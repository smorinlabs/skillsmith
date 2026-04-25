import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

export const getCommandRoots = (
  _env: ScanEnv,
  _scope: Scope,
  _ctx: SkillRootsCtx,
): readonly string[] => [];
