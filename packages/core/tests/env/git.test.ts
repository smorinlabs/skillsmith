import { describe, expect, test } from 'bun:test';
import { GIT_REPO_LOCAL_ENV_VARS, execGit } from '../../src/env/git.ts';
import type { ExecOptions, ScanEnv } from '../../src/env/types.ts';

describe('execGit', () => {
  test('scrubs repository-local state while preserving command options', async () => {
    let captured:
      | { cmd: string; args: readonly string[]; opts: ExecOptions | undefined }
      | undefined;
    const env = {
      exec: async (cmd: string, args: readonly string[], opts?: ExecOptions) => {
        captured = { cmd, args, opts };
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
    } as unknown as ScanEnv;
    const controller = new AbortController();

    await execGit(env, ['-C', '/repo', 'status'], {
      cwd: '/caller',
      timeoutMs: 123,
      signal: controller.signal,
    });

    expect(captured).toEqual({
      cmd: 'git',
      args: ['-C', '/repo', 'status'],
      opts: {
        cwd: '/caller',
        timeoutMs: 123,
        signal: controller.signal,
        env: { GIT_TERMINAL_PROMPT: '0' },
        unsetEnv: GIT_REPO_LOCAL_ENV_VARS,
      },
    });
  });
});
