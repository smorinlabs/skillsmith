import { dirname } from 'node:path';
import type {
  ArtifactCoordinatorPorts,
  ArtifactGroupLockLease,
} from '../artifacts/coordinator-types.ts';
import { commitRetainedArtifactPairWithLease } from '../artifacts/coordinator.ts';
import {
  artifactLockImageFromBytesV1,
  artifactManifestImageFromBytesV1,
} from '../artifacts/execution.ts';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import {
  decodeRetainedArtifactPreimageV1,
  retainedArtifactJournalAuthorityV1,
} from '../artifacts/retained-preimage-codec.ts';
import type { PreparedExecutionBinding, ValidatedExecutionBinding } from '../execution/types.ts';
import { createLedgerPersistenceGateway } from '../place/ledger-persistence.ts';
import { ledgerModelForMutation, readLedgerState } from '../place/ledger.ts';
import {
  advanceLogicalTransaction,
  beginCommittedLogicalTransactionReversal,
  commitLogicalTransaction,
  logicalRollbackExecutionMode,
} from '../place/logical-transactions.ts';
import type { PlacementPorts } from '../place/types.ts';
import { createOperationExecutionResult } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
} from '../planning/types.ts';
import type { UndoArtifactCandidate } from './types.ts';

export interface BindUndoRetainedArtifactRequestV1 {
  readonly operation: ExecutableOperation;
  readonly candidate: UndoArtifactCandidate;
  readonly lease: ArtifactGroupLockLease;
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly ports: PlacementPorts;
  readonly pair: ResolvedArtifactPair;
  readonly ledgerPath: string;
  readonly signal?: AbortSignal;
}

const same = (left: unknown, right: unknown): boolean =>
  canonicalPlanningString(left) === canonicalPlanningString(right);

const rolePath = (pair: ResolvedArtifactPair, role: 'manifest' | 'lock'): string =>
  role === 'manifest' ? pair.file.path : pair.lockfile.path;

const imageFromBytes = (
  role: 'manifest' | 'lock',
  path: string,
  bytes: Uint8Array,
): OperationImage =>
  role === 'manifest'
    ? artifactManifestImageFromBytesV1(path, bytes)
    : artifactLockImageFromBytesV1(path, bytes);

