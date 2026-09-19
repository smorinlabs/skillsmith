import { type SkillSmithError, configError, errorMessage } from '../errors.ts';
import type { InventoryReadPorts, ResolvedRuntimeConfiguration } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { CONFIG_ACCESSORS, getConfigTools, setConfigTools } from './accessors.ts';
import {
  findProjectConfig,
  getConfigPath,
  resolveConfigPath,
  resolveExplicitFile,
} from './paths.ts';
import { parseConfig, parseProjectConfig } from './schema.ts';
import {
  CONFIG_KEYS,
  type Config,
  type ConfigKey,
  type ConfigLayer,
  type EffectiveConfig,
} from './types.ts';

export interface LoadConfigOpts {
  explicitFile?: string;
  configuration: ResolvedRuntimeConfiguration;
  cwd: string;
  readFile?: (p: string) => Promise<string>;
}

const tryLoadFile = async (
  read: (path: string) => Promise<string>,
  exists: (path: string) => Promise<boolean>,
  path: string,
  projectDocument: boolean,
): Promise<Result<Config | null, SkillSmithError>> => {
  if (!(await exists(path))) return ok(null);
  let text: string;
  try {
    text = await read(path);
  } catch (error) {
    return err(configError(`failed to read ${path}: ${errorMessage(error)}`, { file: path }));
  }
  if (projectDocument) {
    const parsed = parseProjectConfig(text);
    return parsed.ok ? ok(parsed.value.config) : err({ ...parsed.error, file: path });
  }
  const parsed = parseConfig(text);
  return parsed.ok ? ok(parsed.value) : err({ ...parsed.error, file: path });
};

const ORDER: readonly ConfigLayer[] = [
  'defaults',
  'system',
  'user',
  'project',
  'explicit-file',
  'env',
  'cli',
];

export const loadConfig = async (
  env: InventoryReadPorts,
  opts: LoadConfigOpts,
): Promise<Result<EffectiveConfig, SkillSmithError>> => {
  const underlyingRead = opts.readFile ?? env.readText;
  const reads = new Map<string, Promise<string>>();
  const read = (path: string) => {
    let pending = reads.get(path);
    if (pending === undefined) {
      pending = underlyingRead(path);
      reads.set(path, pending);
    }
    return pending;
  };
  const explicitPath = resolveConfigPath(
    resolveExplicitFile({ flag: opts.explicitFile, env: opts.configuration.explicitConfigPath }),
    opts.cwd,
  );
  const systemPath = getConfigPath(env, 'system');
  const userPath = getConfigPath(env, 'user');
  const projectPath = await findProjectConfig(env, opts.cwd);
  const [system, user, project, explicit] = await Promise.all([
    tryLoadFile(read, env.fileExists, systemPath, false),
    tryLoadFile(read, env.fileExists, userPath, false),
    projectPath ? tryLoadFile(read, env.fileExists, projectPath, true) : Promise.resolve(ok(null)),
    explicitPath
      ? tryLoadFile(read, env.fileExists, explicitPath, true)
      : Promise.resolve(ok(null)),
  ]);
  if (!system.ok) return system;
  if (!user.ok) return user;
  if (!project.ok) return project;
  if (!explicit.ok) return explicit;

  const layers: Record<ConfigLayer, Config> = {
    defaults: {},
    system: system.value ?? {},
    user: user.value ?? {},
    project: project.value ?? {},
    'explicit-file': explicit.value ?? {},
    env: opts.configuration.configLayer,
    cli: {},
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
    toolSelection = {
      tools: Object.freeze([...tools]),
      source: layer,
      cardinality: tools.length === 1 ? 'scalar' : 'plural',
    };
    break;
  }
  for (const key of CONFIG_KEYS) {
    if (key === 'tool') continue;
    for (let index = ORDER.length - 1; index >= 0; index--) {
      const layer = ORDER[index];
      if (layer === undefined) continue;
      const selected = CONFIG_ACCESSORS[key].get(layers[layer]);
      if (selected === undefined) continue;
      CONFIG_ACCESSORS[key].set(value, selected);
      sources[key] = layer;
      break;
    }
  }
  return ok({
    value,
    sources,
    layers,
    paths: {
      system: systemPath,
      user: userPath,
      ...(projectPath ? { project: projectPath } : {}),
      ...(explicitPath ? { 'explicit-file': explicitPath } : {}),
    },
    ...(toolSelection ? { toolSelection } : {}),
  });
};
