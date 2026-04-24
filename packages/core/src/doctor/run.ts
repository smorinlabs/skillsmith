import { type SkillSmithError, errorMessage, genericError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import type { Check, CheckRunContext, CheckRunResult, Finding } from './types.ts';

const tally = (findings: readonly Finding[]): CheckRunResult['counts'] => {
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const f of findings) {
    if (f.severity === 'error') counts.error++;
    else if (f.severity === 'warning') counts.warning++;
    else counts.ok++;
  }
  return counts;
};

export const runChecks = async (
  registry: readonly Check[],
  ctx: CheckRunContext,
): Promise<Result<CheckRunResult, SkillSmithError>> => {
  const applicable = registry.filter((c) => c.runsIn.includes(ctx.mode));
  const findings: Finding[] = [];
  for (const check of applicable) {
    if (ctx.signal?.aborted) return err(genericError('runChecks aborted'));
    try {
      findings.push(...(await check.run(ctx)));
    } catch (e) {
      findings.push({
        checkId: check.id,
        severity: 'error',
        title: `check '${check.id}' threw`,
        message: errorMessage(e),
      });
    }
  }
  return ok({ findings, counts: tally(findings) });
};
