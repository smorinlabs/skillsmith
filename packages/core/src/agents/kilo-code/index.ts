import type { Agent } from '../types.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';

export const kiloCodeAgent: Agent = {
  tool: 'kilo-code',
  installHint,
  detect,
};
