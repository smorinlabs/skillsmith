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
  test('classifies full SHAs offline as immutable closed facts', async () => {
    let calls = 0;
    const git = createGitPort(
      processPort(async () => {
        calls += 1;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }),
      unusedBinaryProcessPort(),
    );
    const requestedRef = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
    const inspection = await git.inspectRemoteRef?.({
      remoteUrl: 'https://example.invalid/repo',
      ref: requestedRef,
    });

    expect(inspection).toEqual({
      kind: 'sha',
      requestedRef,
      resolvedSha: requestedRef.toLowerCase(),
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(calls).toBe(0);
  });

  test('classifies the exact remote default and branch namespaces', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const calls: readonly string[][] = [];
    const recordedCalls = calls as string[][];
    const git = createGitPort(
      processPort(async (_command, args) => {
        recordedCalls.push([...args]);
        const name = args.at(-1) === 'HEAD' ? 'HEAD' : 'refs/heads/main';
        return { code: 0, stdout: `${sha}\t${name}\r\n`, stderr: '', timedOut: false };
      }),
      unusedBinaryProcessPort(),
    );

    await expect(
      git.inspectRemoteRef?.({ remoteUrl: 'https://example.invalid/repo', ref: null }),
    ).resolves.toEqual({ kind: 'default', requestedRef: null, resolvedSha: sha });
    await expect(
      git.inspectRemoteRef?.({ remoteUrl: 'https://example.invalid/repo', ref: 'main' }),
    ).resolves.toEqual({ kind: 'branch', requestedRef: 'main', resolvedSha: sha });
    expect(calls).toEqual([
      ['ls-remote', '--', 'https://example.invalid/repo', 'HEAD'],
      [
        'ls-remote',
        '--',
        'https://example.invalid/repo',
        'refs/heads/main',
        'refs/tags/main',
        'refs/tags/main^{}',
      ],
    ]);
  });

  test('classifies lightweight and annotated tags and peels the latter', async () => {
    const tagObject = '1111111111111111111111111111111111111111';
    const commit = '2222222222222222222222222222222222222222';
    const git = createGitPort(
      processPort(async (_command, args) => {
        const ref = args.at(-1)?.includes('annotated') ? 'annotated' : 'lightweight';
        const stdout =
          ref === 'annotated'
            ? `${tagObject}\trefs/tags/annotated\n${commit}\trefs/tags/annotated^{}\n`
            : `${commit}\trefs/tags/lightweight\n`;
        return { code: 0, stdout, stderr: '', timedOut: false };
      }),
      unusedBinaryProcessPort(),
    );

    await expect(
      git.inspectRemoteRef?.({
        remoteUrl: 'https://example.invalid/repo',
        ref: 'lightweight',
      }),
    ).resolves.toEqual({ kind: 'tag', requestedRef: 'lightweight', resolvedSha: commit });
    await expect(
      git.inspectRemoteRef?.({
        remoteUrl: 'https://example.invalid/repo',
        ref: 'annotated',
      }),
    ).resolves.toEqual({ kind: 'tag', requestedRef: 'annotated', resolvedSha: commit });
  });

  test('refuses exact branch/tag collisions without applying a preference', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const git = createGitPort(
      processPort(async () => ({
        code: 0,
        stdout: `${sha}\trefs/heads/release\n${sha}\trefs/tags/release\n`,
        stderr: '',
        timedOut: false,
      })),
      unusedBinaryProcessPort(),
    );

    await expect(
      git.inspectRemoteRef?.({ remoteUrl: 'https://example.invalid/repo', ref: 'release' }),
    ).rejects.toMatchObject({
      capability: 'git',
      operation: 'inspectRemoteRef',
      code: 'conflict',
    });
  });

  test('refuses missing, malformed, unexpected, and conflicting exact-ref results', async () => {
    const validSha = '0123456789abcdef0123456789abcdef01234567';
    const cases = [
      { stdout: '', code: 'not-found' },
      { stdout: 'short\trefs/heads/main\n', code: 'invalid' },
      { stdout: `${validSha.toUpperCase()}\trefs/heads/main\n`, code: 'invalid' },
      { stdout: `${validSha}\trefs/heads/other\n`, code: 'invalid' },
      {
        stdout: `${validSha}\trefs/heads/main\n${'1'.repeat(40)}\trefs/heads/main\n`,
        code: 'invalid',
      },
      { stdout: `${validSha}\trefs/tags/main^{}\n`, code: 'invalid' },
    ] as const;

    for (const fixture of cases) {
      const git = createGitPort(
        processPort(async () => ({
          code: 0,
          stdout: fixture.stdout,
          stderr: '',
          timedOut: false,
        })),
        unusedBinaryProcessPort(),
      );
      await expect(
        git.inspectRemoteRef?.({ remoteUrl: 'https://example.invalid/repo', ref: 'main' }),
      ).rejects.toMatchObject({
        capability: 'git',
        operation: 'inspectRemoteRef',
        code: fixture.code,
      });
    }
  });

  test('retains structured unavailable, timeout, cancellation, and credential failures', async () => {
    for (const fixture of [
      { code: 1, timedOut: false, expected: 'unavailable' },
      { code: 1, timedOut: true, expected: 'timeout' },
    ] as const) {
      const git = createGitPort(
        processPort(async () => ({
          code: fixture.code,
          stdout: '',
          stderr: 'credential-bearing stderr must not be surfaced',
          timedOut: fixture.timedOut,
        })),
        unusedBinaryProcessPort(),
      );
      let failure: unknown;
      try {
        await git.inspectRemoteRef?.({
          remoteUrl: 'https://example.invalid/repo',
          ref: null,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        capability: 'git',
        operation: 'inspectRemoteRef',
        code: fixture.expected,
      });
      expect(JSON.stringify(failure)).not.toContain('credential-bearing stderr');
    }

    const cancelled = createGitPort(
      processPort(async () => {
        throw portError({
          capability: 'process',
          operation: 'exec',
          code: 'cancelled',
          message: 'process operation was cancelled',
          context: { command: 'git' },
        });
      }),
      unusedBinaryProcessPort(),
    );
    await expect(
      cancelled.inspectRemoteRef?.({ remoteUrl: 'https://example.invalid/repo', ref: null }),
    ).rejects.toMatchObject({
      capability: 'git',
      operation: 'inspectRemoteRef',
      code: 'cancelled',
    });

    let calls = 0;
    const credentialed = createGitPort(
      processPort(async () => {
        calls += 1;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      }),
      unusedBinaryProcessPort(),
    );
    let credentialFailure: unknown;
    try {
      await credentialed.inspectRemoteRef?.({
        remoteUrl: 'https://P17_SECRET_CANARY@example.invalid/repo',
        ref: null,
      });
    } catch (error) {
      credentialFailure = error;
    }
    expect(credentialFailure).toMatchObject({ code: 'invalid' });
    expect(JSON.stringify(credentialFailure)).not.toContain('P17_SECRET_CANARY');
    expect(calls).toBe(0);

    await expect(
      credentialed.inspectRemoteRef?.({
        remoteUrl: 'https://example.invalid/repo?token=P17_SECRET_CANARY',
        ref: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toBe(0);
  });

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
