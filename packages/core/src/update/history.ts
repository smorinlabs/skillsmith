import { basename, dirname, join } from 'node:path';
import type { ArtifactCoordinatorPorts } from '../artifacts/coordinator-types.ts';
import {
  artifactLockImageFromBytesV1,
  artifactManifestImageFromBytesV1,
} from '../artifacts/execution.ts';
import { type ArtifactDigest, hashCanonicalInput } from '../artifacts/hash.ts';
import type {
  JournalResourceActualV1Dto,
  JournalRetainedV1Dto,
  LogicalJournalV1Dto,
} from '../artifacts/journal-types.ts';
import { validateJournalV1DtoShape } from '../artifacts/registry.ts';
import {
  type DecodedRetainedArtifactPreimageV1,
  decodeRetainedArtifactPreimageV1,
  encodeRetainedArtifactPreimageV1,
} from '../artifacts/retained-preimage-codec.ts';
import type { PreparedExecutionBinding, ValidatedExecutionBinding } from '../execution/types.ts';
import { createLedgerPersistenceGateway } from '../place/ledger-persistence.ts';
import { ledgerModelForMutation, readLedgerState } from '../place/ledger.ts';
import {
  advanceLogicalTransaction,
  commitLogicalTransaction,
} from '../place/logical-transactions.ts';
import type { PlacementPorts } from '../place/types.ts';
import { createOperationExecutionResult } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { ExecutableOperation, OperationDigest, OperationImage } from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';

export interface ForwardUpdateArtifactHistoryErrorV1 {
  readonly code: 'update-artifact-history';
  readonly reason: 'invalid-operation' | 'invalid-retention' | 'invalid-journal';
  readonly message: string;
}

export interface ForwardUpdateArtifactJournalSequenceV1 {
  readonly prepared: LogicalJournalV1Dto;
  readonly staged: LogicalJournalV1Dto;
  readonly backedUp: LogicalJournalV1Dto;
  readonly live: LogicalJournalV1Dto;
  readonly committed: LogicalJournalV1Dto;
  readonly retained: JournalRetainedV1Dto;
  readonly envelope: DecodedRetainedArtifactPreimageV1;
}

export interface CreateForwardUpdateArtifactJournalSequenceRequestV1 {
  readonly operation: ExecutableOperation;
  readonly transactionId: string;
  readonly startedAt: string;
  readonly retainedPath: string;
  readonly retainedBytes: unknown;
  readonly expectedAfterMode: number;
}

export interface BindForwardUpdateArtifactHistoryRequestV1 {
  readonly operation: ExecutableOperation;
  readonly binding: PreparedExecutionBinding;
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly ports: PlacementPorts;
  readonly ledgerPath: string;
  readonly onLedgerCommitted?: () => Promise<void>;
  readonly signal?: AbortSignal;
}

type ArtifactRole = 'manifest' | 'lock';

const failure = (
  reason: ForwardUpdateArtifactHistoryErrorV1['reason'],
): ForwardUpdateArtifactHistoryErrorV1 =>
  Object.freeze({
    code: 'update-artifact-history',
    reason,
    message:
      reason === 'invalid-operation'
        ? 'update artifact history operation is invalid'
        : reason === 'invalid-retention'
          ? 'update artifact retention authority is invalid'
          : 'update artifact logical journal is invalid',
  });

const roleOf = (operation: ExecutableOperation): ArtifactRole | null =>
  operation.kind === 'write-manifest'
    ? 'manifest'
    : operation.kind === 'write-lock'
      ? 'lock'
      : null;

const imagePath = (role: ArtifactRole, image: OperationImage): string | null => {
  const location =
    role === 'manifest' && image.kind === 'manifest'
      ? image.location
      : role === 'lock' && image.kind === 'lock'
        ? image.location
        : null;
  return location?.kind === 'machine-bound' ? location.path : null;
};

const imageDigest = (role: ArtifactRole, image: OperationImage): OperationDigest | null =>
  role === 'manifest' && image.kind === 'manifest'
    ? image.byteHash
    : role === 'lock' && image.kind === 'lock'
      ? image.canonicalHash
      : null;

