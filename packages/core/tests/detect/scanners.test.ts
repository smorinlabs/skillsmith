import { describe, expect, test } from 'bun:test';
import { classifyInstallMethod, findOnPath, wellKnownBinDirs } from '../../src/detect/scanners.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const fakeEnv = (opts: {
  home?: string;
  path?: string[];
  platform?: 'darwin' | 'linux' | 'win32';
  existing?: Set<string>;
}): ScanEnv => ({
  homeDir: opts.home ?? '/home/user',
  path: opts.path ?? [],
  platform: opts.platform ?? 'linux',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => (opts.existing ?? new Set<string>()).has(p),
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
});

describe('classifyInstallMethod', () => {
  test("classifies /opt/homebrew/bin as 'brew'", () => {
    expect(classifyInstallMethod('/opt/homebrew/bin/claude')).toBe('brew');
  });
  test("classifies /usr/local/bin as 'brew' on mac paths", () => {
    expect(classifyInstallMethod('/usr/local/bin/codex')).toBe('brew');
  });
  test('classifies npm-global paths', () => {
    expect(classifyInstallMethod('/home/user/.npm/bin/claude')).toBe('npm-global');
  });
  test('classifies bun-global paths', () => {
    expect(classifyInstallMethod('/home/user/.bun/install/global/node_modules/.bin/codex')).toBe(
      'bun-global',
    );
  });
  test('classifies .app bundle paths', () => {
    expect(classifyInstallMethod('/Applications/Foo.app/Contents/MacOS/bin/claude')).toBe(
      'app-bundle',
    );
  });
  test("falls back to 'unknown' otherwise", () => {
    expect(classifyInstallMethod('/some/random/place/bin/claude')).toBe('unknown');
  });
});

describe('wellKnownBinDirs', () => {
  test('includes brew dirs + $PATH entries + npm-global + bun global on darwin', () => {
    const env = fakeEnv({
      platform: 'darwin',
      path: ['/usr/bin', '/opt/homebrew/bin'],
      home: '/Users/u',
    });
    const dirs = wellKnownBinDirs(env);
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain('/usr/bin');
    expect(dirs).toContain('/Users/u/.npm/bin');
    expect(dirs).toContain('/Users/u/.bun/install/global/node_modules/.bin');
    expect(dirs).toContain('/Users/u/.local/bin');
  });
});

describe('findOnPath', () => {
  test('returns empty when binary is not in any well-known dir', async () => {
    const env = fakeEnv({ platform: 'linux', path: ['/usr/bin'], home: '/home/u' });
    const hits = await findOnPath(env, 'claude');
    expect(hits).toEqual([]);
  });

  test('returns candidate paths where the binary exists, de-duped by realpath', async () => {
    const env = fakeEnv({
      platform: 'linux',
      path: ['/usr/bin'],
      home: '/home/u',
      existing: new Set(['/usr/bin/claude', '/home/u/.local/bin/claude']),
    });
    const hits = await findOnPath(env, 'claude');
    expect(hits.sort()).toEqual(['/home/u/.local/bin/claude', '/usr/bin/claude']);
  });
});
