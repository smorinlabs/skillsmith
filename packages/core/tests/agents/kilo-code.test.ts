import { describe, expect, test } from 'bun:test';
import { kiloCodeAgent } from '../../src/agents/kilo-code/index.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  runVersion: async () => '1.0.0',
});

describe('kiloCodeAgent', () => {
  test('tool identity + installHint', () => {
    expect(kiloCodeAgent.tool).toBe('kilo-code');
    expect(kiloCodeAgent.installHint).toContain('kilo');
  });

  test('detects the `kilo` binary', async () => {
    const r = await kiloCodeAgent.detect(env(['/opt/homebrew/bin/kilo']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]?.path).toBe('/opt/homebrew/bin/kilo');
      expect(r.value[0]?.version).toBe('1.0.0');
    }
  });
});
