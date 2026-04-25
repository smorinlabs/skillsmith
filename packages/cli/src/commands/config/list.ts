import {
  CONFIG_KEYS,
  type EffectiveConfig,
  type Result,
  type ScanEnv,
  type Scope,
  type SkillSmithError,
  getConfigValue,
  loadConfig,
} from '@skillsmith/core';

export interface RunConfigListInput {
  env: ScanEnv;
  scope?: Scope;
  json?: boolean;
  loadConfig?: (env: ScanEnv) => Promise<Result<EffectiveConfig, SkillSmithError>>;
}

export type RunConfigListResult =
  | { ok: true; output: string }
  | { ok: false; error: SkillSmithError };

// Config has its own ConfigLayer enum (defaults | system | user | project | explicit-file | env).
// Scope's 'managed' value is not a config layer — reject here.
type ConfigScope = Exclude<Scope, 'managed'>;
const isConfigScope = (s: Scope): s is ConfigScope => s !== 'managed';

export const runConfigList = async (input: RunConfigListInput): Promise<RunConfigListResult> => {
  const loader = input.loadConfig ?? ((env: ScanEnv) => loadConfig(env));
  const r = await loader(input.env);
  if (!r.ok) return { ok: false, error: r.error };
  const eff = r.value;

  if (input.scope && !isConfigScope(input.scope)) {
    return {
      ok: false,
      error: {
        code: 'config-error',
        message: `scope '${input.scope}' has no SkillSmith config layer (try user|project|system)`,
      },
    };
  }

  if (input.json) {
    if (input.scope) {
      return { ok: true, output: JSON.stringify(eff.layers[input.scope], null, 2) };
    }
    return {
      ok: true,
      output: JSON.stringify(
        { effective: eff.value, sources: eff.sources, layers: eff.layers },
        null,
        2,
      ),
    };
  }

  const lines: string[] = [];
  if (input.scope) {
    const layer = eff.layers[input.scope];
    for (const key of CONFIG_KEYS) {
      const v = getConfigValue(layer, key);
      if (v !== undefined) lines.push(`${key} = ${JSON.stringify(v)}`);
    }
  } else {
    for (const key of CONFIG_KEYS) {
      const source = eff.sources[key];
      if (!source) continue;
      const v = getConfigValue(eff.layers[source], key);
      if (v !== undefined) lines.push(`${key} = ${JSON.stringify(v)}    # source: ${source}`);
    }
  }
  return { ok: true, output: `${lines.join('\n')}\n` };
};
