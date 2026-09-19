import { describe, expect, test } from 'bun:test';
import { readInstalledPlugins } from '../../src/plugins/installed.ts';
import type { InventoryReadPorts } from '../../src/ports/types.ts';

const env = (files: Record<string, string>): InventoryReadPorts => ({
  homeDir: '/h',
  executableSearchPath: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in files,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async (p) => files[p] ?? '',
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  modifiedAt: async () => null,
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
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'config-error', file: '/h/.claude/plugins/installed_plugins.json' },
    });
  });

  test('classifies an installed-plugin manifest EACCES as permission denied', async () => {
    const path = '/h/.claude/plugins/installed_plugins.json';
    const base = env({ [path]: '{}' });

    await expect(
      readInstalledPlugins({
        ...base,
        readText: async (candidate) => {
          if (candidate === path) {
            throw Object.assign(new Error('manifest denied'), { code: 'EACCES' });
          }
          return base.readText(candidate);
        },
      }),
    ).rejects.toEqual({
      code: 'permission-denied',
      message: 'manifest denied',
      path,
    });
  });
});
