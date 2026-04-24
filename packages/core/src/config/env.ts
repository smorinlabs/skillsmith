import type { SupportedTool } from '../agents/types.ts';
import type { Config, Scope } from './types.ts';

export const configFromEnv = (env: Record<string, string | undefined>): Config => {
  const c: Config = {};
  const tool = env.SKILLSMITH_TOOL;
  if (tool !== undefined && tool.length > 0) c.tool = tool as SupportedTool;
  const scope = env.SKILLSMITH_SCOPE;
  if (scope !== undefined && scope.length > 0) c.scope = scope as Scope;
  const path = env.SKILLSMITH_PATH;
  if (path !== undefined && path.length > 0) c.path = path;
  const reg = env.SKILLSMITH_REGISTRY;
  if (reg !== undefined && reg.length > 0) c.registry = { default: reg };
  return c;
};
