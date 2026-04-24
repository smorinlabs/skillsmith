import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { detectAll, detectTool } from '../../src/scan/index.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  runVersion: async () => '9.9.9',
});

describe('detectAll', () => {
  test('returns a map with an entry for each supported tool', async () => {
    const r = await detectAll(env([]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.size).toBe(4);
      for (const t of ['claude-code', 'codex', 'kilo-code', 'opencode'] as const) {
        expect(r.value.has(t)).toBe(true);
        expect(r.value.get(t)).toEqual([]);
      }
    }
  });

  test('honors the tools filter', async () => {
    const r = await detectAll(env([]), { tools: ['codex', 'opencode'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.value.keys()].sort()).toEqual(['codex', 'opencode']);
    }
  });

  test('aggregates detected records per tool', async () => {
    const r = await detectAll(env(['/opt/homebrew/bin/claude', '/usr/local/bin/codex']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.get('claude-code')).toHaveLength(1);
      expect(r.value.get('codex')).toHaveLength(1);
      expect(r.value.get('kilo-code')).toEqual([]);
    }
  });

  test('returns err for an unknown tool in the filter', async () => {
    const r = await detectAll(env([]), { tools: ['not-a-tool' as never] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown-tool');
  });
});

describe('detectTool', () => {
  test('returns the agent record list for a known tool', async () => {
    const r = await detectTool(env(['/opt/homebrew/bin/opencode']), 'opencode');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.path).toBe('/opt/homebrew/bin/opencode');
    }
  });
  test('returns err for unknown tool', async () => {
    const r = await detectTool(env([]), 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown-tool');
  });
});

describe('signal propagation', () => {
  // Tracking env that records which signal (if any) was passed to runVersion.
  const spyEnv = (
    existing: string[],
  ): { env: ScanEnv; lastSignal: { value: AbortSignal | undefined } } => {
    const lastSignal: { value: AbortSignal | undefined } = { value: undefined };
    const e: ScanEnv = {
      homeDir: '/Users/u',
      path: ['/usr/bin'],
      platform: 'darwin',
      xdg: { config: '/c', data: '/d', cache: '/k' },
      fileExists: async (p) => existing.includes(p),
      realpath: async (p) => p,
      runVersion: async (_p, _a, signal) => {
        lastSignal.value = signal;
        return '1.0.0';
      },
    };
    return { env: e, lastSignal };
  };

  test('detectAll forwards opts.signal down to each agent runVersion', async () => {
    const { env: spy, lastSignal } = spyEnv([
      '/opt/homebrew/bin/claude',
      '/opt/homebrew/bin/codex',
    ]);
    const controller = new AbortController();
    const r = await detectAll(spy, { signal: controller.signal });
    expect(r.ok).toBe(true);
    expect(lastSignal.value).toBe(controller.signal);
  });

  test('detectTool forwards signal down to the agent runVersion', async () => {
    const { env: spy, lastSignal } = spyEnv(['/opt/homebrew/bin/kilo']);
    const controller = new AbortController();
    const r = await detectTool(spy, 'kilo-code', controller.signal);
    expect(r.ok).toBe(true);
    expect(lastSignal.value).toBe(controller.signal);
  });
});
