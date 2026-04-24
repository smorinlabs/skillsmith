import type { CheckRunResult, Severity } from '@skillsmith/core';

const MARKER: Record<Severity, string> = { error: '✗', warning: '⚠', info: 'ℹ' };

export const renderDoctorHuman = (r: CheckRunResult): string => {
  const lines: string[] = [];
  for (const f of r.findings) {
    const remed = f.remediation ? `\n    remediation: ${f.remediation}` : '';
    lines.push(`  ${MARKER[f.severity]} ${f.title}\n    ${f.message}${remed}`);
  }
  const total = r.findings.length;
  lines.push(`\n${total} checks reported, ${r.counts.warning} warnings, ${r.counts.error} failed.`);
  return `${lines.join('\n')}\n`;
};
