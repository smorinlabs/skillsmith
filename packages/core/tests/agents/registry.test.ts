import { describe, expect, test } from 'bun:test';
import type {
  PlacementBundle,
  PlacementInventory,
  PlacementResolution,
} from '../../src/agents/adapter-types.ts';
import { codexAdapter } from '../../src/agents/codex/index.ts';
import { codexPlacementBundle } from '../../src/agents/codex/placement.ts';
import {
  createToolRegistry,
  getAgent,
  listSupportedTools,
  registry,
  toolRegistry,
} from '../../src/agents/registry.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';

const ENV = Object.freeze({
  homeDir: '/home/fixture',
  executableSearchPath: Object.freeze([]),
  platform: 'linux' as const,
  xdg: Object.freeze({
    config: '/xdg/config',
    data: '/xdg/data',
    cache: '/xdg/cache',
  }),
});
const CTX = Object.freeze({
  cwd: '/workspace/project',
  configuration: resolveRuntimeConfiguration({}),
});

const virtualPlacementPorts = (directories: readonly string[]) => {
  const present = new Set(directories);
  return {
    ...ENV,
    fileExists: async (path: string) =>
      present.has(path) || directories.some((candidate) => candidate.startsWith(`${path}/`)),
    pathKind: async (path: string) => (present.has(path) ? ('dir' as const) : ('absent' as const)),
    realpath: async (path: string) => path,
    listDir: async (path: string) =>
      directories
        .filter((candidate) => candidate.startsWith(`${path}/`))
        .map((candidate) => candidate.slice(path.length + 1).split('/')[0])
        .filter(
          (name, index, names): name is string =>
            name !== undefined && names.indexOf(name) === index,
        ),
    readText: async () => '',
    readBytes: async () => new Uint8Array(),
    readLink: async () => '',
    isExecutable: async () => false,
    modifiedAt: async () => null,
  };
};

const registeredPlacement = (placement: PlacementBundle) => {
  const custom = createToolRegistry([{ ...codexAdapter, placement }] as const);
  const registered = custom.get('codex')?.placement;
  if (!registered) throw new Error('registered Codex placement is missing');
  return registered;
};

