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
import type { LedgerModel } from '../artifacts/ledger-types.ts';
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
  beginPendingUpdateArtifactRetentionCleanup,
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
  /** Every operation owned by the current invocation; defaults to this artifact operation. */
  readonly currentOperationIds?: readonly string[];
  readonly onLedgerCommitted?: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface RecoverPendingUpdateArtifactHistoryRequestV1 {
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly ports: PlacementPorts;
  readonly ledgerPath: string;
  readonly currentOperationIds: readonly string[];
  readonly signal?: AbortSignal;
}

type PendingUpdateArtifactHistoryRecoveryRequestV1 = Readonly<{
  artifactCoordinator: ArtifactCoordinatorPorts;
  ports: PlacementPorts;
  ledgerPath: string;
  currentOperationIds: ReadonlySet<string>;
  signal?: AbortSignal;
}>;

type ArtifactRole = 'manifest' | 'lock';
type ArtifactHistoryImage = OperationImage | LogicalJournalV1Dto['intent']['before'];

interface PrivateEnvelopeObservation {
  readonly bytes: Uint8Array;
  readonly identity: string;
  readonly parentIdentity: string;
}

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

const imagePath = (role: ArtifactRole, image: ArtifactHistoryImage): string | null => {
  const location =
    role === 'manifest' && image.kind === 'manifest'
      ? image.location
      : role === 'lock' && image.kind === 'lock'
        ? image.location
        : null;
  return location?.kind === 'machine-bound' ? location.path : null;
};

const imageDigest = (role: ArtifactRole, image: ArtifactHistoryImage): OperationDigest | null =>
  role === 'manifest' && image.kind === 'manifest'
    ? (image.byteHash as OperationDigest)
    : role === 'lock' && image.kind === 'lock'
      ? (image.canonicalHash as OperationDigest)
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
  image: ArtifactHistoryImage,
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

const sameImage = (left: unknown, right: unknown): boolean =>
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

const observePrivateEnvelope = async (
  ports: ArtifactCoordinatorPorts,
  path: string,
): Promise<PrivateEnvelopeObservation> => {
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
  return Object.freeze({
    bytes,
    identity: before.identity,
    parentIdentity: parentBefore.identity,
  });
};

const readPrivateEnvelope = async (
  ports: ArtifactCoordinatorPorts,
  path: string,
): Promise<Uint8Array> => (await observePrivateEnvelope(ports, path)).bytes;

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

interface PendingUpdateArtifactAuthority {
  readonly journal: LogicalJournalV1Dto;
  readonly role: ArtifactRole;
  readonly path: string;
  readonly afterDigest: ArtifactDigest;
  readonly retainedPath: string;
  readonly retained: JournalRetainedV1Dto | null;
}

interface PendingUpdateArtifactCleanupAuthority {
  readonly journal: LogicalJournalV1Dto;
  readonly role: ArtifactRole;
  readonly path: string;
  readonly afterDigest: ArtifactDigest;
  readonly retainedPath: string;
}

const pendingPairNullArtifactRole = (journal: LogicalJournalV1Dto): ArtifactRole | null => {
  const role: ArtifactRole | null =
    journal.intent.kind === 'write-manifest'
      ? 'manifest'
      : journal.intent.kind === 'write-lock'
        ? 'lock'
        : null;
  return role !== null && journal.phase !== 'committed' && journal.intent.pairId === null
    ? role
    : null;
};

