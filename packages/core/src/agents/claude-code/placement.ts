import type { ScanEnv } from '../../env/types.ts';
import { type Placement, listPlacements } from '../placement-shared.ts';
import { type SkillRootsCtx, getSkillRoots } from './skill-roots.ts';

export const claudeCodeSkillRootsUser = (env: ScanEnv, ctx: SkillRootsCtx): readonly string[] =>
  getSkillRoots(env, 'user', ctx);

export const listClaudeCodePlacements = async (
  env: ScanEnv,
  ctx: SkillRootsCtx,
  storeRoot: string,
): Promise<Placement[]> => {
  const [root] = claudeCodeSkillRootsUser(env, ctx);
  if (root === undefined) return [];
  return listPlacements(env, root, storeRoot);
};
