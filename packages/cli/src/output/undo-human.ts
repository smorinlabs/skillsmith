import { inspect } from 'node:util';
import { type UndoReportV1Dto, undoV1Codec } from '@skillsmith/core/contracts/v1';
import { renderPlanOperationHuman } from './plan-human.ts';

const fact = (value: unknown): string =>
  inspect(value, {
    breakLength: Number.POSITIVE_INFINITY,
    compact: true,
    depth: null,
    sorted: true,
  });

/** Human projection of the same strict, privacy-bounded undo@1 fact model used by JSON. */
export const renderUndoHuman = (report: UndoReportV1Dto): string => {
  const validated = undoV1Codec.validate(report);
  if (!validated.ok) throw new Error(validated.error.message);
  const value = validated.value;
  const lines = [
    `Undo: ${value.mode} (${value.state})`,
    `Project: cwd=${value.project.effectiveCwd}; root=${value.project.root ?? '(none)'}; identity=${value.project.identity ?? '(none)'}`,
    `Selection: ${value.selection.source}/${value.selection.outcome}; all=${value.selection.all}; targets=${value.selection.targets.join(', ') || '(none)'}; tools=${value.selection.tools.join(', ') || '(none)'}; scopes=${value.selection.scopes.join(', ') || '(none)'}; batch=${value.selection.batchPolicy}`,
    `Groups: ${value.selection.groupIds.join(', ') || '(none)'}`,
    `Approval: ${fact(value.approval)}`,
    ...value.groups.map((group) => `group: ${fact(group)}`),
    ...value.operations.flatMap((operation) => [
      renderPlanOperationHuman(operation),
      `  exact: ${fact(operation)}`,
    ]),
    ...value.checks.map((check) => `check: ${fact(check)}`),
    ...value.results.map((result) => `result: ${fact(result)}`),
    ...value.effects.map((effect) => `effect: ${fact(effect)}`),
    ...value.diagnostics.map((diagnostic) => `diagnostic: ${fact(diagnostic)}`),
    `Summary: ${value.summary.selected} selected, ${value.summary.actionable} actionable, ${value.summary.alreadyReversed} already reversed, ${value.summary.planned} planned, ${value.summary.succeeded} succeeded, ${value.summary.failed} failed, ${value.summary.cancelled} cancelled, ${value.summary.skipped} skipped, ${value.summary.notRun} not run, ${value.summary.effects} effects, ${value.summary.refusals} refusals`,
    `Summary exact: ${fact(value.summary)}`,
  ];
  return `${lines.join('\n')}\n`;
};
