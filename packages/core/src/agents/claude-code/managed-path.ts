import { join } from 'node:path';
import type { Platform } from '../../env/types.ts';
import type { ResolvedRuntimeConfiguration } from '../../ports/types.ts';

const MANAGED_BASE: Record<Platform, string> = {
  darwin: '/Library/Application Support/ClaudeCode',
  linux: '/etc/claude-code',
  win32: 'C:\\Program Files\\ClaudeCode',
};

export const getManagedSkillsDir = (
  platform: Platform,
  configuration: ResolvedRuntimeConfiguration,
): string => {
  const base = configuration.claudeManagedSettingsPath ?? MANAGED_BASE[platform];
  return join(base, '.claude', 'skills');
};

export const isManagedSkillsDisabled = (configuration: ResolvedRuntimeConfiguration): boolean =>
  configuration.claudePolicySkillsDisabled;
