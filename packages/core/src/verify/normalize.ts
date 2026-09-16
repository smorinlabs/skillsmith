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
  const produced = ran.flatMap((m) => (m.verdict === null ? [] : [m.verdict]));
  const worst = worstOutcome(produced);
  if (worst === 'fail') return 'fail';
  if (produced.length === 0 || produced.length !== modes.length) return 'inconclusive';
  return worst;
};

const tally = (findings: readonly VerifyFinding[]): VerifyReport['summary']['counts'] => {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.normalizedSeverity]++;
  return counts;
};

export const summarize = (
  tools: readonly ToolVerdict[],
  options: { explicitTools?: boolean } = {},
): VerifyReport['summary'] => {
  const verified: ToolVerdict['tool'][] = [];
  const failed: ToolVerdict['tool'][] = [];
  const skipped: ToolVerdict['tool'][] = [];
  const allFindings: VerifyFinding[] = [];
  const produced: VerifyOutcome[] = [];
  let incomplete = false;

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
      if (t.available || options.explicitTools) incomplete = true;
    }
  }

  const worst = worstOutcome(produced);
  return {
    verdict:
      worst === 'fail' ? 'fail' : incomplete || produced.length === 0 ? 'inconclusive' : worst,
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
