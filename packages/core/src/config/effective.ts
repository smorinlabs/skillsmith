import type { ProjectContext } from '../context/types.ts';
import { type SkillSmithError, configError, errorMessage } from '../errors.ts';
import type { InventoryReadPorts, ResolvedRuntimeConfiguration } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { CONFIG_ACCESSORS, getConfigTools, setConfigTools } from './accessors.ts';
import { getConfigPath } from './paths.ts';
import { parseConfig, parseProjectConfig } from './schema.ts';
import {
  CONFIG_KEYS,
  type Config,
  type ConfigKey,
  type ConfigLayer,
  type EffectiveConfig,
  type ParsedConfigDocument,
} from './types.ts';

export interface ResolveEffectiveConfigOptions {
  readonly cli?: Config;
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly readFile?: (path: string) => Promise<string>;
}

const ORDER = [
  'defaults',
  'system',
  'user',
  'project',
  'explicit-file',
  'env',
  'cli',
] as const satisfies readonly ConfigLayer[];

interface LoadedLayer {
  readonly config: Config;
  readonly document?: ParsedConfigDocument;
}

const loadLayer = async (
  env: InventoryReadPorts,
  path: string | null,
  readFile: (path: string) => Promise<string>,
  projectDocument: boolean,
): Promise<Result<LoadedLayer, SkillSmithError>> => {
  if (path === null || !(await env.fileExists(path))) return ok({ config: {} });
  let source: string;
  try {
    source = await readFile(path);
  } catch (cause) {
    return err(configError(`failed to read ${path}: ${errorMessage(cause)}`, { file: path }));
  }
  if (projectDocument) {
    const parsed = parseProjectConfig(source);
    return parsed.ok
      ? ok({ config: parsed.value.config, document: parsed.value })
      : err({ ...parsed.error, file: path });
  }
  const parsed = parseConfig(source);
  return parsed.ok ? ok({ config: parsed.value }) : err({ ...parsed.error, file: path });
};

export const resolveEffectiveConfig = async (
  env: InventoryReadPorts,
  context: ProjectContext,
  options: ResolveEffectiveConfigOptions,
): Promise<Result<EffectiveConfig, SkillSmithError>> => {
  const paths = {
    system: getConfigPath(env, 'system'),
    user: getConfigPath(env, 'user'),
    ...(context.discoveredConfigPath ? { project: context.discoveredConfigPath } : {}),
    ...(context.explicitConfigPath ? { 'explicit-file': context.explicitConfigPath } : {}),
  };
  const underlyingRead = options.readFile ?? env.readText;
  const reads = new Map<string, Promise<string>>();
  const readFile = (path: string): Promise<string> => {
    let pending = reads.get(path);
    if (pending === undefined) {
      pending = underlyingRead(path);
      reads.set(path, pending);
    }
    return pending;
  };
  const projectLoads = new Map<string, Promise<Result<LoadedLayer, SkillSmithError>>>();
  const loadProjectLayer = (path: string | null): Promise<Result<LoadedLayer, SkillSmithError>> => {
    if (path === null) return Promise.resolve(ok({ config: {} }));
    let pending = projectLoads.get(path);
    if (pending === undefined) {
      pending = loadLayer(env, path, readFile, true);
      projectLoads.set(path, pending);
    }
    return pending;
  };
  const [system, user, project, explicitFile] = await Promise.all([
    loadLayer(env, paths.system, readFile, false),
    loadLayer(env, paths.user, readFile, false),
    loadProjectLayer(paths.project ?? null),
    loadProjectLayer(paths['explicit-file'] ?? null),
  ]);
  if (!system.ok) return system;
  if (!user.ok) return user;
  if (!project.ok) return project;
  if (!explicitFile.ok) return explicitFile;

  const layers: Record<ConfigLayer, Config> = {
    defaults: {},
    system: system.value.config,
    user: user.value.config,
    project: project.value.config,
    'explicit-file': explicitFile.value.config,
    env: options.configuration.configLayer,
    cli: options.cli ?? {},
  };
  const value: Config = {};
  const sources: Partial<Record<ConfigKey, ConfigLayer>> = {};

  let toolSelection: EffectiveConfig['toolSelection'];
  for (let index = ORDER.length - 1; index >= 0; index--) {
    const layer = ORDER[index];
    if (layer === undefined) continue;
    const tools = getConfigTools(layers[layer]);
    if (tools === undefined) continue;
    setConfigTools(value, tools);
    sources.tool = layer;
    toolSelection = Object.freeze({
      tools: Object.freeze([...tools]),
      source: layer,
      cardinality: tools.length === 1 ? 'scalar' : 'plural',
    });
    break;
  }

  for (const key of CONFIG_KEYS) {
    if (key === 'tool') continue;
    for (let index = ORDER.length - 1; index >= 0; index--) {
      const layer = ORDER[index];
      if (layer === undefined) continue;
      const candidate = CONFIG_ACCESSORS[key].get(layers[layer]);
      if (candidate === undefined) continue;
      CONFIG_ACCESSORS[key].set(value, candidate);
      sources[key] = layer;
      break;
    }
  }

  const notices: NonNullable<EffectiveConfig['notices']>[number][] = [];
  const projectPath = paths.project;
  if (project.value.document?.migrationPending && projectPath) {
    notices.push({
      code: 'legacy-project-config',
      path: projectPath,
      migrationPending: true,
      migrationPhase: 2,
    });
  }
  for (const layer of ORDER) {
    const tools = getConfigTools(layers[layer]);
    if (tools === undefined || tools.length < 2) continue;
    notices.push({
      code: 'plural-tool-selection',
      ...(layer === 'project' && paths.project
        ? { path: paths.project }
        : layer === 'explicit-file' && paths['explicit-file']
          ? { path: paths['explicit-file'] }
          : {}),
      tools: Object.freeze([...tools]),
      source: layer,
      disposition: sources.tool === layer ? 'effective' : 'shadowed',
    });
  }

  return ok({
    value,
    sources,
    layers,
    paths,
    ...(toolSelection === undefined ? {} : { toolSelection }),
    ...(notices.length === 0 ? {} : { notices: Object.freeze(notices) }),
  });
};
