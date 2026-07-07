import type { VerifyFinding, VerifyReport } from '@skillsmith/core';

const SEVERITY_MARKER: Record<VerifyFinding['normalizedSeverity'], string> = {
  error: '✘',
  warning: '⚠',
  info: 'ℹ',
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const renderVerifyHuman = (report: VerifyReport, exitCode: number): string => {
  const lines: string[] = [];
  const modesStr = report.requested.modes.join(', ');
  const toolsStr = report.requested.tools.join(', ');
  lines.push(`Verifying ${report.target.path}  (mode: ${modesStr} · tools: ${toolsStr})`);
  lines.push('');

  for (const t of report.tools) {
    if (!t.available) {
      lines.push(`${t.tool}  not installed (skipped)`);
      lines.push('');
      continue;
    }

    lines.push(`${t.tool} ${t.toolVersion ?? 'unknown'}  verdict: ${t.verdict}`);
    for (const m of t.modes) {
      if (m.status !== 'ran') {
        lines.push(`  ${m.mode}  ${m.status}${m.skipReason ? ` (${m.skipReason})` : ''}`);
        continue;
      }

      const manifestMark = m.coverage.manifest ? '✓' : '—';
      const skillsMark = m.coverage.skills
        ? t.tool === 'claude-code' && m.mode === 'deep'
          ? '✓ (presence)'
          : '✓'
        : '—';
      const noFindings = m.findings.length === 0 ? '  (no findings)' : '';
      lines.push(`  ${m.mode}  manifest ${manifestMark}  skills ${skillsMark}${noFindings}`);

      for (const f of m.findings) {
        const fileSuffix = f.file ? `   ${f.file}` : '';
        lines.push(`    ${SEVERITY_MARKER[f.normalizedSeverity]} ${f.checkId}${fileSuffix}`);
        lines.push(`        ${f.message}`);
      }
    }
    lines.push('');
  }

  const { failed, verified, counts } = report.summary;
  const summaryLine =
    failed.length > 0
      ? `${failed.length} ${failed.length === 1 ? 'tool' : 'tools'} failed, ${verified.length} passed.  ` +
        `(${plural(counts.error, 'error')}, ${plural(counts.warning, 'warning')}, ${plural(counts.info, 'notice')})  ` +
        `Exit code: ${exitCode}`
      : `verified: ${verified.join(', ')}.  Exit code: ${exitCode}`;
  lines.push(summaryLine);

  return `${lines.join('\n')}\n`;
};