const actualResourceId = (role: ArtifactRole, path: string): string => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-update-artifact-actual', 1, role, path]),
  );
  if (!hashed.ok) throw new TypeError('update artifact actual identity could not be hashed');
  return `update-artifact-${role}:v1:${hashed.value.slice('sha256:'.length)}`;
};

const actualFor = (
  role: ArtifactRole,
  image: OperationImage,
): JournalResourceActualV1Dto | null => {
  const path = imagePath(role, image);
  const digest = imageDigest(role, image);
  if (path === null || digest === null) return null;
  const common = {
    resourceId: actualResourceId(role, path),
    role,
    state: 'present' as const,
    repositoryRevision: { kind: 'artifact-bytes' as const, digest: digest as ArtifactDigest },
    location: { kind: 'machine-bound' as const, path },
  };
  return role === 'manifest' && image.kind === 'manifest' && image.shape === 'canonical'
    ? {
        ...common,
        role: 'manifest',
        shape: image.shape,
        version: image.version,
        byteHash: image.byteHash as ArtifactDigest,
        semanticHash: image.semanticHash as ArtifactDigest,
      }
    : role === 'lock' && image.kind === 'lock'
      ? {
          ...common,
          role: 'lock',
          version: image.version,
          canonicalHash: image.canonicalHash as ArtifactDigest,
        }
      : null;
};

const exactArtifactOperation = (
  operation: ExecutableOperation,
): Readonly<{
  role: ArtifactRole;
  path: string;
  before: JournalResourceActualV1Dto;
  after: JournalResourceActualV1Dto;
  afterDigest: ArtifactDigest;
  retentionResourceId: string;
}> | null => {
  const role = roleOf(operation);
  if (
    role === null ||
    operation.pairId !== null ||
    operation.skill !== null ||
    operation.source !== null ||
    operation.tool !== null ||
    operation.scope !== null ||
    operation.reversibility.kind !== 'conditional' ||
    operation.reversibility.retentionResourceIds.length !== 1
  ) {
    return null;
  }
  const before = actualFor(role, operation.before);
  const after = actualFor(role, operation.after);
  const path = imagePath(role, operation.before);
  const afterPath = imagePath(role, operation.after);
  const afterDigest = imageDigest(role, operation.after);
  const retentionResourceId = operation.reversibility.retentionResourceIds[0];
  return before !== null &&
    after !== null &&
    path !== null &&
    path === afterPath &&
    afterDigest !== null &&
    retentionResourceId !== undefined
    ? {
        role,
        path,
        before,
        after,
        afterDigest: afterDigest as ArtifactDigest,
        retentionResourceId,
      }
    : null;
};

