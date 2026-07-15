import type { Scope } from '../config/types.ts';
import type { SkillSmithError } from '../errors.ts';
import { throwIfInventoryCancelled } from '../inventory-control.ts';
import type { InventoryReadPorts } from '../ports/types.ts';
import { type Result, ok } from '../result.ts';
import { resolveEnablement } from './enablement.ts';
import { readInstalledPlugins } from './installed.ts';
import type { DiscoveredPlugin } from './types.ts';

export interface DiscoverPluginsOpts {
  cwd: string;
  scopes?: readonly Scope[];
  signal?: AbortSignal;
}

const appliesToCwd = (
  installation: { scope: string; projectPath?: string | undefined },
  cwd: string,
): boolean => {
  if (installation.scope === 'user' || installation.scope === 'managed') return true;
  return installation.projectPath !== undefined && installation.projectPath === cwd;
};

const pluginScope = (scope: DiscoveredPlugin['installation']['scope']): Scope =>
  scope === 'local' ? 'project' : scope;

export const discoverPlugins = async (
  env: InventoryReadPorts,
  opts: DiscoverPluginsOpts,
): Promise<Result<DiscoveredPlugin[], SkillSmithError>> => {
  throwIfInventoryCancelled(opts.signal);
  const installed = await readInstalledPlugins(env, opts.signal);
  throwIfInventoryCancelled(opts.signal);
  if (!installed.ok) return installed;

  const requestedScopes = opts.scopes === undefined ? null : new Set(opts.scopes);
  const out: DiscoveredPlugin[] = [];
  for (const installation of installed.value) {
    throwIfInventoryCancelled(opts.signal);
    if (!appliesToCwd(installation, opts.cwd)) continue;
    if (requestedScopes !== null && !requestedScopes.has(pluginScope(installation.scope))) continue;
    const enablement = await resolveEnablement(env, installation, opts.signal);
    throwIfInventoryCancelled(opts.signal);
    out.push({ installation, enablement });
  }
  throwIfInventoryCancelled(opts.signal);
  return ok(out);
};
