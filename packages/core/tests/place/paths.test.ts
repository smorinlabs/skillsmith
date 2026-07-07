import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../../src/place/paths.ts';

const env = (): ScanEnv => ({
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
  withFileLock: (_p, fn) => fn(),
});

describe('resolveDataDir', () => {
  test('prefers SKILLSMITH_HOME when set', () => {
    expect(resolveDataDir(env(), { SKILLSMITH_HOME: '/custom/data' })).toBe('/custom/data');
  });

  test('falls back to env.xdg.data/skillsmith when unset', () => {
    expect(resolveDataDir(env(), {})).toBe('/h/.local/share/skillsmith');
  });
});

describe('storeRootOf', () => {
  test('joins "store" onto the data dir', () => {
    expect(storeRootOf('/data')).toBe('/data/store');
  });
});

describe('ledgerPathOf', () => {
  test('joins "placements.json" onto the data dir', () => {
    expect(ledgerPathOf('/data')).toBe('/data/placements.json');
  });
});
