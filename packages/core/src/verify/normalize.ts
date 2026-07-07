import type {
  ModeResult,
  SummaryVerdict,
  ToolVerdict,
  VerifyFinding,
  VerifyOutcome,
  VerifyReport,
} from './types.ts';

const OUTCOME_RANK: Record<VerifyOutcome, number> = { pass: 0, warn: 1, fail: 2 };

export const worstOutcome = (outcomes: readonly VerifyOutcome[]): VerifyOutcome =>
  outcomes.reduce<VerifyOutcome>(
    (worst, o) => (OUTCOME_RANK[o] > OUTCOME_RANK[worst] ? o : worst),
    'pass',
  );

export const modeVerdictFor = (
  findings: readonly VerifyFinding[],
  strict: boolean,
): VerifyOutcome => {
  if (findings.some((f) => f.normalizedSeverity === 'error')) return 'fail';
  if (findings.some((f) => f.normalizedSeverity === 'warning')) return strict ? 'fail' : 'warn';
  return 'pass';
};

export const toolVerdictFor = (modes: readonly ModeResult[]): SummaryVerdict => {
  const ran = modes.filter((m) => m.status === 'ran');
  if (ran.length === 0) return 'inconclusive';
  return worstOutcome(ran.map((m) => m.verdict ?? 'pass'));
};

const tally = (findings: readonly VerifyFinding[]): VerifyReport['summary']['counts'] => {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.normalizedSeverity]++;
  return counts;
};

export const summarize = (tools: readonly ToolVerdict[]): VerifyReport['summary'] => {
  const verified: ToolVerdict['tool'][] = [];
  const failed: ToolVerdict['tool'][] = [];
  const skipped: ToolVerdict['tool'][] = [];
  const allFindings: VerifyFinding[] = [];
  const produced: VerifyOutcome[] = [];

  for (const t of tools) {
    for (const m of t.modes) allFindings.push(...m.findings);
    if (t.verdict === 'fail') {
      failed.push(t.tool);
      produced.push('fail');
    } else if (t.verdict === 'pass' || t.verdict === 'warn') {
      verified.push(t.tool);
      produced.push(t.verdict);
    } else {
      skipped.push(t.tool);
    }
  }

  return {
    verdict: produced.length > 0 ? worstOutcome(produced) : 'inconclusive',
    verified,
    failed,
    skipped,
    counts: tally(allFindings),
  };
};

export const extractVersionToken = (raw: string): string | null => {
  const m = raw.match(/\d+\.\d+\.\d+\S*/);
  return m ? m[0] : null;
};
