import { describe, expect, test } from 'bun:test';
import { getSkillRoots } from '../../../src/agents/antigravity/skill-roots.ts';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import type { PlatformPaths } from '../../../src/ports/types.ts';

const paths: PlatformPaths = {
  homeDir: '/home/u',
  executableSearchPath: [],
  platform: 'linux',
  xdg: {
    config: '/home/u/.config',
    data: '/home/u/.local/share',
    cache: '/home/u/.cache',
  },
};
const ctx = { cwd: '/work/proj', configuration: resolveRuntimeConfiguration({}) };

describe('antigravity getSkillRoots', () => {
  test('user returns native ~/.gemini/config/skills ahead of compat ~/.agents/skills', () => {
    expect(getSkillRoots(paths, 'user', ctx)).toEqual([
      '/home/u/.gemini/config/skills',
      '/home/u/.agents/skills',
    ]);
  });

  test('project returns .agents/skills and all three documented aliases in priority order', () => {
    expect(getSkillRoots(paths, 'project', ctx)).toEqual([
      '/work/proj/.agents/skills',
      '/work/proj/.agent/skills',
      '/work/proj/_agents/skills',
      '/work/proj/_agent/skills',
    ]);
  });

  test('system and managed return empty', () => {
    expect(getSkillRoots(paths, 'system', ctx)).toEqual([]);
    expect(getSkillRoots(paths, 'managed', ctx)).toEqual([]);
  });
});
