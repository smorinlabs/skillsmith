import { inspect } from 'node:util';
import { type GcReportV1Dto, gcV1Codec } from '@skillsmith/core/contracts/v1';

const fact = (value: unknown): string =>
  inspect(value, {
    breakLength: Number.POSITIVE_INFINITY,
    compact: true,
    depth: null,
    sorted: true,
  });

/** Human projection of the same privacy-bounded gc@1 facts used by JSON. */
export const renderGcHuman = (report: GcReportV1Dto): string => {
  const validated = gcV1Codec.validate(report);
  if (!validated.ok) throw new Error(validated.error.message);
  const value = validated.value;
  const lines = [
    `GC: ${value.mode} (${value.state})`,
    `Project: cwd=${value.project.effectiveCwd}; root=${value.project.root}; identity=${value.project.identity}`,
    `Plan: ${value.planId ?? '(none)'}; approval=${value.approval.outcome}; recovery=${value.recovery.state}`,
    ...value.projects.map((project) => `project: ${fact(project)}`),
    ...value.objects.map((object) => `object: ${fact(object)}`),
    ...value.actions.map((action) => `action: ${fact(action)}`),
    ...value.results.map((result) => `result: ${fact(result)}`),
    ...value.diagnostics.map((diagnostic) => `diagnostic: ${fact(diagnostic)}`),
    `Summary: ${value.summary.observedItems} observed, ${value.summary.protectedItems} protected, ${value.summary.ageFilteredItems} age-filtered, ${value.summary.eligibleItems ?? 'unknown'} eligible, ${value.summary.alreadyAbsentItems} already-absent, ${value.summary.reclaimedItems} reclaimed, ${value.summary.forgottenProjects} forgotten`,
    `Summary exact: ${fact(value.summary)}`,
  ];
  return `${lines.join('\n')}\n`;
};
