import { join } from 'node:path';
import type { Platform } from '../env/types.ts';
import type { InventoryReadPorts } from '../ports/types.ts';
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

const readEnabledPlugins = async (
  env: InventoryReadPorts,
  path: string,
): Promise<Record<string, boolean> | null> => {
  if (!(await env.fileExists(path))) return null;
  try {
    const text = await env.readText(path);
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && 'enabledPlugins' in parsed) {
      const ep = (parsed as { enabledPlugins?: unknown }).enabledPlugins;
      if (ep && typeof ep === 'object') return ep as Record<string, boolean>;
    }
  } catch {
    // malformed settings file → treat as no enablement data
  }
  return null;
};

export const resolveEnablement = async (
  env: InventoryReadPorts,
  installation: PluginInstallation,
): Promise<PluginEnablement> => {
  const path = settingsPathForInstallation(env, installation);
  if (!path) return { enabled: 'unset', source: 'none' };

  const ep = await readEnabledPlugins(env, path);
  if (ep === null) return { enabled: 'unset', source: 'none' };

  const value = ep[installation.id];
  if (value === true) return { enabled: 'on', source: installation.scope };
  if (value === false) return { enabled: 'off', source: installation.scope };
  return { enabled: 'unset', source: 'none' };
};
