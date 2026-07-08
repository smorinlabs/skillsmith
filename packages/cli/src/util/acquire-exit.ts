import type { InstallReport, UninstallReport } from '@skillsmith/core';
import { exitCodeForError } from './exit-codes.ts';

/** Batch exit code = highest per-result code (Global Constraint 8), install or uninstall. A
 *  result without a core-only `error` (i.e. a success bucket) contributes 0. */
export const acquireExitCode = (report: InstallReport | UninstallReport): number =>
  report.results.reduce((mx, r) => Math.max(mx, r.error ? exitCodeForError(r.error) : 0), 0);
