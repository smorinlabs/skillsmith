import { createOperationExecutionResult } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  CurrentMutatorOperationPlan,
  ExecutableOperation,
  OperationExecutionResult,
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

export const validateExecutionPlanShape = (plan: CurrentMutatorOperationPlan): void => {
  const pairs = new Map<string, number>();
  const closedGroups = new Set<string>();
  let currentGroup: string | null = null;
  for (const operation of plan.operations) {
    if (operation.pairId === null) fail(`operation ${operation.operationId} requires a pair`);
    const pairId = operation.pairId as string;
    if (operation.dependencyMetadata.operationIds.length > 0) {
      fail(`operation ${operation.operationId} dependency metadata must be empty in this slice`);
    }
    pairs.set(pairId, (pairs.get(pairId) ?? 0) + 1);
    if (operation.groupId !== currentGroup) {
      if (closedGroups.has(operation.groupId)) {
        fail(`operation group ${operation.groupId} is not contiguous`);
      }
      if (currentGroup !== null) closedGroups.add(currentGroup);
      currentGroup = operation.groupId;
    }
  }
  for (const [pairId, count] of pairs) {
    if (count !== 1) fail(`pair ${pairId} must contain exactly one operation`);
  }
};

export const createValidatedExecutionBinding = (
  operation: ExecutableOperation,
  input: ValidatedExecutionBinding,
  index: number,
): ValidatedExecutionBinding => {
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
  const validated = createOperationExecutionResult({
    operationId: operation.operationId,
    outcome: 'cancelled',
    actualBefore: input.actualBefore,
    actualAfter: input.actualBefore,
    force: input.unstartedForce,
    error: null,
  });
  return Object.freeze({
    operationId: input.operationId,
    groupId: input.groupId,
    pairId: input.pairId,
    actualBefore: validated.actualBefore,
    unstartedForce: validated.force,
    execute: input.execute,
  });
};

export const validateExecutionBindings = (
  plan: CurrentMutatorOperationPlan,
  inputs: readonly ValidatedExecutionBinding[],
): readonly ValidatedExecutionBinding[] => {
  validateExecutionPlanShape(plan);
  if (!Array.isArray(inputs) || inputs.length !== plan.operations.length) {
    fail('binding coverage must exactly match planned operations');
  }
  return Object.freeze(
    plan.operations.map((operation, index) =>
      createValidatedExecutionBinding(operation, inputs[index] as ValidatedExecutionBinding, index),
    ),
  );
};

const unstartedResult = (
  binding: ValidatedExecutionBinding,
  outcome: 'cancelled' | 'skipped-after-failure',
): OperationExecutionResult =>
  createOperationExecutionResult({
    operationId: binding.operationId,
    outcome,
    actualBefore: binding.actualBefore,
    actualAfter: binding.actualBefore,
    force: binding.unstartedForce,
    error: null,
  });

const executeBinding = async (
  binding: ValidatedExecutionBinding,
): Promise<OperationExecutionResult> => {
  const result = createOperationExecutionResult(await binding.execute());
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

export const scheduleValidatedOperationPlan = async (
  plan: CurrentMutatorOperationPlan,
  bindings: readonly ValidatedExecutionBinding[],
  options: ExecutionScheduleOptions = {},
): Promise<readonly OperationExecutionResult[]> => {
  const results: OperationExecutionResult[] = [];
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
        results.push(unstartedResult(bindings[index] as ValidatedExecutionBinding, 'cancelled'));
      }
      break;
    }
    if (stopAfterFailure) {
      for (let index = cursor; index < bindings.length; index += 1) {
        results.push(
          unstartedResult(bindings[index] as ValidatedExecutionBinding, 'skipped-after-failure'),
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
            unstartedResult(bindings[remaining] as ValidatedExecutionBinding, 'cancelled'),
          );
        }
        cancelled = true;
        break;
      }
      const result = await executeBinding(bindings[index] as ValidatedExecutionBinding);
      results.push(result);
      if (result.outcome === 'failed') groupFailed = true;
      if (result.outcome === 'cancelled') {
        for (let remaining = index + 1; remaining < bindings.length; remaining += 1) {
          results.push(
            unstartedResult(bindings[remaining] as ValidatedExecutionBinding, 'cancelled'),
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

export const scheduleOperationPlan = async (
  plan: CurrentMutatorOperationPlan,
  inputs: readonly ValidatedExecutionBinding[],
  options: ExecutionScheduleOptions = {},
): Promise<readonly OperationExecutionResult[]> =>
  scheduleValidatedOperationPlan(plan, validateExecutionBindings(plan, inputs), options);
