import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/muse/skill-roots.ts';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import type { PlatformPaths } from '../../../src/ports/types.ts';

const env = (home = '/h'): PlatformPaths => ({
  homeDir: home,
  executableSearchPath: [],
  platform: 'linux',
  xdg: { config: `${home}/.config`, data: `${home}/.local/share`, cache: `${home}/.cache` },
});

const ctx = () => ({ cwd: '/p', configuration: resolveRuntimeConfiguration({}) });

describe('muse getSkillRoots', () => {
  test('user → XDG muse native + .agents compat', () => {
    expect(getSkillRoots(env(), 'user', ctx())).toEqual([
      '/h/.config/muse/skills',
      '/h/.agents/skills',
    ]);
  });

  test('user follows XDG relocation', () => {
    const relocated: PlatformPaths = {
      ...env(),
      xdg: { config: '/xdg', data: '/h/.local/share', cache: '/h/.cache' },
    };
    expect(getSkillRoots(relocated, 'user', ctx())).toEqual([
      '/xdg/muse/skills',
      '/h/.agents/skills',
    ]);
  });

  test('project → .agents only', () => {
    expect(getSkillRoots(env(), 'project', ctx())).toEqual(['/p/.agents/skills']);
  });

  test('system and managed → empty', () => {
    expect(getSkillRoots(env(), 'system', ctx())).toEqual([]);
    expect(getSkillRoots(env(), 'managed', ctx())).toEqual([]);
  });
});
