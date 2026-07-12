import { readFile as fsReadFile } from 'node:fs/promises';
import type { ScanEnv } from '../env/types.ts';
import { type SkillSmithError, configError, errorMessage } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { CONFIG_ACCESSORS } from './accessors.ts';
import { configFromEnv } from './env.ts';
import {
  findProjectConfig,
  getConfigPath,
  resolveConfigPath,
  resolveExplicitFile,
} from './paths.ts';
import { parseConfig } from './schema.ts';
import {
  CONFIG_KEYS,
  type Config,
  type ConfigKey,
  type ConfigLayer,
  type EffectiveConfig,
} from './types.ts';

export interface LoadConfigOpts {
  explicitFile?: string;
  explicitFileEnv?: string;
  envVars?: Record<string, string | undefined>;
  cwd?: string;
  readFile?: (p: string) => Promise<string>;
}

const DEFAULT_READ = async (p: string) => fsReadFile(p, 'utf8');

const tryLoadFile = async (
  read: (p: string) => Promise<string>,
  exists: (p: string) => Promise<boolean>,
  p: string,
): Promise<Result<Config | null, SkillSmithError>> => {
  if (!(await exists(p))) return ok(null);
  let text: string;
  try {
    text = await read(p);
  } catch (e) {
    return err(configError(`failed to read ${p}: ${errorMessage(e)}`, { file: p }));
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    const base = parsed.error;
    if (base.code !== 'config-error') return err(base);
    return err({ ...base, file: p });
  }
  return ok(parsed.value);
};

const ORDER: ConfigLayer[] = [
  'defaults',
  'system',
  'user',
  'project',
  'explicit-file',
  'env',
  'cli',
];

export const loadConfig = async (
  env: ScanEnv,
  opts: LoadConfigOpts = {},
): Promise<Result<EffectiveConfig, SkillSmithError>> => {
  const read = opts.readFile ?? DEFAULT_READ;
  const envVars = opts.envVars ?? (process.env as Record<string, string | undefined>);
  const cwd = opts.cwd ?? process.cwd();
  const explicitPath = resolveConfigPath(
    resolveExplicitFile({
      flag: opts.explicitFile,
      env: opts.explicitFileEnv,
    }),
    cwd,
  );
  const systemPath = getConfigPath(env, 'system');
  const userPath = getConfigPath(env, 'user');
  const projectPath = await findProjectConfig(env, cwd);
  const [systemR, userR, projectR, explicitR] = await Promise.all([
    tryLoadFile(read, env.fileExists, systemPath),
    tryLoadFile(read, env.fileExists, userPath),
    projectPath ? tryLoadFile(read, env.fileExists, projectPath) : Promise.resolve(ok(null)),
    explicitPath ? tryLoadFile(read, env.fileExists, explicitPath) : Promise.resolve(ok(null)),
  ]);
  for (const r of [systemR, userR, projectR, explicitR]) {
    if (!r.ok) return r;
  }

  const layers: Record<ConfigLayer, Config> = {
    defaults: {},
    system: (systemR.ok && systemR.value) || {},
    user: (userR.ok && userR.value) || {},
    project: (projectR.ok && projectR.value) || {},
    'explicit-file': (explicitR.ok && explicitR.value) || {},
    env: configFromEnv(envVars),
    cli: {},
  };

  const value: Config = {};
  const sources: Partial<Record<ConfigKey, ConfigLayer>> = {};
  for (const key of CONFIG_KEYS) {
    for (let i = ORDER.length - 1; i >= 0; i--) {
      const layer = ORDER[i] as ConfigLayer;
      const v = CONFIG_ACCESSORS[key].get(layers[layer]);
      if (v !== undefined) {
        CONFIG_ACCESSORS[key].set(value, v);
        sources[key] = layer;
        break;
      }
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
  });
};