export const createForwardUpdateArtifactJournalSequenceV1 = (
  request: CreateForwardUpdateArtifactJournalSequenceRequestV1,
): Result<ForwardUpdateArtifactJournalSequenceV1, ForwardUpdateArtifactHistoryErrorV1> => {
  const artifact = exactArtifactOperation(request.operation);
  if (artifact === null) return err(failure('invalid-operation'));
  if (
    request.transactionId.length === 0 ||
    request.transactionId.length > 192 ||
    !/^[A-Za-z0-9._:-]+$/u.test(request.transactionId) ||
    basename(dirname(request.retainedPath)) !== `.skillsmith-artifact-${request.transactionId}` ||
    basename(request.retainedPath) !== `${artifact.role}.backup`
  ) {
    return err(failure('invalid-retention'));
  }
  const envelope = decodeRetainedArtifactPreimageV1(request.retainedBytes, {
    operationId: request.operation.operationId,
    role: artifact.role,
    path: artifact.path,
    after: { digest: artifact.afterDigest, mode: request.expectedAfterMode },
  });
  if (!envelope.ok) return err(failure('invalid-retention'));
  const retained: JournalRetainedV1Dto = Object.freeze({
    resourceId: artifact.retentionResourceId,
    role: 'backup',
    sourceRole: artifact.role,
    path: request.retainedPath,
    repositoryRevision: {
      kind: 'resource' as const,
      digest: envelope.value.repositoryDigest,
    },
    contentHash: envelope.value.contentDigest,
    retainUntil: null,
  });
  const intent: LogicalJournalV1Dto['intent'] = {
    operationId: request.operation.operationId,
    groupId: request.operation.groupId,
    pairId: null,
    kind: request.operation.kind,
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: request.operation.before as LogicalJournalV1Dto['intent']['before'],
    after: request.operation.after as LogicalJournalV1Dto['intent']['after'],
    mutates: request.operation.mutates,
    reversibility: {
      kind: 'conditional',
      retentionResourceIds: [artifact.retentionResourceId],
    },
    conflict: null,
  };
  const at = (
    phase: LogicalJournalV1Dto['phase'],
    retainedRows: readonly JournalRetainedV1Dto[],
  ): LogicalJournalV1Dto => {
    const visible = phase === 'live' || phase === 'committed';
    return {
      schemaVersion: 1,
      kind: 'skillsmith.transaction-journal',
      transactionId: request.transactionId,
      intent,
      context: {
        parentOperationId: request.operation.operationId,
        command: 'update',
        workflow: 'update-artifact-history',
        attempt: 1,
        startedAt: request.startedAt,
      },
      disposition: 'forward',
      phase,
      actual: {
        before: [artifact.before],
        after: visible ? [artifact.after] : [],
        retained: retainedRows,
      },
      updatedAt: request.startedAt,
      completedAt: phase === 'committed' ? request.startedAt : null,
    };
  };
  const prepared = at('prepared', []);
  const staged = at('staged', [retained]);
  const backedUp = at('backed-up', [retained]);
  const live = at('live', [retained]);
  const committed = at('committed', [retained]);
  const journals = [prepared, staged, backedUp, live, committed];
  if (journals.some((journal) => !validateJournalV1DtoShape(journal).ok)) {
    return err(failure('invalid-journal'));
  }
  return ok(
    Object.freeze({
      prepared,
      staged,
      backedUp,
      live,
      committed,
      retained,
      envelope: envelope.value,
    }),
  );
};

const sameImage = (left: OperationImage, right: OperationImage): boolean =>
  canonicalPlanningString(left) === canonicalPlanningString(right);

const observePhysicalArtifact = async (
  ports: ArtifactCoordinatorPorts,
  role: ArtifactRole,
  path: string,
): Promise<Readonly<{ image: OperationImage; bytes: Uint8Array; mode: number }>> => {
  const before = await ports.observe(path);
  if (
    before.kind !== 'file' ||
    before.identity === null ||
    before.mode === null ||
    before.linkCount !== 1
  ) {
    throw new TypeError('update artifact history requires one stable regular file');
  }
  const bytes = new Uint8Array(await ports.readBytes(path));
  const after = await ports.observe(path);
  if (
    after.kind !== 'file' ||
    after.identity !== before.identity ||
    after.mode !== before.mode ||
    after.linkCount !== 1
  ) {
    throw new TypeError('update artifact changed while retention was observed');
  }
  return Object.freeze({
    image:
      role === 'manifest'
        ? artifactManifestImageFromBytesV1(path, bytes)
        : artifactLockImageFromBytesV1(path, bytes),
    bytes,
    mode: before.mode,
  });
};

