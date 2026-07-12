import type { InstallReport, UninstallReport } from '@skillsmith/core';
import { type ExitCode, exitCodeForError, selectExitCode } from './exit-codes.ts';

/** Semantic batch exit for install/uninstall. A success result contributes 0; the shared selector
 * owns actual-error, drift, and cancellation precedence. */
export const acquireExitCode = (report: InstallReport | UninstallReport): ExitCode =>
  selectExitCode(report.results.map((r) => (r.error ? exitCodeForError(r.error) : 0)));
