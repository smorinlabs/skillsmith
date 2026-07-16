import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import { flipFailedError, safeErrorCode } from '../errors.ts';
import {
  beginRecoveryObservation,
  completeRecoveryObservation,
  createTransactionObservation,
  isExecutionCancellation,
} from '../execution/observation.ts';
import type { ObservationBundle, ObservationOutcome } from '../observation/index.ts';
import type { ExecutableOperation } from '../planning/types.ts';
import type { PlacementExecutionInput } from './execute.ts';
import { createPlacementSwapRequest } from './execute.ts';
import { getLedgerPairAt } from './ledger.ts';
import { beginTransactionRecoveryAttempt } from './logical-transactions.ts';
import {
  refusedMessage,
  resumeSwap,
  resumeSwapObserved,
  rollbackSwap,
  rollbackSwapAfterRecoveryAttempt,
  rollbackSwapObserved,
  sweepCommittedAcquireJournals,
  sweepCommittedAcquireJournalsObserved,
} from './swap.ts';
import type { FlipTool, SwapExecutionResult, SwapOutcome, SwapRequest } from './types.ts';

export interface PlacementRecoveryTarget {
  readonly skill: string;
  readonly tool: FlipTool;
  readonly scopeKey?: string | null;
}

const journalForTarget = (
  input: PlacementExecutionInput,
  target: PlacementRecoveryTarget,
): LogicalJournalV1Dto | null => {
  const pair = getLedgerPairAt(input.ledger, target.scopeKey ?? null, target.skill, target.tool);
  const transactionId = pair?.journal?.txId;
  if (transactionId === undefined) return null;
  return (
    input.ledger.transactions[transactionId] ??
    input.ledger.history.find((journal) => journal.transactionId === transactionId) ??
    null
  );
};

const recoveryCompletion = (
  result: SwapExecutionResult<unknown>,
): Readonly<{ outcome: ObservationOutcome; errorCode: string | null }> =>
  result.ok
    ? { outcome: 'success', errorCode: null }
    : {
        outcome: result.error.code === 'cancelled' ? 'cancelled' : 'failure',
        errorCode: result.error.code,
      };

const recoveryOperation = (journal: LogicalJournalV1Dto): ExecutableOperation =>
  Object.freeze({
    operationId: journal.intent.operationId,
    groupId: journal.intent.groupId,
    pairId: journal.intent.pairId,
    kind: journal.intent.kind,
    dependencyMetadata: Object.freeze({
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: Object.freeze([]),
    }),
    skill: journal.intent.skill,
    source: journal.intent.source as ExecutableOperation['source'],
    tool: journal.intent.tool,
    scope: journal.intent.scope,
    before: journal.intent.before as ExecutableOperation['before'],
    after: journal.intent.after as ExecutableOperation['after'],
    reason: Object.freeze({
      code: 'transaction-recovery',
      message: 'Resume an existing durable placement transaction.',
    }),
    selectionSource: 'explicit-targets',
    preconditionIds: Object.freeze([]),
    requiredCheckIds: Object.freeze([]),
    reversibility: journal.intent.reversibility as ExecutableOperation['reversibility'],
    mutates: journal.intent.mutates,
    conflict: journal.intent.conflict as ExecutableOperation['conflict'],
  });

const recoveryRequest = (
  input: PlacementExecutionInput,
  journal: LogicalJournalV1Dto | null,
): ReturnType<typeof createPlacementSwapRequest> =>
  createPlacementSwapRequest(
    journal === null || input.logicalOperation !== undefined
      ? input
      : Object.freeze({ ...input, logicalOperation: recoveryOperation(journal) }),
  );

type PlannedPlacementRecovery =
  | Readonly<{
      ok: true;
      request: SwapRequest;
      journal: LogicalJournalV1Dto | null;
      attemptedModel: PlacementExecutionInput['ledger'] | null;
      attemptBegun: boolean;
    }>
  | Extract<SwapExecutionResult<never>, { readonly ok: false }>;

