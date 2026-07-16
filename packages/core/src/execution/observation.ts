import { createHash } from 'node:crypto';
import { safeErrorCode } from '../errors.ts';
import { createOperationContext } from '../observation/operation-context.ts';
import type {
  ObservationBundle,
  ObservationOutcome,
  ObservationSpan,
  RecoveryKind,
  TransactionStage,
} from '../observation/types.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  CurrentMutatorCommand,
  ExecutableOperation,
  OperationExecutionResult,
  OperationPlan,
} from '../planning/types.ts';

export interface TransactionObservationJournal {
  readonly transactionId: string;
  readonly intent: Readonly<{
    readonly operationId: string;
    readonly groupId: string;
    readonly pairId: string | null;
  }>;
  readonly context: Readonly<{
    readonly parentOperationId: string | null;
    readonly command: string;
    readonly workflow: string;
    readonly attempt: number;
    readonly startedAt: string;
  }>;
}

const bundleWithContext = (
  bundle: ObservationBundle,
  context: ObservationBundle['context'],
): ObservationBundle => Object.freeze({ context, emitter: bundle.emitter });

export const operationPlanObservationId = <
  ToolId extends string,
  Command extends CurrentMutatorCommand = CurrentMutatorCommand,
>(
  plan: OperationPlan<Command, ToolId>,
): string => `plan:v1:${createHash('sha256').update(canonicalPlanningString(plan)).digest('hex')}`;

export const emitOperationPlanCreated = <
  ToolId extends string,
  Command extends CurrentMutatorCommand = CurrentMutatorCommand,
>(
  bundle: ObservationBundle,
  plan: OperationPlan<Command, ToolId>,
): void => {
  try {
    bundle.emitter.emit(bundle.context, {
      kind: 'plan.created',
      planId: operationPlanObservationId(plan),
      operationCount: plan.operations.length,
    });
  } catch {
    // Observation cannot acquire authority over a successfully created plan.
  }
};

export const createPlannedOperationObservation = <ToolId extends string>(
  bundle: ObservationBundle,
  operation: ExecutableOperation<ToolId>,
): ObservationBundle =>
  bundleWithContext(
    bundle,
    createOperationContext({
      command: bundle.context.command,
      workflow: bundle.context.workflow,
      clock: bundle.context.clock,
      id: { nextId: () => operation.operationId },
      operationId: operation.operationId,
      parentOperationId: bundle.context.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      attempt: 1,
    }),
  );

export const createTransactionObservation = (
  bundle: ObservationBundle,
  journal: TransactionObservationJournal,
): ObservationBundle => {
  let capturePersistedStart = true;
  const context = createOperationContext({
    command: journal.context.command,
    workflow: journal.context.workflow,
    clock: {
      wallNowIso: () => {
        if (capturePersistedStart) {
          capturePersistedStart = false;
          return journal.context.startedAt;
        }
        return bundle.context.clock.wallNowIso();
      },
      monotonicMilliseconds: bundle.context.clock.monotonicMilliseconds,
    },
    id: { nextId: () => journal.transactionId },
    operationId: journal.transactionId,
    parentOperationId: journal.context.parentOperationId ?? journal.intent.operationId,
    groupId: journal.intent.groupId,
    pairId: journal.intent.pairId,
    attempt: journal.context.attempt,
  });
  return bundleWithContext(bundle, context);
};

export const beginOperationObservation = (
  bundle: ObservationBundle,
  operation: ExecutableOperation<string>,
): ObservationSpan<'operation.started'> | null =>
  bundle.emitter.begin(bundle.context, {
    kind: 'operation.started',
    operationKind: operation.kind,
  });

export const operationCompletionForResult = (
  result: OperationExecutionResult<string>,
): Readonly<{
  outcome: ObservationOutcome;
  errorCode: string | null;
  standaloneCount: null;
  bundledCount: null;
  resultCount: null;
}> => {
  switch (result.outcome) {
    case 'succeeded':
    case 'rolled-back':
      return Object.freeze({
        outcome: 'success',
        errorCode: null,
        standaloneCount: null,
        bundledCount: null,
        resultCount: null,
      });
    case 'failed':
      return Object.freeze({
        outcome: 'failure',
        errorCode: result.error.code,
        standaloneCount: null,
        bundledCount: null,
        resultCount: null,
      });
    case 'cancelled':
      return Object.freeze({
        outcome: 'cancelled',
        errorCode: 'cancelled',
        standaloneCount: null,
        bundledCount: null,
        resultCount: null,
      });
    case 'skipped-after-failure':
      return Object.freeze({
        outcome: 'skipped',
        errorCode: null,
        standaloneCount: null,
        bundledCount: null,
        resultCount: null,
      });
  }
};

