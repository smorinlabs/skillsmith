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

describe('skillsmith dev — flag validation', () => {
  test('no positional and no --all -> exit 2', async () => {
    const r = await run(['dev']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--all');
  });

  test('--all combined with a positional -> exit 2', async () => {
    const r = await run(['dev', 'x', '--all']);
    expect(r.code).toBe(2);
  });

  test('--source with two positional targets -> exit 2', async () => {
    const r = await run(['dev', 'x', 'y', '--source', '/tmp']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--source');
  });

  test('--rollback combined with --source -> exit 2', async () => {
    const r = await run(['dev', '--rollback', '--source', '/tmp', 'x']);
    expect(r.code).toBe(2);
  });

  // BF-7(c): rollback takes none of the create/gate flags (matches promote's discipline).
  test('--rollback combined with --dest -> exit 2', async () => {
    const r = await run(['dev', '--rollback', '--dest', '/tmp', '--tool', 'codex', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--rollback');
  });

  test('--rollback combined with --strict -> exit 2', async () => {
    const r = await run(['dev', '--rollback', '--strict', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--rollback');
  });

  test('--rollback combined with --no-verify -> exit 2', async () => {
    const r = await run(['dev', '--rollback', '--no-verify', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--rollback');
  });

  test('an unknown --tool value -> exit 2', async () => {
    const r = await run(['dev', 'x', '--tool', 'bogus']);
    expect(r.code).toBe(2);
  });

  test('--help exits 0 and lists the demote alias', async () => {
    const r = await run(['dev', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('demote');
    expect(r.stdout).toContain('EXAMPLES');
    expect(r.stdout).toContain('EXIT CODES');
  });

  test('demote alias resolves to the dev command', async () => {
    const r = await run(['demote', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Flip a skill from production (pinned copy) back to dev mode');
  });
});