type PreparedPlacementRecovery =
  | Readonly<{
      ok: true;
      request: SwapRequest;
      journal: LogicalJournalV1Dto | null;
      attemptBegun: boolean;
    }>
  | Extract<SwapExecutionResult<never>, { readonly ok: false }>;

const recoveryAttemptCommand = (
  journal: LogicalJournalV1Dto,
  direction: 'resume' | 'rollback',
): Readonly<{ command: string; workflow: string }> =>
  direction === 'rollback' && journal.disposition === 'forward'
    ? { command: 'skillsmith-rollback', workflow: 'placement-swap' }
    : { command: journal.context.command, workflow: journal.context.workflow };

const recoveryObservationJournal = (
  input: PlacementExecutionInput,
  direction: 'resume' | 'rollback',
  journal: LogicalJournalV1Dto | null,
): LogicalJournalV1Dto | null => {
  if (journal === null || input.ledger.transactions[journal.transactionId] === undefined) {
    return journal;
  }
  const attemptContext = recoveryAttemptCommand(journal, direction);
  const attempted = beginTransactionRecoveryAttempt(input.ledger, {
    transactionId: journal.transactionId,
    command: attemptContext.command,
    workflow: attemptContext.workflow,
    updatedAt: journal.updatedAt,
  });
  return attempted.ok ? (attempted.value.transactions[journal.transactionId] ?? null) : null;
};

const planPlacementRecovery = (
  input: PlacementExecutionInput,
  direction: 'resume' | 'rollback',
  journal: LogicalJournalV1Dto | null,
): PlannedPlacementRecovery => {
  const request = recoveryRequest(input, journal);
  if (journal === null || input.ledger.transactions[journal.transactionId] === undefined) {
    return Object.freeze({
      ok: true,
      request,
      journal,
      attemptedModel: null,
      attemptBegun: false,
    });
  }
  const attemptContext = recoveryAttemptCommand(journal, direction);
  const attempted = beginTransactionRecoveryAttempt(input.ledger, {
    transactionId: journal.transactionId,
    command: attemptContext.command,
    workflow: attemptContext.workflow,
    updatedAt: request.effects.journalNow(),
  });
  if (!attempted.ok) {
    return Object.freeze({
      ok: false,
      error: flipFailedError(`cannot begin placement recovery: ${attempted.error.message}`),
      state: request.state,
    });
  }
  const attemptedJournal = attempted.value.transactions[journal.transactionId];
  if (attemptedJournal === undefined) {
    return Object.freeze({
      ok: false,
      error: flipFailedError('placement recovery attempt lost its pending transaction'),
      state: request.state,
    });
  }
  return Object.freeze({
    ok: true,
    request,
    journal: attemptedJournal,
    attemptedModel: attempted.value,
    attemptBegun: true,
  });
};

const persistPlacementRecoveryAttempt = async (
  planned: Extract<PlannedPlacementRecovery, { readonly ok: true }>,
): Promise<PreparedPlacementRecovery> => {
  if (planned.attemptedModel === null) {
    return Object.freeze({
      ok: true,
      request: planned.request,
      journal: planned.journal,
      attemptBegun: planned.attemptBegun,
    });
  }
  const persisted = await planned.request.effects.persistLedger(planned.attemptedModel);
  if (!persisted.ok) {
    return Object.freeze({
      ok: false,
      error: persisted.error,
      state: Object.freeze({ ledger: persisted.ledger }),
    });
  }
  const transactionId = planned.journal?.transactionId;
  const durableJournal =
    transactionId === undefined ? undefined : persisted.ledger.transactions[transactionId];
  if (durableJournal === undefined) {
    return Object.freeze({
      ok: false,
      error: flipFailedError('durable placement recovery attempt lost its pending transaction'),
      state: Object.freeze({ ledger: persisted.ledger }),
    });
  }
  return Object.freeze({
    ok: true,
    request: Object.freeze({
      ...planned.request,
      state: Object.freeze({ ledger: persisted.ledger }),
    }),
    journal: durableJournal,
    attemptBegun: planned.attemptBegun,
  });
};

