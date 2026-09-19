import type { InitReport } from '@skillsmith/core';

export const renderInitHuman = (report: InitReport): string => {
  const before =
    report.result.before.state === 'absent'
      ? 'absent'
      : `${report.result.before.shape}; bytes ${report.result.before.byteHash}; semantics ${report.result.before.semanticHash ?? 'none'}`;
  const after =
    report.result.after === null
      ? 'unchanged'
      : `canonical; bytes ${report.result.after.byteHash}; semantics ${report.result.after.semanticHash}`;
  const forceTarget =
    report.force.target !== null &&
    'location' in report.force.target &&
    report.force.target.location.kind === 'machine-bound'
      ? report.force.target.location.path
      : 'unavailable';
  const force =
    report.force.conflictType === null
      ? `requested ${report.force.requested ? 'yes' : 'no'}; applied no; conflict none; backup none`
      : `requested yes; applied ${report.force.applied ? 'yes' : 'no'}; conflict ${report.force.conflictType}; target ${forceTarget}; normal ${report.force.normalBehavior}; forced ${report.force.forcedBehavior}; backup ${report.force.backup}`;
  return [
    `Init: ${report.result.action} (${report.effects[0].outcome})`,
    `Manifest: ${report.artifactSelection.manifestPath}`,
    `Lock: ${report.artifactSelection.lockPath} (not written)`,
    `Before: ${before}`,
    `After: ${after}`,
    `Force: ${force}`,
    '',
  ].join('\n');
};
