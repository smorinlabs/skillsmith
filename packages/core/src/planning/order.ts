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

/**
 * Return the first invalid external dependency shape. The only admitted cross-group edge is one
 * earlier artifact-prefix write-lock named by every operation in the dependent group.
 */
const artifactPrefixDependencyErrorFor = <ToolId extends string = string>(
  groups: readonly (readonly ExecutableOperation<ToolId>[])[],
  validateCanonicalPosition: boolean,
): string | null => {
  const operations = groups.flat();
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  const groupPositions = new Map<string, number>();
  for (const [position, group] of groups.entries()) {
    const groupId = group[0]?.groupId;
    if (groupId === undefined || groupPositions.has(groupId)) {
      return 'operation groups are malformed';
    }
    groupPositions.set(groupId, position);
  }
  for (const group of groups) {
    const groupId = group[0]?.groupId;
    if (groupId === undefined || group.some((operation) => operation.groupId !== groupId)) {
      return 'operation groups are malformed';
    }
    const externalIds = new Set<string>();
    for (const operation of group) {
      for (const dependencyId of operation.dependencyMetadata.operationIds) {
        const dependency = byId.get(dependencyId);
        if (dependency === undefined) continue;
        if (dependency.groupId !== groupId) externalIds.add(dependencyId);
      }
    }
    if (externalIds.size === 0) continue;
    if (externalIds.size !== 1) {
      return `operation group ${groupId} has multiple cross-group dependencies`;
    }
    const [prefixId] = externalIds;
    const prefix = prefixId === undefined ? undefined : byId.get(prefixId);
    if (
      prefix === undefined ||
      prefix.groupId === groupId ||
      prefix.kind !== 'write-lock' ||
      prefix.pairId !== null
    ) {
      return `operation group ${groupId} has an invalid cross-group artifact-prefix dependency`;
    }
    if (
      validateCanonicalPosition &&
      (groupPositions.get(prefix.groupId) as number) >= (groupPositions.get(groupId) as number)
    ) {
      return `operation group ${groupId} depends on a later artifact prefix`;
    }
    if (prefix.after.kind !== 'lock') {
      return `operation group ${groupId} has an invalid cross-group artifact-prefix image`;
    }
    if (validateCanonicalPosition) {
      const groupPosition = groupPositions.get(groupId) as number;
      const prefixPosition = groupPositions.get(prefix.groupId) as number;
      const prefixLocation = canonicalPlanningString(prefix.after.location);
      let latestPrefixPosition = -1;
      for (const [position, candidateGroup] of groups.entries()) {
        if (position >= groupPosition) break;
        if (
          candidateGroup.some(
            (candidate) =>
              candidate.kind === 'write-lock' &&
              candidate.pairId === null &&
              candidate.after.kind === 'lock' &&
              canonicalPlanningString(candidate.after.location) === prefixLocation,
          )
        ) {
          latestPrefixPosition = position;
        }
      }
      if (prefixPosition !== latestPrefixPosition) {
        return `operation group ${groupId} does not depend on the latest artifact prefix`;
      }
    }
    const prefixGroup = groups.find((candidate) => candidate[0]?.groupId === prefix.groupId) ?? [];
    if (
      prefixGroup.filter(
        (operation) => operation.kind === 'write-lock' && operation.pairId === null,
      ).length !== 1 ||
      group.some(
        (operation) => !operation.dependencyMetadata.operationIds.includes(prefix.operationId),
      )
    ) {
      return `operation group ${groupId} does not fully depend on one artifact prefix`;
    }
  }
  return null;
};

export const artifactPrefixDependencyError = <ToolId extends string = string>(
  groups: readonly (readonly ExecutableOperation<ToolId>[])[],
): string | null => artifactPrefixDependencyErrorFor(groups, true);

