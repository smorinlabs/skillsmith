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
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  InstallDeps,
  InstallOptions,
  InstallRecord,
  RuntimePorts,
  SkillSmithError,
  VerifyReport,
} from '@skillsmith/core';
import { VERIFIED_AGAINST, err, ok, runInstall } from '@skillsmith/core';
import { parseSource } from '../../../core/src/acquire/source.ts';
import {
  normalizeManifestDocument,
  readManifestSource,
} from '../../../core/src/artifacts/manifest.ts';
import { sourceUnresolvableError } from '../../../core/src/errors.ts';
import {
  getLedgerPairAt,
  readLedgerState,
  withoutLedgerPairAt,
  writeLedger,
} from '../../../core/src/place/ledger.ts';
import { ledgerPathOf } from '../../../core/src/place/paths.ts';
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
import { renderInstallHuman } from '../../src/output/install-human.ts';
import { renderInstallJson } from '../../src/output/install-json.ts';
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

setDefaultTimeout(120_000);

const NOW = '2026-07-16T00:00:00.000Z';
const CLAUDE_ONLY = ['claude-code'] as const;
const msg = (error: SkillSmithError): string => ('message' in error ? error.message : error.code);

type G4AInstallOptions = InstallOptions &
  Readonly<{
    file?: string;
    lockfile?: string;
    noSave?: boolean;
    path?: string;
  }>;
type G4AInstallOptionOverrides = Omit<Partial<G4AInstallOptions>, 'tools'> &
  Readonly<{ tools?: InstallOptions['tools'] | undefined }>;

interface G4AResultView {
  readonly action?: string;
  readonly tool?: string | null;
  readonly placementPath?: string | null;
  readonly executionOutcome?: string | null;
  readonly drift?: Readonly<{
    status?: string;
    futureApply?: string;
    reason?: string | null;
  }>;
  readonly force?: Readonly<{
    requested?: boolean;
    applied?: boolean;
    conflictType?: string | null;
    normalBehavior?: string | null;
    forcedBehavior?: string | null;
    backup?: string | null;
    target?: unknown;
  }>;
}

interface G4AReportView {
  readonly reportVersion?: number;
  readonly saveMode?: string;
  readonly artifactPair?: Readonly<{
    manifestPath?: string;
    lockPath?: string;
    lockSource?: string;
  }> | null;
  readonly artifactSelection?: Readonly<{
    outcome?: string;
    selectedBy?: string;
    reason?: string;
    candidates?: readonly string[];
  }>;
  readonly artifactEffects?: readonly Readonly<{
    groupId?: string;
    skill?: string;
    manifestAction?: string;
    lockAction?: string;
    migration?: string;
    outcome?: string;
    reason?: string | null;
  }>[];
  readonly requested?: Readonly<{
    path?: string | null;
    batchPolicy?: string;
  }>;
  readonly results?: readonly G4AResultView[];
  readonly plan?: Readonly<{
    operations?: readonly Readonly<{
      operationId?: string;
      kind?: string;
      dependencyMetadata?: Readonly<{ operationIds?: readonly string[] }>;
    }>[];
  }>;
}

const g4aView = (value: unknown): G4AReportView => value as G4AReportView;

const detectBoth: InstallDeps['detect'] = async (_env, tool) =>
  ok<InstallRecord[]>([
    { path: `/fixture/bin/${tool}`, version: '1.0.0', installMethod: 'unknown' },
  ]);

const detectClaudeOnly: InstallDeps['detect'] = async (_env, tool) =>
  tool === 'claude-code'
    ? ok<InstallRecord[]>([
        { path: '/fixture/bin/claude-code', version: '1.0.0', installMethod: 'unknown' },
      ])
    : ok<InstallRecord[]>([]);

const detectNone: InstallDeps['detect'] = async () => ok<InstallRecord[]>([]);

const passingVerify: InstallDeps['verify'] = async (_env, options) => {
  const tool = options.tools?.[0] ?? 'claude-code';
  const report: VerifyReport = {
    schemaVersion: 1,
    target: { path: options.path, kind: 'skill' },
    requested: {
      tools: [tool],
      modes: options.deep ? ['static', 'deep'] : ['static'],
      strict: options.strict ?? false,
      explicitTools: true,
    },
    verifiedAgainst: VERIFIED_AGAINST,
    summary: {
      verdict: 'pass',
      verified: [tool],
      failed: [],
      skipped: [],
      counts: { error: 0, warning: 0, info: 0 },
    },
    tools: [
      {
        tool,
        available: true,
        toolVersion: '1.0.0',
        versionDrift: false,
        skipReason: null,
        verdict: 'pass',
        modes: [],
      },
    ],
  };
  return ok(report);
};

let remote: RemoteFixture;
let fleet: FixtureFleet;
let env: RuntimePorts;
let source: string;
let txSequence = 0;

