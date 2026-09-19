import { describe, expect, test } from 'bun:test';
import { walkCommandDir } from '../../src/commands/walk.ts';
import { INVENTORY_CANCELLED } from '../../src/inventory/cancellation.ts';
import { inventoryRootOrdinalOf } from '../../src/inventory/types.ts';
import type { InventoryReadPorts } from '../../src/ports/types.ts';

const fakeEnv = (
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

  test('propagates a selected command read failure without partial output', async () => {
    const failure = new Error('selected command read failed');
    const base = fakeEnv(
      { '/r': ['one.md', 'two.md'] },
      { '/r/one.md': '---\n---\n', '/r/two.md': '---\n---\n' },
    );
    const env: InventoryReadPorts = {
      ...base,
      readText: async (path) => {
        if (path === '/r/two.md') throw failure;
        return base.readText(path);
      },
    };

    await expect(
      walkCommandDir(env, {
        tool: 'claude-code',
        scope: 'user',
        root: '/r',
        origin: { kind: 'standalone' },
        enabled: 'on',
      }),
    ).rejects.toBe(failure);
  });

  test('classifies a selected command realpath EACCES as permission denied', async () => {
    const base = fakeEnv({ '/r': ['one.md'] }, { '/r/one.md': '---\n---\n' });
    const env: InventoryReadPorts = {
      ...base,
      realpath: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    };

    await expect(
      walkCommandDir(env, {
        tool: 'claude-code',
        scope: 'user',
        root: '/r',
        origin: { kind: 'standalone' },
        enabled: 'on',
      }),
    ).rejects.toEqual({
      code: 'permission-denied',
      message: 'denied',
      path: '/r/one.md',
    });
  });

  test('stops after an abort during the first command read', async () => {
    const controller = new AbortController();
    let reads = 0;
    let realpaths = 0;
    const base = fakeEnv(
      { '/r': ['one.md', 'two.md'] },
      { '/r/one.md': '---\n---\n', '/r/two.md': '---\n---\n' },
    );
    const env: InventoryReadPorts = {
      ...base,
      readText: async (path) => {
        reads += 1;
        controller.abort(new Error('private reason'));
        return base.readText(path);
      },
      realpath: async (path) => {
        realpaths += 1;
        return base.realpath(path);
      },
    };

    await expect(
      walkCommandDir(env, {
        tool: 'claude-code',
        scope: 'user',
        root: '/r',
        origin: { kind: 'standalone' },
        enabled: 'on',
        signal: controller.signal,
      }),
    ).rejects.toEqual(INVENTORY_CANCELLED);
    expect({ reads, realpaths }).toEqual({ reads: 1, realpaths: 0 });
  });

  test('retains a non-enumerable internal root ordinal', async () => {
    const r = await walkCommandDir(fakeEnv({ '/r': ['one.md'] }, { '/r/one.md': '---\n---\n' }), {
      tool: 'claude-code',
      scope: 'user',
      root: '/r',
      origin: { kind: 'standalone' },
      enabled: 'on',
      rootOrdinal: 3,
    });

    expect(inventoryRootOrdinalOf(r[0] ?? {})).toBe(3);
    expect(Object.keys(r[0] ?? {})).not.toContain('rootOrdinal');
  });
});
