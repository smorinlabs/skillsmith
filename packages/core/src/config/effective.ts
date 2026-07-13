import { readFile as fsReadFile } from 'node:fs/promises';
import type { ProjectContext } from '../context/types.ts';
import type { ScanEnv } from '../env/types.ts';
import { type SkillSmithError, configError, errorMessage } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { CONFIG_ACCESSORS } from './accessors.ts';
import { configFromEnv } from './env.ts';
import { getConfigPath } from './paths.ts';
import { parseConfig } from './schema.ts';
import {
  CONFIG_KEYS,
  type Config,
  type ConfigKey,
  type ConfigLayer,
  type EffectiveConfig,
} from './types.ts';

export interface ResolveEffectiveConfigOptions {
  readonly cli?: Config;
  readonly envVars?: Record<string, string | undefined>;
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
  readonly exactLegacy: boolean;
}

const loadLayer = async (
  env: ScanEnv,
  path: string | null,
  readFile: (path: string) => Promise<string>,
): Promise<Result<LoadedLayer, SkillSmithError>> => {
  if (path === null || !(await env.fileExists(path))) {
    return ok({ config: {}, exactLegacy: false });
  }
  let source: string;
  try {
    source = await readFile(path);
  } catch (cause) {
    return err(configError(`failed to read ${path}: ${errorMessage(cause)}`, { file: path }));
  }
  const parsed = parseConfig(source);
  if (!parsed.ok) {
    return parsed.error.code === 'config-error' ? err({ ...parsed.error, file: path }) : parsed;
  }
  return ok({
    config: parsed.value,
    exactLegacy: Object.keys(parsed.value).length > 0,
  });
};

export const resolveEffectiveConfig = async (
  env: ScanEnv,
  context: ProjectContext,
  options: ResolveEffectiveConfigOptions = {},
): Promise<Result<EffectiveConfig, SkillSmithError>> => {
  const paths = {
    system: getConfigPath(env, 'system'),
    user: getConfigPath(env, 'user'),
    ...(context.discoveredConfigPath ? { project: context.discoveredConfigPath } : {}),
    ...(context.explicitConfigPath ? { 'explicit-file': context.explicitConfigPath } : {}),
  };
  const readFile = options.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));
  const [system, user, project, explicitFile] = await Promise.all([
    loadLayer(env, paths.system, readFile),
    loadLayer(env, paths.user, readFile),
    loadLayer(env, paths.project ?? null, readFile),
    loadLayer(env, paths['explicit-file'] ?? null, readFile),
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
    env: configFromEnv(options.envVars ?? process.env),
    cli: options.cli ?? {},
  };
  const value: Config = {};
  const sources: Partial<Record<ConfigKey, ConfigLayer>> = {};
  for (const key of CONFIG_KEYS) {
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

  const projectPath = paths.project;
  const notices =
    project.value.exactLegacy && projectPath
      ? [
          {
            code: 'legacy-project-config' as const,
            path: projectPath,
            migrationPending: true as const,
            migrationPhase: 2 as const,
          },
        ]
      : [];
  return ok({
    value,
    sources,
    layers,
    paths,
    ...(notices.length > 0 ? { notices } : {}),
  });
};
