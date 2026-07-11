import { describe, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import pkg from '../../core/package.json' with { type: 'json' };
import { hermeticGitEnv } from '../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from './fixtures/cli.ts';

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

describe('skillsmith help routing', () => {
  test('CLI entrypoint is independent of the test process cwd', async () => {
    expect(isAbsolute(CLI_ENTRYPOINT)).toBe(true);
    expect(await Bun.file(CLI_ENTRYPOINT).exists()).toBe(true);
  });

  test('`skillsmith` (no args) prints top-level help, exit 0', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('skillsmith');
    expect(r.stdout.toLowerCase()).toContain('usage');
  });

  test('`skillsmith --version` prints a version, exit 0', async () => {
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(pkg.version);
  });

  test('`skillsmith help exit-codes` prints topic page, exit 0', async () => {
    const r = await run(['help', 'exit-codes']);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('exit');
  });

  test('`skillsmith help bogus-topic` exits 2', async () => {
    const r = await run(['help', 'bogus-topic']);
    expect(r.code).toBe(2);
  });

  test('`skillsmith agents --format json` returns valid JSON, exit 0', async () => {
    const r = await run(['agents', '--format', 'json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.tools).toBe('object');
  });
});
