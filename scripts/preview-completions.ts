#!/usr/bin/env bun
import { type Shell, runCompletion } from '../packages/cli/src/commands/completion.ts';
import { buildProgram } from '../packages/cli/src/program.ts';

const shells: Shell[] = ['bash', 'zsh', 'fish'];
const program = buildProgram();
for (const shell of shells) {
  process.stdout.write(`=== ${shell} ===\n`);
  process.stdout.write(runCompletion(program, shell));
  process.stdout.write('\n');
}
