import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { readInstalledPlugins } from '../../src/plugins/installed.ts';

const env = (files: Record<string, string>): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in files,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
});

describe('readInstalledPlugins', () => {
  test('returns [] when installed_plugins.json does not exist', async () => {
    const r = await readInstalledPlugins(env({}));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('parses a v2 installed_plugins.json', async () => {
    const text = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [
          {
            scope: 'user',
            installPath: '/h/.claude/plugins/cache/bar/foo/1.0.0',
            version: '1.0.0',
          },
        ],
      },
    });
    const r = await readInstalledPlugins(
      env({ '/h/.claude/plugins/installed_plugins.json': text }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.id).toBe('foo@bar');
      expect(r.value[0]?.scope).toBe('user');
      expect(r.value[0]?.version).toBe('1.0.0');
    }
  });

  test('returns multiple entries when a plugin has multiple scopes', async () => {
    const text = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [
          { scope: 'user', installPath: '/a', version: '1.0.0' },
          { scope: 'project', projectPath: '/p', installPath: '/b', version: '2.0.0' },
        ],
      },
    });
    const r = await readInstalledPlugins(
      env({ '/h/.claude/plugins/installed_plugins.json': text }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(2);
  });

  test('returns config-error for malformed JSON', async () => {
    const r = await readInstalledPlugins(
      env({ '/h/.claude/plugins/installed_plugins.json': 'not json' }),
    );
    expect(r.ok).toBe(false);
  });
});