const pendingUpdateArtifactAuthority = (
  journal: LogicalJournalV1Dto,
  ledgerPath: string,
): PendingUpdateArtifactAuthority | null => {
  const role: ArtifactRole | null =
    journal.intent.kind === 'write-manifest'
      ? 'manifest'
      : journal.intent.kind === 'write-lock'
        ? 'lock'
        : null;
  if (
    role === null ||
    journal.phase === 'committed' ||
    journal.disposition !== 'forward' ||
    journal.intent.pairId !== null ||
    journal.intent.skill !== null ||
    journal.intent.source !== null ||
    journal.intent.tool !== null ||
    journal.intent.scope !== null ||
    journal.context.command !== 'update' ||
    journal.context.workflow !== 'update-artifact-history' ||
    journal.context.parentOperationId !== journal.intent.operationId ||
    journal.intent.reversibility.kind !== 'conditional' ||
    journal.intent.reversibility.retentionResourceIds.length !== 1
  ) {
    return null;
  }
  const path = imagePath(role, journal.intent.before);
  const afterPath = imagePath(role, journal.intent.after);
  const afterDigest = imageDigest(role, journal.intent.after);
  const beforeActual = actualFor(role, journal.intent.before);
  const afterActual = actualFor(role, journal.intent.after);
  if (
    path === null ||
    afterPath !== path ||
    afterDigest === null ||
    beforeActual === null ||
    afterActual === null ||
    canonicalPlanningString(journal.actual.before) !== canonicalPlanningString([beforeActual]) ||
    canonicalPlanningString(journal.actual.after) !==
      canonicalPlanningString(journal.phase === 'live' ? [afterActual] : [])
  ) {
    return null;
  }
  const retainedPath = join(
    dirname(ledgerPath),
    `.skillsmith-artifact-${journal.transactionId}`,
    `${role}.backup`,
  );
  const retained = journal.actual.retained[0] ?? null;
  if (
    (journal.phase === 'prepared' && journal.actual.retained.length !== 0) ||
    (journal.phase !== 'prepared' &&
      (journal.actual.retained.length !== 1 ||
        retained?.role !== 'backup' ||
        retained.sourceRole !== role ||
        retained.resourceId !== journal.intent.reversibility.retentionResourceIds[0] ||
        retained.path !== retainedPath ||
        retained.repositoryRevision.kind !== 'resource' ||
        retained.retainUntil !== null))
  ) {
    return null;
  }
  return Object.freeze({
    journal,
    role,
    path,
    afterDigest: afterDigest as ArtifactDigest,
    retainedPath,
    retained,
  });
};

const pendingUpdateArtifactCleanupAuthority = (
  journal: LogicalJournalV1Dto,
  ledgerPath: string,
): PendingUpdateArtifactCleanupAuthority | null => {
  const role: ArtifactRole | null =
    journal.intent.kind === 'write-manifest'
      ? 'manifest'
      : journal.intent.kind === 'write-lock'
        ? 'lock'
        : null;
  if (
    role === null ||
    journal.phase === 'committed' ||
    journal.disposition !== 'rollback' ||
    journal.intent.pairId !== null ||
    journal.intent.skill !== null ||
    journal.intent.source !== null ||
    journal.intent.tool !== null ||
    journal.intent.scope !== null ||
    journal.context.command !== 'update' ||
    journal.context.workflow !== 'update-artifact-orphan-cleanup' ||
    journal.context.parentOperationId !== journal.intent.operationId ||
    journal.context.attempt < 2 ||
    journal.intent.reversibility.kind !== 'conditional' ||
    journal.intent.reversibility.retentionResourceIds.length !== 1 ||
    journal.actual.retained.length !== 0 ||
    journal.completedAt !== null
  ) {
    return null;
  }
  const path = imagePath(role, journal.intent.before);
  const afterPath = imagePath(role, journal.intent.after);
  const afterDigest = imageDigest(role, journal.intent.after);
  const beforeActual = actualFor(role, journal.intent.before);
  if (
    path === null ||
    afterPath !== path ||
    afterDigest === null ||
    beforeActual === null ||
    canonicalPlanningString(journal.actual.before) !== canonicalPlanningString([beforeActual]) ||
    canonicalPlanningString(journal.actual.after) !==
      canonicalPlanningString(journal.phase === 'live' ? [beforeActual] : [])
  ) {
    return null;
  }
  return Object.freeze({
    journal,
    role,
    path,
    afterDigest: afterDigest as ArtifactDigest,
    retainedPath: join(
      dirname(ledgerPath),
      `.skillsmith-artifact-${journal.transactionId}`,
      `${role}.backup`,
    ),
  });
};

type OptionalPrivateEnvelope =
  | Readonly<{
      readonly state: 'absent';
      readonly directoryIdentity: string | null;
    }>
  | Readonly<{
      readonly state: 'present';
      readonly value: PrivateEnvelopeObservation;
    }>;

const observeOptionalPrivateEnvelope = async (
  ports: ArtifactCoordinatorPorts,
  path: string,
): Promise<OptionalPrivateEnvelope> => {
  const directory = dirname(path);
  const file = await ports.observe(path);
  if (file.kind !== 'absent') {
    return Object.freeze({ state: 'present', value: await observePrivateEnvelope(ports, path) });
  }
  const parent = await ports.observe(directory);
  if (parent.kind === 'absent') {
    return Object.freeze({ state: 'absent', directoryIdentity: null });
  }
  if (
    parent.kind !== 'directory' ||
    parent.identity === null ||
    parent.mode !== 0o700 ||
    file.parent.state !== 'present' ||
    file.parent.identity !== parent.identity
  ) {
    throw new TypeError('prepared update artifact orphan directory is not owner-private');
  }
  return Object.freeze({ state: 'absent', directoryIdentity: parent.identity });
};

