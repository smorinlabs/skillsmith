import {
  CONFIG_KEYS,
  type Config,
  type ConfigKey,
  type ScanEnv,
  type Scope,
  type SkillSmithError,
  type SupportedTool,
  saveConfig,
} from '@skillsmith/core';

export interface RunConfigSetInput {
  env: ScanEnv;
  key: string;
  value: string;
  scope?: Scope;
  cwd?: string;
}

export type RunConfigSetError = SkillSmithError | { code: 'unknown-key'; key: string };
export type RunConfigSetResult =
  | { ok: true; file: string }
  | { ok: false; error: RunConfigSetError };

const patchFor = (key: ConfigKey, value: string): Partial<Config> => {
  switch (key) {
    case 'tool':
      return { tool: value as SupportedTool };
    case 'scope':
      return { scope: value as Scope };
    case 'path':
      return { path: value };
    case 'registry.default':
      return { registry: { default: value } };
  }
};

export const runConfigSet = async (input: RunConfigSetInput): Promise<RunConfigSetResult> => {
  if (!(CONFIG_KEYS as readonly string[]).includes(input.key)) {
    return { ok: false, error: { code: 'unknown-key', key: input.key } };
  }
  const key = input.key as ConfigKey;
  const scope = input.scope ?? 'user';
  const r = await saveConfig(input.env, {
    scope,
    patch: patchFor(key, input.value),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, file: r.value.file };
};
