#!/usr/bin/env bun
import { resolveCompletionRequest } from './completion/transport.ts';
import {
  cliErrorFormatFromArgv,
  normalizeCliError,
  renderCliError,
} from './output/error-boundary.ts';
import { buildProgram } from './program.ts';
import { createCompletionRuntimeContext } from './runtime/context.ts';
import { processRuntimeIo } from './runtime/io.ts';
import { presentHumanOutput, presentationPolicyFromArgv } from './runtime/presentation.ts';
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
    const invocation = process.argv.slice(2);
    const format = cliErrorFormatFromArgv(invocation);
    const error = normalizeCliError(e);
    const rendered = renderCliError(error, format);
    if (format === 'json') {
      process.stdout.write(rendered);
    } else {
      const output = presentHumanOutput(
        { stderr: rendered },
        presentationPolicyFromArgv(invocation, format, processRuntimeIo),
        'error',
      );
      process.stderr.write(output.stderr ?? rendered);
    }
    process.exitCode = error.exitCode;
  },
);
