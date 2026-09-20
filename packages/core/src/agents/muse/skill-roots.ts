import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { PlatformPaths } from '../../ports/types.ts';
import type { SkillRootsCtx } from '../adapter-types.ts';

export const getSkillRoots = (
  env: PlatformPaths,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  switch (scope) {
    case 'user': {
      const nativeBase = join(env.xdg.config, 'muse');
      return [join(nativeBase, 'skills'), join(env.homeDir, '.agents', 'skills')];
    }
    case 'project':
      return [join(ctx.cwd, '.agents', 'skills')];
    case 'system':
      return [];
    case 'managed':
      return [];
  }
};