const makeDeps = (overrides: Partial<InstallDeps> = {}): InstallDeps => {
  const sequence = txSequence++;
  let transaction = 0;
  return {
    detect: detectBoth,
    verify: passingVerify,
    transport: remote.transport,
    now: () => NOW,
    newTxId: () => (0x20000000 + sequence * 1000 + transaction++).toString(16).slice(-8),
    ...overrides,
  };
};

const scopedEnv = (fixture: FixtureFleet): RuntimePorts => ({
  ...fixture.env,
  xdg: Object.freeze({
    config: join(fixture.base, 'xdg-config'),
    data: join(fixture.base, 'xdg-data'),
    cache: join(fixture.base, 'xdg-cache'),
  }),
});

const baseOptions = (overrides: G4AInstallOptionOverrides = {}): G4AInstallOptions => {
  const { tools, ...rest } = overrides;
  const options = {
    sources: [source],
    cwd: fleet.base,
    configuration: fleet.configuration,
    ...rest,
  };
  if ('tools' in overrides) return tools === undefined ? options : { ...options, tools };
  return { ...options, tools: CLAUDE_ONLY };
};

const unwrapInstall = async (
  options: G4AInstallOptions,
  deps: InstallDeps = makeDeps(),
  ports: RuntimePorts = env,
) => {
  const result = await runInstall(ports, options, deps);
  if (!result.ok) throw new Error(msg(result.error));
  return result.value;
};

const ledger = async (fixture: FixtureFleet = fleet, ports: RuntimePorts = env) => {
  const result = await readLedgerState(ports, ledgerPathOf(fixture.data));
  if (!result.ok) throw new Error(msg(result.error));
  if (result.value.state !== 'present') throw new Error('expected a persisted fixture ledger');
  return result.value.model;
};

const textIfFile = async (ports: RuntimePorts, path: string): Promise<string> =>
  (await ports.pathKind(path)) === 'file' ? ports.readText(path) : '';

const manifestSource = (names: readonly string[], scope: 'user' | 'project'): string =>
  `${[
    'version = 1',
    '[defaults]',
    `scope = "${scope}"`,
    'tools = ["claude-code"]',
    ...names.flatMap((name) => [
      '[[skills]]',
      `name = "${name}"`,
      `source = "fixture.invalid/acme/multi//plugins/fh/skills/${name}"`,
    ]),
  ].join('\n')}\n`;

const expectManifestFixtureToParse = (fixtureSource: string): void => {
  const parsed = readManifestSource(fixtureSource);
  expect(parsed.ok).toBeTrue();
  if (!parsed.ok) throw new Error('expected manifest fixture to parse');

  const normalized = normalizeManifestDocument(parsed.value);
  expect(normalized.ok).toBeTrue();
};

