import { describe, expect, test } from 'bun:test';
import { resolveRuntimeConfiguration } from '../../../core/src/config/runtime.ts';
import { runChecks } from '../../../core/src/doctor/run.ts';
import { focusDoctorPorts } from '../../../core/src/doctor/run.ts';
import type { Check, CheckRunContext, CheckRunResult } from '../../../core/src/doctor/types.ts';
import { noopLogger } from '../../../core/src/env/logger.ts';
import type { ScanEnv } from '../../../core/src/env/types.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { runtimePorts } from '../../../core/tests/fixtures/runtime-ports.ts';
import * as checkModule from '../../src/commands/check.ts';
import { renderDoctorJson } from '../../src/output/doctor-json.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

type CheckFlags = { readonly reportOnly: boolean; readonly exitCode: boolean };
type CheckInputs = {
  readonly cli: {
    readonly tools: readonly string[];
    readonly scope?: string;
    readonly allTools: boolean;
    readonly file?: string;
    readonly lockfile?: string;
  };
  readonly effectiveConfig: { readonly tool?: string; readonly scope?: string };
  readonly effectiveCwd: string;
};
type CheckInputResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly tools: readonly string[];
        readonly scopes: readonly string[];
        readonly file?: string;
        readonly lockfile?: string;
      };
    }
  | { readonly ok: false; readonly error: { readonly exitCode: 2; readonly message: string } };

const checkApi = checkModule as typeof checkModule & {
  resolveCheckExitCode(
    report: CheckRunResult,
    flags: CheckFlags,
  ):
    | { readonly ok: true; readonly value: 0 | 1 }
    | {
        readonly ok: false;
        readonly error: { readonly exitCode: 2; readonly message: string };
      };
  resolveCheckInputs(input: CheckInputs): CheckInputResult;
};

const env: ScanEnv = {
  homeDir: '/home/test',
  path: [],
  platform: 'linux',
  xdg: { config: '/config', data: '/data', cache: '/cache' },
  fileExists: async () => false,
  realpath: async (path) => path,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  pathKind: async () => 'absent',
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async () => {},
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  modifiedAt: async () => null,
  withFileLock: (_path, fn) => fn(),
};

const context = (overrides: Partial<CheckRunContext> = {}): CheckRunContext => ({
  env: focusDoctorPorts(runtimePorts(env)),
  mode: 'check',
  tools: ['codex'],
  scopes: ['project'],
  cwd: '/repo',
  configuration: resolveRuntimeConfiguration({}),
  offline: false,
  logger: noopLogger,
  ...overrides,
});

const finding = (severity: 'error' | 'warning' | 'info', checkId: string = severity) => ({
  checkId,
  severity,
  title: `${severity} finding`,
  message: `${severity} detail`,
});

const report = (errors: number): CheckRunResult => ({
  findings: Array.from({ length: errors }, () => finding('error')),
  counts: { ok: 0, warning: 0, error: errors },
});

