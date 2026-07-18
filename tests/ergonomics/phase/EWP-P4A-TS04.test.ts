import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
});
