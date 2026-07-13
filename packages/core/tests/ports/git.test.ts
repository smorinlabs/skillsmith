import { describe, expect, test } from 'bun:test';
import { createGitPort } from '../../src/ports/git.ts';
import type { ProcessPort } from '../../src/ports/types.ts';

const processPort = (exec: ProcessPort['exec']): ProcessPort => ({
  exec,
  runVersion: async () => 'unknown',
});

describe('GitPort', () => {
  test('resolves full SHAs without arbitrary process execution', async () => {
    let calls = 0;
    const git = createGitPort(
      processPort(async () => {
        calls += 1;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }),
    );
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(
      await git.resolveRemoteRef({ remoteUrl: 'https://example.invalid/repo', ref: sha }),
    ).toBe(sha);
    expect(calls).toBe(0);
  });

  test('sanitizes process failures at the named Git operation boundary', async () => {
    const git = createGitPort(
      processPort(async () => {
        throw new Error('spawn failed');
      }),
    );
    let failure: unknown;
    try {
      await git.readBlob({ repositoryRoot: '/repo', ref: 'HEAD', path: 'SKILL.md' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ capability: 'git', operation: 'readBlob' });
    expect(failure).not.toHaveProperty('cause');
  });

  test('forwards request cancellation to Git process execution', async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const git = createGitPort(
      processPort(async (_command, _args, options) => {
        signals.push(options?.signal);
        return { code: 0, stdout: 'contents', stderr: '', timedOut: false };
      }),
    );

    await git.readBlob({
      repositoryRoot: '/repo',
      ref: 'HEAD',
      path: 'SKILL.md',
      signal: controller.signal,
    });

    expect(signals).toEqual([controller.signal]);
  });
});
