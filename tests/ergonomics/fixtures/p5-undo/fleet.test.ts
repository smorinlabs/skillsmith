import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_OPTIONAL_LOCKS: '0',
};

function observeGit(cwd: string, args: string[]): string {
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

test.each(['hook', 'trio'])(
  'undo fixture creation, source commit and local install preserve outer repository under %s poison (#17)',
  async (poison) => {
    const base = await mkdtemp(join(tmpdir(), 'skillsmith-undo-recurrence-'));
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
      const script = `
import { createUndoFleet, destroyUndoFleet, seedDev, seedInstall } from ${JSON.stringify(join(import.meta.dir, 'fleet.ts'))};
import { runGit } from ${JSON.stringify(join(import.meta.dir, '../../../../packages/core/tests/fixtures/git-env.ts'))};
const fleet = await createUndoFleet();
try {
  const initial = runGit(fleet.sourceRepository, ['rev-parse', 'HEAD']).trim();
  await seedDev(fleet, { skill: 'new-fixture-skill' });
  const added = runGit(fleet.sourceRepository, ['rev-parse', 'HEAD']).trim();
  await seedInstall(fleet);
  console.log(JSON.stringify({ initial, added, count: runGit(fleet.sourceRepository, ['rev-list', '--count', 'HEAD']).trim() }));
} finally { await destroyUndoFleet(fleet); }
`;
      const child = Bun.spawn([process.execPath, '--eval', script], {
        cwd: base,
        env: {
          ...cleanEnvironment,
          HOME: home,
          XDG_CONFIG_HOME: home,
          TMPDIR: temporary,
          GIT_DIR: join(outer, '.git'),
          GIT_INDEX_FILE: join(outer, '.git/index'),
          ...(poison === 'trio' ? { GIT_WORK_TREE: outer } : {}),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      try {
        const exitCode = await child.exited;
        expect(await identity(outer)).toEqual(before);
        const output = await stdout;
        const error = await stderr;
        expect({ exitCode, error }).toEqual({ exitCode: 0, error: '' });
        const result = JSON.parse(output) as { initial: string; added: string; count: string };
        expect(result.initial).toMatch(/^[0-9a-f]{40}$/);
        expect(result.added).toMatch(/^[0-9a-f]{40}$/);
        expect(result.added).not.toBe(result.initial);
        expect(result.count).toBe('2');
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
  25_000,
);
