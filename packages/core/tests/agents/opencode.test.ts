import { describe, expect, test } from 'bun:test';
import { opencodeAgent } from '../../src/agents/opencode/index.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => '1.0.190',
});

describe('opencodeAgent', () => {
  test('tool identity + installHint', () => {
    expect(opencodeAgent.tool).toBe('opencode');
    expect(opencodeAgent.installHint).toContain('opencode');
  });

  test('detects the `opencode` binary', async () => {
    const r = await opencodeAgent.detect(env(['/opt/homebrew/bin/opencode']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]?.path).toBe('/opt/homebrew/bin/opencode');
      expect(r.value[0]?.version).toBe('1.0.190');
    }
  });
});
