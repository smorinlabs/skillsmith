import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

setDefaultTimeout(30_000);

type UnknownRecord = Record<string, unknown>;

interface CliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface InitFixture {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly cache: string;
}

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fixture = async (): Promise<InitFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-init-contract-'));
  fixtures.push(root);
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  const config = join(root, 'xdg', 'config');
  const data = join(root, 'xdg', 'data');
  const cache = join(root, 'xdg', 'cache');
  await Promise.all(
    [cwd, home, config, data, cache].map((path) => mkdir(path, { recursive: true })),
  );
  return { root, cwd, home, config, data, cache };
};

const runCli = async (
  value: InitFixture,
  args: readonly string[],
  cwd = value.cwd,
): Promise<CliProduct> => {
  const process = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv({
      ...processEnvWithoutConfig(),
      HOME: value.home,
      XDG_CONFIG_HOME: value.config,
      XDG_DATA_HOME: value.data,
      XDG_CACHE_HOME: value.cache,
      SKILLSMITH_HOME: join(value.data, 'skillsmith'),
      CLAUDE_CONFIG_DIR: join(value.home, '.claude'),
      CODEX_HOME: join(value.home, '.codex'),
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

const processEnvWithoutConfig = (): Record<string, string | undefined> => {
  const env = { ...process.env };
  env.SKILLSMITH_CONFIG = undefined;
  return env;
};

const json = (product: CliProduct, expectedExit: number, label: string): UnknownRecord => {
  expect(product.exitCode, `${label}\nstdout:\n${product.stdout}\nstderr:\n${product.stderr}`).toBe(
    expectedExit,
  );
  let value: unknown;
  try {
    value = JSON.parse(product.stdout);
  } catch {
    throw new Error(`${label}: stdout was not one JSON document`);
  }
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBeFalse();
  return value as UnknownRecord;
};

const readMaybe = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

describe('EWP-CMD-INIT-TS01', () => {
  test('bare init creates the exact minimal XDG manifest and no sibling lock outside Git', async () => {
    const value = await fixture();
    const manifest = join(value.config, 'skillsmith', 'skillsmith.toml');
    const lock = join(value.config, 'skillsmith', 'skillsmith.lock');

    const product = await runCli(value, ['init']);

    expect(product.exitCode, product.stderr).toBe(0);
    expect(await readFile(manifest, 'utf8')).toBe('version = 1\n');
    expect(await readMaybe(lock)).toBeNull();
    expect(product.stdout).toContain(manifest);
    expect(product.stdout).toContain(lock);
  });
});

describe('EWP-CMD-INIT-TS02', () => {
  test('explicit file, tool, and project scope shape one non-mutating canonical preview', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'team.toml');
    const report = json(
      await runCli(value, [
        'init',
        '--file',
        'team.toml',
        '--tool',
        'codex',
        '--scope',
        'project',
        '--dry-run',
        '--json',
      ]),
      0,
      'explicit init preview',
    );

    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: 'skillsmith.init',
      reportVersion: 1,
      dryRun: true,
      requested: {
        tools: ['codex'],
        explicitTools: true,
        toolSource: 'explicit',
        scope: 'project',
        explicitScope: true,
        file: manifest,
        force: false,
      },
      defaults: { tools: ['codex'], scope: 'project' },
      artifactSelection: { selectedBy: 'explicit-file', manifestPath: manifest },
      result: { action: 'create-manifest' },
      summary: { changed: 1, unchanged: 0 },
    });
    expect(await readMaybe(manifest)).toBeNull();
  });
});

describe('EWP-CMD-INIT-TS03', () => {
  test('force replaces only the selected invalid manifest and preserves sibling canaries', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'skillsmith.toml');
    const lock = join(value.cwd, 'skillsmith.lock');
    const live = join(value.cwd, 'live.canary');
    const ledger = join(value.data, 'skillsmith', 'placements.json');
    await mkdir(join(value.data, 'skillsmith'), { recursive: true });
    await writeFile(manifest, 'unknown = true\n');
    await writeFile(lock, 'lock-canary\n');
    await writeFile(live, 'live-canary\n');
    await writeFile(ledger, 'ledger-canary\n');

    const report = json(
      await runCli(value, ['init', '--file', manifest, '--force', '--json']),
      0,
      'forced init replacement',
    );

    expect(report.result).toMatchObject({ action: 'replace-manifest' });
    expect(report.force).toMatchObject({
      requested: true,
      applied: true,
      conflictType: 'destination-exists',
      normalBehavior: 'refuse',
      forcedBehavior: 'backup-and-replace',
      backup: 'required',
    });
    expect(await readFile(manifest, 'utf8')).toBe('version = 1\n');
    expect(await readFile(lock, 'utf8')).toBe('lock-canary\n');
    expect(await readFile(live, 'utf8')).toBe('live-canary\n');
    expect(await readFile(ledger, 'utf8')).toBe('ledger-canary\n');
  });
});

describe('EWP-CMD-INIT-TS04', () => {
  test('dry-run and execution expose the same immutable create operation', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'skillsmith.toml');
    const args = ['init', '--file', manifest, '--tool', 'codex', '--json'] as const;
    const preview = json(
      await runCli(value, [...args.slice(0, -1), '--dry-run', '--json']),
      0,
      'init dry-run',
    );
    expect(await readMaybe(manifest)).toBeNull();
    const executed = json(await runCli(value, args), 0, 'init execution');

    expect(preview.result).toEqual(executed.result);
    expect((preview.effects as readonly unknown[])[0]).toMatchObject({ outcome: 'planned' });
    expect((executed.effects as readonly unknown[])[0]).toMatchObject({ outcome: 'succeeded' });
    expect(await readFile(manifest, 'utf8')).toContain('tools = ["codex"]');
  });
});

describe('EWP-CMD-INIT-TS05', () => {
  test('help, completion, JSON errors, and the activated grammar agree', async () => {
    const value = await fixture();
    const help = await runCli(value, ['init', '--help']);
    expect(help.exitCode, help.stderr).toBe(0);
    for (const fragment of [
      '--file <path>',
      '--tool <name>',
      '--scope <scope>',
      '--force',
      '--dry-run',
    ]) {
      expect(help.stdout).toContain(fragment);
    }

    const completion = await runCli(value, ['completion', 'bash']);
    expect(completion.exitCode, completion.stderr).toBe(0);
    expect(completion.stdout).toContain('init');

    const unsupported = json(
      await runCli(value, ['init', '--tool', 'kilo-code', '--json']),
      4,
      'init unsupported mutation tool',
    );
    expect(unsupported).toMatchObject({ kind: 'error', code: 'capability', exitCode: 4 });
  });
});