const readPrivateEnvelope = async (
  ports: ArtifactCoordinatorPorts,
  path: string,
): Promise<Uint8Array> => {
  const directory = dirname(path);
  const parentBefore = await ports.observe(directory);
  const before = await ports.observe(path);
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
    throw new TypeError('retained update artifact envelope is not owner-private');
  }
  const bytes = new Uint8Array(await ports.readBytes(path));
  const parentAfter = await ports.observe(directory);
  const after = await ports.observe(path);
  if (
    parentAfter.kind !== 'directory' ||
    parentAfter.identity !== parentBefore.identity ||
    parentAfter.mode !== 0o700 ||
    after.kind !== 'file' ||
    after.identity !== before.identity ||
    after.mode !== 0o600 ||
    after.linkCount !== 1
  ) {
    throw new TypeError('retained update artifact envelope identity changed while reading');
  }
  return bytes;
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const ensurePrivateEnvelope = async (
  ports: ArtifactCoordinatorPorts,
  path: string,
  expected: Uint8Array,
): Promise<Uint8Array> => {
  const directory = dirname(path);
  const observedDirectory = await ports.observe(directory);
  if (observedDirectory.kind === 'absent') {
    await ports.makeDirectoryExclusive(directory, 0o700);
    await ports.fsyncDirectory(dirname(directory));
  } else if (observedDirectory.kind !== 'directory' || observedDirectory.mode !== 0o700) {
    throw new TypeError('retained update artifact directory is not owner-private');
  }
  const observed = await ports.observe(path);
  if (observed.kind === 'absent') {
    await ports.writeBytesExclusive(path, expected, 0o600);
    await ports.fsyncFile(path);
    await ports.fsyncDirectory(directory);
  } else if (observed.kind !== 'file') {
    throw new TypeError('retained update artifact envelope path is not a regular file');
  }
  const adopted = await readPrivateEnvelope(ports, path);
  if (!equalBytes(adopted, expected)) {
    throw new TypeError('retained update artifact envelope conflicts with observed preimage');
  }
  return adopted;
};

const historyFailureResult = (
  operation: ExecutableOperation,
  binding: ValidatedExecutionBinding,
  actualAfter: OperationImage,
  reason: string,
) =>
  createOperationExecutionResult({
    operationId: operation.operationId,
    outcome: 'failed',
    actualBefore: binding.actualBefore,
    actualAfter,
    force: null,
    error: {
      code: 'update-artifact-history-failed',
      message: `update artifact history failed: ${reason}`,
      remediation: 'Re-run the same update to recover its retained artifact history.',
    },
  });

const journalAtPendingPhase = (
  sequence: ForwardUpdateArtifactJournalSequenceV1,
  phase: LogicalJournalV1Dto['phase'],
): LogicalJournalV1Dto =>
  phase === 'prepared'
    ? sequence.prepared
    : phase === 'staged'
      ? sequence.staged
      : phase === 'backed-up'
        ? sequence.backedUp
        : phase === 'live'
          ? sequence.live
          : sequence.committed;

/**
 * Bind one approved update artifact write to its durable logical carrier. The execution
 * coordinator already holds artifact-group, member, and ledger locks when this callback runs.
 */
