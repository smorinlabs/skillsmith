import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { discoverPlugins } from '../../src/plugins/discover.ts';

const env = (files: Record<string, string>): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'darwin',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in files,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async (p) => files[p] ?? '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
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
});
