import { toolRegistry } from '../agents/registry.ts';
import type {
  ExecutableOperation,
  OperationScope,
  PlanCheck,
  PlanningDiagnostic,
  PlanningToolContext,
} from './types.ts';
import { EXECUTABLE_OPERATION_KINDS } from './vocabulary.ts';

export const comparePlanningText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

type ToolOrderContext<ToolId extends string = string> = Pick<
  PlanningToolContext<ToolId>,
  'toolOrder'
>;

const planningContextFail = (message: string): never => {
  throw new TypeError(`operation planning: ${message}`);
};

const builtInPlanningToolContext = (registry = toolRegistry): PlanningToolContext<string> =>
  Object.freeze({
    registry,
    toolOrder: registry.ids,
  });

const validatePlanningToolContext = (context: unknown): PlanningToolContext<string> => {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return planningContextFail('$planningContext must be an object');
  }
  const candidate = context as Partial<PlanningToolContext<string>>;
  if (!Array.isArray(candidate.toolOrder)) {
    return planningContextFail('$planningContext.toolOrder must be an array');
  }
  if (
    candidate.registry === null ||
    typeof candidate.registry !== 'object' ||
    typeof candidate.registry.get !== 'function'
  ) {
    return planningContextFail('$planningContext.registry must provide get');
  }
  const orderedTools = [...candidate.toolOrder];
  if (new Set(orderedTools).size !== orderedTools.length) {
    return planningContextFail('$planningContext.toolOrder contains duplicate values');
  }
  for (const [index, tool] of orderedTools.entries()) {
    if (typeof tool !== 'string' || tool.length === 0) {
      return planningContextFail(`$planningContext.toolOrder[${index}] must be a non-empty string`);
    }
    if (candidate.registry.get(tool)?.descriptor.id !== tool) {
      return planningContextFail(`$planningContext.toolOrder[${index}] is not registered`);
    }
  }
  return context as PlanningToolContext<string>;
};

export function resolvePlanningToolContext(): PlanningToolContext;
export function resolvePlanningToolContext<ToolId extends string>(
  context: PlanningToolContext<ToolId>,
): PlanningToolContext<ToolId>;
export function resolvePlanningToolContext<ToolId extends string>(
  context: PlanningToolContext<ToolId> | undefined,
): PlanningToolContext<ToolId>;
export function resolvePlanningToolContext(context?: unknown): PlanningToolContext<string> {
  return validatePlanningToolContext(context ?? builtInPlanningToolContext());
}

const builtInToolOrder = (registry = toolRegistry): ToolOrderContext => ({
  toolOrder: registry.ids,
});
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
  ['write-manifest', 2],
  ['write-lock', 3],
]);

const rank = (value: string | null, order: ReadonlyMap<string, number>): number =>
  value === null ? Number.MAX_SAFE_INTEGER : (order.get(value) ?? Number.MAX_SAFE_INTEGER - 1);

const toolRank = (context: ToolOrderContext): ReadonlyMap<string, number> =>
  new Map(context.toolOrder.map((tool, index) => [tool, index]));

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

export const compareExecutableOperations = <ToolId extends string = string>(
  left: ExecutableOperation<ToolId>,
  right: ExecutableOperation<ToolId>,
  context?: ToolOrderContext<ToolId>,
): number => {
  const order = toolRank(context ?? builtInToolOrder());
  return (
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
    rank(left.tool, order) - rank(right.tool, order) ||
    comparePlanningText(left.tool ?? '', right.tool ?? '') ||
    comparePlanningText(left.pairId ?? '', right.pairId ?? '') ||
    rank(left.kind, operationKindOrder) - rank(right.kind, operationKindOrder) ||
    comparePlanningText(left.operationId, right.operationId)
  );
};

