import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type {
  LedgerMigrationJournalSequence,
  LedgerModel,
  LedgerReadState,
} from '../artifacts/ledger-types.ts';
import type { LedgerMigrationCursor } from '../artifacts/ledger-writer.ts';
import { ledgerByteRevision, resolveLedgerArtifactCodec } from '../artifacts/registry.ts';
import { createExecutionPrecondition } from '../execution/index.ts';
import {
  beginRecoveryObservation,
  beginTransactionStageObservation,
  completeRecoveryObservation,
  completeTransactionStageObservation,
  createTransactionObservation,
  emitTransactionCommitted,
} from '../execution/observation.ts';
import type { ExecutionPrecondition, PreparedExecutionBinding } from '../execution/types.ts';
import type { ObservationBundle, TransactionStage } from '../observation/index.ts';
import {
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
} from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationDigest,
  OperationExecutionResult,
  OperationImage,
} from '../planning/types.ts';
import {
  type LedgerPersistenceError,
  openCallerLedgerWriter,
  runLedgerWriterOperation,
} from './ledger-persistence.ts';
import { readLedgerState } from './ledger.ts';
import type { PlacementPorts } from './types.ts';

const ledgerV2Codec = resolveLedgerArtifactCodec(2);

export type LedgerMigrationCommand = 'install' | 'uninstall' | 'promote' | 'dev';

export interface PreparedLedgerMigration {
  readonly operation: ExecutableOperation;
  readonly expectedState: Extract<LedgerReadState, { readonly state: 'present' }>;
  readonly precondition: ExecutionPrecondition;
}

export const ledgerStateFacts = (state: LedgerReadState): unknown =>
  state.state === 'absent'
    ? { state: 'absent', sourceVersion: null, byteRevision: null, semanticRevision: null }
    : {
        state: 'present',
        sourceVersion: state.sourceVersion,
        byteRevision: state.byteRevision,
        semanticRevision: state.semanticRevision,
      };

const operationDigest = (value: ArtifactDigest): OperationDigest => value as OperationDigest;
const artifactDigest = (value: OperationDigest): ArtifactDigest => value as ArtifactDigest;

