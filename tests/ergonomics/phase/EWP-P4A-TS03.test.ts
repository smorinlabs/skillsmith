import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallDeps, InstallRecord } from '@skillsmith/core';
import { ok, runInstall } from '@skillsmith/core';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
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
      const firstBytes = [await readMaybe(manifest), await readMaybe(lock)] as const;
      expect(firstBytes.every((value) => value !== null)).toBeTrue();

      const rerun = json(await runCli(fleet, args), 0, 'phase unchanged rerun');
      expect(rerun.summary).toMatchObject({ changed: 0 });
      expect([await readMaybe(manifest), await readMaybe(lock)]).toEqual(firstBytes);

      await fleet.makeCheckoutDirty();
      const strictBefore = [await readMaybe(manifest), await readMaybe(lock)] as const;
      const strict = json(
        await runCli(fleet, [...args, '--strict', '--force']),
        1,
        'phase strict matrix',
      );
      expect(strict.summary).toMatchObject({ skipped: 1 });
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
