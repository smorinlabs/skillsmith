import type { InventoryReadPorts } from '../../ports/types.ts';
import { type Placement, listPlacements } from '../placement-shared.ts';
import { type SkillRootsCtx, getSkillRoots } from './skill-roots.ts';

export const claudeCodeSkillRootsUser = (
  env: InventoryReadPorts,
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
