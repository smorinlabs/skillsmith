import { basename, dirname } from 'node:path';
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
} from '../artifacts/retained-preimage-codec.ts';
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