const recoverPlacementInternal = async (
  input: PlacementExecutionInput,
  direction: 'resume' | 'rollback',
  target: PlacementRecoveryTarget,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> => {
  const sourceJournal = journalForTarget(input, target);
  const observationJournal = recoveryObservationJournal(input, direction, sourceJournal);
  const transactionObservation =
    observation === undefined || observationJournal === null
      ? null
      : createTransactionObservation(observation, observationJournal);
  const span =
    transactionObservation === null
      ? null
      : beginRecoveryObservation(transactionObservation, direction);
  try {
    const planned = planPlacementRecovery(input, direction, sourceJournal);
    if (!planned.ok) {
      if (transactionObservation !== null) {
        const completion = recoveryCompletion(planned);
        completeRecoveryObservation(
          transactionObservation,
          span,
          completion.outcome,
          completion.errorCode,
        );
      }
      return planned;
    }
    const prepared = await persistPlacementRecoveryAttempt(planned);
    if (!prepared.ok) {
      if (transactionObservation !== null) {
        const completion = recoveryCompletion(prepared);
        completeRecoveryObservation(
          transactionObservation,
          span,
          completion.outcome,
          completion.errorCode,
        );
      }
      return prepared;
    }
    const recovered =
      direction === 'resume'
        ? observation === undefined
          ? await resumeSwap(prepared.request, target.skill, target.tool, target.scopeKey ?? null)
          : await resumeSwapObserved(
              prepared.request,
              target.skill,
              target.tool,
              target.scopeKey ?? null,
              observation,
            )
        : observation === undefined
          ? await (prepared.attemptBegun
              ? rollbackSwapAfterRecoveryAttempt(
                  prepared.request,
                  target.skill,
                  target.tool,
                  target.scopeKey ?? null,
                )
              : rollbackSwap(prepared.request, target.skill, target.tool, target.scopeKey ?? null))
          : await rollbackSwapObserved(
              prepared.request,
              target.skill,
              target.tool,
              target.scopeKey ?? null,
              observation,
            );
    if (transactionObservation !== null) {
      const completion = recoveryCompletion(recovered);
      completeRecoveryObservation(
        transactionObservation,
        span,
        completion.outcome,
        completion.errorCode,
      );
    }
    return recovered;
  } catch (error) {
    if (transactionObservation !== null) {
      const cancelled = isExecutionCancellation(error, input.signal);
      completeRecoveryObservation(
        transactionObservation,
        span,
        cancelled ? 'cancelled' : 'failure',
        cancelled ? 'cancelled' : (safeErrorCode(error) ?? 'recovery-threw'),
      );
    }
    throw error;
  }
};

export const recoverPlacement = (
  input: PlacementExecutionInput,
  direction: 'resume' | 'rollback',
  target: PlacementRecoveryTarget,
): Promise<SwapExecutionResult<SwapOutcome>> => recoverPlacementInternal(input, direction, target);

export const recoverPlacementObserved = (
  input: PlacementExecutionInput,
  direction: 'resume' | 'rollback',
  target: PlacementRecoveryTarget,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  recoverPlacementInternal(input, direction, target, observation);

export const recoverPlacementWithObservation = (
  input: PlacementExecutionInput,
  direction: 'resume' | 'rollback',
  target: PlacementRecoveryTarget,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  recoverPlacementInternal(input, direction, target, observation);

export const recoverCommittedAcquirePlacements = (
  input: PlacementExecutionInput,
): Promise<SwapExecutionResult<string[]>> =>
  sweepCommittedAcquireJournals(createPlacementSwapRequest(input));

export const recoverCommittedAcquirePlacementsObserved = (
  input: PlacementExecutionInput,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<string[]>> =>
  sweepCommittedAcquireJournalsObserved(createPlacementSwapRequest(input), observation);

export const recoveryRefusedMessage = refusedMessage;
