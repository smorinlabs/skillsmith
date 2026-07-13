import { type VerifyReport, verifyExitClass } from '@skillsmith/core';

export const verifyExitCode = (report: VerifyReport): 0 | 1 | 4 => {
  const exitClass = verifyExitClass(report);
  if (exitClass === 'failure') return 1;
  if (exitClass === 'capability') return 4;
  return 0;
};