const observeImage = async (
  ports: ArtifactCoordinatorPorts,
  role: 'manifest' | 'lock',
  path: string,
): Promise<Readonly<{ image: OperationImage; mode: number }>> => {
  const before = await ports.observe(path);
  if (
    before.kind !== 'file' ||
    before.identity === null ||
    before.mode === null ||
    before.linkCount !== 1
  ) {
    throw new TypeError(`undo ${role} artifact is not one stable regular file`);
  }
  const bytes = new Uint8Array(await ports.readBytes(path));
  const after = await ports.observe(path);
  if (
    after.kind !== 'file' ||
    after.identity !== before.identity ||
    after.mode !== before.mode ||
    after.linkCount !== 1
  ) {
    throw new TypeError(`undo ${role} artifact changed while it was observed`);
  }
  return Object.freeze({ image: imageFromBytes(role, path, bytes), mode: before.mode });
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const revalidateRetainedEnvelope = async (
  request: BindUndoRetainedArtifactRequestV1,
): Promise<void> => {
  const path = request.candidate.retainedPath;
  const parentPath = dirname(path);
  const parentBefore = await request.artifactCoordinator.observe(parentPath);
  const before = await request.artifactCoordinator.observe(path);
  if (
    parentBefore.kind !== 'directory' ||
    parentBefore.identity === null ||
    parentBefore.mode !== 0o700 ||
    before.kind !== 'file' ||
    before.identity === null ||
    before.mode !== 0o600 ||
    before.linkCount !== 1 ||
    before.parent.state !== 'present' ||
    before.parent.identity !== parentBefore.identity
  ) {
    throw new TypeError('retained undo artifact envelope is no longer owner-private');
  }
  const bytes = new Uint8Array(await request.artifactCoordinator.readBytes(path));
  const parentAfter = await request.artifactCoordinator.observe(parentPath);
  const after = await request.artifactCoordinator.observe(path);
  if (
    parentAfter.kind !== 'directory' ||
    parentAfter.identity !== parentBefore.identity ||
    parentAfter.mode !== 0o700 ||
    after.kind !== 'file' ||
    after.identity !== before.identity ||
    after.mode !== 0o600 ||
    after.linkCount !== 1
  ) {
    throw new TypeError('retained undo artifact envelope changed while it was read');
  }
  const decoded = decodeRetainedArtifactPreimageV1(bytes, {
    operationId: request.candidate.sourceOperationId,
    role: request.candidate.role,
    path: request.candidate.artifactPath,
    after: request.candidate.envelope.model.after,
  });
  if (!decoded.ok || !equalBytes(decoded.value.encoded, request.candidate.envelope.encoded)) {
    throw new TypeError('retained undo artifact envelope differs from approved authority');
  }
};

const result = (
  operation: ExecutableOperation,
  binding: ValidatedExecutionBinding,
  outcome: 'succeeded' | 'failed' | 'cancelled',
  actualAfter: OperationImage,
  reason?: string,
): OperationExecutionResult =>
  createOperationExecutionResult({
    operationId: operation.operationId,
    outcome,
    actualBefore: binding.actualBefore,
    actualAfter,
    force: null,
    error:
      outcome === 'failed'
        ? {
            code: 'undo-artifact-restore-failed',
            message: `retained artifact restore failed${reason === undefined ? '' : `: ${reason}`}`,
            remediation: 'Re-run the same undo to recover the retained artifact operation.',
          }
        : null,
  });

const phaseJournal = (
  pending: LogicalJournalV1Dto,
  phase: 'staged' | 'backed-up' | 'live',
  updatedAt: string,
  terminalAfter: LogicalJournalV1Dto['actual']['after'],
): LogicalJournalV1Dto => ({
  ...pending,
  phase,
  actual: { ...pending.actual, after: phase === 'live' ? terminalAfter : [] },
  updatedAt,
  completedAt: null,
});

const validateAuthority = (request: BindUndoRetainedArtifactRequestV1): void => {
  const { operation, candidate, pair } = request;
  const source = retainedArtifactJournalAuthorityV1(candidate.journal);
  const expectedKind = candidate.role === 'manifest' ? 'write-manifest' : 'write-lock';
  const path = rolePath(pair, candidate.role);
  if (
    candidate.action === 'already-restored' ||
    (candidate.action === 'restore') !== (candidate.rollbackJournal === null) ||
    (candidate.action === 'resume' &&
      (candidate.rollbackJournal === null ||
        candidate.rollbackJournal.phase === 'committed' ||
        candidate.rollbackJournal.disposition !== 'rollback' ||
        candidate.rollbackJournal.context.parentOperationId !== candidate.sourceOperationId ||
        candidate.rollbackJournal.intent.operationId !== operation.operationId ||
        candidate.rollbackJournal.intent.groupId !== operation.groupId ||
        candidate.rollbackJournal.intent.pairId !== null ||
        candidate.rollbackJournal.intent.kind !== expectedKind)) ||
    source === null ||
    source.role !== candidate.role ||
    source.path !== candidate.artifactPath ||
    source.path !== path ||
    source.retained.path !== candidate.retainedPath ||
    operation.kind !== expectedKind ||
    operation.pairId !== null ||
    operation.skill !== null ||
    operation.source !== null ||
    operation.tool !== null ||
    operation.scope !== null ||
    operation.reversibility.kind !== 'conditional' ||
    !same(operation.reversibility, candidate.journal.intent.reversibility) ||
    !same(operation.before, candidate.journal.intent.after) ||
    !same(operation.after, candidate.journal.intent.before) ||
    candidate.envelope.model.operationId !== candidate.sourceOperationId ||
    candidate.envelope.model.path !== path ||
    candidate.envelope.model.role !== candidate.role
  ) {
    throw new TypeError('undo retained artifact binding authority is invalid');
  }
  const retainedImage = imageFromBytes(candidate.role, path, candidate.envelope.model.before.bytes);
  if (!same(retainedImage, operation.after)) {
    throw new TypeError('undo retained artifact bytes differ from the approved inverse');
  }
};

/** Bind one pair-null undo operation to its exact retained bytes and rollback lineage. */
export const bindUndoRetainedArtifactV1 = (
  request: BindUndoRetainedArtifactRequestV1,
): PreparedExecutionBinding => {
  validateAuthority(request);
  const { operation, candidate } = request;
  const path = rolePath(request.pair, candidate.role);
  return Object.freeze({
    operationId: operation.operationId,
    groupId: operation.groupId,
    pairId: null,
    unstartedForce: null,
    observeActualBefore: async () => {
      if (!candidate.physicalHead) return operation.before;
      const observed = await observeImage(request.artifactCoordinator, candidate.role, path);
      const forward =
        observed.mode === candidate.envelope.model.after.mode &&
        same(observed.image, operation.before);
      const restored =
        observed.mode === candidate.envelope.model.before.mode &&
        same(observed.image, operation.after);
      const allowed =
        candidate.action === 'restore'
          ? forward
          : candidate.rollbackJournal?.phase === 'backed-up'
            ? forward || restored
            : candidate.rollbackJournal?.phase === 'live'
              ? restored
              : forward;
      if (!allowed) {
        throw new TypeError(`current ${candidate.role} artifact differs from approved undo state`);
      }
      // A recovery-aware binding retains the approved operation start image while the pending
      // rollback journal authenticates an already-restored physical after-image.
      return operation.before;
    },
    execute: async (binding: ValidatedExecutionBinding): Promise<OperationExecutionResult> => {
      let durableImage = operation.before;
      try {
        if (!same(binding.actualBefore, operation.before)) {
          throw new TypeError('validated undo artifact binding differs from approved state');
        }
        await revalidateRetainedEnvelope(request);
        const state = await readLedgerState(request.ports, request.ledgerPath);
        if (!state.ok) throw state.error;
        let model = ledgerModelForMutation(state.value, request.ports.wallNowIso());
        const pendingCandidates = Object.values(model.transactions).filter(
          (journal) =>
            journal.disposition === 'rollback' &&
            journal.intent.operationId === operation.operationId &&
            journal.context.parentOperationId === candidate.sourceOperationId &&
            journal.context.workflow === 'undo-artifact-history',
        );
        if (pendingCandidates.length > 1) {
          throw new TypeError('undo artifact operation has ambiguous pending history');
        }
        const transactionId =
          pendingCandidates[0]?.transactionId ?? request.ports.nextId('undo-artifact-transaction');
        const persistence = createLedgerPersistenceGateway(
          request.ports,
          request.ledgerPath,
          request.signal,
        );
        const persistModel = async (next: typeof model): Promise<void> => {
          const persisted = await persistence.persist(next);
          if (!persisted.ok) throw persisted.error;
          model = persisted.value.model;
        };

        let pending = model.transactions[transactionId];
        if (pending === undefined) {
          const startedAt = request.ports.wallNowIso();
          const begun = beginCommittedLogicalTransactionReversal(model, {
            sourceTransactionId: candidate.sourceTransactionId,
            transactionId,
            operationId: operation.operationId,
            groupId: operation.groupId,
            pairId: null,
            command: 'skillsmith-undo',
            workflow: 'undo-artifact-history',
            startedAt,
            updatedAt: startedAt,
          });
          if (!begun.ok) throw new TypeError(begun.error.message);
          await persistModel(begun.value);
          pending = model.transactions[transactionId];
        }
        if (pending === undefined) {
          throw new TypeError('undo artifact rollback journal was not persisted');
        }
        const mode = logicalRollbackExecutionMode(model, pending);
        if (!mode.ok || mode.value !== 'fresh-reversal') {
          throw new TypeError('undo artifact rollback lineage is inconsistent');
        }
        const remainingPhases =
          pending.phase === 'prepared'
            ? (['staged', 'backed-up'] as const)
            : pending.phase === 'staged'
              ? (['backed-up'] as const)
              : pending.phase === 'backed-up' || pending.phase === 'live'
                ? ([] as const)
                : null;
        if (remainingPhases === null) {
          throw new TypeError('undo artifact rollback journal has an invalid phase');
        }
        for (const phase of remainingPhases) {
          const next = phaseJournal(
            pending,
            phase,
            request.ports.wallNowIso(),
            candidate.journal.actual.before,
          );
          const advanced = advanceLogicalTransaction(model, next);
          if (!advanced.ok) throw new TypeError(advanced.error.message);
          await persistModel(advanced.value);
          pending = model.transactions[transactionId] as LogicalJournalV1Dto;
        }

        const physical = await observeImage(request.artifactCoordinator, candidate.role, path);
        const alreadyRestored =
          physical.mode === candidate.envelope.model.before.mode &&
          same(physical.image, operation.after);
        if (!alreadyRestored) {
          if (
            physical.mode !== candidate.envelope.model.after.mode ||
            !same(physical.image, operation.before)
          ) {
            throw new TypeError('physical artifact state no longer matches rollback authority');
          }
          const committed = await commitRetainedArtifactPairWithLease(request.lease, {
            kind: 'retained-preimage',
            pair: request.pair,
            role: candidate.role,
            bytes: candidate.envelope.model.before.bytes,
            mode: candidate.envelope.model.before.mode,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
          if (!committed.ok) throw committed.error;
        }
        durableImage = operation.after;

        pending = model.transactions[transactionId] as LogicalJournalV1Dto;
        if (pending.phase !== 'live') {
          const live = phaseJournal(
            pending,
            'live',
            request.ports.wallNowIso(),
            candidate.journal.actual.before,
          );
          const advanced = advanceLogicalTransaction(model, live);
          if (!advanced.ok) throw new TypeError(advanced.error.message);
          await persistModel(advanced.value);
          pending = model.transactions[transactionId] as LogicalJournalV1Dto;
        }
        const completedAt = request.ports.wallNowIso();
        const committed = commitLogicalTransaction(model, {
          ...pending,
          phase: 'committed',
          actual: { ...pending.actual, after: candidate.journal.actual.before },
          updatedAt: completedAt,
          completedAt,
        });
        if (!committed.ok) throw new TypeError(committed.error.message);
        await persistModel(committed.value);
        return result(operation, binding, 'succeeded', operation.after);
      } catch (error) {
        const observed = await observeImage(
          request.artifactCoordinator,
          candidate.role,
          path,
        ).catch(() => null);
        if (observed !== null) {
          if (same(observed.image, operation.after)) durableImage = operation.after;
          else if (same(observed.image, operation.before)) durableImage = operation.before;
        }
        const cancelled = request.signal?.aborted === true;
        return result(
          operation,
          binding,
          cancelled ? 'cancelled' : 'failed',
          durableImage,
          error instanceof Error
            ? error.message
            : typeof error === 'object' && error !== null && 'message' in error
              ? String(error.message)
              : typeof error === 'object' && error !== null && 'reason' in error
                ? String(error.reason)
                : 'unknown restore error',
        );
      }
    },
  });
};
