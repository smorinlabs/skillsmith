import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { PlatformPaths } from '../../ports/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

export const getSkillRoots = (
  env: PlatformPaths,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  const dropClaude = ctx.configuration.opencodeClaudeSkillsDisabled;
  switch (scope) {
    case 'user': {
      const nativeBase = ctx.configuration.opencodeConfigDir ?? join(env.xdg.config, 'opencode');
      const roots: string[] = [join(nativeBase, 'skills')];
      if (!dropClaude) roots.push(join(env.homeDir, '.claude', 'skills'));
      roots.push(join(env.homeDir, '.agents', 'skills'));
      return roots;
    }
    case 'project': {
      const base = ctx.cwd;
      const roots: string[] = [join(base, '.opencode', 'skills')];
      if (!dropClaude) roots.push(join(base, '.claude', 'skills'));
      roots.push(join(base, '.agents', 'skills'));
      return roots;
    }
    case 'system':
      return [];
    case 'managed':
      return [];
  }
};