const runCli = async (args: readonly string[]) => {
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    env: hermeticGitEnv({ CI: '1', NO_COLOR: '1' }),
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

describe('EWP-CMD-CHECK-TS01', () => {
  test('check executes only error-class registry entries', async () => {
    const executed: string[] = [];
    const registry: Check[] = (['error', 'warning', 'info'] as const).map((severity) => ({
      id: severity,
      severity,
      runsIn: ['check'],
      run: async () => {
        executed.push(severity);
        return [finding(severity)];
      },
    }));

    const result = await runChecks(registry, context());
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(executed).toEqual(['error']);
    expect(result.value.findings).toEqual([finding('error')]);
  });
});

describe('EWP-CMD-CHECK-TS02', () => {
  test('default gating, report-only, compatibility, and conflicts share one payload', async () => {
    const payload = report(1);
    const before = structuredClone(payload);
    expect(checkApi.resolveCheckExitCode(payload, { reportOnly: false, exitCode: false })).toEqual({
      ok: true,
      value: 1,
    });
    expect(checkApi.resolveCheckExitCode(payload, { reportOnly: true, exitCode: false })).toEqual({
      ok: true,
      value: 0,
    });
    expect(checkApi.resolveCheckExitCode(payload, { reportOnly: false, exitCode: true })).toEqual({
      ok: true,
      value: 1,
    });
    expect(payload).toEqual(before);

    const conflict = await runCli([
      '-C',
      '/definitely/missing',
      'check',
      '--report-only',
      '--exit-code',
      '--json',
    ]);
    expect(conflict.exitCode).toBe(2);
    expect(conflict.stderr).toBe('');
    expect(JSON.parse(conflict.stdout)).toMatchObject({ exitCode: 2 });
    expect(conflict.stdout).toContain('--report-only');
    expect(conflict.stdout).toContain('--exit-code');
    expect(conflict.stdout).not.toContain('/definitely/missing');
  });

  test('deprecated exit-code emits one actionable human warning and structured JSON data', async () => {
    const human = await runCli(['check', '--tool', 'codex', '--scope', 'user', '--exit-code']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('checks reported');
    expect(human.stderr).toContain('warning: --exit-code is deprecated');
    expect(human.stderr).toContain('default check behavior');
    expect(human.stderr.trim().split('\n')).toHaveLength(1);

    const json = await runCli([
      'check',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--exit-code',
      '--json',
    ]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      deprecations: [
        {
          spelling: '--exit-code',
          replacement: 'default check behavior',
          removalVersion: '2.0',
        },
      ],
    });
  });
});

describe('EWP-CMD-CHECK-TS03', () => {
  test('effective config and explicit artifact selection resolve without widening', () => {
    expect(
      checkApi.resolveCheckInputs({
        cli: { tools: [], allTools: false },
        effectiveConfig: { tool: 'codex', scope: 'project' },
        effectiveCwd: '/repo',
      }),
    ).toEqual({ ok: true, value: { tools: ['codex'], scopes: ['project'] } });

    expect(
      checkApi.resolveCheckInputs({
        cli: {
          tools: ['claude-code'],
          scope: 'system',
          allTools: false,
          file: 'config/skillsmith.toml',
        },
        effectiveConfig: { tool: 'codex', scope: 'project' },
        effectiveCwd: '/repo',
      }),
    ).toEqual({
      ok: true,
      value: {
        tools: ['claude-code'],
        scopes: ['system'],
        file: '/repo/config/skillsmith.toml',
        lockfile: '/repo/config/skillsmith.lock',
      },
    });

    const explicit = checkApi.resolveCheckInputs({
      cli: {
        tools: [],
        allTools: false,
        file: 'custom.toml',
        lockfile: 'locks/custom.lock',
      },
      effectiveConfig: {},
      effectiveCwd: '/repo',
    });
    expect(explicit).toMatchObject({
      ok: true,
      value: { file: '/repo/custom.toml', lockfile: '/repo/locks/custom.lock' },
    });

    for (const invalid of [
      { tools: [], allTools: false, lockfile: 'orphan.lock' },
      { tools: ['codex'], allTools: true },
    ]) {
      expect(
        checkApi.resolveCheckInputs({
          cli: invalid,
          effectiveConfig: {},
          effectiveCwd: '/repo',
        }),
      ).toMatchObject({ ok: false, error: { exitCode: 2 } });
    }
  });

  test('repeated singular artifact selectors fail before project discovery', async () => {
    const cases = [
      ['check', '--file', 'first.toml', '--file', 'second.toml'],
      ['check', '--file', 'state.toml', '--lockfile', 'first.lock', '--lockfile', 'second.lock'],
      ['doctor', '--file', 'first.toml', '--file', 'second.toml'],
      ['doctor', '--file', 'state.toml', '--lockfile', 'first.lock', '--lockfile', 'second.lock'],
    ] as const;

    for (const args of cases) {
      const result = await runCli(['-C', '/definitely/missing', ...args, '--json']);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      const error = JSON.parse(result.stdout) as {
        readonly exitCode: number;
        readonly message: string;
      };
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain('may only be specified once');
      expect(result.stdout).not.toContain('/definitely/missing');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
    }
  });

  test('repeated singular artifact selectors emit one human usage error', async () => {
    const result = await runCli([
      '-C',
      '/definitely/missing',
      'check',
      '--file',
      'first.toml',
      '--file',
      'second.toml',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--file may only be specified once');
    expect(result.stderr).not.toContain('/definitely/missing');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });
});

describe('EWP-CMD-CHECK-TS04', () => {
  test('CI JSON is one value and exit selection is stable at 0, 1, or 2', () => {
    const clean = report(0);
    const failing = report(1);
    for (const value of [clean, failing]) {
      const json = renderDoctorJson(value);
      expect(() => JSON.parse(json)).not.toThrow();
      expect(JSON.parse(json)).toMatchObject({ counts: value.counts });
    }
    expect(checkApi.resolveCheckExitCode(clean, { reportOnly: false, exitCode: false })).toEqual({
      ok: true,
      value: 0,
    });
    expect(checkApi.resolveCheckExitCode(failing, { reportOnly: false, exitCode: false })).toEqual({
      ok: true,
      value: 1,
    });
    expect(
      checkApi.resolveCheckExitCode(failing, { reportOnly: true, exitCode: true }),
    ).toMatchObject({ ok: false, error: { exitCode: 2 } });
  });
});

describe('EWP-CMD-CHECK-TS05', () => {
  test('check never executes network or advisory entries', async () => {
    let networkCalls = 0;
    const noisy: Check[] = [
      {
        id: 'network-reach',
        severity: 'warning',
        runsIn: ['check'],
        run: async () => {
          networkCalls++;
          return [finding('warning', 'network-reach')];
        },
      },
      {
        id: 'advisory-update',
        severity: 'info',
        runsIn: ['check'],
        run: async () => [finding('info', 'advisory-update')],
      },
    ];
    const result = await runChecks(noisy, context());
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(networkCalls).toBe(0);
    expect(result.value.findings).toEqual([]);
  });
});
