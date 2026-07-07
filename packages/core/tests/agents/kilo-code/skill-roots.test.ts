import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/kilo-code/skill-roots.ts';
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

describe('kilo-code getSkillRoots', () => {
  test('user → .kilo + compat', () => {
    expect(getSkillRoots(env(), 'user', { cwd: '/p', envVars: {} })).toEqual([
      '/h/.kilo/skills',
      '/h/.claude/skills',
      '/h/.agents/skills',
    ]);
  });

  test('KILO_DISABLE_EXTERNAL_SKILLS=true drops compat', () => {
    const r = getSkillRoots(env(), 'user', {
      cwd: '/p',
      envVars: { KILO_DISABLE_EXTERNAL_SKILLS: 'true' },
    });
    expect(r).toEqual(['/h/.kilo/skills']);
  });

  test('project → project .kilo + compat', () => {
    expect(getSkillRoots(env(), 'project', { cwd: '/p', envVars: {} })).toEqual([
      '/p/.kilo/skills',
      '/p/.claude/skills',
      '/p/.agents/skills',
    ]);
  });

  test('system → empty', () => {
    expect(getSkillRoots(env(), 'system', { cwd: '/p', envVars: {} })).toEqual([]);
  });
});
