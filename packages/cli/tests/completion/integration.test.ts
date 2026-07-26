import { describe, expect, test } from 'bun:test';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';
const run = async (args: string[]) => {
  const proc = Bun.spawn(['bun', 'run', CLI_ENTRYPOINT, ...args], {
    env: hermeticGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    code,
  };
};

describe('skillsmith completion', () => {
  test('bash: exit 0, contains hardened dynamic callback', async () => {
    const r = await run(['completion', 'bash']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/_skillsmith/);
    expect(r.stdout).toContain('skillsmith complete --');
    expect(r.stdout).not.toMatch(/\beval\b/);
  });

  test('zsh: exit 0, has #compdef header', async () => {
    const r = await run(['completion', 'zsh']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^#compdef skillsmith/m);
  });

  test('fish: exit 0, has complete -c skillsmith lines', async () => {
    const r = await run(['completion', 'fish']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/complete -c skillsmith/);
  });

  test('unknown shell: exit 2', async () => {
    const r = await run(['completion', 'pwsh']);
    expect(r.code).toBe(2);
  });
});
