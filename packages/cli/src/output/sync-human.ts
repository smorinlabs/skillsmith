import { inspect } from 'node:util';
import { type SyncReportV1Dto, syncV1Codec } from '@skillsmith/core/contracts/v1';
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
  const validated = syncV1Codec.validate(report);
  if (!validated.ok) throw new Error(validated.error.message);
  const value = validated.value;
  const artifact =
    value.artifactPair === null
      ? 'Artifacts: not selected'
      : `Artifacts: ${value.artifactPair.manifestPath} + ${value.artifactPair.lockPath} (${value.artifactPair.lockSource}; ${value.artifactPair.selectionSource})`;
  const lines = [
    `Sync: ${value.mode} (${value.state})`,
    `From: ${value.endpoints.from.selectedInput} (${value.endpoints.from.kind}/${value.endpoints.from.scope}; project=${value.endpoints.from.projectRoot ?? '(none)'})`,
    `To: ${value.endpoints.to.selectedInput} (${value.endpoints.to.kind}/${value.endpoints.to.scope}; project=${value.endpoints.to.projectRoot ?? '(none)'})`,
    artifact,
    `Options: force=${value.options.force} delete=${value.options.delete} save=${value.options.save} dry-run=${value.options.dryRun} continue-on-error=${value.options.continueOnError}`,
    `Selection: ${value.selection.selectionSource}/${value.selection.selectionOutcome}; targets=${value.selection.targets.join(', ') || '(none)'}; tools=${value.selection.tools.join(', ') || '(none)'}; source=${value.selection.sourceMembers}; destination=${value.selection.destinationMembers}`,
    `Groups: ${value.selection.groupIds.join(', ') || '(none)'}`,
    ...value.operations.flatMap((operation) => [
      renderPlanOperationHuman(operation),
      `  exact: ${fact(operation)}`,
    ]),
    ...value.checks.map((check) => `check: ${fact(check)}`),
    ...value.diagnostics.map((diagnostic) => `diagnostic: ${fact(diagnostic)}`),
    `Approval: ${fact(value.approval)}`,
    ...value.groups.flatMap((group) => [
      `group: ${group.groupId} (${group.skill})`,
      ...group.pairs.map((pair) => `  pair: ${fact(pair)}`),
    ]),
    ...value.effects.map((effect) => `effect: ${fact(effect)}`),
    `Summary: ${value.summary.groups} groups, ${value.summary.pairs} pairs, ${value.summary.changed} changed, ${value.summary.unchanged} unchanged, ${value.summary.succeeded} succeeded, ${value.summary.failed} failed, ${value.summary.cancelled} cancelled, ${value.summary.skipped} skipped, ${value.summary.drift} drift, ${value.summary.refusals} refusals`,
    `Summary exact: ${fact(value.summary)}`,
  ];
  return `${lines.join('\n')}\n`;
};
