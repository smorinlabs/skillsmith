import { dirname, join } from 'node:path';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import { normalizeSourceIdentity } from '../artifacts/identity.ts';
import type {
  JournalResourceActualV1Dto,
  LogicalJournalV1Dto,
} from '../artifacts/journal-types.ts';
import type {
  LedgerModel,
  LedgerPairIdentity,
  LedgerPairV1Dto,
} from '../artifacts/ledger-types.ts';
import {
  deriveLedgerProjectRegistrations,
  legacyJournalMatchesLogicalShadow,
  validateJournalV1DtoShape,
} from '../artifacts/registry.ts';
import { hashSourceContentV1, projectSourceContent } from '../artifacts/source-content.ts';
import type { PathKind } from '../env/types.ts';
import {
  type SkillSmithError,
  cancelledError,
  errorMessage,
  flipFailedError,
  flipRefusedError,
  genericError,
  permissionDeniedError,
  safeErrorCode,
} from '../errors.ts';
import {
  beginRecoveryObservation,
  beginTransactionStageObservation,
  completeRecoveryObservation,
  completeTransactionStageObservation,
  createTransactionObservation,
  emitTransactionCommitted,
  emitTransactionRolledBack,
} from '../execution/observation.ts';
import type {
  ObservationBundle,
  ObservationOutcome,
  TransactionStage,
} from '../observation/index.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { ExecutableOperation, OperationImage } from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { getLedgerPairAt, withLedgerPairAt, withoutLedgerPairAt } from './ledger.ts';
import {
  abortPendingLogicalTransaction,
  abortPendingLogicalTransactionAfterRecoveryAttempt,
  advanceLogicalTransaction,
  commitLogicalTransaction,
} from './logical-transactions.ts';
import { contentHashOf } from './store.ts';
import type {
  FlipTool,
  Journal,
  JournalOp,
  JournalPhase,
  PairRecord,
  SwapCtx,
  SwapEffects,
  SwapExecutionResult,
  SwapOutcome,
  SwapPlan,
  SwapPorts,
  SwapRequest,
  SwapState,
} from './types.ts';

const pairAt = (
  ledger: LedgerModel,
  scopeKey: string | null,
  skill: string,
  tool: string,
): PairRecord | null => {
  const pair = getLedgerPairAt(ledger, scopeKey, skill, tool);
  return pair === null ? null : (structuredClone(pair) as PairRecord);
};

interface SwapLedgerAccess {
  readonly current: () => LedgerModel;
  readonly persist: (candidate: LedgerModel) => Promise<Result<void, SkillSmithError>>;
}

type SwapOperation<T> = (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
) => Promise<Result<T, SkillSmithError>>;

const portableContentHash = async (
  env: SwapPorts,
  path: string,
): Promise<Result<string, SkillSmithError>> => {
  if (!('readFileMetadata' in env) || typeof env.readFileMetadata !== 'function') {
    return err(genericError('portable source metadata authority is unavailable'));
  }
  const projected = await projectSourceContent(
    env as Parameters<typeof projectSourceContent>[0],
    path,
  );
  if (!projected.ok) {
    return err(genericError('portable source content could not be projected'));
  }
  const hashed = hashSourceContentV1(projected.value);
  return hashed.ok
    ? ok(hashed.value)
    : err(genericError('portable source content could not be hashed'));
};

const contentMatchesAnyHash = async (
  env: SwapPorts,
  path: string,
  acceptableHashes: readonly string[],
  v1First: boolean,
): Promise<Result<boolean, SkillSmithError>> => {
  if (v1First) {
    const v1 = await portableContentHash(env, path);
    if (v1.ok && acceptableHashes.includes(v1.value)) return ok(true);
  }
  const legacy = await contentHashOf(env, path);
  return legacy.ok ? ok(acceptableHashes.includes(legacy.value)) : legacy;
};

const executeWithSwapState = async <T>(
  request: SwapRequest,
  operation: SwapOperation<T>,
): Promise<SwapExecutionResult<T>> => {
  let state: SwapState = request.state;
  const ledger: SwapLedgerAccess = Object.freeze({
    current: () => state.ledger,
    persist: async (candidate: LedgerModel) => {
      const persisted = await request.effects.persistLedger(candidate);
      state = Object.freeze({ ledger: persisted.ledger });
      if (!persisted.ok) return err(persisted.error);
      return ok(undefined);
    },
  });
  const result = await operation(request.context, ledger, request.effects);
  return result.ok
    ? Object.freeze({ ok: true, value: result.value, state })
    : Object.freeze({ ok: false, error: result.error, state });
};

const TRANSACTION_STAGES: ReadonlySet<LogicalJournalV1Dto['phase']> = new Set([
  'prepared',
  'staged',
  'backed-up',
  'live',
  'committed',
]);

const journalForOperation = (
  model: LedgerModel,
  operationId: string,
  transactionId: string | null,
): LogicalJournalV1Dto | null => {
  if (transactionId !== null) {
    return (
      model.transactions[transactionId] ??
      model.history.find((journal) => journal.transactionId === transactionId) ??
      null
    );
  }
  const pending = Object.values(model.transactions).find(
    (journal) => journal.intent.operationId === operationId,
  );
  if (pending !== undefined) return pending;
  for (let index = model.history.length - 1; index >= 0; index -= 1) {
    const journal = model.history[index];
    if (journal?.intent.operationId === operationId) return journal;
  }
  return null;
};

const persistenceOutcome = (
  error: unknown,
): Readonly<{ outcome: ObservationOutcome; errorCode: string }> => {
  const code = safeErrorCode(error);
  const cancelled = code === 'cancelled' || code === 'ABORT_ERR' || code === 'AbortError';
  return {
    outcome: cancelled ? 'cancelled' : 'failure',
    errorCode: cancelled ? 'cancelled' : (code ?? 'durable-write-failed'),
  };
};

