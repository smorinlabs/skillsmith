import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/codex/skill-roots.ts';
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

describe('codex getSkillRoots', () => {
  test('user → current + deprecated', () => {
    expect(getSkillRoots(env(), 'user', ctx())).toEqual(['/h/.agents/skills', '/h/.codex/skills']);
  });

  test('user honors CODEX_HOME', () => {
    expect(getSkillRoots(env(), 'user', ctx({ CODEX_HOME: '/cc' }))).toEqual([
      '/h/.agents/skills',
      '/cc/skills',
    ]);
  });

  test('project → <cwd>/.agents/skills', () => {
    expect(getSkillRoots(env(), 'project', ctx())).toEqual(['/p/.agents/skills']);
  });

  test('system → /etc/codex/skills', () => {
    expect(getSkillRoots(env(), 'system', ctx())).toEqual(['/etc/codex/skills']);
  });
});
