import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { SkillRootsCtx } from './skill-roots.ts';

export const getCommandRoots = (
  env: ScanEnv,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  switch (scope) {
    case 'user': {
      const base = ctx.envVars.CLAUDE_CONFIG_DIR ?? join(env.homeDir, '.claude');
      return [join(base, 'commands')];
    }
    case 'project':
      return [join(ctx.cwd, '.claude', 'commands')];
    case 'system':
    case 'managed':
      return [];
  }
};
