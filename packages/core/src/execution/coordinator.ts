import { createOperationExecutionResult } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationResourceIdentity,
} from '../planning/types.ts';
import { withExecutionLockHierarchy } from './lock-hierarchy.ts';
import {
  validateExecutionPreconditionCoverage,
  validateExecutionPreconditions,
} from './preconditions.ts';
import {
  createValidatedExecutionBinding,
  scheduleValidatedOperationPlan,
  validateExecutionPlanShape,
} from './scheduler.ts';
import type {
  ExecutionCoordinatorRequest,
  PreparedExecutionBinding,
  ValidatedExecutionBinding,
} from './types.ts';

interface PreparedBindingAdapter {
  readonly operation: ExecutableOperation;
  readonly operationId: string;
  readonly groupId: string;
  readonly pairId: string;
  readonly unstartedForce: ValidatedExecutionBinding['unstartedForce'];
  readonly observeActualBefore: () => Promise<OperationImage>;
  readonly execute: (binding: ValidatedExecutionBinding) => Promise<OperationExecutionResult>;
}

const preparedKeys = Object.freeze([
  'execute',
  'groupId',
  'observeActualBefore',
  'operationId',
  'pairId',
  'unstartedForce',
]);

const fail = (message: string): never => {
  throw new TypeError(`execution coordinator: ${message}`);
};

const stateError = (
  code: 'precondition-state-changed' | 'precondition-observation-failed',
  message: string,
) => Object.freeze({ code, message });

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

const resourceForImage = (image: OperationImage): OperationResourceIdentity => {
  if (image.kind === 'absent' || image.kind === 'placement') return image.resource;
  if (image.kind === 'manifest') return { kind: 'manifest-bytes', location: image.location };
  if (image.kind === 'lock') return { kind: 'lock', location: image.location };
  return { kind: 'ledger', projectRoot: image.projectRoot };
};

const preflightBindings = (
  request: ExecutionCoordinatorRequest,
): readonly PreparedBindingAdapter[] => {
  validateExecutionPlanShape(request.plan);
  if (
    !Array.isArray(request.bindings) ||
    request.bindings.length !== request.plan.operations.length
  ) {
    fail('binding coverage must exactly match planned operations');
  }
  const preconditions = validateExecutionPreconditionCoverage(request.plan, request.preconditions);

  return Object.freeze(
    request.plan.operations.map((operation, index) => {
      const candidate = request.bindings[index] as PreparedExecutionBinding;
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return fail(`binding ${index} must be an object`);
      }
      if (!exactKeys(candidate, preparedKeys)) {
        return fail(`binding ${index} has an invalid exact shape`);
      }
      if (candidate.operationId !== operation.operationId) {
        return fail(`binding ${index} operation order mismatch`);
      }
      if (candidate.groupId !== operation.groupId) fail(`binding ${index} group identity mismatch`);
      if (candidate.pairId !== operation.pairId) fail(`binding ${index} pair identity mismatch`);
      if (typeof candidate.execute !== 'function')
        fail(`binding ${index} execute must be a function`);
      if (candidate.unstartedForce?.applied) {
        fail(`binding ${index} unstarted force must not be applied`);
      }
      if (typeof candidate.observeActualBefore !== 'function') {
        fail(`binding ${index} actual-before observer must be a function`);
      }

      const matchingResource = preconditions.some(
        (precondition) =>
          precondition.operationIds.includes(operation.operationId) &&
          canonicalPlanningString(precondition.resource) ===
            canonicalPlanningString(resourceForImage(operation.before)),
      );
      if (!matchingResource) {
        fail(`operation ${operation.operationId} lacks a same-resource precondition`);
      }

      return Object.freeze({
        operation,
        operationId: candidate.operationId,
        groupId: candidate.groupId,
        pairId: candidate.pairId,
        unstartedForce: candidate.unstartedForce,
        observeActualBefore: candidate.observeActualBefore,
        execute: candidate.execute,
      });
    }),
  );
};

const bindUnderLock = async (
  prepared: readonly PreparedBindingAdapter[],
  signal: AbortSignal | undefined,
): Promise<readonly ValidatedExecutionBinding[]> => {
  const bindings: ValidatedExecutionBinding[] = [];
  for (const [index, input] of prepared.entries()) {
    if (signal?.aborted) {
      throw Object.freeze({
        code: 'cancelled',
        message: 'execution binding observation cancelled',
      });
    }
    let actualBefore: OperationImage;
    try {
      const observed = await input.observeActualBefore();
      actualBefore = createOperationExecutionResult({
        operationId: input.operationId,
        outcome: 'cancelled',
        actualBefore: observed,
        actualAfter: observed,
        force: input.unstartedForce,
        error: null,
      }).actualBefore;
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'cancelled'
      ) {
        throw error;
      }
      throw stateError(
        'precondition-observation-failed',
        `execution actual-before observation failed for ${input.operationId}`,
      );
    }
    if (canonicalPlanningString(actualBefore) !== canonicalPlanningString(input.operation.before)) {
      throw stateError(
        'precondition-state-changed',
        `execution actual-before state changed for ${input.operationId}`,
      );
    }

    const validated = createValidatedExecutionBinding(
      input.operation,
      {
        operationId: input.operationId,
        groupId: input.groupId,
        pairId: input.pairId,
        actualBefore,
        unstartedForce: input.unstartedForce,
        execute: () => input.execute(validated),
      },
      index,
    );
    bindings.push(validated);
  }
  return Object.freeze(bindings);
};

export const executeOperationPlan = async (
  request: ExecutionCoordinatorRequest,
): Promise<readonly OperationExecutionResult[]> => {
  const prepared = preflightBindings(request);
  const options =
    request.signal === undefined ? Object.freeze({}) : Object.freeze({ signal: request.signal });

  return withExecutionLockHierarchy(
    request.lockPort,
    request.locks,
    async () => {
      await validateExecutionPreconditions(request.plan, request.preconditions, options);
      const bindings = await bindUnderLock(prepared, request.signal);
      return scheduleValidatedOperationPlan(request.plan, bindings, options);
    },
    options,
  );
};
