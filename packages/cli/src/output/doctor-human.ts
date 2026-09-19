import type { CheckRunResult, Severity } from '@skillsmith/core';

const MARKER: Record<Severity, string> = { error: '✗', warning: '⚠', info: 'ℹ' };

export const renderDoctorHuman = (r: CheckRunResult): string => {
  const doctor =
    'repair' in r
      ? (r as CheckRunResult & {
          readonly repair: Readonly<{
            readonly mode: 'not-requested' | 'preview' | 'execute';
            readonly operations: readonly Readonly<{
              readonly kind: string;
              readonly path: string;
            }>[];
            readonly results: readonly Readonly<{
              readonly operationId: string;
              readonly outcome: 'changed' | 'unchanged' | 'failed';
            }>[];
          }>;
        })
      : null;
  if (
    doctor !== null &&
    doctor.repair.mode === 'execute' &&
    doctor.repair.operations.length === 0 &&
    doctor.findings.length === 0
  ) {
    return 'No repairs needed\n';
  }
  const lines: string[] = [];
  for (const f of r.findings) {
    const context = [
      f.tool && f.scope ? `scope: ${f.tool}/${f.scope}` : null,
      f.path ? `path: ${f.path}` : null,
      f.operation ? `operation: ${f.operation}` : null,
      f.reason ? `reason: ${f.reason}` : null,
      f.scopeInUse === undefined ? null : `scope in use: ${f.scopeInUse ? 'yes' : 'no'}`,
      f.remediation ? `remediation: ${f.remediation}` : null,
    ].filter((line): line is string => line !== null);
    const details = context.length > 0 ? `\n    ${context.join('\n    ')}` : '';
    lines.push(`  ${MARKER[f.severity]} ${f.title}\n    ${f.message}${details}`);
  }
  if (doctor !== null && doctor.repair.operations.length > 0) {
    for (const operation of doctor.repair.operations) {
      lines.push(`  → ${operation.kind}: ${operation.path}`);
    }
    for (const result of doctor.repair.results) {
      lines.push(
        `  ${result.outcome === 'failed' ? '✗' : '✓'} ${result.outcome}: ${result.operationId}`,
      );
    }
  } else if (
    doctor !== null &&
    doctor.repair.mode !== 'not-requested' &&
    doctor.findings.length > 0
  ) {
    lines.push('No automatic repairs available');
  }
  const total = r.findings.length;
  lines.push(`\n${total} checks reported, ${r.counts.warning} warnings, ${r.counts.error} failed.`);
  return `${lines.join('\n')}\n`;
};
