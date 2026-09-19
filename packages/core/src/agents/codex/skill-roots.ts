import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { PlatformPaths } from '../../ports/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

export const getSkillRoots = (
  env: PlatformPaths,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  switch (scope) {
    case 'user': {
      const deprecatedBase = ctx.configuration.codexHome ?? join(env.homeDir, '.codex');
      return [join(env.homeDir, '.agents', 'skills'), join(deprecatedBase, 'skills')];
    }
    case 'project':
      return [join(ctx.cwd, '.agents', 'skills')];
    case 'system':
      return ['/etc/codex/skills'];
    case 'managed':
      return [];
  }
};
