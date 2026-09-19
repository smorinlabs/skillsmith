import { inspect } from 'node:util';
import { type UpdateReportV1Dto, updateV1Codec } from '@skillsmith/core/contracts/v1';
import { renderPlanOperationHuman } from './plan-human.ts';

const fact = (value: unknown): string =>
  inspect(value, {
    breakLength: Number.POSITIVE_INFINITY,
    compact: true,
    depth: null,
    sorted: true,
  });

/** Human projection of the same strict, privacy-bounded update@1 fact model used by JSON. */
export const renderUpdateHuman = (report: UpdateReportV1Dto): string => {
  const validated = updateV1Codec.validate(report);
  if (!validated.ok) throw new Error(validated.error.message);
  const value = validated.value;
  const lines = [
    `Update: ${value.mode} (${value.state})`,
    `Artifacts: ${value.artifactPair.manifestPath} + ${value.artifactPair.lockPath} (${value.artifactPair.lockSource}; ${value.artifactPair.selectionSource})`,
    `Options: all=${value.options.all} ref=${value.options.ref ?? '(none)'} pin=${value.options.pin} strict=${value.options.strict} continue-on-error=${value.options.continueOnError}`,
    `Selection: ${value.selection.selectionSource}/${value.selection.selectionOutcome}; targets=${value.selection.targets.join(', ') || '(none)'}; skills=${value.selection.skills.join(', ') || '(none)'}; tools=${value.selection.tools.join(', ') || '(none)'}`,
    `Groups: ${value.selection.groupIds.join(', ') || '(none)'}`,
    ...value.candidates.map((candidate) => `candidate: ${fact(candidate)}`),
    ...value.operations.flatMap((operation) => [
      renderPlanOperationHuman(operation),
      `  exact: ${fact(operation)}`,
    ]),
    ...value.checks.map((check) => `check: ${fact(check)}`),
    ...value.diagnostics.map((diagnostic) => `diagnostic: ${fact(diagnostic)}`),
    `Approval: ${fact(value.approval)}`,
    ...value.groups.map((group) => `group: ${fact(group)}`),
    ...value.effects.map((effect) => `effect: ${fact(effect)}`),
    `Summary: ${value.summary.groups} groups, ${value.summary.candidates} candidates, ${value.summary.current} current, ${value.summary.available} available, ${value.summary.succeeded} succeeded, ${value.summary.failed} failed, ${value.summary.cancelled} cancelled, ${value.summary.skipped} skipped, ${value.summary.artifactDrift} artifact drift, ${value.summary.liveDrift} live drift, ${value.summary.refusals} refusals`,
    `Summary exact: ${fact(value.summary)}`,
  ];
  return `${lines.join('\n')}\n`;
};
