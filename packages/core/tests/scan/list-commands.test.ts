import { describe, expect, test } from 'bun:test';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import { INVENTORY_CANCELLED } from '../../src/inventory/cancellation.ts';
import type { InventoryReadPorts } from '../../src/ports/types.ts';
import { listCommands, observeCommandPlacements } from '../../src/scan/list-commands.ts';

const configuration = resolveRuntimeConfiguration({});

const env = (
  dirs: Record<string, readonly string[]>,
  files: Record<string, string>,
): InventoryReadPorts => ({
  homeDir: '/h',
  executableSearchPath: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in dirs || p in files,
  realpath: async (p) => p,
  listDir: async (p) => dirs[p] ?? [],
  readText: async (p) => files[p] ?? '',
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  modifiedAt: async () => null,
});

describe('listCommands', () => {
  test('empty → []', async () => {
    const r = await listCommands(env({}, {}), { cwd: '/proj', configuration });
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
      configuration,
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
    const r = await listCommands(e, { tools: ['claude-code'], cwd: '/proj', configuration });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cmd = r.value.find((x) => x.name === 'do-thing');
      expect(cmd?.origin.kind).toBe('plugin');
      expect(cmd?.enabled).toBe('on');
    }
  });
});

const failingPorts = (listDirs: string[]): InventoryReadPorts => ({
  homeDir: '/home/alice',
  executableSearchPath: Object.freeze([]),
  platform: 'linux',
  xdg: Object.freeze({
    config: '/home/alice/.config',
    data: '/home/alice/.local/share',
    cache: '/home/alice/.cache',
  }),
  fileExists: async () => true,
  pathKind: async () => 'dir',
  realpath: async (path) => path,
  listDir: async (path) => {
    listDirs.push(path);
    throw new Error(`failed:${path}`);
  },
  readText: async () => '',
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  isExecutable: async () => false,
  modifiedAt: async () => null,
});

describe('inventory command observation seam', () => {
  test('attempts every selected root before exposing a deterministic aggregate', async () => {
    const listDirs: string[] = [];
    let failure: unknown;
    try {
      await observeCommandPlacements(failingPorts(listDirs), {
        tools: ['claude-code'],
        scopes: ['user', 'project'],
        cwd: '/repo',
        configuration,
      });
    } catch (error) {
      failure = error;
    }
    expect(listDirs).toEqual(['/home/alice/.claude/commands', '/repo/.claude/commands']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(Object.isFrozen((failure as AggregateError).errors)).toBeTrue();
    expect((failure as AggregateError).errors.map(String)).toEqual([
      'Error: failed:/home/alice/.claude/commands',
      'Error: failed:/repo/.claude/commands',
    ]);
  });

  test('pre-cancellation wins before any root read', async () => {
    const listDirs: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error('private reason'));
    let failure: unknown;
    try {
      await observeCommandPlacements(failingPorts(listDirs), {
        tools: ['claude-code'],
        scopes: ['user', 'project'],
        cwd: '/repo',
        configuration,
        signal: controller.signal,
      });
    } catch (error) {
      failure = error;
    }
    expect(listDirs).toEqual([]);
    expect(failure).toEqual({ code: 'cancelled', message: 'inventory read cancelled' });
  });

  test('mid-root cancellation stops the command walker promptly', async () => {
    const root = '/h/.claude/commands';
    const controller = new AbortController();
    let reads = 0;
    const base = env(
      { [root]: ['one.md', 'two.md'] },
      { [`${root}/one.md`]: '---\n---\n', [`${root}/two.md`]: '---\n---\n' },
    );
    const ports: InventoryReadPorts = {
      ...base,
      readText: async (path) => {
        reads += 1;
        controller.abort(new Error('private reason'));
        return base.readText(path);
      },
    };

    await expect(
      observeCommandPlacements(ports, {
        tools: ['claude-code'],
        scopes: ['user'],
        cwd: '/repo',
        configuration,
        signal: controller.signal,
      }),
    ).rejects.toEqual(INVENTORY_CANCELLED);
    expect(reads).toBe(1);
  });
});