const cliEnvironment = (
  fixture: FixtureFleet,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> => ({
  ...remote.gitRewriteEnv,
  HOME: fixture.home,
  XDG_CONFIG_HOME: join(fixture.base, 'xdg-config'),
  XDG_DATA_HOME: join(fixture.base, 'xdg-data'),
  XDG_CACHE_HOME: join(fixture.base, 'xdg-cache'),
  SKILLSMITH_HOME: fixture.data,
  CI: '1',
  NO_COLOR: '1',
  ...overrides,
});

const provisionDetectedClaude = async (
  fixture: FixtureFleet,
): Promise<Readonly<Record<string, string>>> => {
  const bin = join(fixture.base, 'fixture-bin');
  const executable = join(bin, 'claude');
  const gitConfig = join(fixture.base, 'fixture-gitconfig');
  await mkdir(bin, { recursive: true });
  await writeFile(
    executable,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.202"; exit 0; fi\nexit 0\n',
  );
  await chmod(executable, 0o755);
  await writeFile(
    gitConfig,
    [
      `[url "${remote.multiUrl}"]`,
      `\tinsteadOf = ${remote.multiSource}`,
      `[url "${remote.singleUrl}"]`,
      `\tinsteadOf = ${remote.singleSource}`,
      `[url "${remote.rootUrl}"]`,
      `\tinsteadOf = ${remote.rootSource}`,
      '[protocol "file"]',
      '\tallow = always',
      '',
    ].join('\n'),
  );
  return {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    GIT_CONFIG_GLOBAL: gitConfig,
  };
};

const spawnCli = (
  fixture: FixtureFleet,
  args: readonly string[],
  overrides: Readonly<Record<string, string | undefined>> = {},
) => {
  const command =
    overrides.GIT_CONFIG_GLOBAL === undefined
      ? [process.execPath, CLI_ENTRYPOINT, ...args]
      : [
          'env',
          `GIT_CONFIG_GLOBAL=${overrides.GIT_CONFIG_GLOBAL}`,
          process.execPath,
          CLI_ENTRYPOINT,
          ...args,
        ];
  return Bun.spawn(command, {
    cwd: fixture.base,
    env: hermeticGitEnv(cliEnvironment(fixture, overrides)),
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
  fixture: FixtureFleet,
  args: readonly string[],
  overrides: Readonly<Record<string, string | undefined>> = {},
) => {
  const child = spawnCli(fixture, args, overrides);
  const code = await waitForChildExit(child, `CLI ${args[0] ?? 'command'}`);
  return {
    code,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
};

const waitForJournalPhase = async (
  fixture: FixtureFleet,
  phase: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const ledgerPath = ledgerPathOf(fixture.data);
  while (Date.now() < deadline) {
    const state = await readLedgerState(fixture.env, ledgerPath);
    if (state.ok && state.value.state === 'present') {
      const journal = getLedgerPairAt(
        state.value.model,
        null,
        'factor-scan',
        'claude-code',
      )?.journal;
      if (journal?.phase === phase) return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for install journal phase ${phase}`);
};

const persistedFixtureText = async (
  ports: RuntimePorts,
  roots: readonly string[],
): Promise<string> => {
  const chunks: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const kind = await ports.pathKind(path);
    if (kind === 'file') {
      chunks.push(await ports.readText(path));
      return;
    }
    if (kind !== 'dir') return;
    for (const name of await ports.listDir(path)) await visit(join(path, name));
  };
  for (const root of roots) await visit(root);
  return chunks.join('\n');
};

beforeAll(async () => {
  remote = await buildRemoteFixture();
});

afterAll(async () => {
  await destroyRemoteFixture(remote);
});

beforeEach(async () => {
  fleet = await buildFixtureFleet();
  env = scopedEnv(fleet);
  source = `${remote.multiSource}//plugins/fh/skills/factor-scan`;
});

afterEach(async () => {
  await destroyFixtureFleet(fleet);
});

describe('G4A-01 install command contract', () => {
  test('EWP-CMD-INSTALL-TS01 source grammar, noninteractive picker refusal, and credential-safe remediation', async () => {
    const parsed = parseSource(`${source}@v1.0.0`);
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) throw new Error(msg(parsed.error));
    expect(parsed.value).toMatchObject({
      canonicalInvocation: 'fixture.invalid/acme/multi//plugins/fh/skills/factor-scan@v1.0.0',
      ref: 'v1.0.0',
    });

    const ambiguous = await unwrapInstall(
      baseOptions({ sources: [remote.multiSource], dryRun: true }),
    );
    expect(ambiguous.results).toHaveLength(1);
    expect(ambiguous.results[0]).toMatchObject({
      action: 'refused',
      error: { code: 'flip-refused' },
    });
    expect(ambiguous.results[0]?.candidates?.every((candidate) => candidate.includes('//'))).toBe(
      true,
    );

    const credentialMarker = 'synthetic-sensitive-marker';
    const credentialUrl = new URL(
      'https://fixture.invalid/acme/multi.git//plugins/fh/skills/factor-scan',
    );
    credentialUrl.username = 'fixture-user';
    credentialUrl.password = credentialMarker;
    const credentialInput = credentialUrl.toString();
    const rejected = await unwrapInstall(baseOptions({ sources: [credentialInput], dryRun: true }));
    expect(rejected.results[0]?.action).toBe('refused');
    expect(JSON.stringify(rejected)).not.toContain(credentialMarker);

    const installed = await unwrapInstall(baseOptions());
    expect(installed.results[0]).toMatchObject({
      skill: 'factor-scan',
      tool: 'claude-code',
      action: 'installed',
    });
    const future = g4aView(installed);
    const manifestPath = join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.toml');
    const saved = await textIfFile(env, manifestPath);

    expect({
      reportVersion: future.reportVersion,
      saveMode: future.saveMode,
      manifestKind: await env.pathKind(manifestPath),
      canonicalSourcePersisted: saved.includes(
        'fixture.invalid/acme/multi//plugins/fh/skills/factor-scan',
      ),
      literalTransportPersisted: saved.includes(remote.multiSource),
    }).toEqual({
      reportVersion: 2,
      saveMode: 'desired-state',
      manifestKind: 'file',
      canonicalSourcePersisted: true,
      literalTransportPersisted: false,
    });
  });

  test('EWP-CMD-INSTALL-TS02 registered automatic and explicit detection with capability refusal', async () => {
    const installSpec = CURRENT_COMMAND_SPECS.find(
      (candidate) => candidate.path === 'skillsmith install',
    );
    const toolOption = installSpec?.options.find((option) => option.long === '--tool');
    expect(toolOption?.allowedValues).toEqual(['claude-code', 'codex', 'kilo-code', 'opencode']);

    const automatic = await unwrapInstall(
      baseOptions({ tools: undefined, dryRun: true }),
      makeDeps({ detect: detectClaudeOnly }),
    );
    expect(automatic.requested).toMatchObject({
      tools: ['claude-code'],
      explicitTools: false,
    });
    expect(automatic.results).toMatchObject([{ tool: 'claude-code', action: 'installed' }]);

    const unavailable = await unwrapInstall(
      baseOptions({ tools: ['codex'], dryRun: true }),
      makeDeps({ detect: detectNone }),
    );
    expect(unavailable.results).toMatchObject([
      {
        tool: 'codex',
        action: 'refused',
        error: { code: 'tool-unavailable' },
      },
    ]);

    const installed = await unwrapInstall(
      baseOptions({ tools: undefined }),
      makeDeps({ detect: detectClaudeOnly }),
    );
    const future = g4aView(installed);
    const manifestPath = join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.toml');
    const saved = await textIfFile(env, manifestPath);
    expect({
      saveMode: future.saveMode,
      selection: future.artifactSelection,
      savedOnlyDetectedTool:
        saved.includes('tools = ["claude-code"]') && !saved.includes('"codex"'),
      groupAssigned: future.results?.[0]?.executionOutcome,
    }).toEqual({
      saveMode: 'desired-state',
      selection: { outcome: 'selected', selectedBy: 'new-user' },
      savedOnlyDetectedTool: true,
      groupAssigned: 'succeeded',
    });
  });

  test('EWP-CMD-INSTALL-TS03 scope identity and portable custom-path translation, refusal, and no-save escape', async () => {
    const baseline = await unwrapInstall(baseOptions({ cwd: fleet.project, dryRun: true }));
    expect(baseline.requested).toMatchObject({ scope: 'project', explicitScope: false });
    expect(baseline.results[0]?.placementPath).toBe(
      join(fleet.projectReal, '.claude', 'skills', 'factor-scan'),
    );

    const relative = await unwrapInstall(
      baseOptions({
        cwd: fleet.project,
        scope: 'project',
        path: './custom/skills',
        dryRun: true,
      }),
    );
    const absolutePath = join(fleet.base, 'machine-only-skills');
    const nonportable = await unwrapInstall(
      baseOptions({
        cwd: fleet.project,
        scope: 'project',
        path: absolutePath,
        dryRun: true,
      }),
    );
    const liveOnly = await unwrapInstall(
      baseOptions({
        cwd: fleet.project,
        scope: 'project',
        path: absolutePath,
        noSave: true,
        dryRun: true,
      }),
    );
    const installSpec = CURRENT_COMMAND_SPECS.find(
      (candidate) => candidate.path === 'skillsmith install',
    );
    const futureRelative = g4aView(relative);
    const futureNonportable = g4aView(nonportable);
    const futureLiveOnly = g4aView(liveOnly);

    expect({
      options: installSpec?.options
        .map(({ long }) => long)
        .filter((option) => ['--file', '--lockfile', '--no-save', '--path'].includes(option))
        .sort(),
      portablePath: futureRelative.requested?.path,
      nonportableAction: futureNonportable.results?.[0]?.action,
      nonportableSelection: futureNonportable.artifactSelection?.reason,
      noSaveMode: futureLiveOnly.saveMode,
      noSavePair: futureLiveOnly.artifactPair,
      noSaveSelection: futureLiveOnly.artifactSelection,
      noSaveDrift: futureLiveOnly.results?.[0]?.drift,
    }).toEqual({
      options: ['--file', '--lockfile', '--no-save', '--path'],
      portablePath: './custom/skills',
      nonportableAction: 'refused',
      nonportableSelection: 'nonportable-path',
      noSaveMode: 'live-only',
      noSavePair: null,
      noSaveSelection: { outcome: 'none', reason: 'no-save' },
      noSaveDrift: {
        status: 'not-evaluated',
        futureApply: 'depends-on-selected-manifest',
        reason: null,
      },
    });
  });

  test('EWP-CMD-INSTALL-TS04 static, deep, strict, and no-verify gates precede an artifact-aware dry-run plan', async () => {
    const calls: Array<Readonly<{ deep: boolean; strict: boolean }>> = [];
    const verify: InstallDeps['verify'] = async (ports, options) => {
      calls.push({ deep: options.deep ?? false, strict: options.strict ?? false });
      return passingVerify(ports, options);
    };
    const ordinary = await unwrapInstall(baseOptions({ dryRun: true }), makeDeps({ verify }));
    const deep = await unwrapInstall(
      baseOptions({ tools: ['codex'], deep: true, dryRun: true }),
      makeDeps({ verify }),
    );
    const strict = await unwrapInstall(
      baseOptions({ strict: true, dryRun: true }),
      makeDeps({ verify }),
    );
    const skipped = await unwrapInstall(
      baseOptions({ noVerify: true, dryRun: true }),
      makeDeps({ verify }),
    );
    expect(calls).toEqual([
      { deep: false, strict: false },
      { deep: true, strict: false },
      { deep: false, strict: true },
    ]);
    expect([ordinary, deep, strict, skipped].map((report) => report.results[0]?.action)).toEqual([
      'installed',
      'installed',
      'installed',
      'installed',
    ]);
    expect(await env.pathKind(ledgerPathOf(fleet.data))).toBe('absent');

    const blocked = await unwrapInstall(
      baseOptions(),
      makeDeps({
        verify: async () => err(sourceUnresolvableError('synthetic verification gate failure')),
      }),
    );
    expect(blocked.results[0]?.action).toBe('failed');
    expect(await env.pathKind(ledgerPathOf(fleet.data))).toBe('absent');
    expect(await env.pathKind(join(fleet.home, '.claude', 'skills', 'factor-scan'))).toBe('absent');
    const blockedFuture = g4aView(blocked);
    expect(blockedFuture.artifactEffects ?? []).toEqual([]);
    expect(
      (blockedFuture.plan?.operations ?? [])
        .map(({ kind }) => kind)
        .filter((kind) => kind === 'write-manifest' || kind === 'write-lock'),
    ).toEqual([]);
    expect(
      await env.pathKind(join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.toml')),
    ).toBe('absent');
    expect(
      await env.pathKind(join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.lock')),
    ).toBe('absent');

    const future = g4aView(deep);
    const operations = future.plan?.operations ?? [];
    const manifest = operations.find((operation) => operation.kind === 'write-manifest');
    const lock = operations.find((operation) => operation.kind === 'write-lock');
    const placement = operations.find((operation) => operation.kind === 'install');
    expect({
      pair: future.artifactPair,
      effects: future.artifactEffects,
      operationKinds: operations.map(({ kind }) => kind),
      lockDependsOnManifest: lock?.dependencyMetadata?.operationIds?.includes(
        manifest?.operationId ?? '',
      ),
      placementDependsOnLock: placement?.dependencyMetadata?.operationIds?.includes(
        lock?.operationId ?? '',
      ),
    }).toEqual({
      pair: {
        manifestPath: join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.toml'),
        lockPath: join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.lock'),
        lockSource: 'sibling',
      },
      effects: [
        {
          groupId: expect.any(String),
          skill: 'factor-scan',
          manifestAction: 'create',
          lockAction: 'create',
          migration: 'none',
          outcome: 'planned',
          reason: null,
        },
      ],
      operationKinds: ['write-manifest', 'write-lock', 'install'],
      lockDependsOnManifest: true,
      placementDependsOnLock: true,
    });
  });

  test('EWP-CMD-INSTALL-TS05 install, update, repair, noop, copy, ref, pin, and bounded-force backup facts', async () => {
    const installed = await unwrapInstall(baseOptions());
    expect(installed.results[0]).toMatchObject({ action: 'installed', placement: 'symlink' });

    const noop = await unwrapInstall(baseOptions());
    expect(noop.results[0]?.action).toBe('noop');

    const currentLedger = await ledger();
    const withoutPair = withoutLedgerPairAt(currentLedger, null, 'factor-scan', 'claude-code');
    if (!withoutPair.ok) throw new Error(msg(withoutPair.error));
    const persisted = await writeLedger(env, ledgerPathOf(fleet.data), withoutPair.value);
    if (!persisted.ok) throw new Error(msg(persisted.error));
    const repaired = await unwrapInstall(baseOptions());
    expect(repaired.results[0]?.action).toBe('repaired');

    const updated = await unwrapInstall(
      baseOptions({ direct: true, ref: 'v1.0.0', pin: true, force: true }),
    );
    expect(updated.results[0]).toMatchObject({
      action: 'updated',
      placement: 'copy',
      origin: {
        refRequested: 'v1.0.0',
        refResolved: remote.multiTagSha,
        pin: true,
      },
    });

    const unmanagedPath = join(fleet.home, '.claude', 'skills', 'lint');
    await mkdir(unmanagedPath, { recursive: true });
    await writeFile(join(unmanagedPath, 'SKILL.md'), '---\nname: lint\n---\n');
    const forcedBackup = await unwrapInstall(
      baseOptions({
        sources: [remote.singleSource],
        force: true,
      }),
    );
    expect(forcedBackup.results[0]?.action).not.toBe('refused');
    const skillsRoot = join(fleet.home, '.claude', 'skills');
    const backupNames = (await env.listDir(skillsRoot)).filter((name) =>
      name.startsWith('.skillsmith-backup-lint-'),
    );
    expect(backupNames).toHaveLength(1);
    const backupName = backupNames[0];
    if (backupName === undefined) throw new Error('forced replacement backup is missing');
    const backupPath = join(skillsRoot, backupName);
    expect(await env.pathKind(backupPath)).toBe('dir');
    expect(await env.readText(join(backupPath, 'SKILL.md'))).toContain('name: lint');

    const futureUpdate = g4aView(updated).results?.[0];
    const futureBackup = g4aView(forcedBackup).results?.[0];
    expect({
      sourceChange: futureUpdate?.force,
      unmanagedReplacement: futureBackup?.force,
    }).toEqual({
      sourceChange: {
        requested: true,
        applied: true,
        conflictType: 'source-changed',
        target: expect.any(Object),
        normalBehavior: 'refuse',
        forcedBehavior: 'replace',
        backup: 'none',
      },
      unmanagedReplacement: {
        requested: true,
        applied: true,
        conflictType: 'unmanaged-target',
        target: expect.any(Object),
        normalBehavior: 'refuse',
        forcedBehavior: 'backup-and-replace',
        backup: 'required',
      },
    });
  });

  test('EWP-CMD-INSTALL-TS06 explicit, owned, scoped-new, dual-owner, and legacy pair selection is zero-write on dry-run or refusal', async () => {
    const projectManifest = join(fleet.project, 'skillsmith.toml');
    const userManifest = join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.toml');
    const explicitManifest = join(fleet.project, 'team-state.toml');
    await mkdir(join(fleet.base, 'xdg-config', 'skillsmith'), { recursive: true });

    const explicit = await unwrapInstall(
      baseOptions({
        cwd: fleet.project,
        scope: 'user',
        file: explicitManifest,
        dryRun: true,
      }),
    );

    const projectBytes = manifestSource(['factor-scan'], 'project');
    expectManifestFixtureToParse(projectBytes);
    await writeFile(projectManifest, projectBytes);
    const projectOwner = await unwrapInstall(
      baseOptions({ cwd: fleet.project, scope: 'user', dryRun: true }),
    );
    expect(await readFile(projectManifest, 'utf8')).toBe(projectBytes);

    await rm(projectManifest);
    const scopedNew = await unwrapInstall(
      baseOptions({ cwd: fleet.project, scope: 'project', dryRun: true }),
    );
    expect(await env.pathKind(projectManifest)).toBe('absent');

    await writeFile(projectManifest, projectBytes);
    const userBytes = manifestSource(['factor-scan'], 'user');
    expectManifestFixtureToParse(userBytes);
    await writeFile(userManifest, userBytes);
    const dual = await unwrapInstall(
      baseOptions({ cwd: fleet.project, scope: 'user', force: true, dryRun: true }),
    );
    expect(await readFile(projectManifest, 'utf8')).toBe(projectBytes);
    expect(await readFile(userManifest, 'utf8')).toBe(userBytes);

    await rm(userManifest);
    const legacyBytes = 'tool = "codex"\n';
    await writeFile(projectManifest, legacyBytes);
    const legacy = await unwrapInstall(
      baseOptions({ cwd: fleet.project, scope: 'project', dryRun: true }),
    );
    expect(await readFile(projectManifest, 'utf8')).toBe(legacyBytes);

    expect({
      explicit: g4aView(explicit).artifactPair,
      projectOwner: g4aView(projectOwner).artifactSelection,
      scopedNew: g4aView(scopedNew).artifactSelection,
      dual: {
        action: g4aView(dual).results?.[0]?.action,
        selection: g4aView(dual).artifactSelection,
        operations: g4aView(dual).plan?.operations?.length,
      },
      legacy: {
        selection: g4aView(legacy).artifactSelection,
        kinds: g4aView(legacy).plan?.operations?.map(({ kind }) => kind),
      },
    }).toEqual({
      explicit: {
        manifestPath: explicitManifest,
        lockPath: join(fleet.project, 'team-state.lock'),
        lockSource: 'sibling',
      },
      projectOwner: { outcome: 'selected', selectedBy: 'selected-project-owner' },
      scopedNew: { outcome: 'selected', selectedBy: 'new-project' },
      dual: {
        action: 'refused',
        selection: {
          outcome: 'refused',
          reason: 'ambiguous-owner',
          candidates: [projectManifest, userManifest],
        },
        operations: 0,
      },
      legacy: {
        selection: { outcome: 'selected', selectedBy: 'legacy-project-migration' },
        kinds: ['migrate-project-config', 'write-manifest', 'write-lock', 'install'],
      },
    });
  });

  test('EWP-CMD-INSTALL-TS07 save, no-save, dry-run, human, JSON, output-mode, and redacted-error parity', async () => {
    const preview = await unwrapInstall(baseOptions({ dryRun: true }));
    expect(await env.pathKind(ledgerPathOf(fleet.data))).toBe('absent');
    const json = renderInstallJson(preview);
    const decoded = JSON.parse(json) as Record<string, unknown>;
    const human = renderInstallHuman(preview, 0);
    expect(human).toContain('factor-scan');
    expect(human).toContain('Exit code: 0');
    expect(JSON.stringify(decoded)).not.toContain('"error"');

    const humanArgs = [
      'install',
      source,
      '--tool',
      'claude-code',
      '--user',
      '--no-verify',
      '--dry-run',
    ] as const;
    const detectedToolEnv = await provisionDetectedClaude(fleet);
    const normalOutput = await runCli(fleet, humanArgs, detectedToolEnv);
    const quietOutput = await runCli(fleet, ['--quiet', ...humanArgs], detectedToolEnv);
    const verboseOutput = await runCli(fleet, ['--verbose', ...humanArgs], detectedToolEnv);
    expect(
      [normalOutput.code, quietOutput.code, verboseOutput.code],
      JSON.stringify({ normalOutput, quietOutput, verboseOutput }),
    ).toEqual([0, 0, 0]);
    expect(normalOutput.stdout).toContain('factor-scan');
    expect(normalOutput.stderr).toBe('');
    expect(quietOutput.stdout).toBe('');
    expect(quietOutput.stderr).toBe('');
    expect(verboseOutput.stdout).toContain('factor-scan');
    expect(verboseOutput.stderr).toContain('detail: command.started');

    const liveOnly = await unwrapInstall(baseOptions({ noSave: true, dryRun: true }));
    const canary = 'synthetic-sensitive-output-marker';
    const failed = await unwrapInstall(
      baseOptions(),
      makeDeps({
        transport: {
          ...remote.transport,
          fetchRepo: async () => err(sourceUnresolvableError(`password=${canary}`)),
        },
      }),
    );
    expect(JSON.stringify(failed)).not.toContain(canary);
    expect(failed.results[0]?.reason).toContain('[REDACTED]');
    expect(renderInstallJson(failed)).not.toContain(canary);
    expect(renderInstallHuman(failed, 1)).not.toContain(canary);
    expect(await env.pathKind(ledgerPathOf(fleet.data))).toBe('absent');
    expect(
      await persistedFixtureText(env, [fleet.home, fleet.data, env.xdg.config, env.xdg.data]),
    ).not.toContain(canary);

    const rootSpec = CURRENT_COMMAND_SPECS.find((candidate) => candidate.path === 'skillsmith');
    const futurePreview = g4aView(preview);
    const futureFailed = g4aView(failed);
    expect({
      outputModes: rootSpec?.options
        .map(({ long }) => long)
        .filter((option) => ['--quiet', '--verbose', '--debug'].includes(option))
        .sort(),
      schemaVersion: decoded.schemaVersion,
      saveMode: decoded.saveMode,
      dryRunHeading: human.includes('Would save desired state:'),
      previewPair: futurePreview.artifactPair,
      liveOnly: {
        mode: g4aView(liveOnly).saveMode,
        pair: g4aView(liveOnly).artifactPair,
      },
      failedSelection: futureFailed.artifactSelection,
    }).toEqual({
      outputModes: ['--debug', '--quiet', '--verbose'],
      schemaVersion: 2,
      saveMode: 'desired-state',
      dryRunHeading: true,
      previewPair: {
        manifestPath: join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.toml'),
        lockPath: join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.lock'),
        lockSource: 'sibling',
      },
      liveOnly: { mode: 'live-only', pair: null },
      failedSelection: { outcome: 'none', reason: 'pre-resolution-failure' },
    });
  });

  test('EWP-CMD-INSTALL-TS08 group fail-fast, partial drift, OS SIGINT, process crash recovery, and canary safety', async () => {
    const bad = `${remote.multiSource}//not/a/skill`;
    const failedFirst = await unwrapInstall(baseOptions({ sources: [bad, source], dryRun: true }));
    expect(failedFirst.results.some(({ action }) => action === 'failed')).toBeTrue();
    expect(
      failedFirst.results.some(
        ({ action, reason }) => action === 'skipped' && reason === 'fail-fast',
      ),
    ).toBeTrue();

    const continued = await unwrapInstall(
      baseOptions({ sources: [bad, source], continueOnError: true, dryRun: true }),
    );
    expect(continued.results.some(({ action }) => action === 'failed')).toBeTrue();
    expect(continued.results.some(({ action }) => action === 'installed')).toBeTrue();

    const canary = 'synthetic-sensitive-partial-marker';
    const partialEnv: RuntimePorts = {
      ...env,
      makeSymlink: async (target, linkPath) => {
        if (
          linkPath.startsWith(join(fleet.home, '.agents', 'skills')) &&
          linkPath.includes('.skillsmith-staging-factor-scan-')
        ) {
          throw new Error(`password=${canary}`);
        }
        return env.makeSymlink(target, linkPath);
      },
    };
    const partial = await unwrapInstall(
      baseOptions({ tools: ['claude-code', 'codex'] }),
      makeDeps(),
      partialEnv,
    );
    expect(partial.results.find(({ tool }) => tool === 'claude-code')?.action).toBe('installed');
    expect(partial.results.find(({ tool }) => tool === 'codex')?.action).toBe('failed');
    expect(JSON.stringify(partial)).not.toContain(canary);
    expect(
      await persistedFixtureText(env, [fleet.home, fleet.data, env.xdg.config, env.xdg.data]),
    ).not.toContain(canary);

    const lifecycleArgs = [
      'install',
      source,
      '--tool',
      'claude-code',
      '--user',
      '--no-verify',
      '--json',
    ] as const;

    const signalFleet = await buildFixtureFleet();
    try {
      const signalLedgerPath = ledgerPathOf(signalFleet.data);
      const signalToolEnv = await provisionDetectedClaude(signalFleet);
      const child = spawnCli(signalFleet, lifecycleArgs, {
        ...signalToolEnv,
        SKILLSMITH_E2E: '1',
        SKILLSMITH_TEST_PAUSE_AT: 'prepared',
      });
      let exited = false;
      try {
        await waitForJournalPhase(signalFleet, 'prepared');
        child.kill('SIGINT');
        const code = await waitForChildExit(child, 'SIGINT install cancellation');
        exited = true;
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        expect(code).toBe(130);
        expect(JSON.parse(stdout)).toMatchObject({
          results: [{ action: 'skipped', reason: 'interrupted' }],
        });
        expect(stdout).not.toContain(canary);
        expect(stderr).not.toContain(canary);
      } finally {
        if (!exited) {
          child.kill('SIGKILL');
          await waitForChildExit(child, 'SIGINT fixture cleanup');
        }
      }
      expect(await signalFleet.env.pathKind(`${signalLedgerPath}.lock`)).toBe('absent');
    } finally {
      await destroyFixtureFleet(signalFleet);
    }

    const crashFleet = await buildFixtureFleet();
    try {
      const crashLedgerPath = ledgerPathOf(crashFleet.data);
      const crashToolEnv = await provisionDetectedClaude(crashFleet);
      const child = spawnCli(crashFleet, lifecycleArgs, {
        ...crashToolEnv,
        SKILLSMITH_E2E: '1',
        SKILLSMITH_TEST_PAUSE_AT: 'live',
      });
      let exited = false;
      try {
        await waitForJournalPhase(crashFleet, 'live');
        child.kill('SIGKILL');
        await waitForChildExit(child, 'SIGKILL install crash');
        exited = true;
      } finally {
        if (!exited) {
          child.kill('SIGKILL');
          await waitForChildExit(child, 'SIGKILL fixture cleanup');
        }
        await rm(`${crashLedgerPath}.lock`, { recursive: true, force: true });
      }

      const interrupted = await readLedgerState(crashFleet.env, crashLedgerPath);
      if (!interrupted.ok || interrupted.value.state !== 'present') {
        throw new Error('process crash did not retain its install ledger');
      }
      expect(
        getLedgerPairAt(interrupted.value.model, null, 'factor-scan', 'claude-code')?.journal
          ?.phase,
      ).toBe('live');

      const opposite = await runCli(
        crashFleet,
        ['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--json'],
        crashToolEnv,
      );
      expect(opposite.code).toBe(2);

      const resumed = await runCli(crashFleet, lifecycleArgs, crashToolEnv);
      expect(resumed.code).toBe(0);
      const recovered = await readLedgerState(crashFleet.env, crashLedgerPath);
      if (!recovered.ok || recovered.value.state !== 'present') {
        throw new Error('same-operation resume did not retain its install ledger');
      }
      expect(
        getLedgerPairAt(recovered.value.model, null, 'factor-scan', 'claude-code')?.journal,
      ).toBeNull();
      expect(
        await crashFleet.env.pathKind(join(crashFleet.home, '.claude', 'skills', 'factor-scan')),
      ).toBe('symlink');
    } finally {
      await destroyFixtureFleet(crashFleet);
    }

    const manifestPath = join(fleet.base, 'xdg-config', 'skillsmith', 'skillsmith.toml');
    const saved = await textIfFile(env, manifestPath);
    const future = g4aView(partial);
    const claude = future.results?.find(({ tool }) => tool === 'claude-code');
    const codex = future.results?.find(({ tool }) => tool === 'codex');
    expect({
      manifestKind: await env.pathKind(manifestPath),
      completeIntent: saved.includes('"claude-code"') && saved.includes('"codex"'),
      claude: {
        outcome: claude?.executionOutcome,
        drift: claude?.drift,
      },
      codex: {
        outcome: codex?.executionOutcome,
        drift: codex?.drift,
      },
    }).toEqual({
      manifestKind: 'file',
      completeIntent: true,
      claude: {
        outcome: 'succeeded',
        drift: { status: 'in-sync', futureApply: 'none', reason: null },
      },
      codex: {
        outcome: 'failed',
        drift: {
          status: 'desired-without-live',
          futureApply: 'restore-live',
          reason: expect.any(String),
        },
      },
    });
  });
});
