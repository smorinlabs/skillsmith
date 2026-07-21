import { inspect } from 'node:util';
import type { SyncReportV1Dto } from '@skillsmith/core/contracts/v1';
import { renderPlanOperationHuman } from './plan-human.ts';

const fact = (value: unknown): string =>
  inspect(value, {
    breakLength: Number.POSITIVE_INFINITY,
    compact: true,
    depth: null,
    sorted: true,
  });

/** Human projection of the same immutable sync@1 facts encoded by JSON output. */
export const renderSyncHuman = (report: SyncReportV1Dto): string => {
  const artifact =
    report.artifactPair === null
      ? 'Artifacts: not selected'
      : `Artifacts: ${report.artifactPair.manifestPath} + ${report.artifactPair.lockPath} (${report.artifactPair.lockSource}; ${report.artifactPair.selectionSource})`;
  const lines = [
    `Sync: ${report.mode} (${report.state})`,
    `From: ${report.endpoints.from.selectedInput} (${report.endpoints.from.kind}/${report.endpoints.from.scope}; project=${report.endpoints.from.projectRoot ?? '(none)'})`,
    `To: ${report.endpoints.to.selectedInput} (${report.endpoints.to.kind}/${report.endpoints.to.scope}; project=${report.endpoints.to.projectRoot ?? '(none)'})`,
    artifact,
    `Options: force=${report.options.force} delete=${report.options.delete} save=${report.options.save} dry-run=${report.options.dryRun} continue-on-error=${report.options.continueOnError}`,
    `Selection: ${report.selection.selectionSource}/${report.selection.selectionOutcome}; targets=${report.selection.targets.join(', ') || '(none)'}; tools=${report.selection.tools.join(', ') || '(none)'}; source=${report.selection.sourceMembers}; destination=${report.selection.destinationMembers}`,
    `Groups: ${report.selection.groupIds.join(', ') || '(none)'}`,
    ...report.operations.flatMap((operation) => [
      renderPlanOperationHuman(operation),
      `  exact: ${fact(operation)}`,
    ]),
    ...report.checks.map((check) => `check: ${fact(check)}`),
    ...report.diagnostics.map((diagnostic) => `diagnostic: ${fact(diagnostic)}`),
    `Approval: ${fact(report.approval)}`,
    ...report.groups.flatMap((group) => [
      `group: ${group.groupId} (${group.skill})`,
      ...group.pairs.map((pair) => `  pair: ${fact(pair)}`),
    ]),
    ...report.effects.map((effect) => `effect: ${fact(effect)}`),
    `Summary: ${report.summary.groups} groups, ${report.summary.pairs} pairs, ${report.summary.changed} changed, ${report.summary.unchanged} unchanged, ${report.summary.succeeded} succeeded, ${report.summary.failed} failed, ${report.summary.cancelled} cancelled, ${report.summary.skipped} skipped, ${report.summary.drift} drift, ${report.summary.refusals} refusals`,
    `Summary exact: ${fact(report.summary)}`,
  ];
  return `${lines.join('\n')}\n`;
};
