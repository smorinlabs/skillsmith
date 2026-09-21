import { describe, expect, test } from 'bun:test';
import type { InventoryIdentitySurface } from '../../src/agents/adapter-types.ts';
import { museDescriptor } from '../../src/agents/muse/descriptor.ts';
import { museAgent } from '../../src/agents/muse/index.ts';
import type { DetectionPorts } from '../../src/ports/types.ts';

const env = (
  existing: string[],
  runVersion: DetectionPorts['runVersion'] = async () => 'Muse Code 1.3.0 (1.3.0-R3401.1)',
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

describe('museAgent', () => {
  test('tool identity + installHint', () => {
    expect(museAgent.tool).toBe('muse');
    expect(museAgent.installHint).toContain('dev.meta.ai/install.sh');
  });

  test('descriptor is user+custom lifecycle at order 50', () => {
    expect(museDescriptor.id).toBe('muse');
    expect(museDescriptor.order).toBe(50);
    expect(museDescriptor.capabilityVersion).toBe(2);
    expect(museDescriptor.operations['inventory-skills'].supported).toBeTrue();
    expect(museDescriptor.operations.diagnostics.supported).toBeTrue();
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
      expect(museDescriptor.operations[op].supported).toBeTrue();
      expect(museDescriptor.operations[op].scopes).toEqual(['user', 'custom']);
    }
    expect(museDescriptor.operations['verify-static'].supported).toBeTrue();
    expect(museDescriptor.operations['verify-static'].scopes).toEqual(['artifact']);
    expect(museDescriptor.operations['verify-deep'].supported).toBeTrue();
    expect(museDescriptor.operations.adapt.supported).toBeFalse();
  });

  test('detects the `muse` binary', async () => {
    const r = await museAgent.detect(env(['/opt/homebrew/bin/muse']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]?.path).toBe('/opt/homebrew/bin/muse');
      expect(r.value[0]?.version).toContain('1.3.0');
    }
  });

  test('version probes suppress the launcher self-update check', async () => {
    let received: Record<string, string> | undefined;
    const runVersion: DetectionPorts['runVersion'] = async (_binary, _args, _signal, probeEnv) => {
      received = probeEnv;
      return '1.3.0';
    };
    const r = await museAgent.detect(env(['/usr/bin/muse'], runVersion));
    expect(r.ok).toBe(true);
    expect(received).toEqual({ MUSE_NO_AUTO_UPDATE: '1' });
  });

  test('no standalone command roots or plugin mapping yet', async () => {
    const paths = {
      homeDir: '/h',
      executableSearchPath: [],
      platform: 'linux' as const,
      xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
    };
    const ctx = { cwd: '/p', configuration: {} as never };
    expect(museAgent.getCommandRoots(paths, 'user', ctx)).toEqual([]);
    expect(museAgent.getPluginSkillDir('/x')).toBeNull();
    expect(museAgent.getPluginCommandDir('/x')).toBeNull();
  });

  test('collisions resolve project > user-native > user-compat', () => {
    const resolve = museAgent.resolveInventoryCollision;
    if (!resolve) throw new Error('muse collision resolver is missing');
    const project = surface({
      scope: 'project',
      root: '/p/.agents/skills',
      path: '/p/.agents/skills/dup',
      realpath: '/p/.agents/skills/dup',
    });
    const native = surface({
      scope: 'user',
      root: '/h/.config/muse/skills',
      path: '/h/.config/muse/skills/dup',
      realpath: '/h/.config/muse/skills/dup',
    });
    const compat = surface({ scope: 'user' });
    expect(resolve([compat, native, project])).toBe(project.path);
    expect(resolve([compat, native])).toBe(native.path);
    expect(resolve([compat])).toBe(compat.path);
    expect(resolve([])).toBeNull();
  });
});
