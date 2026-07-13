import { Glob } from 'bun';
import { registry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import type { SkillSmithError } from '../errors.ts';
import { discoverPlugins } from '../plugins/discover.ts';
import type { DiscoveredPlugin } from '../plugins/types.ts';
import type { InventoryReadPorts, ResolvedRuntimeConfiguration } from '../ports/types.ts';
import { type Result, ok } from '../result.ts';
import type { Origin, PluginProvenanceScope, SkillEntry } from '../skills/types.ts';
import { walkSkillDir } from '../skills/walk.ts';

export interface ListSkillsOpts {
  tools?: readonly SupportedTool[];
  scopes?: readonly Scope[];
  globs?: readonly string[];
  duplicatesOnly?: boolean;
  enabledFilter?: 'enabled-only' | 'disabled-only' | 'unconfigured-only';
  cwd: string;
  configuration: ResolvedRuntimeConfiguration;
  logger?: Logger;
  signal?: AbortSignal;
}

const pluginScopeToScope = (ps: PluginProvenanceScope): Scope => (ps === 'local' ? 'project' : ps);

// Origin per scope: managed-scope claude-code skills are policy-pushed (not bundled in a plugin).
const standaloneOriginFor = (scope: Scope): Origin =>
  scope === 'managed' ? { kind: 'policy' } : { kind: 'standalone' };

const applyGlobs = (entries: SkillEntry[], globs: readonly string[]): SkillEntry[] => {
  const compiled = globs.map((g) => new Glob(g));
  return entries.filter((e) => compiled.some((g) => g.match(e.name)));
};

const filterCrossScopeDuplicates = (entries: SkillEntry[]): SkillEntry[] => {
  const byName = new Map<string, Set<Scope>>();
  for (const e of entries) {
    if (!byName.has(e.name)) byName.set(e.name, new Set());
    byName.get(e.name)?.add(e.scope);
  }
  const dupNames = new Set<string>();
  for (const [name, scopes] of byName) {
    if (scopes.size > 1) dupNames.add(name);
  }
  return entries.filter((e) => dupNames.has(e.name));
};

const dedupeByRealpath = (entries: SkillEntry[]): SkillEntry[] => {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const e of entries) {
    const key = `${e.tool}|${e.scope}|${e.realpath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
};

const scanStandalone = async (
  env: InventoryReadPorts,
  tools: readonly SupportedTool[],
  scopes: readonly Scope[],
  ctx: { cwd: string; configuration: ResolvedRuntimeConfiguration },
): Promise<SkillEntry[]> => {
  const out: SkillEntry[] = [];
  for (const tool of tools) {
    for (const scope of scopes) {
      const agent = registry[tool];
      const roots = agent.getSkillRoots(env, scope, ctx);
      const origin = standaloneOriginFor(scope);
      for (const root of roots) {
        const entries = await walkSkillDir(env, {
          tool,
          scope,
          root,
          origin,
          enabled: 'on',
        });
        out.push(...entries);
      }
    }
  }
  return out;
};

const scanPluginBundled = async (
  env: InventoryReadPorts,
  tools: readonly SupportedTool[],
  discovered: readonly DiscoveredPlugin[],
): Promise<SkillEntry[]> => {
  const out: SkillEntry[] = [];
  for (const tool of tools) {
    const agent = registry[tool];
    for (const p of discovered) {
      const root = agent.getPluginSkillDir(p.installation.installPath);
      if (!root) continue;
      const origin: Origin = {
        kind: 'plugin',
        pluginId: p.installation.id,
        pluginVersion: p.installation.version,
        pluginScope: p.installation.scope,
      };
      const entries = await walkSkillDir(env, {
        tool,
        scope: pluginScopeToScope(p.installation.scope),
        root,
        origin,
        enabled: p.enablement.enabled,
      });
      out.push(...entries);
    }
  }
  return out;
};

export const listSkills = async (
  env: InventoryReadPorts,
  opts: ListSkillsOpts,
): Promise<Result<SkillEntry[], SkillSmithError>> => {
  const logger = opts.logger ?? noopLogger;
  const tools = opts.tools ?? (Object.keys(registry) as readonly SupportedTool[]);
  const scopes = opts.scopes ?? SCOPES;
  const ctx = { cwd: opts.cwd, configuration: opts.configuration };

  const standalone = await scanStandalone(env, tools, scopes, ctx);
  const discoveredR = await discoverPlugins(env, { cwd: opts.cwd });
  if (!discoveredR.ok) return discoveredR;
  const pluginBundled = await scanPluginBundled(env, tools, discoveredR.value);

  let all = [...standalone, ...pluginBundled];
  all = dedupeByRealpath(all);
  if (opts.globs && opts.globs.length > 0) all = applyGlobs(all, opts.globs);
  if (opts.duplicatesOnly) all = filterCrossScopeDuplicates(all);
  if (opts.enabledFilter === 'enabled-only') all = all.filter((e) => e.enabled === 'on');
  if (opts.enabledFilter === 'disabled-only') all = all.filter((e) => e.enabled === 'off');
  if (opts.enabledFilter === 'unconfigured-only') all = all.filter((e) => e.enabled === 'unset');

  // scope filter applies after plugin expansion because plugin-bundled entries
  // have their scope computed from pluginScope
  const scopeSet = new Set(scopes);
  all = all.filter((e) => scopeSet.has(e.scope));

  logger.debug(
    `listSkills: ${standalone.length} standalone + ${pluginBundled.length} plugin = ${all.length} after filters`,
  );

  return ok(all);
};
