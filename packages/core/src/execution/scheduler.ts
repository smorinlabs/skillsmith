import type { SupportedTool } from '../agents/types.ts';
import type { ObservationBundle } from '../observation/types.ts';
import { createOperationExecutionResult } from '../planning/create.ts';
import {
  artifactPrefixDependencyError,
  canonicalPlanningString,
  resolvePlanningToolContext,
} from '../planning/order.ts';
import type {
  CurrentMutatorCommand,
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
  PlanningToolContext,
} from '../planning/types.ts';
import {
  beginOperationObservation,
  completeOperationObservation,
  createPlannedOperationObservation,
  operationCompletionForResult,
  operationCompletionForThrown,
} from './observation.ts';
import type { ExecutionScheduleOptions, ValidatedExecutionBinding } from './types.ts';

export type ObservedValidatedExecutionBinding<ToolId extends string = SupportedTool> = Omit<
  ValidatedExecutionBinding<ToolId>,
  'execute'
> &
  Readonly<{
    execute: (observation?: ObservationBundle) => Promise<OperationExecutionResult<ToolId>>;
  }>;

const fail = (message: string): never => {
  throw new TypeError(`operation scheduler: ${message}`);
};

const exactBindingKeys = Object.freeze([
  'actualBefore',
  'execute',
  'groupId',
  'operationId',
  'pairId',
  'unstartedForce',
]);

const ARTIFACT_OPERATION_KINDS = Object.freeze([
  'migrate-ledger',
  'migrate-project-config',
  'write-manifest',
  'write-lock',
] as const);

type ArtifactPrerequisiteKind = (typeof ARTIFACT_OPERATION_KINDS)[number];

const isArtifactPrerequisiteKind = (kind: string): kind is ArtifactPrerequisiteKind =>
  ARTIFACT_OPERATION_KINDS.some((candidate) => candidate === kind);

const sameLocation = (left: unknown, right: unknown): boolean =>
  canonicalPlanningString(left) === canonicalPlanningString(right);

const validArtifactImages = (
  kind: ArtifactPrerequisiteKind,
  before: OperationImage<string>,
  after: OperationImage<string>,
): boolean => {
  if (kind === 'migrate-ledger') {
    return (
      before.kind === 'ledger' &&
      before.schemaVersion === 1 &&
      after.kind === 'ledger' &&
      after.schemaVersion === 2 &&
      sameLocation(before.projectRoot, after.projectRoot)
    );
  }
  if (kind === 'migrate-project-config') {
    return (
      before.kind === 'manifest' &&
      before.shape === 'legacy' &&
      after.kind === 'manifest' &&
      after.shape === 'canonical' &&
      sameLocation(before.location, after.location) &&
      before.semanticHash === after.semanticHash &&
      sameLocation(before.value, after.value)
    );
  }
  if (kind === 'write-manifest') {
    return (
      after.kind === 'manifest' &&
      after.shape === 'canonical' &&
      ((before.kind === 'absent' &&
        before.resource.kind === 'manifest-bytes' &&
        sameLocation(before.resource.location, after.location)) ||
        (before.kind === 'manifest' &&
          before.shape === 'canonical' &&
          sameLocation(before.location, after.location)) ||
        (before.kind === 'opaque-manifest' && sameLocation(before.location, after.location)))
    );
  }
  return (
    after.kind === 'lock' &&
    ((before.kind === 'absent' &&
      before.resource.kind === 'lock' &&
      sameLocation(before.resource.location, after.location)) ||
      (before.kind === 'lock' && sameLocation(before.location, after.location)))
  );
};

const validateArtifactPrerequisite = (
  command: CurrentMutatorCommand,
  operation: ExecutableOperation<string>,
): void => {
  const kind: ArtifactPrerequisiteKind = isArtifactPrerequisiteKind(operation.kind)
    ? operation.kind
    : fail(`null-pair operation ${operation.operationId} has an unsupported kind`);
  if (
    operation.skill !== null ||
    operation.source !== null ||
    operation.tool !== null ||
    operation.scope !== null
  ) {
    fail(`artifact prerequisite ${operation.operationId} requires null pair identity fields`);
  }
  if (
    operation.reversibility.kind !== 'none' ||
    operation.reversibility.retentionResourceIds.length !== 0
  ) {
    fail(`artifact prerequisite ${operation.operationId} must be non-reversible`);
  }
  const initReplacement =
    command === 'init' &&
    kind === 'write-manifest' &&
    operation.before.kind !== 'absent' &&
    operation.conflict?.class === 'destination-exists' &&
    operation.conflict.normal === 'refuse' &&
    operation.conflict.forced === 'backup-and-replace' &&
    operation.conflict.backup === 'required' &&
    operation.conflict.target.kind === 'manifest-bytes' &&
    sameLocation(
      operation.conflict.target.location,
      operation.before.kind === 'manifest' || operation.before.kind === 'opaque-manifest'
        ? operation.before.location
        : null,
    );
  if (operation.conflict !== null && !initReplacement) {
    fail(`artifact prerequisite ${operation.operationId} has an invalid conflict`);
  }
  const expectedMutations =
    kind === 'migrate-ledger'
      ? { live: false, manifest: false, lock: false, ledger: true }
      : kind === 'migrate-project-config'
        ? { live: false, manifest: true, lock: false, ledger: false }
        : kind === 'write-manifest'
          ? { live: false, manifest: true, lock: false, ledger: false }
          : { live: false, manifest: false, lock: true, ledger: false };
  if (
    !sameLocation(operation.mutates, expectedMutations) ||
    !validArtifactImages(kind, operation.before, operation.after)
  ) {
    fail(`artifact prerequisite ${operation.operationId} has an invalid artifact-only mutation`);
  }
};

