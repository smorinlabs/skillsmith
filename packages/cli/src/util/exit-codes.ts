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
  }
};
