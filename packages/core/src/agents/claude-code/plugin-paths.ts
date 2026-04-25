import { join } from 'node:path';

export const getPluginSkillDir = (installPath: string): string | null =>
  join(installPath, 'skills');

export const getPluginCommandDir = (installPath: string): string | null =>
  join(installPath, 'commands');