export const validateExecutionPlanShape = <ToolId extends string = SupportedTool>(
  plan: OperationPlan<CurrentMutatorCommand, ToolId>,
): void => {
  const pairs = new Map<string, number>();
  const closedGroups = new Set<string>();
  const groupOperationCounts = new Map<string, number>();
  let currentGroup: string | null = null;
  const operationsById = new Map(
    plan.operations.map((operation) => [operation.operationId, operation]),
  );
  if (operationsById.size !== plan.operations.length) fail('operation IDs must be unique');
  const operationIndex = new Map(
    plan.operations.map((operation, index) => [operation.operationId, index]),
  );
  const operationGroups = new Map<string, ExecutableOperation<ToolId>[]>();
  for (const operation of plan.operations) {
    const group = operationGroups.get(operation.groupId) ?? [];
    group.push(operation);
    operationGroups.set(operation.groupId, group);
  }
  const prefixError = artifactPrefixDependencyError([...operationGroups.values()]);
  if (prefixError !== null) fail(prefixError);
  for (const operation of plan.operations) {
    for (const dependencyId of operation.dependencyMetadata.operationIds) {
      const dependency = operationsById.get(dependencyId);
      if (dependency === undefined) {
        fail(`operation ${operation.operationId} has a dangling dependency`);
      }
      if (
        (operationIndex.get(dependencyId) as number) >=
        (operationIndex.get(operation.operationId) as number)
      ) {
        fail(`operation ${operation.operationId} dependency order is not topological`);
      }
    }
    if (operation.groupId !== currentGroup) {
      if (closedGroups.has(operation.groupId)) {
        fail(`operation group ${operation.groupId} is not contiguous`);
      }
      if (currentGroup !== null) closedGroups.add(currentGroup);
      currentGroup = operation.groupId;
    }
    const groupCount = groupOperationCounts.get(operation.groupId) ?? 0;
    groupOperationCounts.set(operation.groupId, groupCount + 1);
    if (operation.pairId === null) {
      validateArtifactPrerequisite(plan.command, operation);
    } else {
      pairs.set(operation.pairId, (pairs.get(operation.pairId) ?? 0) + 1);
    }
  }
  for (const [pairId, count] of pairs) {
    if (count !== 1) {
      fail(`multi-operation pair ${pairId} is invalid; one operation per pair is required`);
    }
  }
  for (const operation of plan.operations) {
    if (operation.kind === 'migrate-ledger' && groupOperationCounts.get(operation.groupId) !== 1) {
      fail(`ledger migration ${operation.operationId} must be a singleton group`);
    }
  }
  if (String(plan.command) === 'doctor') {
    if (plan.batchPolicy !== 'continue-on-error') {
      fail('doctor artifact repairs require continue-on-error');
    }
    for (const operation of plan.operations) {
      if (operation.pairId !== null || groupOperationCounts.get(operation.groupId) !== 1) {
        fail(`doctor operation ${operation.operationId} must be a null-pair singleton group`);
      }
    }
  }
};

