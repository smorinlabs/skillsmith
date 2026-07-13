import type { Command } from 'commander';
import { renderBash } from '../../completion/bash.ts';
import { renderFish } from '../../completion/fish.ts';
import { walk } from '../../completion/walk.ts';
import { renderZsh } from '../../completion/zsh.ts';

export type Shell = 'bash' | 'zsh' | 'fish';

export const runCompletion = (program: Command, shell: Shell): string => {
  const nodes = walk(program);
  switch (shell) {
    case 'bash':
      return renderBash(nodes);
    case 'zsh':
      return renderZsh(nodes);
    case 'fish':
      return renderFish(nodes);
  }
};
