import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DoctorReport {
  readonly schemaVersion: 1;
  readonly findings: readonly { readonly checkId: string; readonly severity: string }[];
  readonly counts: { readonly warning: number; readonly error: number };
}

const runCli = async (
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<CliResult> => {
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv({ ...env, CI: '1', NO_COLOR: '1' }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

const parseSingleJson = <T>(result: CliResult): T => {
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).not.toBe('');
  return JSON.parse(result.stdout) as T;
};

const fixtureEnv = (sandbox: string): Record<string, string | undefined> => ({
  HOME: join(sandbox, 'home'),
  XDG_CONFIG_HOME: join(sandbox, 'xdg', 'config'),
  XDG_DATA_HOME: join(sandbox, 'xdg', 'data'),
  XDG_CACHE_HOME: join(sandbox, 'xdg', 'cache'),
  CODEX_HOME: join(sandbox, 'codex-home'),
  SKILLSMITH_CONFIG: undefined,
  SKILLSMITH_TOOL: undefined,
  SKILLSMITH_SCOPE: undefined,
});

describe('EWP-P1-TS04', () => {
  test('check gates errors by default while report-only preserves the exact report', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-check-'));
    const clean = join(sandbox, 'clean');
    const malformed = join(sandbox, 'malformed');
    const env = fixtureEnv(sandbox);
    await Promise.all([
      mkdir(clean, { recursive: true }),
      mkdir(malformed, { recursive: true }),
      mkdir(env.HOME as string, { recursive: true }),
      mkdir(env.XDG_CONFIG_HOME as string, { recursive: true }),
      mkdir(env.XDG_DATA_HOME as string, { recursive: true }),
      mkdir(env.XDG_CACHE_HOME as string, { recursive: true }),
    ]);
    await writeFile(join(malformed, 'skillsmith.toml'), 'tool = [not valid toml\n');

    try {
      const cleanResult = await runCli(
        ['check', '--tool', 'codex', '--scope', 'user', '--json'],
        clean,
        env,
      );
      expect(cleanResult.exitCode).toBe(0);
      expect(parseSingleJson<DoctorReport>(cleanResult).counts.error).toBe(0);

      const gating = await runCli(
        ['check', '--tool', 'codex', '--scope', 'user', '--json'],
        malformed,
        env,
      );
      expect(gating.exitCode).toBe(1);
      const gatingReport = parseSingleJson<DoctorReport>(gating);
      expect(gatingReport.counts.error).toBeGreaterThan(0);
      expect(gatingReport.findings).toContainEqual(
        expect.objectContaining({ checkId: 'config-parse', severity: 'error' }),
      );

      const reportOnly = await runCli(
        ['check', '--tool', 'codex', '--scope', 'user', '--report-only', '--json'],
        malformed,
        env,
      );
      expect(reportOnly.exitCode).toBe(0);
      expect(parseSingleJson<DoctorReport>(reportOnly)).toEqual(gatingReport);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('check rejects report-only with the deprecated exit-code compatibility flag', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-check-conflict-'));
    const env = fixtureEnv(sandbox);
    await Promise.all([
      mkdir(env.HOME as string, { recursive: true }),
      mkdir(env.XDG_CONFIG_HOME as string, { recursive: true }),
      mkdir(env.XDG_DATA_HOME as string, { recursive: true }),
      mkdir(env.XDG_CACHE_HOME as string, { recursive: true }),
    ]);

    try {
      const result = await runCli(
        ['check', '--report-only', '--exit-code', '--json'],
        sandbox,
        env,
      );
      expect(result.exitCode).toBe(2);
      const error = parseSingleJson<{ message: string; exitCode: number }>(result);
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain('--report-only');
      expect(error.message).toContain('--exit-code');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('doctor warnings are advisory unless strict, while errors always fail', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-doctor-'));
    const warningRoot = join(sandbox, 'warning');
    const errorRoot = join(sandbox, 'error');
    const env = fixtureEnv(sandbox);
    const legacySkill = join(env.CODEX_HOME as string, 'skills', 'legacy');
    await Promise.all([
      mkdir(warningRoot, { recursive: true }),
      mkdir(errorRoot, { recursive: true }),
      mkdir(env.HOME as string, { recursive: true }),
      mkdir(env.XDG_CONFIG_HOME as string, { recursive: true }),
      mkdir(env.XDG_DATA_HOME as string, { recursive: true }),
      mkdir(env.XDG_CACHE_HOME as string, { recursive: true }),
      mkdir(legacySkill, { recursive: true }),
    ]);
    await writeFile(join(legacySkill, 'SKILL.md'), 'legacy fixture\n');
    await writeFile(join(errorRoot, 'skillsmith.toml'), 'tool = [not valid toml\n');
    const baseArgs = ['doctor', '--tool', 'codex', '--scope', 'user', '--offline'] as const;

    try {
      const advisory = await runCli([...baseArgs, '--json'], warningRoot, env);
      expect(advisory.exitCode).toBe(0);
      const advisoryReport = parseSingleJson<DoctorReport>(advisory);
      expect(advisoryReport.counts.warning).toBeGreaterThan(0);
      expect(advisoryReport.counts.error).toBe(0);

      const strict = await runCli([...baseArgs, '--strict', '--json'], warningRoot, env);
      expect(strict.exitCode).toBe(1);
      expect(parseSingleJson<DoctorReport>(strict)).toEqual(advisoryReport);

      const error = await runCli([...baseArgs, '--json'], errorRoot, env);
      expect(error.exitCode).toBe(1);
      const errorReport = parseSingleJson<DoctorReport>(error);
      expect(errorReport.counts.error).toBeGreaterThan(0);
      expect(errorReport.findings).toContainEqual(
        expect.objectContaining({ checkId: 'config-parse', severity: 'error' }),
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