export const createValidatedExecutionBinding = <ToolId extends string = SupportedTool>(
  operation: ExecutableOperation<ToolId>,
  input: ValidatedExecutionBinding<ToolId>,
  index: number,
  context: PlanningToolContext<ToolId>,
): ValidatedExecutionBinding<ToolId> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(`binding ${index} must be an object`);
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== exactBindingKeys.length ||
    keys.some((key, offset) => key !== exactBindingKeys[offset])
  ) {
    fail(`binding ${index} has an invalid exact shape`);
  }
  if (input.operationId !== operation.operationId)
    fail(`binding ${index} operation order mismatch`);
  if (input.groupId !== operation.groupId) fail(`binding ${index} group identity mismatch`);
  if (input.pairId !== operation.pairId) fail(`binding ${index} pair identity mismatch`);
  if (typeof input.execute !== 'function') fail(`binding ${index} execute must be a function`);
  if (input.unstartedForce?.applied) fail(`binding ${index} unstarted force must not be applied`);
  const validated = createOperationExecutionResult(
    {
      operationId: operation.operationId,
      outcome: 'cancelled',
      actualBefore: input.actualBefore,
      actualAfter: input.actualBefore,
      force: input.unstartedForce,
      error: null,
    },
    context,
  );
  return Object.freeze({
    operationId: input.operationId,
    groupId: input.groupId,
    pairId: input.pairId,
    actualBefore: validated.actualBefore,
    unstartedForce: validated.force,
    execute: input.execute,
  });
};

export const validateExecutionBindings = <ToolId extends string = SupportedTool>(
  plan: OperationPlan<CurrentMutatorCommand, ToolId>,
  inputs: readonly ValidatedExecutionBinding<ToolId>[],
  context: PlanningToolContext<ToolId>,
): readonly ValidatedExecutionBinding<ToolId>[] => {
  validateExecutionPlanShape(plan);
  if (!Array.isArray(inputs) || inputs.length !== plan.operations.length) {
    fail('binding coverage must exactly match planned operations');
  }
  return Object.freeze(
    plan.operations.map((operation, index) =>
      createValidatedExecutionBinding(
        operation,
        inputs[index] as ValidatedExecutionBinding<ToolId>,
        index,
        context,
      ),
    ),
  );
};

const unstartedResult = <ToolId extends string>(
  binding: ValidatedExecutionBinding<ToolId>,
  outcome: 'cancelled' | 'skipped-after-failure',
  context: PlanningToolContext<ToolId>,
): OperationExecutionResult<ToolId> =>
  createOperationExecutionResult(
    {
      operationId: binding.operationId,
      outcome,
      actualBefore: binding.actualBefore,
      actualAfter: binding.actualBefore,
      force: binding.unstartedForce,
      error: null,
    },
    context,
  );

const executeBinding = async <ToolId extends string>(
  binding: ValidatedExecutionBinding<ToolId>,
  operation: ExecutableOperation<ToolId>,
  context: PlanningToolContext<ToolId>,
  observation: ObservationBundle | undefined,
  signal: AbortSignal | undefined,
): Promise<OperationExecutionResult<ToolId>> => {
  let operationObservation: ObservationBundle | undefined;
  let span: ReturnType<typeof beginOperationObservation> = null;
  if (observation !== undefined) {
    try {
      operationObservation = createPlannedOperationObservation(observation, operation);
      span = beginOperationObservation(
        operationObservation,
        operation as ExecutableOperation<string>,
      );
    } catch {
      operationObservation = undefined;
      span = null;
    }
  }
  try {
    const execute = binding.execute as (
      operationObservation?: ObservationBundle,
    ) => Promise<OperationExecutionResult<ToolId>>;
    const result = createOperationExecutionResult(
      await (operationObservation === undefined ? execute() : execute(operationObservation)),
      context,
    );
    if (result.operationId !== binding.operationId) {
      fail(`binding ${binding.operationId} returned a mismatched result`);
    }
    if (
      canonicalPlanningString(result.actualBefore) !== canonicalPlanningString(binding.actualBefore)
    ) {
      fail(`binding ${binding.operationId} returned a mismatched actual-before image`);
    }
    if (result.outcome === 'skipped-after-failure') {
      fail(`started binding ${binding.operationId} returned an unstarted scheduling outcome`);
    }
    if (operationObservation !== undefined) {
      completeOperationObservation(
        operationObservation,
        span,
        operationCompletionForResult(result as OperationExecutionResult<string>),
      );
    }
    return result;
  } catch (error) {
    if (operationObservation !== undefined) {
      completeOperationObservation(
        operationObservation,
        span,
        operationCompletionForThrown(error, signal),
      );
    }
    throw error;
  }
};