/** Deterministic Kahn ordering: dependencies decide readiness, the canonical comparator breaks ties. */
export const orderExecutableOperationsTopologically = <ToolId extends string = string>(
  operations: readonly ExecutableOperation<ToolId>[],
  context?: ToolOrderContext<ToolId>,
): ExecutableOperation<ToolId>[] => {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  if (byId.size !== operations.length) planningContextFail('operation IDs must be unique');
  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, ExecutableOperation<ToolId>[]>();
  const groups = new Map<string, ExecutableOperation<ToolId>[]>();
  for (const operation of operations) {
    const group = groups.get(operation.groupId) ?? [];
    group.push(operation);
    groups.set(operation.groupId, group);
  }
  for (const operation of operations) {
    const dependencies = operation.dependencyMetadata.operationIds;
    let internalDependencies = 0;
    for (const dependencyId of dependencies) {
      if (dependencyId === operation.operationId) {
        planningContextFail(`operation ${operation.operationId} has a self dependency`);
      }
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) {
        planningContextFail(`operation ${operation.operationId} has a dangling dependency`);
      }
      if ((dependency as ExecutableOperation<ToolId>).groupId === operation.groupId) {
        internalDependencies += 1;
        const current = dependents.get(dependencyId) ?? [];
        current.push(operation);
        dependents.set(dependencyId, current);
      }
    }
    remainingDependencies.set(operation.operationId, internalDependencies);
  }
  const compareCanonicalGroups = (
    left: {
      readonly representative: ExecutableOperation<ToolId>;
    },
    right: {
      readonly representative: ExecutableOperation<ToolId>;
    },
  ): number => compareExecutableOperations(left.representative, right.representative, context);
  const canonicalGroups = [...groups.values()]
    .map((operationsInGroup) => ({
      operations: operationsInGroup,
      representative: [...operationsInGroup].sort((left, right) =>
        compareExecutableOperations(left, right, context),
      )[0] as ExecutableOperation<ToolId>,
    }))
    .sort(compareCanonicalGroups);
  const prefixShapeError = artifactPrefixDependencyErrorFor(
    canonicalGroups.map(({ operations: group }) => group),
    false,
  );
  if (prefixShapeError !== null) planningContextFail(prefixShapeError);
  const groupById = new Map(canonicalGroups.map((group) => [group.representative.groupId, group]));
  const remainingGroupDependencies = new Map(
    canonicalGroups.map(({ representative }) => [representative.groupId, 0]),
  );
  const dependentGroups = new Map<string, typeof canonicalGroups>();
  const externalPrefixIdByGroup = new Map<string, string>();
  for (const selected of canonicalGroups) {
    const external = selected.operations
      .flatMap((operation) => operation.dependencyMetadata.operationIds)
      .map((dependencyId) => byId.get(dependencyId))
      .find(
        (dependency) =>
          dependency !== undefined && dependency.groupId !== selected.representative.groupId,
      );
    if (external === undefined) continue;
    externalPrefixIdByGroup.set(selected.representative.groupId, external.operationId);
    remainingGroupDependencies.set(selected.representative.groupId, 1);
    const current = dependentGroups.get(external.groupId) ?? [];
    current.push(selected);
    dependentGroups.set(external.groupId, current);
  }
  const readyGroups = canonicalGroups.filter(
    ({ representative }) => remainingGroupDependencies.get(representative.groupId) === 0,
  );
  const ordered: ExecutableOperation<ToolId>[] = [];
  const orderedGroups: ExecutableOperation<ToolId>[][] = [];
  let orderedGroupCount = 0;
  while (readyGroups.length > 0) {
    readyGroups.sort(compareCanonicalGroups);
    // A later artifact writer must not leapfrog an earlier consumer of the same exact prefix.
    // Filter eligibility first so the semantic comparator remains globally transitive.
    const firstReadyGroupIdByPrefix = new Map<string, string>();
    for (const readyGroup of readyGroups) {
      const prefixId = externalPrefixIdByGroup.get(readyGroup.representative.groupId);
      if (prefixId === undefined) continue;
      const firstGroupId = firstReadyGroupIdByPrefix.get(prefixId);
      if (
        firstGroupId === undefined ||
        comparePlanningText(readyGroup.representative.groupId, firstGroupId) < 0
      ) {
        firstReadyGroupIdByPrefix.set(prefixId, readyGroup.representative.groupId);
      }
    }
    const selectedIndex = readyGroups.findIndex((readyGroup) => {
      const prefixId = externalPrefixIdByGroup.get(readyGroup.representative.groupId);
      return (
        prefixId === undefined ||
        firstReadyGroupIdByPrefix.get(prefixId) === readyGroup.representative.groupId
      );
    });
    if (selectedIndex < 0) planningContextFail('operation group ordering is invalid');
    const [selected] = readyGroups.splice(selectedIndex, 1) as [(typeof canonicalGroups)[number]];
    if (!groupById.has(selected.representative.groupId)) {
      planningContextFail('operation group ordering is invalid');
    }
    const group = selected.operations;
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
    orderedGroups.push(ordered.slice(groupStart));
    orderedGroupCount += 1;
    for (const dependent of dependentGroups.get(selected.representative.groupId) ?? []) {
      const remaining =
        (remainingGroupDependencies.get(dependent.representative.groupId) as number) - 1;
      remainingGroupDependencies.set(dependent.representative.groupId, remaining);
      if (remaining === 0) readyGroups.push(dependent);
    }
  }
  if (orderedGroupCount !== canonicalGroups.length) {
    planningContextFail('operation group dependencies are cyclic');
  }
  const prefixError = artifactPrefixDependencyError(orderedGroups);
  if (prefixError !== null) planningContextFail(prefixError);
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