export const ledgerMigrationOperation = (
  command: LedgerMigrationCommand,
  selectionSource: ExecutableOperation['selectionSource'],
  ledgerPath: string,
  state: Extract<LedgerReadState, { readonly state: 'present' }>,
  recoveryJournal?: LogicalJournalV1Dto,
): ExecutableOperation => {
  const targetBytes = ledgerV2Codec.encode(state.model);
  if (!targetBytes.ok) {
    throw new TypeError('ledger v1 projection cannot be encoded as canonical v2');
  }
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command,
    skill: null,
    source: null,
    scope: null,
    target: ledgerPath,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind: 'migrate-ledger',
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  return {
    operationId,
    groupId,
    pairId: null,
    kind: 'migrate-ledger',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before:
      recoveryJournal?.intent.before.kind === 'ledger'
        ? {
            ...recoveryJournal.intent.before,
            byteHash: operationDigest(recoveryJournal.intent.before.byteHash),
            semanticHash: operationDigest(recoveryJournal.intent.before.semanticHash),
          }
        : {
            kind: 'ledger',
            projectRoot: null,
            schemaVersion: 1,
            byteHash: operationDigest(state.byteRevision),
            semanticHash: operationDigest(state.semanticRevision),
          },
    after:
      recoveryJournal?.intent.after.kind === 'ledger'
        ? {
            ...recoveryJournal.intent.after,
            byteHash: operationDigest(recoveryJournal.intent.after.byteHash),
            semanticHash: operationDigest(recoveryJournal.intent.after.semanticHash),
          }
        : {
            kind: 'ledger',
            projectRoot: null,
            schemaVersion: 2,
            byteHash: operationDigest(ledgerByteRevision(targetBytes.value)),
            semanticHash: operationDigest(state.semanticRevision),
          },
    reason: { code: 'migrate-ledger', message: 'migrate placement ledger to canonical v2' },
    selectionSource,
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: false, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

export const ledgerMigrationJournals = (
  operation: ExecutableOperation,
  startedAt: string,
  callerIdentity?: Readonly<{
    operationId: string;
    transactionId: string;
    startedAt: string;
    attempt?: number;
  }>,
): LedgerMigrationJournalSequence => {
  if (
    operation.kind !== 'migrate-ledger' ||
    operation.before.kind !== 'ledger' ||
    operation.before.schemaVersion !== 1 ||
    operation.after.kind !== 'ledger' ||
    operation.after.schemaVersion !== 2
  ) {
    throw new TypeError('placement ledger migration operation is invalid');
  }
  const transactionId = callerIdentity?.transactionId ?? `transaction:${operation.operationId}`;
  const journalOperationId = callerIdentity?.operationId ?? operation.operationId;
  const rawJournalStartedAt = callerIdentity?.startedAt ?? startedAt;
  const parsedJournalStartedAt = new Date(rawJournalStartedAt);
  const journalStartedAt = Number.isNaN(parsedJournalStartedAt.valueOf())
    ? rawJournalStartedAt
    : parsedJournalStartedAt.toISOString();
  const beforeImage = {
    kind: 'ledger' as const,
    projectRoot: null,
    schemaVersion: 1 as const,
    byteHash: artifactDigest(operation.before.byteHash),
    semanticHash: artifactDigest(operation.before.semanticHash),
  };
  const afterImage = {
    kind: 'ledger' as const,
    projectRoot: null,
    schemaVersion: 2 as const,
    byteHash: artifactDigest(operation.after.byteHash),
    semanticHash: artifactDigest(operation.after.semanticHash),
  };
  const before = {
    resourceId: 'ledger:placements',
    role: 'ledger' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'artifact-bytes' as const, digest: beforeImage.byteHash },
    schemaVersion: 1 as const,
    semanticHash: beforeImage.semanticHash,
  };
  const after = {
    resourceId: 'ledger:placements',
    role: 'ledger' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'artifact-bytes' as const, digest: afterImage.byteHash },
    schemaVersion: 2 as const,
    semanticHash: afterImage.semanticHash,
  };
  const at = (phase: LogicalJournalV1Dto['phase']): LogicalJournalV1Dto => {
    const committed = phase === 'committed';
    const visible = phase === 'live' || committed;
    return {
      schemaVersion: 1,
      kind: 'skillsmith.transaction-journal',
      transactionId,
      intent: {
        operationId: journalOperationId,
        groupId: operation.groupId,
        pairId: null,
        kind: 'migrate-ledger',
        skill: null,
        source: null,
        tool: null,
        scope: null,
        before: beforeImage,
        after: afterImage,
        mutates: operation.mutates,
        reversibility: { kind: 'none', retentionResourceIds: [] },
        conflict: null,
      },
      context: {
        parentOperationId: journalOperationId,
        command: `skillsmith ${operation.kind}`,
        workflow: 'placement-ledger-migration',
        attempt: callerIdentity?.attempt ?? 1,
        startedAt: journalStartedAt,
      },
      disposition: 'forward',
      phase,
      actual: { before: [before], after: visible ? [after] : [], retained: [] },
      updatedAt: journalStartedAt,
      completedAt: committed ? journalStartedAt : null,
    };
  };
  return {
    prepared: at('prepared'),
    staged: at('staged'),
    backedUp: at('backed-up'),
    live: at('live'),
    committed: at('committed'),
  };
};

const callerLedgerOperationIdentity = (
  env: PlacementPorts,
):
  | Readonly<{
      operationId: string;
      transactionId: string;
      sourceRevision: string | null;
      startedAt: string;
      attempt?: number;
    }>
  | undefined =>
  (
    env as PlacementPorts & {
      readonly ledgerOperationIdentity?: Readonly<{
        operationId: string;
        transactionId: string;
        sourceRevision: string | null;
        startedAt: string;
        attempt?: number;
      }>;
    }
  ).ledgerOperationIdentity;

