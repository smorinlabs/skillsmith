import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { walkSkillDir } from '../../src/skills/walk.ts';

interface Fake {
  dirs: Record<string, readonly string[]>;
  files: Record<string, string>;
  realpaths: Record<string, string>;
}

const fakeEnv = (fake: Fake): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in fake.files || p in fake.dirs,
  realpath: async (p) => fake.realpaths[p] ?? p,
  listDir: async (p) => fake.dirs[p] ?? [],
  readText: async (p) => fake.files[p] ?? '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
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
});
