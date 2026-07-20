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
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallDeps, InstallRecord } from '@skillsmith/core';
import { ok, runInstall } from '@skillsmith/core';
import { ledgerV1Codec } from '../../../core/src/artifacts/ledger-codec.ts';
import type { LedgerSkillsV1Dto, LedgerV1Dto } from '../../../core/src/artifacts/ledger-types.ts';
import {
  correlatePortableLock,
  readPortableLockSource,
  serializePortableLock,
} from '../../../core/src/artifacts/lock.ts';
import {
  normalizeManifestDocument,
  readManifestSource,
} from '../../../core/src/artifacts/manifest.ts';
import { readLedgerState } from '../../../core/src/place/ledger.ts';
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
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

setDefaultTimeout(120_000);

type UnknownRecord = Record<string, unknown>;

interface CliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const readMaybe = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
};

let remote: RemoteFixture;
let fleet: FixtureFleet;
let txSequence = 0;

beforeAll(async () => {
  remote = await buildRemoteFixture();
});

afterAll(async () => {
  await destroyRemoteFixture(remote);
});

beforeEach(async () => {
  fleet = await buildFixtureFleet();
});

afterEach(async () => {
  await destroyFixtureFleet(fleet);
});

const source = (): string => `${remote.multiSource}//plugins/fh/skills/factor-scan`;

const detectTools: InstallDeps['detect'] = async (_env, tool) =>
  ok<InstallRecord[]>([
    {
      path: `/fixture/bin/${tool}`,
      version: '1.0.0',
      installMethod: 'unknown',
    },
  ]);

const installDeps = (): InstallDeps => {
  const sequence = txSequence++;
  return {
    detect: detectTools,
    verify: async () => {
      throw new Error('export fixture requested verification despite noVerify');
    },
    transport: remote.transport,
    now: () => '2026-07-18T00:00:00.000Z',
    newTxId: () => (0x40000000 + sequence).toString(16),
  };
};

const seedManaged = async (
  tools: readonly ('claude-code' | 'codex')[] = ['claude-code'],
  scope: 'user' | 'project' = 'user',
  placementRoot?: string,
): Promise<void> => {
  for (const tool of tools) {
    const result = await runInstall(
      fleet.env,
      {
        sources: [source()],
        tools: [tool],
        scope,
        noSave: true,
        noVerify: true,
        cwd: scope === 'project' ? fleet.project : fleet.base,
        configuration: fleet.configuration,
        ...(placementRoot === undefined ? {} : { path: placementRoot }),
      },
      installDeps(),
    );
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
    if (!result.ok) throw new Error('could not seed a managed export fixture');
    expect(
      result.value.results.every((row) =>
        placementRoot === undefined
          ? row.action === 'installed'
          : row.action === 'installed' || row.action === 'repaired' || row.action === 'noop',
      ),
      JSON.stringify(result.value.results),
    ).toBeTrue();
  }
};

const downgradeLedgerToV1 = async (): Promise<void> => {
  const path = ledgerPathOf(fleet.data);
  const current = await readLedgerState(fleet.env, path);
  expect(current.ok).toBeTrue();
  if (!current.ok || current.value.state !== 'present') {
    throw new Error('managed fixture ledger was unavailable');
  }
  const dto: LedgerV1Dto = {
    schemaVersion: 1,
    kind: 'skillsmith.placements',
    updatedAt: current.value.model.updatedAt,
    skills: current.value.model.skills as LedgerSkillsV1Dto,
    ...(Object.keys(current.value.model.projects).length === 0
      ? {}
      : {
          projects: Object.fromEntries(
            Object.entries(current.value.model.projects).map(([root, project]) => [
              root,
              { skills: project.skills as LedgerSkillsV1Dto },
            ]),
          ),
        }),
  };
  const legacyModel = ledgerV1Codec.fromDto(dto);
  expect(legacyModel.ok, legacyModel.ok ? undefined : JSON.stringify(legacyModel.error)).toBeTrue();
  if (!legacyModel.ok) throw new Error('managed fixture v1 DTO was invalid');
  const encoded = ledgerV1Codec.encode(legacyModel.value);
  expect(encoded.ok, encoded.ok ? undefined : JSON.stringify(encoded.error)).toBeTrue();
  if (!encoded.ok) throw new Error('managed fixture could not project to ledger v1');
  await writeFile(path, encoded.value);
  const downgraded = await readLedgerState(fleet.env, path);
  expect(downgraded.ok && downgraded.value.sourceVersion).toBe(1);
};

