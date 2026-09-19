import { join } from 'node:path';
import {
  type InventoryBundle,
  type PlacementBundle,
  type PlacementInventory,
  type PlacementResolution,
  type SkillRootsCtx,
  type ToolAdapter,
  fullLifecycleOperations,
} from '../../../../packages/core/src/agents/adapter-types.ts';
import {
  classifyPlacement,
  listPlacements,
} from '../../../../packages/core/src/agents/placement-shared.ts';
import type { Scope } from '../../../../packages/core/src/config/types.ts';
import type {
  InventoryReadPorts,
  PlatformPaths,
} from '../../../../packages/core/src/ports/types.ts';
import type { ToolVerifier } from '../../../../packages/core/src/verify/types.ts';

export const FIXTURE_P3B_WRITE_TOOL = 'fixture-p3b-write' as const;
export const FIXTURE_P3B_ALTERNATE_NOTICE =
  'fixture-p3b-write placement is in the adapter-owned alternate root';
export const FIXTURE_P3B_DEEP_COVERAGE_SUFFIX = ' (fixture skill content)';

export const fixtureP3bInstallStaticNotice = (skill: string): string =>
  `fixture-p3b-write static verification passed for ${skill}; deep verification remains available`;

export interface FixtureP3bPlacementRootFact {
  readonly path: string;
  readonly role: 'destination' | 'alternate';
}

interface FixtureP3bPlacementBundle extends PlacementBundle {
  rootFacts(
    env: PlatformPaths,
    scope: Scope,
    ctx: SkillRootsCtx,
  ): readonly FixtureP3bPlacementRootFact[];
  listScoped(
    env: InventoryReadPorts,
    ctx: SkillRootsCtx,
    storeRoot: string,
    scope: Scope,
  ): Promise<PlacementInventory>;
  resolveScoped(
    env: InventoryReadPorts,
    ctx: SkillRootsCtx,
    storeRoot: string,
    skill: string,
    scope: Scope,
  ): Promise<PlacementResolution>;
}

const scopeBase = (env: PlatformPaths, scope: Scope, ctx: SkillRootsCtx): string => {
  switch (scope) {
    case 'system':
      return join(env.xdg.data, 'skillsmith-p3b-write');
    case 'user':
      return join(env.homeDir, '.skillsmith-p3b-write');
    case 'project':
      return join(ctx.cwd, '.skillsmith-p3b-write');
    case 'managed':
      return join(env.xdg.config, 'skillsmith-p3b-write-managed');
  }
};

