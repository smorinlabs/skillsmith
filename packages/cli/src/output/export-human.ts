import type { ExportReport } from '@skillsmith/core';

export const renderExportHuman = (report: ExportReport): string => {
  const lines: string[] = [];
  if (report.artifactSelection.outcome === 'refused') {
    lines.push(`export refused: ${report.artifactSelection.reason}`);
  } else if (report.artifactSelection.outcome === 'selected') {
    lines.push(
      `${report.dryRun ? 'would export' : report.summary.changed > 0 ? 'exported' : 'unchanged'} ${report.artifactSelection.manifestPath} + ${report.artifactSelection.lockPath}`,
    );
  } else {
    lines.push(`export: ${report.artifactSelection.reason}`);
  }
  for (const result of report.results) {
    lines.push(
      result.action === 'skipped'
        ? `skip ${result.name}: ${result.reason}`
        : result.action === 'conflict'
          ? `conflict ${result.name}: ${result.reason}`
          : `${result.action} ${result.name} (${result.tools.join(', ')})`,
    );
  }
  return `${lines.join('\n')}\n`;
};
