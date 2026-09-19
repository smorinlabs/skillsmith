import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalizeCommanderTree } from '../../../packages/cli/src/contracts/commander-surface.ts';
import { buildProgram } from '../../../packages/cli/src/program.ts';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/index.ts';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const TEST_BUN_CACHE = join(tmpdir(), 'skillsmith-test-bun-cache');

const runCli = async (
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
) => {
  const child = Bun.spawn(['bun', 'run', CLI_ENTRYPOINT, ...args], {
    cwd: options.cwd ?? ROOT,
    env: hermeticGitEnv({
      BUN_INSTALL_CACHE_DIR: TEST_BUN_CACHE,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      CI: '1',
      NO_COLOR: '1',
      ...options.env,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
};

describe('P17 Phase 6 completion aggregate', () => {
  test('EWP-P6-TS02 closes three shells, parser invisibility, pure callbacks, and native builds', async () => {
    const root = await runCli(['complete', '--', '']);
    expect(root.exitCode, root.stderr).toBe(0);
    expect(root.stderr).toBe('');
    expect(root.stdout).toMatch(/\n:4\n$/);
    expect(root.stdout).toContain('agents\t');
    expect(root.stdout).toContain('ls\t');
    expect(root.stdout).not.toContain('\ncomplete\t');

    const publicPaths = canonicalizeCommanderTree(buildProgram())
      .map(({ path }) => path)
      .filter((path) => path.split(' ').length === 2);
    expect(publicPaths).toHaveLength(24);
    expect(publicPaths).not.toContain('skillsmith complete');
    expect(CURRENT_COMMAND_SPECS.filter((spec) => spec.path.split(' ').length === 2)).toHaveLength(
      24,
    );
    expect((await runCli(['complete'])).exitCode).toBe(2);

    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const first = await runCli(['completion', shell]);
      const second = await runCli(['completion', shell]);
      expect(first).toEqual(second);
      expect(first.exitCode, first.stderr).toBe(0);
      expect(first.stderr).toBe('');
      expect(first.stdout).toContain('skillsmith complete --');
      expect(first.stdout).not.toMatch(/\beval\b/);
      if (shell === 'bash') {
        const syntax = Bun.spawnSync(['bash', '-n'], {
          env: hermeticGitEnv(),
          stdin: Buffer.from(first.stdout),
        });
        expect(syntax.exitCode, syntax.stderr.toString()).toBe(0);
      } else if (shell === 'zsh') {
        expect(first.stdout).toMatch(/^#compdef skillsmith/m);
        expect(first.stdout).toContain('_describe');
      } else {
        expect(first.stdout).toContain('function __skillsmith_perform_completion');
        expect(first.stdout).toContain('skillsmith complete -- $args');
      }
    }

    const fixture = await mkdtemp(join(tmpdir(), 'skillsmith-p6-ts02-build-'));
    try {
      const home = join(fixture, 'home');
      await mkdir(home);
      const canary = join(home, '.bashrc');
      await writeFile(canary, 'completion-canary\n');
      const before = await Bun.file(canary).text();
      expect(
        (
          await runCli(['complete', '--', 'config', ''], {
            cwd: fixture,
            env: { HOME: home, XDG_CONFIG_HOME: join(fixture, 'xdg') },
          })
        ).stdout,
      ).toContain('get\t');
      expect(await Bun.file(canary).text()).toBe(before);

      for (const target of ['bun-linux-x64', 'bun-linux-arm64'] as const) {
        const outfile = join(fixture, `skillsmith-${target}`);
        const build = Bun.spawn(
          [
            'bun',
            'build',
            '--compile',
            '--bytecode',
            `--target=${target}`,
            CLI_ENTRYPOINT,
            '--outfile',
            outfile,
          ],
          {
            cwd: ROOT,
            env: hermeticGitEnv(),
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const exitCode = await build.exited;
        const output = `${await new Response(build.stdout).text()}${await new Response(build.stderr).text()}`;
        expect(exitCode, output).toBe(0);
        expect((await Bun.file(outfile).stat()).size).toBeGreaterThan(0);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 120_000);
});
