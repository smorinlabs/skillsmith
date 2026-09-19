import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/claude-code/skill-roots.ts';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import type { PlatformPaths } from '../../../src/ports/types.ts';

const env = (home = '/h'): PlatformPaths => ({
  homeDir: home,
  executableSearchPath: [],
  platform: 'linux',
  xdg: { config: `${home}/.config`, data: `${home}/.local/share`, cache: `${home}/.cache` },
});

const ctx = (environment: Readonly<Record<string, string | undefined>> = {}) => ({
  cwd: '/proj',
  configuration: resolveRuntimeConfiguration(environment),
});

describe('claude-code getSkillRoots', () => {
  test('user → ~/.claude/skills', () => {
    expect(getSkillRoots(env(), 'user', ctx())).toEqual(['/h/.claude/skills']);
  });

  test('user honors CLAUDE_CONFIG_DIR', () => {
    expect(getSkillRoots(env(), 'user', ctx({ CLAUDE_CONFIG_DIR: '/custom' }))).toEqual([
      '/custom/skills',
    ]);
  });

  test('project → <cwd>/.claude/skills', () => {
    expect(getSkillRoots(env(), 'project', ctx())).toEqual(['/proj/.claude/skills']);
  });

  test('system → empty', () => {
    expect(getSkillRoots(env(), 'system', ctx())).toEqual([]);
  });
});
