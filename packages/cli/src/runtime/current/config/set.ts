import {
  CONFIG_KEYS,
  type ConfigKey,
  type ScanEnv,
  type Scope,
  type SkillSmithError,
  listSupportedTools,
  saveConfig,
} from '@skillsmith/core';

export interface RunConfigSetInput {
  env: ScanEnv;
  key: string;
  value: string;
  scope?: Scope;
  cwd?: string;
}

export type RunConfigSetError =
  | SkillSmithError
  | { code: 'unknown-key'; key: string }
  | { code: 'invalid-value'; key: ConfigKey; value: string; allowed: readonly string[] };
export type RunConfigSetResult =
  | { ok: true; file: string }
  | { ok: false; error: RunConfigSetError };

const SCOPES = ['system', 'user', 'project'] as const;

const validate = (
  key: ConfigKey,
  value: string,
): { ok: true } | { ok: false; allowed: readonly string[] } => {
  if (key === 'tool') {
    const tools = listSupportedTools();
    if (!(tools as readonly string[]).includes(value)) return { ok: false, allowed: tools };
  }
  if (key === 'scope' && !(SCOPES as readonly string[]).includes(value)) {
    return { ok: false, allowed: SCOPES };
  }
  return { ok: true };
};

const patchFor = (key: ConfigKey, value: string) => {
  if (key === 'registry.default') return { registry: { default: value } };
  return { [key]: value };
};

export const runConfigSet = async (input: RunConfigSetInput): Promise<RunConfigSetResult> => {
  if (!(CONFIG_KEYS as readonly string[]).includes(input.key)) {
    return { ok: false, error: { code: 'unknown-key', key: input.key } };
  }
  const key = input.key as ConfigKey;
  const v = validate(key, input.value);
  if (!v.ok) {
    return {
      ok: false,
      error: { code: 'invalid-value', key, value: input.value, allowed: v.allowed },
    };
  }
  const scope = input.scope ?? 'user';
  const r = await saveConfig(input.env, {
    scope,
    patch: patchFor(key, input.value),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, file: r.value.file };
};
