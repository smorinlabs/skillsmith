import type { VerifyReport } from '@skillsmith/core';

export const verifyExitCode = (report: VerifyReport): 0 | 1 | 4 => {
  if (report.summary.verdict === 'fail') return 1;
  const anyRan = report.tools.some((tool) => tool.modes.some((mode) => mode.status === 'ran'));
  if (!anyRan) return 4;
  if (report.requested.explicitTools && report.tools.some((tool) => !tool.available)) return 4;
  if (
    report.requested.modes.includes('deep') &&
    report.tools.some(
      (tool) =>
        tool.available && !tool.modes.some((mode) => mode.mode === 'deep' && mode.status === 'ran'),
    )
  )
    return 4;
  return 0;
};
