import type { InventoryReadPorts, PlatformPaths } from '../../ports/types.ts';
import type { PlacementBundle, PlacementInventory } from '../adapter-types.ts';
import { type Placement, classifyPlacement, listPlacements } from '../placement-shared.ts';
import { type SkillRootsCtx, getSkillRoots } from './skill-roots.ts';

export const claudeCodeSkillRootsUser = (
  env: PlatformPaths,
  ctx: SkillRootsCtx,
): readonly string[] => getSkillRoots(env, 'user', ctx);

export const listClaudeCodePlacements = async (
  env: InventoryReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
): Promise<Placement[]> => {
  const [root] = claudeCodeSkillRootsUser(env, ctx);
  if (root === undefined) return [];
  return listPlacements(env, root, storeRoot);
};

export const claudeCodePlacementBundle: PlacementBundle = {
  roots: getSkillRoots,
  standardRoots: (env, ctx) => claudeCodeSkillRootsUser(env, ctx),
  list: async (env, ctx, storeRoot): Promise<PlacementInventory> => {
    const placements = await listClaudeCodePlacements(env, ctx, storeRoot);
    const [currentRoot] = claudeCodeSkillRootsUser(env, ctx);
    return {
      placements,
      duplicates: [],
      currentRoot: currentRoot ?? null,
      legacyRoot: null,
    };
  },
  resolve: async (env, ctx, storeRoot, skill) => {
    const [root] = claudeCodeSkillRootsUser(env, ctx);
    const currentRoot = root ?? '';
    return {
      placement: await classifyPlacement(env, currentRoot, skill, storeRoot),
      notices: [],
      duplicateReason: null,
    };
  },
  noticeForRoot: () => null,
};
