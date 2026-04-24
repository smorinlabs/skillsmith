import { join } from 'node:path';
import type { Scope } from '../../config/types.ts';
import type { ScanEnv } from '../../env/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';

export const getSkillRoots = (
  env: ScanEnv,
  scope: Scope,
  ctx: SkillRootsCtx,
): readonly string[] => {
  const dropClaude = ctx.envVars.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS === 'true';
  switch (scope) {
    case 'user': {
      const nativeBase = ctx.envVars.OPENCODE_CONFIG_DIR ?? join(env.xdg.config, 'opencode');
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
  }
};
