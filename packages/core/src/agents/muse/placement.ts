import type { Scope } from '../../config/types.ts';
import type { InventoryReadPorts } from '../../ports/types.ts';
import type {
  PlacementBundle,
  PlacementInventory,
  PlacementResolution,
  PlacementRootFact,
  SkillRootsCtx,
} from '../adapter-types.ts';
import { classifyPlacement, listPlacements } from '../placement-shared.ts';
import { getSkillRoots } from './skill-roots.ts';

// Muse manages a single user placement root: the native
// `$XDG_CONFIG_HOME/muse/skills` directory (first user root by contract; the
// `~/.agents/skills` compatibility root stays inventory-visible but is never a
// placement target). Project mutations are deferred (D-scope: same destination
// as Codex, see issue #99), so non-user scopes expose no placement roots;
// every planning layer skips rootless (tool, scope) pairs before resolving.
const museRootFacts = (
  env: Parameters<PlacementBundle['roots']>[0],
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly PlacementRootFact[] => {
  if (scope !== 'user') return [];
  const [native] = getSkillRoots(env, scope, ctx);
  if (native === undefined) return [];
  return [{ path: native, role: 'destination' }];
};

const listMusePlacementsScoped = async (
  env: InventoryReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  scope: Scope,
): Promise<PlacementInventory> => {
  const facts = museRootFacts(env, scope, ctx);
  const destination = facts.find((fact) => fact.role === 'destination')?.path ?? null;
  if (destination === null) {
    return { placements: [], duplicates: [], currentRoot: null, legacyRoot: null };
  }
  const placements = (
    await Promise.all(facts.map(async (fact) => listPlacements(env, fact.path, storeRoot)))
  ).flat();
  const bySkill = new Map<string, number>();
  for (const placement of placements) {
    if (placement.class === 'absent') continue;
    bySkill.set(placement.skill, (bySkill.get(placement.skill) ?? 0) + 1);
  }
  const duplicates = [...bySkill.entries()]
    .filter(([, count]) => count > 1)
    .map(([skill]) => skill);
  return { placements, duplicates, currentRoot: destination, legacyRoot: null };
};

const resolveMusePlacementScoped = async (
  env: InventoryReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  skill: string,
  scope: Scope,
): Promise<PlacementResolution> => {
  const facts = museRootFacts(env, scope, ctx);
  const destination = facts.find((fact) => fact.role === 'destination');
  if (destination === undefined) {
    throw new Error(`muse placement invariant: no ${scope} destination root`);
  }
  const classified = await Promise.all(
    facts.map(async (fact) => ({
      fact,
      placement: await classifyPlacement(env, fact.path, skill, storeRoot),
    })),
  );
  const destinationPlacement = classified.find((item) => item.fact === destination);
  if (destinationPlacement === undefined) {
    throw new Error(`muse placement invariant: ${scope} destination was not classified`);
  }
  const present = classified.filter((item) => item.placement.class !== 'absent');
  if (present.length > 1) {
    return {
      placement: destinationPlacement.placement,
      notices: [],
      duplicateReason: `found in both ${present
        .map((item) => item.fact.path)
        .join(' and ')}; resolve the duplicate first`,
    };
  }
  const selected = present[0] ?? destinationPlacement;
  return { placement: selected.placement, notices: [], duplicateReason: null };
};

export const musePlacementBundle: PlacementBundle = {
  roots: (env, scope, ctx) => museRootFacts(env, scope, ctx).map((fact) => fact.path),
  rootFacts: museRootFacts,
  standardRoots: (env, ctx) => {
    const [native] = getSkillRoots(env, 'user', ctx);
    return native === undefined ? [] : [native];
  },
  list: (env, ctx, storeRoot) => listMusePlacementsScoped(env, ctx, storeRoot, 'user'),
  listScoped: listMusePlacementsScoped,
  resolve: (env, ctx, storeRoot, skill) =>
    resolveMusePlacementScoped(env, ctx, storeRoot, skill, 'user'),
  resolveScoped: resolveMusePlacementScoped,
  noticeForRoot: () => null,
};
