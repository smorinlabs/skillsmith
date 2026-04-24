import {
  CONFIG_KEYS,
  type ConfigKey,
  type EffectiveConfig,
  type Result,
  type ScanEnv,
  type Scope,
  type SkillSmithError,
  getConfigValue,
  loadConfig,
} from '@skillsmith/core';

export interface RunConfigGetInput {
  env: ScanEnv;
  key: string;
  scope?: Scope;
  json?: boolean;
  loadConfig?: (env: ScanEnv) => Promise<Result<EffectiveConfig, SkillSmithError>>;
}

export type RunConfigGetError =
  | SkillSmithError
  | { code: 'unknown-key'; key: string }
  | { code: 'unset'; key: string; scope?: Scope };

export type RunConfigGetResult =
  | { ok: true; value: string; source?: string }
  | { ok: false; error: RunConfigGetError };

export const runConfigGet = async (input: RunConfigGetInput): Promise<RunConfigGetResult> => {
  if (!(CONFIG_KEYS as readonly string[]).includes(input.key)) {
    return { ok: false, error: { code: 'unknown-key', key: input.key } };
  }
  const key = input.key as ConfigKey;
  const loader = input.loadConfig ?? ((env: ScanEnv) => loadConfig(env));
  const r = await loader(input.env);
  if (!r.ok) return { ok: false, error: r.error };
  const eff = r.value;

  if (input.scope) {
    const v = getConfigValue(eff.layers[input.scope], key);
    if (v === undefined) {
      return { ok: false, error: { code: 'unset', key: input.key, scope: input.scope } };
    }
    return { ok: true, value: v };
  }
  const source = eff.sources[key];
  if (!source) return { ok: false, error: { code: 'unset', key: input.key } };
  const v = getConfigValue(eff.layers[source], key);
  if (v === undefined) return { ok: false, error: { code: 'unset', key: input.key } };
  return { ok: true, value: v, source };
};
