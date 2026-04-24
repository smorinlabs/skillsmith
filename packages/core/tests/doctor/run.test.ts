import { describe, expect, test } from 'bun:test';
import { runChecks } from '../../src/doctor/run.ts';
import type { Check, CheckRunContext } from '../../src/doctor/types.ts';
import { noopLogger } from '../../src/env/logger.ts';
import type { ScanEnv } from '../../src/env/types.ts';

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
};

const ctx: CheckRunContext = {
  env,
  mode: 'doctor',
  tools: [],
  scopes: [],
  cwd: '/p',
  envVars: {},
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

describe('runChecks', () => {
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
