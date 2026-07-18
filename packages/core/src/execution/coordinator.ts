import type { SupportedTool } from '../agents/types.ts';
import type { ObservationBundle } from '../observation/types.ts';
import { canonicalPlanningString, resolvePlanningToolContext } from '../planning/order.ts';
import type {
  CurrentMutatorCommand,
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
  OperationResourceIdentity,
  PlanningToolContext,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type ExpectedRevisionV1,
  type StateDomainV1,
  isExpectedRevisionV1,
  sameExpectedRevisionV1,
} from '../state/types.ts';
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
  ExecutionPrecondition,
  PreparedExecutionBinding,
  ValidatedExecutionBinding,
} from './types.ts';

export type ObservedPreparedExecutionBinding<ToolId extends string = SupportedTool> = Omit<
  PreparedExecutionBinding<ToolId>,
  'execute'
> &
  Readonly<{
    execute: (
      binding: ValidatedExecutionBinding<ToolId>,
      observation?: ObservationBundle,
    ) => Promise<OperationExecutionResult<ToolId>>;
  }>;

export type ObservedExecutionCoordinatorRequest<ToolId extends string = SupportedTool> = Omit<
  ExecutionCoordinatorRequest<ToolId>,
  'bindings'
> &
  Readonly<{
    bindings: readonly ObservedPreparedExecutionBinding<ToolId>[];
  }>;

export type RepositoryRevisionV1 = ExpectedRevisionV1;

export interface RevisionCursorV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly revisions: readonly RepositoryRevisionV1[];
}

export interface RevisionCursorPlanV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly expectedRevisions: readonly RepositoryRevisionV1[];
}

export type DurabilityDispositionV1 = 'committed' | 'rolled-back' | 'indeterminate';

export interface DurabilityRevisionTransitionV1 {
  readonly resourceId: string;
  readonly beforeRevision: RepositoryRevisionV1;
  readonly afterRevision: RepositoryRevisionV1;
}

export interface DurabilityReceiptV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly disposition: DurabilityDispositionV1;
  readonly revisions: readonly DurabilityRevisionTransitionV1[];
}

export interface RevisionCursorErrorV1 {
  readonly code:
    | 'invalid-cursor'
    | 'invalid-receipt'
    | 'indeterminate'
    | 'stale-revision'
    | 'unknown-resource';
  readonly operationId: string | null;
  readonly resourceId: string | null;
}

export interface RepositoryLifecycleStageV1 {
  readonly operationId: string;
  readonly domain: StateDomainV1;
  readonly resourceId: string;
  readonly beforeRevision: RepositoryRevisionV1;
}

export interface RepositoryLifecycleV1<
  Stage extends RepositoryLifecycleStageV1 = RepositoryLifecycleStageV1,
  Failure = unknown,
> {
  readonly operationId: string;
  readonly stage: () => Promise<Result<readonly Stage[], Failure>>;
  readonly commit: (stages: readonly Stage[]) => Promise<Result<DurabilityReceiptV1, Failure>>;
  readonly rollback: (
    stages: readonly Stage[],
    commitFailure: Failure,
  ) => Promise<Result<DurabilityReceiptV1, Failure>>;
  readonly cleanup: (
    stages: readonly Stage[],
    disposition: Exclude<DurabilityDispositionV1, 'indeterminate'>,
  ) => Promise<Result<void, Failure>>;
}

export interface RepositoryLifecycleValueV1 {
  readonly cursor: RevisionCursorV1;
  readonly receipt: DurabilityReceiptV1;
}

export type RepositoryLifecycleResultV1 = Result<
  RepositoryLifecycleValueV1,
  Readonly<Record<string, unknown>>
>;

