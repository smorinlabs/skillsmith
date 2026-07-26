import { describe, expect, test } from 'bun:test';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

const run = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = Bun.spawn(['bun', 'run', CLI_ENTRYPOINT, ...args], {
    env: hermeticGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

describe('skillsmith promote — flag validation', () => {
  test('no positional and no --all -> exit 2', async () => {
    const r = await run(['promote']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--all');
  });

  test('--all combined with a positional -> exit 2', async () => {
    const r = await run(['promote', 'x', '--all']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--all');
  });

  test('--rollback combined with --no-verify -> exit 2', async () => {
    const r = await run(['promote', '--rollback', '--no-verify', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--rollback');
  });

  test('--rollback combined with --strict -> exit 2', async () => {
    const r = await run(['promote', '--rollback', '--strict', 'x']);
    expect(r.code).toBe(2);
  });

  test('--rollback combined with --allow-dirty -> exit 2', async () => {
    const r = await run(['promote', '--rollback', '--allow-dirty', 'x']);
    expect(r.code).toBe(2);
  });

  test('an unknown --tool value -> exit 2', async () => {
    const r = await run(['promote', 'x', '--tool', 'bogus']);
    expect(r.code).toBe(2);
  });

  test('--help exits 0 and includes COMMON WORKFLOWS/EXIT CODES sections', async () => {
    const r = await run(['promote', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('COMMON WORKFLOWS');
    expect(r.stdout).toContain('EXIT CODES');
  });
});
