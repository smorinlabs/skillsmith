import { SUPPORTED_TOOLS } from '../agents/registry.ts';
import type {
  ExecutableOperation,
  OperationScope,
  PlanCheck,
  PlanningDiagnostic,
} from './types.ts';
import { EXECUTABLE_OPERATION_KINDS } from './vocabulary.ts';

export const comparePlanningText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const toolOrder = new Map<string, number>(SUPPORTED_TOOLS.map((tool, index) => [tool, index]));
const scopeOrder = new Map<OperationScope, number>([
  ['user', 0],
  ['project', 1],
]);
const operationKindOrder = new Map<string, number>(
  EXECUTABLE_OPERATION_KINDS.map((kind, index) => [kind, index]),
);
const artifactPrerequisiteOrder = new Map<string, number>([
  ['migrate-ledger', 0],
  ['migrate-project-config', 1],
  ['write-lock', 2],
]);

const rank = (value: string | null, order: ReadonlyMap<string, number>): number =>
  value === null ? Number.MAX_SAFE_INTEGER : (order.get(value) ?? Number.MAX_SAFE_INTEGER - 1);

export const canonicalPlanningString = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPlanningString).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(comparePlanningText)
    .map((key) => `${JSON.stringify(key)}:${canonicalPlanningString(record[key])}`)
    .join(',')}}`;
};

export const compareExecutableOperations = (
  left: ExecutableOperation,
  right: ExecutableOperation,
): number =>
  Number(left.pairId !== null) - Number(right.pairId !== null) ||
  (left.pairId === null && right.pairId === null
    ? rank(left.kind, artifactPrerequisiteOrder) - rank(right.kind, artifactPrerequisiteOrder)
    : 0) ||
  rank(left.scope, scopeOrder) - rank(right.scope, scopeOrder) ||
  comparePlanningText(left.skill ?? '', right.skill ?? '') ||
  comparePlanningText(
    canonicalPlanningString(left.source),
    canonicalPlanningString(right.source),
  ) ||
  comparePlanningText(left.groupId, right.groupId) ||
  rank(left.tool, toolOrder) - rank(right.tool, toolOrder) ||
  comparePlanningText(left.pairId ?? '', right.pairId ?? '') ||
  rank(left.kind, operationKindOrder) - rank(right.kind, operationKindOrder) ||
  comparePlanningText(left.operationId, right.operationId);

export const comparePlanChecks = (
  operationIndex: ReadonlyMap<string, number>,
  left: PlanCheck,
  right: PlanCheck,
): number => {
  const leftIndex = Math.min(
    ...left.operationIds.map(
      (operationId) => operationIndex.get(operationId) ?? Number.POSITIVE_INFINITY,
    ),
  );
  const rightIndex = Math.min(
    ...right.operationIds.map(
      (operationId) => operationIndex.get(operationId) ?? Number.POSITIVE_INFINITY,
    ),
  );
  return leftIndex - rightIndex || comparePlanningText(left.checkId, right.checkId);
};

export const comparePlanningDiagnostics = (
  left: PlanningDiagnostic,
  right: PlanningDiagnostic,
): number =>
  rank(left.affected.scope, scopeOrder) - rank(right.affected.scope, scopeOrder) ||
  comparePlanningText(left.affected.skill ?? '', right.affected.skill ?? '') ||
  rank(left.affected.tool, toolOrder) - rank(right.affected.tool, toolOrder) ||
  comparePlanningText(left.correlation.groupId ?? '', right.correlation.groupId ?? '') ||
  comparePlanningText(left.correlation.pairId ?? '', right.correlation.pairId ?? '') ||
  comparePlanningText(left.correlation.operationId ?? '', right.correlation.operationId ?? '') ||
  comparePlanningText(left.diagnosticId, right.diagnosticId);

export const sortPlanningStrings = (values: readonly string[]): string[] =>
  [...values].sort(comparePlanningText);

export const sortPlanningTools = (values: readonly string[]): string[] =>
  [...values].sort(
    (left, right) =>
      rank(left, toolOrder) - rank(right, toolOrder) || comparePlanningText(left, right),
  );

export const sortPlanningScopes = (values: readonly string[]): string[] =>
  [...values].sort(
    (left, right) =>
      rank(left, scopeOrder) - rank(right, scopeOrder) || comparePlanningText(left, right),
  );
