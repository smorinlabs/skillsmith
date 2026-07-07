import type { FlipReport } from '@skillsmith/core';
import { exitCodeForError } from './exit-codes.ts';

/** Batch exit code = highest per-pair code (Global Constraint 8). A result without a core-only
 *  `error` (i.e. a success bucket) contributes 0. */
export const flipExitCode = (report: FlipReport): number =>
  report.results.reduce((mx, r) => Math.max(mx, r.error ? exitCodeForError(r.error) : 0), 0);