const removePrivateEnvelope = async (
  ports: ArtifactCoordinatorPorts,
  path: string,
  observation: OptionalPrivateEnvelope,
): Promise<void> => {
  const directory = dirname(path);
  const expectedDirectoryIdentity =
    observation.state === 'present'
      ? observation.value.parentIdentity
      : observation.directoryIdentity;
  if (observation.state === 'present') {
    const parent = await ports.observe(directory);
    const file = await ports.observe(path);
    if (
      parent.kind !== 'directory' ||
      parent.identity !== observation.value.parentIdentity ||
      parent.mode !== 0o700 ||
      file.kind !== 'file' ||
      file.identity !== observation.value.identity ||
      file.mode !== 0o600 ||
      file.linkCount !== 1 ||
      file.parent.state !== 'present' ||
      file.parent.identity !== parent.identity
    ) {
      throw new TypeError('prepared update artifact orphan changed before cleanup');
    }
    await ports.removeFile(path);
    await ports.fsyncDirectory(directory);
  }
  if (expectedDirectoryIdentity === null) return;
  const directoryBefore = await ports.observe(directory);
  if (
    directoryBefore.kind !== 'directory' ||
    directoryBefore.identity !== expectedDirectoryIdentity ||
    directoryBefore.mode !== 0o700
  ) {
    throw new TypeError('prepared update artifact orphan directory changed before cleanup');
  }
  await ports.removeEmptyDirectory(directory);
  await ports.fsyncDirectory(dirname(directory));
};

const beginPendingArtifactAbortProjection = (
  model: LedgerModel,
  authority: PendingUpdateArtifactAuthority,
  retainedObservation: PrivateEnvelopeObservation | null,
  updatedAt: string,
): LedgerModel => {
  const retainedResources =
    authority.retained === null
      ? []
      : [
          {
            resourceId: authority.retained.resourceId,
            path: authority.retained.path,
            repositoryRevision: authority.retained.repositoryRevision,
            contentHash: authority.retained.contentHash,
            state: 'present' as const,
            owned: true,
            kind: 'file' as const,
            beforeIdentity: retainedObservation?.identity ?? null,
            afterIdentity: retainedObservation?.identity ?? null,
          },
        ];
  const aborted = beginPendingUpdateArtifactRetentionCleanup(model, {
    transactionId: authority.journal.transactionId,
    pairId: null,
    command: 'update',
    workflow: 'update-artifact-orphan-cleanup',
    updatedAt,
    retainedResources,
  });
  if (!aborted.ok) throw new TypeError(aborted.error.message);
  return aborted.value;
};

const completePendingArtifactAbortProjection = (
  model: LedgerModel,
  transactionId: string,
  updatedAt: string,
): LedgerModel => {
  let next = model;
  let rollback = next.transactions[transactionId];
  if (rollback === undefined) throw new TypeError('artifact orphan rollback was not projected');
  const phases = ['prepared', 'staged', 'backed-up', 'live'] as const;
  const start = phases.indexOf(rollback.phase as (typeof phases)[number]);
  if (
    start < 0 ||
    rollback.disposition !== 'rollback' ||
    rollback.context.command !== 'update' ||
    rollback.context.workflow !== 'update-artifact-orphan-cleanup' ||
    rollback.context.parentOperationId !== rollback.intent.operationId ||
    rollback.intent.pairId !== null ||
    (rollback.intent.kind !== 'write-manifest' && rollback.intent.kind !== 'write-lock') ||
    rollback.actual.retained.length !== 0
  ) {
    throw new TypeError('artifact orphan rollback marker is invalid');
  }
  for (const phase of phases.slice(start + 1)) {
    const journal: LogicalJournalV1Dto = {
      ...rollback,
      phase,
      actual: {
        ...rollback.actual,
        after: phase === 'live' ? rollback.actual.before : [],
      },
      updatedAt,
      completedAt: null,
    };
    const advanced = advanceLogicalTransaction(next, journal);
    if (!advanced.ok) throw new TypeError(advanced.error.message);
    next = advanced.value;
    rollback = next.transactions[transactionId];
    if (rollback === undefined) throw new TypeError('artifact orphan rollback phase was lost');
  }
  const committed = commitLogicalTransaction(next, {
    ...rollback,
    phase: 'committed',
    completedAt: updatedAt,
    updatedAt,
  });
  if (!committed.ok) throw new TypeError(committed.error.message);
  return committed.value;
};

