import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallDeps, InstallRecord } from '@skillsmith/core';
import { ok, runInstall } from '@skillsmith/core';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { ledgerV1Codec } from '../../../packages/core/src/artifacts/ledger-codec.ts';
import type {
  LedgerSkillsV1Dto,
  LedgerV1Dto,
} from '../../../packages/core/src/artifacts/ledger-types.ts';
import { readLedgerState } from '../../../packages/core/src/place/ledger.ts';
import { ledgerPathOf } from '../../../packages/core/src/place/paths.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../packages/core/tests/fixtures/acquire/remote.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../packages/core/tests/fixtures/place/fleet.ts';

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
let txSequence = 0;

beforeAll(async () => {
  remote = await buildRemoteFixture();
});

afterAll(async () => {
  await destroyRemoteFixture(remote);
});

const detectTools: InstallDeps['detect'] = async (_env, tool) =>
  ok<InstallRecord[]>([
    {
      path: `/fixture/bin/${tool}`,
      version: '1.0.0',
      installMethod: 'unknown',
    },
  ]);

const seedManaged = async (fleet: FixtureFleet): Promise<void> => {
  for (const tool of ['claude-code', 'codex'] as const) {
    const sequence = txSequence++;
    const result = await runInstall(
      fleet.env,
      {
        sources: [`${remote.multiSource}//plugins/fh/skills/factor-scan`],
        tools: [tool],
        scope: 'user',
        noSave: true,
        noVerify: true,
        cwd: fleet.base,
        configuration: fleet.configuration,
      },
      {
        detect: detectTools,
        verify: async () => {
          throw new Error('phase export fixture requested verification despite noVerify');
        },
        transport: remote.transport,
        now: () => '2026-07-18T00:00:00.000Z',
        newTxId: () => (0x50000000 + sequence).toString(16),
      },
    );
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
    if (!result.ok) throw new Error('could not seed the phase export fixture');
    expect(result.value.results.map((row) => row.action)).toEqual(['installed']);
  }
};

const downgradeLedgerToV1 = async (fleet: FixtureFleet): Promise<void> => {
  const path = ledgerPathOf(fleet.data);
  const current = await readLedgerState(fleet.env, path);
  if (!current.ok || current.value.state !== 'present') {
    throw new Error('phase export ledger fixture was unavailable');
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
            Object.entries(current.value.model.projects).map(([projectRoot, project]) => [
              projectRoot,
              { skills: project.skills as LedgerSkillsV1Dto },
            ]),
          ),
        }),
  };
  const model = ledgerV1Codec.fromDto(dto);
  if (!model.ok) throw new Error('phase export v1 fixture was invalid');
  const encoded = ledgerV1Codec.encode(model.value);
  if (!encoded.ok) throw new Error('phase export v1 fixture could not be encoded');
  await writeFile(path, encoded.value);
};

