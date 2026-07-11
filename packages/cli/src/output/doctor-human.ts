import type { CheckRunResult, Severity } from '@skillsmith/core';

const MARKER: Record<Severity, string> = { error: '✗', warning: '⚠', info: 'ℹ' };

export const renderDoctorHuman = (r: CheckRunResult): string => {
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
  const total = r.findings.length;
  lines.push(`\n${total} checks reported, ${r.counts.warning} warnings, ${r.counts.error} failed.`);
  return `${lines.join('\n')}\n`;
};
