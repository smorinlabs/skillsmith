import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';

setDefaultTimeout(30_000);

type UnknownRecord = Record<string, unknown>;

const runCli = async (
  cwd: string,
  env: Record<string, string | undefined>,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const process = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv(env),
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

const report = (
  product: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  label: string,
): UnknownRecord => {
  expect(product.exitCode, `${label}\n${product.stdout}\n${product.stderr}`).toBe(0);
  return JSON.parse(product.stdout) as UnknownRecord;
};

describe('EWP-P4A-TS04', () => {
  test('init preview/execution identity changes only one manifest and never its sibling lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p4a-ts04-'));
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    const config = join(root, 'config');
    const data = join(root, 'data');
    const cache = join(root, 'cache');
    const manifest = join(cwd, 'skillsmith.toml');
    const lock = join(cwd, 'skillsmith.lock');
    await Promise.all(
      [cwd, home, config, data, cache].map((path) => mkdir(path, { recursive: true })),
    );
    const cleanEnv = { ...process.env };
    cleanEnv.SKILLSMITH_CONFIG = undefined;
    const env = {
      ...cleanEnv,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      SKILLSMITH_HOME: join(data, 'skillsmith'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      CI: '1',
      NO_COLOR: '1',
    };
    const args = ['init', '--file', manifest, '--tool', 'codex', '--json'] as const;

    try {
      const preview = report(
        await runCli(cwd, env, [...args.slice(0, -1), '--dry-run', '--json']),
        'phase init preview',
      );
      expect(Bun.file(manifest).size).toBe(0);
      expect(Bun.file(lock).size).toBe(0);

      const executed = report(await runCli(cwd, env, args), 'phase init execution');
      expect(preview.result).toEqual(executed.result);
      expect(await readFile(manifest, 'utf8')).toContain('tools = ["codex"]');
      expect(Bun.file(lock).size).toBe(0);
      expect(executed).toMatchObject({
        kind: 'skillsmith.init',
        artifactSelection: { manifestPath: manifest, lockPath: lock },
        summary: { changed: 1, unchanged: 0 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('legacy, noop, opaque replacement, and future refusal preserve all non-manifest bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p4a-ts04-matrix-'));
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    const config = join(root, 'config');
    const data = join(root, 'data');
    const cache = join(root, 'cache');
    await Promise.all(
      [cwd, home, config, data, cache].map((path) => mkdir(path, { recursive: true })),
    );
    const cleanEnv = { ...process.env };
    cleanEnv.SKILLSMITH_CONFIG = undefined;
    const env = {
      ...cleanEnv,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      SKILLSMITH_HOME: join(data, 'skillsmith'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      CI: '1',
      NO_COLOR: '1',
    };
    const lock = join(cwd, 'skillsmith.lock');
    const live = join(cwd, 'live.canary');
    const ledger = join(data, 'skillsmith', 'placements.json');
    await mkdir(join(data, 'skillsmith'), { recursive: true });
    await writeFile(lock, 'lock-canary\n');
    await writeFile(live, 'live-canary\n');
    await writeFile(ledger, 'ledger-canary\n');

    try {
      const legacy = join(cwd, 'legacy.toml');
      await writeFile(legacy, 'tool = "codex"\nscope = "project"\n');
      expect(
        report(
          await runCli(cwd, env, [
            'init',
            '--file',
            legacy,
            '--tool',
            'codex',
            '--scope',
            'project',
            '--json',
          ]),
          'legacy',
        ).result,
      ).toMatchObject({ action: 'migrate-project-config', before: { shape: 'legacy' } });

      const noop = report(
        await runCli(cwd, env, [
          'init',
          '--file',
          legacy,
          '--tool',
          'codex',
          '--scope',
          'project',
          '--json',
        ]),
        'canonical noop',
      );
      expect(noop).toMatchObject({ result: { action: 'noop' }, summary: { unchanged: 1 } });

      const opaque = join(cwd, 'opaque.toml');
      await writeFile(opaque, Uint8Array.from([0xff, 0xfe, 0xfd]));
      expect(
        report(
          await runCli(cwd, env, ['init', '--file', opaque, '--force', '--json']),
          'opaque replacement',
        ).result,
      ).toMatchObject({ action: 'replace-manifest', before: { shape: 'malformed' } });

      const future = join(cwd, 'future.toml');
      await writeFile(future, 'version = 2\n');
      const futureResult = await runCli(cwd, env, ['init', '--file', future, '--force', '--json']);
      expect(futureResult.exitCode).toBe(3);
      expect(JSON.parse(futureResult.stdout)).toMatchObject({
        kind: 'error',
        code: 'init-future-manifest',
      });
      expect(await readFile(future, 'utf8')).toBe('version = 2\n');
      expect(await readFile(lock, 'utf8')).toBe('lock-canary\n');
      expect(await readFile(live, 'utf8')).toBe('live-canary\n');
      expect(await readFile(ledger, 'utf8')).toBe('ledger-canary\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
