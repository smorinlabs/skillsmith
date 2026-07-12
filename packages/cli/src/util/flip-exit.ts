import type { FlipReport } from '@skillsmith/core';
import { type ExitCode, exitCodeForError, selectExitCode } from './exit-codes.ts';

/** Semantic flip-batch exit. A success result contributes 0; the shared selector owns actual-error,
 * drift, and cancellation precedence. */
export const flipExitCode = (report: FlipReport): ExitCode =>
  selectExitCode(report.results.map((r) => (r.error ? exitCodeForError(r.error) : 0)));
