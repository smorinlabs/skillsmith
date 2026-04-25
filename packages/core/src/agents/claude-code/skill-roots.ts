import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import { getManagedSkillsDir, isManagedSkillsDisabled } from './managed-path.ts';

export interface SkillRootsCtx {
  cwd: string;
  envVars: Record<string, string | undefined>;
}

export const getSkillRoots = (
  env: ScanEnv,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  switch (scope) {
    case 'user': {
      const base = ctx.envVars.CLAUDE_CONFIG_DIR ?? join(env.homeDir, '.claude');
      return [join(base, 'skills')];
    }
    case 'project':
      return [join(ctx.cwd, '.claude', 'skills')];
    case 'system':
      return [];
    case 'managed':
      return isManagedSkillsDisabled(ctx.envVars)
        ? []
        : [getManagedSkillsDir(env.platform, ctx.envVars)];
  }
};
