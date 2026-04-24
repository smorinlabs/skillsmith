import type { Agent } from '../types.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { getSkillRoots } from './skill-roots.ts';

export const claudeCodeAgent: Agent = {
  tool: 'claude-code',
  installHint,
  detect,
  getSkillRoots,
};
