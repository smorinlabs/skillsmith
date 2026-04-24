import { describe, expect, test } from 'bun:test';
import type { Command, Option } from 'commander';
import { buildProgram } from '../../src/program.ts';

// Heuristic: an option whose short description lists a pipe-separated enum
// must carry argChoices. Catches `.option('--fmt <x>', 'a | b')` regressions.
const ENUM_DESCRIPTION = /\b\w+\s*\|\s*\w+\b/;

const walk = (cmd: Command): { cmd: Command; opts: readonly Option[] }[] => [
  { cmd, opts: cmd.options },
  ...cmd.commands.flatMap(walk),
];

describe('commander declaration gate', () => {
  const program = buildProgram();

  test('every subcommand has a description', () => {
    for (const { cmd } of walk(program)) {
      if (cmd === program) continue;
      expect(cmd.description()).not.toBe('');
    }
  });

  test('every enum-looking option has argChoices', () => {
    for (const { cmd, opts } of walk(program)) {
      for (const opt of opts) {
        const desc = opt.description ?? '';
        if (!ENUM_DESCRIPTION.test(desc)) continue;
        expect(
          opt.argChoices,
          `${cmd.name()} ${opt.long} — description looks enum-shaped but no .choices() declared`,
        ).toBeDefined();
      }
    }
  });
});
