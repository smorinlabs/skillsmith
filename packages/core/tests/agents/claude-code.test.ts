import { describe, expect, test } from 'bun:test';
import { claudeCodeAgent } from '../../src/agents/claude-code/index.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  runVersion: async () => '1.2.3',
});

describe('claudeCodeAgent', () => {
  test('tool identity + installHint', () => {
    expect(claudeCodeAgent.tool).toBe('claude-code');
    expect(claudeCodeAgent.installHint).toContain('claude');
  });

  test('returns empty list when not detected', async () => {
    const r = await claudeCodeAgent.detect(env([]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('returns InstallRecord[] when claude binary is present', async () => {
    const r = await claudeCodeAgent.detect(env(['/opt/homebrew/bin/claude']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]).toEqual({
        path: '/opt/homebrew/bin/claude',
        version: '1.2.3',
        installMethod: 'brew',
      });
    }
  });
});
