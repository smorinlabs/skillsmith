#!/usr/bin/env bun
import { normalizeCliError, renderCliError } from './output/error-boundary.ts';
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
  (code) => process.exit(code),
  (e) => {
    const error = normalizeCliError(e);
    process.stderr.write(renderCliError(error, 'human'));
    process.exit(error.exitCode);
  },
);