const cliEnv = (): Record<string, string | undefined> => ({
  HOME: fleet.home,
  XDG_CONFIG_HOME: fleet.env.xdg.config,
  XDG_DATA_HOME: fleet.env.xdg.data,
  XDG_CACHE_HOME: fleet.env.xdg.cache,
  SKILLSMITH_HOME: fleet.data,
  CLAUDE_CONFIG_DIR: join(fleet.home, '.claude'),
  CODEX_HOME: join(fleet.home, '.codex'),
  CI: '1',
  NO_COLOR: '1',
});

const gitConfigPath = (): string => join(fleet.base, 'export-gitconfig');

const writeGitConfig = (): Promise<void> =>
  writeFile(
    gitConfigPath(),
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

const runCli = async (args: readonly string[], cwd = fleet.base): Promise<CliProduct> => {
  await writeGitConfig();
  const process = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv(
      { ...cliEnv(), GIT_ALLOW_PROTOCOL: 'file:https' },
      { globalConfigPath: gitConfigPath() },
    ),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await process.exited;
  return {
    exitCode,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
};

const requireJson = (product: CliProduct, expectedExit: number, label: string): UnknownRecord => {
  expect(product.exitCode, `${label}\nstdout:\n${product.stdout}\nstderr:\n${product.stderr}`).toBe(
    expectedExit,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(product.stdout);
  } catch {
    throw new Error(`${label}: stdout was not one JSON report\n${product.stdout}`);
  }
  expect(isRecord(parsed), `${label}: JSON report must be an object`).toBeTrue();
  if (!isRecord(parsed)) throw new Error(`${label}: JSON report unavailable`);
  return parsed;
};

const exportPaths = (label: string): Readonly<{ manifest: string; lock: string }> => {
  const directory = join(fleet.base, 'exports', label);
  return {
    manifest: join(directory, 'team.toml'),
    lock: join(directory, 'team.lock'),
  };
};

const exportArgs = (
  paths: Readonly<{ manifest: string; lock: string }>,
  extra: readonly string[] = [],
): readonly string[] => [
  'export',
  '--user',
  '--tool',
  'claude-code',
  '--file',
  paths.manifest,
  '--lockfile',
  paths.lock,
  '--json',
  ...extra,
];

const seedCleanDev = async (): Promise<void> => {
  const product = await runCli([
    'dev',
    'alpha',
    '--tool',
    'claude-code',
    '--source',
    fleet.alphaSrc,
    '--no-verify',
    '--json',
  ]);
  expect(product.exitCode, product.stderr).toBe(0);
};

describe('G4A-02 export command contract', () => {
  test('EWP-CMD-EXPORT-TS01 managed pinned remote exports exact origin and resolution', async () => {
    await seedManaged();
    await downgradeLedgerToV1();
    const ledger = await readLedgerState(fleet.env, ledgerPathOf(fleet.data));
    expect(ledger.ok).toBeTrue();
    expect(ledger.ok && ledger.value.state).toBe('present');

    const paths = exportPaths('managed');
    const preview = requireJson(
      await runCli(exportArgs(paths, ['--dry-run'])),
      0,
      'managed migration preview',
    );
    expect(records(preview.effects)).toContainEqual(
      expect.objectContaining({ role: 'ledger', action: 'migrate', outcome: 'planned' }),
    );
    const afterPreview = await readLedgerState(fleet.env, ledgerPathOf(fleet.data));
    expect(afterPreview.ok && afterPreview.value.sourceVersion).toBe(1);

    const report = requireJson(await runCli(exportArgs(paths)), 0, 'managed export');
    expect(records(report.effects)).toContainEqual(
      expect.objectContaining({ role: 'ledger', action: 'migrate', outcome: 'succeeded' }),
    );
    const afterExecution = await readLedgerState(fleet.env, ledgerPathOf(fleet.data));
    expect(afterExecution.ok && afterExecution.value.sourceVersion).toBe(2);
    const row = records(report.results).find((candidate) => candidate.name === 'factor-scan');
    expect(row).toMatchObject({
      classification: 'portable-managed',
      tools: ['claude-code'],
      scope: 'user',
    });
    expect(row?.source).toMatchObject({
      host: 'fixture.invalid',
      repository: 'acme/multi',
      path: 'plugins/fh/skills/factor-scan',
    });
    expect(row?.resolvedSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(await readMaybe(paths.manifest)).toContain('factor-scan');
    expect(await readMaybe(paths.lock)).toContain(String(row?.resolvedSha));
  });

  test('EWP-CMD-EXPORT-TS02 clean Git dev placement converts to exact portable identity', async () => {
    await seedCleanDev();
    const paths = exportPaths('clean-dev');
    const report = requireJson(await runCli(exportArgs(paths)), 0, 'clean dev export');
    const row = records(report.results).find((candidate) => candidate.name === 'alpha');
    expect(row).toMatchObject({
      classification: 'portable-dev',
      resolvedSha: fleet.headSha,
    });
    expect(await readMaybe(paths.manifest)).toContain(fleet.headSha);
    expect(await readMaybe(paths.lock)).toContain(fleet.headSha);
  });

  test('EWP-CMD-EXPORT-TS03 nonportable state warns or strict-fails without an empty pair', async () => {
    await seedCleanDev();
    await fleet.makeCheckoutDirty();
    await downgradeLedgerToV1();
    const paths = exportPaths('nonportable');

    const warning = requireJson(await runCli(exportArgs(paths)), 0, 'default dirty export');
    expect(records(warning.results).some((row) => row.classification === 'dirty-git')).toBeTrue();
    expect(await readMaybe(paths.manifest)).toBeNull();
    expect(await readMaybe(paths.lock)).toBeNull();
    const afterWarning = await readLedgerState(fleet.env, ledgerPathOf(fleet.data));
    expect(afterWarning.ok && afterWarning.value.sourceVersion).toBe(1);

    const strict = requireJson(
      await runCli(exportArgs(paths, ['--strict', '--force'])),
      1,
      'strict dirty export',
    );
    expect(strict.summary).toMatchObject({ portable: 0 });
    expect(Number((strict.summary as UnknownRecord).skipped)).toBeGreaterThanOrEqual(1);
    expect(await readMaybe(paths.manifest)).toBeNull();
    expect(await readMaybe(paths.lock)).toBeNull();
    const afterStrict = await readLedgerState(fleet.env, ledgerPathOf(fleet.data));
    expect(afterStrict.ok && afterStrict.value.sourceVersion).toBe(1);
  });

  test('EWP-CMD-EXPORT-TS04 registry grammar, readable tools, scope default, and pair default are exact', async () => {
    const spec = CURRENT_COMMAND_SPECS.find((candidate) => candidate.path === 'skillsmith export');
    expect(spec, 'export must be activated in the sole command registry').toBeDefined();
    expect(spec?.options.map((option) => option.long)).toEqual([
      '--help',
      '--file',
      '--lockfile',
      '--tool',
      '--scope',
      '--user',
      '--project',
      '--system',
      '--managed',
      '--strict',
      '--force',
      '--dry-run',
      '--json',
    ]);
    await mkdir(join(fleet.env.xdg.config, 'skillsmith'), { recursive: true });
    await writeFile(join(fleet.env.xdg.config, 'skillsmith', 'config.toml'), 'tool = "codex"\n');
    await seedManaged(['claude-code', 'codex'], 'project');
    const report = requireJson(
      await runCli(['export', '--json'], fleet.project),
      0,
      'bare project export',
    );
    expect(report.requested).toMatchObject({
      tools: ['codex'],
      explicitTools: false,
      scope: 'project',
      explicitScope: false,
    });
    expect(records(report.results).length).toBeGreaterThan(0);
    expect(
      records(report.results).every(
        (row) =>
          Array.isArray(row.tools) &&
          row.tools.includes('codex') &&
          !row.tools.includes('claude-code'),
      ),
    ).toBeTrue();
    expect(report.artifactSelection).toMatchObject({
      outcome: 'selected',
      selectedBy: 'project',
      manifestPath: join(fleet.projectReal, 'skillsmith.toml'),
      lockPath: join(fleet.projectReal, 'skillsmith.lock'),
    });

    const customRoot = join(fleet.home, 'portable', 'custom-skills');
    await seedManaged(['claude-code'], 'user', customRoot);
    const customPaths = exportPaths('custom-path');
    const custom = requireJson(await runCli(exportArgs(customPaths)), 0, 'custom user path');
    expect(records(custom.results).find((row) => row.name === 'factor-scan')).toMatchObject({
      path: '~/portable/custom-skills',
      tools: ['claude-code'],
    });
    expect(await readMaybe(customPaths.manifest)).toContain('path = "~/portable/custom-skills"');

    const scopeConflict = requireJson(
      await runCli(['export', '--user', '--project', '--json']),
      2,
      'equivalent scope conflict',
    );
    expect(scopeConflict).toMatchObject({ kind: 'error', exitCode: 2 });

    const grammarPaths = exportPaths('grammar-refusal');
    requireJson(
      await runCli(['export', '--user', '--lockfile', grammarPaths.lock, '--json']),
      2,
      'lockfile without file',
    );
    requireJson(
      await runCli([
        'export',
        '--user',
        '--file',
        grammarPaths.manifest,
        '--file',
        `${grammarPaths.manifest}.other`,
        '--json',
      ]),
      2,
      'repeated singular file',
    );
    expect(await readMaybe(grammarPaths.manifest)).toBeNull();

    await destroyFixtureFleet(fleet);
    fleet = await buildFixtureFleet();
    const readableNoop = requireJson(
      await runCli(['export', '--user', '--tool', 'kilo-code', '--tool', 'kilo-code', '--json']),
      0,
      'readable tool dedup noop',
    );
    expect(readableNoop.requested).toMatchObject({
      tools: ['kilo-code'],
      explicitTools: true,
    });
    expect(readableNoop.artifactSelection).toMatchObject({
      outcome: 'none',
      reason: 'no-portable-candidates',
    });
  });

  test('EWP-CMD-EXPORT-TS05 compatible default-path tools merge without weakening conflicts', async () => {
    await seedManaged(['claude-code', 'codex']);
    const paths = exportPaths('same-name');
    const args = exportArgs(paths).flatMap((value) =>
      value === 'claude-code' ? ['claude-code', '--tool', 'codex'] : [value],
    );
    const report = requireJson(await runCli(args), 0, 'same-name tool merge');
    const row = records(report.results).find((candidate) => candidate.name === 'factor-scan');
    expect(row?.tools).toEqual(['claude-code', 'codex']);
    const manifest = await readMaybe(paths.manifest);
    expect(manifest).toContain('tools = ["claude-code", "codex"]');

    await destroyFixtureFleet(fleet);
    fleet = await buildFixtureFleet();
    const customRoot = join(fleet.home, 'portable', 'shared');
    await seedManaged(['claude-code', 'codex'], 'user', customRoot);
    const conflictPaths = exportPaths('custom-conflict');
    const customArgs = exportArgs(conflictPaths).flatMap((value) =>
      value === 'claude-code' ? ['claude-code', '--tool', 'codex'] : [value],
    );
    const conflict = requireJson(await runCli(customArgs), 2, 'custom-path tool conflict');
    expect(
      records(conflict.results).some((row) => row.action === 'conflict'),
      JSON.stringify(conflict),
    ).toBeTrue();
    expect(conflict.summary).toMatchObject({ portable: 0, conflicts: 2 });
    expect(Number((conflict.summary as UnknownRecord).observed)).toBe(
      Number((conflict.summary as UnknownRecord).skipped) + 2,
    );
    expect(await readMaybe(conflictPaths.manifest)).toBeNull();
    expect(await readMaybe(conflictPaths.lock)).toBeNull();

    const forced = requireJson(
      await runCli([...customArgs, '--force']),
      2,
      'forced custom-path tool conflict',
    );
    expect(records(forced.results).some((row) => row.action === 'conflict')).toBeTrue();
    expect(await readMaybe(conflictPaths.manifest)).toBeNull();
  });

  test('EWP-CMD-EXPORT-TS06 pair creation and unchanged rerun are lossless and byte-identical', async () => {
    await seedManaged();
    const paths = exportPaths('rerun');
    requireJson(await runCli(exportArgs(paths)), 0, 'first export');
    const first = [await readMaybe(paths.manifest), await readMaybe(paths.lock)] as const;
    expect(first.every((value) => value !== null)).toBeTrue();

    const report = requireJson(await runCli(exportArgs(paths)), 0, 'unchanged export');
    expect(report.summary).toMatchObject({ changed: 0, unchanged: 1 });
    expect([await readMaybe(paths.manifest), await readMaybe(paths.lock)]).toEqual([...first]);

    const legacyPaths = exportPaths('legacy-project');
    const legacySource = '# retained heading\ntool = "codex" # retained default\nscope = "user"\n';
    await mkdir(join(fleet.base, 'exports', 'legacy-project'), { recursive: true });
    await writeFile(legacyPaths.manifest, legacySource);
    const legacyPreview = requireJson(
      await runCli(exportArgs(legacyPaths, ['--dry-run'])),
      0,
      'legacy project preview',
    );
    expect(records(legacyPreview.effects)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'manifest', action: 'migrate', outcome: 'planned' }),
        expect.objectContaining({ role: 'manifest', action: 'update', outcome: 'planned' }),
        expect.objectContaining({ role: 'lock', action: 'create', outcome: 'planned' }),
      ]),
    );
    expect(await readMaybe(legacyPaths.manifest)).toBe(legacySource);
    requireJson(await runCli(exportArgs(legacyPaths)), 0, 'legacy project execution');
    const migratedSource = await readMaybe(legacyPaths.manifest);
    expect(migratedSource).toContain('# retained heading\nversion = 1');
    expect(migratedSource).toContain('factor-scan');
    expect(await readMaybe(legacyPaths.lock)).toContain('factor-scan');

    const incompletePaths = exportPaths('incomplete-lock');
    await mkdir(join(fleet.base, 'exports', 'incomplete-lock'), { recursive: true });
    const incompleteManifest =
      'version = 1\n\n[[skills]]\nname = "retained"\nsource = "github.com/acme/retained//skill"\ntools = ["codex"]\nscope = "user"\nplacement = "symlink"\n';
    await writeFile(incompletePaths.manifest, incompleteManifest);
    requireJson(await runCli(exportArgs(incompletePaths)), 3, 'incomplete lock refusal');
    expect(await readMaybe(incompletePaths.manifest)).toBe(incompleteManifest);
    expect(await readMaybe(incompletePaths.lock)).toBeNull();
  });

  test('EWP-CMD-EXPORT-TS07 dry-run and execution expose equal effects and exact failure classes', async () => {
    await seedManaged();
    const paths = exportPaths('execution');
    const preview = requireJson(
      await runCli(exportArgs(paths, ['--dry-run'])),
      0,
      'export dry-run',
    );
    expect(await readMaybe(paths.manifest)).toBeNull();
    expect(await readMaybe(paths.lock)).toBeNull();

    const execution = requireJson(await runCli(exportArgs(paths)), 0, 'export execution');
    expect(
      records(preview.effects).map(({ role, action, operationId }) => ({
        role,
        action,
        operationId,
      })),
    ).toEqual(
      records(execution.effects).map(({ role, action, operationId }) => ({
        role,
        action,
        operationId,
      })),
    );
    expect(
      records(execution.effects).every(
        (effect) =>
          effect.outcome === 'succeeded' ||
          (effect.role === 'ledger' &&
            effect.action === 'not-written' &&
            effect.outcome === 'not-run'),
      ),
    ).toBeTrue();

    const blockedDirectory = join(fleet.base, 'blocked-export');
    await mkdir(blockedDirectory, { recursive: true });
    await chmod(blockedDirectory, 0o500);
    try {
      const blockedPaths = {
        manifest: join(blockedDirectory, 'skillsmith.toml'),
        lock: join(blockedDirectory, 'skillsmith.lock'),
      };
      const denied = requireJson(
        await runCli(exportArgs(blockedPaths)),
        6,
        'artifact permission denial',
      );
      expect(denied.artifactSelection).toMatchObject({
        outcome: 'refused',
        reason: 'export-permission-denied',
      });
      expect(records(denied.effects).some((effect) => effect.outcome === 'failed')).toBeTrue();
      expect(await readMaybe(blockedPaths.manifest)).toBeNull();
      expect(await readMaybe(blockedPaths.lock)).toBeNull();
    } finally {
      await chmod(blockedDirectory, 0o700);
    }

    const cancelledPaths = exportPaths('cancelled');
    let cancelledProduct: CliProduct | null = null;
    await fleet.env.withFileLock(ledgerPathOf(fleet.data), async () => {
      const child = Bun.spawn(['bun', CLI_ENTRYPOINT, ...exportArgs(cancelledPaths)], {
        cwd: fleet.base,
        env: hermeticGitEnv(
          { ...cliEnv(), GIT_ALLOW_PROTOCOL: 'file:https' },
          { globalConfigPath: gitConfigPath() },
        ),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let exited = false;
      try {
        const compatibilityLocks = [
          `${cancelledPaths.manifest}.lock`,
          `${cancelledPaths.lock}.lock`,
        ] as const;
        const deadline = Date.now() + 10_000;
        let lockKinds = await Promise.all(
          compatibilityLocks.map((path) => fleet.env.pathKind(path)),
        );
        while (Date.now() < deadline && lockKinds.some((kind) => kind !== 'dir')) {
          await Bun.sleep(10);
          lockKinds = await Promise.all(compatibilityLocks.map((path) => fleet.env.pathKind(path)));
        }
        expect(lockKinds, 'export child did not acquire artifact compatibility locks').toEqual([
          'dir',
          'dir',
        ]);
        child.kill('SIGINT');
        cancelledProduct = {
          exitCode: await child.exited,
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
        };
        exited = true;
      } finally {
        if (!exited) {
          child.kill('SIGKILL');
          await child.exited;
        }
      }
    });
    if (cancelledProduct === null) throw new Error('cancelled export product was unavailable');
    const cancelled = requireJson(cancelledProduct, 130, 'artifact cancellation');
    expect(cancelled).toMatchObject({
      kind: 'skillsmith.export',
      artifactSelection: { outcome: 'refused' },
    });
    expect(records(cancelled.effects).some((effect) => effect.outcome === 'cancelled')).toBeTrue();
    expect(await readMaybe(cancelledPaths.manifest)).toBeNull();
    expect(await readMaybe(cancelledPaths.lock)).toBeNull();

    const contendedPaths = exportPaths('contended');
    let contendedProduct: CliProduct | null = null;
    await fleet.env.withFileLock(ledgerPathOf(fleet.data), async () => {
      contendedProduct = await runCli(exportArgs(contendedPaths));
    });
    if (contendedProduct === null) throw new Error('contended export product was unavailable');
    const contended = requireJson(contendedProduct, 3, 'ledger lock contention');
    expect(contended).toMatchObject({
      kind: 'skillsmith.export',
      artifactSelection: { outcome: 'refused', reason: 'export-lock-contention' },
    });
    expect(await readMaybe(contendedPaths.manifest)).toBeNull();
    expect(await readMaybe(contendedPaths.lock)).toBeNull();
  });

  test('EWP-CMD-EXPORT-TS08 local and credential canaries never cross the portable boundary', async () => {
    await seedCleanDev();
    const canary = 'synthetic-export-sensitive-marker';
    await writeFile(join(fleet.alphaSrc, 'LOCAL-CANARY'), `${canary}\n`);
    const paths = exportPaths('scrub');
    const product = await runCli(exportArgs(paths, ['--strict', '--force']));
    const report = requireJson(product, 1, 'strict scrub export');
    const serialized = JSON.stringify(report) + product.stderr;
    expect(serialized).not.toContain(canary);
    expect(report.artifactSelection).toMatchObject({
      manifestPath: paths.manifest,
      lockPath: paths.lock,
    });
    const { artifactSelection: _selectedOutputPaths, ...scrubbedReport } = report;
    expect(JSON.stringify(scrubbedReport) + product.stderr).not.toContain(fleet.base);
    expect(await readMaybe(paths.manifest)).toBeNull();
    expect(await readMaybe(paths.lock)).toBeNull();
  });

  test('EWP-CMD-EXPORT-TS09 copied pair is canonical, correlated, and clean-root readable', async () => {
    await seedManaged();
    const paths = exportPaths('machine-a');
    requireJson(await runCli(exportArgs(paths)), 0, 'Machine A export');
    const manifestBytes = await readFile(paths.manifest);
    const lockBytes = await readFile(paths.lock);

    const machineB = await mkdtemp(join(tmpdir(), 'skillsmith-export-machine-b-'));
    try {
      await mkdir(join(machineB, 'portable'), { recursive: true });
      const copiedManifest = join(machineB, 'portable', 'skillsmith.toml');
      const copiedLock = join(machineB, 'portable', 'skillsmith.lock');
      await Promise.all([
        writeFile(copiedManifest, manifestBytes),
        writeFile(copiedLock, lockBytes),
      ]);
      const parsedManifest = readManifestSource(await readFile(copiedManifest, 'utf8'));
      expect(parsedManifest.ok).toBeTrue();
      if (!parsedManifest.ok) throw new Error('copied manifest did not parse');
      const normalized = normalizeManifestDocument(parsedManifest.value);
      expect(normalized.ok).toBeTrue();
      if (!normalized.ok) throw new Error('copied manifest did not normalize');
      const parsedLock = readPortableLockSource(await readFile(copiedLock));
      expect(parsedLock.ok).toBeTrue();
      if (!parsedLock.ok) throw new Error('copied lock did not parse');
      expect(correlatePortableLock(normalized.value, parsedLock.value).state).toBe('current');
      const canonical = serializePortableLock(parsedLock.value);
      expect(canonical.ok).toBeTrue();
      expect(canonical.ok && canonical.value).toBe(lockBytes.toString());
      expect(`${await readMaybe(copiedManifest)}${await readMaybe(copiedLock)}`).not.toContain(
        fleet.base,
      );
      expect(await readMaybe(join(machineB, 'placements.json'))).toBeNull();
    } finally {
      await rm(machineB, { recursive: true, force: true });
    }
  });
});