/** Deterministic Kahn ordering: dependencies decide readiness, the canonical comparator breaks ties. */
export const orderExecutableOperationsTopologically = <ToolId extends string = string>(
  operations: readonly ExecutableOperation<ToolId>[],
  context?: ToolOrderContext<ToolId>,
): ExecutableOperation<ToolId>[] => {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  if (byId.size !== operations.length) planningContextFail('operation IDs must be unique');
  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, ExecutableOperation<ToolId>[]>();
  for (const operation of operations) {
    const dependencies = operation.dependencyMetadata.operationIds;
    remainingDependencies.set(operation.operationId, dependencies.length);
    for (const dependencyId of dependencies) {
      if (dependencyId === operation.operationId) {
        planningContextFail(`operation ${operation.operationId} has a self dependency`);
      }
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) {
        planningContextFail(`operation ${operation.operationId} has a dangling dependency`);
      }
      if ((dependency as ExecutableOperation<ToolId>).groupId !== operation.groupId) {
        planningContextFail(`operation ${operation.operationId} has a cross-group dependency`);
      }
      const current = dependents.get(dependencyId) ?? [];
      current.push(operation);
      dependents.set(dependencyId, current);
    }
  }
  const ordered: ExecutableOperation<ToolId>[] = [];
  const groups = new Map<string, ExecutableOperation<ToolId>[]>();
  for (const operation of operations) {
    const group = groups.get(operation.groupId) ?? [];
    group.push(operation);
    groups.set(operation.groupId, group);
  }
  const canonicalGroups = [...groups.values()]
    .map((operationsInGroup) => ({
      operations: operationsInGroup,
      representative: [...operationsInGroup].sort((left, right) =>
        compareExecutableOperations(left, right, context),
      )[0] as ExecutableOperation<ToolId>,
    }))
    .sort((left, right) =>
      compareExecutableOperations(left.representative, right.representative, context),
    );
  for (const { operations: group } of canonicalGroups) {
    const ready = group.filter(
      (operation) => remainingDependencies.get(operation.operationId) === 0,
    );
    const groupStart = ordered.length;
    while (ready.length > 0) {
      ready.sort((left, right) => compareExecutableOperations(left, right, context));
      const operation = ready.shift() as ExecutableOperation<ToolId>;
      ordered.push(operation);
      for (const dependent of dependents.get(operation.operationId) ?? []) {
        const remaining = (remainingDependencies.get(dependent.operationId) as number) - 1;
        remainingDependencies.set(dependent.operationId, remaining);
        if (remaining === 0) ready.push(dependent);
      }
    }
    if (ordered.length - groupStart !== group.length) {
      planningContextFail('operation dependencies are cyclic');
    }
  }
  return ordered;
};

export const comparePlanChecks = <ToolId extends string = string>(
  operationIndex: ReadonlyMap<string, number>,
  left: PlanCheck<ToolId>,
  right: PlanCheck<ToolId>,
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

export const comparePlanningDiagnostics = <ToolId extends string = string>(
  left: PlanningDiagnostic<ToolId>,
  right: PlanningDiagnostic<ToolId>,
  context?: ToolOrderContext<ToolId>,
): number => {
  const order = toolRank(context ?? builtInToolOrder());
  return (
    rank(left.affected.scope, scopeOrder) - rank(right.affected.scope, scopeOrder) ||
    comparePlanningText(left.affected.skill ?? '', right.affected.skill ?? '') ||
    rank(left.affected.tool, order) - rank(right.affected.tool, order) ||
    comparePlanningText(left.affected.tool ?? '', right.affected.tool ?? '') ||
    comparePlanningText(left.correlation.groupId ?? '', right.correlation.groupId ?? '') ||
    comparePlanningText(left.correlation.pairId ?? '', right.correlation.pairId ?? '') ||
    comparePlanningText(left.correlation.operationId ?? '', right.correlation.operationId ?? '') ||
    comparePlanningText(left.diagnosticId, right.diagnosticId)
  );
};

export const sortPlanningStrings = (values: readonly string[]): string[] =>
  [...values].sort(comparePlanningText);

export const sortPlanningTools = (
  values: readonly string[],
  context: ToolOrderContext = builtInToolOrder(),
): string[] => {
  const order = toolRank(context);
  return [...values].sort(
    (left, right) => rank(left, order) - rank(right, order) || comparePlanningText(left, right),
  );
};

export const sortPlanningScopes = (values: readonly string[]): string[] =>
  [...values].sort(
    (left, right) =>
      rank(left, scopeOrder) - rank(right, scopeOrder) || comparePlanningText(left, right),
  );
