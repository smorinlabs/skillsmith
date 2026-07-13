import { describe, expect, test } from 'bun:test';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import { configParse } from '../../src/doctor/checks/config-parse.ts';
import { focusDoctorPorts, runChecks } from '../../src/doctor/run.ts';
import type { Check, CheckRunContext, DoctorPorts } from '../../src/doctor/types.ts';
import { noopLogger } from '../../src/env/logger.ts';
import type { ScanEnv } from '../../src/env/types.ts';
import { runtimePorts } from '../fixtures/runtime-ports.ts';

const env: ScanEnv = {
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async () => false,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  pathKind: async () => 'absent' as const,
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
  withFileLock: (_p, fn) => fn(),
};

const ctx: CheckRunContext = {
  env: focusDoctorPorts(runtimePorts(env)),
  mode: 'doctor',
  tools: [],
  scopes: [],
  cwd: '/p',
  configuration: resolveRuntimeConfiguration({}),
  offline: false,
  logger: noopLogger,
};

const mkCheck = (
  id: string,
  severity: 'error' | 'warning',
  runsIn: ('doctor' | 'check')[],
  findings: number,
): Check => ({
  id,
  severity,
  runsIn,
  run: async () =>
    Array.from({ length: findings }, (_, i) => ({
      checkId: id,
      severity,
      title: `${id}-${i}`,
      message: '',
    })),
});

const assertNoProcessAuthority = (ports: DoctorPorts): void => {
  // @ts-expect-error health checks cannot execute arbitrary processes
  void ports.exec;
  // @ts-expect-error health checks cannot run subprocess-backed version probes
  void ports.runVersion;
};

describe('runChecks', () => {
  test('projects runtime authority without arbitrary process or mutation capabilities', () => {
    const focused = focusDoctorPorts(runtimePorts(env));
    assertNoProcessAuthority(focused);

    expect(focused.http.request).toBeFunction();
    expect(focused.assertWritableDirectory).toBeFunction();
    expect(focused).not.toHaveProperty('exec');
    expect(focused).not.toHaveProperty('runVersion');
    expect(focused).not.toHaveProperty('writeTextFile');
    expect(focused).not.toHaveProperty('withFileLock');
    expect(focused).not.toHaveProperty('git');
  });

  test('filters registry by mode', async () => {
    const registry: Check[] = [
      mkCheck('a', 'warning', ['doctor'], 1),
      mkCheck('b', 'error', ['doctor', 'check'], 1),
    ];
    const r = await runChecks(registry, { ...ctx, mode: 'check' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.findings.map((f) => f.checkId)).toEqual(['b']);
    }
  });

  test('check mode executes only checks declared as error severity', async () => {
    let warningRuns = 0;
    const warning: Check = {
      id: 'advisory',
      severity: 'warning',
      runsIn: ['doctor', 'check'],
      run: async () => {
        warningRuns += 1;
        return [
          {
            checkId: 'advisory',
            severity: 'warning',
            title: 'advisory finding',
            message: '',
          },
        ];
      },
    };
    const error = mkCheck('blocking', 'error', ['check'], 1);

    const result = await runChecks([warning, error], { ...ctx, mode: 'check' });

    expect(result.ok).toBe(true);
    expect(warningRuns).toBe(0);
    if (result.ok) {
      expect(result.value.findings.map((finding) => finding.checkId)).toEqual(['blocking']);
      expect(result.value.counts).toEqual({ ok: 0, warning: 0, error: 1 });
    }
  });

  test('doctor mode retains advisory checks', async () => {
    const result = await runChecks([mkCheck('advisory', 'warning', ['doctor', 'check'], 1)], ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findings.map((finding) => finding.checkId)).toEqual(['advisory']);
      expect(result.value.counts).toEqual({ ok: 0, warning: 1, error: 0 });
    }
  });

  test('check mode tallies actual findings from error-class checks', async () => {
    const declaredError: Check = {
      id: 'blocking-family',
      severity: 'error',
      runsIn: ['check'],
      run: async () => [
        { checkId: 'blocking-family', severity: 'info', title: 'healthy', message: '' },
        { checkId: 'blocking-family', severity: 'warning', title: 'warning', message: '' },
        { checkId: 'blocking-family', severity: 'error', title: 'failure', message: '' },
      ],
    };

    const result = await runChecks([declaredError], { ...ctx, mode: 'check' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counts).toEqual({ ok: 1, warning: 1, error: 1 });
    }
  });

  test('aggregates counts by severity', async () => {
    const registry: Check[] = [
      mkCheck('x', 'error', ['doctor'], 2),
      mkCheck('y', 'warning', ['doctor'], 3),
    ];
    const r = await runChecks(registry, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.counts).toEqual({ ok: 0, warning: 3, error: 2 });
    }
  });

  test('check that throws becomes an error finding', async () => {
    const bad: Check = {
      id: 'bad',
      severity: 'error',
      runsIn: ['doctor'],
      run: async () => {
        throw new Error('boom');
      },
    };
    const r = await runChecks([bad], ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.findings[0]?.title).toMatch(/bad/);
      expect(r.value.findings[0]?.severity).toBe('error');
    }
  });
});

describe('config-parse artifact selection', () => {
  test('an explicit selected file is diagnosed without reading or writing its sibling lock', async () => {
    const file = '/p/custom/team.toml';
    const selectedEnv: ScanEnv = {
      ...env,
      fileExists: async (path) => path === file,
      readText: async (path) => {
        if (path !== file) throw new Error(`unexpected read: ${path}`);
        return 'tool = [invalid toml\n';
      },
    };

    const findings = await configParse.run({
      ...ctx,
      env: focusDoctorPorts(runtimePorts(selectedEnv)),
      artifactPair: { file, lockfile: '/p/custom/team.lock' },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: 'config-parse',
      severity: 'error',
    });
    expect(findings[0]?.remediation).toContain(file);
  });
});