export const prepareLedgerMigration = (
  env: PlacementPorts,
  command: LedgerMigrationCommand,
  selectionSource: ExecutableOperation['selectionSource'],
  ledgerPath: string,
  state: LedgerReadState,
): PreparedLedgerMigration | null => {
  if (state.state !== 'present') return null;
  const recoveryJournal = Object.values(state.model.transactions).find(
    (journal) => journal.intent.kind === 'migrate-ledger' && journal.intent.pairId === null,
  );
  if (state.sourceVersion !== 1 && recoveryJournal === undefined) return null;
  const operation = ledgerMigrationOperation(
    command,
    selectionSource,
    ledgerPath,
    state,
    recoveryJournal,
  );
  const expected = ledgerStateFacts(state);
  const precondition = createExecutionPrecondition({
    operationIds: [operation.operationId],
    resource: { kind: 'ledger', projectRoot: null },
    expected,
    observe: async () => {
      const current = await readLedgerState(env, ledgerPath);
      if (!current.ok) throw current.error;
      return ledgerStateFacts(current.value);
    },
  });
  return {
    operation: { ...operation, preconditionIds: [precondition.preconditionId] },
    expectedState: state,
    precondition,
  };
};

const ledgerMigrationExecutionBindingInternal = (
  args: Readonly<{
    env: PlacementPorts;
    ledgerPath: string;
    operation: ExecutableOperation;
    expectedState: Extract<LedgerReadState, { readonly state: 'present' }>;
    startedAt: string;
    signal?: AbortSignal;
    onMigrated(model: LedgerModel): void;
  }>,
  observation?: ObservationBundle,
): PreparedExecutionBinding => {
  const { env, ledgerPath, operation, expectedState, startedAt, signal, onMigrated } = args;
  if (
    operation.pairId !== null ||
    operation.before.kind !== 'ledger' ||
    operation.after.kind !== 'ledger'
  ) {
    throw new Error('prepared ledger migration binding is invalid');
  }
  return {
    operationId: operation.operationId,
    groupId: operation.groupId,
    pairId: null,
    unstartedForce: null,
    observeActualBefore: async (): Promise<OperationImage> => {
      const current = await readLedgerState(env, ledgerPath);
      if (!current.ok) throw current.error;
      if (
        canonicalPlanningString(ledgerStateFacts(current.value)) !==
        canonicalPlanningString(ledgerStateFacts(expectedState))
      ) {
        throw new Error('prepared ledger migration source changed');
      }
      return operation.before;
    },
    execute: async (validatedBinding) => {
      const writerFailure = (
        error: LedgerPersistenceError,
        stage: 'preflight' | 'migration' | 'history finalization',
      ): OperationExecutionResult => {
        if (error.code === 'cancelled') {
          return createOperationExecutionResult({
            operationId: operation.operationId,
            outcome: 'cancelled',
            actualBefore: validatedBinding.actualBefore,
            actualAfter: validatedBinding.actualBefore,
            force: null,
            error: null,
          });
        }
        return createOperationExecutionResult({
          operationId: operation.operationId,
          outcome: 'failed',
          actualBefore: validatedBinding.actualBefore,
          actualAfter: validatedBinding.actualBefore,
          force: null,
          error: {
            code:
              stage === 'migration' && error.code === 'stale-state'
                ? 'flip-refused'
                : `ledger-${error.code}`,
            message: `placement ledger migration ${stage} failed: ${error.code}`,
            remediation:
              stage === 'history finalization'
                ? 'Re-run the command to complete ledger recovery.'
                : 'Re-run the command to prepare the current ledger state.',
          },
        });
      };
      const journals = ledgerMigrationJournals(
        operation,
        startedAt,
        callerLedgerOperationIdentity(env),
      );
      let transactionObservation: ObservationBundle | null = null;
      let recoverySpan: ReturnType<typeof beginRecoveryObservation> = null;
      const observedStages = new Set<TransactionStage>();
      const cursorStage = (cursor: LedgerMigrationCursor): TransactionStage | null => {
        if (
          cursor === 'prepared' ||
          cursor === 'staged' ||
          cursor === 'backed-up' ||
          cursor === 'committed'
        ) {
          return cursor;
        }
        return cursor === 'handed-off' ? 'live' : null;
      };
      const afterCursorTransition =
        observation === undefined
          ? undefined
          : (cursor: LedgerMigrationCursor): void => {
              if (transactionObservation === null) return;
              const stage = cursorStage(cursor);
              if (stage === null || observedStages.has(stage)) return;
              const span = beginTransactionStageObservation(transactionObservation, stage);
              completeTransactionStageObservation(transactionObservation, span, 'success', null);
              observedStages.add(stage);
              if (stage === 'committed') emitTransactionCommitted(transactionObservation);
            };
      const opened = await openCallerLedgerWriter(env, ledgerPath, signal, afterCursorTransition);
      if (!opened.ok) return writerFailure(opened.error, 'preflight');
      const writer = opened.value;
      const recoveryJournal = await runLedgerWriterOperation(() =>
        writer.readMigrationRecoveryJournal(),
      );
      if (!recoveryJournal.ok) return writerFailure(recoveryJournal.error, 'preflight');
      const recoveryPending = recoveryJournal.value !== null;
      const beforeRecovery = await runLedgerWriterOperation(() => writer.read());
      if (!beforeRecovery.ok) return writerFailure(beforeRecovery.error, 'preflight');
      const recoveryTransactionId =
        recoveryJournal.value?.transactionId ?? journals.committed.transactionId;
      const alreadyCommittedJournal =
        beforeRecovery.value.state === 'present'
          ? beforeRecovery.value.model.history.find(
              (journal) =>
                journal.transactionId === recoveryTransactionId && journal.phase === 'committed',
            )
          : undefined;
      const wasAlreadyCommitted = alreadyCommittedJournal !== undefined;
      if (
        !wasAlreadyCommitted &&
        recoveryJournal.value !== null &&
        (!Number.isSafeInteger(recoveryJournal.value.context.attempt) ||
          recoveryJournal.value.context.attempt >= Number.MAX_SAFE_INTEGER)
      ) {
        return writerFailure(
          { code: 'invalid-state', path: writer.recoveryPointerPath },
          'preflight',
        );
      }
      if (observation !== undefined) {
        if (wasAlreadyCommitted) observedStages.add('committed');
        const observedJournal =
          alreadyCommittedJournal !== undefined
            ? alreadyCommittedJournal
            : recoveryJournal.value !== null
              ? {
                  ...recoveryJournal.value,
                  context: {
                    ...recoveryJournal.value.context,
                    attempt: recoveryJournal.value.context.attempt + 1,
                  },
                }
              : journals.prepared;
        transactionObservation = createTransactionObservation(observation, observedJournal);
        if (recoveryPending) {
          recoverySpan = beginRecoveryObservation(
            transactionObservation,
            wasAlreadyCommitted ? 'cleanup' : 'resume',
          );
        }
      }
      const completeRecoveryFailure = (error: LedgerPersistenceError): void => {
        if (transactionObservation === null || recoverySpan === null) return;
        completeRecoveryObservation(
          transactionObservation,
          recoverySpan,
          error.code === 'cancelled' ? 'cancelled' : 'failure',
          error.code,
        );
      };
      const migrated = await runLedgerWriterOperation(() =>
        writer.migrateV1ToV2({
          expectedSourceByteRevision: expectedState.byteRevision,
          expectedSourceSemanticRevision: expectedState.semanticRevision,
          journals,
        }),
      );
      if (!migrated.ok) {
        completeRecoveryFailure(migrated.error);
        return writerFailure(migrated.error, 'migration');
      }
      const finalized = await runLedgerWriterOperation(() =>
        writer.finalizeHistory({
          model: migrated.value.model,
          expectedByteRevision: migrated.value.byteRevision,
        }),
      );
      if (!finalized.ok) {
        completeRecoveryFailure(finalized.error);
        return writerFailure(finalized.error, 'history finalization');
      }
      onMigrated(finalized.value.model);
      if (transactionObservation !== null && recoverySpan !== null) {
        completeRecoveryObservation(transactionObservation, recoverySpan, 'success', null);
      }
      return createOperationExecutionResult({
        operationId: operation.operationId,
        outcome: 'succeeded',
        actualBefore: validatedBinding.actualBefore,
        actualAfter: operation.after,
        force: null,
        error: null,
      });
    },
  };
};

export const ledgerMigrationExecutionBinding = (
  args: Parameters<typeof ledgerMigrationExecutionBindingInternal>[0],
): PreparedExecutionBinding => ledgerMigrationExecutionBindingInternal(args);

export const ledgerMigrationExecutionBindingObserved = (
  args: Parameters<typeof ledgerMigrationExecutionBindingInternal>[0],
  observation: ObservationBundle,
): PreparedExecutionBinding => ledgerMigrationExecutionBindingInternal(args, observation);