const recoverPendingArtifactCleanupMarkers = async (
  model: LedgerModel,
  request: PendingUpdateArtifactHistoryRecoveryRequestV1,
  persist: (next: LedgerModel) => Promise<LedgerModel>,
): Promise<LedgerModel> => {
  let next = model;
  const markers = Object.values(next.transactions)
    .filter((journal) => journal.context.workflow === 'update-artifact-orphan-cleanup')
    .map((journal) => {
      const authority = pendingUpdateArtifactCleanupAuthority(journal, request.ledgerPath);
      if (authority === null) {
        throw new TypeError('pending update artifact cleanup marker is invalid');
      }
      return authority;
    })
    .sort((left, right) => left.journal.transactionId.localeCompare(right.journal.transactionId));
  for (const authority of markers) {
    if (request.signal?.aborted) throw new TypeError('update artifact orphan cleanup cancelled');
    const physical = await observePhysicalArtifact(
      request.artifactCoordinator,
      authority.role,
      authority.path,
    );
    const envelope = await observeOptionalPrivateEnvelope(
      request.artifactCoordinator,
      authority.retainedPath,
    );
    const decoded =
      envelope.state === 'present'
        ? decodeRetainedArtifactPreimageV1(envelope.value.bytes, {
            operationId: authority.journal.intent.operationId,
            role: authority.role,
            path: authority.path,
          })
        : null;
    if (decoded !== null && !decoded.ok) throw new TypeError(decoded.error.message);
    if (
      decoded?.ok &&
      (decoded.value.model.after.digest !== authority.afterDigest ||
        !sameImage(physical.image, authority.journal.intent.before) ||
        physical.mode !== decoded.value.model.before.mode ||
        !equalBytes(physical.bytes, decoded.value.model.before.bytes))
    ) {
      throw new TypeError('pending update artifact cleanup authority changed before recovery');
    }
    if (!sameImage(physical.image, authority.journal.intent.before)) {
      throw new TypeError('pending update artifact cleanup physical preimage changed');
    }
    await removePrivateEnvelope(request.artifactCoordinator, authority.retainedPath, envelope);
    next = await persist(
      completePendingArtifactAbortProjection(
        next,
        authority.journal.transactionId,
        request.ports.wallNowIso(),
      ),
    );
  }
  return next;
};

const finalizePendingArtifactProjection = (
  model: LedgerModel,
  authority: PendingUpdateArtifactAuthority,
  updatedAt: string,
): LedgerModel => {
  let next = model;
  let pending = authority.journal;
  if (pending.phase === 'backed-up') {
    const after = actualFor(authority.role, pending.intent.after);
    if (after === null) throw new TypeError('pending artifact terminal image is invalid');
    const live: LogicalJournalV1Dto = {
      ...pending,
      phase: 'live',
      actual: { ...pending.actual, after: [after] },
      updatedAt,
      completedAt: null,
    };
    const advanced = advanceLogicalTransaction(next, live);
    if (!advanced.ok) throw new TypeError(advanced.error.message);
    next = advanced.value;
    pending = live;
  }
  if (pending.phase !== 'live') {
    throw new TypeError('pending artifact cannot be finalized from its durable phase');
  }
  const committed = commitLogicalTransaction(next, {
    ...pending,
    phase: 'committed',
    updatedAt,
    completedAt: updatedAt,
  });
  if (!committed.ok) throw new TypeError(committed.error.message);
  return committed.value;
};

