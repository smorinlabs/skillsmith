#!/usr/bin/env bun
import { errorMessage } from '@skillsmith/core';
import { buildProgram } from './program.ts';
import { installSignalHandler } from './util/signals.ts';

const main = async (): Promise<number> => {
  const controller = new AbortController();
  const signals = installSignalHandler(controller);

  try {
    const args = process.argv.slice(2);
    const program = buildProgram(controller.signal);
    if (args.length === 0) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync(process.argv);
    return signals.exitCode() ?? 0;
  } finally {
    signals.uninstall();
  }
};

main().then(
  (code) => {
    // Let piped stdout/stderr drain before Bun exits (large list JSON, #46).
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`fatal: ${errorMessage(e)}\n`);
    process.exitCode = 1;
  },
);
