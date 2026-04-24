import { describe, expect, test } from 'bun:test';
import { findProjectConfig, getConfigPath, resolveExplicitFile } from '../../src/config/paths.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const env = (overrides: Partial<ScanEnv> = {}): ScanEnv => ({
  homeDir: '/home/u',
  path: [],
  platform: 'linux',
  xdg: { config: '/home/u/.config', data: '/home/u/.local/share', cache: '/home/u/.cache' },
  fileExists: async () => false,
  realpath: async (p) => p,
  runVersion: async () => 'unknown',
  ...overrides,
});

describe('getConfigPath', () => {
  test('user scope uses XDG config dir', () => {
    expect(getConfigPath(env(), 'user')).toBe('/home/u/.config/skillsmith/config.toml');
  });
  test('system scope uses /etc', () => {
    expect(getConfigPath(env(), 'system')).toBe('/etc/skillsmith/config.toml');
  });
  test('project scope uses given cwd', () => {
    expect(getConfigPath(env(), 'project', '/tmp/proj')).toBe('/tmp/proj/skillsmith.toml');
  });
});

describe('findProjectConfig', () => {
  test('returns null when no skillsmith.toml is found', async () => {
    const r = await findProjectConfig(env(), '/a/b/c');
    expect(r).toBeNull();
  });
  test('returns the nearest skillsmith.toml walking up', async () => {
    const existing = new Set(['/a/skillsmith.toml']);
    const e = env({ fileExists: async (p) => existing.has(p) });
    const r = await findProjectConfig(e, '/a/b/c');
    expect(r).toBe('/a/skillsmith.toml');
  });
  test('stops walk at .git boundary', async () => {
    const existing = new Set(['/top/skillsmith.toml', '/top/sub/.git']);
    const e = env({ fileExists: async (p) => existing.has(p) });
    const r = await findProjectConfig(e, '/top/sub/nested');
    expect(r).toBeNull();
  });
});

describe('resolveExplicitFile', () => {
  test('prefers flag over env', () => {
    expect(resolveExplicitFile({ flag: '/f', env: '/e' })).toBe('/f');
  });
  test('falls back to env when no flag', () => {
    expect(resolveExplicitFile({ flag: undefined, env: '/e' })).toBe('/e');
  });
  test('returns null when neither is set', () => {
    expect(resolveExplicitFile({ flag: undefined, env: undefined })).toBeNull();
  });
});
