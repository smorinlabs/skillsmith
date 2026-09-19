import { describe, expect, test } from 'bun:test';
import { resolveEnablement } from '../../src/plugins/enablement.ts';
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

describe('resolveEnablement', () => {
  test('user: explicit true → on', async () => {
    const e = env({
      '/h/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'foo@bar': true } }),
    });
    const r = await resolveEnablement(e, {
      id: 'foo@bar',
      scope: 'user',
      installPath: '/x',
      version: '1',
    });
    expect(r).toEqual({ enabled: 'on', source: 'user' });
  });

  test('user: missing settings file → unset', async () => {
    const r = await resolveEnablement(env({}), {
      id: 'foo@bar',
      scope: 'user',
      installPath: '/x',
      version: '1',
    });
    expect(r).toEqual({ enabled: 'unset', source: 'none' });
  });

  test('user: explicit false → off (source: user)', async () => {
    const e = env({
      '/h/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'foo@bar': false } }),
    });
    const r = await resolveEnablement(e, {
      id: 'foo@bar',
      scope: 'user',
      installPath: '/x',
      version: '1',
    });
    expect(r).toEqual({ enabled: 'off', source: 'user' });
  });

  test('user: enabledPlugins object exists but key absent → unset', async () => {
    const e = env({
      '/h/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'other@x': true } }),
    });
    const r = await resolveEnablement(e, {
      id: 'foo@bar',
      scope: 'user',
      installPath: '/x',
      version: '1',
    });
    expect(r).toEqual({ enabled: 'unset', source: 'none' });
  });

  test('project: reads <projectPath>/.claude/settings.json', async () => {
    const e = env({
      '/p/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'foo@bar': true } }),
    });
    const r = await resolveEnablement(e, {
      id: 'foo@bar',
      scope: 'project',
      installPath: '/x',
      version: '1',
      projectPath: '/p',
    });
    expect(r).toEqual({ enabled: 'on', source: 'project' });
  });

  test('local: reads <projectPath>/.claude/settings.local.json', async () => {
    const e = env({
      '/p/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'foo@bar': true } }),
    });
    const r = await resolveEnablement(e, {
      id: 'foo@bar',
      scope: 'local',
      installPath: '/x',
      version: '1',
      projectPath: '/p',
    });
    expect(r).toEqual({ enabled: 'on', source: 'local' });
  });

  test('managed: reads platform managed-settings.json (darwin path)', async () => {
    const e = env({
      '/Library/Application Support/ClaudeCode/managed-settings.json': JSON.stringify({
        enabledPlugins: { 'foo@bar': true },
      }),
    });
    const r = await resolveEnablement(e, {
      id: 'foo@bar',
      scope: 'managed',
      installPath: '/x',
      version: '1',
    });
    expect(r).toEqual({ enabled: 'on', source: 'managed' });
  });

  test('project: missing projectPath → unset', async () => {
    const r = await resolveEnablement(env({}), {
      id: 'foo@bar',
      scope: 'project',
      installPath: '/x',
      version: '1',
    });
    expect(r).toEqual({ enabled: 'unset', source: 'none' });
  });

  test('classifies a selected settings read EACCES as permission denied', async () => {
    const path = '/h/.claude/settings.json';
    const base = env({ [path]: '{}' });

    await expect(
      resolveEnablement(
        {
          ...base,
          readText: async (candidate) => {
            if (candidate === path) {
              throw Object.assign(new Error('settings denied'), { code: 'EACCES' });
            }
            return base.readText(candidate);
          },
        },
        { id: 'foo@bar', scope: 'user', installPath: '/x', version: '1' },
      ),
    ).rejects.toEqual({
      code: 'permission-denied',
      message: 'settings denied',
      path,
    });
  });
});
