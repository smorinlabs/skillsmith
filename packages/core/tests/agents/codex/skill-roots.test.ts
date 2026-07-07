import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/codex/skill-roots.ts';
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
});

describe('codex getSkillRoots', () => {
  test('user → current + deprecated', () => {
    expect(getSkillRoots(env(), 'user', { cwd: '/p', envVars: {} })).toEqual([
      '/h/.agents/skills',
      '/h/.codex/skills',
    ]);
  });

  test('user honors CODEX_HOME', () => {
    expect(getSkillRoots(env(), 'user', { cwd: '/p', envVars: { CODEX_HOME: '/cc' } })).toEqual([
      '/h/.agents/skills',
      '/cc/skills',
    ]);
  });

  test('project → <cwd>/.agents/skills', () => {
    expect(getSkillRoots(env(), 'project', { cwd: '/p', envVars: {} })).toEqual([
      '/p/.agents/skills',
    ]);
  });

  test('system → /etc/codex/skills', () => {
    expect(getSkillRoots(env(), 'system', { cwd: '/p', envVars: {} })).toEqual([
      '/etc/codex/skills',
    ]);
  });
});
