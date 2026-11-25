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
    case 'user':
      return [
        join(env.homeDir, '.gemini', 'config', 'skills'),
        join(env.homeDir, '.agents', 'skills'),
      ];
    case 'project':
      return [
        join(ctx.cwd, '.agents', 'skills'),
        join(ctx.cwd, '.agent', 'skills'),
        join(ctx.cwd, '_agents', 'skills'),
        join(ctx.cwd, '_agent', 'skills'),
      ];
    case 'system':
      return [];
    case 'managed':
      return [];
  }
};
