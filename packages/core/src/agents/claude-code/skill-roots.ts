import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { PlatformPaths } from '../../ports/types.ts';
import type { SkillRootsCtx } from '../adapter-types.ts';
import { getManagedSkillsDir, isManagedSkillsDisabled } from './managed-path.ts';

export type { SkillRootsCtx } from '../adapter-types.ts';

export const getSkillRoots = (
  env: PlatformPaths,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  switch (scope) {
    case 'user': {
      const base = ctx.configuration.claudeConfigDir ?? join(env.homeDir, '.claude');
      return [join(base, 'skills')];
    }
    case 'project':
      return [join(ctx.cwd, '.claude', 'skills')];
    case 'system':
      return [];
    case 'managed':
      return isManagedSkillsDisabled(ctx.configuration)
        ? []
        : [getManagedSkillsDir(env.platform, ctx.configuration)];
  }
};