const runCli = async (fleet: FixtureFleet, args: readonly string[]): Promise<CliProduct> => {
  const process = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd: fleet.base,
    env: hermeticGitEnv({
      HOME: fleet.home,
      XDG_CONFIG_HOME: fleet.env.xdg.config,
      XDG_DATA_HOME: fleet.env.xdg.data,
      XDG_CACHE_HOME: fleet.env.xdg.cache,
      SKILLSMITH_HOME: fleet.data,
      CLAUDE_CONFIG_DIR: join(fleet.home, '.claude'),
      CODEX_HOME: join(fleet.home, '.codex'),
      CI: '1',
      NO_COLOR: '1',
    }),
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

const json = (product: CliProduct, expectedExit: number, label: string): UnknownRecord => {
  expect(product.exitCode, `${label}\nstdout:\n${product.stdout}\nstderr:\n${product.stderr}`).toBe(
    expectedExit,
  );
  let value: unknown;
  try {
    value = JSON.parse(product.stdout);
  } catch {
    throw new Error(`${label}: stdout was not JSON`);
  }
  expect(isRecord(value)).toBeTrue();
  if (!isRecord(value)) throw new Error(`${label}: report was not an object`);
  return value;
};

describe('EWP-P4A-TS03', () => {
  test('export portable/nonportable, merge, migration, refusal, strict, and rerun matrix', async () => {
    const fleet = await buildFixtureFleet();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p4a-ts03-artifacts-'));
    const manifest = join(root, 'portable', 'skillsmith.toml');
    const lock = join(root, 'portable', 'skillsmith.lock');
    const args = [
      'export',
      '--user',
      '--tool',
      'claude-code',
      '--tool',
      'codex',
      '--file',
      manifest,
      '--lockfile',
      lock,
      '--json',
    ] as const;

    try {
      await seedManaged(fleet);
      const devSeed = await runCli(fleet, [
        'dev',
        'alpha',
        '--tool',
        'claude-code',
        '--source',
        fleet.alphaSrc,
        '--no-verify',
        '--json',
      ]);
      expect(devSeed.exitCode, devSeed.stderr).toBe(0);
      expect(await readMaybe(manifest)).toBeNull();
      expect(await readMaybe(lock)).toBeNull();
      await downgradeLedgerToV1(fleet);

      const first = json(await runCli(fleet, args), 0, 'phase export matrix');
      const rows = records(first.results);
      expect(rows.find((row) => row.name === 'factor-scan')).toMatchObject({
        classification: 'portable-managed',
        tools: ['claude-code', 'codex'],
      });
      expect(rows.find((row) => row.name === 'alpha')).toMatchObject({
        classification: 'portable-dev',
      });
      expect(rows.some((row) => row.classification === 'unmanaged')).toBeTrue();
      expect(records(first.effects)).toContainEqual(
        expect.objectContaining({ role: 'ledger', action: 'migrate', outcome: 'succeeded' }),
      );
      const migratedLedger = await readLedgerState(fleet.env, ledgerPathOf(fleet.data));
      expect(migratedLedger.ok && migratedLedger.value.sourceVersion).toBe(2);
      const firstBytes = [await readMaybe(manifest), await readMaybe(lock)] as const;
      expect(firstBytes.every((value) => value !== null)).toBeTrue();

      const rerun = json(await runCli(fleet, args), 0, 'phase unchanged rerun');
      expect(rerun.summary).toMatchObject({ changed: 0 });
      expect([await readMaybe(manifest), await readMaybe(lock)]).toEqual(firstBytes);

      for (const scope of ['system', 'managed'] as const) {
        const scopeManifest = join(root, scope, 'skillsmith.toml');
        const scopeLock = join(root, scope, 'skillsmith.lock');
        const scoped = json(
          await runCli(fleet, [
            'export',
            `--${scope}`,
            '--tool',
            'claude-code',
            '--file',
            scopeManifest,
            '--lockfile',
            scopeLock,
            '--json',
          ]),
          0,
          `phase ${scope} nonrepresentable scope`,
        );
        expect(scoped.requested).toMatchObject({ scope });
        expect(
          records(scoped.results).every((row) => row.classification === 'unsupported-scope'),
        ).toBeTrue();
        expect(await readMaybe(scopeManifest)).toBeNull();
        expect(await readMaybe(scopeLock)).toBeNull();
      }

      await fleet.makeCheckoutDirty();
      const strictBefore = [await readMaybe(manifest), await readMaybe(lock)] as const;
      const strict = json(
        await runCli(fleet, [...args, '--strict', '--force']),
        1,
        'phase strict matrix',
      );
      expect(strict.summary).toMatchObject({ portable: 1 });
      expect(Number((strict.summary as UnknownRecord).skipped)).toBeGreaterThanOrEqual(1);
      expect([await readMaybe(manifest), await readMaybe(lock)]).toEqual(strictBefore);

      await mkdir(join(root, 'portable'), { recursive: true });
      await writeFile(lock, 'invalid portable lock\n');
      const invalidBefore = [await readMaybe(manifest), await readMaybe(lock)] as const;
      const invalid = await runCli(fleet, args);
      expect(invalid.exitCode).toBe(3);
      expect([await readMaybe(manifest), await readMaybe(lock)]).toEqual(invalidBefore);
    } finally {
      await Promise.all([destroyFixtureFleet(fleet), rm(root, { recursive: true, force: true })]);
    }
  });
});