describe('agents registry', () => {
  test('listSupportedTools returns all four tools in order', () => {
    expect(listSupportedTools()).toEqual(['claude-code', 'codex', 'kilo-code', 'opencode']);
  });

  test('registry has an Agent for every supported tool', () => {
    for (const t of listSupportedTools()) {
      expect(registry[t].tool).toBe(t);
    }
  });

  test('getAgent returns ok for a known tool and err for an unknown one', () => {
    const good = getAgent('codex');
    expect(good.ok).toBe(true);
    const bad = getAgent('nope');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('unknown-tool');
  });

  test('normalizes built-in placements without changing legacy method identity', () => {
    const placement = toolRegistry.get('codex')?.placement;
    if (!placement) throw new Error('Codex placement is missing');
    expect(placement.roots).toBe(codexPlacementBundle.roots);
    expect(placement.standardRoots).toBe(codexPlacementBundle.standardRoots);
    expect(placement.list).toBe(codexPlacementBundle.list);
    expect(placement.resolve).toBe(codexPlacementBundle.resolve);
    expect(placement.noticeForRoot).toBe(codexPlacementBundle.noticeForRoot);
    expect(placement.rootFacts(ENV, 'user', CTX)).toEqual([
      { path: '/home/fixture/.agents/skills', role: 'destination' },
      { path: '/home/fixture/.codex/skills', role: 'alternate' },
    ]);
    expect(placement.rootFacts(ENV, 'project', CTX)).toEqual([
      { path: '/workspace/project/.agents/skills', role: 'destination' },
    ]);
  });

  test('keeps legacy user behavior exact and supplies neutral scoped placement behavior', async () => {
    const userInventory: PlacementInventory = {
      placements: [],
      duplicates: ['legacy-user'],
      currentRoot: '/legacy/user/destination',
      legacyRoot: '/legacy/user/alternate',
    };
    const userResolution: PlacementResolution = {
      placement: {
        skill: 'alpha',
        root: '/legacy/user/destination',
        path: '/legacy/user/destination/alpha',
        class: 'absent',
        symlinkTarget: null,
        dangling: false,
      },
      notices: ['exact legacy user result'],
      duplicateReason: null,
    };
    const roots: PlacementBundle['roots'] = (_env, scope) => [
      `/legacy/${scope}/destination`,
      `/legacy/${scope}/alternate`,
    ];
    const standardRoots: PlacementBundle['standardRoots'] = () => [
      '/legacy/user/destination',
      '/legacy/user/alternate',
    ];
    const list: PlacementBundle['list'] = async () => userInventory;
    const resolve: PlacementBundle['resolve'] = async () => userResolution;
    const noticeForRoot: PlacementBundle['noticeForRoot'] = (root) =>
      root.endsWith('/alternate') ? 'adapter-owned alternate notice' : null;
    const placement = registeredPlacement({
      roots,
      standardRoots,
      list,
      resolve,
      noticeForRoot,
    });

    expect(placement.roots).toBe(roots);
    expect(placement.standardRoots).toBe(standardRoots);
    expect(placement.list).toBe(list);
    expect(placement.resolve).toBe(resolve);
    expect(placement.noticeForRoot).toBe(noticeForRoot);
    expect(await placement.listScoped(virtualPlacementPorts([]), CTX, '/store', 'user')).toBe(
      userInventory,
    );
    expect(
      await placement.resolveScoped(virtualPlacementPorts([]), CTX, '/store', 'alpha', 'user'),
    ).toBe(userResolution);

    const destination = '/legacy/project/destination';
    const alternate = '/legacy/project/alternate';
    expect(placement.rootFacts(ENV, 'project', CTX)).toEqual([
      { path: destination, role: 'destination' },
      { path: alternate, role: 'alternate' },
    ]);
    const duplicatePorts = virtualPlacementPorts([`${destination}/alpha`, `${alternate}/alpha`]);
    const inventory = await placement.listScoped(duplicatePorts, CTX, '/store', 'project');
    expect(inventory.currentRoot).toBe(destination);
    expect(inventory.legacyRoot).toBe(alternate);
    expect(inventory.duplicates).toEqual(['alpha']);
    const duplicate = await placement.resolveScoped(
      duplicatePorts,
      CTX,
      '/store',
      'alpha',
      'project',
    );
    expect(duplicate.placement.root).toBe(destination);
    expect(duplicate.notices).toEqual([]);
    expect(duplicate.duplicateReason).toContain('multiple adapter roots');
    expect(duplicate.duplicateReason).toContain(destination);
    expect(duplicate.duplicateReason).toContain(alternate);

    const alternateOnly = await placement.resolveScoped(
      virtualPlacementPorts([`${alternate}/alpha`]),
      CTX,
      '/store',
      'alpha',
      'project',
    );
    expect(alternateOnly.placement.root).toBe(alternate);
    expect(alternateOnly.notices).toEqual(['adapter-owned alternate notice']);
    expect(alternateOnly.duplicateReason).toBeNull();
  });

  test('rejects duplicate roots and any nonempty root set without one destination', () => {
    const duplicate = registeredPlacement({
      ...codexPlacementBundle,
      roots: () => ['/duplicate', '/duplicate'],
    });
    expect(() => duplicate.rootFacts(ENV, 'project', CTX)).toThrow(/duplicate/i);

    for (const facts of [
      [{ path: '/alternate', role: 'alternate' }] as const,
      [
        { path: '/first', role: 'destination' },
        { path: '/second', role: 'destination' },
      ] as const,
    ]) {
      const placement = registeredPlacement({
        ...codexPlacementBundle,
        rootFacts: () => facts,
      });
      expect(() => placement.rootFacts(ENV, 'project', CTX)).toThrow(/exactly one destination/i);
    }
  });

  test('does not invent notices for neutral alternate roots', async () => {
    const alternate = '/neutral/project/alternate';
    const placement = registeredPlacement({
      ...codexPlacementBundle,
      roots: (_env, scope) => [`/neutral/${scope}/destination`, `/neutral/${scope}/alternate`],
      noticeForRoot: () => null,
    });
    const resolved = await placement.resolveScoped(
      virtualPlacementPorts([`${alternate}/alpha`]),
      CTX,
      '/store',
      'alpha',
      'project',
    );
    expect(resolved.placement.root).toBe(alternate);
    expect(resolved.notices).toEqual([]);
  });
});
