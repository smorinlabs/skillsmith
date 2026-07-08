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
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => '1.0.0',
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
