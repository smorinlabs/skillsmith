import type { SupportedTool } from '../agents/types.ts';
import { createOperationExecutionResult, resolvePlanningToolContext } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  CurrentMutatorCommand,
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
  PlanningToolContext,
} from '../planning/types.ts';
import type { ExecutionScheduleOptions, ValidatedExecutionBinding } from './types.ts';

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

const ARTIFACT_PREREQUISITE_KINDS = Object.freeze([
  'migrate-ledger',
  'migrate-project-config',
  'write-lock',
] as const);

type ArtifactPrerequisiteKind = (typeof ARTIFACT_PREREQUISITE_KINDS)[number];

const isArtifactPrerequisiteKind = (kind: string): kind is ArtifactPrerequisiteKind =>
  ARTIFACT_PREREQUISITE_KINDS.some((candidate) => candidate === kind);

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
      sameLocation(before.location, after.location)
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

const validateArtifactPrerequisite = (operation: ExecutableOperation<string>): void => {
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
    operation.reversibility.retentionResourceIds.length !== 0 ||
    operation.conflict !== null
  ) {
    fail(`artifact prerequisite ${operation.operationId} must be non-reversible and conflict-free`);
  }
  const expectedMutations =
    kind === 'migrate-ledger'
      ? { live: false, manifest: false, lock: false, ledger: true }
      : kind === 'migrate-project-config'
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
  const artifactGroups = new Set<string>();
  let currentGroup: string | null = null;
  for (const operation of plan.operations) {
    if (operation.dependencyMetadata.operationIds.length > 0) {
      fail(`operation ${operation.operationId} dependency metadata must be empty in this slice`);
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
      validateArtifactPrerequisite(operation);
      if (artifactGroups.has(operation.groupId) || groupCount !== 0) {
        fail(`artifact prerequisite ${operation.operationId} must be the unique group prefix`);
      }
      artifactGroups.add(operation.groupId);
    } else {
      pairs.set(operation.pairId, (pairs.get(operation.pairId) ?? 0) + 1);
    }
  }
  for (const [pairId, count] of pairs) {
    if (count !== 1) fail(`pair ${pairId} must contain exactly one operation`);
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
  context: PlanningToolContext<ToolId>,
): Promise<OperationExecutionResult<ToolId>> => {
  const result = createOperationExecutionResult(await binding.execute(), context);
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
  return result;
};

export const scheduleValidatedOperationPlan = async <ToolId extends string = SupportedTool>(
  plan: OperationPlan<CurrentMutatorCommand, ToolId>,
  bindings: readonly ValidatedExecutionBinding<ToolId>[],
  options: ExecutionScheduleOptions,
  context: PlanningToolContext<ToolId>,
): Promise<readonly OperationExecutionResult<ToolId>[]> => {
  const results: OperationExecutionResult<ToolId>[] = [];
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
      const result = await executeBinding(
        bindings[index] as ValidatedExecutionBinding<ToolId>,
        context,
      );
      results.push(result);
      if (result.outcome === 'failed') {
        groupFailed = true;
        const operation = plan.operations[index] as ExecutableOperation<ToolId>;
        if (operation.pairId === null) {
          for (let remaining = index + 1; remaining < groupEnd; remaining += 1) {
            results.push(
              unstartedResult(
                bindings[remaining] as ValidatedExecutionBinding<ToolId>,
                'skipped-after-failure',
                context,
              ),
            );
          }
          if (operation.kind === 'migrate-ledger' && plan.command !== 'doctor') {
            stopAfterFailure = true;
          }
          break;
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
