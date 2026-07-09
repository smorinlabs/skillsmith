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
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => '1.2.3',
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
