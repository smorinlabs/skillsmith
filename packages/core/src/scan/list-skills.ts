import { Glob } from 'bun';
import { registry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import type { SkillSmithError } from '../errors.ts';
import { throwIfInventoryCancelled } from '../inventory/cancellation.ts';
import type { InventoryMode } from '../inventory/types.ts';
import { type ObservationBundle, observationFromLegacyLogger } from '../observation/index.ts';
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
  modeFilter?: InventoryMode;
  sourceGlob?: string;
  revisionGlob?: string;
  descriptionGlob?: string;
  verificationFilter?: 'verified' | 'unverified';
  cwd: string;
  configuration: ResolvedRuntimeConfiguration;
  observation?: ObservationBundle;
  /** @deprecated Use observation. */
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
  signal?: AbortSignal,
): Promise<SkillEntry[]> => {
  const out: SkillEntry[] = [];
  const failures: unknown[] = [];
  for (const tool of tools) {
    throwIfInventoryCancelled(signal);
    for (const scope of scopes) {
      throwIfInventoryCancelled(signal);
      const agent = registry[tool];
      const roots = agent.getSkillRoots(env, scope, ctx);
      const origin = standaloneOriginFor(scope);
      for (const [rootOrdinal, root] of roots.entries()) {
        throwIfInventoryCancelled(signal);
        try {
          const entries = await walkSkillDir(env, {
            tool,
            scope,
            root,
            origin,
            enabled: 'on',
            rootOrdinal,
            ...(signal === undefined ? {} : { signal }),
          });
          out.push(...entries);
        } catch (failure) {
          throwIfInventoryCancelled(signal);
          failures.push(failure);
        }
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const errors = Object.freeze([...failures]);
    const aggregate = new AggregateError(errors, 'multiple skill inventory roots failed');
    Object.freeze(aggregate.errors);
    throw aggregate;
  }
  return out;
};

const scanPluginBundled = async (
  env: InventoryReadPorts,
  tools: readonly SupportedTool[],
  discovered: readonly DiscoveredPlugin[],
  signal?: AbortSignal,
): Promise<SkillEntry[]> => {
  const out: SkillEntry[] = [];
  const failures: unknown[] = [];
  for (const tool of tools) {
    throwIfInventoryCancelled(signal);
    const agent = registry[tool];
    for (const [rootOrdinal, p] of discovered.entries()) {
      throwIfInventoryCancelled(signal);
      const root = agent.getPluginSkillDir(p.installation.installPath);
      if (!root) continue;
      const origin: Origin = {
        kind: 'plugin',
        pluginId: p.installation.id,
        pluginVersion: p.installation.version,
        pluginScope: p.installation.scope,
      };
      try {
        const entries = await walkSkillDir(env, {
          tool,
          scope: pluginScopeToScope(p.installation.scope),
          root,
          origin,
          enabled: p.enablement.enabled,
          rootOrdinal,
          ...(signal === undefined ? {} : { signal }),
        });
        out.push(...entries);
      } catch (failure) {
        throwIfInventoryCancelled(signal);
        failures.push(failure);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const errors = Object.freeze([...failures]);
    const aggregate = new AggregateError(errors, 'multiple plugin skill inventory roots failed');
    Object.freeze(aggregate.errors);
    throw aggregate;
  }
  return out;
};

const scanSkillPlacements = async (
  env: InventoryReadPorts,
  opts: ListSkillsOpts,
  project: (entries: SkillEntry[], scopes: readonly Scope[]) => SkillEntry[],
): Promise<Result<SkillEntry[], SkillSmithError>> => {
  const tools = opts.tools ?? (Object.keys(registry) as readonly SupportedTool[]);
  const observation =
    opts.observation ??
    observationFromLegacyLogger(opts.logger ?? noopLogger, 'list-skills', [...new Set(tools)]);
  const span = observation.emitter.begin(observation.context, {
    kind: 'operation.started',
    operationKind: 'inventory',
  });
  const scopes = opts.scopes ?? SCOPES;
  const ctx = { cwd: opts.cwd, configuration: opts.configuration };

  let standalone: SkillEntry[] = [];
  let pluginBundled: SkillEntry[] = [];
  try {
    throwIfInventoryCancelled(opts.signal);
    standalone = await scanStandalone(env, tools, scopes, ctx, opts.signal);
    throwIfInventoryCancelled(opts.signal);
    const discoveredR = await discoverPlugins(env, { cwd: opts.cwd });
    throwIfInventoryCancelled(opts.signal);
    if (!discoveredR.ok) {
      observation.emitter.complete(span, {
        outcome: 'failure',
        errorCode: discoveredR.error.code,
        standaloneCount: standalone.length,
        bundledCount: 0,
        resultCount: 0,
      });
      return discoveredR;
    }
    pluginBundled = await scanPluginBundled(env, tools, discoveredR.value, opts.signal);
    throwIfInventoryCancelled(opts.signal);
  } catch (error) {
    observation.emitter.complete(span, {
      outcome: 'failure',
      errorCode: 'generic',
      standaloneCount: standalone.length,
      bundledCount: pluginBundled.length,
      resultCount: 0,
    });
    throw error;
  }

  // scope filter applies after plugin expansion because plugin-bundled entries
  // have their scope computed from pluginScope
  const scopeSet = new Set(scopes);
  const all = project(
    [...standalone, ...pluginBundled].filter((entry) => scopeSet.has(entry.scope)),
    scopes,
  );

  observation.emitter.complete(span, {
    outcome: 'success',
    errorCode: null,
    standaloneCount: standalone.length,
    bundledCount: pluginBundled.length,
    resultCount: all.length,
  });

  return ok(all);
};

/** Internal all-observations seam. It intentionally does not apply legacy realpath dedupe. */
export const observeSkillPlacements = async (
  env: InventoryReadPorts,
  opts: ListSkillsOpts,
): Promise<Result<SkillEntry[], SkillSmithError>> =>
  scanSkillPlacements(env, opts, (entries) => entries);

export const listSkills = async (
  env: InventoryReadPorts,
  opts: ListSkillsOpts,
): Promise<Result<SkillEntry[], SkillSmithError>> =>
  scanSkillPlacements(env, opts, (entries) => {
    let projected = dedupeByRealpath(entries);
    if (opts.globs && opts.globs.length > 0) projected = applyGlobs(projected, opts.globs);
    if (opts.duplicatesOnly) projected = filterCrossScopeDuplicates(projected);
    if (opts.enabledFilter === 'enabled-only') {
      projected = projected.filter((entry) => entry.enabled === 'on');
    }
    if (opts.enabledFilter === 'disabled-only') {
      projected = projected.filter((entry) => entry.enabled === 'off');
    }
    if (opts.enabledFilter === 'unconfigured-only') {
      projected = projected.filter((entry) => entry.enabled === 'unset');
    }
    return projected;
  });