const recoverSupersededArtifactHistory = async (
  model: LedgerModel,
  request: PendingUpdateArtifactHistoryRecoveryRequestV1,
  persist: (next: LedgerModel) => Promise<LedgerModel>,
): Promise<LedgerModel> => {
  for (const journal of Object.values(model.transactions)) {
    if (pendingPairNullArtifactRole(journal) === null) continue;
    const forward = pendingUpdateArtifactAuthority(journal, request.ledgerPath);
    const cleanup = pendingUpdateArtifactCleanupAuthority(journal, request.ledgerPath);
    if (forward !== null || cleanup !== null) continue;
    if (
      journal.disposition === 'rollback' &&
      journal.context.workflow === 'undo-artifact-history'
    ) {
      throw new TypeError('pending undo artifact history must recover before update');
    }
    throw new TypeError('pending update artifact recovery authority is invalid');
  }
  let next = await recoverPendingArtifactCleanupMarkers(model, request, persist);
  const superseded = Object.values(next.transactions)
    .filter((journal) => journal.context.workflow === 'update-artifact-history')
    .map((journal) => {
      const authority = pendingUpdateArtifactAuthority(journal, request.ledgerPath);
      if (authority === null) {
        throw new TypeError('pending update artifact history journal is invalid');
      }
      return authority;
    })
    .filter((authority) => !request.currentOperationIds.has(authority.journal.intent.operationId))
    .sort((left, right) => left.journal.transactionId.localeCompare(right.journal.transactionId));
  for (const authority of superseded) {
    if (request.signal?.aborted) throw new TypeError('update artifact orphan cleanup cancelled');
    const physical = await observePhysicalArtifact(
      request.artifactCoordinator,
      authority.role,
      authority.path,
    );
    const envelope = await observeOptionalPrivateEnvelope(
      request.artifactCoordinator,
      authority.retainedPath,
    );
    const decoded =
      envelope.state === 'present'
        ? decodeRetainedArtifactPreimageV1(envelope.value.bytes, {
            operationId: authority.journal.intent.operationId,
            role: authority.role,
            path: authority.path,
          })
        : null;
    if (decoded !== null && !decoded.ok) throw new TypeError(decoded.error.message);
    if (
      decoded?.ok &&
      (decoded.value.model.after.digest !== authority.afterDigest ||
        (authority.retained !== null &&
          (decoded.value.repositoryDigest !== authority.retained.repositoryRevision.digest ||
            decoded.value.contentDigest !== authority.retained.contentHash)))
    ) {
      throw new TypeError('pending update artifact envelope differs from journal authority');
    }
    if (authority.retained !== null && (envelope.state !== 'present' || !decoded?.ok)) {
      throw new TypeError('pending update artifact retained envelope is missing');
    }
    const physicalBefore =
      sameImage(physical.image, authority.journal.intent.before) &&
      (decoded?.ok ? physical.mode === decoded.value.model.before.mode : true) &&
      (decoded?.ok ? equalBytes(physical.bytes, decoded.value.model.before.bytes) : true);
    const physicalAfter =
      decoded?.ok === true &&
      sameImage(physical.image, authority.journal.intent.after) &&
      physical.mode === decoded.value.model.after.mode;
    const canAbort =
      physicalBefore &&
      (authority.journal.phase === 'prepared' ||
        authority.journal.phase === 'staged' ||
        authority.journal.phase === 'backed-up');
    const canFinalize =
      physicalAfter &&
      (authority.journal.phase === 'backed-up' || authority.journal.phase === 'live');
    if (!canAbort && !canFinalize) {
      throw new TypeError('pending update artifact cannot be recovered for the next invocation');
    }
    const updatedAt = request.ports.wallNowIso();
    if (canFinalize) {
      next = await persist(finalizePendingArtifactProjection(next, authority, updatedAt));
      continue;
    }
    next = await persist(
      beginPendingArtifactAbortProjection(
        next,
        authority,
        envelope.state === 'present' ? envelope.value : null,
        updatedAt,
      ),
    );
    await removePrivateEnvelope(request.artifactCoordinator, authority.retainedPath, envelope);
    next = await persist(
      completePendingArtifactAbortProjection(next, authority.journal.transactionId, updatedAt),
    );
  }
  return next;
};

/**
 * Recover or reject every pending update artifact carrier before an invocation can schedule any
 * physical operation. The caller must hold the artifact-group, member, and ledger lock hierarchy.
 */
export const recoverPendingUpdateArtifactHistoryV1 = async (
  request: RecoverPendingUpdateArtifactHistoryRequestV1,
): Promise<boolean> => {
  const state = await readLedgerState(request.ports, request.ledgerPath);
  if (!state.ok) throw state.error;
  const model = ledgerModelForMutation(state.value, request.ports.wallNowIso());
  const persistence = createLedgerPersistenceGateway(
    request.ports,
    request.ledgerPath,
    request.signal,
  );
  let changed = false;
  await recoverSupersededArtifactHistory(
    model,
    {
      artifactCoordinator: request.artifactCoordinator,
      ports: request.ports,
      ledgerPath: request.ledgerPath,
      currentOperationIds: new Set(request.currentOperationIds),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    },
    async (next) => {
      const persisted = await persistence.persist(next);
      if (!persisted.ok) throw persisted.error;
      changed = true;
      return persisted.value.model;
    },
  );
  return changed;
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
        const persistence = createLedgerPersistenceGateway(
          request.ports,
          request.ledgerPath,
          request.signal,
        );
        model = await recoverSupersededArtifactHistory(
          model,
          {
            artifactCoordinator: request.artifactCoordinator,
            ports: request.ports,
            ledgerPath: request.ledgerPath,
            currentOperationIds: new Set([
              request.operation.operationId,
              ...(request.currentOperationIds ?? []),
            ]),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
          async (next) => {
            const persisted = await persistence.persist(next);
            if (!persisted.ok) throw persisted.error;
            return persisted.value.model;
          },
        );
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
