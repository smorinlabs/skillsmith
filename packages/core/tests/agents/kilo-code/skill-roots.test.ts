import { describe, expect, test } from 'bun:test';
import type { InventoryIdentitySurface } from '../../../src/agents/adapter-types.ts';
import { kiloCodeAgent } from '../../../src/agents/kilo-code/index.ts';
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

const collisionCandidate = (
  scope: InventoryIdentitySurface['scope'],
  root: string,
): InventoryIdentitySurface => ({
  name: 'shared',
  scope,
  origin: { kind: 'standalone' },
  rootOrdinal: scope === 'user' ? 0 : 1,
  root,
  path: `${root}${root.includes('\\') ? '\\' : '/'}shared`,
  realpath: `${root}${root.includes('\\') ? '\\' : '/'}shared`,
});

describe('kilo-code inventory collision precedence', () => {
  test('project-native beats user-native with POSIX or Win32 separators', () => {
    const posix = [
      collisionCandidate('user', '/home/alice/.kilo/skills'),
      collisionCandidate('project', '/repo/.kilo/skills'),
    ];
    const win32 = [
      collisionCandidate('user', 'C:\\Users\\alice\\.kilo\\skills'),
      collisionCandidate('project', 'D:\\repo\\.kilo\\skills'),
    ];

    expect(kiloCodeAgent.resolveInventoryCollision?.(posix)).toBe(posix[1]?.path);
    expect(kiloCodeAgent.resolveInventoryCollision?.(win32)).toBe(win32[1]?.path);
  });

  test('compatibility and native-looking prefix roots remain ambiguous', () => {
    const compatibility = [
      collisionCandidate('user', '/home/alice/.kilo/skills'),
      collisionCandidate('project', '/repo/.claude/skills'),
    ];
    const falsePrefix = [
      collisionCandidate('user', '/home/alice/.kilo/skills'),
      collisionCandidate('project', '/repo/.kilo/skills-old'),
    ];

    expect(kiloCodeAgent.resolveInventoryCollision?.(compatibility)).toBeNull();
    expect(kiloCodeAgent.resolveInventoryCollision?.(falsePrefix)).toBeNull();
  });
});
