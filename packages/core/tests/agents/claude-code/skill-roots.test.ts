import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/claude-code/skill-roots.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const env = (home = '/h'): ScanEnv => ({
  homeDir: home,
  path: [],
  platform: 'linux',
  xdg: { config: `${home}/.config`, data: `${home}/.local/share`, cache: `${home}/.cache` },
  fileExists: async () => false,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
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

describe('claude-code getSkillRoots', () => {
  test('user → ~/.claude/skills', () => {
    expect(getSkillRoots(env(), 'user', { cwd: '/proj', envVars: {} })).toEqual([
      '/h/.claude/skills',
    ]);
  });

  test('user honors CLAUDE_CONFIG_DIR', () => {
    expect(
      getSkillRoots(env(), 'user', { cwd: '/proj', envVars: { CLAUDE_CONFIG_DIR: '/custom' } }),
    ).toEqual(['/custom/skills']);
  });

  test('project → <cwd>/.claude/skills', () => {
    expect(getSkillRoots(env(), 'project', { cwd: '/proj', envVars: {} })).toEqual([
      '/proj/.claude/skills',
    ]);
  });

  test('system → empty', () => {
    expect(getSkillRoots(env(), 'system', { cwd: '/proj', envVars: {} })).toEqual([]);
  });
});
