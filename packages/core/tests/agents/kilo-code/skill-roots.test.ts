import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/kilo-code/skill-roots.ts';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import type { PlatformPaths } from '../../../src/ports/types.ts';

const env = (home = '/h'): PlatformPaths => ({
  homeDir: home,
  executableSearchPath: [],
  platform: 'linux',
  xdg: { config: `${home}/.config`, data: `${home}/.local/share`, cache: `${home}/.cache` },
});

const ctx = (environment: Readonly<Record<string, string | undefined>> = {}) => ({
  cwd: '/p',
  configuration: resolveRuntimeConfiguration(environment),
});

describe('kilo-code getSkillRoots', () => {
  test('user → .kilo + compat', () => {
    expect(getSkillRoots(env(), 'user', ctx())).toEqual([
      '/h/.kilo/skills',
      '/h/.claude/skills',
      '/h/.agents/skills',
    ]);
  });

  test('KILO_DISABLE_EXTERNAL_SKILLS=true drops compat', () => {
    const r = getSkillRoots(env(), 'user', ctx({ KILO_DISABLE_EXTERNAL_SKILLS: 'true' }));
    expect(r).toEqual(['/h/.kilo/skills']);
  });

  test('project → project .kilo + compat', () => {
    expect(getSkillRoots(env(), 'project', ctx())).toEqual([
      '/p/.kilo/skills',
      '/p/.claude/skills',
      '/p/.agents/skills',
    ]);
  });

  test('system → empty', () => {
    expect(getSkillRoots(env(), 'system', ctx())).toEqual([]);
  });
});
