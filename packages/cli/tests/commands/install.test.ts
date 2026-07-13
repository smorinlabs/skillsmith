import { describe, expect, test } from 'bun:test';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { buildInstallDeps, shouldEnablePicker } from '../../src/commands/install.ts';
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

describe('skillsmith install — flag validation', () => {
  test('no <source> -> exit 2 (commander missingArgument)', async () => {
    const r = await run(['install']);
    expect(r.code).toBe(2);
  });

  test('--user and --project together -> exit 2', async () => {
    const r = await run(['install', 'acme/repo', '--user', '--project']);
    expect(r.code).toBe(2);
  });

  test('--scope=user conflicting with --project -> exit 2', async () => {
    const r = await run(['install', 'acme/repo', '--scope', 'user', '--project']);
    expect(r.code).toBe(2);
  });

  test('--deep with --no-verify -> exit 2, message names both flags', async () => {
    const r = await run(['install', 'acme/repo', '--deep', '--no-verify']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--deep');
    expect(r.stderr).toContain('--no-verify');
  });

  test('--scope system -> exit 4 (known but unsupported capability)', async () => {
    const r = await run(['install', 'acme/repo', '--scope', 'system']);
    expect(r.code).toBe(4);
  });

  test('an unknown --tool value -> exit 2', async () => {
    const r = await run(['install', 'acme/repo', '--tool', 'bogus']);
    expect(r.code).toBe(2);
  });

  test('--help exits 0 and includes ALIASES/EXAMPLES/EXIT CODES sections', async () => {
    const r = await run(['install', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ALIASES');
    expect(r.stdout).toContain('EXAMPLES');
    expect(r.stdout).toContain('EXIT CODES');
  });

  test('`i` alias resolves to the install command', async () => {
    const r = await run(['i', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Install agent skills from a git host.');
  });
});

describe('install picker gating (D4)', () => {
  test('enabled only when stderr+stdin are TTYs and neither --json nor --no-prompt is set', () => {
    expect(
      shouldEnablePicker({ json: false, noPrompt: false }, { stderr: true, stdin: true }),
    ).toBe(true);
  });

  test('--json disables the picker even under a TTY', () => {
    expect(shouldEnablePicker({ json: true, noPrompt: false }, { stderr: true, stdin: true })).toBe(
      false,
    );
  });

  test('--no-prompt disables the picker even under a TTY', () => {
    expect(shouldEnablePicker({ json: false, noPrompt: true }, { stderr: true, stdin: true })).toBe(
      false,
    );
  });

  test('a non-TTY stderr disables the picker', () => {
    expect(
      shouldEnablePicker({ json: false, noPrompt: false }, { stderr: false, stdin: true }),
    ).toBe(false);
  });

  test('a non-TTY stdin disables the picker', () => {
    expect(
      shouldEnablePicker({ json: false, noPrompt: false }, { stderr: true, stdin: false }),
    ).toBe(false);
  });

  test('buildInstallDeps omits `pick` when gating is false (spy on the deps builder)', () => {
    const deps = buildInstallDeps({ json: true, noPrompt: false }, { stderr: true, stdin: true });
    expect(deps.pick).toBeUndefined();
  });

  test('buildInstallDeps installs a `pick` function when every gate passes', () => {
    const deps = buildInstallDeps({ json: false, noPrompt: false }, { stderr: true, stdin: true });
    expect(typeof deps.pick).toBe('function');
  });

  test('buildInstallDeps carries domain defaults while clock and ID stay port-owned', () => {
    const deps = buildInstallDeps({ json: true, noPrompt: false }, { stderr: true, stdin: true });
    expect(typeof deps.verify).toBe('function');
    expect(typeof deps.detect).toBe('function');
    expect(deps.now).toBeUndefined();
    expect(deps.newTxId).toBeUndefined();
  });

  // `--yes` is not part of the gating signature at all — it structurally cannot auto-pick,
  // it only ever no-ops (the picker is a choice, not a confirmation, per D16/D4).
  test('picker gating has no `yes` input — a TTY + no --json/--no-prompt still requires a real choice', () => {
    expect(
      shouldEnablePicker({ json: false, noPrompt: false }, { stderr: true, stdin: true }),
    ).toBe(true);
    const deps = buildInstallDeps({ json: false, noPrompt: false }, { stderr: true, stdin: true });
    // `pick` is wired (a prompt WILL be shown); nothing here can auto-resolve it — that would
    // require `deps.pick` to be absent, which it is not.
    expect(typeof deps.pick).toBe('function');
  });
});
