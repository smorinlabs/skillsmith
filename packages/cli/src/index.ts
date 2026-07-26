#!/usr/bin/env bun
import { resolveCompletionRequest } from './completion/transport.ts';
import { normalizeCliError, renderCliError } from './output/error-boundary.ts';
import { buildProgram } from './program.ts';
import { createCompletionRuntimeContext } from './runtime/context.ts';
import { installSignalHandler } from './util/signals.ts';

const main = async (): Promise<number> => {
  const invocation = process.argv.slice(2);
  if (invocation[0] === 'complete' && invocation[1] === '--') {
    const context = await createCompletionRuntimeContext();
    process.stdout.write(await resolveCompletionRequest(invocation.slice(2), context));
    return 0;
  }

  const controller = new AbortController();
  const signals = installSignalHandler(controller);

  try {
    const program = buildProgram(controller.signal);
    await program.parseAsync(process.argv);
    return signals.exitCode() ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
  } finally {
    signals.uninstall();
  }
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    const error = normalizeCliError(e);
    process.stderr.write(renderCliError(error, 'human'));
    process.exitCode = error.exitCode;
  },
);
