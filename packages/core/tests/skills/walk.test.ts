import { describe, expect, test } from 'bun:test';
import { INVENTORY_CANCELLED } from '../../src/inventory/cancellation.ts';
import { inventoryRootOrdinalOf } from '../../src/inventory/types.ts';
import type { InventoryReadPorts } from '../../src/ports/types.ts';
import { walkSkillDir } from '../../src/skills/walk.ts';

interface Fake {
  dirs: Record<string, readonly string[]>;
  files: Record<string, string>;
  realpaths: Record<string, string>;
}

const fakeEnv = (fake: Fake): InventoryReadPorts => ({
  homeDir: '/h',
  executableSearchPath: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in fake.files || p in fake.dirs,
  realpath: async (p) => fake.realpaths[p] ?? p,
  listDir: async (p) => fake.dirs[p] ?? [],
  readText: async (p) => fake.files[p] ?? '',
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  modifiedAt: async () => null,
});

describe('walkSkillDir', () => {
  test('returns [] when root does not exist', async () => {
    const env = fakeEnv({ dirs: {}, files: {}, realpaths: {} });
    const r = await walkSkillDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/skills',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r).toEqual([]);
  });

  test('returns one entry per skill directory with SKILL.md', async () => {
    const env = fakeEnv({
      dirs: {
        '/h/.claude/skills': ['grep', 'diff'],
        '/h/.claude/skills/grep': ['SKILL.md'],
        '/h/.claude/skills/diff': ['SKILL.md'],
      },
      files: {
        '/h/.claude/skills/grep/SKILL.md': '---\nname: grep\n---\n',
        '/h/.claude/skills/diff/SKILL.md': '---\nname: diff\n---\n',
      },
      realpaths: {},
    });
    const r = await walkSkillDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/skills',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r.map((e) => e.name).sort()).toEqual(['diff', 'grep']);
    expect(r.every((e) => e.frontmatter !== null)).toBe(true);
  });

  test('entries with missing SKILL.md are omitted', async () => {
    const env = fakeEnv({
      dirs: {
        '/root': ['real', 'bogus'],
        '/root/real': ['SKILL.md'],
        '/root/bogus': [],
      },
      files: { '/root/real/SKILL.md': '---\nname: real\n---\n' },
      realpaths: {},
    });
    const r = await walkSkillDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/root',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r.map((e) => e.name)).toEqual(['real']);
  });

  test('SKILL.md with unknown fields still yields a populated skill entry', async () => {
    const env = fakeEnv({
      dirs: { '/r': ['ok'], '/r/ok': ['SKILL.md'] },
      files: { '/r/ok/SKILL.md': '---\nunknown_field: 42\n---\nbody\n' },
      realpaths: {},
    });
    const r = await walkSkillDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/r',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.frontmatter).toEqual({});
  });

  test('populates realpath (symlink collapse)', async () => {
    const env = fakeEnv({
      dirs: { '/r': ['link'], '/r/link': ['SKILL.md'] },
      files: { '/r/link/SKILL.md': '---\n---\n' },
      realpaths: { '/r/link': '/elsewhere/real' },
    });
    const r = await walkSkillDir(env, {
      tool: 'claude-code',
      scope: 'user',
      root: '/r',
      origin: { kind: 'standalone' },
      enabled: 'on',
    });
    expect(r[0]?.realpath).toBe('/elsewhere/real');
  });

  test('stops after an abort during the first entry read', async () => {
    const controller = new AbortController();
    let reads = 0;
    let realpaths = 0;
    const base = fakeEnv({
      dirs: { '/r': ['one', 'two'] },
      files: {
        '/r/one/SKILL.md': '---\n---\n',
        '/r/two/SKILL.md': '---\n---\n',
      },
      realpaths: {},
    });
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
      walkSkillDir(env, {
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
    const r = await walkSkillDir(
      fakeEnv({
        dirs: { '/r': ['one'] },
        files: { '/r/one/SKILL.md': '---\n---\n' },
        realpaths: {},
      }),
      {
        tool: 'codex',
        scope: 'user',
        root: '/r',
        origin: { kind: 'standalone' },
        enabled: 'on',
        rootOrdinal: 7,
      },
    );

    expect(inventoryRootOrdinalOf(r[0] ?? {})).toBe(7);
    expect(Object.keys(r[0] ?? {})).not.toContain('rootOrdinal');
  });
});
