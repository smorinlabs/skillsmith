import { describe, expect, test } from 'bun:test';
import type { InventoryIdentitySurface } from '../../src/agents/adapter-types.ts';
import { antigravityDescriptor } from '../../src/agents/antigravity/descriptor.ts';
import { antigravityAdapter, antigravityAgent } from '../../src/agents/antigravity/index.ts';
import type { DetectionPorts } from '../../src/ports/types.ts';

const env = (
  existing: string[],
  runVersion: DetectionPorts['runVersion'] = async () => '1.5.16',
): DetectionPorts => ({
  homeDir: '/Users/u',
  executableSearchPath: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion,
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  modifiedAt: async () => null,
});

const surface = (
  overrides: Partial<InventoryIdentitySurface> & { scope: InventoryIdentitySurface['scope'] },
): InventoryIdentitySurface => ({
  name: 'dup',
  origin: { kind: 'standalone' },
  rootOrdinal: 0,
  root: '/h/.agents/skills',
  path: '/h/.agents/skills/dup',
  realpath: '/h/.agents/skills/dup',
  ...overrides,
});

describe('antigravityAgent', () => {
  test('tool identity + installHint', () => {
    expect(antigravityAgent.tool).toBe('antigravity');
    expect(antigravityAgent.installHint).toContain('antigravity.google/cli/install.sh');
  });

  test('descriptor is user+custom lifecycle at order 60', () => {
    expect(antigravityDescriptor.id).toBe('antigravity');
    expect(antigravityDescriptor.order).toBe(60);
    expect(antigravityDescriptor.capabilityVersion).toBe(2);
    expect(antigravityDescriptor.operations['inventory-skills'].supported).toBeTrue();
    expect(antigravityDescriptor.operations.diagnostics.supported).toBeTrue();
    for (const op of [
      'install',
      'uninstall',
      'dev',
      'promote',
      'undo',
      'plan',
      'apply',
      'sync',
      'update',
    ] as const) {
      expect(antigravityDescriptor.operations[op].supported).toBeTrue();
      expect(antigravityDescriptor.operations[op].scopes).toEqual(['user', 'custom']);
    }
    expect(antigravityDescriptor.operations['verify-static'].supported).toBeTrue();
    expect(antigravityDescriptor.operations['verify-static'].scopes).toEqual(['artifact']);
    expect(antigravityDescriptor.operations['verify-deep'].supported).toBeTrue();
    expect(antigravityDescriptor.operations['verify-deep'].scopes).toEqual(['artifact']);
    expect(antigravityDescriptor.operations.adapt.supported).toBeFalse();
    expect(antigravityAdapter.verification.gatePolicy).toEqual({
      installDeep: false,
      promote: 'static',
      update: 'static',
    });
  });

  test('detects the `agy` binary', async () => {
    const r = await antigravityAgent.detect(env(['/Users/u/.local/bin/agy']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]?.path).toBe('/Users/u/.local/bin/agy');
      expect(r.value[0]?.version).toBe('1.5.16');
    }
  });

  test('no standalone command roots or plugin mapping in v1', () => {
    const paths = {
      homeDir: '/h',
      executableSearchPath: [],
      platform: 'linux' as const,
      xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
    };
    const ctx = { cwd: '/p', configuration: {} as never };
    expect(antigravityAgent.getCommandRoots(paths, 'user', ctx)).toEqual([]);
    expect(antigravityAgent.getPluginSkillDir('/x')).toBeNull();
    expect(antigravityAgent.getPluginCommandDir('/x')).toBeNull();
  });

  test('collisions resolve project (.agents > aliases) > user-native > user-compat', () => {
    const resolve = antigravityAgent.resolveInventoryCollision;
    if (!resolve) throw new Error('antigravity collision resolver is missing');
    const projectCanonical = surface({
      scope: 'project',
      rootOrdinal: 0,
      root: '/p/.agents/skills',
      path: '/p/.agents/skills/dup',
      realpath: '/p/.agents/skills/dup',
    });
    const projectAlias = surface({
      scope: 'project',
      rootOrdinal: 1,
      root: '/p/.agent/skills',
      path: '/p/.agent/skills/dup',
      realpath: '/p/.agent/skills/dup',
    });
    const native = surface({
      scope: 'user',
      rootOrdinal: 0,
      root: '/h/.gemini/config/skills',
      path: '/h/.gemini/config/skills/dup',
      realpath: '/h/.gemini/config/skills/dup',
    });
    const compat = surface({
      scope: 'user',
      rootOrdinal: 1,
      root: '/h/.agents/skills',
      path: '/h/.agents/skills/dup',
      realpath: '/h/.agents/skills/dup',
    });
    expect(resolve([compat, native, projectAlias, projectCanonical])).toBe(projectCanonical.path);
    expect(resolve([compat, native, projectAlias])).toBe(projectAlias.path);
    expect(resolve([compat, native])).toBe(native.path);
    expect(resolve([compat])).toBe(compat.path);
    expect(resolve([])).toBeNull();
  });
});