const observeSwapPersistence = (
  request: SwapRequest,
  observation: ObservationBundle,
  operation: Readonly<{ operationId: string }>,
  rolledBackReasonCode = 'rollback-requested',
  suppressCommittedObservation = false,
): SwapRequest => {
  let transactionId: string | null = null;
  let transactionObservation: ObservationBundle | null = null;
  const completedStages = new Set<TransactionStage>();
  if (suppressCommittedObservation) completedStages.add('committed');
  let terminalEmitted = suppressCommittedObservation;
  return Object.freeze({
    ...request,
    effects: Object.freeze({
      ...request.effects,
      persistLedger: async (candidate: LedgerModel) => {
        const journal = journalForOperation(candidate, operation.operationId, transactionId);
        const stage =
          journal !== null && TRANSACTION_STAGES.has(journal.phase)
            ? (journal.phase as TransactionStage)
            : null;
        if (journal !== null && transactionId === null) transactionId = journal.transactionId;
        if (journal !== null && transactionObservation === null) {
          transactionObservation = createTransactionObservation(observation, journal);
        }
        const stageSpan =
          stage !== null && !completedStages.has(stage) && transactionObservation !== null
            ? beginTransactionStageObservation(transactionObservation, stage)
            : null;
        const persisted = await request.effects.persistLedger(candidate);
        if (stage !== null && !completedStages.has(stage) && transactionObservation !== null) {
          if (persisted.ok) {
            completeTransactionStageObservation(transactionObservation, stageSpan, 'success', null);
            completedStages.add(stage);
            if (stage === 'committed' && !terminalEmitted && journal !== null) {
              if (journal.disposition === 'rollback') {
                emitTransactionRolledBack(transactionObservation, rolledBackReasonCode);
              } else {
                emitTransactionCommitted(transactionObservation);
              }
              terminalEmitted = true;
            }
          } else {
            const completion = persistenceOutcome(persisted.error);
            completeTransactionStageObservation(
              transactionObservation,
              stageSpan,
              completion.outcome,
              completion.errorCode,
            );
          }
        }
        return persisted;
      },
    }),
  });
};

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}` as ArtifactDigest;

const liveActual = (
  image: OperationImage,
  pair: PairRecord,
  fallbackState: 'absent' | 'present',
): JournalResourceActualV1Dto => {
  if (image.kind === 'absent') {
    return {
      resourceId: 'live:placement',
      role: 'live',
      state: 'absent',
      repositoryRevision: null,
      placementPath: pair.placementPath,
      liveKind: null,
      mode: null,
      symlinkTarget: null,
      contentHash: null,
    };
  }
  if (image.kind === 'placement') {
    const digest = (image.contentHash ??
      image.source?.contentHash ??
      ZERO_DIGEST) as ArtifactDigest;
    return {
      resourceId: 'live:placement',
      role: 'live',
      state: 'present',
      repositoryRevision: { kind: 'resource', digest },
      placementPath: pair.placementPath,
      liveKind: image.representation === 'symlink' ? 'symlink' : 'directory',
      mode: image.classification === 'dev' ? 'dev' : 'pinned',
      symlinkTarget: image.linkTarget?.kind === 'machine-bound' ? image.linkTarget.path : null,
      contentHash: image.contentHash as ArtifactDigest | null,
    };
  }
  return fallbackState === 'absent'
    ? {
        resourceId: 'live:placement',
        role: 'live',
        state: 'absent',
        repositoryRevision: null,
        placementPath: pair.placementPath,
        liveKind: null,
        mode: null,
        symlinkTarget: null,
        contentHash: null,
      }
    : {
        resourceId: 'live:placement',
        role: 'live',
        state: 'present',
        repositoryRevision: { kind: 'resource', digest: ZERO_DIGEST },
        placementPath: pair.placementPath,
        liveKind: 'directory',
        mode: pair.mode,
        symlinkTarget: null,
        contentHash: (pair.pinned?.contentHash ?? null) as ArtifactDigest | null,
      };
};

const logicalJournalFor = (
  operation: ExecutableOperation,
  pair: PairRecord,
  shadow: Journal,
): LogicalJournalV1Dto => {
  const visible = shadow.phase === 'live' || shadow.phase === 'committed';
  const imageSource = operation.after.kind === 'placement' ? operation.after.source : null;
  const source =
    operation.kind === 'promote' && operation.source?.kind !== 'portable'
      ? {
          kind: 'portable' as const,
          identity: {
            host: 'local.skillsmith.invalid',
            repository: 'content/placement',
            path: operation.skill,
          },
          requestedRef: null,
          resolvedSha: (
            operation.source?.contentHash ??
            imageSource?.contentHash ??
            pair.pinned?.contentHash ??
            ZERO_DIGEST
          )
            .slice('sha256:'.length)
            .slice(0, 40),
          sourcePath: operation.skill ?? '.',
          contentHash: (operation.source?.contentHash ??
            imageSource?.contentHash ??
            pair.pinned?.contentHash ??
            ZERO_DIGEST) as ArtifactDigest,
        }
      : (operation.source ??
        ((operation.kind === 'install' ||
          operation.kind === 'update' ||
          operation.kind === 'repair') &&
        pair.origin !== undefined &&
        pair.pinned != null
          ? {
              kind: 'portable' as const,
              identity: {
                host: pair.origin.host,
                repository: pair.origin.repo,
                path: pair.origin.skillPath,
              },
              requestedRef: pair.origin.refRequested,
              resolvedSha: pair.origin.refResolved,
              sourcePath: pair.origin.skillPath,
              contentHash: pair.pinned.contentHash as ArtifactDigest,
            }
          : null));
  const afterImage = operation.after;
  const ledger = {
    resourceId: 'ledger:placements',
    role: 'ledger' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'resource' as const, digest: ZERO_DIGEST },
    schemaVersion: 2 as const,
    semanticHash: ZERO_DIGEST,
  };
  return {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId: shadow.txId,
    intent: {
      operationId: operation.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      kind: operation.kind,
      skill: operation.skill,
      source: source as unknown as LogicalJournalV1Dto['intent']['source'],
      tool: operation.tool,
      scope: operation.scope,
      before: operation.before as unknown as LogicalJournalV1Dto['intent']['before'],
      after: afterImage as unknown as LogicalJournalV1Dto['intent']['after'],
      mutates: operation.mutates,
      reversibility: { kind: 'none', retentionResourceIds: [] },
      conflict: null,
    },
    context: {
      parentOperationId: operation.operationId,
      command: 'skillsmith-place',
      workflow: 'placement-swap',
      attempt: 1,
      startedAt: shadow.startedAt,
    },
    disposition: 'forward',
    phase: shadow.phase,
    actual: {
      before: [liveActual(operation.before, pair, 'absent'), ledger],
      after: visible ? [liveActual(afterImage as OperationImage, pair, 'present'), ledger] : [],
      retained: [],
    },
    updatedAt: shadow.completedAt ?? shadow.startedAt,
    completedAt: shadow.completedAt,
  };
};

const recordOnlyBefore = (operation: ExecutableOperation): Journal['before'] => {
  if (operation.before.kind === 'absent') return { mode: 'absent' };
  if (operation.before.kind !== 'placement') return { mode: 'absent' };
  if (operation.before.classification === 'dev') {
    const linkTarget = operation.before.linkTarget ?? operation.before.resource.location;
    return {
      mode: 'dev',
      symlinkTarget: linkTarget.kind === 'machine-bound' ? linkTarget.path : linkTarget.token,
      liveKind: operation.before.representation === 'symlink' ? 'symlink' : 'dir',
    };
  }
  return {
    mode: 'pinned',
    storePath: null,
    contentHash: operation.before.contentHash,
    liveKind: operation.before.representation === 'symlink' ? 'symlink' : 'dir',
  };
};

/**
 * One canonical finalizer for mutations whose live filesystem state is already authoritative.
 * Repair writes the terminal pair plus committed logical history directly, without inventing a
 * physical shadow. Other record-only operations advance their logical/compatibility-shadow phases
 * in memory. Both paths persist exactly one terminal ledger image; there is no recoverable
 * filesystem phase because these callers deliberately perform no live mutation.
 */
const commitRecordOnlyLogicalTransactionInternal = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null = null,
): Promise<Result<void, SkillSmithError>> => {
  if (operation.pairId === null) {
    return err(flipFailedError('record-only logical transaction requires canonical pair identity'));
  }
  const canonicalLedger = ledger.current();
  const transactionId = effects.newTransactionId(canonicalLedger);
  const startedAt = effects.journalNow();
  let stagedModel = canonicalLedger;
  const stagedLedger: SwapLedgerAccess = Object.freeze({
    current: () => stagedModel,
    persist: async (candidate: LedgerModel) => {
      stagedModel = candidate;
      return ok(undefined);
    },
  });
  const journal: Journal = {
    op:
      operation.kind === 'remove' ? 'uninstall' : operation.kind === 'link-dev' ? 'dev' : 'install',
    txId: transactionId,
    phase: 'prepared',
    startedAt,
    completedAt: null,
    before: recordOnlyBefore(operation),
    stagingPath: join(
      dirname(pair.placementPath),
      `.skillsmith-staging-${operation.skill ?? 'skill'}-${transactionId}`,
    ),
    backupPath: join(
      dirname(pair.placementPath),
      `.skillsmith-backup-${operation.skill ?? 'skill'}-${transactionId}`,
    ),
  };
  if (operation.kind === 'repair') {
    if (
      canonicalLedger.transactions[transactionId] !== undefined ||
      canonicalLedger.history.some((candidate) => candidate.transactionId === transactionId)
    ) {
      return err(flipFailedError('record-only repair transaction identity already exists'));
    }
    const completedAt = effects.journalNow();
    const committed = logicalJournalFor(operation, pair, {
      ...journal,
      phase: 'committed',
      completedAt,
    });
    const validation = validateJournalV1DtoShape(committed);
    if (!validation.ok) {
      return err(
        flipFailedError(
          `record-only repair journal is invalid: ${JSON.stringify(validation.error)}`,
        ),
      );
    }
    const terminal = withLedgerPairAt(
      canonicalLedger,
      scopeKey,
      operation.skill ?? '',
      operation.tool ?? '',
      { ...pair, journal: null },
    );
    if (!terminal.ok) return terminal;
    return ledger.persist({
      ...terminal.value,
      history: [...terminal.value.history, committed],
    });
  }
  for (const phase of ['prepared', 'staged', 'backed-up', 'live', 'committed'] as const) {
    if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
    const completedAt = phase === 'committed' ? effects.journalNow() : null;
    const persisted = await persistPair(
      ctx,
      stagedLedger,
      effects,
      scopeKey,
      operation.skill ?? '',
      operation.tool ?? '',
      {
        ...pair,
        journal: { ...journal, phase, completedAt },
      },
    );
    if (!persisted.ok) return persisted;
  }
  return ledger.persist(stagedModel);
};

export const commitRecordOnlyLogicalTransaction = (
  request: SwapRequest,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null = null,
): Promise<SwapExecutionResult<void>> =>
  executeWithSwapState(request, (ctx, ledger, effects) =>
    commitRecordOnlyLogicalTransactionInternal(ctx, ledger, effects, operation, pair, scopeKey),
  );

export const commitRecordOnlyLogicalTransactionObserved = (
  request: SwapRequest,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<void>> =>
  commitRecordOnlyLogicalTransaction(
    observeSwapPersistence(request, observation, operation),
    operation,
    pair,
    scopeKey,
  );

interface MoveScopeTransactionState {
  readonly operation: ExecutableOperation;
  readonly sourceScopeKey: string | null;
  readonly destinationScopeKey: string | null;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly stagingPath: string;
  readonly backupPath: string;
  readonly pair: PairRecord;
}

const moveScopeRoot = (
  image: OperationImage,
): Readonly<{ scopeKey: string | null; path: string }> | null => {
  if (
    image.kind !== 'placement' ||
    image.resource.kind !== 'live' ||
    image.resource.location.kind !== 'machine-bound'
  ) {
    return null;
  }
  const root = image.resource.projectRoot;
  if (image.resource.scope === 'user' && root === null) {
    return { scopeKey: null, path: image.resource.location.path };
  }
  if (image.resource.scope === 'project' && root !== null && root.kind === 'machine-bound') {
    return { scopeKey: root.path, path: image.resource.location.path };
  }
  return null;
};

const moveScopeTransactionState = (
  model: LedgerModel,
  operation: ExecutableOperation,
  transactionId: string,
): Result<MoveScopeTransactionState, SkillSmithError> => {
  if (
    operation.kind !== 'move-scope' ||
    operation.pairId === null ||
    operation.skill === null ||
    operation.tool === null ||
    operation.scope === null ||
    operation.before.kind !== 'placement' ||
    operation.after.kind !== 'placement' ||
    operation.before.resource.skill !== operation.skill ||
    operation.after.resource.skill !== operation.skill ||
    operation.before.resource.tool !== operation.tool ||
    operation.after.resource.tool !== operation.tool ||
    operation.after.resource.scope !== operation.scope
  ) {
    return err(flipFailedError('move-scope operation identity is invalid'));
  }
  const source = moveScopeRoot(operation.before);
  const destination = moveScopeRoot(operation.after);
  if (
    source === null ||
    destination === null ||
    (source.scopeKey === destination.scopeKey && source.path === destination.path)
  ) {
    return err(flipFailedError('move-scope live locations are invalid'));
  }
  const pair = getLedgerPairAt(model, source.scopeKey, operation.skill, operation.tool);
  if (
    pair === null ||
    pair.placementPath !== source.path ||
    pair.journal != null ||
    getLedgerPairAt(model, destination.scopeKey, operation.skill, operation.tool) !== null
  ) {
    return err(flipRefusedError('move-scope ledger membership changed; retry'));
  }
  if (
    operation.source?.kind !== 'portable' ||
    operation.before.source?.kind !== 'portable' ||
    operation.after.source?.kind !== 'portable' ||
    pair.mode !== 'pinned' ||
    pair.pinned == null ||
    pair.origin === undefined ||
    operation.before.contentHash === null ||
    operation.after.contentHash === null ||
    operation.before.contentHash !== operation.after.contentHash ||
    operation.source.contentHash !== operation.before.contentHash ||
    operation.before.source.contentHash !== operation.before.contentHash ||
    operation.after.source.contentHash !== operation.before.contentHash ||
    canonicalPlanningString(operation.before.source) !==
      canonicalPlanningString(operation.source) ||
    canonicalPlanningString(operation.after.source) !== canonicalPlanningString(operation.source) ||
    pair.origin.host !== operation.source.identity.host ||
    pair.origin.repo !== operation.source.identity.repository ||
    pair.origin.skillPath !== operation.source.sourcePath ||
    pair.origin.refRequested !== operation.source.requestedRef ||
    pair.origin.refResolved !== operation.source.resolvedSha ||
    (pair.pinned.gitSha !== null && pair.pinned.gitSha !== operation.source.resolvedSha) ||
    pair.pinned.rev !== operation.source.resolvedSha.slice(0, 12) ||
    pair.pinned.storePath.length === 0 ||
    operation.before.dangling ||
    operation.after.dangling ||
    operation.after.classification !== 'pinned' ||
    (operation.before.representation === 'copy'
      ? operation.before.classification !== 'pinned' || operation.before.linkTarget !== null
      : operation.before.representation === 'symlink'
        ? operation.before.classification !== 'store-linked' ||
          operation.before.linkTarget?.kind !== 'machine-bound' ||
          operation.before.linkTarget.path !== pair.pinned.storePath
        : true) ||
    (operation.after.representation === 'copy'
      ? operation.after.linkTarget !== null
      : operation.after.representation === 'symlink'
        ? operation.after.linkTarget?.kind !== 'machine-bound' ||
          operation.after.linkTarget.path !== pair.pinned.storePath
        : true) ||
    (pair.pinned.placement ?? 'copy') !== operation.before.representation
  ) {
    return err(flipRefusedError('move-scope requires one reproducible pinned source pair'));
  }
  const originIdentity = normalizeSourceIdentity(pair.origin.source, 'move-scope.ledger.origin');
  if (
    !originIdentity.ok ||
    canonicalPlanningString(originIdentity.value) !==
      canonicalPlanningString(operation.source.identity)
  ) {
    return err(flipRefusedError('move-scope requires one reproducible pinned source pair'));
  }
  return ok(
    Object.freeze({
      operation,
      sourceScopeKey: source.scopeKey,
      destinationScopeKey: destination.scopeKey,
      sourcePath: source.path,
      destinationPath: destination.path,
      stagingPath: join(
        dirname(destination.path),
        `.skillsmith-staging-${operation.skill}-${transactionId}`,
      ),
      backupPath: join(
        dirname(source.path),
        `.skillsmith-backup-${operation.skill}-${transactionId}`,
      ),
      pair: structuredClone(pair) as PairRecord,
    }),
  );
};

const moveScopeJournal = (
  state: MoveScopeTransactionState,
  transactionId: string,
  startedAt: string,
): LogicalJournalV1Dto => {
  const ledgerActual = {
    resourceId: 'ledger:placements',
    role: 'ledger' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'resource' as const, digest: ZERO_DIGEST },
    schemaVersion: 2 as const,
    semanticHash: ZERO_DIGEST,
  };
  return {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId,
    intent: {
      operationId: state.operation.operationId,
      groupId: state.operation.groupId,
      pairId: state.operation.pairId,
      kind: state.operation.kind,
      skill: state.operation.skill,
      source: state.operation.source as LogicalJournalV1Dto['intent']['source'],
      tool: state.operation.tool,
      scope: state.operation.scope,
      before: state.operation.before as LogicalJournalV1Dto['intent']['before'],
      after: state.operation.after as LogicalJournalV1Dto['intent']['after'],
      mutates: state.operation.mutates,
      reversibility: state.operation
        .reversibility as LogicalJournalV1Dto['intent']['reversibility'],
      conflict: state.operation.conflict as LogicalJournalV1Dto['intent']['conflict'],
    },
    context: {
      parentOperationId: state.operation.operationId,
      command: 'skillsmith-apply',
      workflow: 'reconcile-move-scope',
      attempt: 1,
      startedAt,
    },
    disposition: 'forward',
    phase: 'prepared',
    actual: {
      before: [liveActual(state.operation.before, state.pair, 'present'), ledgerActual],
      after: [],
      retained: [],
    },
    updatedAt: startedAt,
    completedAt: null,
  };
};

const journalOperation = (journal: LogicalJournalV1Dto): ExecutableOperation => ({
  operationId: journal.intent.operationId,
  groupId: journal.intent.groupId,
  pairId: journal.intent.pairId,
  kind: journal.intent.kind,
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: [],
  },
  skill: journal.intent.skill,
  source: journal.intent.source as ExecutableOperation['source'],
  tool: journal.intent.tool,
  scope: journal.intent.scope,
  before: journal.intent.before as ExecutableOperation['before'],
  after: journal.intent.after as ExecutableOperation['after'],
  reason: { code: 'transaction-recovery', message: 'Recover move-scope transaction.' },
  selectionSource: 'explicit-targets',
  preconditionIds: [],
  requiredCheckIds: [],
  reversibility: journal.intent.reversibility as ExecutableOperation['reversibility'],
  mutates: journal.intent.mutates,
  conflict: journal.intent.conflict as ExecutableOperation['conflict'],
});

const persistMoveScopePhase = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  journal: LogicalJournalV1Dto,
  phase: Exclude<LogicalJournalV1Dto['phase'], 'committed'>,
): Promise<Result<LogicalJournalV1Dto, SkillSmithError>> => {
  const current = ledger.current().transactions[journal.transactionId] ?? journal;
  const visible = phase === 'live';
  const state = moveScopeTransactionState(
    ledger.current(),
    journalOperation(current),
    journal.transactionId,
  );
  if (!state.ok) return state;
  const ledgerActual = current.actual.before.find(({ role }) => role === 'ledger');
  if (ledgerActual === undefined) {
    return err(flipFailedError('move-scope ledger observation is missing'));
  }
  const next: LogicalJournalV1Dto = {
    ...current,
    phase,
    actual: {
      ...current.actual,
      after: visible
        ? [
            liveActual(
              current.intent.after as OperationImage,
              { ...state.value.pair, placementPath: state.value.destinationPath },
              'present',
            ),
            ledgerActual,
          ]
        : [],
    },
    updatedAt: effects.journalNow(),
    completedAt: null,
  };
  const advanced = advanceLogicalTransaction(ledger.current(), next);
  if (!advanced.ok) return err(flipFailedError(advanced.error.message));
  const persisted = await ledger.persist(advanced.value);
  if (!persisted.ok) return persisted;
  if (ctx.pauseAt === phase) await pause(ctx.signal);
  return ok(ledger.current().transactions[journal.transactionId] ?? next);
};

const moveScopeImageMatches = async (
  env: SwapPorts,
  path: string,
  image: Extract<OperationImage, { kind: 'placement' }>,
  operation: ExecutableOperation,
): Promise<boolean> => {
  const kind = await env.pathKind(path);
  if (image.representation === 'symlink') {
    return (
      kind === 'symlink' &&
      image.linkTarget?.kind === 'machine-bound' &&
      (await env.readLink(path)) === image.linkTarget.path
    );
  }
  if (image.representation !== 'copy' || kind !== 'dir' || image.contentHash === null) return false;
  const matches = await contentMatchesAnyHash(
    env,
    path,
    [image.contentHash],
    operation.source?.kind === 'portable',
  );
  return matches.ok && matches.value;
};

const buildMoveScopeStaging = async (
  ctx: SwapCtx,
  state: MoveScopeTransactionState,
): Promise<Result<void, SkillSmithError>> => {
  const after = state.operation.after;
  if (after.kind !== 'placement') return err(flipFailedError('move-scope after-image is invalid'));
  try {
    if (after.representation === 'symlink') {
      if (after.linkTarget?.kind !== 'machine-bound') {
        return err(flipFailedError('move-scope symlink target is invalid'));
      }
      await ctx.env.makeSymlink(after.linkTarget.path, state.stagingPath);
      return ok(undefined);
    }
    if (after.representation !== 'copy' || state.pair.pinned == null) {
      return err(flipFailedError('move-scope representation is unsupported'));
    }
    await ctx.env.copyTree(state.pair.pinned.storePath, state.stagingPath);
    await fsyncTree(ctx.env, state.stagingPath);
    return (await moveScopeImageMatches(ctx.env, state.stagingPath, after, state.operation))
      ? ok(undefined)
      : err(flipFailedError('move-scope staging content changed'));
  } catch (error) {
    return err(mapFsErr(error, `cannot stage move-scope ${state.operation.skill ?? 'skill'}`));
  }
};

const commitMoveScope = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  journal: LogicalJournalV1Dto,
  state: MoveScopeTransactionState,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pending = ledger.current().transactions[journal.transactionId];
  if (pending === undefined || pending.phase !== 'live' || pending.disposition !== 'forward') {
    return err(flipFailedError('move-scope transaction is not ready to commit'));
  }
  const completedAt = effects.journalNow();
  const committed = commitLogicalTransaction(ledger.current(), {
    ...pending,
    phase: 'committed',
    updatedAt: completedAt,
    completedAt,
  });
  if (!committed.ok) return err(flipFailedError(committed.error.message));
  const persisted = await ledger.persist(committed.value);
  if (!persisted.ok) return persisted;
  if (ctx.pauseAt === 'committed') await pause(ctx.signal);
  const reclaimed = await reclaimBackup(
    ctx.env,
    state.backupPath,
    [state.operation.before.kind === 'placement' ? state.operation.before.contentHash : null],
    'moved',
  );
  if (!reclaimed.ok) return reclaimed;
  const synced = await guardFs(
    () => ctx.env.fsyncDir(dirname(state.sourcePath)),
    `cannot fsync ${dirname(state.sourcePath)}`,
  );
  return synced.ok ? ok({ committed: true, ...reclaimed.value }) : synced;
};

const forwardMoveScope = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  journal: LogicalJournalV1Dto,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  let pending = ledger.current().transactions[journal.transactionId] ?? journal;
  const state = moveScopeTransactionState(
    ledger.current(),
    journalOperation(pending),
    journal.transactionId,
  );
  if (!state.ok) return state;
  const before = state.value.operation.before;
  const after = state.value.operation.after;
  if (before.kind !== 'placement' || after.kind !== 'placement') {
    return err(flipFailedError('move-scope placement images are invalid'));
  }
  const idx = (): number => PHASE_INDEX[pending.phase];

  if (idx() < PHASE_INDEX.staged) {
    if (ctx.signal?.aborted) return err(cancelledError('interrupted'));
    const stagingKind = await ctx.env.pathKind(state.value.stagingPath);
    if (stagingKind !== 'absent') {
      if (
        !(await moveScopeImageMatches(
          ctx.env,
          state.value.stagingPath,
          after,
          state.value.operation,
        ))
      ) {
        return err(flipRefusedError('move-scope staging path changed; recovery refused'));
      }
    } else {
      const built = await buildMoveScopeStaging(ctx, state.value);
      if (!built.ok) return built;
    }
    const advanced = await persistMoveScopePhase(ctx, ledger, effects, pending, 'staged');
    if (!advanced.ok) return advanced;
    pending = advanced.value;
  }

  if (idx() < PHASE_INDEX['backed-up']) {
    if (ctx.signal?.aborted) return err(cancelledError('interrupted'));
    const advanced = await persistMoveScopePhase(ctx, ledger, effects, pending, 'backed-up');
    if (!advanced.ok) return advanced;
    pending = advanced.value;
  }
  if (idx() <= PHASE_INDEX['backed-up']) {
    const [sourceKind, backupKind] = await Promise.all([
      ctx.env.pathKind(state.value.sourcePath),
      ctx.env.pathKind(state.value.backupPath),
    ]);
    if (sourceKind !== 'absent' && backupKind === 'absent') {
      if (ctx.signal?.aborted) return err(cancelledError('interrupted'));
      if (
        !(await moveScopeImageMatches(
          ctx.env,
          state.value.sourcePath,
          before,
          state.value.operation,
        ))
      ) {
        return err(flipRefusedError('move-scope source changed; recovery refused'));
      }
      const moved = await guardFs(
        () => ctx.env.rename(state.value.sourcePath, state.value.backupPath),
        `cannot back up move-scope ${state.value.operation.skill ?? 'skill'}`,
      );
      if (!moved.ok) return moved;
    } else if (sourceKind === 'absent' && backupKind !== 'absent') {
      if (
        !(await moveScopeImageMatches(
          ctx.env,
          state.value.backupPath,
          before,
          state.value.operation,
        ))
      ) {
        return err(flipRefusedError('move-scope backup changed; recovery refused'));
      }
    } else {
      return err(flipRefusedError('move-scope source/backup state is ambiguous'));
    }
  }

  if (idx() < PHASE_INDEX.live) {
    if (ctx.signal?.aborted) return err(cancelledError('interrupted'));
    const advanced = await persistMoveScopePhase(ctx, ledger, effects, pending, 'live');
    if (!advanced.ok) return advanced;
    pending = advanced.value;
  }
  if (idx() <= PHASE_INDEX.live) {
    const [destinationKind, stagingKind] = await Promise.all([
      ctx.env.pathKind(state.value.destinationPath),
      ctx.env.pathKind(state.value.stagingPath),
    ]);
    if (destinationKind === 'absent' && stagingKind !== 'absent') {
      if (ctx.signal?.aborted) return err(cancelledError('interrupted'));
      if (
        !(await moveScopeImageMatches(
          ctx.env,
          state.value.stagingPath,
          after,
          state.value.operation,
        ))
      ) {
        return err(flipRefusedError('move-scope staging changed; recovery refused'));
      }
      const published = await guardFs(
        () => ctx.env.rename(state.value.stagingPath, state.value.destinationPath),
        `cannot publish move-scope ${state.value.operation.skill ?? 'skill'}`,
      );
      if (!published.ok) return published;
    } else if (destinationKind !== 'absent' && stagingKind === 'absent') {
      if (
        !(await moveScopeImageMatches(
          ctx.env,
          state.value.destinationPath,
          after,
          state.value.operation,
        ))
      ) {
        return err(flipRefusedError('move-scope destination changed; recovery refused'));
      }
    } else {
      return err(flipRefusedError('move-scope destination/staging state is ambiguous'));
    }
  }

  const synced = await Promise.all([
    guardFs(
      () => ctx.env.fsyncDir(dirname(state.value.sourcePath)),
      `cannot fsync ${dirname(state.value.sourcePath)}`,
    ),
    guardFs(
      () => ctx.env.fsyncDir(dirname(state.value.destinationPath)),
      `cannot fsync ${dirname(state.value.destinationPath)}`,
    ),
  ]);
  const syncFailure = synced.find((result) => !result.ok);
  if (syncFailure !== undefined && !syncFailure.ok) return syncFailure;
  return commitMoveScope(ctx, ledger, effects, pending, state.value);
};

const runMoveScopeTransactionInternal = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  operation: ExecutableOperation,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const transactionId = effects.newTransactionId(ledger.current());
  const state = moveScopeTransactionState(ledger.current(), operation, transactionId);
  if (!state.ok) return state;
  const [sourceKind, destinationKind, stagingKind, backupKind] = await Promise.all([
    ctx.env.pathKind(state.value.sourcePath),
    ctx.env.pathKind(state.value.destinationPath),
    ctx.env.pathKind(state.value.stagingPath),
    ctx.env.pathKind(state.value.backupPath),
  ]);
  if (
    sourceKind === 'absent' ||
    destinationKind !== 'absent' ||
    stagingKind !== 'absent' ||
    backupKind !== 'absent' ||
    operation.before.kind !== 'placement' ||
    !(await moveScopeImageMatches(ctx.env, state.value.sourcePath, operation.before, operation))
  ) {
    return err(flipRefusedError('move-scope filesystem precondition changed; retry'));
  }
  const journal = moveScopeJournal(state.value, transactionId, effects.journalNow());
  const advanced = advanceLogicalTransaction(ledger.current(), journal);
  if (!advanced.ok) return err(flipFailedError(advanced.error.message));
  const persisted = await ledger.persist(advanced.value);
  if (!persisted.ok) return persisted;
  if (ctx.pauseAt === 'prepared') await pause(ctx.signal);
  return forwardMoveScope(ctx, ledger, effects, journal);
};

export const runMoveScopeTransaction = (
  request: SwapRequest,
  operation: ExecutableOperation,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  executeWithSwapState(request, (ctx, ledger, effects) =>
    runMoveScopeTransactionInternal(ctx, ledger, effects, operation),
  );

export const runMoveScopeTransactionObserved = (
  request: SwapRequest,
  operation: ExecutableOperation,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  runMoveScopeTransaction(observeSwapPersistence(request, observation, operation), operation);

export const resumeMoveScopeTransaction = (
  request: SwapRequest,
  journal: LogicalJournalV1Dto,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  executeWithSwapState(request, (ctx, ledger, effects) => {
    const durable = ledger.current().transactions[journal.transactionId] ?? journal;
    return durable.disposition === 'rollback'
      ? rollbackMoveScopeTransactionInternal(ctx, ledger, effects, durable, true)
      : forwardMoveScope(ctx, ledger, effects, durable);
  });

export const resumeMoveScopeTransactionObserved = (
  request: SwapRequest,
  journal: LogicalJournalV1Dto,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  resumeMoveScopeTransaction(
    observeSwapPersistence(request, observation, { operationId: journal.intent.operationId }),
    journal,
  );

const rollbackMoveScopeTransactionInternal = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  journal: LogicalJournalV1Dto,
  recoveryAttemptBegun: boolean,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pending = ledger.current().transactions[journal.transactionId];
  if (pending === undefined || pending.intent.kind !== 'move-scope') {
    return err(flipRefusedError('move-scope transaction is not pending'));
  }
  const state = moveScopeTransactionState(
    ledger.current(),
    journalOperation(pending),
    journal.transactionId,
  );
  if (!state.ok) return state;
  const before = state.value.operation.before;
  const after = state.value.operation.after;
  if (before.kind !== 'placement' || after.kind !== 'placement') {
    return err(flipFailedError('move-scope rollback images are invalid'));
  }
  let rollback = pending;
  if (pending.disposition === 'forward') {
    const abort = recoveryAttemptBegun
      ? abortPendingLogicalTransactionAfterRecoveryAttempt
      : abortPendingLogicalTransaction;
    const aborted = abort(ledger.current(), {
      transactionId: pending.transactionId,
      pairId: pending.intent.pairId,
      command: recoveryAttemptBegun ? pending.context.command : 'skillsmith-rollback',
      workflow: recoveryAttemptBegun ? pending.context.workflow : 'reconcile-move-scope',
      updatedAt: effects.journalNow(),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    if (!aborted.ok) {
      return err(logicalRollbackError(aborted.error.message, aborted.error.reason === 'cancelled'));
    }
    const persisted = await ledger.persist(aborted.value);
    if (!persisted.ok) return persisted;
    const durableRollback = ledger.current().transactions[journal.transactionId];
    if (durableRollback === undefined || durableRollback.disposition !== 'rollback') {
      return err(flipFailedError('durable move-scope rollback transaction is missing'));
    }
    rollback = durableRollback;
  }

  const [sourceKind, backupKind] = await Promise.all([
    ctx.env.pathKind(state.value.sourcePath),
    ctx.env.pathKind(state.value.backupPath),
  ]);
  if (sourceKind === 'absent') {
    if (backupKind === 'absent') {
      return err(flipRefusedError('move-scope rollback source and backup are both absent'));
    }
    if (
      !(await moveScopeImageMatches(ctx.env, state.value.backupPath, before, state.value.operation))
    ) {
      return err(flipRefusedError('move-scope rollback backup changed; recovery refused'));
    }
    const restored = await guardFs(
      () => ctx.env.rename(state.value.backupPath, state.value.sourcePath),
      `cannot restore move-scope ${state.value.operation.skill ?? 'skill'}`,
    );
    if (!restored.ok) return restored;
  } else {
    if (
      !(await moveScopeImageMatches(ctx.env, state.value.sourcePath, before, state.value.operation))
    ) {
      return err(flipRefusedError('move-scope rollback source changed; recovery refused'));
    }
    if (backupKind !== 'absent') {
      const reclaimed = await reclaimBackup(
        ctx.env,
        state.value.backupPath,
        [before.contentHash],
        'move-scope rollback',
      );
      if (!reclaimed.ok || reclaimed.value.backupKept !== null) {
        return reclaimed.ok
          ? err(flipRefusedError('move-scope rollback backup changed; recovery refused'))
          : reclaimed;
      }
    }
  }

  const destinationKind = await ctx.env.pathKind(state.value.destinationPath);
  if (destinationKind !== 'absent') {
    if (
      !(await moveScopeImageMatches(
        ctx.env,
        state.value.destinationPath,
        after,
        state.value.operation,
      ))
    ) {
      return err(flipRefusedError('move-scope rollback destination changed; recovery refused'));
    }
    const removed = await guardFs(
      () => ctx.env.removeTree(state.value.destinationPath),
      `cannot remove move-scope destination ${state.value.operation.skill ?? 'skill'}`,
    );
    if (!removed.ok) return removed;
  }
  const stagingKind = await ctx.env.pathKind(state.value.stagingPath);
  if (stagingKind !== 'absent') {
    if (
      !(await moveScopeImageMatches(ctx.env, state.value.stagingPath, after, state.value.operation))
    ) {
      return err(flipRefusedError('move-scope rollback staging changed; recovery refused'));
    }
    const removed = await guardFs(
      () => ctx.env.removeTree(state.value.stagingPath),
      `cannot remove move-scope staging ${state.value.operation.skill ?? 'skill'}`,
    );
    if (!removed.ok) return removed;
  }
  const synced = await Promise.all([
    guardFs(
      () => ctx.env.fsyncDir(dirname(state.value.sourcePath)),
      `cannot fsync ${dirname(state.value.sourcePath)}`,
    ),
    guardFs(
      () => ctx.env.fsyncDir(dirname(state.value.destinationPath)),
      `cannot fsync ${dirname(state.value.destinationPath)}`,
    ),
  ]);
  const syncFailure = synced.find((result) => !result.ok);
  if (syncFailure !== undefined && !syncFailure.ok) return syncFailure;

  const completedAt = effects.journalNow();
  const committed = commitLogicalTransaction(ledger.current(), {
    ...rollback,
    phase: 'committed',
    actual: { ...rollback.actual, after: rollback.actual.before },
    updatedAt: completedAt,
    completedAt,
  });
  if (!committed.ok) return err(flipFailedError(committed.error.message));
  const persisted = await ledger.persist(committed.value);
  return persisted.ok ? ok({ committed: true, backupKept: null, warning: null }) : persisted;
};

export const rollbackMoveScopeTransaction = (
  request: SwapRequest,
  journal: LogicalJournalV1Dto,
  recoveryAttemptBegun = false,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  executeWithSwapState(request, (ctx, ledger, effects) =>
    rollbackMoveScopeTransactionInternal(ctx, ledger, effects, journal, recoveryAttemptBegun),
  );

export const rollbackMoveScopeTransactionObserved = (
  request: SwapRequest,
  journal: LogicalJournalV1Dto,
  observation: ObservationBundle,
  recoveryAttemptBegun = false,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  rollbackMoveScopeTransaction(
    observeSwapPersistence(request, observation, { operationId: journal.intent.operationId }),
    journal,
    recoveryAttemptBegun,
  );

const hydrateLogicalPendingFromShadow = (
  model: LedgerModel,
  scopeKey: string | null,
  skill: string,
  tool: string,
  journal: LogicalJournalV1Dto,
): Result<LedgerModel, SkillSmithError> => {
  if (model.transactions[journal.transactionId] !== undefined) return ok(model);
  const pair = getLedgerPairAt(model, scopeKey, skill, tool);
  const shadow = pair?.journal;
  if (
    pair === null ||
    shadow === undefined ||
    shadow === null ||
    shadow.txId !== journal.transactionId ||
    shadow.phase === 'committed'
  ) {
    return ok(model);
  }

  const phases = ['prepared', 'staged', 'backed-up', 'live'] as const;
  const shadowIndex = phases.indexOf(shadow.phase);
  if (shadowIndex < 0) return ok(model);
  const preparedPair = withLedgerPairAt(model, scopeKey, skill, tool, {
    ...pair,
    journal: { ...shadow, phase: 'prepared', completedAt: null },
  });
  if (!preparedPair.ok) return preparedPair;

  let hydrated = preparedPair.value;
  for (const phase of phases.slice(0, shadowIndex + 1)) {
    const pending = hydrated.transactions[journal.transactionId];
    const replay: LogicalJournalV1Dto =
      pending === undefined
        ? {
            ...journal,
            phase: 'prepared',
            actual: { ...journal.actual, after: [] },
            updatedAt: journal.context.startedAt,
            completedAt: null,
          }
        : {
            ...pending,
            phase,
            actual: {
              ...pending.actual,
              after: phase === 'live' ? journal.actual.after : [],
            },
            updatedAt: journal.updatedAt,
            completedAt: null,
          };
    const advanced = advanceLogicalTransaction(hydrated, replay);
    if (!advanced.ok) return err(flipFailedError(advanced.error.message));
    hydrated = advanced.value;
  }
  return ok(hydrated);
};

const persistPair = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  scopeKey: string | null,
  skill: string,
  tool: string,
  pair: PairRecord,
): Promise<Result<void, SkillSmithError>> => {
  let model = ledger.current();
  const operation = ctx.logicalOperation;
  if (operation !== undefined && pair.journal == null && operation.pairId !== null) {
    const pending = Object.values(model.transactions).find(
      (journal) => journal.intent.operationId === operation.operationId,
    );
    if (pending !== undefined) {
      if (pending.phase !== 'live') {
        return err(flipFailedError('logical placement terminal write requires live state'));
      }
      const completedAt = effects.journalNow();
      const committed = commitLogicalTransaction(model, {
        ...pending,
        phase: 'committed',
        updatedAt: completedAt,
        completedAt,
      });
      if (!committed.ok) return err(flipFailedError(committed.error.message));
      return ledger.persist(committed.value);
    }
  }
  if (operation !== undefined && pair.journal != null) {
    const freshJournal = logicalJournalFor(operation, pair, pair.journal);
    const persistedPending = model.transactions[freshJournal.transactionId];
    // A crash can make the freshly observed live image differ from the operation's original
    // before-image (for example, live has already moved to backup). Resume from the durable logical
    // identity and use the fresh journal only for this phase's observed after-resources/timestamps.
    const journal: LogicalJournalV1Dto =
      persistedPending === undefined
        ? freshJournal
        : {
            ...persistedPending,
            phase: freshJournal.phase,
            actual: { ...persistedPending.actual, after: freshJournal.actual.after },
            updatedAt: freshJournal.updatedAt,
            completedAt: freshJournal.completedAt,
          };
    const validation = validateJournalV1DtoShape(journal);
    if (!validation.ok) {
      return err(
        flipFailedError(
          `logical placement journal is invalid: ${JSON.stringify(validation.error)} ${JSON.stringify(journal.intent)}`,
        ),
      );
    }
    const hydrated = hydrateLogicalPendingFromShadow(model, scopeKey, skill, tool, journal);
    if (!hydrated.ok) return hydrated;
    model = hydrated.value;
    if (journal.phase === 'committed') {
      if (model.transactions[journal.transactionId] === undefined) {
        return err(flipFailedError('logical placement transaction is missing at commit'));
      }
      const pendingPair = getLedgerPairAt(model, scopeKey, skill, tool);
      const staged = withLedgerPairAt(model, scopeKey, skill, tool, {
        ...(pair as LedgerPairV1Dto),
        journal: pendingPair?.journal ?? null,
      });
      if (!staged.ok) return staged;
      // Canonical pair replacement validates and normalizes the complete ledger model. Build the
      // terminal record from that normalized pending record so identity comparison is exact even
      // when the codec has canonicalized resource ordering.
      const stagedPending = staged.value.transactions[journal.transactionId];
      if (stagedPending === undefined) {
        return err(flipFailedError('logical placement transaction is missing after pair staging'));
      }
      const terminalJournal: LogicalJournalV1Dto = {
        ...stagedPending,
        phase: 'committed',
        actual: { ...stagedPending.actual, after: journal.actual.after },
        updatedAt: journal.updatedAt,
        completedAt: journal.completedAt,
      };
      const committed = commitLogicalTransaction(staged.value, terminalJournal);
      if (!committed.ok) return err(flipFailedError(committed.error.message));
      model = committed.value;
    } else {
      const pending = model.transactions[journal.transactionId];
      const transitionJournal: LogicalJournalV1Dto =
        pending === undefined
          ? journal
          : {
              ...pending,
              phase: journal.phase,
              actual: { ...pending.actual, after: journal.actual.after },
              updatedAt: journal.updatedAt,
              completedAt: journal.completedAt,
            };
      const base =
        pending === undefined
          ? withLedgerPairAt(model, scopeKey, skill, tool, pair as LedgerPairV1Dto)
          : ok(model);
      if (!base.ok) return base;
      const advanced = advanceLogicalTransaction(base.value, transitionJournal);
      if (!advanced.ok) return err(flipFailedError(advanced.error.message));
      model = advanced.value;
    }
  } else {
    const next = withLedgerPairAt(model, scopeKey, skill, tool, pair as LedgerPairV1Dto);
    if (!next.ok) return next;
    model = next.value;
  }
  return ledger.persist(model);
};

const persistWithoutPair = async (
  ledger: SwapLedgerAccess,
  scopeKey: string | null,
  skill: string,
  tool: string,
): Promise<Result<void, SkillSmithError>> => {
  const next = withoutLedgerPairAt(ledger.current(), scopeKey, skill, tool);
  if (!next.ok) return next;
  return ledger.persist(next.value);
};

const logicalRollbackError = (message: string, cancelled = false): SkillSmithError =>
  cancelled ? cancelledError(message) : flipFailedError(message);

/**
 * Switch the original interrupted transaction to rollback before changing the filesystem. The
 * durable direction change makes a crash after this boundary resume rollback instead of allowing a
 * same-operation retry to drive the interrupted forward transaction to committed.
 */
const prepareLogicalRollback = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  transactionId: string,
  recoveryAttemptBegun = false,
): Promise<Result<LogicalJournalV1Dto | null, SkillSmithError>> => {
  const pending = ledger.current().transactions[transactionId];
  // Canonical ledgers migrated from the legacy schema may still carry an unmatched compatibility
  // shadow. There is no logical transaction to abort in that representation, so retain the legacy
  // journal-clearing path. A matched logical transaction always takes the durable rollback route.
  if (pending === undefined) return ok(null);
  if (pending.disposition === 'rollback') return ok(pending);

  const abort = recoveryAttemptBegun
    ? abortPendingLogicalTransactionAfterRecoveryAttempt
    : abortPendingLogicalTransaction;
  const aborted = abort(ledger.current(), {
    transactionId: pending.transactionId,
    pairId: pending.intent.pairId,
    command: recoveryAttemptBegun ? pending.context.command : 'skillsmith-rollback',
    workflow: recoveryAttemptBegun ? pending.context.workflow : 'placement-swap',
    updatedAt: effects.journalNow(),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (!aborted.ok) {
    return err(logicalRollbackError(aborted.error.message, aborted.error.reason === 'cancelled'));
  }
  const persisted = await ledger.persist(aborted.value);
  if (!persisted.ok) return persisted;

  const rollback = ledger.current().transactions[transactionId];
  return rollback?.disposition === 'rollback'
    ? ok(rollback)
    : err(flipFailedError('durable logical placement rollback transaction is missing'));
};

/** Finish the original transaction as rollback after its before-image is authoritative on disk. */
const commitLogicalRollback = async (
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  transactionId: string,
  scopeKey: string | null,
  skill: string,
  tool: string,
  restoredMode: PairRecord['mode'],
): Promise<Result<void, SkillSmithError>> => {
  const pending = ledger.current().transactions[transactionId];
  if (pending === undefined || pending.disposition !== 'rollback') {
    return err(flipFailedError('logical placement rollback transaction is not pending'));
  }

  let terminalBase = ledger.current();
  if (pending.intent.before.kind !== 'absent') {
    const currentPair = getLedgerPairAt(terminalBase, scopeKey, skill, tool);
    if (currentPair === null) {
      return err(flipFailedError('logical placement rollback pair is missing'));
    }
    const restored = withLedgerPairAt(terminalBase, scopeKey, skill, tool, {
      ...currentPair,
      mode: restoredMode,
    });
    if (!restored.ok) return restored;
    terminalBase = restored.value;
  }

  const terminalPending = terminalBase.transactions[transactionId];
  if (terminalPending === undefined || terminalPending.disposition !== 'rollback') {
    return err(flipFailedError('logical placement rollback transaction was lost during staging'));
  }
  const completedAt = effects.journalNow();
  const committed = commitLogicalTransaction(terminalBase, {
    ...terminalPending,
    phase: 'committed',
    actual: { ...terminalPending.actual, after: terminalPending.actual.before },
    updatedAt: completedAt,
    completedAt,
  });
  if (!committed.ok) return err(flipFailedError(committed.error.message));
  return ledger.persist(committed.value);
};

const PHASE_INDEX: Record<JournalPhase, number> = {
  prepared: 0,
  staged: 1,
  'backed-up': 2,
  live: 3,
  committed: 4,
};

const isPermError = (e: unknown): boolean => {
  const code = safeErrorCode(e);
  return code === 'EACCES' || code === 'EPERM';
};

const mapFsErr = (e: unknown, context: string): SkillSmithError =>
  isPermError(e)
    ? permissionDeniedError(`${context}: ${errorMessage(e)}`)
    : flipFailedError(`${context}: ${errorMessage(e)}`);

const guardFs = async (
  fn: () => Promise<void>,
  context: string,
): Promise<Result<void, SkillSmithError>> => {
  try {
    await fn();
    return ok(undefined);
  } catch (e) {
    return err(mapFsErr(e, context));
  }
};

const stagingNameOf = (skill: string, txId: string): string =>
  `.skillsmith-staging-${skill}-${txId}`;
const backupNameOf = (skill: string, txId: string): string => `.skillsmith-backup-${skill}-${txId}`;

const kindOf = (probe: PathKind): 'symlink' | 'dir' => (probe === 'symlink' ? 'symlink' : 'dir');

// Recursively fsync every regular file under a freshly copied staging tree (durability of P2).
const fsyncTree = async (env: SwapPorts, dir: string): Promise<void> => {
  const names = await env.listDir(dir);
  for (const name of names) {
    const abs = join(dir, name);
    const kind = await env.pathKind(abs);
    if (kind === 'dir') await fsyncTree(env, abs);
    else if (kind === 'file') await env.fsyncFile(abs);
  }
};

// Test seam: hold in a crash window for 30 s (used only by the CLI E2E via SKILLSMITH_TEST_PAUSE_AT).
const pause = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, 30_000);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

// Persist a phase transition (write-ahead) then, if configured, hold in that crash window.
const advance = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  plan: SwapPlan,
  pair: PairRecord,
  j: Journal,
  phase: JournalPhase,
): Promise<Result<void, SkillSmithError>> => {
  j.phase = phase;
  const p = await persistPair(
    ctx,
    ledger,
    effects,
    plan.scopeKey ?? null,
    plan.skill,
    plan.tool,
    pair,
  );
  if (!p.ok) return p;
  if (ctx.pauseAt === phase) await pause(ctx.signal);
  return ok(undefined);
};

// P2: materialize the staging entry under its dot-name (never touches the live path).
const buildStaging = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  j: Journal,
): Promise<Result<void, SkillSmithError>> => {
  const env = ctx.env;
  try {
    if (plan.op === 'promote') {
      if (!plan.promote) return err(genericError('promote plan missing promote payload'));
      await env.copyTree(plan.promote.storePath, j.stagingPath);
      await fsyncTree(env, j.stagingPath);
      const h = await contentHashOf(env, j.stagingPath);
      if (!h.ok) return h;
      if (h.value !== plan.promote.contentHash) {
        return err(
          flipFailedError(
            `staging hash mismatch for ${plan.skill}: expected ${plan.promote.contentHash}`,
          ),
        );
      }
      return ok(undefined);
    }
    if (plan.op === 'install') {
      if (!plan.install) return err(genericError('install plan missing install payload'));
      if (plan.install.build === 'symlink') {
        await env.makeSymlink(plan.install.storePath, j.stagingPath);
        return ok(undefined);
      }
      await env.copyTree(plan.install.storePath, j.stagingPath);
      await fsyncTree(env, j.stagingPath);
      const matches = await contentMatchesAnyHash(
        env,
        j.stagingPath,
        [plan.install.contentHash],
        true,
      );
      if (!matches.ok) return matches;
      if (!matches.value) {
        return err(
          flipFailedError(
            `staging hash mismatch for ${plan.skill}: expected ${plan.install.contentHash}`,
          ),
        );
      }
      return ok(undefined);
    }
    if (plan.op === 'uninstall') return ok(undefined); // no staging phase
    if (!plan.dev) return err(genericError('dev plan missing dev payload'));
    await env.makeSymlink(plan.dev.sourcePath, j.stagingPath);
    return ok(undefined);
  } catch (e) {
    return err(mapFsErr(e, `cannot stage ${plan.skill}`));
  }
};

/** Reclaim a backup left by a two-rename swap. Symlink backups are always removed (the store
 *  target they pointed at is never touched and remains recorded). A dir backup is removed only
 *  when its content matches a store entry recorded on the pair (reproducible); an edited copy is
 *  KEPT with a warning so an unmanaged edit is never silently destroyed. */
const reclaimBackup = async (
  env: SwapPorts,
  backupPath: string,
  acceptableHashes: readonly (string | null | undefined)[],
  label: string,
): Promise<Result<{ backupKept: string | null; warning: string | null }, SkillSmithError>> => {
  try {
    const kind = await env.pathKind(backupPath);
    if (kind === 'absent') return ok({ backupKept: null, warning: null });
    if (kind === 'symlink') {
      await env.removeTree(backupPath);
      return ok({ backupKept: null, warning: null });
    }
    const acceptable = acceptableHashes.filter(
      (h): h is string => typeof h === 'string' && h.length > 0,
    );
    const matches = await contentMatchesAnyHash(env, backupPath, acceptable, true);
    if (!matches.ok) return matches;
    if (matches.value) {
      await env.removeTree(backupPath);
      return ok({ backupKept: null, warning: null });
    }
    return ok({
      backupKept: backupPath,
      warning:
        acceptable.length === 0
          ? `kept backup ${backupPath}: no trusted before-image authorizes removal`
          : `kept backup ${backupPath}: the ${label} copy was edited in place (hash mismatch)`,
    });
  } catch (e) {
    return err(mapFsErr(e, `cannot reclaim backup ${backupPath}`));
  }
};

const trustedInstallBackupHashes = (
  before: Journal['before'],
  newHash: string | null,
  logicalOperation: ExecutableOperation | null | undefined,
): readonly (string | null)[] =>
  logicalOperation?.conflict?.backup === 'required'
    ? []
    : before.mode === 'pinned' && before.contentHash !== null
      ? [newHash, before.contentHash]
      : [];

const trustedPortableRemovalBackupHash = (operation: ExecutableOperation | null | undefined) =>
  operation?.kind === 'remove' &&
  operation.source?.kind === 'portable' &&
  operation.before.kind === 'placement' &&
  operation.before.source?.kind === 'portable' &&
  operation.before.source.contentHash === operation.before.contentHash
    ? operation.before.contentHash
    : null;

// P5: write-ahead commit (durable committed journal) THEN reclaim the backup. Committing first
// keeps the C5 rollback valid — the backup is the only physical copy of the old state and must
// survive until the new live entry is recorded as committed. Promote/dev leave the committed
// journal at rest; acquisition ops (install/uninstall) finish with a terminal write that nulls the
// journal (install) or deletes the pair (uninstall) so no committed acquisition journal survives.
const commit = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  plan: SwapPlan,
  pair: PairRecord,
  j: Journal,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const env = ctx.env;
  const scopeKey = plan.scopeKey ?? null;
  try {
    await env.fsyncDir(plan.skillsRoot);
  } catch (e) {
    return err(mapFsErr(e, `cannot fsync ${plan.skillsRoot}`));
  }

  if (plan.op === 'promote' || plan.op === 'dev') {
    if (plan.op === 'promote') {
      if (!plan.promote) return err(genericError('promote plan missing promote payload'));
      pair.mode = 'pinned';
      pair.pinned = plan.promote.pinned;
      pair.dev = plan.promote.devRecord;
    } else {
      if (!plan.dev) return err(genericError('dev plan missing dev payload'));
      pair.mode = 'dev';
      pair.dev = plan.dev.devRecord;
    }
    j.phase = 'committed';
    j.completedAt = effects.journalNow();
    const persisted = await persistPair(
      ctx,
      ledger,
      effects,
      scopeKey,
      plan.skill,
      plan.tool,
      pair,
    );
    if (!persisted.ok) return persisted;

    // Backup reclamation is authorized by the now-durable committed journal.
    let backupKept: string | null = null;
    let warning: string | null = null;
    try {
      if (plan.op === 'dev') {
        const pinnedHash = pair.pinned?.contentHash ?? null;
        if ((await env.pathKind(j.backupPath)) !== 'absent') {
          if (pinnedHash === null) {
            backupKept = j.backupPath;
            warning = `kept backup ${j.backupPath}: no pinned record to verify the demoted copy`;
          } else {
            const h = await contentHashOf(env, j.backupPath);
            if (!h.ok) return h;
            if (h.value === pinnedHash) {
              await env.removeTree(j.backupPath);
            } else {
              backupKept = j.backupPath;
              warning = `kept backup ${j.backupPath}: demoted copy was edited in place (hash mismatch)`;
            }
          }
        }
      } else if ((await env.pathKind(j.backupPath)) !== 'absent') {
        await env.removeTree(j.backupPath);
      }
      await env.fsyncDir(plan.skillsRoot);
    } catch (e) {
      return err(mapFsErr(e, `cannot reclaim backup for ${plan.skill}`));
    }
    return ok({ committed: true, backupKept, warning });
  }

  if (plan.op === 'install') {
    // The terminal records (mode 'pinned', pinned, origin, dev) were staged at P1. A fresh install
    // (before absent) has no backup: a single terminal write nulls the journal. A replace install
    // needs a write-ahead committed journal to authorize reclaiming the backup, then a terminal
    // write to null the journal.
    if (j.before.mode === 'absent') {
      pair.journal = null;
      const persisted = await persistPair(
        ctx,
        ledger,
        effects,
        scopeKey,
        plan.skill,
        plan.tool,
        pair,
      );
      if (!persisted.ok) return persisted;
      return ok({ committed: true, backupKept: null, warning: null });
    }
    j.phase = 'committed';
    j.completedAt = effects.journalNow();
    const committed = await persistPair(
      ctx,
      ledger,
      effects,
      scopeKey,
      plan.skill,
      plan.tool,
      pair,
    );
    if (!committed.ok) return committed;

    const newHash = plan.install?.contentHash ?? pair.pinned?.contentHash ?? null;
    const reclaimed = await reclaimBackup(
      env,
      j.backupPath,
      trustedInstallBackupHashes(j.before, newHash, ctx.logicalOperation),
      'replaced',
    );
    if (!reclaimed.ok) return reclaimed;
    const synced = await guardFs(
      () => env.fsyncDir(plan.skillsRoot),
      `cannot fsync ${plan.skillsRoot}`,
    );
    if (!synced.ok) return synced;

    pair.journal = null;
    const terminal = await persistPair(ctx, ledger, effects, scopeKey, plan.skill, plan.tool, pair);
    if (!terminal.ok) return terminal;
    return ok({ committed: true, ...reclaimed.value });
  }

  // op === 'uninstall'
  j.phase = 'committed';
  j.completedAt = effects.journalNow();
  const committed = await persistPair(ctx, ledger, effects, scopeKey, plan.skill, plan.tool, pair);
  if (!committed.ok) return committed;

  const reclaimed = await reclaimBackup(
    env,
    j.backupPath,
    [trustedPortableRemovalBackupHash(ctx.logicalOperation), pair.pinned?.contentHash],
    'uninstalled',
  );
  if (!reclaimed.ok) return reclaimed;
  const synced = await guardFs(
    () => env.fsyncDir(plan.skillsRoot),
    `cannot fsync ${plan.skillsRoot}`,
  );
  if (!synced.ok) return synced;

  const terminal = await persistWithoutPair(ledger, scopeKey, plan.skill, plan.tool);
  if (!terminal.ok) return terminal;
  return ok({ committed: true, ...reclaimed.value });
};

// Drive the swap forward from the journal's current phase to committed, probing the filesystem to
// disambiguate the crash window (spec §8.4 right column). Idempotent per phase. Uninstall has no
// staging (P2) and no publish (P4) — only the P3 backup rename and the P5 commit.
const forward = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  plan: SwapPlan,
  pair: PairRecord,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const j = pair.journal;
  if (!j) return err(genericError(`no journal to drive for ${plan.skill}`));
  const env = ctx.env;
  const live = plan.placementPath;
  const idx = (): number => PHASE_INDEX[j.phase];
  const hasStaging = plan.op !== 'uninstall';

  // P2 — build staging (journal at prepared). Skipped for uninstall.
  if (hasStaging && idx() < PHASE_INDEX.staged) {
    if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
    if ((await env.pathKind(j.stagingPath)) !== 'absent') {
      const cleared = await guardFs(() => env.removeTree(j.stagingPath), 'clear staging remnant');
      if (!cleared.ok) return cleared;
    }
    const built = await buildStaging(ctx, plan, j);
    if (!built.ok) return built;
    const p = await advance(ctx, ledger, effects, plan, pair, j, 'staged');
    if (!p.ok) return p;
  }

  // Uninstall has no physical staging artifact, but its logical transaction still traverses the
  // complete adjacent phase protocol. Persist the staged state before backing up/removing live.
  if (!hasStaging && idx() < PHASE_INDEX.staged) {
    const p = await advance(ctx, ledger, effects, plan, pair, j, 'staged');
    if (!p.ok) return p;
  }

  // P3 — persist backed-up, then rename(live → backup) if the live path is still the old entry.
  if (idx() < PHASE_INDEX['backed-up']) {
    if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
    const p = await advance(ctx, ledger, effects, plan, pair, j, 'backed-up');
    if (!p.ok) return p;
  }
  if (idx() <= PHASE_INDEX['backed-up']) {
    if ((await env.pathKind(live)) !== 'absent') {
      if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
      const r = await guardFs(() => env.rename(live, j.backupPath), `back up ${plan.skill}`);
      if (!r.ok) return r;
    }
  }

  // P4 — persist live, then rename(staging → live) if the live path is still absent. Skipped for
  // uninstall (nothing is published).
  if (hasStaging) {
    if (idx() < PHASE_INDEX.live) {
      const p = await advance(ctx, ledger, effects, plan, pair, j, 'live');
      if (!p.ok) return p;
    }
    if (idx() <= PHASE_INDEX.live) {
      if ((await env.pathKind(live)) === 'absent') {
        if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
        const r = await guardFs(() => env.rename(j.stagingPath, live), `install ${plan.skill}`);
        if (!r.ok) return r;
      }
    }
  } else if (idx() < PHASE_INDEX.live) {
    // Removing the live entry is the uninstall operation's published state. Record that logical
    // visibility before committing so forward transactions obey the same live-before-commit rule.
    const p = await advance(ctx, ledger, effects, plan, pair, j, 'live');
    if (!p.ok) return p;
  }

  // P5 — commit.
  if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
  return commit(ctx, ledger, effects, plan, pair, j);
};

export const refusedMessage = (op: JournalOp, skill: string, source?: string): string => {
  if (op === 'install') {
    return (
      `a previous install of ${skill} was interrupted. ` +
      `Run 'skillsmith promote --rollback ${skill}' (or 'skillsmith dev --rollback ${skill}') ` +
      `to restore the previous state, or re-run 'skillsmith install ${source ?? skill}' to complete it.`
    );
  }
  if (op === 'uninstall') {
    return (
      `a previous uninstall of ${skill} was interrupted. ` +
      `Run 'skillsmith promote --rollback ${skill}' (or 'skillsmith dev --rollback ${skill}') ` +
      `to restore the previous state, or re-run 'skillsmith uninstall ${skill}' to complete it.`
    );
  }
  return (
    `a previous ${op} of ${skill} was interrupted. ` +
    `Run 'skillsmith ${op} --rollback ${skill}' to restore the previous state, ` +
    `or re-run 'skillsmith ${op} ${skill}' to complete the swap.`
  );
};

// Compute the journal `before` record (the pre-swap live state) for a fresh swap.
const computeBefore = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  existing: PairRecord | null,
  liveKind: PathKind,
): Promise<Result<Journal['before'], SkillSmithError>> => {
  const readLive = async (): Promise<Result<string, SkillSmithError>> => {
    try {
      return ok(await ctx.env.readLink(plan.placementPath));
    } catch (e) {
      return err(mapFsErr(e, `cannot read live symlink for ${plan.skill}`));
    }
  };

  if (plan.op === 'promote') {
    const t = await readLive();
    if (!t.ok) return t;
    return ok({ mode: 'dev', symlinkTarget: t.value, liveKind: kindOf(liveKind) });
  }
  if (plan.op === 'dev') {
    return ok({
      mode: 'pinned',
      storePath: existing?.pinned?.storePath ?? null,
      contentHash: existing?.pinned?.contentHash ?? null,
      liveKind: kindOf(liveKind),
    });
  }
  if (plan.op === 'install') {
    if (liveKind === 'absent') {
      // Fresh install. The run layer routes any pair holding prior records through the replace
      // path, so a fresh install must land on a genuinely empty slot.
      if (existing?.pinned || existing?.dev) {
        return err(
          genericError(
            `fresh install precondition violated for ${plan.skill}: pair holds prior records`,
          ),
        );
      }
      return ok({ mode: 'absent' });
    }
    // Replace install. `rollbackSwap` decides "live is the new artifact" (P4 done): for a
    // kind-changing swap by the kind flip; for symlink→symlink by the recorded old symlink target;
    // and for a logical copy→copy update by exact before/after content hashes (see rollbackSwap).
    const newBuildKind = plan.install?.build === 'symlink' ? 'symlink' : 'dir';
    const oldKind = kindOf(liveKind);
    if (newBuildKind === 'dir' && oldKind === 'dir') {
      const logical = ctx.logicalOperation;
      const beforeHash = logical?.before.kind === 'placement' ? logical.before.contentHash : null;
      const afterHash = logical?.after.kind === 'placement' ? logical.after.contentHash : null;
      if (
        (logical?.kind !== 'update' && logical?.kind !== 'repair') ||
        logical.after.kind !== 'placement' ||
        logical.after.representation !== 'copy' ||
        beforeHash === null ||
        afterHash === null ||
        beforeHash === afterHash ||
        afterHash !== plan.install?.contentHash
      ) {
        return err(
          genericError(
            `same-kind replace of ${plan.skill} (dir → dir) lacks exact logical before/after hashes`,
          ),
        );
      }
    }
    // Record the old symlink target for ANY symlink pre-state so rollback can disambiguate a
    // symlink→symlink replace via the target. `adoptedDev` is the run layer's signal that the live
    // symlink points outside the store (governs dev-vs-pinned mode); if it forgets to set it, that
    // dev record is silently lost (recorded as pinned instead of dev).
    let symlinkTarget: string | null = null;
    if (oldKind === 'symlink') {
      const t = await readLive();
      if (!t.ok) return t;
      symlinkTarget = t.value;
    }
    if (plan.install?.adoptedDev) {
      if (symlinkTarget === null) {
        return err(
          genericError(`cannot adopt dev source for ${plan.skill}: live is not a symlink`),
        );
      }
      return ok({ mode: 'dev', symlinkTarget, liveKind: 'symlink' });
    }
    return ok({
      mode: 'pinned',
      storePath: existing?.pinned?.storePath ?? null,
      contentHash:
        newBuildKind === 'dir' &&
        oldKind === 'dir' &&
        ctx.logicalOperation?.before.kind === 'placement'
          ? ctx.logicalOperation.before.contentHash
          : (existing?.pinned?.contentHash ?? null),
      liveKind: oldKind,
      ...(symlinkTarget !== null ? { symlinkTarget } : {}),
    });
  }
  // op === 'uninstall'
  if (!existing) return err(genericError(`cannot uninstall ${plan.skill}: no pair record`));
  if (existing.mode === 'dev') {
    const t = await readLive();
    if (!t.ok) return t;
    return ok({ mode: 'dev', symlinkTarget: t.value, liveKind: kindOf(liveKind) });
  }
  // Record the old symlink target for a store-symlink placement too, so rollback's symlink branch
  // always has it (uninstall is symlink→absent, so a live symlink at rollback is always the OLD one;
  // recording the target keeps that branch well-defined rather than tripping its fail-loud guard).
  let uninstallTarget: string | null = null;
  if (kindOf(liveKind) === 'symlink') {
    const t = await readLive();
    if (!t.ok) return t;
    uninstallTarget = t.value;
  }
  return ok({
    mode: 'pinned',
    storePath: existing.pinned?.storePath ?? null,
    contentHash: existing.pinned?.contentHash ?? null,
    liveKind: kindOf(liveKind),
    ...(uninstallTarget !== null ? { symlinkTarget: uninstallTarget } : {}),
  });
};

// Build the pair record to stage behind the uncommitted journal at P1.
const stagePair = (
  plan: SwapPlan,
  existing: PairRecord | null,
  before: Journal['before'],
  journal: Journal,
): Result<PairRecord, SkillSmithError> => {
  if (plan.op === 'install') {
    if (!plan.install) return err(genericError('install plan missing install payload'));
    return ok({
      placementPath: plan.placementPath,
      mode: 'pinned',
      dev: plan.install.adoptedDev ?? existing?.dev ?? null,
      pinned: plan.install.pinned,
      ...(plan.install.origin === null ? {} : { origin: plan.install.origin }),
      journal,
    });
  }
  if (plan.op === 'uninstall') {
    if (!existing) return err(genericError(`cannot uninstall ${plan.skill}: no pair record`));
    return ok({ ...existing, journal });
  }
  // promote / dev — mode stays the before-mode until P5 (P12 shape, unchanged).
  const mode = before.mode === 'dev' ? 'dev' : 'pinned';
  return ok({
    placementPath: plan.placementPath,
    mode,
    dev: plan.op === 'promote' ? (plan.promote?.devRecord ?? null) : (plan.dev?.devRecord ?? null),
    pinned: plan.op === 'promote' ? (plan.promote?.pinned ?? null) : (existing?.pinned ?? null),
    ...(existing?.origin ? { origin: existing.origin } : {}),
    journal,
  });
};

/** Start a fresh journaled swap. Refuses (flip-refused) when the pair carries an uncommitted
 *  journal — the caller must rollback or resume it first (Global Constraint 6). */
const runSwapInternal = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  plan: SwapPlan,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const scopeKey = plan.scopeKey ?? null;
  const existing = pairAt(ledger.current(), scopeKey, plan.skill, plan.tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    return err(
      flipRefusedError(
        refusedMessage(existing.journal.op, plan.skill, plan.install?.origin?.source),
      ),
    );
  }

  let liveKind: PathKind;
  try {
    liveKind = await ctx.env.pathKind(plan.placementPath);
  } catch (e) {
    return err(mapFsErr(e, `cannot probe live path for ${plan.skill}`));
  }

  const beforeRes = await computeBefore(ctx, plan, existing, liveKind);
  if (!beforeRes.ok) return beforeRes;
  const before = beforeRes.value;

  const txId = effects.newTransactionId(ledger.current());
  const journal: Journal = {
    op: plan.op,
    txId,
    phase: 'prepared',
    startedAt: effects.journalNow(),
    completedAt: null,
    before,
    stagingPath: join(plan.skillsRoot, stagingNameOf(plan.skill, txId)),
    backupPath: join(plan.skillsRoot, backupNameOf(plan.skill, txId)),
  };

  const pairRes = stagePair(plan, existing, before, journal);
  if (!pairRes.ok) return pairRes;
  const pair = pairRes.value;
  const p1 = await persistPair(ctx, ledger, effects, scopeKey, plan.skill, plan.tool, pair);
  if (!p1.ok) return p1;
  if (ctx.pauseAt === 'prepared') await pause(ctx.signal);

  return forward(ctx, ledger, effects, plan, pair);
};

export const runSwap = (
  request: SwapRequest,
  plan: SwapPlan,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  executeWithSwapState(request, (ctx, ledger, effects) =>
    runSwapInternal(ctx, ledger, effects, plan),
  );

export const runSwapObserved = (
  request: SwapRequest,
  plan: SwapPlan,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> => {
  const operation = request.context.logicalOperation;
  return operation === undefined
    ? runSwap(request, plan)
    : runSwap(observeSwapPersistence(request, observation, operation), plan);
};

const reconstructPlan = (
  model: LedgerModel,
  pair: PairRecord,
  j: Journal,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null,
): Result<SwapPlan, SkillSmithError> => {
  const base = {
    skill,
    tool,
    skillsRoot: dirname(pair.placementPath),
    placementPath: pair.placementPath,
    scopeKey,
  };
  if (j.op === 'promote') {
    if (!pair.pinned) return err(genericError(`cannot resume promote of ${skill}: pinned missing`));
    if (!pair.dev) return err(genericError(`cannot resume promote of ${skill}: dev missing`));
    return ok({
      ...base,
      op: 'promote',
      promote: {
        storePath: pair.pinned.storePath,
        contentHash: pair.pinned.contentHash,
        pinned: pair.pinned,
        devRecord: pair.dev,
      },
    });
  }
  if (j.op === 'dev') {
    if (!pair.dev) return err(genericError(`cannot resume dev of ${skill}: dev missing`));
    return ok({
      ...base,
      op: 'dev',
      dev: { sourcePath: pair.dev.sourcePath, devRecord: pair.dev },
    });
  }
  if (j.op === 'install') {
    if (!pair.pinned) return err(genericError(`cannot resume install of ${skill}: pinned missing`));
    const logicalJournal =
      model.transactions[j.txId] ??
      model.history.find((candidate) => candidate.transactionId === j.txId) ??
      null;
    const localIntent = logicalJournal?.intent;
    const localAfter = localIntent?.after;
    const localResume =
      pair.origin === undefined &&
      (pair.pinned.placement ?? 'copy') === 'copy' &&
      localIntent !== undefined &&
      (localIntent.kind === 'install' || localIntent.kind === 'update') &&
      localIntent.skill === skill &&
      localIntent.tool === tool &&
      localIntent.scope === (scopeKey === null ? 'user' : 'project') &&
      localIntent.source?.kind === 'local-dev' &&
      (localIntent.kind === 'install'
        ? localIntent.before.kind === 'absent'
        : localIntent.before.kind === 'placement') &&
      localAfter?.kind === 'placement' &&
      localAfter.resource.kind === 'live' &&
      localAfter.resource.skill === skill &&
      localAfter.resource.tool === tool &&
      localAfter.resource.scope === (scopeKey === null ? 'user' : 'project') &&
      localAfter.resource.location.kind === 'machine-bound' &&
      localAfter.resource.location.path === pair.placementPath &&
      localAfter.classification === 'pinned' &&
      localAfter.representation === 'copy' &&
      localAfter.linkTarget === null &&
      !localAfter.dangling &&
      localAfter.source?.kind === 'local-dev' &&
      localAfter.source.path === localIntent.source.path &&
      localAfter.source.contentHash === localIntent.source.contentHash &&
      localAfter.contentHash === localIntent.source.contentHash &&
      pair.pinned.contentHash === localIntent.source.contentHash &&
      pair.pinned.storePath.length > 0;
    if (pair.origin === undefined && !localResume) {
      return err(genericError(`cannot resume install of ${skill}: origin missing`));
    }
    return ok({
      ...base,
      op: 'install',
      install: {
        build: pair.pinned.placement === 'symlink' ? 'symlink' : 'copy',
        storePath: pair.pinned.storePath,
        contentHash: pair.pinned.contentHash,
        pinned: pair.pinned,
        origin: pair.origin ?? null,
        adoptedDev: pair.dev,
      },
    });
  }
  if (j.op === 'uninstall') {
    return ok({ ...base, op: 'uninstall' });
  }
  return err(genericError(`cannot resume journal op '${j.op}' for ${skill}`));
};

/** Same-op re-run continuation (spec §8.4 right column). Reconstructs the plan from the ledger and
 *  drives the journal forward to committed; a committed journal only reclaims residue and finishes
 *  the terminal transition.
 *  Warning: called on an already-`committed` journal, this still returns `ok({committed: true})` —
 *  that means "residue reclaimed", never "this call just performed the swap"; callers must not
 *  count it as a fresh success. */
const resumeSwapInternal = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null = null,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pair = pairAt(ledger.current(), scopeKey, skill, tool);
  const j = pair?.journal ?? null;
  if (!pair || !j) return err(flipRefusedError(`nothing to resume for ${skill}`));
  const plan = reconstructPlan(ledger.current(), pair, j, skill, tool, scopeKey);
  if (!plan.ok) return plan;
  const logicalJournal =
    ledger.current().transactions[j.txId] ??
    ledger.current().history.find((candidate) => candidate.transactionId === j.txId) ??
    null;
  const resumedContext: SwapCtx =
    ctx.logicalOperation !== undefined || logicalJournal === null
      ? ctx
      : Object.freeze({ ...ctx, logicalOperation: journalOperation(logicalJournal) });
  return forward(resumedContext, ledger, effects, plan.value, pair);
};

export const resumeSwap = (
  request: SwapRequest,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null = null,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  executeWithSwapState(request, (ctx, ledger, effects) =>
    resumeSwapInternal(ctx, ledger, effects, skill, tool, scopeKey),
  );

const recoveryOperationId = (
  request: SwapRequest,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null,
): string | null => {
  const pair = pairAt(request.state.ledger, scopeKey, skill, tool);
  const transactionId = pair?.journal?.txId;
  if (transactionId === undefined) return null;
  return (
    request.state.ledger.transactions[transactionId]?.intent.operationId ??
    request.state.ledger.history.find((journal) => journal.transactionId === transactionId)?.intent
      .operationId ??
    null
  );
};

export const resumeSwapObserved = (
  request: SwapRequest,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> => {
  const committedCleanup =
    pairAt(request.state.ledger, scopeKey, skill, tool)?.journal?.phase === 'committed';
  const operationId = recoveryOperationId(request, skill, tool, scopeKey);
  return operationId === null
    ? resumeSwap(request, skill, tool, scopeKey)
    : resumeSwap(
        observeSwapPersistence(
          request,
          observation,
          { operationId },
          'rollback-requested',
          committedCleanup,
        ),
        skill,
        tool,
        scopeKey,
      );
};

/** Uncommitted-journal recovery (spec §8.4 --rollback column). Restores the before-state with at
 *  most two renames and clears the journal. A committed promote/dev/install is refused — the run
 *  layer performs the inverse via the retained records. A committed uninstall is still reversible
 *  while its backup survives (rename it back); once reclaimed it is terminal. A fresh install
 *  (before absent) rolls back to "nothing there": the new artifact and pair record are removed. */
const rollbackSwapInternal = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null = null,
  recoveryAttemptBegun = false,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pair = pairAt(ledger.current(), scopeKey, skill, tool);
  const j = pair?.journal ?? null;
  if (!pair || !j) return err(flipRefusedError(`nothing to roll back for ${skill}`));

  const env = ctx.env;
  const live = pair.placementPath;
  const before = j.before;

  if (j.phase === 'committed') {
    if (j.op === 'uninstall' && (await env.pathKind(j.backupPath)) !== 'absent') {
      try {
        if ((await env.pathKind(live)) === 'absent') await env.rename(j.backupPath, live);
      } catch (e) {
        return err(mapFsErr(e, `cannot roll back ${skill}`));
      }
      pair.journal = null;
      const persisted = await persistPair(ctx, ledger, effects, scopeKey, skill, tool, pair);
      if (!persisted.ok) return persisted;
      return ok({ committed: false, backupKept: null, warning: null });
    }
    return err(flipRefusedError(`cannot roll back a committed ${j.op} of ${skill}`));
  }

  const logicalRollback = await prepareLogicalRollback(
    ctx,
    ledger,
    effects,
    j.txId,
    recoveryAttemptBegun,
  );
  if (!logicalRollback.ok) return logicalRollback;

  // Fresh install: the only live entry that can exist is the new artifact. Restore "nothing there".
  if (before.mode === 'absent') {
    try {
      if ((await env.pathKind(live)) !== 'absent') await env.removeTree(live);
      if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
    } catch (e) {
      return err(mapFsErr(e, `cannot roll back ${skill}`));
    }
    const persisted =
      logicalRollback.value === null
        ? await persistWithoutPair(ledger, scopeKey, skill, tool)
        : await commitLogicalRollback(ledger, effects, j.txId, scopeKey, skill, tool, pair.mode);
    if (!persisted.ok) return persisted;
    return ok({ committed: false, backupKept: null, warning: null });
  }

  const oldKind = before.liveKind ?? (before.mode === 'dev' ? 'symlink' : 'dir');
  try {
    const liveKind = await env.pathKind(live);
    if (liveKind === 'absent') {
      // P3 done, P4 not: the old entry lives at the backup — one rename restores it.
      if ((await env.pathKind(j.backupPath)) !== 'absent') {
        await env.rename(j.backupPath, live);
      }
    } else {
      // Live is present: decide whether it is the NEW artifact (P4 done) or still the OLD one. A kind
      // change tells them apart; same-kind swaps use their exact retained identity.
      let liveIsNew: boolean;
      if (oldKind === 'symlink' && liveKind === 'symlink') {
        if (before.symlinkTarget == null) {
          return err(
            genericError(`cannot roll back ${skill}: symlink before-state is missing its target`),
          );
        }
        liveIsNew = (await env.readLink(live)) !== before.symlinkTarget;
      } else if (oldKind === 'dir' && liveKind === 'dir') {
        const durableLogical = ledger.current().transactions[j.txId];
        const logicalOperation =
          ctx.logicalOperation ??
          (durableLogical === undefined ? undefined : journalOperation(durableLogical));
        const exactCopyReplace =
          j.op === 'install' &&
          (logicalOperation?.kind === 'update' || logicalOperation?.kind === 'repair') &&
          logicalOperation.after.kind === 'placement' &&
          logicalOperation.after.representation === 'copy';
        if (!exactCopyReplace) {
          liveIsNew = false;
        } else {
          const newHash = pair.pinned?.contentHash ?? null;
          if (
            before.mode !== 'pinned' ||
            before.contentHash === null ||
            newHash === null ||
            before.contentHash === newHash
          ) {
            return err(genericError(`cannot roll back ${skill}: copy identity is ambiguous`));
          }
          const observedHash = await contentHashOf(env, live);
          if (!observedHash.ok) return observedHash;
          if (observedHash.value === newHash) liveIsNew = true;
          else if (observedHash.value === before.contentHash) liveIsNew = false;
          else {
            return err(genericError(`cannot roll back ${skill}: copy residue is incompatible`));
          }
        }
      } else {
        liveIsNew = liveKind !== oldKind;
      }
      if (liveIsNew) {
        // Move the new entry aside, restore the backup, drop the new one.
        if ((await env.pathKind(j.backupPath)) !== 'absent') {
          if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
          await env.rename(live, j.stagingPath);
          await env.rename(j.backupPath, live);
        }
      }
      // else: live is still the old entry — nothing to restore.
    }
    if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
  } catch (e) {
    return err(mapFsErr(e, `cannot roll back ${skill}`));
  }

  // Restores the old live BYTES but keeps whatever records `stagePair` wrote at P1: for an
  // uncommitted replace-install rollback that means the NEW pinned/origin/placement records survive
  // (mirrors P12 promote-rollback — the engine never retains the old PinnedRecord/origin, so it
  // cannot restore them). The run layer (Task 7) MUST reconcile the ledger record after such a rollback.
  pair.mode = before.mode;
  if (logicalRollback.value === null) pair.journal = null;
  const persisted = await (logicalRollback.value === null
    ? persistPair(ctx, ledger, effects, scopeKey, skill, tool, pair)
    : commitLogicalRollback(ledger, effects, j.txId, scopeKey, skill, tool, before.mode));
  if (!persisted.ok) return persisted;
  return ok({ committed: false, backupKept: null, warning: null });
};

export const rollbackSwap = (
  request: SwapRequest,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null = null,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  executeWithSwapState(request, (ctx, ledger, effects) =>
    rollbackSwapInternal(ctx, ledger, effects, skill, tool, scopeKey),
  );

export const rollbackSwapAfterRecoveryAttempt = (
  request: SwapRequest,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  executeWithSwapState(request, (ctx, ledger, effects) =>
    rollbackSwapInternal(ctx, ledger, effects, skill, tool, scopeKey, true),
  );

export const rollbackSwapObserved = (
  request: SwapRequest,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> => {
  const operationId = recoveryOperationId(request, skill, tool, scopeKey);
  return operationId === null
    ? rollbackSwapAfterRecoveryAttempt(request, skill, tool, scopeKey)
    : executeWithSwapState(
        observeSwapPersistence(request, observation, { operationId }),
        (ctx, ledger, effects) =>
          rollbackSwapInternal(ctx, ledger, effects, skill, tool, scopeKey, true),
      );
};

/** §8.5: finish any committed acquisition journal left by a crash between the committed write and
 *  the terminal write. Walks the user `skills` tree AND every `projects` subtree. Runs at the start
 *  of every locked batch (install, uninstall, promote, dev, rollback). Idempotent. */
interface CommittedAcquireTarget {
  readonly scopeKey: string | null;
  readonly skill: string;
  readonly tool: FlipTool;
  readonly pair: PairRecord;
  readonly shadow: Journal;
  readonly logicalJournal: LogicalJournalV1Dto | null;
  readonly canonicalJournal: LogicalJournalV1Dto | null;
}

const canonicalAcquireJournal = (
  journal: LogicalJournalV1Dto | null,
  identity: LedgerPairIdentity,
  pair: PairRecord,
  shadow: Journal,
): LogicalJournalV1Dto | null => {
  if (journal?.phase !== 'committed' || journal.disposition !== 'forward') return null;
  const acquisitionKindMatches =
    (shadow.op === 'install' &&
      (journal.intent.kind === 'install' || journal.intent.kind === 'update')) ||
    (shadow.op === 'uninstall' && journal.intent.kind === 'remove');
  return acquisitionKindMatches && legacyJournalMatchesLogicalShadow(journal, identity, pair)
    ? journal
    : null;
};

const canonicalCommittedAcquireBase = (
  model: LedgerModel,
  targets: readonly CommittedAcquireTarget[],
): LedgerModel => {
  const candidate = structuredClone(model);
  for (const target of targets) {
    const journal = target.canonicalJournal;
    if (journal === null) continue;
    const tree =
      target.scopeKey === null ? candidate.skills : candidate.projects[target.scopeKey]?.skills;
    const entry = tree?.[target.skill];
    const pair = entry?.tools[target.tool];
    if (entry === undefined || pair === undefined) continue;
    if (journal.intent.kind === 'remove') {
      Reflect.deleteProperty(entry.tools, target.tool);
      if (Object.keys(entry.tools).length === 0 && tree !== undefined) {
        Reflect.deleteProperty(tree, target.skill);
      }
      if (target.scopeKey !== null) {
        const project = candidate.projects[target.scopeKey];
        if (project !== undefined && Object.keys(project.skills).length === 0) {
          Reflect.deleteProperty(candidate.projects, target.scopeKey);
        }
      }
    } else {
      Reflect.set(pair, 'journal', null);
    }
  }
  return {
    ...candidate,
    projectRegistrations: deriveLedgerProjectRegistrations(candidate.projects),
  };
};

const cleanupCanonicalCommittedAcquire = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  pair: PairRecord,
  shadow: Journal,
  logicalOperation: ExecutableOperation,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  if (ctx.signal?.aborted) return err(cancelledError('interrupted'));
  const syncedBeforeCleanup = await guardFs(
    () => ctx.env.fsyncDir(plan.skillsRoot),
    `cannot fsync ${plan.skillsRoot}`,
  );
  if (!syncedBeforeCleanup.ok) return syncedBeforeCleanup;

  if (plan.op === 'install') {
    if (shadow.before.mode === 'absent') {
      return ok({ committed: true, backupKept: null, warning: null });
    }
    const newHash = plan.install?.contentHash ?? pair.pinned?.contentHash ?? null;
    const reclaimed = await reclaimBackup(
      ctx.env,
      shadow.backupPath,
      trustedInstallBackupHashes(shadow.before, newHash, logicalOperation),
      'replaced',
    );
    if (!reclaimed.ok) return reclaimed;
    const synced = await guardFs(
      () => ctx.env.fsyncDir(plan.skillsRoot),
      `cannot fsync ${plan.skillsRoot}`,
    );
    return synced.ok ? ok({ committed: true, ...reclaimed.value }) : synced;
  }

  if (plan.op === 'uninstall') {
    const reclaimed = await reclaimBackup(
      ctx.env,
      shadow.backupPath,
      [pair.pinned?.contentHash],
      'uninstalled',
    );
    if (!reclaimed.ok) return reclaimed;
    const synced = await guardFs(
      () => ctx.env.fsyncDir(plan.skillsRoot),
      `cannot fsync ${plan.skillsRoot}`,
    );
    return synced.ok ? ok({ committed: true, ...reclaimed.value }) : synced;
  }

  return err(genericError(`cannot clean canonical acquisition journal for ${plan.skill}`));
};

const sweepCommittedAcquireJournalsInternal = async (
  ctx: SwapCtx,
  ledger: SwapLedgerAccess,
  effects: SwapEffects,
  observation?: ObservationBundle,
): Promise<Result<string[], SkillSmithError>> => {
  const targets: CommittedAcquireTarget[] = [];
  const model = ledger.current();

  const collect = (tree: LedgerModel['skills'], scopeKey: string | null): void => {
    for (const skill of Object.keys(tree)) {
      const entry = tree[skill];
      if (!entry) continue;
      for (const tool of Object.keys(entry.tools) as FlipTool[]) {
        const pair = entry.tools[tool];
        const shadow = pair?.journal;
        if (
          pair !== undefined &&
          shadow !== undefined &&
          shadow !== null &&
          shadow.phase === 'committed' &&
          (shadow.op === 'install' || shadow.op === 'uninstall')
        ) {
          const logicalJournal =
            model.transactions[shadow.txId] ??
            model.history.find(({ transactionId }) => transactionId === shadow.txId) ??
            null;
          targets.push({
            scopeKey,
            skill,
            tool,
            pair: structuredClone(pair) as PairRecord,
            shadow: structuredClone(shadow),
            logicalJournal,
            canonicalJournal: canonicalAcquireJournal(
              logicalJournal,
              { projectRoot: scopeKey, skill, tool },
              pair,
              shadow,
            ),
          });
        }
      }
    }
  };

  collect(model.skills, null);
  if (model.projects) {
    for (const key of Object.keys(model.projects)) {
      const scope = model.projects[key];
      if (scope) collect(scope.skills, key);
    }
  }

  const notes: string[] = [];
  for (const journal of model.history) {
    if (
      journal.intent.kind !== 'move-scope' ||
      journal.disposition !== 'forward' ||
      journal.phase !== 'committed' ||
      journal.intent.skill === null ||
      journal.intent.tool === null ||
      journal.intent.before.kind !== 'placement' ||
      journal.intent.after.kind !== 'placement'
    ) {
      continue;
    }
    if (ctx.signal?.aborted) return err(cancelledError('interrupted'));
    const source = moveScopeRoot(journal.intent.before as OperationImage);
    const destination = moveScopeRoot(journal.intent.after as OperationImage);
    if (source === null || destination === null) continue;
    const pair = getLedgerPairAt(
      model,
      destination.scopeKey,
      journal.intent.skill,
      journal.intent.tool,
    );
    if (pair === null || pair.placementPath !== destination.path) continue;
    const backupPath = join(
      dirname(source.path),
      `.skillsmith-backup-${journal.intent.skill}-${journal.transactionId}`,
    );
    const transactionObservation =
      observation === undefined ? null : createTransactionObservation(observation, journal);
    const span =
      transactionObservation === null
        ? null
        : beginRecoveryObservation(transactionObservation, 'cleanup');
    const reclaimed = await reclaimBackup(
      ctx.env,
      backupPath,
      [journal.intent.before.contentHash, pair.pinned?.contentHash],
      'moved',
    );
    if (!reclaimed.ok) {
      if (transactionObservation !== null) {
        completeRecoveryObservation(
          transactionObservation,
          span,
          reclaimed.error.code === 'cancelled' ? 'cancelled' : 'failure',
          reclaimed.error.code,
        );
      }
      return reclaimed;
    }
    const synced = await guardFs(
      () => ctx.env.fsyncDir(dirname(source.path)),
      `cannot fsync ${dirname(source.path)}`,
    );
    if (!synced.ok) {
      if (transactionObservation !== null) {
        completeRecoveryObservation(
          transactionObservation,
          span,
          synced.error.code === 'cancelled' ? 'cancelled' : 'failure',
          synced.error.code,
        );
      }
      return synced;
    }
    if (transactionObservation !== null) {
      completeRecoveryObservation(transactionObservation, span, 'success', null);
    }
    if (reclaimed.value.warning !== null) notes.push(reclaimed.value.warning);
  }
  const canonicalTargets = targets.filter(({ canonicalJournal }) => canonicalJournal !== null);
  const pendingCanonicalObservations: Array<
    Readonly<{
      transactionObservation: ObservationBundle;
      span: ReturnType<typeof beginRecoveryObservation>;
    }>
  > = [];
  const completeCanonicalObservations = (
    outcome: ObservationOutcome,
    errorCode: string | null,
  ): void => {
    for (const pending of pendingCanonicalObservations) {
      completeRecoveryObservation(pending.transactionObservation, pending.span, outcome, errorCode);
    }
    pendingCanonicalObservations.length = 0;
  };

  try {
    const canonicalCleanupContext =
      ctx.signal === undefined
        ? ctx
        : (({ signal: _signal, ...signalFreeContext }) => signalFreeContext)(ctx);
    let canonicalCleanupStarted = false;
    for (const target of canonicalTargets) {
      const journal = target.canonicalJournal;
      if (journal === null) continue;
      const transactionObservation =
        observation === undefined ? null : createTransactionObservation(observation, journal);
      if (transactionObservation !== null) {
        pendingCanonicalObservations.push({
          transactionObservation,
          span: beginRecoveryObservation(transactionObservation, 'cleanup'),
        });
      }
      const plan = reconstructPlan(
        model,
        target.pair,
        target.shadow,
        target.skill,
        target.tool,
        target.scopeKey,
      );
      if (!plan.ok) {
        completeCanonicalObservations(
          plan.error.code === 'cancelled' ? 'cancelled' : 'failure',
          plan.error.code,
        );
        return plan;
      }
      const cleanupContext = canonicalCleanupStarted ? canonicalCleanupContext : ctx;
      canonicalCleanupStarted = true;
      const done = await cleanupCanonicalCommittedAcquire(
        cleanupContext,
        plan.value,
        target.pair,
        target.shadow,
        journalOperation(journal),
      );
      if (!done.ok) {
        completeCanonicalObservations(
          done.error.code === 'cancelled' ? 'cancelled' : 'failure',
          done.error.code,
        );
        return done;
      }
      if (done.value.warning) notes.push(done.value.warning);
    }
    if (canonicalTargets.length > 0) {
      const persisted = await ledger.persist(
        canonicalCommittedAcquireBase(ledger.current(), targets),
      );
      if (!persisted.ok) {
        completeCanonicalObservations(
          persisted.error.code === 'cancelled' ? 'cancelled' : 'failure',
          persisted.error.code,
        );
        return persisted;
      }
      completeCanonicalObservations('success', null);
    }
  } catch (error) {
    const code = safeErrorCode(error);
    const cancelled =
      ctx.signal?.aborted === true ||
      code === 'cancelled' ||
      code === 'ABORT_ERR' ||
      code === 'AbortError';
    completeCanonicalObservations(
      cancelled ? 'cancelled' : 'failure',
      cancelled ? 'cancelled' : (code ?? 'recovery-threw'),
    );
    throw error;
  }

  for (const t of targets) {
    if (t.canonicalJournal !== null) continue;
    const pair = t.pair;
    const j = t.shadow;
    const journal = t.logicalJournal;
    const transactionObservation =
      observation === undefined || journal === null
        ? null
        : createTransactionObservation(observation, journal);
    const span =
      transactionObservation === null
        ? null
        : beginRecoveryObservation(transactionObservation, 'cleanup');
    const plan = reconstructPlan(model, pair, j, t.skill, t.tool, t.scopeKey);
    if (!plan.ok) {
      if (transactionObservation !== null) {
        completeRecoveryObservation(
          transactionObservation,
          span,
          plan.error.code === 'cancelled' ? 'cancelled' : 'failure',
          plan.error.code,
        );
      }
      return plan;
    }
    try {
      const done = await forward(ctx, ledger, effects, plan.value, pair);
      if (transactionObservation !== null) {
        completeRecoveryObservation(
          transactionObservation,
          span,
          done.ok ? 'success' : done.error.code === 'cancelled' ? 'cancelled' : 'failure',
          done.ok ? null : done.error.code,
        );
      }
      if (!done.ok) return done;
      if (done.value.warning) notes.push(done.value.warning);
    } catch (error) {
      if (transactionObservation !== null) {
        const code = safeErrorCode(error);
        const cancelled =
          ctx.signal?.aborted === true ||
          code === 'cancelled' ||
          code === 'ABORT_ERR' ||
          code === 'AbortError';
        completeRecoveryObservation(
          transactionObservation,
          span,
          cancelled ? 'cancelled' : 'failure',
          cancelled ? 'cancelled' : (code ?? 'recovery-threw'),
        );
      }
      throw error;
    }
  }
  return ok(notes);
};

export const sweepCommittedAcquireJournals = (
  request: SwapRequest,
): Promise<SwapExecutionResult<string[]>> =>
  executeWithSwapState(request, (ctx, ledger, effects) =>
    sweepCommittedAcquireJournalsInternal(ctx, ledger, effects),
  );

export const sweepCommittedAcquireJournalsObserved = (
  request: SwapRequest,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<string[]>> =>
  executeWithSwapState(request, (ctx, ledger, effects) =>
    sweepCommittedAcquireJournalsInternal(ctx, ledger, effects, observation),
  );