export const bindForwardUpdateArtifactHistoryV1 = (
  request: BindForwardUpdateArtifactHistoryRequestV1,
): PreparedExecutionBinding => {
  const artifact = exactArtifactOperation(request.operation);
  if (artifact === null) throw new TypeError('update artifact history binding is invalid');
  return Object.freeze({
    ...request.binding,
    execute: async (binding: ValidatedExecutionBinding) => {
      let durableImage = binding.actualBefore;
      try {
        const state = await readLedgerState(request.ports, request.ledgerPath);
        if (!state.ok) throw state.error;
        let model = ledgerModelForMutation(state.value, request.ports.wallNowIso());
        const candidates = Object.values(model.transactions).filter(
          (journal) =>
            journal.intent.operationId === request.operation.operationId &&
            journal.disposition === 'forward' &&
            journal.context.command === 'update' &&
            journal.context.workflow === 'update-artifact-history',
        );
        if (candidates.length > 1) {
          throw new TypeError('update artifact operation has ambiguous pending history');
        }
        const pending = candidates[0] ?? null;
        const transactionId =
          pending?.transactionId ?? request.ports.nextId('update-artifact-transaction');
        const startedAt = pending?.context.startedAt ?? request.ports.wallNowIso();
        const retainedPath = join(
          dirname(request.ledgerPath),
          `.skillsmith-artifact-${transactionId}`,
          `${artifact.role}.backup`,
        );
        const physical = await observePhysicalArtifact(
          request.artifactCoordinator,
          artifact.role,
          artifact.path,
        );
        const physicalIsBefore = sameImage(physical.image, request.operation.before);
        const physicalIsAfter = sameImage(physical.image, request.operation.after);
        if (
          (!physicalIsBefore && !physicalIsAfter) ||
          (pending === null && !physicalIsBefore) ||
          (pending?.phase === 'prepared' && !physicalIsBefore) ||
          (pending?.phase === 'staged' && !physicalIsBefore)
        ) {
          throw new TypeError('physical update artifact does not match its retained journal phase');
        }

        let retainedBytes: Uint8Array;
        let expectedAfterMode: number;
        if (pending !== null && pending.phase !== 'prepared') {
          retainedBytes = await readPrivateEnvelope(request.artifactCoordinator, retainedPath);
          const decoded = decodeRetainedArtifactPreimageV1(retainedBytes, {
            operationId: request.operation.operationId,
            role: artifact.role,
            path: artifact.path,
            after: { digest: artifact.afterDigest, mode: physical.mode },
          });
          if (!decoded.ok) throw new TypeError(decoded.error.message);
          expectedAfterMode = decoded.value.model.after.mode;
        } else {
          if (!physicalIsBefore) {
            throw new TypeError('update artifact preimage is no longer available');
          }
          expectedAfterMode = physical.mode;
          const encoded = encodeRetainedArtifactPreimageV1({
            operationId: request.operation.operationId,
            role: artifact.role,
            path: artifact.path,
            before: { bytes: physical.bytes, mode: physical.mode },
            after: { digest: artifact.afterDigest, mode: expectedAfterMode },
          });
          if (!encoded.ok) throw new TypeError(encoded.error.message);
          retainedBytes = encoded.value.encoded;
        }
        const sequence = createForwardUpdateArtifactJournalSequenceV1({
          operation: request.operation,
          transactionId,
          startedAt,
          retainedPath,
          retainedBytes,
          expectedAfterMode,
        });
        if (!sequence.ok) throw new TypeError(sequence.error.message);
        if (
          pending !== null &&
          canonicalPlanningString(pending) !==
            canonicalPlanningString(journalAtPendingPhase(sequence.value, pending.phase))
        ) {
          throw new TypeError('pending update artifact history differs from approved authority');
        }

        const persistence = createLedgerPersistenceGateway(
          request.ports,
          request.ledgerPath,
          request.signal,
        );
        const persist = async (journal: LogicalJournalV1Dto, terminal = false): Promise<void> => {
          const advanced = terminal
            ? commitLogicalTransaction(model, journal)
            : advanceLogicalTransaction(model, journal);
          if (!advanced.ok) throw new TypeError(advanced.error.message);
          const persisted = await persistence.persist(advanced.value);
          if (!persisted.ok) throw persisted.error;
          model = persisted.value.model;
        };

        if (pending === null) await persist(sequence.value.prepared);
        if (pending === null || pending.phase === 'prepared') {
          retainedBytes = await ensurePrivateEnvelope(
            request.artifactCoordinator,
            retainedPath,
            retainedBytes,
          );
          await persist(sequence.value.staged);
        }
        if (pending === null || pending.phase === 'prepared' || pending.phase === 'staged') {
          await persist(sequence.value.backedUp);
        }

        const physicalResult = await request.binding.execute(binding);
        if (sameImage(physicalResult.actualAfter, request.operation.after)) {
          durableImage = request.operation.after;
        }
        if (!sameImage(durableImage, request.operation.after)) return physicalResult;
        if (pending?.phase !== 'live') await persist(sequence.value.live);
        await persist(sequence.value.committed, true);
        await request.onLedgerCommitted?.();
        return physicalResult;
      } catch (error) {
        return historyFailureResult(
          request.operation,
          binding,
          durableImage,
          error instanceof Error ? error.message : 'unknown retained history failure',
        );
      }
    },
  });
};
