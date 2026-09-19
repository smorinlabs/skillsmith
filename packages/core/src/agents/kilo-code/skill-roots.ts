import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { PlatformPaths } from '../../ports/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

export const getSkillRoots = (
  env: PlatformPaths,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  const noCompat = ctx.configuration.kiloExternalSkillsDisabled;
  switch (scope) {
    case 'user': {
      const base = env.homeDir;
      const primary = [join(base, '.kilo', 'skills')];
      return noCompat
        ? primary
        : [...primary, join(base, '.claude', 'skills'), join(base, '.agents', 'skills')];
    }
    case 'project': {
      const base = ctx.cwd;
      const primary = [join(base, '.kilo', 'skills')];
      return noCompat
        ? primary
        : [...primary, join(base, '.claude', 'skills'), join(base, '.agents', 'skills')];
    }
    case 'system':
      return [];
    case 'managed':
      return [];
  }
};
