import { afterEach, describe, test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_REPO_SCRUB_VARS, hermeticGitEnv, runGit, scrubGitRepoEnv } from './git-env.ts';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const withPoisonedProcessEnv = (fn: () => void): void => {
  const saved: Record<string, string | undefined> = {};
  for (const name of GIT_REPO_SCRUB_VARS) {
    saved[name] = process.env[name];
    process.env[name] = '/poisoned';
  }
  try {
    fn();
  } finally {
    for (const name of GIT_REPO_SCRUB_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
};

describe('hermeticGitEnv', () => {
  test('scrubs every repo-location variable inherited from the parent env', () => {
    withPoisonedProcessEnv(() => {
      const env = hermeticGitEnv();
      for (const name of GIT_REPO_SCRUB_VARS) {
        expect(env[name]).toBeUndefined();
      }
    });
  });

  test('pins git config to /dev/null like the previous per-fixture envs did', () => {
    const env = hermeticGitEnv();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
  });

  test('overrides cannot reintroduce scrubbed variables or unpin config', () => {
    const env = hermeticGitEnv({ GIT_DIR: '/explicit/.git', GIT_CONFIG_GLOBAL: '/tmp/cfg' });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });

  test('non-git overrides pass through and unrelated vars are preserved', () => {
    const env = hermeticGitEnv({ HOME: '/tmp/fixture-home', SKILLSMITH_E2E: '1' });
    expect(env.HOME).toBe('/tmp/fixture-home');
    expect(env.SKILLSMITH_E2E).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe('scrubGitRepoEnv', () => {
  test('deletes the scrub vars from process.env itself', () => {
    withPoisonedProcessEnv(() => {
      scrubGitRepoEnv();
      for (const name of GIT_REPO_SCRUB_VARS) {
        expect(process.env[name]).toBeUndefined();
      }
    });
  });
});

describe('runGit', () => {
  test('returns stdout when git exits successfully', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'skillsmith-run-git-'));
    temporaryRoots.push(cwd);

    expect(runGit(cwd, ['--version'])).toMatch(/^git version /);
  });

  test('throws an error containing stderr when git exits non-zero', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'skillsmith-run-git-'));
    temporaryRoots.push(cwd);
    runGit(cwd, ['init', '-q', '-b', 'main']);

    expect(() => runGit(cwd, ['rev-parse', '--verify', 'refs/heads/missing'])).toThrow(
      /git rev-parse --verify refs\/heads\/missing failed:.*fatal:/s,
    );
  });
});
