import { isPortError } from '../ports/errors.ts';
import { defaultScanEnv } from './default.ts';
import type { ExecOptions, ExecResult } from './types.ts';

/** @deprecated Process execution is composed through ProcessPort. */
export const runVersionCommand = async (
  binaryPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | 'unknown'> => (await defaultScanEnv()).runVersion(binaryPath, args, signal);

/** @deprecated Process execution is composed through ProcessPort. */
export const execCommand = async (
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> => {
  try {
    return await (await defaultScanEnv()).exec(command, args, options);
  } catch (error) {
    return {
      code: -1,
      stdout: '',
      stderr: isPortError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : 'process operation failed',
      timedOut: false,
    };
  }
};
