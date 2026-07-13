import { describe, expect, test } from 'bun:test';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import type { InventoryReadPorts } from '../../src/ports/types.ts';
import { listSkills } from '../../src/scan/list-skills.ts';

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
});
