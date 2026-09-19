import { describe, expect, test } from 'bun:test';
import { INVENTORY_CANCELLED } from '../../src/inventory/cancellation.ts';
import { discoverPlugins } from '../../src/plugins/discover.ts';
import type { InventoryReadPorts } from '../../src/ports/types.ts';

const env = (files: Record<string, string>): InventoryReadPorts => ({
  homeDir: '/h',
  executableSearchPath: [],
  platform: 'darwin',
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

describe('discoverPlugins', () => {
  test('empty system → []', async () => {
    const r = await discoverPlugins(env({}), { cwd: '/proj' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('user-scope install + enabled', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: { 'foo@bar': [{ scope: 'user', installPath: '/x', version: '1.0' }] },
    });
    const settings = JSON.stringify({ enabledPlugins: { 'foo@bar': true } });
    const e = env({
      '/h/.claude/plugins/installed_plugins.json': installed,
      '/h/.claude/settings.json': settings,
    });
    const r = await discoverPlugins(e, { cwd: '/proj' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.enablement.enabled).toBe('on');
    }
  });

  test('project-scope install for a different project → filtered out', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [{ scope: 'project', installPath: '/x', version: '1.0', projectPath: '/other' }],
      },
    });
    const e = env({ '/h/.claude/plugins/installed_plugins.json': installed });
    const r = await discoverPlugins(e, { cwd: '/proj' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('project-scope install for matching project → included', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: {
        'foo@bar': [{ scope: 'project', installPath: '/x', version: '1.0', projectPath: '/proj' }],
      },
    });
    const settings = JSON.stringify({ enabledPlugins: { 'foo@bar': true } });
    const e = env({
      '/h/.claude/plugins/installed_plugins.json': installed,
      '/proj/.claude/settings.json': settings,
    });
    const r = await discoverPlugins(e, { cwd: '/proj' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.enablement.enabled).toBe('on');
    }
  });

  test('filters unrequested scopes before settings I/O', async () => {
    const installedPath = '/h/.claude/plugins/installed_plugins.json';
    const userSettings = '/h/.claude/settings.json';
    const projectSettings = '/proj/.claude/settings.json';
    const files = {
      [installedPath]: JSON.stringify({
        version: 2,
        plugins: {
          'user@market': [{ scope: 'user', installPath: '/user', version: '1.0' }],
          'project@market': [
            {
              scope: 'project',
              installPath: '/project',
              version: '1.0',
              projectPath: '/proj',
            },
          ],
        },
      }),
      [userSettings]: JSON.stringify({ enabledPlugins: { 'user@market': true } }),
      [projectSettings]: JSON.stringify({ enabledPlugins: { 'project@market': true } }),
    };
    const base = env(files);
    const reads: string[] = [];
    const r = await discoverPlugins(
      {
        ...base,
        readText: async (path) => {
          reads.push(path);
          return base.readText(path);
        },
      },
      { cwd: '/proj', scopes: ['user'] },
    );

    expect(r).toMatchObject({ ok: true, value: [{ installation: { id: 'user@market' } }] });
    expect(reads).toEqual([installedPath, userSettings]);
  });

  test('aborting during one plugin enablement leaves every later plugin untouched', async () => {
    const installedPath = '/h/.claude/plugins/installed_plugins.json';
    const settingsPath = '/h/.claude/settings.json';
    const files = {
      [installedPath]: JSON.stringify({
        version: 2,
        plugins: {
          'first@market': [{ scope: 'user', installPath: '/first', version: '1.0' }],
          'later@market': [{ scope: 'user', installPath: '/later', version: '1.0' }],
        },
      }),
      [settingsPath]: JSON.stringify({
        enabledPlugins: { 'first@market': true, 'later@market': true },
      }),
    };
    const base = env(files);
    const controller = new AbortController();
    let settingsReads = 0;

    await expect(
      discoverPlugins(
        {
          ...base,
          readText: async (path) => {
            const text = await base.readText(path);
            if (path === settingsPath) {
              settingsReads += 1;
              controller.abort(new Error('private reason'));
            }
            return text;
          },
        },
        { cwd: '/proj', scopes: ['user'], signal: controller.signal },
      ),
    ).rejects.toEqual(INVENTORY_CANCELLED);
    expect(settingsReads).toBe(1);
  });

  test('rejects malformed selected plugin settings as configuration state', async () => {
    const installedPath = '/h/.claude/plugins/installed_plugins.json';
    const settingsPath = '/h/.claude/settings.json';
    const e = env({
      [installedPath]: JSON.stringify({
        version: 2,
        plugins: { 'foo@bar': [{ scope: 'user', installPath: '/x', version: '1.0' }] },
      }),
      [settingsPath]: '{not-json',
    });

    await expect(discoverPlugins(e, { cwd: '/proj', scopes: ['user'] })).rejects.toMatchObject({
      code: 'config-error',
      file: settingsPath,
    });
  });
});
