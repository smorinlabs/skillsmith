import { inspect } from 'node:util';
import type { ApplyReportV1Dto } from '@skillsmith/core/contracts/v1';
import { renderPlanOperationHuman } from './plan-human.ts';

const fact = (value: unknown): string =>
  inspect(value, {
    breakLength: Number.POSITIVE_INFINITY,
    compact: true,
    depth: null,
    sorted: true,
  });

/** Render the strict apply-report projection; execution does not have a separate output model. */
export const renderApplyHuman = (report: ApplyReportV1Dto): string => {
  const selectedArtifact =
    report.savedPlan === null
      ? `Manifest: ${report.artifactPair?.manifestPath ?? '(none)'}\nLock: ${report.artifactPair?.lockPath ?? '(none)'}`
      : `Saved plan: ${report.savedPlan.path} (${report.savedPlan.portability}; executor ${report.savedPlan.executorSchemaVersion}; hashes ${report.savedPlan.hashSchemaVersion})`;
  const lines = [
    `Apply: ${report.mode} (${report.state})`,
    selectedArtifact,
    `Project: ${report.project.root ?? '(none)'} [${report.project.identity ?? 'unidentified'}] cwd=${report.project.effectiveCwd}`,
    `Options: locked=${report.options.locked} prune=${report.options.prune} check=${report.options.check} dry-run=${report.options.dryRun} continue-on-error=${report.options.continueOnError}`,
    `Selection: ${report.selection.tools.join(', ') || '(none)'} / ${report.selection.scopes.join(', ') || '(none)'} (${report.selection.selectionSource}; ${report.selection.selectionOutcome})`,
    `Selected skills: ${report.selection.skills.join(', ') || '(none)'}`,
    ...report.operations.flatMap((operation) => [
      renderPlanOperationHuman(operation),
      `  exact: ${fact(operation)}`,
    ]),
    ...report.checks.map((check) => `check: ${fact(check)}`),
    ...report.diagnostics.map((diagnostic) => `diagnostic: ${fact(diagnostic)}`),
    `Approval: ${fact(report.approval)}`,
    `Validation: ${fact(report.validation)}`,
    ...report.results.map((result) => `result: ${fact(result)}`),
    `Summary: ${report.summary.operations} operations, ${report.summary.succeeded} succeeded, ${report.summary.failed} failed, ${report.summary.cancelled} cancelled, ${report.summary.rolledBack} rolled back, ${report.summary.skipped} skipped, ${report.summary.drift} drift, ${report.summary.refusals} refusals`,
    `Summary exact: ${fact(report.summary)}`,
  ];
  return `${lines.join('\n')}\n`;
};
