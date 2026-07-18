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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallDeps, InstallRecord } from '@skillsmith/core';
import { ok, runInstall } from '@skillsmith/core';
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
      },
      installDeps(),
    );
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
    if (!result.ok) throw new Error('could not seed a managed export fixture');
    expect(result.value.results.every((row) => row.action === 'installed')).toBeTrue();
  }
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

const runCli = async (args: readonly string[], cwd = fleet.base): Promise<CliProduct> => {
  const process = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv(cliEnv()),
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
    const ledger = await readLedgerState(fleet.env, ledgerPathOf(fleet.data));
    expect(ledger.ok).toBeTrue();
    expect(ledger.ok && ledger.value.state).toBe('present');

    const paths = exportPaths('managed');
    const report = requireJson(await runCli(exportArgs(paths)), 0, 'managed export');
    const row = records(report.results).find((candidate) => candidate.name === 'factor-scan');
    expect(row).toMatchObject({
      classification: 'portable-managed',
      tools: ['claude-code'],
      scope: 'user',
    });
    expect(String(row?.source)).toContain('fixture.invalid/acme/multi');
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
    const paths = exportPaths('nonportable');

    const warning = requireJson(await runCli(exportArgs(paths)), 0, 'default dirty export');
    expect(records(warning.results).some((row) => row.classification === 'dirty-git')).toBeTrue();
    expect(await readMaybe(paths.manifest)).toBeNull();
    expect(await readMaybe(paths.lock)).toBeNull();

    const strict = requireJson(
      await runCli(exportArgs(paths, ['--strict', '--force'])),
      1,
      'strict dirty export',
    );
    expect(strict.summary).toMatchObject({ portable: 0, skipped: 1 });
    expect(await readMaybe(paths.manifest)).toBeNull();
    expect(await readMaybe(paths.lock)).toBeNull();
  });

  test('EWP-CMD-EXPORT-TS04 registry grammar, readable tools, scope default, and pair default are exact', async () => {
    const spec = CURRENT_COMMAND_SPECS.find((candidate) => candidate.path === 'skillsmith export');
    expect(spec, 'export must be activated in the sole command registry').toBeDefined();
    expect(spec?.options.map((option) => option.long)).toEqual([
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
    await seedManaged(['claude-code'], 'project');
    const report = requireJson(
      await runCli(['export', '--tool', 'claude-code', '--json'], fleet.project),
      0,
      'bare project export',
    );
    expect(report.requested).toMatchObject({
      scope: 'project',
      explicitScope: false,
    });
    expect(report.artifactSelection).toMatchObject({
      outcome: 'selected',
      selectedBy: 'project',
      manifestPath: join(fleet.projectReal, 'skillsmith.toml'),
      lockPath: join(fleet.projectReal, 'skillsmith.lock'),
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
  });

  test('EWP-CMD-EXPORT-TS06 pair creation and unchanged rerun are lossless and byte-identical', async () => {
    await seedManaged();
    const paths = exportPaths('rerun');
    requireJson(await runCli(exportArgs(paths)), 0, 'first export');
    const first = [await readMaybe(paths.manifest), await readMaybe(paths.lock)] as const;
    expect(first.every((value) => value !== null)).toBeTrue();

    const report = requireJson(await runCli(exportArgs(paths)), 0, 'unchanged export');
    expect(report.summary).toMatchObject({ changed: 0, unchanged: 1 });
    expect([await readMaybe(paths.manifest), await readMaybe(paths.lock)]).toEqual(first);
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
    expect(records(preview.effects).map(({ role, action }) => ({ role, action }))).toEqual(
      records(execution.effects).map(({ role, action }) => ({ role, action })),
    );
    expect(records(execution.effects).every((effect) => effect.outcome === 'succeeded')).toBeTrue();
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
    expect(serialized).not.toContain(fleet.base);
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
