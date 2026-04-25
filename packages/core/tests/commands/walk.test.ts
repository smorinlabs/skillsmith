import { describe, expect, test } from 'bun:test';
import { walkCommandDir } from '../../src/commands/walk.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const fakeEnv = (
  dirs: Record<string, readonly string[]>,
  files: Record<string, string>,
): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in dirs || p in files,
  realpath: async (p) => p,
  listDir: async (p) => dirs[p] ?? [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
});

describe('walkCommandDir', () => {
  test('returns [] for missing root', async () => {
    const r = await walkCommandDir(fakeEnv({}, {}), {
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/commands',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r).toEqual([]);
  });

  test('returns one entry per .md file', async () => {
    const env = fakeEnv(
      { '/r': ['ci-audit.md', 'foo.md', 'README.txt'] },
      {
        '/r/ci-audit.md': '---\ndescription: audit CI\n---\nbody',
        '/r/foo.md': '---\n---\n',
      },
    );
    const r = await walkCommandDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/r',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r.map((e) => e.name).sort()).toEqual(['ci-audit', 'foo']);
  });

  test('skips non-.md files and dotfiles', async () => {
    const env = fakeEnv(
      { '/r': ['.hidden.md', 'good.md', 'image.png'] },
      { '/r/good.md': '---\n---\n' },
    );
    const r = await walkCommandDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/r',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r.map((e) => e.name)).toEqual(['good']);
  });
});
