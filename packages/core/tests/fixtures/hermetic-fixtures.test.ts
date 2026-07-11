import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGit } from './git-env.ts';
import { buildRemoteFixture, destroyRemoteFixture } from './acquire/remote.ts';
import { buildFixtureFleet, destroyFixtureFleet } from './place/fleet.ts';

// Reproduces issue #17: lefthook pre-push exports GIT_DIR (no GIT_WORK_TREE),
// so a non-hermetic child git treats its cwd as the worktree of the REAL repo
// and fixture commits land on the branch being pushed.
const POISON_VARS = ['GIT_DIR', 'GIT_INDEX_FILE'] as const;

interface Victim {
  dir: string;
  head: string;
}

const makeVictim = async (): Promise<Victim> => {
  const dir = await mkdtemp(join(tmpdir(), 'skillsmith-victim-'));
  await writeFile(join(dir, 'README.md'), '# victim\n');
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, [
    '-c', 'user.email=victim@skillsmith.test',
    '-c', 'user.name=victim',
    '-c', 'commit.gpgsign=false',
    'add', '-A',
  ]);
  runGit(dir, [
    '-c', 'user.email=victim@skillsmith.test',
    '-c', 'user.name=victim',
    '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'victim: initial',
  ]);
  return { dir, head: runGit(dir, ['rev-parse', 'HEAD']).trim() };
};

const withPoisonedEnv = async <T>(victim: Victim, fn: () => Promise<T>): Promise<T> => {
  const saved: Record<string, string | undefined> = {};
  for (const name of POISON_VARS) saved[name] = process.env[name];
  process.env.GIT_DIR = join(victim.dir, '.git');
  process.env.GIT_INDEX_FILE = join(victim.dir, '.git', 'index');
  try {
    return await fn();
  } finally {
    for (const name of POISON_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
};

// The load-bearing assertions: same HEAD, exactly one commit, clean tree.
const assertVictimUntouched = (victim: Victim): void => {
  expect(runGit(victim.dir, ['rev-parse', 'HEAD']).trim()).toBe(victim.head);
  expect(runGit(victim.dir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  expect(runGit(victim.dir, ['status', '--porcelain']).trim()).toBe('');
};

test('buildRemoteFixture is hermetic under a poisoned hook environment (#17)', async () => {
  const victim = await makeVictim();
  let fixture: Awaited<ReturnType<typeof buildRemoteFixture>> | null = null;
  let builderError: unknown = null;
  try {
    try {
      fixture = await withPoisonedEnv(victim, () => buildRemoteFixture());
    } catch (e) {
      builderError = e;
    }
    assertVictimUntouched(victim);
    expect(builderError).toBeNull();
    expect(fixture?.multiHead).not.toBe(victim.head);
  } finally {
    if (fixture) await destroyRemoteFixture(fixture);
    await rm(victim.dir, { recursive: true, force: true });
  }
});

test('buildFixtureFleet is hermetic under a poisoned hook environment (#17)', async () => {
  const victim = await makeVictim();
  let fleet: Awaited<ReturnType<typeof buildFixtureFleet>> | null = null;
  let builderError: unknown = null;
  try {
    try {
      fleet = await withPoisonedEnv(victim, () => buildFixtureFleet());
    } catch (e) {
      builderError = e;
    }
    assertVictimUntouched(victim);
    expect(builderError).toBeNull();
    expect(fleet?.headSha).not.toBe(victim.head);
  } finally {
    if (fleet) await destroyFixtureFleet(fleet);
    await rm(victim.dir, { recursive: true, force: true });
  }
});