const rootFacts = (
  env: PlatformPaths,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly FixtureP3bPlacementRootFact[] => {
  const base = scopeBase(env, scope, ctx);
  return [
    { path: join(base, 'skills'), role: 'destination' },
    { path: join(base, 'alternate-skills'), role: 'alternate' },
  ];
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const listScoped = async (
  env: InventoryReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  scope: Scope,
): Promise<PlacementInventory> => {
  const facts = rootFacts(env, scope, ctx);
  const byRoot = await Promise.all(
    facts.map(async (fact) => {
      const placements = await listPlacements(env, fact.path, storeRoot);
      return [...placements].sort((left, right) => compareText(left.skill, right.skill));
    }),
  );
  const placements = byRoot.flat();
  const presentCounts = new Map<string, number>();
  for (const placement of placements) {
    if (placement.class === 'absent') continue;
    presentCounts.set(placement.skill, (presentCounts.get(placement.skill) ?? 0) + 1);
  }
  const duplicates = [...presentCounts]
    .filter(([, count]) => count > 1)
    .map(([skill]) => skill)
    .sort(compareText);

  return {
    placements,
    duplicates,
    currentRoot: facts.find((fact) => fact.role === 'destination')?.path ?? null,
    legacyRoot: facts.find((fact) => fact.role === 'alternate')?.path ?? null,
  };
};

const resolveScoped = async (
  env: InventoryReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  skill: string,
  scope: Scope,
): Promise<PlacementResolution> => {
  const facts = rootFacts(env, scope, ctx);
  const classified = await Promise.all(
    facts.map(async (fact) => ({
      fact,
      placement: await classifyPlacement(env, fact.path, skill, storeRoot),
    })),
  );
  const present = classified.filter(({ placement }) => placement.class !== 'absent');
  const destination = classified.find(({ fact }) => fact.role === 'destination');
  if (!destination) throw new Error('fixture-p3b-write requires one destination root');

  if (present.length > 1) {
    return {
      placement: destination.placement,
      notices: [],
      duplicateReason: `fixture-p3b-write found ${skill} in multiple adapter roots: ${present
        .map(({ fact }) => fact.path)
        .join(', ')}`,
    };
  }

  const selected = present[0] ?? destination;
  return {
    placement: selected.placement,
    notices: selected.fact.role === 'alternate' ? [FIXTURE_P3B_ALTERNATE_NOTICE] : [],
    duplicateReason: null,
  };
};

export const fixtureP3bPlacementBundle: FixtureP3bPlacementBundle = {
  roots: (env, scope, ctx) => rootFacts(env, scope, ctx).map((fact) => fact.path),
  rootFacts,
  standardRoots: (env, ctx) => rootFacts(env, 'user', ctx).map((fact) => fact.path),
  list: (env, ctx, storeRoot) => listScoped(env, ctx, storeRoot, 'user'),
  listScoped,
  resolve: (env, ctx, storeRoot, skill) => resolveScoped(env, ctx, storeRoot, skill, 'user'),
  resolveScoped,
  noticeForRoot: (root, inventory) =>
    root === inventory.legacyRoot ? FIXTURE_P3B_ALTERNATE_NOTICE : null,
};

const inventoryRoot = (
  env: PlatformPaths,
  scope: Scope,
  ctx: SkillRootsCtx,
  artifact: 'skills' | 'commands',
): string => join(scopeBase(env, scope, ctx), `inventory-${artifact}`);

const inventory: InventoryBundle<typeof FIXTURE_P3B_WRITE_TOOL> = {
  tool: FIXTURE_P3B_WRITE_TOOL,
  installHint: 'install the hermetic fixture-p3b-write executable',
  detect: async () => ({ ok: true, value: [] }),
  getSkillRoots: (env, scope, ctx) => [inventoryRoot(env, scope, ctx, 'skills')],
  getCommandRoots: (env, scope, ctx) => [inventoryRoot(env, scope, ctx, 'commands')],
  getPluginSkillDir: (installPath) => join(installPath, 'fixture-skills'),
  getPluginCommandDir: (installPath) => join(installPath, 'fixture-commands'),
  resolveInventoryCollision: () => null,
};

const verifyFixture: ToolVerifier<typeof FIXTURE_P3B_WRITE_TOOL> = async (_env, options) => ({
  ok: true,
  value: {
    tool: FIXTURE_P3B_WRITE_TOOL,
    available: true,
    toolVersion: '3.6.0-fixture',
    versionDrift: false,
    skipReason: null,
    verdict: 'pass',
    modes: options.modes.map((mode) => ({
      mode,
      status: 'ran',
      skipReason: null,
      coverage: { manifest: true, skills: mode === 'deep' },
      verdict: 'pass',
      command: `fixture-p3b-write verify --${mode}`,
      findings: [],
    })),
  },
});

const definition = {
  descriptor: {
    id: FIXTURE_P3B_WRITE_TOOL,
    order: 9_002,
    capabilityVersion: 1,
    operations: fullLifecycleOperations(FIXTURE_P3B_WRITE_TOOL),
  },
  inventory,
  verification: {
    verifiedAgainst: '3.6.0-fixture',
    modes: ['static', 'deep'],
    verify: verifyFixture,
    gatePolicy: { installDeep: true, promote: 'static+deep', update: 'static+deep' },
    targetManifests: ['.fixture-p3b/plugin.json'],
    renderedFacts: {
      deepSkillCoverageSuffix: FIXTURE_P3B_DEEP_COVERAGE_SUFFIX,
      installStaticNotice: fixtureP3bInstallStaticNotice,
    },
  },
  placement: fixtureP3bPlacementBundle,
} as const;

const currentToolAdapter = <const Adapter extends ToolAdapter<typeof FIXTURE_P3B_WRITE_TOOL>>(
  adapter: Adapter,
): Adapter => adapter;

export const writeFixtureAdapter = currentToolAdapter(definition);
