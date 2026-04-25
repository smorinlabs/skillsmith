import type { Agent } from '../types.ts';
import { getCommandRoots } from './command-roots.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';

export const codexAgent: Agent = {
  tool: 'codex',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
};
