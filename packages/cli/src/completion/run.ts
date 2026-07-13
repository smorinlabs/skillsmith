import type { Command } from 'commander';
import { renderBash } from './bash.ts';
import { renderFish } from './fish.ts';
import { walk } from './walk.ts';
import { renderZsh } from './zsh.ts';

export type Shell = 'bash' | 'zsh' | 'fish';

export const runCompletion = (program: Command, shell: Shell): string => {
  const nodes = walk(program);
  if (shell === 'bash') return renderBash(nodes);
  if (shell === 'zsh') return renderZsh(nodes);
  return renderFish(nodes);
};
