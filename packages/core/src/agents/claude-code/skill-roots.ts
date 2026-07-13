import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { PlatformPaths, ResolvedRuntimeConfiguration } from '../../ports/types.ts';
import { getManagedSkillsDir, isManagedSkillsDisabled } from './managed-path.ts';

export interface SkillRootsCtx {
  cwd: string;
  configuration: ResolvedRuntimeConfiguration;
}

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
