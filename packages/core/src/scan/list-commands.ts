import { Glob } from 'bun';
import { registry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import type { CommandEntry } from '../commands/types.ts';
import { walkCommandDir } from '../commands/walk.ts';
import type { Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import type { SkillSmithError } from '../errors.ts';
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
): Promise<CommandEntry[]> => {
  const out: CommandEntry[] = [];
  const origin: Origin = { kind: 'standalone' };
  for (const tool of tools) {
    for (const scope of scopes) {
      const agent = registry[tool];
      const roots = agent.getCommandRoots(env, scope, ctx);
      for (const root of roots) {
        const entries = await walkCommandDir(env, {
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
): Promise<CommandEntry[]> => {
  const out: CommandEntry[] = [];
  for (const tool of tools) {
    const agent = registry[tool];
    for (const p of discovered) {
      const root = agent.getPluginCommandDir(p.installation.installPath);
      if (!root) continue;
      const origin: Origin = {
        kind: 'plugin',
        pluginId: p.installation.id,
        pluginVersion: p.installation.version,
        pluginScope: p.installation.scope,
      };
      const entries = await walkCommandDir(env, {
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

export const listCommands = async (
  env: InventoryReadPorts,
  opts: ListCommandsOpts,
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
    standalone = await scanStandalone(env, tools, scopes, {
      cwd: opts.cwd,
      configuration: opts.configuration,
    });
    const discoveredR = await discoverPlugins(env, { cwd: opts.cwd });
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
    pluginBundled = await scanPluginBundled(env, tools, discoveredR.value);
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

  let all = [...standalone, ...pluginBundled];
  all = dedupeByRealpath(all);
  if (opts.globs && opts.globs.length > 0) all = applyGlobs(all, opts.globs);
  if (opts.enabledFilter === 'enabled-only') all = all.filter((e) => e.enabled === 'on');
  if (opts.enabledFilter === 'disabled-only') all = all.filter((e) => e.enabled === 'off');
  if (opts.enabledFilter === 'unconfigured-only') all = all.filter((e) => e.enabled === 'unset');

  const scopeSet: Set<Scope> = new Set(scopes);
  all = all.filter((e) => scopeSet.has(e.scope));

  observation.emitter.complete(span, {
    outcome: 'success',
    errorCode: null,
    standaloneCount: standalone.length,
    bundledCount: pluginBundled.length,
    resultCount: all.length,
  });

  return ok(all);
};
