import { SUPPORTED_TOOLS, type SupportedTool } from '../agents/types.ts';
import { type Config, SCOPES, type Scope } from './types.ts';

const isSupportedTool = (v: string): v is SupportedTool =>
  (SUPPORTED_TOOLS as readonly string[]).includes(v);

const isScope = (v: string): v is Scope => (SCOPES as readonly string[]).includes(v);

export const configFromEnv = (env: Record<string, string | undefined>): Config => {
  const c: Config = {};
  const tool = env.SKILLSMITH_TOOL;
  if (tool !== undefined && tool.length > 0 && isSupportedTool(tool)) c.tool = tool;
  const scope = env.SKILLSMITH_SCOPE;
  if (scope !== undefined && scope.length > 0 && isScope(scope)) c.scope = scope;
  const path = env.SKILLSMITH_PATH;
  if (path !== undefined && path.length > 0) c.path = path;
  const reg = env.SKILLSMITH_REGISTRY;
  if (reg !== undefined && reg.length > 0) c.registry = { default: reg };
  return c;
};
