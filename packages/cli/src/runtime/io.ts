import type { ExitCode } from '../util/exit-codes.ts';

/** A deliberately small output capability owned by the CLI composition root. */
export interface CliOutputPort {
  write(value: string): void;
}

/** Process-facing effects used by the shared runtime and replaceable by focused tests. */
export interface CliRuntimeIo {
  readonly stdout: CliOutputPort;
  readonly stderr: CliOutputPort;
  exit(code: ExitCode): void;
}

export interface RenderedCommandOutput {
  readonly stdout?: string;
  readonly stderr?: string;
}

export const emitCommandOutput = (io: CliRuntimeIo, output: RenderedCommandOutput): void => {
  if (output.stderr !== undefined && output.stderr.length > 0) io.stderr.write(output.stderr);
  if (output.stdout !== undefined && output.stdout.length > 0) io.stdout.write(output.stdout);
};

/** The sole production process-stream adapter; command modules receive only CliRuntimeIo. */
export const processRuntimeIo: CliRuntimeIo = {
  stdout: { write: (value) => process.stdout.write(value) },
  stderr: { write: (value) => process.stderr.write(value) },
  exit: (code) => {
    process.exitCode = code;
  },
};