interface PreparedBindingAdapter<ToolId extends string = SupportedTool> {
  readonly operation: ExecutableOperation<ToolId>;
  readonly operationId: string;
  readonly groupId: string;
  readonly pairId: string | null;
  readonly unstartedForce: ValidatedExecutionBinding<ToolId>['unstartedForce'];
  readonly observeActualBefore: () => Promise<OperationImage<ToolId>>;
  readonly execute: (
    binding: ValidatedExecutionBinding<ToolId>,
    observation?: ObservationBundle,
  ) => Promise<OperationExecutionResult<ToolId>>;
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

const resourceForImage = <ToolId extends string>(
  image: OperationImage<ToolId>,
): OperationResourceIdentity<ToolId> => {
  if (image.kind === 'absent' || image.kind === 'placement') return image.resource;
  if (image.kind === 'manifest') return { kind: 'manifest-bytes', location: image.location };
  if (image.kind === 'opaque-manifest') {
    return { kind: 'manifest-bytes', location: image.location };
  }
  if (image.kind === 'lock') return { kind: 'lock', location: image.location };
  return { kind: 'ledger', projectRoot: image.projectRoot };
};

/**
 * Preconditions compare opaque canonical resource facts and operation IDs; their implementation
 * does not branch on the built-in tool union. Keep that validator generic at this private seam.
 */
const validateGenericPreconditionCoverage = validateExecutionPreconditionCoverage as <
  ToolId extends string,
>(
  plan: OperationPlan<CurrentMutatorCommand, ToolId>,
  preconditions: readonly ExecutionPrecondition[],
) => readonly ExecutionPrecondition[];

const validateGenericPreconditions = validateExecutionPreconditions as <ToolId extends string>(
  plan: OperationPlan<CurrentMutatorCommand, ToolId>,
  preconditions: readonly ExecutionPrecondition[],
  options?: Readonly<{ readonly signal?: AbortSignal }>,
) => Promise<void>;

const preflightBindings = <ToolId extends string>(
  request: ExecutionCoordinatorRequest<ToolId> | ObservedExecutionCoordinatorRequest<ToolId>,
): readonly PreparedBindingAdapter<ToolId>[] => {
  validateExecutionPlanShape(request.plan);
  if (
    !Array.isArray(request.bindings) ||
    request.bindings.length !== request.plan.operations.length
  ) {
    fail('binding coverage must exactly match planned operations');
  }
  const preconditions = validateGenericPreconditionCoverage(request.plan, request.preconditions);

  return Object.freeze(
    request.plan.operations.map((operation, index) => {
      const candidate = request.bindings[index] as PreparedExecutionBinding<ToolId>;
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

const bindUnderLock = async <ToolId extends string>(
  prepared: readonly PreparedBindingAdapter<ToolId>[],
  signal: AbortSignal | undefined,
  context: PlanningToolContext<ToolId>,
): Promise<readonly ValidatedExecutionBinding<ToolId>[]> => {
  const bindings: ValidatedExecutionBinding<ToolId>[] = [];
  for (const [index, input] of prepared.entries()) {
    if (signal?.aborted) {
      throw Object.freeze({
        code: 'cancelled',
        message: 'execution binding observation cancelled',
      });
    }
    let actualBefore: OperationImage<ToolId>;
    try {
      actualBefore = await input.observeActualBefore();
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

    const bindingReference: { current: ValidatedExecutionBinding<ToolId> | null } = {
      current: null,
    };
    const validated = createValidatedExecutionBinding(
      input.operation,
      {
        operationId: input.operationId,
        groupId: input.groupId,
        pairId: input.pairId,
        actualBefore,
        unstartedForce: input.unstartedForce,
        execute: (
          operationObservation?: ObservationBundle,
        ): Promise<OperationExecutionResult<ToolId>> => {
          const binding = bindingReference.current;
          if (binding === null) {
            return fail(`binding ${index} executed before validation completed`);
          }
          return operationObservation === undefined
            ? (input as PreparedExecutionBinding<ToolId>).execute(binding)
            : (input as ObservedPreparedExecutionBinding<ToolId>).execute(
                binding,
                operationObservation,
              );
        },
      },
      index,
      context,
    );
    bindingReference.current = validated;
    bindings.push(validated);
  }
  return Object.freeze(bindings);
};

interface ExecuteOperationPlan {
  (request: ExecutionCoordinatorRequest): Promise<readonly OperationExecutionResult[]>;
  <ToolId extends string>(
    request: ExecutionCoordinatorRequest<ToolId>,
    context: PlanningToolContext<ToolId>,
  ): Promise<readonly OperationExecutionResult<ToolId>[]>;
}

interface ExecuteOperationPlanObserved {
  (
    request: ObservedExecutionCoordinatorRequest,
    observation: ObservationBundle,
  ): Promise<readonly OperationExecutionResult[]>;
  <ToolId extends string>(
    request: ObservedExecutionCoordinatorRequest<ToolId>,
    observation: ObservationBundle,
    context: PlanningToolContext<ToolId>,
  ): Promise<readonly OperationExecutionResult<ToolId>[]>;
}

const executeOperationPlanWithObservation = async <ToolId extends string>(
  request: ExecutionCoordinatorRequest<ToolId> | ObservedExecutionCoordinatorRequest<ToolId>,
  suppliedContext: PlanningToolContext<ToolId> | undefined,
  observation: ObservationBundle | undefined,
): Promise<readonly OperationExecutionResult<ToolId>[]> => {
  const context = resolvePlanningToolContext(suppliedContext);
  const prepared = preflightBindings(request);
  const options =
    request.signal === undefined ? Object.freeze({}) : Object.freeze({ signal: request.signal });

  return withExecutionLockHierarchy(
    request.lockPort,
    request.locks,
    async () => {
      await validateGenericPreconditions(request.plan, request.preconditions, options);
      const bindings = await bindUnderLock(prepared, request.signal, context);
      return scheduleValidatedOperationPlan(request.plan, bindings, options, context, observation);
    },
    options,
  );
};

export const executeOperationPlan: ExecuteOperationPlan = async <ToolId extends string>(
  request: ExecutionCoordinatorRequest<ToolId>,
  suppliedContext?: PlanningToolContext<ToolId>,
): Promise<readonly OperationExecutionResult<ToolId>[]> =>
  executeOperationPlanWithObservation(request, suppliedContext, undefined);

export const executeOperationPlanObserved: ExecuteOperationPlanObserved = async <
  ToolId extends string,
>(
  request: ObservedExecutionCoordinatorRequest<ToolId>,
  observation: ObservationBundle,
  suppliedContext?: PlanningToolContext<ToolId>,
): Promise<readonly OperationExecutionResult<ToolId>[]> =>
  executeOperationPlanWithObservation(request, suppliedContext, observation);

const revisionCursorError = (
  code: RevisionCursorErrorV1['code'],
  operationId: string | null,
  resourceId: string | null,
): RevisionCursorErrorV1 => Object.freeze({ code, operationId, resourceId });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ownRevision = (value: unknown): RepositoryRevisionV1 => {
  if (!isExpectedRevisionV1(value)) fail('revision must be a valid ExpectedRevisionV1');
  return Object.freeze(structuredClone(value)) as RepositoryRevisionV1;
};

const sameRevision = (left: RepositoryRevisionV1, right: RepositoryRevisionV1): boolean =>
  sameExpectedRevisionV1(left, right);

const ownRevisionCursor = (
  snapshotId: string,
  revisions: readonly RepositoryRevisionV1[],
): RevisionCursorV1 =>
  Object.freeze({
    schemaVersion: 1,
    snapshotId,
    revisions: Object.freeze(revisions.map((revision) => ownRevision(revision))),
  });

export const createRevisionCursorV1 = (plan: RevisionCursorPlanV1): RevisionCursorV1 => {
  if (
    !isRecord(plan) ||
    plan.schemaVersion !== 1 ||
    typeof plan.snapshotId !== 'string' ||
    !/^snapshot:v1:[0-9a-f]{64}$/u.test(plan.snapshotId) ||
    !Array.isArray(plan.expectedRevisions)
  ) {
    fail('revision cursor plan is invalid');
  }
  const revisions = plan.expectedRevisions.map((revision) => ownRevision(revision));
  const resourceIds = revisions.map((revision) => revision.resourceId);
  if (new Set(resourceIds).size !== resourceIds.length) {
    fail('revision cursor resources must be unique');
  }
  return ownRevisionCursor(plan.snapshotId, revisions);
};

const transitionReceipt = (
  cursor: RevisionCursorV1,
  receipt: DurabilityReceiptV1,
  disposition: Exclude<DurabilityDispositionV1, 'indeterminate'>,
): Result<RevisionCursorV1, RevisionCursorErrorV1> => {
  const revisions = new Map(cursor.revisions.map((revision) => [revision.resourceId, revision]));
  const seen = new Set<string>();
  for (const transition of receipt.revisions) {
    if (
      !isRecord(transition) ||
      typeof transition.resourceId !== 'string' ||
      seen.has(transition.resourceId)
    ) {
      return err(revisionCursorError('invalid-receipt', receipt.operationId, null));
    }
    seen.add(transition.resourceId);
    const current = revisions.get(transition.resourceId);
    if (current === undefined) {
      return err(
        revisionCursorError('unknown-resource', receipt.operationId, transition.resourceId),
      );
    }
    let beforeRevision: RepositoryRevisionV1;
    let afterRevision: RepositoryRevisionV1;
    try {
      beforeRevision = ownRevision(transition.beforeRevision);
      afterRevision = ownRevision(transition.afterRevision);
    } catch {
      return err(
        revisionCursorError('invalid-receipt', receipt.operationId, transition.resourceId),
      );
    }
    if (
      beforeRevision.resourceId !== transition.resourceId ||
      afterRevision.resourceId !== transition.resourceId ||
      beforeRevision.domain !== current.domain ||
      afterRevision.domain !== current.domain
    ) {
      return err(
        revisionCursorError('invalid-receipt', receipt.operationId, transition.resourceId),
      );
    }
    if (!sameRevision(current, beforeRevision)) {
      return err(revisionCursorError('stale-revision', receipt.operationId, transition.resourceId));
    }
    if (disposition === 'rolled-back' && !sameRevision(beforeRevision, afterRevision)) {
      return err(
        revisionCursorError('invalid-receipt', receipt.operationId, transition.resourceId),
      );
    }
    revisions.set(
      transition.resourceId,
      disposition === 'committed' ? afterRevision : beforeRevision,
    );
  }
  const ordered = cursor.revisions.map(
    (revision) => revisions.get(revision.resourceId) ?? revision,
  );
  return ok(ownRevisionCursor(cursor.snapshotId, ordered));
};

const advanceRevisionCursor = (
  cursor: RevisionCursorV1,
  receipt: DurabilityReceiptV1,
): Result<RevisionCursorV1, RevisionCursorErrorV1> =>
  transitionReceipt(cursor, receipt, 'committed');

const restoreRevisionCursor = (
  cursor: RevisionCursorV1,
  receipt: DurabilityReceiptV1,
): Result<RevisionCursorV1, RevisionCursorErrorV1> =>
  transitionReceipt(cursor, receipt, 'rolled-back');

export const applyDurabilityReceiptV1 = (
  cursor: RevisionCursorV1,
  receipt: DurabilityReceiptV1,
): Result<RevisionCursorV1, RevisionCursorErrorV1> => {
  if (
    !isRecord(cursor) ||
    cursor.schemaVersion !== 1 ||
    typeof cursor.snapshotId !== 'string' ||
    !Array.isArray(cursor.revisions)
  ) {
    return err(revisionCursorError('invalid-cursor', null, null));
  }
  if (
    !isRecord(receipt) ||
    receipt.schemaVersion !== 1 ||
    typeof receipt.operationId !== 'string' ||
    !Array.isArray(receipt.revisions) ||
    (receipt.disposition !== 'committed' &&
      receipt.disposition !== 'rolled-back' &&
      receipt.disposition !== 'indeterminate')
  ) {
    return err(revisionCursorError('invalid-receipt', null, null));
  }
  if (receipt.disposition === 'indeterminate') {
    return err(revisionCursorError('indeterminate', receipt.operationId, null));
  }
  return receipt.disposition === 'committed'
    ? advanceRevisionCursor(cursor, receipt)
    : restoreRevisionCursor(cursor, receipt);
};

const isResult = (value: unknown): value is Result<unknown, unknown> =>
  isRecord(value) &&
  typeof value.ok === 'boolean' &&
  (value.ok ? 'value' in value : 'error' in value);

const invokeLifecycle = async (
  operation: () => Promise<unknown>,
): Promise<Result<unknown, unknown>> => {
  try {
    const result = await operation();
    return isResult(result) ? result : err({ code: 'invalid-lifecycle-result' });
  } catch (error) {
    return err(error);
  }
};

const lifecycleFailure = (
  failure: unknown,
  cursor: RevisionCursorV1 | null,
  disposition: DurabilityDispositionV1 | 'unstarted',
): Readonly<Record<string, unknown>> => {
  const details: Record<string, unknown> = {};
  if (isRecord(failure)) {
    for (const key of ['code', 'reason', 'message']) {
      const descriptor = Object.getOwnPropertyDescriptor(failure, key);
      if (
        descriptor !== undefined &&
        'value' in descriptor &&
        (descriptor.value === null ||
          typeof descriptor.value === 'string' ||
          typeof descriptor.value === 'number' ||
          typeof descriptor.value === 'boolean')
      ) {
        details[key] = descriptor.value;
      }
    }
  }
  if (typeof details.code !== 'string') details.code = 'repository-lifecycle-failed';
  return Object.freeze({ ...details, disposition, cursor });
};

const cleanupLifecycle = async <Stage extends RepositoryLifecycleStageV1>(
  lifecycle: RepositoryLifecycleV1<Stage>,
  stages: readonly Stage[],
  disposition: Exclude<DurabilityDispositionV1, 'indeterminate'>,
  cursor: RevisionCursorV1,
): Promise<Result<void, Readonly<Record<string, unknown>>>> => {
  const cleanup = await invokeLifecycle(() => lifecycle.cleanup(stages, disposition));
  return cleanup.ok ? ok(undefined) : err(lifecycleFailure(cleanup.error, cursor, disposition));
};

const validLifecycleStages = (
  stages: readonly unknown[],
  operationId: string,
): stages is readonly RepositoryLifecycleStageV1[] => {
  const resources = new Set<string>();
  for (const stage of stages) {
    if (
      !isRecord(stage) ||
      stage.operationId !== operationId ||
      typeof stage.domain !== 'string' ||
      typeof stage.resourceId !== 'string' ||
      resources.has(stage.resourceId) ||
      !isExpectedRevisionV1(stage.beforeRevision) ||
      stage.beforeRevision.domain !== stage.domain ||
      stage.beforeRevision.resourceId !== stage.resourceId
    ) {
      return false;
    }
    resources.add(stage.resourceId);
  }
  return true;
};

const receiptExactlyCoversStages = (
  stages: readonly RepositoryLifecycleStageV1[],
  receipt: DurabilityReceiptV1,
): boolean => {
  if (!Array.isArray(receipt.revisions) || receipt.revisions.length !== stages.length) return false;
  const transitions = new Map(receipt.revisions.map((item) => [item.resourceId, item]));
  if (transitions.size !== stages.length) return false;
  for (const stage of stages) {
    const transition = transitions.get(stage.resourceId);
    if (
      transition === undefined ||
      !isExpectedRevisionV1(transition.beforeRevision) ||
      !isExpectedRevisionV1(transition.afterRevision) ||
      transition.beforeRevision.domain !== stage.domain ||
      transition.afterRevision.domain !== stage.domain ||
      transition.beforeRevision.resourceId !== stage.resourceId ||
      transition.afterRevision.resourceId !== stage.resourceId ||
      !sameExpectedRevisionV1(transition.beforeRevision, stage.beforeRevision)
    ) {
      return false;
    }
  }
  return true;
};

export const executeRepositoryLifecycleV1 = async <Stage extends RepositoryLifecycleStageV1>(
  cursor: RevisionCursorV1,
  lifecycle: RepositoryLifecycleV1<Stage>,
): Promise<RepositoryLifecycleResultV1> => {
  if (typeof lifecycle.operationId !== 'string' || lifecycle.operationId.length === 0) {
    return err(lifecycleFailure({ code: 'invalid-operation-id' }, cursor, 'unstarted'));
  }
  const staged = await invokeLifecycle(() => lifecycle.stage());
  if (!staged.ok) return err(lifecycleFailure(staged.error, cursor, 'unstarted'));
  if (!Array.isArray(staged.value)) {
    return err(lifecycleFailure({ code: 'invalid-stage-result' }, cursor, 'unstarted'));
  }
  const stages = staged.value as readonly Stage[];
  if (!validLifecycleStages(stages, lifecycle.operationId)) {
    return err(lifecycleFailure({ code: 'invalid-stage-result' }, cursor, 'unstarted'));
  }
  const committed = await invokeLifecycle(() => lifecycle.commit(stages));
  if (committed.ok) {
    const receipt = committed.value as DurabilityReceiptV1;
    if (receipt?.operationId !== lifecycle.operationId) {
      return err(lifecycleFailure({ code: 'invalid-receipt' }, null, 'indeterminate'));
    }
    if (receipt?.disposition === 'indeterminate') {
      return err(lifecycleFailure({ code: 'indeterminate' }, null, 'indeterminate'));
    }
    if (!receiptExactlyCoversStages(stages, receipt)) {
      return err(lifecycleFailure({ code: 'invalid-receipt' }, null, 'indeterminate'));
    }
    const advanced = applyDurabilityReceiptV1(cursor, receipt);
    if (!advanced.ok) {
      return err(lifecycleFailure(advanced.error, null, 'indeterminate'));
    }
    const cleanup = await cleanupLifecycle(lifecycle, stages, receipt.disposition, advanced.value);
    if (!cleanup.ok) return cleanup;
    if (receipt.disposition === 'rolled-back') {
      return err(lifecycleFailure({ code: 'rolled-back' }, advanced.value, 'rolled-back'));
    }
    return ok(Object.freeze({ cursor: advanced.value, receipt }));
  }

  const rolledBack = await invokeLifecycle(() => lifecycle.rollback(stages, committed.error));
  if (!rolledBack.ok) {
    return err(lifecycleFailure(rolledBack.error, null, 'indeterminate'));
  }
  const receipt = rolledBack.value as DurabilityReceiptV1;
  if (receipt?.operationId !== lifecycle.operationId) {
    return err(lifecycleFailure({ code: 'invalid-receipt' }, null, 'indeterminate'));
  }
  if (receipt?.disposition === 'indeterminate') {
    return err(lifecycleFailure(committed.error, null, 'indeterminate'));
  }
  if (!receiptExactlyCoversStages(stages, receipt)) {
    return err(lifecycleFailure({ code: 'invalid-receipt' }, null, 'indeterminate'));
  }
  const resolved = applyDurabilityReceiptV1(cursor, receipt);
  if (!resolved.ok) {
    return err(lifecycleFailure(resolved.error, null, 'indeterminate'));
  }
  const cleanup = await cleanupLifecycle(lifecycle, stages, receipt.disposition, resolved.value);
  if (!cleanup.ok) return cleanup;
  if (receipt.disposition === 'committed') {
    return ok(Object.freeze({ cursor: resolved.value, receipt }));
  }
  return err(lifecycleFailure(committed.error, resolved.value, 'rolled-back'));
};
