import type { SkillSmithError } from '../errors.ts';
import type { InventoryReadPorts } from '../ports/types.ts';
import { type Result, ok } from '../result.ts';
import { resolveEnablement } from './enablement.ts';
import { readInstalledPlugins } from './installed.ts';
import type { DiscoveredPlugin } from './types.ts';

export interface DiscoverPluginsOpts {
  cwd: string;
}

const appliesToCwd = (
  installation: { scope: string; projectPath?: string | undefined },
  cwd: string,
): boolean => {
  if (installation.scope === 'user' || installation.scope === 'managed') return true;
  return installation.projectPath !== undefined && installation.projectPath === cwd;
};

export const discoverPlugins = async (
  env: InventoryReadPorts,
  opts: DiscoverPluginsOpts,
): Promise<Result<DiscoveredPlugin[], SkillSmithError>> => {
  const installed = await readInstalledPlugins(env);
  if (!installed.ok) return installed;

  const out: DiscoveredPlugin[] = [];
  for (const installation of installed.value) {
    if (!appliesToCwd(installation, opts.cwd)) continue;
    const enablement = await resolveEnablement(env, installation);
    out.push({ installation, enablement });
  }
  return ok(out);
};
