import { describe, expect, test } from 'bun:test';
import { crossScopeDuplicate } from '../../src/doctor/checks/cross-scope-duplicate.ts';
import { noopLogger } from '../../src/env/logger.ts';
import type { ScanEnv } from '../../src/env/types.ts';
import { listSkills } from '../../src/scan/list-skills.ts';

const fakeEnv = (
  existing: Record<string, readonly string[]>,
  files: Record<string, string> = {},
): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in existing || p in files,
  realpath: async (p) => p,
  listDir: async (p) => existing[p] ?? [],
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
  modifiedAt: async () => null,
  withFileLock: (_p, fn) => fn(),
});

describe('listSkills', () => {
  test('cross-tool name reuse is not a same-tool cross-scope duplicate', async () => {
    const env = fakeEnv(
      {
        '/h/.claude/skills': ['shared'],
        '/proj/.agents/skills': ['shared'],
      },
      {
        '/h/.claude/skills/shared/SKILL.md': '---\nname: shared\n---\n',
        '/proj/.agents/skills/shared/SKILL.md': '---\nname: shared\n---\n',
      },
    );
    const opts = { tools: ['claude-code', 'codex'] as const, cwd: '/proj', envVars: {} };
    const inventory = await listSkills(env, opts);
    const duplicates = await listSkills(env, { ...opts, duplicatesOnly: true });
    expect(inventory.ok && inventory.value.length).toBe(2);
    expect(duplicates.ok && duplicates.value).toEqual([]);
  });

  test('doctor keeps independent tools duplicate groups separate', async () => {
    const roots = [
      '/h/.claude/skills',
      '/proj/.claude/skills',
      '/h/.agents/skills',
      '/proj/.agents/skills',
    ];
    const env = fakeEnv(
      Object.fromEntries(roots.map((root) => [root, ['shared']])),
      Object.fromEntries(
        roots.map((root) => [`${root}/shared/SKILL.md`, '---\nname: shared\n---\n']),
      ),
    );
    const findings = await crossScopeDuplicate.run({
      env,
      mode: 'doctor',
      tools: ['claude-code', 'codex'],
      scopes: ['user', 'project'],
      cwd: '/proj',
      envVars: {},
      offline: true,
      logger: noopLogger,
    });
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.tool).sort()).toEqual(['claude-code', 'codex']);
  });

  test('empty system → []', async () => {
    const r = await listSkills(fakeEnv({}), { cwd: '/proj', envVars: {} });
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
      envVars: {},
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
      envVars: {},
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
      envVars: {},
      globs: ['gr*'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((e) => e.name)).toEqual(['grep']);
  });
});
