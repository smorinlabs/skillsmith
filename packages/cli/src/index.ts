#!/usr/bin/env bun
import { errorMessage } from '@skillsmith/core';
import { buildProgram } from './program.ts';
import { installSigintHandler } from './util/signals.ts';

const main = async (): Promise<number> => {
  const controller = new AbortController();
  const sigint = installSigintHandler(controller);

  try {
    const args = process.argv.slice(2);
    const program = buildProgram(controller.signal);
    if (args.length === 0) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync(process.argv);
    return sigint.wasInterrupted() ? 130 : 0;
  } finally {
    sigint.uninstall();
  }
};

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`fatal: ${errorMessage(e)}\n`);
    process.exit(1);
  },
);
