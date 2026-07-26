import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

const run = async (
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = Bun.spawn(['bun', 'run', CLI_ENTRYPOINT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: hermeticGitEnv(env),
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

describe('skillsmith uninstall — flag validation', () => {
  test('no <skill> -> exit 2 (commander missingArgument)', async () => {
    const r = await run(['uninstall']);
    expect(r.code).toBe(2);
  });

  test('--user and --project together -> exit 2', async () => {
    const r = await run(['uninstall', 'x', '--user', '--project']);
    expect(r.code).toBe(2);
  });

  test('--all-scopes combined with --scope -> exit 2', async () => {
    const r = await run(['uninstall', 'x', '--all-scopes', '--scope', 'user']);
    expect(r.code).toBe(2);
  });

  test('--scope system -> exit 4 (known but unsupported capability)', async () => {
    const r = await run(['uninstall', 'x', '--scope', 'system']);
    expect(r.code).toBe(4);
  });

  test('an unknown --tool value -> exit 2', async () => {
    const r = await run(['uninstall', 'x', '--tool', 'bogus']);
    expect(r.code).toBe(2);
  });

  test('--help exits 0 and includes ALIASES/COMMON WORKFLOWS/EXIT CODES sections', async () => {
    const r = await run(['uninstall', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ALIASES');
    expect(r.stdout).toContain('rm');
    expect(r.stdout).toContain('remove');
    expect(r.stdout).toContain('COMMON WORKFLOWS');
    expect(r.stdout).toContain('EXIT CODES');
  });

  test('`rm` alias resolves to the uninstall command', async () => {
    const r = await run(['rm', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Remove installed skills');
  });

  test('`remove` alias resolves to the uninstall command', async () => {
    const r = await run(['remove', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Remove installed skills');
  });
});

describe('skillsmith uninstall — smoke (scratch $SKILLSMITH_HOME)', () => {
  test('uninstalling an absent skill with --json -> exit 0, action noop', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'skillsmith-uninstall-test-'));
    try {
      const r = await run(['uninstall', 'nope-not-a-real-skill', '--json'], {
        SKILLSMITH_HOME: scratch,
        HOME: scratch,
      });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.kind).toBe('skillsmith.uninstall');
      expect(parsed.results[0].action).toBe('noop');
      expect(parsed.summary.noop).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
