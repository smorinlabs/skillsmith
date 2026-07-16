import type { Scope } from '../../config/types.ts';
import type { InventoryReadPorts } from '../../ports/types.ts';
import type {
  PlacementBundle,
  PlacementInventory,
  PlacementResolution,
  PlacementRootFact,
  SkillRootsCtx,
} from '../adapter-types.ts';
import { type Placement, classifyPlacement, listPlacements } from '../placement-shared.ts';
import { getSkillRoots } from './skill-roots.ts';

export interface CodexPlacementScan {
  placements: Placement[]; // from both roots; current root (~/.agents/skills) listed first
  duplicates: string[]; // skill names present (as flippable classes) in BOTH roots
  legacyRoot: string; // resolved legacy root (~/.codex/skills or $CODEX_HOME/skills)
  currentRoot: string; // resolved current root (~/.agents/skills)
}

export const CODEX_LEGACY_ROOT_NOTICE =
  'codex placement is in the legacy ~/.codex/skills; the current convention is ~/.agents/skills — ' +
  "a future 'skillsmith install' can migrate it";

const codexRootFacts = (
  env: Parameters<PlacementBundle['roots']>[0],
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly PlacementRootFact[] => {
  const [destination, alternate] = getSkillRoots(env, scope, ctx);
  if (destination === undefined) return [];
  return [
    { path: destination, role: 'destination' },
    ...(alternate === undefined ? [] : [{ path: alternate, role: 'alternate' as const }]),
  ];
};

const listCodexPlacementsScoped = async (
  env: InventoryReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  scope: Scope,
): Promise<CodexPlacementScan> => {
  const facts = codexRootFacts(env, scope, ctx);
  const currentRoot = facts.find((fact) => fact.role === 'destination')?.path;
  const legacyRoot = facts.find((fact) => fact.role === 'alternate')?.path;
  if (currentRoot === undefined) {
    return { placements: [], duplicates: [], legacyRoot: '', currentRoot: '' };
  }

  const currentPlacements = await listPlacements(env, currentRoot, storeRoot);
  const legacyPlacements =
    legacyRoot === undefined ? [] : await listPlacements(env, legacyRoot, storeRoot);

  const flippable = (p: Placement): boolean => p.class !== 'absent';
  const currentBySkill = new Map(currentPlacements.map((p) => [p.skill, p]));
  const legacyBySkill = new Map(legacyPlacements.map((p) => [p.skill, p]));

  const duplicates = [...currentBySkill.keys()].filter((skill) => {
    const current = currentBySkill.get(skill);
    const legacy = legacyBySkill.get(skill);
    return current !== undefined && legacy !== undefined && flippable(current) && flippable(legacy);
  });

  return {
    placements: [...currentPlacements, ...legacyPlacements],
    duplicates,
    legacyRoot: legacyRoot ?? '',
    currentRoot,
  };
};

export const listCodexPlacements = (
  env: InventoryReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
): Promise<CodexPlacementScan> => listCodexPlacementsScoped(env, ctx, storeRoot, 'user');

const resolveCodexPlacementScoped = async (
  env: InventoryReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  skill: string,
  scope: Scope,
): Promise<PlacementResolution> => {
  const facts = codexRootFacts(env, scope, ctx);
  const destination = facts.find((fact) => fact.role === 'destination');
  if (destination === undefined) {
    throw new Error(`codex placement invariant: no ${scope} destination root`);
  }
  const classified = await Promise.all(
    facts.map(async (fact) => ({
      fact,
      placement: await classifyPlacement(env, fact.path, skill, storeRoot),
    })),
  );
  const destinationPlacement = classified.find((item) => item.fact === destination);
  if (destinationPlacement === undefined) {
    throw new Error(`codex placement invariant: ${scope} destination was not classified`);
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
  return {
    placement: selected.placement,
    notices: selected.fact.role === 'alternate' ? [CODEX_LEGACY_ROOT_NOTICE] : [],
    duplicateReason: null,
  };
};

export const codexPlacementBundle: PlacementBundle = {
  roots: getSkillRoots,
  rootFacts: codexRootFacts,
  standardRoots: (env, ctx) => getSkillRoots(env, 'user', ctx),
  list: async (env, ctx, storeRoot) => {
    const scan = await listCodexPlacements(env, ctx, storeRoot);
    return {
      placements: scan.placements,
      duplicates: scan.duplicates,
      currentRoot: scan.currentRoot || null,
      legacyRoot: scan.legacyRoot || null,
    };
  },
  listScoped: async (env, ctx, storeRoot, scope): Promise<PlacementInventory> => {
    const scan = await listCodexPlacementsScoped(env, ctx, storeRoot, scope);
    return {
      placements: scan.placements,
      duplicates: scan.duplicates,
      currentRoot: scan.currentRoot || null,
      legacyRoot: scan.legacyRoot || null,
    };
  },
  resolve: (env, ctx, storeRoot, skill) =>
    resolveCodexPlacementScoped(env, ctx, storeRoot, skill, 'user'),
  resolveScoped: resolveCodexPlacementScoped,
  noticeForRoot: (root, inventory) =>
    inventory.legacyRoot === root ? CODEX_LEGACY_ROOT_NOTICE : null,
};
