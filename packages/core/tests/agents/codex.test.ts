import { describe, expect, test } from 'bun:test';
import { codexAgent } from '../../src/agents/codex/index.ts';
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
  runVersion: async () => '0.5.1',
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

describe('codexAgent', () => {
  test('tool identity + installHint', () => {
    expect(codexAgent.tool).toBe('codex');
    expect(codexAgent.installHint).toContain('codex');
  });

  test('returns InstallRecord[] when codex binary is present', async () => {
    const r = await codexAgent.detect(env(['/opt/homebrew/bin/codex']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]).toEqual({
        path: '/opt/homebrew/bin/codex',
        version: '0.5.1',
        installMethod: 'brew',
      });
    }
  });
});
