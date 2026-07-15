import { describe, expect, test } from 'bun:test';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import { INVENTORY_CANCELLED } from '../../src/inventory/cancellation.ts';
import { inventoryRootOrdinalOf } from '../../src/inventory/types.ts';
import type { InventoryReadPorts } from '../../src/ports/types.ts';
import { listSkills, observeSkillPlacements } from '../../src/scan/list-skills.ts';

const configuration = resolveRuntimeConfiguration({});

const fakeEnv = (
  existing: Record<string, readonly string[]>,
  files: Record<string, string> = {},
): InventoryReadPorts => ({
  homeDir: '/h',
  executableSearchPath: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in existing || p in files,
  realpath: async (p) => p,
  listDir: async (p) => existing[p] ?? [],
  readText: async (p) => files[p] ?? '',
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  modifiedAt: async () => null,
});

describe('listSkills', () => {
  test('empty system → []', async () => {
    const r = await listSkills(fakeEnv({}), { cwd: '/proj', configuration });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test('finds claude user skill and labels it (scoped to claude-code only)', async () => {
    const env = fakeEnv(
      {
        '/h/.claude/skills': ['grep'],
        '/h/.claude/skills/grep': ['SKILL.md'],
      },
      { '/h/.claude/skills/grep/SKILL.md': '---\nname: grep\n---\n' },
    );
    const r = await listSkills(env, {
      tools: ['claude-code'],
      cwd: '/proj',
      configuration,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.tool).toBe('claude-code');
      expect(r.value[0]?.scope).toBe('user');
    }
  });

  test('duplicatesOnly filters to cross-scope name collisions', async () => {
    const env = fakeEnv(
      {
        '/h/.claude/skills': ['grep'],
        '/h/.claude/skills/grep': ['SKILL.md'],
        '/proj/.claude/skills': ['grep'],
        '/proj/.claude/skills/grep': ['SKILL.md'],
      },
      {
        '/h/.claude/skills/grep/SKILL.md': '---\n---\n',
        '/proj/.claude/skills/grep/SKILL.md': '---\n---\n',
      },
    );
    const r = await listSkills(env, {
      tools: ['claude-code'],
      cwd: '/proj',
      configuration,
      duplicatesOnly: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(2);
      expect(r.value.every((e) => e.name === 'grep')).toBe(true);
    }
  });

  test('glob filter narrows result', async () => {
    const env = fakeEnv(
      {
        '/h/.claude/skills': ['grep', 'diff'],
        '/h/.claude/skills/grep': ['SKILL.md'],
        '/h/.claude/skills/diff': ['SKILL.md'],
      },
      {
        '/h/.claude/skills/grep/SKILL.md': '---\n---\n',
        '/h/.claude/skills/diff/SKILL.md': '---\n---\n',
      },
    );
    const r = await listSkills(env, {
      tools: ['claude-code'],
      cwd: '/proj',
      configuration,
      globs: ['gr*'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((e) => e.name)).toEqual(['grep']);
  });

  test('internal observations retain each adapter root ordinal', async () => {
    const currentRoot = '/h/.agents/skills';
    const legacyRoot = '/h/.codex/skills';
    const observed = await observeSkillPlacements(
      fakeEnv(
        {
          [currentRoot]: ['current'],
          [legacyRoot]: ['legacy'],
        },
        {
          [`${currentRoot}/current/SKILL.md`]: '---\n---\n',
          [`${legacyRoot}/legacy/SKILL.md`]: '---\n---\n',
        },
      ),
      { tools: ['codex'], scopes: ['user'], cwd: '/proj', configuration },
    );

    expect(observed.ok).toBeTrue();
    if (observed.ok) {
      expect(observed.value.map((entry) => [entry.root, inventoryRootOrdinalOf(entry)])).toEqual([
        [currentRoot, 0],
        [legacyRoot, 1],
      ]);
    }
  });

  test('does not read Claude plugin state when selected tools have no plugin skill root', async () => {
    const pluginState = '/h/.claude/plugins/installed_plugins.json';
    const base = fakeEnv({});
    const touched: string[] = [];
    const env: InventoryReadPorts = {
      ...base,
      fileExists: async (path) => {
        touched.push(path);
        if (path === pluginState) throw new Error('Claude plugin state must stay untouched');
        return base.fileExists(path);
      },
    };

    const r = await listSkills(env, {
      tools: ['codex'],
      scopes: ['user'],
      cwd: '/proj',
      configuration,
    });

    expect(r).toMatchObject({ ok: true, value: [] });
    expect(touched).not.toContain(pluginState);
  });

  test('filters plugin scopes before settings and plugin-root I/O', async () => {
    const installedPath = '/h/.claude/plugins/installed_plugins.json';
    const projectSettings = '/proj/.claude/settings.json';
    const pluginRoot = '/pkg/skills';
    const base = fakeEnv(
      {},
      {
        [installedPath]: JSON.stringify({
          version: 2,
          plugins: {
            'project@market': [
              {
                scope: 'project',
                installPath: '/pkg',
                version: '1.0',
                projectPath: '/proj',
              },
            ],
          },
        }),
        [projectSettings]: JSON.stringify({ enabledPlugins: { 'project@market': true } }),
      },
    );
    const reads: string[] = [];
    const listed: string[] = [];
    const env: InventoryReadPorts = {
      ...base,
      readText: async (path) => {
        reads.push(path);
        return base.readText(path);
      },
      listDir: async (path) => {
        listed.push(path);
        return base.listDir(path);
      },
    };

    const r = await listSkills(env, {
      tools: ['claude-code'],
      scopes: ['user'],
      cwd: '/proj',
      configuration,
    });

    expect(r).toMatchObject({ ok: true, value: [] });
    expect(reads).toEqual([installedPath]);
    expect(reads).not.toContain(projectSettings);
    expect(listed).not.toContain(pluginRoot);
  });

  test('mid-root cancellation stops the skill walker promptly', async () => {
    const root = '/h/.claude/skills';
    const controller = new AbortController();
    let reads = 0;
    const base = fakeEnv(
      { [root]: ['one', 'two'] },
      {
        [`${root}/one/SKILL.md`]: '---\n---\n',
        [`${root}/two/SKILL.md`]: '---\n---\n',
      },
    );
    const env: InventoryReadPorts = {
      ...base,
      readText: async (path) => {
        reads += 1;
        controller.abort(new Error('private reason'));
        return base.readText(path);
      },
    };

    await expect(
      observeSkillPlacements(env, {
        tools: ['claude-code'],
        scopes: ['user'],
        cwd: '/proj',
        configuration,
        signal: controller.signal,
      }),
    ).rejects.toEqual(INVENTORY_CANCELLED);
    expect(reads).toBe(1);
  });
});
