import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ArtifactCoordinatorPorts,
  type ArtifactPairBarrier,
  type PortableLockV1,
  commitArtifactPair,
  createOperationGroupId,
  defaultRuntimePorts,
  hashManifestSemantics,
  normalizeManifestDocument,
  readManifestSource,
  readPortableLockSource,
  recoverArtifactPair,
  resolveProjectContext,
  serializePortableLock,
} from '@skillsmith/core';
import { createTestNodeArtifactCoordinatorPorts } from '../../../core/src/artifacts/node-coordinator.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../core/tests/fixtures/acquire/remote.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

setDefaultTimeout(60_000);

type UnknownRecord = Record<string, unknown>;
interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let remote: RemoteFixture;
let fleet: FixtureFleet;
let installSupportsNoSave = false;

const fixtureEnv = (
  selected: FixtureFleet | undefined,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> => ({
  ...remote.gitRewriteEnv,
  ...(selected === undefined
    ? {}
    : {
        HOME: selected.home,
        XDG_CONFIG_HOME: join(selected.home, '.config'),
        XDG_DATA_HOME: join(selected.home, '.local', 'share'),
        XDG_CACHE_HOME: join(selected.home, '.cache'),
        SKILLSMITH_HOME: selected.data,
      }),
  CI: '1',
  NO_COLOR: '1',
  ...overrides,
});

const spawnCli = (
  args: readonly string[],
  options: Readonly<{
    selected?: FixtureFleet;
    cwd?: string;
    env?: Readonly<Record<string, string | undefined>>;
  }> = {},
) => {
  const gitConfig =
    options.selected === undefined ? undefined : join(options.selected.base, 'gitconfig');
  const command =
    gitConfig === undefined
      ? ['bun', CLI_ENTRYPOINT, ...args]
      : ['env', `GIT_CONFIG_GLOBAL=${gitConfig}`, 'bun', CLI_ENTRYPOINT, ...args];
  return Bun.spawn(command, {
    cwd: options.cwd ?? options.selected?.base ?? process.cwd(),
    env: hermeticGitEnv(fixtureEnv(options.selected, options.env)),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
};

const waitForChildExit = async (
  child: ReturnType<typeof spawnCli>,
  label: string,
  timeoutMs = 15_000,
): Promise<number> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} did not exit within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const runCli = async (
  args: readonly string[],
  options: Parameters<typeof spawnCli>[1] = {},
): Promise<CliResult> => {
  const child = spawnCli(args, options);
  const code = await waitForChildExit(child, `CLI ${args[0] ?? 'command'}`);
  return {
    code,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
};

const requireCode = (result: CliResult, code: number, label: string): void => {
  if (result.code !== code) {
    throw new Error(
      `${label}: expected exit ${code}, got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
};

const object = (value: unknown, label: string): UnknownRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
};

const objects = (value: unknown, label: string): UnknownRecord[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
};

const json = (result: CliResult): UnknownRecord => object(JSON.parse(result.stdout), 'CLI report');

const pathKind = async (path: string): Promise<'absent' | 'file' | 'dir' | 'symlink'> => {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink()) return 'symlink';
    if (status.isDirectory()) return 'dir';
    return 'file';
  } catch {
    return 'absent';
  }
};

const readTextMaybe = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const source = () => `${remote.multiSource}//plugins/fh/skills/factor-scan`;
const livePath = (selected: FixtureFleet, tool = 'claude-code', scope = 'user'): string =>
  scope === 'project'
    ? join(selected.project, tool === 'codex' ? '.agents' : '.claude', 'skills', 'factor-scan')
    : join(selected.home, tool === 'codex' ? '.agents' : '.claude', 'skills', 'factor-scan');

const seedManaged = async (
  selected: FixtureFleet,
  tools: readonly ('claude-code' | 'codex')[] = ['claude-code'],
  options: Readonly<{ scope?: 'user' | 'project'; direct?: boolean; cwd?: string }> = {},
): Promise<UnknownRecord> => {
  const scope = options.scope ?? 'user';
  const args = [
    'install',
    source(),
    ...tools.flatMap((tool) => ['--tool', tool]),
    '--no-verify',
    scope === 'project' ? '--project' : '--user',
    ...(options.direct === true ? ['--direct'] : []),
    ...(installSupportsNoSave ? ['--no-save'] : []),
    '--json',
  ];
  const result = await runCli(args, {
    selected,
    cwd: options.cwd ?? (scope === 'project' ? selected.project : selected.base),
  });
  requireCode(result, 0, `seed ${scope} ${tools.join('+')} install`);
  const report = json(result);
  expect(objects(report.results, 'seed results').every((row) => row.action === 'installed')).toBe(
    true,
  );
  return report;
};

const desiredSource = (tools: readonly ('claude-code' | 'codex')[]): string => `# retained-comment
version = 1

[[skills]]
name = "factor-scan"
source = "fixture.invalid/acme/multi//plugins/fh/skills/factor-scan"
tools = [${tools.map((tool) => `"${tool}"`).join(', ')}]
scope = "user"
placement = "symlink"
`;

const writeDesiredPair = async (
  manifestPath: string,
  lockPath: string,
  tools: readonly ('claude-code' | 'codex')[],
): Promise<Readonly<{ manifest: string; lock: string }>> => {
  const manifest = desiredSource(tools);
  const parsed = readManifestSource(manifest);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const normalized = normalizeManifestDocument(parsed.value);
  if (!normalized.ok) throw new Error(normalized.error.message);
  const candidate: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(normalized.value),
    skills: [
      {
        name: 'factor-scan',
        source: 'fixture.invalid/acme/multi//plugins/fh/skills/factor-scan',
        requestedRef: null,
        resolvedSha: remote.multiHead,
        sourcePath: 'plugins/fh/skills/factor-scan',
        contentHash: hashManifestSemantics(normalized.value),
      },
    ],
  };
  const encoded = serializePortableLock(candidate);
  if (!encoded.ok) throw new Error(encoded.error.message);
  await Promise.all([
    mkdir(dirname(manifestPath), { recursive: true }),
    mkdir(dirname(lockPath), { recursive: true }),
  ]);
  await Promise.all([writeFile(manifestPath, manifest), writeFile(lockPath, encoded.value)]);
  return { manifest, lock: encoded.value };
};

const userPair = (selected: FixtureFleet) => ({
  manifest: join(selected.home, '.config', 'skillsmith', 'skillsmith.toml'),
  lock: join(selected.home, '.config', 'skillsmith', 'skillsmith.lock'),
});

const expectV2 = (report: UnknownRecord): void => {
  expect(report).toMatchObject({ schemaVersion: 2, kind: 'skillsmith.uninstall' });
};

const readLedger = async (selected: FixtureFleet): Promise<UnknownRecord> =>
  object(JSON.parse(await readFile(join(selected.data, 'placements.json'), 'utf8')), 'ledger');

const waitForJournal = async (selected: FixtureFleet, phase: string): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const ledger = await readLedger(selected);
      const skills = object(ledger.skills, 'ledger.skills');
      const skill = object(skills['factor-scan'], 'ledger skill');
      const tools = object(skill.tools, 'ledger tools');
      const pair = object(tools['claude-code'], 'ledger pair');
      if (object(pair.journal, 'ledger journal').phase === phase) return;
    } catch {
      // The ledger may be absent or between atomic writes while the child advances.
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for uninstall journal phase ${phase}`);
};

const characterizeSingleArtifactOperationRecovery = async (
  selected: FixtureFleet,
): Promise<void> => {
  const root = join(selected.base, 'single-artifact-operation-recovery');
  const manifestPath = join(root, 'skillsmith.toml');
  const lockPath = join(root, 'skillsmith.lock');
  const manifestSource = 'version = 1\nskills = []\n';
  const parsed = readManifestSource(manifestSource);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const normalized = normalizeManifestDocument(parsed.value);
  if (!normalized.ok) throw new Error(normalized.error.message);
  const targetLock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(normalized.value),
    skills: [],
  };
  const serialized = serializePortableLock(targetLock);
  if (!serialized.ok) throw new Error(serialized.error.message);
  await mkdir(root, { recursive: true });
  await writeFile(manifestPath, manifestSource);
  const pair = Object.freeze({
    file: Object.freeze({
      token: null,
      path: manifestPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfile: Object.freeze({
      token: null,
      path: lockPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfileSource: 'sibling' as const,
  });
  const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
  let interrupted = false;
  let blockCatchRecovery = false;
  const ports: ArtifactCoordinatorPorts = Object.freeze({
    ...base,
    recovery: Object.freeze({
      ...base.recovery,
      discover: async () => {
        if (blockCatchRecovery) throw new Error('simulated single-operation process death');
        return base.recovery.discover();
      },
    }),
    afterBarrier: async (barrier: ArtifactPairBarrier) => {
      if (
        !interrupted &&
        barrier.kind === 'mutation-returned' &&
        barrier.operation === 'link-file-no-replace' &&
        barrier.role === 'lock'
      ) {
        interrupted = true;
        blockCatchRecovery = true;
        throw new Error('interrupt one lock artifact operation after durable install');
      }
    },
  });
  const result = await commitArtifactPair(ports, {
    pair,
    manifest: { kind: 'keep' },
    lock: { kind: 'replace', lock: targetLock },
  });
  expect(result.ok).toBeFalse();
  expect(interrupted).toBeTrue();
  blockCatchRecovery = false;
  expect(await recoverArtifactPair(base, pair, 'resume')).toEqual({ ok: true, value: 'finalized' });
  expect(await readFile(manifestPath, 'utf8')).toBe(manifestSource);
  expect(await readFile(lockPath, 'utf8')).toBe(serialized.value);
  expect(await base.recovery.discover()).toEqual([]);
};

beforeAll(async () => {
  remote = await buildRemoteFixture();
  const help = await runCli(['install', '--help']);
  requireCode(help, 0, 'install help characterization');
  installSupportsNoSave = help.stdout.includes('--no-save');
});

afterAll(async () => {
  await destroyRemoteFixture(remote);
});

beforeEach(async () => {
  fleet = await buildFixtureFleet();
  await writeFile(
    join(fleet.base, 'gitconfig'),
    `[url "${remote.multiUrl}"]\n\tinsteadOf = ${remote.multiSource}\n`,
  );
});

afterEach(async () => {
  await destroyFixtureFleet(fleet);
});

// biome-ignore format: keep the seven selector-owned rows compact and auditable as one bounded matrix.
describe('G4A-01 uninstall command contract', () => {
  test('EWP-CMD-UNINSTALL-TS01 name/path resolution, absent noop, and declared-only cleanup', async () => {
    const absent = await runCli(['uninstall', 'never-installed', '--user', '--json'], { selected: fleet });
    requireCode(absent, 0, 'truly absent uninstall');
    expect(objects(json(absent).results, 'absent results')[0]?.action).toBe('noop');

    await seedManaged(fleet);
    const byPath = await runCli(['uninstall', livePath(fleet), '--user', '--json'], { selected: fleet });
    requireCode(byPath, 0, 'path-target uninstall characterization');
    expect(objects(json(byPath).results, 'path results')[0]).toMatchObject({ action: 'removed', placementPath: livePath(fleet) });

    const pair = userPair(fleet);
    await writeDesiredPair(pair.manifest, pair.lock, ['claude-code']);
    const declaredOnly = await runCli(['uninstall', 'factor-scan', '--user', '--json'], { selected: fleet });
    requireCode(declaredOnly, 0, 'declared-only uninstall');
    const report = json(declaredOnly);
    expectV2(report);
    expect(object(report.summary, 'declared-only summary')).toMatchObject({ desiredState: { changed: 1 } });
    expect(await readFile(pair.manifest, 'utf8')).not.toContain('name = "factor-scan"');
    expect(await readFile(pair.lock, 'utf8')).not.toContain('[[skills]]');
  });

  test('EWP-CMD-UNINSTALL-TS02 tool/scope/all-scopes ambiguity and stable project identity', async () => {
    const installCwd = join(fleet.project, 'packages', 'installer');
    const uninstallCwd = join(fleet.project, 'packages', 'remover');
    await Promise.all([
      mkdir(installCwd, { recursive: true }),
      mkdir(uninstallCwd, { recursive: true }),
    ]);
    const contextPorts = await defaultRuntimePorts();
    const [installContext, uninstallContext] = await Promise.all([
      resolveProjectContext(contextPorts, { invocationCwd: installCwd }),
      resolveProjectContext(contextPorts, { invocationCwd: uninstallCwd }),
    ]);
    if (!installContext.ok || !uninstallContext.ok) {
      throw new Error('nested project context fixture did not resolve');
    }
    const canonicalProject = await contextPorts.realpath(fleet.project);
    expect([
      installContext.value.projectRoot,
      installContext.value.projectIdentity,
      uninstallContext.value.projectRoot,
      uninstallContext.value.projectIdentity,
    ]).toEqual([canonicalProject, canonicalProject, canonicalProject, canonicalProject]);

    await seedManaged(fleet, ['claude-code'], { scope: 'project', cwd: installCwd });
    const projectLedger = await readLedger(fleet);
    expect(Object.keys(object(projectLedger.projects, 'project ledger projects'))).toEqual([
      canonicalProject,
    ]);
    await seedManaged(fleet, ['claude-code'], { scope: 'user' });
    const ambiguous = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--json'], { selected: fleet, cwd: uninstallCwd });
    const all = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--all-scopes', '--yes', '--json'], { selected: fleet, cwd: uninstallCwd });
    await seedManaged(fleet, ['claude-code', 'codex'], { scope: 'user' });
    const toolAmbiguous = await runCli(['uninstall', 'factor-scan', '--user', '--json'], { selected: fleet });

    expect(ambiguous.code).toBe(2);
    requireCode(all, 0, 'all-scopes uninstall');
    const report = json(all);
    const results = objects(report.results, 'all-scopes results');
    expect(new Set(results.map((row) => row.scope))).toEqual(new Set(['user', 'project']));
    const projectResult = results.find((row) => row.scope === 'project');
    expect(projectResult).toMatchObject({ placementPath: livePath(fleet, 'claude-code', 'project') });
    expect({
      toolAmbiguityExit: toolAmbiguous.code,
      projectGroupId: projectResult?.groupId,
    }).toEqual({
      toolAmbiguityExit: 2,
      projectGroupId: createOperationGroupId({
        domain: 'skillsmith.operation-group-identity',
        schemaVersion: 1,
        command: 'uninstall',
        skill: 'factor-scan',
        source: null,
        scope: 'project',
        target: 'factor-scan',
      }),
    });
    expectV2(report);
  });

  test('EWP-CMD-UNINSTALL-TS03 bounded force covers managed, dev, unmanaged, edited-copy, backup, and store retention', async () => {
    const unmanagedPath = join(fleet.home, '.claude', 'skills', 'copied');
    const refused = await runCli(['uninstall', 'copied', '--tool', 'claude-code', '--user', '--json'], { selected: fleet });
    expect(refused.code).toBe(2);
    expect(await pathKind(unmanagedPath)).toBe('dir');
    const forced = await runCli(['uninstall', 'copied', '--tool', 'claude-code', '--user', '--force', '--yes', '--json'], { selected: fleet });
    requireCode(forced, 0, 'forced unmanaged uninstall');
    const forcedRow = objects(json(forced).results, 'forced results')[0] as UnknownRecord;
    expect(await pathKind(String(forcedRow.backupKept))).not.toBe('absent');

    const seed = await seedManaged(fleet, ['claude-code', 'codex'], { direct: true });
    const seedRow = objects(seed.results, 'direct seed results').find(
      (row) => row.tool === 'claude-code',
    );
    if (seedRow === undefined) throw new Error('direct seed omitted claude-code result');
    const storePath = String(object(seedRow.store, 'seed store').path);
    const storeSkillPath = join(storePath, 'SKILL.md');
    const storeBytes = await readFile(storeSkillPath, 'utf8');
    const editedBytes = '---\nname: factor-scan\n---\nedited\n';
    await writeFile(join(livePath(fleet), 'SKILL.md'), editedBytes);
    await writeFile(join(livePath(fleet, 'codex'), 'SKILL.md'), editedBytes);
    const editedRefusal = await runCli(['uninstall', 'factor-scan', '--tool', 'codex', '--user', '--json'], { selected: fleet });
    const editedAfterRefusal = {
      liveKind: await pathKind(livePath(fleet, 'codex')),
      liveBytes: await readTextMaybe(join(livePath(fleet, 'codex'), 'SKILL.md')),
      storeKind: await pathKind(storePath),
      storeBytes: await readTextMaybe(storeSkillPath),
    };
    const editedForced = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--force', '--yes', '--json'], { selected: fleet });
    requireCode(editedForced, 0, 'forced edited managed copy uninstall');
    const editedForcedRow = objects(json(editedForced).results, 'forced edited results')[0] as UnknownRecord;
    expect(editedForcedRow.storeRetained).toBe(storePath);
    expect(await pathKind(storePath)).toBe('dir');
    expect(await readFile(storeSkillPath, 'utf8')).toBe(storeBytes);
    expect(await pathKind(String(editedForcedRow.backupKept))).not.toBe('absent');

    const devSeed = await seedManaged(fleet);
    const devSeedRow = objects(devSeed.results, 'dev seed results')[0] as UnknownRecord;
    const devStorePath = String(object(devSeedRow.store, 'dev seed store').path);
    const devStoreSkillPath = join(devStorePath, 'SKILL.md');
    const devStoreBytes = await readFile(devStoreSkillPath, 'utf8');
    const devSourceSkillPath = join(fleet.gammaSrc, 'SKILL.md');
    const devSourceBytes = await readFile(devSourceSkillPath, 'utf8');
    requireCode(await runCli(['dev', 'factor-scan', '--tool', 'claude-code', '--source', fleet.gammaSrc, '--no-verify', '--json'], { selected: fleet }), 0, 'dev-mode seed');
    const devRefusal = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--json'], { selected: fleet });
    const devAfterRefusal = {
      liveKind: await pathKind(livePath(fleet)),
      sourceKind: await pathKind(fleet.gammaSrc),
      sourceBytes: await readTextMaybe(devSourceSkillPath),
      storeKind: await pathKind(devStorePath),
      storeBytes: await readTextMaybe(devStoreSkillPath),
    };
    const devForced = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--force', '--json'], { selected: fleet });
    requireCode(devForced, 0, 'forced dev-mode uninstall');
    const devForcedRow = objects(json(devForced).results, 'forced dev results')[0] as UnknownRecord;
    expect(await pathKind(livePath(fleet))).toBe('absent');
    expect(await pathKind(fleet.gammaSrc)).toBe('dir');
    expect(await readFile(devSourceSkillPath, 'utf8')).toBe(devSourceBytes);
    expect(await pathKind(devStorePath)).toBe('dir');
    expect(await readFile(devStoreSkillPath, 'utf8')).toBe(devStoreBytes);

    const report = json(forced);
    expect({
      report: { schemaVersion: report.schemaVersion, kind: report.kind },
      unmanaged: {
        force: forcedRow.force,
        backupKind: await pathKind(String(forcedRow.backupKept)),
      },
      edited: {
        refusalCode: editedRefusal.code,
        stateAfterRefusal: editedAfterRefusal,
        forcedCode: editedForced.code,
        force: editedForcedRow.force,
        backupKind: await pathKind(String(editedForcedRow.backupKept)),
      },
      dev: {
        refusalCode: devRefusal.code,
        stateAfterRefusal: devAfterRefusal,
        forcedCode: devForced.code,
        force: devForcedRow.force,
        backupKept: devForcedRow.backupKept,
        storeRetained: devForcedRow.storeRetained,
      },
    }).toEqual({
      report: { schemaVersion: 2, kind: 'skillsmith.uninstall' },
      unmanaged: {
        force: expect.objectContaining({ requested: true, applied: true, conflictType: 'unmanaged-target', normalBehavior: 'refuse', forcedBehavior: 'backup-and-replace', backup: 'required' }),
        backupKind: 'dir',
      },
      edited: {
        refusalCode: 2,
        stateAfterRefusal: {
          liveKind: 'dir',
          liveBytes: editedBytes,
          storeKind: 'dir',
          storeBytes,
        },
        forcedCode: 0,
        force: expect.objectContaining({ requested: true, applied: true, conflictType: 'modified-managed-target', normalBehavior: 'refuse', forcedBehavior: 'backup-and-replace', backup: 'required' }),
        backupKind: 'dir',
      },
      dev: {
        refusalCode: 2,
        stateAfterRefusal: {
          liveKind: 'symlink',
          sourceKind: 'dir',
          sourceBytes: devSourceBytes,
          storeKind: 'dir',
          storeBytes: devStoreBytes,
        },
        forcedCode: 0,
        force: expect.objectContaining({ requested: true, applied: true, conflictType: 'source-changed', normalBehavior: 'refuse', forcedBehavior: 'replace', backup: 'none' }),
        backupKept: null,
        storeRetained: devStorePath,
      },
    });
  });

  test('EWP-CMD-UNINSTALL-TS04 ownership selection, retention, final artifact preservation, legacy, and selector conflicts', async () => {
    const project = { manifest: join(fleet.project, 'skillsmith.toml'), lock: join(fleet.project, 'skillsmith.lock') };
    await seedManaged(fleet, ['codex'], { scope: 'project' });
    const legacyBytes = 'tool = "codex"\n';
    await writeFile(project.manifest, legacyBytes);
    await rm(project.lock, { force: true });
    expect(await pathKind(livePath(fleet, 'codex', 'project'))).toBe('symlink');
    expect(await readFile(project.manifest, 'utf8')).toBe(legacyBytes);
    expect(await pathKind(project.lock)).toBe('absent');
    const legacy = await runCli(['uninstall', 'factor-scan', '--tool', 'codex', '--project', '--json'], { selected: fleet, cwd: fleet.project });
    const legacyManifestAfter = await readFile(project.manifest, 'utf8');
    const legacyLockAfter = await pathKind(project.lock);
    const legacyDocument = readManifestSource(legacyManifestAfter);
    if (!legacyDocument.ok) throw new Error(legacyDocument.error.message);
    const legacyNormalized = normalizeManifestDocument(legacyDocument.value);
    if (!legacyNormalized.ok) throw new Error(legacyNormalized.error.message);
    const legacyLockBytes = legacyLockAfter === 'file' ? await readFile(project.lock) : null;
    const legacyLock = legacyLockBytes === null ? null : readPortableLockSource(legacyLockBytes);
    if (legacyLock !== null && !legacyLock.ok) throw new Error(legacyLock.error.message);
    await rm(project.manifest, { force: true });
    await rm(project.lock, { force: true });

    await seedManaged(fleet, ['claude-code', 'codex']);
    const user = userPair(fleet);
    await writeDesiredPair(project.manifest, project.lock, ['claude-code', 'codex']);
    const unique = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--json'], { selected: fleet, cwd: fleet.project });
    const uniqueManifest = await readFile(project.manifest, 'utf8');
    const uniqueLock = await readFile(project.lock, 'utf8');
    await seedManaged(fleet, ['claude-code']);
    const projectBytes = await writeDesiredPair(project.manifest, project.lock, ['claude-code', 'codex']);
    const userBytes = await writeDesiredPair(user.manifest, user.lock, ['claude-code', 'codex']);
    const dualLivePath = livePath(fleet);
    const dualLiveSkill = join(dualLivePath, 'SKILL.md');
    const dualBefore = {
      projectManifest: projectBytes.manifest,
      projectLock: projectBytes.lock,
      userManifest: userBytes.manifest,
      userLock: userBytes.lock,
      liveKind: await pathKind(dualLivePath),
      liveBytes: await readTextMaybe(dualLiveSkill),
    };
    const lockOnly = await runCli(['uninstall', 'factor-scan', '--lockfile', project.lock, '--json'], { selected: fleet, cwd: fleet.project });
    const afterLockOnly = {
      projectManifest: await readFile(project.manifest, 'utf8'),
      projectLock: await readFile(project.lock, 'utf8'),
      userManifest: await readFile(user.manifest, 'utf8'),
      userLock: await readFile(user.lock, 'utf8'),
      liveKind: await pathKind(dualLivePath),
      liveBytes: await readTextMaybe(dualLiveSkill),
    };
    const noSaveLockfile = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--no-save', '--lockfile', project.lock, '--json'], { selected: fleet, cwd: fleet.project });
    const noSaveLockfileError = json(noSaveLockfile);
    const afterNoSaveLockfile = {
      projectManifest: await readFile(project.manifest, 'utf8'),
      projectLock: await readFile(project.lock, 'utf8'),
      userManifest: await readFile(user.manifest, 'utf8'),
      userLock: await readFile(user.lock, 'utf8'),
      liveKind: await pathKind(dualLivePath),
      liveBytes: await readTextMaybe(dualLiveSkill),
    };
    const noSaveFile = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--no-save', '--file', project.manifest, '--json'], { selected: fleet, cwd: fleet.project });
    const noSaveFileError = json(noSaveFile);
    const afterNoSaveFile = {
      projectManifest: await readFile(project.manifest, 'utf8'),
      projectLock: await readFile(project.lock, 'utf8'),
      userManifest: await readFile(user.manifest, 'utf8'),
      userLock: await readFile(user.lock, 'utf8'),
      liveKind: await pathKind(dualLivePath),
      liveBytes: await readTextMaybe(dualLiveSkill),
    };
    const dual = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--force', '--json'], { selected: fleet, cwd: fleet.project });
    const afterDual = {
      projectManifest: await readFile(project.manifest, 'utf8'),
      projectLock: await readFile(project.lock, 'utf8'),
      userManifest: await readFile(user.manifest, 'utf8'),
      userLock: await readFile(user.lock, 'utf8'),
      liveKind: await pathKind(dualLivePath),
      liveBytes: await readTextMaybe(dualLiveSkill),
    };

    const partial = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--file', project.manifest, '--lockfile', project.lock, '--json'], { selected: fleet, cwd: fleet.project });
    const partialManifest = await readFile(project.manifest, 'utf8');
    const partialLock = await readFile(project.lock, 'utf8');
    const final = await runCli(['uninstall', 'factor-scan', '--tool', 'codex', '--user', '--file', project.manifest, '--lockfile', project.lock, '--json'], { selected: fleet, cwd: fleet.project });
    const absentManifest = join(fleet.base, 'absent.toml');
    const absent = await runCli(['uninstall', 'not-installed', '--file', absentManifest, '--json'], { selected: fleet });

    requireCode(legacy, 0, 'legacy project removal');
    expect(await pathKind(livePath(fleet, 'codex', 'project'))).toBe('absent');
    requireCode(unique, 0, 'unique project-owner uninstall');
    expect(uniqueManifest).toContain('name = "factor-scan"');
    expect(uniqueManifest).toContain('"codex"');
    expect(uniqueLock).toContain('name = "factor-scan"');
    expect(lockOnly.code).toBe(2);
    expect(afterLockOnly).toEqual(dualBefore);
    expect(afterNoSaveLockfile).toEqual(dualBefore);
    expect(afterNoSaveFile).toEqual(dualBefore);
    expect({
      legacy: {
        shape: legacyDocument.value.shape,
        migrationPending: legacyDocument.value.migrationPending,
        model: legacyNormalized.value,
        lock: legacyLock?.ok === true ? legacyLock.value : null,
        selection: json(legacy).artifactSelection,
      },
      dual: {
        code: dual.code,
        selection: json(dual).artifactSelection,
        state: afterDual,
      },
      noSaveLockfile: {
        code: noSaveLockfile.code,
        error: noSaveLockfileError,
      },
      noSaveFile: {
        code: noSaveFile.code,
        error: noSaveFileError,
      },
    }).toEqual({
      legacy: {
        shape: 'canonical',
        migrationPending: false,
        model: { version: 1, defaults: { tools: ['codex'] }, skills: [] },
        lock: {
          version: 1,
          hashSchemaVersion: 1,
          manifestHash: hashManifestSemantics(legacyNormalized.value),
          skills: [],
        },
        selection: { outcome: 'selected', selectedBy: 'legacy-project-migration' },
      },
      dual: {
        code: 2,
        selection: {
          outcome: 'refused',
          reason: 'ambiguous-owner',
          candidates: [project.manifest, user.manifest],
        },
        state: dualBefore,
      },
      noSaveLockfile: {
        code: 2,
        error: {
          schemaVersion: 1,
          kind: 'error',
          code: 'usage',
          message: '--no-save cannot be combined with --lockfile',
          exitCode: 2,
        },
      },
      noSaveFile: {
        code: 2,
        error: {
          schemaVersion: 1,
          kind: 'error',
          code: 'usage',
          message: '--no-save cannot be combined with --file',
          exitCode: 2,
        },
      },
    });
    requireCode(partial, 0, 'explicit partial declaration uninstall');
    expect(partialManifest).toContain('name = "factor-scan"');
    expect(partialManifest).toContain('"codex"');
    expect(partialManifest).not.toContain('"claude-code"');
    expect(partialLock).toContain('name = "factor-scan"');
    requireCode(final, 0, 'explicit final declaration uninstall');
    requireCode(absent, 0, 'explicit absent-file uninstall');
    expect(await readFile(project.manifest, 'utf8')).toContain('# retained-comment');
    expect(await readFile(project.manifest, 'utf8')).not.toContain('name = "factor-scan"');
    expect(await readFile(project.lock, 'utf8')).not.toContain('[[skills]]');
    expect(await Bun.file(project.manifest).exists()).toBeTrue();
    expect(await Bun.file(project.lock).exists()).toBeTrue();
    expect(await Bun.file(absentManifest).exists()).toBeFalse();
    expect(await readFile(user.manifest, 'utf8')).toBe(userBytes.manifest);
    expect(uniqueManifest).not.toContain('"claude-code"');
    expect(object(json(unique).artifactSelection, 'unique selection')).toMatchObject({ outcome: 'selected', selectedBy: 'selected-project-owner' });
    expectV2(json(final));
  });

  test('EWP-CMD-UNINSTALL-TS05 no-save, dry-run, approval, noninteractive JSON, and force effects', async () => {
    const malformed = userPair(fleet);
    await mkdir(dirname(malformed.manifest), { recursive: true });
    await writeFile(malformed.manifest, 'not = [valid\n');
    const original = await readFile(malformed.manifest, 'utf8');
    const copied = join(fleet.home, '.claude', 'skills', 'copied');
    const base = ['uninstall', 'copied', '--tool', 'claude-code', '--user', '--no-save', '--force', '--no-prompt', '--json'];
    expect(await readFile(malformed.manifest, 'utf8')).toBe(original);
    expect(await pathKind(copied)).toBe('dir');
    const preview = await runCli([...base, '--dry-run'], { selected: fleet });
    const noninteractive = await runCli(base, { selected: fleet });
    expect(await readFile(malformed.manifest, 'utf8')).toBe(original);
    expect(await pathKind(copied)).toBe('dir');
    const yesDryRun = await runCli([...base.filter((arg) => arg !== '--no-prompt'), '--yes', '--dry-run'], { selected: fleet });
    const approved = await runCli([...base.filter((arg) => arg !== '--no-prompt'), '--yes'], { selected: fleet });

    expect(noninteractive.code).toBe(2);
    expect(yesDryRun.code).toBe(2);
    requireCode(preview, 0, 'no-save force preview');
    requireCode(approved, 0, 'approved no-save force uninstall');
    expect(await readFile(malformed.manifest, 'utf8')).toBe(original);
    expect(await pathKind(copied)).toBe('absent');
    const report = json(preview);
    expectV2(report);
    expect(report).toMatchObject({ dryRun: true, saveMode: 'live-only', artifactPair: null, artifactSelection: { outcome: 'none', reason: 'no-save' } });
    expect(object(objects(report.results, 'preview results')[0]?.force, 'preview force')).toMatchObject({ requested: true, conflictType: 'unmanaged-target', applied: false });
  });

  test('EWP-CMD-UNINSTALL-TS06 retains store bytes and committed undo eligibility', async () => {
    const seed = await seedManaged(fleet);
    const seedRow = objects(seed.results, 'seed results')[0] as UnknownRecord;
    const storePath = String(object(seedRow.store, 'seed store').path);
    const removed = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--json'], { selected: fleet });
    requireCode(removed, 0, 'managed uninstall');
    expect(await pathKind(storePath)).toBe('dir');
    const ledger = await readLedger(fleet);
    const history = objects(ledger.history, 'ledger history');
    expect(history.at(-1)).toMatchObject({ intent: { kind: 'remove', skill: 'factor-scan', tool: 'claude-code' }, phase: 'committed' });
    expect(Object.keys(object(ledger.transactions, 'ledger transactions'))).toEqual([]);
    const report = json(removed);
    expectV2(report);
    expect(objects(report.results, 'removed results')[0]).toMatchObject({ storeRetained: storePath, executionOutcome: 'succeeded', drift: expect.any(Object) });
  });

  test('EWP-CMD-UNINSTALL-TS07 partial failure, continue, skipped results, and crash recovery boundaries', async () => {
    // One coordinator commit with manifest=keep characterizes recovery of the same single
    // write-lock artifact operation. No crash is injected between manifest and lock operations.
    await characterizeSingleArtifactOperationRecovery(fleet);
    await seedManaged(fleet);
    const ledgerPath = join(fleet.data, 'placements.json');
    // This row owns one bounded placement-operation interruption. Crashes between the two
    // separately committed artifact operations remain the exhaustive G4A-04 matrix.
    const crashed = spawnCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user'], { selected: fleet, env: { SKILLSMITH_E2E: '1', SKILLSMITH_TEST_PAUSE_AT: 'backed-up' } });
    try {
      await waitForJournal(fleet, 'backed-up');
    } finally {
      crashed.kill('SIGKILL');
      await waitForChildExit(crashed, 'SIGKILL uninstall crash');
      await rm(`${ledgerPath}.lock`, { recursive: true, force: true });
    }
    const oppositeArgs = ['install', source(), '--tool', 'claude-code', '--no-verify', '--user', ...(installSupportsNoSave ? ['--no-save'] : [])];
    const opposite = await runCli(oppositeArgs, { selected: fleet, env: { SKILLSMITH_E2E: '1' } });
    expect(opposite.code).toBe(2);
    requireCode(await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--user'], { selected: fleet, env: { SKILLSMITH_E2E: '1' } }), 0, 'same-operation uninstall resume');

    await seedManaged(fleet);
    const failFast = await runCli(['uninstall', 'copied', 'factor-scan', '--tool', 'claude-code', '--user', '--json'], { selected: fleet });
    if ((await pathKind(livePath(fleet))) === 'absent') await seedManaged(fleet);
    const continued = await runCli(['uninstall', 'copied', 'factor-scan', '--tool', 'claude-code', '--user', '--continue-on-error', '--json'], { selected: fleet });

    if ((await pathKind(livePath(fleet))) === 'absent') await seedManaged(fleet);
    const partialPair = userPair(fleet);
    const partialBytes = await writeDesiredPair(partialPair.manifest, partialPair.lock, ['claude-code', 'codex']);
    const refusedPairPath = livePath(fleet, 'codex');
    await mkdir(refusedPairPath, { recursive: true });
    await writeFile(join(refusedPairPath, 'SKILL.md'), '---\nname: factor-scan\n---\nunmanaged\n');
    const partial = await runCli(['uninstall', 'factor-scan', '--tool', 'claude-code', '--tool', 'codex', '--user', '--file', partialPair.manifest, '--lockfile', partialPair.lock, '--json'], { selected: fleet });

    expect(failFast.code).toBe(2);
    expect(continued.code).toBe(2);
    expect(partial.code).toBe(2);
    expect(await readFile(partialPair.manifest, 'utf8')).toBe(partialBytes.manifest);
    expect(await readFile(partialPair.lock, 'utf8')).toBe(partialBytes.lock);
    expect(await pathKind(refusedPairPath)).toBe('dir');
    expect(await pathKind(livePath(fleet))).toBe('absent');
    const partialReport = json(partial);
    expectV2(partialReport);
    expect(objects(partialReport.results, 'partial-pair results')).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'claude-code', action: 'removed', executionOutcome: 'succeeded', drift: expect.objectContaining({ status: 'desired-without-live' }) }),
      expect.objectContaining({ tool: 'codex', action: 'refused', executionOutcome: 'failed' }),
    ]));
    const failFastReport = json(failFast);
    expectV2(failFastReport);
    expect(objects(failFastReport.results, 'fail-fast results')).toContainEqual(expect.objectContaining({ skill: 'factor-scan', action: 'skipped', executionOutcome: 'skipped-after-failure' }));
    expect(objects(json(continued).results, 'continued results')).toContainEqual(expect.objectContaining({ skill: 'factor-scan', action: 'removed', executionOutcome: 'succeeded' }));
    expect(await pathKind(livePath(fleet))).toBe('absent');
  });
});
