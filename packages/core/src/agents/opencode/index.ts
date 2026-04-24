import type { Agent } from '../types.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';

export const opencodeAgent: Agent = {
  tool: 'opencode',
  installHint,
  detect,
};
