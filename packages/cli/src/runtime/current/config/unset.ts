import {
  CONFIG_KEYS,
  type ConfigKey,
  type ScanEnv,
  type Scope,
  type SkillSmithError,
  saveConfig,
} from '@skillsmith/core';

export interface RunConfigUnsetInput {
  env: ScanEnv;
  key: string;
  scope?: Scope;
  cwd?: string;
}

export type RunConfigUnsetError = SkillSmithError | { code: 'unknown-key'; key: string };
export type RunConfigUnsetResult =
  | { ok: true; file: string }
  | { ok: false; error: RunConfigUnsetError };

export const runConfigUnset = async (input: RunConfigUnsetInput): Promise<RunConfigUnsetResult> => {
  if (!(CONFIG_KEYS as readonly string[]).includes(input.key)) {
    return { ok: false, error: { code: 'unknown-key', key: input.key } };
  }
  const scope = input.scope ?? 'user';
  const r = await saveConfig(input.env, {
    scope,
    delete: [input.key as ConfigKey],
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, file: r.value.file };
};
