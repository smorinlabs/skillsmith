import { describe, expect, test } from 'bun:test';
import { portError } from '../../src/ports/errors.ts';
import { type BinaryProcessPort, createGitPort } from '../../src/ports/git.ts';
import type { ProcessPort } from '../../src/ports/types.ts';

const processPort = (exec: ProcessPort['exec']): ProcessPort => ({
  exec,
  runVersion: async () => 'unknown',
});

const binaryProcessPort = (exec: BinaryProcessPort['exec']): BinaryProcessPort => ({ exec });

const unusedBinaryProcessPort = (): BinaryProcessPort =>
  binaryProcessPort(async () => ({
    code: 0,
    stdout: new Uint8Array(),
    stderr: '',
    timedOut: false,
  }));

describe('GitPort', () => {
  test('resolves full SHAs without arbitrary process execution', async () => {
    let calls = 0;
    const git = createGitPort(
      processPort(async () => {
        calls += 1;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }),
      unusedBinaryProcessPort(),
    );
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(
      await git.resolveRemoteRef({ remoteUrl: 'https://example.invalid/repo', ref: sha }),
    ).toBe(sha);
    expect(calls).toBe(0);
  });

  test('sanitizes process failures at the named Git operation boundary', async () => {
    const git = createGitPort(
      processPort(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
      binaryProcessPort(async () => {
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

  test('preserves the last five actionable stderr lines in structured failures', async () => {
    const git = createGitPort(
      processPort(async () => ({
        code: 1,
        stdout: '',
        stderr: ['line 1', '', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7'].join(
          '\n',
        ),
        timedOut: false,
      })),
      unusedBinaryProcessPort(),
    );

    await expect(git.listTree({ repositoryRoot: '/repo', ref: 'HEAD' })).rejects.toMatchObject({
      capability: 'git',
      operation: 'listTree',
      message: 'line 3\nline 4\nline 5\nline 6\nline 7',
    });
  });

  test('forwards request cancellation to Git process execution', async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const git = createGitPort(
      processPort(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
      binaryProcessPort(async (_command, _args, options) => {
        signals.push(options?.signal);
        return { code: 0, stdout: new Uint8Array(), stderr: '', timedOut: false };
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

  test('preserves cancellation truth at the named Git boundary', async () => {
    const git = createGitPort(
      processPort(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
      binaryProcessPort(async () => {
        throw portError({
          capability: 'process',
          operation: 'exec',
          code: 'cancelled',
          message: 'process operation was cancelled',
          context: { command: 'git' },
        });
      }),
    );

    await expect(
      git.readBlob({ repositoryRoot: '/repo', ref: 'HEAD', path: 'SKILL.md' }),
    ).rejects.toMatchObject({
      capability: 'git',
      operation: 'readBlob',
      code: 'cancelled',
    });
  });

  test('keeps arbitrary blob bytes intact through the binary process boundary', async () => {
    const blob = new Uint8Array([0xff, 0x00, 0xfe, 0x80]);
    const git = createGitPort(
      processPort(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })),
      binaryProcessPort(async () => ({ code: 0, stdout: blob, stderr: '', timedOut: false })),
    );

    expect(
      await git.readBlob({ repositoryRoot: '/repo', ref: 'HEAD', path: 'binary.dat' }),
    ).toEqual(blob);
  });

  test('preserves tree object mode and commit entries for exact content projection', async () => {
    const git = createGitPort(
      processPort(async () => ({
        code: 0,
        stdout: [
          `100755 blob ${'a'.repeat(40)}\tbin/run.sh`,
          `120000 blob ${'b'.repeat(40)}\tlink.md`,
          `160000 commit ${'c'.repeat(40)}\tvendor/submodule`,
          '',
        ].join('\0'),
        stderr: '',
        timedOut: false,
      })),
      unusedBinaryProcessPort(),
    );

    expect(await git.listTree({ repositoryRoot: '/repo', ref: 'HEAD' })).toEqual([
      { mode: '100755', kind: 'blob', path: 'bin/run.sh' },
      { mode: '120000', kind: 'blob', path: 'link.md' },
      { mode: '160000', kind: 'commit', path: 'vendor/submodule' },
    ]);
  });

  test('delimits intent fields and restores bounded fetch and checkout execution', async () => {
    const calls: Array<{ args: readonly string[]; timeoutMs: number | undefined }> = [];
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const git = createGitPort(
      processPort(async (_command, args, options) => {
        calls.push({ args, timeoutMs: options?.timeoutMs });
        return {
          code: 0,
          stdout: args.includes('rev-parse') ? `${sha}\n` : '',
          stderr: '',
          timedOut: false,
        };
      }),
      unusedBinaryProcessPort(),
    );

    await git.fetchRef({ repositoryRoot: '/repo', ref: '--upload-pack=pwn' });
    await git.materializeTree({ repositoryRoot: '/repo', ref: sha, path: '--stdin' });

    const fetch = calls.find(({ args }) => args.includes('fetch'));
    expect(fetch?.args.slice(-3)).toEqual(['--', 'origin', '--upload-pack=pwn']);
    expect(fetch?.timeoutMs).toBe(120_000);
    const sparse = calls.find(({ args }) => args.includes('set'));
    expect(sparse?.args.slice(-2)).toEqual(['--', '--stdin']);
    expect(sparse?.timeoutMs).toBe(10_000);
    const checkout = calls.find(({ args }) => args.includes('checkout'));
    expect(checkout?.timeoutMs).toBe(120_000);
  });

  test('rejects undelimitable revision options before process execution', async () => {
    let calls = 0;
    const git = createGitPort(
      processPort(async () => {
        calls += 1;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }),
      unusedBinaryProcessPort(),
    );

    await expect(git.listTree({ repositoryRoot: '/repo', ref: '--help' })).rejects.toMatchObject({
      capability: 'git',
      operation: 'listTree',
      code: 'invalid',
    });
    expect(calls).toBe(0);
  });
});
