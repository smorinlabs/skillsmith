import { inspect } from 'node:util';
import type { PlanOperationV1Dto, PlanV1Dto } from '@skillsmith/core/contracts/v1';

type RenderablePlanOperation = Pick<PlanOperationV1Dto, 'kind'> &
  Partial<
    Pick<PlanOperationV1Dto, 'operationId' | 'skill' | 'tool' | 'scope' | 'before' | 'after'>
  >;

const imageKind = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  return kind !== undefined && 'value' in kind && typeof kind.value === 'string'
    ? kind.value
    : null;
};

const planFact = (value: unknown): string =>
  inspect(value, {
    breakLength: Number.POSITIVE_INFINITY,
    compact: true,
    depth: null,
    sorted: true,
  });

export const renderPlanOperationHuman = (operation: RenderablePlanOperation): string => {
  const identity = operation.operationId ?? 'synthetic';
  const subject = [operation.skill, operation.tool, operation.scope].filter(Boolean).join(' / ');
  const before = imageKind(operation.before);
  const after = imageKind(operation.after);
  const transition = before === null || after === null ? '' : ` ${before} -> ${after}`;
  return `${identity} ${operation.kind}${subject.length === 0 ? '' : ` ${subject}`}${transition}`;
};

export const renderPlanHuman = (report: PlanV1Dto): string => {
  const lines = [
    `Plan: ${report.artifactPair.manifestPath}`,
    `Lock: ${report.artifactPair.lockPath} (${report.artifactPair.lockSource}; ${report.artifactPair.selectionSource})`,
    `Project: ${report.project.root ?? '(none)'} [${report.project.identity ?? 'unidentified'}] cwd=${report.project.effectiveCwd}`,
    `Options: locked=${report.options.locked} prune=${report.options.prune} check=${report.options.check}`,
    `Selection: ${report.selection.tools.join(', ') || '(none)'} / ${report.selection.scopes.join(', ') || '(none)'} (${report.selection.selectionSource}; ${report.selection.selectionOutcome})`,
    `Selected skills: ${report.selection.skills.join(', ') || '(none)'}`,
    `Requested filters: tools=${report.selection.requestedTools.join(', ') || '(none)'} scope=${report.selection.requestedScope ?? '(none)'}`,
    ...report.operations.flatMap((operation) => [
      renderPlanOperationHuman(operation),
      `  exact: ${planFact({
        groupId: operation.groupId,
        pairId: operation.pairId,
        dependsOn: operation.dependsOn,
        source: operation.source,
        selectionSource: operation.selectionSource,
        before: operation.before,
        after: operation.after,
        preconditionIds: operation.preconditionIds,
        requiredCheckIds: operation.requiredCheckIds,
        reversibility: operation.reversibility,
        mutates: operation.mutates,
        conflict: operation.conflict,
        reason: operation.reason,
      })}`,
    ]),
    ...report.checks.map((check) => `check: ${planFact(check)}`),
    ...report.diagnostics.flatMap((diagnostic) => [
      `${diagnostic.kind}: ${diagnostic.reason.message} [${diagnostic.diagnosticId}]`,
      `  exact: ${planFact({
        severity: diagnostic.severity,
        refusalClass: diagnostic.refusalClass,
        affected: diagnostic.affected,
        correlation: diagnostic.correlation,
        reason: diagnostic.reason,
        selectionSource: diagnostic.selectionSource,
      })}`,
    ]),
    `Summary: ${report.summary.operations} operations, ${report.summary.checks} checks, ${report.summary.diagnostics} diagnostics, ${report.summary.drift} drift, ${report.summary.refusals} refusals`,
    `Summary kinds: ${planFact({ operationKinds: report.summary.operationKinds, checkKinds: report.summary.checkKinds, diagnosticKinds: report.summary.diagnosticKinds })}`,
    `Conclusion: ${report.state}${report.summary.drift > 0 ? ' with drift' : ' converged'} (${report.summary.refusals} refusals)`,
  ];
  if (report.savedOutput !== null) {
    lines.push(
      `Saved: ${report.savedOutput.path} (${report.savedOutput.disposition}, ${report.savedOutput.mode})`,
      `Saved receipt: ${planFact(report.savedOutput)}`,
    );
  }
  return `${lines.join('\n')}\n`;
};
