import { Glob } from 'bun';
import { registry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import type { CommandEntry } from '../commands/types.ts';
import { walkCommandDir } from '../commands/walk.ts';
import type { Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import type { SkillSmithError } from '../errors.ts';
import { throwIfInventoryCancelled } from '../inventory/cancellation.ts';
import { type ObservationBundle, observationFromLegacyLogger } from '../observation/index.ts';
import { discoverPlugins } from '../plugins/discover.ts';
import type { DiscoveredPlugin } from '../plugins/types.ts';
import type { InventoryReadPorts, ResolvedRuntimeConfiguration } from '../ports/types.ts';
import { type Result, ok } from '../result.ts';
import type { Origin, PluginProvenanceScope } from '../skills/types.ts';

export interface ListCommandsOpts {
  tools?: readonly SupportedTool[];
  scopes?: readonly Scope[];
  globs?: readonly string[];
  enabledFilter?: 'enabled-only' | 'disabled-only' | 'unconfigured-only';
  cwd: string;
  configuration: ResolvedRuntimeConfiguration;
  observation?: ObservationBundle;
  /** @deprecated Use observation. */
  logger?: Logger;
  signal?: AbortSignal;
}

const COMMAND_SCOPES: readonly Scope[] = ['user', 'project'];

const pluginScopeToScope = (ps: PluginProvenanceScope): Scope => (ps === 'local' ? 'project' : ps);

const applyGlobs = (entries: CommandEntry[], globs: readonly string[]): CommandEntry[] => {
  const compiled = globs.map((g) => new Glob(g));
  return entries.filter((e) => compiled.some((g) => g.match(e.name)));
};

const dedupeByRealpath = (entries: CommandEntry[]): CommandEntry[] => {
  const seen = new Set<string>();
  const out: CommandEntry[] = [];
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
): Promise<CommandEntry[]> => {
  const out: CommandEntry[] = [];
  const failures: unknown[] = [];
  const origin: Origin = { kind: 'standalone' };
  for (const tool of tools) {
    throwIfInventoryCancelled(signal);
    for (const scope of scopes) {
      throwIfInventoryCancelled(signal);
      const agent = registry[tool];
      const roots = agent.getCommandRoots(env, scope, ctx);
      for (const [rootOrdinal, root] of roots.entries()) {
        throwIfInventoryCancelled(signal);
        try {
          const entries = await walkCommandDir(env, {
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
    const aggregate = new AggregateError(errors, 'multiple command inventory roots failed');
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
): Promise<CommandEntry[]> => {
  const out: CommandEntry[] = [];
  const failures: unknown[] = [];
  for (const tool of tools) {
    throwIfInventoryCancelled(signal);
    const agent = registry[tool];
    for (const [rootOrdinal, p] of discovered.entries()) {
      throwIfInventoryCancelled(signal);
      const root = agent.getPluginCommandDir(p.installation.installPath);
      if (!root) continue;
      const origin: Origin = {
        kind: 'plugin',
        pluginId: p.installation.id,
        pluginVersion: p.installation.version,
        pluginScope: p.installation.scope,
      };
      try {
        const entries = await walkCommandDir(env, {
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
    const aggregate = new AggregateError(errors, 'multiple plugin command inventory roots failed');
    Object.freeze(aggregate.errors);
    throw aggregate;
  }
  return out;
};

const scanCommandPlacements = async (
  env: InventoryReadPorts,
  opts: ListCommandsOpts,
  project: (entries: CommandEntry[]) => CommandEntry[],
): Promise<Result<CommandEntry[], SkillSmithError>> => {
  const tools = opts.tools ?? (Object.keys(registry) as readonly SupportedTool[]);
  const observation =
    opts.observation ??
    observationFromLegacyLogger(opts.logger ?? noopLogger, 'list-commands', [...new Set(tools)]);
  const span = observation.emitter.begin(observation.context, {
    kind: 'operation.started',
    operationKind: 'inventory',
  });
  const requestedScopes = opts.scopes ?? COMMAND_SCOPES;
  // commands don't exist at system/managed — filter even if caller requested
  const scopes = requestedScopes.filter((s) => s === 'user' || s === 'project');

  let standalone: CommandEntry[] = [];
  let pluginBundled: CommandEntry[] = [];
  try {
    throwIfInventoryCancelled(opts.signal);
    standalone = await scanStandalone(
      env,
      tools,
      scopes,
      {
        cwd: opts.cwd,
        configuration: opts.configuration,
      },
      opts.signal,
    );
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

  const scopeSet: Set<Scope> = new Set(scopes);
  const all = project(
    [...standalone, ...pluginBundled].filter((entry) => scopeSet.has(entry.scope)),
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
export const observeCommandPlacements = async (
  env: InventoryReadPorts,
  opts: ListCommandsOpts,
): Promise<Result<CommandEntry[], SkillSmithError>> =>
  scanCommandPlacements(env, opts, (entries) => entries);

export const listCommands = async (
  env: InventoryReadPorts,
  opts: ListCommandsOpts,
): Promise<Result<CommandEntry[], SkillSmithError>> =>
  scanCommandPlacements(env, opts, (entries) => {
    let projected = dedupeByRealpath(entries);
    if (opts.globs && opts.globs.length > 0) projected = applyGlobs(projected, opts.globs);
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