export const scheduleValidatedOperationPlan = async <ToolId extends string = SupportedTool>(
  plan: OperationPlan<CurrentMutatorCommand, ToolId>,
  bindings: readonly ValidatedExecutionBinding<ToolId>[],
  options: ExecutionScheduleOptions,
  context: PlanningToolContext<ToolId>,
  observation?: ObservationBundle,
): Promise<readonly OperationExecutionResult<ToolId>[]> => {
  const results: OperationExecutionResult<ToolId>[] = [];
  const resultByOperationId = new Map<string, OperationExecutionResult<ToolId>>();
  let cursor = 0;
  let stopAfterFailure = false;

  while (cursor < plan.operations.length) {
    const groupId = plan.operations[cursor]?.groupId;
    let groupEnd = cursor + 1;
    while (groupEnd < plan.operations.length && plan.operations[groupEnd]?.groupId === groupId) {
      groupEnd += 1;
    }

    if (options.signal?.aborted) {
      for (let index = cursor; index < bindings.length; index += 1) {
        results.push(
          unstartedResult(
            bindings[index] as ValidatedExecutionBinding<ToolId>,
            'cancelled',
            context,
          ),
        );
      }
      break;
    }
    if (stopAfterFailure) {
      for (let index = cursor; index < bindings.length; index += 1) {
        results.push(
          unstartedResult(
            bindings[index] as ValidatedExecutionBinding<ToolId>,
            'skipped-after-failure',
            context,
          ),
        );
      }
      break;
    }

    let groupFailed = false;
    let cancelled = false;
    for (let index = cursor; index < groupEnd; index += 1) {
      if (options.signal?.aborted) {
        for (let remaining = index; remaining < bindings.length; remaining += 1) {
          results.push(
            unstartedResult(
              bindings[remaining] as ValidatedExecutionBinding<ToolId>,
              'cancelled',
              context,
            ),
          );
        }
        cancelled = true;
        break;
      }
      const operation = plan.operations[index] as ExecutableOperation<ToolId>;
      const dependenciesSucceeded = operation.dependencyMetadata.operationIds.every(
        (operationId) => resultByOperationId.get(operationId)?.outcome === 'succeeded',
      );
      if (!dependenciesSucceeded) {
        const skipped = unstartedResult(
          bindings[index] as ValidatedExecutionBinding<ToolId>,
          'skipped-after-failure',
          context,
        );
        results.push(skipped);
        resultByOperationId.set(operation.operationId, skipped);
        continue;
      }
      const result = await executeBinding(
        bindings[index] as ValidatedExecutionBinding<ToolId>,
        operation,
        context,
        observation,
        options.signal,
      );
      results.push(result);
      resultByOperationId.set(operation.operationId, result);
      if (result.outcome === 'failed') {
        groupFailed = true;
        if (operation.kind === 'migrate-ledger' && plan.command !== 'doctor') {
          stopAfterFailure = true;
        }
      }
      if (result.outcome === 'cancelled') {
        for (let remaining = index + 1; remaining < bindings.length; remaining += 1) {
          results.push(
            unstartedResult(
              bindings[remaining] as ValidatedExecutionBinding<ToolId>,
              'cancelled',
              context,
            ),
          );
        }
        cancelled = true;
        break;
      }
    }
    if (cancelled) break;
    if (groupFailed && plan.batchPolicy === 'fail-fast') stopAfterFailure = true;
    cursor = groupEnd;
  }

  if (results.length !== plan.operations.length) {
    fail('result coverage did not exactly match planned operations');
  }
  return Object.freeze(results);
};

export function scheduleOperationPlan(
  plan: OperationPlan<CurrentMutatorCommand>,
  inputs: readonly ValidatedExecutionBinding[],
  options?: ExecutionScheduleOptions,
): Promise<readonly OperationExecutionResult[]>;
export function scheduleOperationPlan<ToolId extends string>(
  plan: OperationPlan<CurrentMutatorCommand, ToolId>,
  inputs: readonly ValidatedExecutionBinding<ToolId>[],
  options: ExecutionScheduleOptions | undefined,
  context: PlanningToolContext<ToolId>,
): Promise<readonly OperationExecutionResult<ToolId>[]>;
export async function scheduleOperationPlan(
  plan: OperationPlan<CurrentMutatorCommand, string>,
  inputs: readonly ValidatedExecutionBinding<string>[],
  options: ExecutionScheduleOptions = {},
  suppliedContext?: PlanningToolContext<string>,
): Promise<readonly OperationExecutionResult<string>[]> {
  const context = resolvePlanningToolContext(suppliedContext);
  return scheduleValidatedOperationPlan(
    plan,
    validateExecutionBindings(plan, inputs, context),
    options,
    context,
  );
}

export const scheduleOperationPlanObserved = async <ToolId extends string>(
  plan: OperationPlan<CurrentMutatorCommand, ToolId>,
  inputs: readonly ObservedValidatedExecutionBinding<ToolId>[],
  options: ExecutionScheduleOptions,
  observation: ObservationBundle,
  suppliedContext?: PlanningToolContext<ToolId>,
): Promise<readonly OperationExecutionResult<ToolId>[]> => {
  const context = resolvePlanningToolContext(suppliedContext);
  return scheduleValidatedOperationPlan(
    plan,
    validateExecutionBindings(
      plan,
      inputs as readonly ValidatedExecutionBinding<ToolId>[],
      context,
    ),
    options,
    context,
    observation,
  );
};
