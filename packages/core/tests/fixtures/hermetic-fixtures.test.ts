import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

// The observer is deliberately independent of the Git helper under test. Poison
// is delivered only to a fresh non-test Bun process, so no preload can hide it.
const cleanEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_OPTIONAL_LOCKS: '0',
};

function observeGit(cwd: string, args: string[]): string {
  // eslint-disable-next-line skillsmith/hermetic-test-spawn -- independent clean observer must not call the helper being tested
  const result = Bun.spawnSync(
    [
      'git',
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${devNull}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Skillsmith Test',
      '-c',
      'user.email=skillsmith@example.invalid',
      ...args,
    ],
    { cwd, env: { ...cleanEnvironment, HOME: cwd }, stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function identity(root: string) {
  const digest = async (path: string) =>
    createHash('sha256')
      .update(await readFile(join(root, path)))
      .digest('hex');
  return {
    head: observeGit(root, ['rev-parse', 'HEAD']),
    ref: observeGit(root, ['symbolic-ref', 'HEAD']),
    index: await digest('.git/index'),
    config: await digest('.git/config'),
    sentinel: await digest('README.md'),
    count: observeGit(root, ['rev-list', '--count', 'HEAD']),
    status: observeGit(root, ['status', '--porcelain']),
  };
}

const cases = ['hook', 'trio', 'common', 'objects', 'config', 'discovery'] as const;
for (const kind of ['remote', 'fleet'] as const) {
  test.each([...cases])(
    `${kind} fixture preserves outer HEAD/index/config under %s poison (#17)`,
    async (poison) => {
      const base = await mkdtemp(join(tmpdir(), 'skillsmith-hermetic-recurrence-'));
      const outer = join(base, 'outer');
      const home = join(base, 'home');
      const temporary = join(base, 'tmp');
      try {
        await Promise.all([outer, home, temporary].map((path) => mkdir(path)));
        await writeFile(join(outer, 'README.md'), '# sacrificial outer repository\n');
        observeGit(outer, ['init', '-q', '-b', 'main']);
        observeGit(outer, ['config', 'fixture.sentinel', 'retained']);
        observeGit(outer, ['add', '-A']);
        observeGit(outer, ['commit', '-qm', 'test: sacrificial outer']);
        const before = await identity(outer);
        const gitDirectory = join(outer, '.git');
        const redirect = { GIT_DIR: gitDirectory, GIT_INDEX_FILE: join(gitDirectory, 'index') };
        const poisonEnvironment: Record<string, string> =
          poison === 'hook'
            ? redirect
            : poison === 'trio'
              ? { ...redirect, GIT_WORK_TREE: outer }
              : poison === 'common'
                ? { ...redirect, GIT_COMMON_DIR: gitDirectory }
                : poison === 'objects'
                  ? {
                      GIT_OBJECT_DIRECTORY: join(gitDirectory, 'objects'),
                      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDirectory, 'objects'),
                    }
                  : poison === 'config'
                    ? {
                        GIT_CONFIG_COUNT: '1',
                        GIT_CONFIG_KEY_0: 'core.worktree',
                        GIT_CONFIG_VALUE_0: outer,
                        GIT_CONFIG_PARAMETERS: "'core.bare=false'",
                      }
                    : {
                        GIT_CEILING_DIRECTORIES: base,
                        GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
                        GIT_NAMESPACE: 'fixture-namespace',
                      };
        const script = `
import { buildRemoteFixture, destroyRemoteFixture } from ${JSON.stringify(join(import.meta.dir, 'acquire/remote.ts'))};
import { buildFixtureFleet, destroyFixtureFleet } from ${JSON.stringify(join(import.meta.dir, 'place/fleet.ts'))};
const kind = ${JSON.stringify(kind)};
const fixture = await (kind === 'remote' ? buildRemoteFixture() : buildFixtureFleet());
try {
  console.log(JSON.stringify({ head: kind === 'remote' ? fixture.multiHead : fixture.headSha, canary: process.env.SKILLSMITH_ISOLATION_CANARY }));
} finally { await (kind === 'remote' ? destroyRemoteFixture(fixture) : destroyFixtureFleet(fixture)); }
`;
        // eslint-disable-next-line skillsmith/hermetic-test-spawn -- deliberate poison targets only the sacrificial outer repo; parent checks its raw identity
        const child = Bun.spawn([process.execPath, '--eval', script], {
          cwd: base,
          env: {
            ...cleanEnvironment,
            HOME: home,
            XDG_CONFIG_HOME: home,
            TMPDIR: temporary,
            SKILLSMITH_ISOLATION_CANARY: 'retained',
            ...poisonEnvironment,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const stdout = new Response(child.stdout).text();
        const stderr = new Response(child.stderr).text();
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        try {
          const exitCode = await child.exited;
          expect(await identity(outer)).toEqual(before);
          const output = await stdout;
          const error = await stderr;
          expect({ exitCode, error }).toEqual({ exitCode: 0, error: '' });
          const result = JSON.parse(output) as { head: string; canary: string };
          expect(result.head).toMatch(/^[0-9a-f]{40}$/);
          expect(result.head).not.toBe(before.head);
          expect(result.canary).toBe('retained');
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) {
            child.kill('SIGKILL');
            await child.exited;
          }
        }
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    },
    20_000,
  );
}
