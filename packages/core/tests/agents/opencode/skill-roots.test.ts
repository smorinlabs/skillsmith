import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/opencode/skill-roots.ts';
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

describe('opencode getSkillRoots', () => {
  test('user → XDG opencode + .claude compat + .agents compat', () => {
    expect(getSkillRoots(env(), 'user', ctx())).toEqual([
      '/h/.config/opencode/skills',
      '/h/.claude/skills',
      '/h/.agents/skills',
    ]);
  });

  test('OPENCODE_DISABLE_CLAUDE_CODE_SKILLS drops .claude/skills', () => {
    const r = getSkillRoots(env(), 'user', ctx({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' }));
    expect(r).toEqual(['/h/.config/opencode/skills', '/h/.agents/skills']);
  });

  test('OPENCODE_CONFIG_DIR overrides native root', () => {
    expect(getSkillRoots(env(), 'user', ctx({ OPENCODE_CONFIG_DIR: '/oc' }))).toEqual([
      '/oc/skills',
      '/h/.claude/skills',
      '/h/.agents/skills',
    ]);
  });

  test('project → three roots', () => {
    expect(getSkillRoots(env(), 'project', ctx())).toEqual([
      '/p/.opencode/skills',
      '/p/.claude/skills',
      '/p/.agents/skills',
    ]);
  });

  test('system → empty', () => {
    expect(getSkillRoots(env(), 'system', ctx())).toEqual([]);
  });
});
