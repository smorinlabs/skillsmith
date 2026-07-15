import type { SkillSmithError } from '@skillsmith/core';

/** Complete semantic CLI exit-code taxonomy. */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 130;

/**
 * Select one semantic outcome for a command or batch.
 *
 * Cancellation wins over completed work. Actual errors (1-6) beat drift (7),
 * and retain the established deterministic numeric precedence among errors.
 */
export const selectExitCode = (codes: readonly ExitCode[]): ExitCode => {
  if (codes.includes(130)) return 130;

  let error: ExitCode = 0;
  for (const code of codes) {
    if (code >= 1 && code <= 6 && code > error) error = code;
  }
  if (error !== 0) return error;
  return codes.includes(7) ? 7 : 0;
};

export const exitCodeForError = (e: SkillSmithError): ExitCode => {
  switch (e.code) {
    case 'generic':
      return 1;
    case 'invalid-argument':
      return 2;
    case 'unknown-tool':
      return 2;
    case 'config-error':
      return 3;
    case 'skill-parse-error':
      return 1;
    case 'flip-failed':
      return 1;
    case 'flip-refused':
      return 2;
    case 'ledger-error':
      return 3;
    case 'placement-not-found':
      return 4;
    case 'source-unresolvable':
      return 5;
    case 'permission-denied':
      return 6;
    case 'tool-unavailable':
      return 4;
    case 'cancelled':
      return 130;
  }
};