const ownStringDataProperty = (value: unknown, key: string): string | null => {
  if (value === null || typeof value !== 'object') return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : null;
};

export const isExecutionCancellation = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  const code = safeErrorCode(error);
  return (
    code === 'cancelled' ||
    code === 'ABORT_ERR' ||
    ownStringDataProperty(error, 'name') === 'AbortError'
  );
};

export const operationCompletionForThrown = (
  error: unknown,
  signal?: AbortSignal,
): Readonly<{
  outcome: 'failure' | 'cancelled';
  errorCode: string;
  standaloneCount: null;
  bundledCount: null;
  resultCount: null;
}> => {
  const cancelled = isExecutionCancellation(error, signal);
  return Object.freeze({
    outcome: cancelled ? 'cancelled' : 'failure',
    errorCode: cancelled ? 'cancelled' : (safeErrorCode(error) ?? 'execution-threw'),
    standaloneCount: null,
    bundledCount: null,
    resultCount: null,
  });
};

export const completeOperationObservation = (
  bundle: ObservationBundle,
  span: ObservationSpan<'operation.started'> | null,
  completion:
    | ReturnType<typeof operationCompletionForResult>
    | ReturnType<typeof operationCompletionForThrown>,
): void => {
  bundle.emitter.complete(span, completion);
};

export const beginToolDetectionObservation = (
  bundle: ObservationBundle,
  toolId: string,
): ObservationSpan<'tool.detection.started'> | null =>
  bundle.emitter.begin(bundle.context, {
    kind: 'tool.detection.started',
    toolId,
  });

export const completeToolDetectionObservation = (
  bundle: ObservationBundle,
  span: ObservationSpan<'tool.detection.started'> | null,
  outcome: ObservationOutcome,
  errorCode: string | null,
  resultCount: number,
): void => {
  bundle.emitter.complete(span, { outcome, errorCode, resultCount });
};

export const beginTransactionStageObservation = (
  bundle: ObservationBundle,
  stage: TransactionStage,
): ObservationSpan<'transaction.stage.started'> | null =>
  bundle.emitter.begin(bundle.context, {
    kind: 'transaction.stage.started',
    transactionId: bundle.context.operationId,
    stage,
  });

export const completeTransactionStageObservation = (
  bundle: ObservationBundle,
  span: ObservationSpan<'transaction.stage.started'> | null,
  outcome: ObservationOutcome,
  errorCode: string | null,
): void => {
  bundle.emitter.complete(span, { outcome, errorCode });
};

export const emitTransactionCommitted = (bundle: ObservationBundle): void => {
  try {
    bundle.emitter.emit(bundle.context, {
      kind: 'transaction.committed',
      transactionId: bundle.context.operationId,
      durationMilliseconds: Math.max(
        0,
        bundle.context.clock.monotonicMilliseconds() - bundle.context.startedMonotonicMilliseconds,
      ),
    });
  } catch {
    // Observation cannot acquire authority over a committed transaction.
  }
};

export const emitTransactionRolledBack = (bundle: ObservationBundle, reasonCode: string): void => {
  try {
    bundle.emitter.emit(bundle.context, {
      kind: 'transaction.rolled-back',
      transactionId: bundle.context.operationId,
      reasonCode,
      durationMilliseconds: Math.max(
        0,
        bundle.context.clock.monotonicMilliseconds() - bundle.context.startedMonotonicMilliseconds,
      ),
    });
  } catch {
    // Observation cannot acquire authority over a rolled-back transaction.
  }
};

export const beginRecoveryObservation = (
  bundle: ObservationBundle,
  recoveryKind: RecoveryKind,
): ObservationSpan<'recovery.started'> | null =>
  bundle.emitter.begin(bundle.context, {
    kind: 'recovery.started',
    transactionId: bundle.context.operationId,
    recoveryKind,
  });

export const completeRecoveryObservation = (
  bundle: ObservationBundle,
  span: ObservationSpan<'recovery.started'> | null,
  outcome: ObservationOutcome,
  errorCode: string | null,
): void => {
  bundle.emitter.complete(span, { outcome, errorCode });
};
