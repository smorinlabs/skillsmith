import type { Scope } from '../../config/types.ts';
import type { PlatformPaths } from '../../ports/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

export const getCommandRoots = (
  _env: PlatformPaths,
  _scope: Scope,
  _ctx: SkillRootsCtx,
): readonly string[] => [];
