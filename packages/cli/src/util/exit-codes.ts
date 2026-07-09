import type { SkillSmithError } from '@skillsmith/core';

export const exitCodeForError = (e: SkillSmithError): number => {
  switch (e.code) {
    case 'generic':
      return 1;
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
  }
};
