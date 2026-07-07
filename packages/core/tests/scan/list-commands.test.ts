import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { listCommands } from '../../src/scan/list-commands.ts';

const env = (dirs: Record<string, readonly string[]>, files: Record<string, string>): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in dirs || p in files,
  realpath: async (p) => p,
  listDir: async (p) => dirs[p] ?? [],
  readText: async (p) => files[p] ?? '',
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

describe('listCommands', () => {
  test('empty → []', async () => {
    const r = await listCommands(env({}, {}), { cwd: '/proj', envVars: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('finds standalone user command', async () => {
    const e = env(
      { '/h/.claude/commands': ['ci-audit.md'] },
      { '/h/.claude/commands/ci-audit.md': '---\ndescription: audit\n---\n' },
    );
    const r = await listCommands(e, {
      tools: ['claude-code'],
      cwd: '/proj',
      envVars: {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.name).toBe('ci-audit');
      expect(r.value[0]?.origin.kind).toBe('standalone');
    }
  });

  test('finds plugin-bundled command', async () => {
    const installed = JSON.stringify({
      version: 2,
      plugins: { 'foo@bar': [{ scope: 'user', installPath: '/pkg', version: '1.0' }] },
    });
    const settings = JSON.stringify({ enabledPlugins: { 'foo@bar': true } });
    const e = env(
      {
        '/pkg/commands': ['do-thing.md'],
      },
      {
        '/h/.claude/plugins/installed_plugins.json': installed,
        '/h/.claude/settings.json': settings,
        '/pkg/commands/do-thing.md': '---\ndescription: a plugin command\n---\n',
      },
    );
    const r = await listCommands(e, { tools: ['claude-code'], cwd: '/proj', envVars: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cmd = r.value.find((x) => x.name === 'do-thing');
      expect(cmd?.origin.kind).toBe('plugin');
      expect(cmd?.enabled).toBe('on');
    }
  });
});
