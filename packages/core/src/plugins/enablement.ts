import { join } from 'node:path';
import { z } from 'zod';
import type { Platform } from '../env/types.ts';
import { type SkillSmithError, configError, errorMessage } from '../errors.ts';
import { rethrowInventoryReadFailure, throwIfInventoryCancelled } from '../inventory-control.ts';
import type { InventoryReadPorts } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { PluginEnablement, PluginInstallation } from './types.ts';

const MANAGED_SETTINGS_PATH: Record<Platform, string> = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\ProgramData\\ClaudeCode\\managed-settings.json',
};

const settingsPathForInstallation = (
  env: InventoryReadPorts,
  inst: PluginInstallation,
): string | null => {
  switch (inst.scope) {
    case 'user':
      return join(env.homeDir, '.claude', 'settings.json');
    case 'project':
      return inst.projectPath ? join(inst.projectPath, '.claude', 'settings.json') : null;
    case 'local':
      return inst.projectPath ? join(inst.projectPath, '.claude', 'settings.local.json') : null;
    case 'managed':
      return MANAGED_SETTINGS_PATH[env.platform];
  }
};

const SettingsSchema = z
  .object({
    enabledPlugins: z.record(z.boolean()).optional(),
  })
  .passthrough();

const readEnabledPlugins = async (
  env: InventoryReadPorts,
  path: string,
  signal?: AbortSignal,
): Promise<Result<Record<string, boolean> | null, SkillSmithError>> => {
  throwIfInventoryCancelled(signal);
  const exists = await env
    .fileExists(path)
    .catch((failure: unknown) => rethrowInventoryReadFailure(failure, path));
  throwIfInventoryCancelled(signal);
  if (!exists) return ok(null);

  const text = await env.readText(path).catch((failure: unknown) => {
    throwIfInventoryCancelled(signal);
    return rethrowInventoryReadFailure(failure, path);
  });
  throwIfInventoryCancelled(signal);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (failure) {
    return err(
      configError(`plugin settings parse error: ${errorMessage(failure)}`, { file: path }),
    );
  }

  const validated = SettingsSchema.safeParse(parsed);
  if (!validated.success) {
    return err(
      configError(
        `plugin settings schema error: ${validated.error.issues[0]?.message ?? 'invalid'}`,
        { file: path },
      ),
    );
  }
  return ok(validated.data.enabledPlugins ?? null);
};

export const resolveEnablement = async (
  env: InventoryReadPorts,
  installation: PluginInstallation,
  signal?: AbortSignal,
): Promise<PluginEnablement> => {
  throwIfInventoryCancelled(signal);
  const path = settingsPathForInstallation(env, installation);
  if (!path) return { enabled: 'unset', source: 'none' };

  const read = await readEnabledPlugins(env, path, signal);
  throwIfInventoryCancelled(signal);
  if (!read.ok) throw read.error;
  const ep = read.value;
  if (ep === null) return { enabled: 'unset', source: 'none' };

  const value = ep[installation.id];
  if (value === true) return { enabled: 'on', source: installation.scope };
  if (value === false) return { enabled: 'off', source: installation.scope };
  return { enabled: 'unset', source: 'none' };
};
