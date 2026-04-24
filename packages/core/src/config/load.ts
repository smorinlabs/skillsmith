import { readFile as fsReadFile } from 'node:fs/promises';
import type { ScanEnv } from '../env/types.ts';
import { type SkillSmithError, configError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { configFromEnv } from './env.ts';
import { findProjectConfig, getConfigPath, resolveExplicitFile } from './paths.ts';
import { parseConfig } from './schema.ts';
import type { Config, ConfigKey, ConfigLayer, EffectiveConfig } from './types.ts';

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
    return err(
      configError(`failed to read ${p}: ${e instanceof Error ? e.message : String(e)}`, {
        file: p,
      }),
    );
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    const base = parsed.error;
    if (base.code !== 'config-error') return err(base);
    return err({ ...base, file: p });
  }
  return ok(parsed.value);
};

// Layers in ascending precedence (later entries override earlier ones)
const ORDER: ConfigLayer[] = ['defaults', 'system', 'user', 'project', 'explicit-file', 'env'];

const KEY_GETTERS: Record<ConfigKey, (c: Config) => unknown> = {
  tool: (c) => c.tool,
  scope: (c) => c.scope,
  path: (c) => c.path,
  'registry.default': (c) => c.registry?.default,
};

const assign = (target: Config, key: ConfigKey, value: unknown): void => {
  switch (key) {
    case 'tool':
      target.tool = value as NonNullable<Config['tool']>;
      return;
    case 'scope':
      target.scope = value as NonNullable<Config['scope']>;
      return;
    case 'path':
      target.path = value as string;
      return;
    case 'registry.default':
      target.registry = { ...(target.registry ?? {}), default: value as string };
      return;
  }
};

export const loadConfig = async (
  env: ScanEnv,
  opts: LoadConfigOpts = {},
): Promise<Result<EffectiveConfig, SkillSmithError>> => {
  const read = opts.readFile ?? DEFAULT_READ;
  const envVars = opts.envVars ?? (process.env as Record<string, string | undefined>);
  const cwd = opts.cwd ?? process.cwd();
  const explicitPath = resolveExplicitFile({
    flag: opts.explicitFile,
    env: opts.explicitFileEnv,
  });
  const projectPath = await findProjectConfig(env, cwd);

  const layers: Record<ConfigLayer, Config> = {
    defaults: {},
    system: {},
    user: {},
    project: {},
    'explicit-file': {},
    env: configFromEnv(envVars),
  };

  const systemR = await tryLoadFile(read, env.fileExists, getConfigPath(env, 'system'));
  if (!systemR.ok) return systemR;
  if (systemR.value) layers.system = systemR.value;

  const userR = await tryLoadFile(read, env.fileExists, getConfigPath(env, 'user'));
  if (!userR.ok) return userR;
  if (userR.value) layers.user = userR.value;

  if (projectPath) {
    const projectR = await tryLoadFile(read, env.fileExists, projectPath);
    if (!projectR.ok) return projectR;
    if (projectR.value) layers.project = projectR.value;
  }
  if (explicitPath) {
    const explicitR = await tryLoadFile(read, env.fileExists, explicitPath);
    if (!explicitR.ok) return explicitR;
    if (explicitR.value) layers['explicit-file'] = explicitR.value;
  }

  const value: Config = {};
  const sources: Partial<Record<ConfigKey, ConfigLayer>> = {};
  const keys: ConfigKey[] = ['tool', 'scope', 'path', 'registry.default'];
  for (const key of keys) {
    for (let i = ORDER.length - 1; i >= 0; i--) {
      const layer = ORDER[i] as ConfigLayer;
      const v = KEY_GETTERS[key](layers[layer]);
      if (v !== undefined) {
        assign(value, key, v);
        sources[key] = layer;
        break;
      }
    }
  }

  return ok({ value, sources, layers });
};
