import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { VerifyJsonSchema } from '../../src/output/verify-json.ts';

// Env-gated live e2e against the real `claude` / `codex` CLIs, driven through the
// actual CLI process (not the library entry point) so exit codes and stdout framing
// are covered end to end. CI never sets SKILLSMITH_E2E and its runners don't have the
// tool CLIs installed, so this suite reports as skipped and `bun run check` stays
// green. Run locally with both CLIs installed:
// `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/verify-live.test.ts`
const E2E = process.env.SKILLSMITH_E2E === '1';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const DUMMYTEST = join(REPO_ROOT, 'packages', 'core', 'tests', 'fixtures', 'verify', 'dummytest');

const run = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = Bun.spawn(['bun', 'packages/cli/src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: hermeticGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

/** Fails with the full process transcript, not just a bare exit-code mismatch. */
const requireExit = (
  r: { stdout: string; stderr: string; code: number },
  expected: number,
  label: string,
): void => {
  if (r.code !== expected) {
    throw new Error(
      `${label}: expected exit ${expected}, got ${r.code}\n` +
        `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
};

describe.skipIf(!E2E)('skillsmith verify live e2e (real claude/codex CLIs)', () => {
  test('verify <dummytest> --deep --json: exit 1, valid VerifyJsonSchema, non-empty summary.failed', async () => {
    const r = await run(['verify', DUMMYTEST, '--deep', '--json']);
    requireExit(r, 1, 'verify --deep --json dummytest');

    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      throw new Error(`stdout was not valid JSON (${e})\n--- stdout ---\n${r.stdout}`);
    }
    const report = VerifyJsonSchema.parse(parsed);
    expect(report.schemaVersion).toBe(1);
    expect(report.summary.failed.length).toBeGreaterThan(0);
  }, 120_000);

  test('verify <empty-dir>: exit 2 (not a plugin or skill directory)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'skillsmith-verify-live-empty-'));
    try {
      const r = await run(['verify', empty]);
      requireExit(r, 2, 'verify empty-dir');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  }, 120_000);

  test('verify <dummytest> --tool claude-code --tool codex --json: exit 1, tools array length 2', async () => {
    const r = await run([
      'verify',
      DUMMYTEST,
      '--tool',
      'claude-code',
      '--tool',
      'codex',
      '--json',
    ]);
    requireExit(r, 1, 'verify --tool claude-code --tool codex');

    const parsed: unknown = JSON.parse(r.stdout);
    const report = VerifyJsonSchema.parse(parsed);
    expect(report.tools).toHaveLength(2);
  }, 120_000);
});
