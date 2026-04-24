import type { SkillSmithError } from '@skillsmith/core';

export const exitCodeForError = (e: SkillSmithError): number => {
  switch (e.code) {
    case 'generic':
      return 1;
    case 'unknown-tool':
      return 2;
  }
};
