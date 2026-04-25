import { join } from 'node:path';
import type { Platform } from '../../env/types.ts';

const MANAGED_BASE: Record<Platform, string> = {
  darwin: '/Library/Application Support/ClaudeCode',
  linux: '/etc/claude-code',
  win32: 'C:\\Program Files\\ClaudeCode',
};

export const getManagedSkillsDir = (
  platform: Platform,
  envVars: Record<string, string | undefined>,
): string => {
  const base = envVars.CLAUDE_CODE_MANAGED_SETTINGS_PATH ?? MANAGED_BASE[platform];
  return join(base, '.claude', 'skills');
};

export const isManagedSkillsDisabled = (envVars: Record<string, string | undefined>): boolean => {
  const v = envVars.CLAUDE_CODE_DISABLE_POLICY_SKILLS;
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
};
