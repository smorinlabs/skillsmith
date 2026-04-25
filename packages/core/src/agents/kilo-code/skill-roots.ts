import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

const compatDisabled = (envVars: Record<string, string | undefined>): boolean =>
  envVars.KILO_DISABLE_EXTERNAL_SKILLS === 'true';

export const getSkillRoots = (
  env: ScanEnv,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  const noCompat = compatDisabled(ctx.envVars);
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
