import type { Command } from 'commander';
import { generateCompletionScript } from './adapter.ts';

export type Shell = 'bash' | 'zsh' | 'fish';

export const runCompletion = (_program: Command, shell: Shell): string =>
  generateCompletionScript(shell);
