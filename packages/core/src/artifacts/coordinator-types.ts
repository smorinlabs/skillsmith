import type { Result } from '../result.ts';
import type { ArtifactDigest } from './hash.ts';
import type { PortableLockV1 } from './lock.ts';
import type { ManifestEditRequest } from './manifest-edit.ts';
import type { ResolvedArtifactPair } from './pair.ts';

export const ARTIFACT_LOCK_RETRY_DELAYS_MS = Object.freeze([0, 100, 200, 400, 800, 800] as const);
export const ARTIFACT_CENTRAL_LOCK_STALE_MS = 2_000 as const;
export const ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS = 1_000 as const;
export const ARTIFACT_COMPATIBILITY_LOCK_STALE_MS = 30_000 as const;
export const ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS = 5_000 as const;

export type ArtifactParentRevision =
  | { readonly state: 'present'; readonly path: string; readonly identity: string }
  | {
      readonly state: 'missing';
      readonly nearestExistingPath: string;
      readonly nearestExistingIdentity: string;
      readonly missingSegments: readonly string[];
    };

export type ArtifactFileRevision =
  | { readonly state: 'absent'; readonly parent: ArtifactParentRevision }
  | {
      readonly state: 'file';
      readonly bytes: Uint8Array;
      readonly digest: ArtifactDigest;
      readonly mode: number;
      readonly identity: string;
      readonly linkCount: 1;
      readonly parent: ArtifactParentRevision;
    };

export interface ArtifactPathObservation {
  readonly kind: 'absent' | 'file' | 'directory' | 'symlink' | 'other';
  readonly mode: number | null;
  readonly identity: string | null;
  readonly linkCount: number | null;
  readonly parent: ArtifactParentRevision;
}

export interface ArtifactPairSnapshot {
  readonly manifest: ArtifactFileRevision;
  readonly lock: ArtifactFileRevision;
}

export type ArtifactMutationErrorReason =
  | 'invalid-request'
  | 'unsafe-human-edit'
  | 'invalid-utf8'
  | 'invalid-manifest'
  | 'invalid-lock'
  | 'invalid-file-kind'
  | 'artifact-alias'
  | 'lock-contention'
  | 'external-writer-conflict'
  | 'stage-collision'
  | 'recovery-record-invalid'
  | 'recovery-conflict'
  | 'filesystem-failure'
  | 'permission-denied'
  | 'cancelled';

export interface ArtifactMutationError {
  readonly code: 'artifact-mutation';
  readonly exitCode: 2 | 3 | 6 | 130;
  readonly reason: ArtifactMutationErrorReason;
  readonly role?: 'manifest' | 'lock' | 'recovery' | 'staging' | 'backup';
  readonly field?: string;
  readonly path?: string;
  readonly manualPatch?: string;
  readonly durableState?: 'unobserved-before' | 'before' | 'after';
  readonly manifestRevision?: ArtifactFileRevision;
  readonly lockRevision?: ArtifactFileRevision;
  readonly message: string;
}

export type ArtifactRecoveryCursor =
  | 'prepared'
  | 'staging'
  | 'final-guard'
  | 'lock-backup'
  | 'lock-install'
  | 'manifest-backup'
  | 'manifest-install'
  | 'pair-verify'
  | 'rollback-manifest-remove'
  | 'rollback-manifest-restore'
  | 'rollback-lock-remove'
  | 'rollback-lock-restore'
  | 'rollback-verify'
  | 'committed'
  | 'cleanup';

export type ArtifactRecordedBeforeState =
  | { readonly state: 'absent' }
  | {
      readonly state: 'file';
      readonly digest: ArtifactDigest;
      readonly mode: number;
      readonly identity: string;
    };

export type ArtifactRecordedAfterState =
  | { readonly state: 'absent' }
  | {
      readonly state: 'file';
      readonly digest: ArtifactDigest;
      readonly mode: number;
      readonly identity: string | null;
    };

export interface ArtifactRecoveryObject {
  readonly role: 'manifest' | 'lock';
  readonly slot: 'stage' | 'backup' | 'discard';
  readonly path: string;
  readonly expectedDigest: ArtifactDigest;
  readonly expectedMode: number;
  readonly identity: string | null;
}

export interface ArtifactRecoveryDirectory {
  readonly purpose: 'transaction';
  readonly path: string;
  readonly before: 'absent';
  readonly ownershipToken: string;
  readonly identity: string | null;
}

export interface ArtifactRecordedParent {
  readonly path: string;
  readonly identity: string;
}

export interface ArtifactPairRecoveryRecord {
  readonly kind: 'skillsmith-artifact-pair-recovery';
  readonly version: 1;
  readonly key: string;
  readonly transactionId: string;
  readonly attempt: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly disposition: 'forward' | 'rollback';
  readonly pair: { readonly manifest: string; readonly lock: string | null };
  readonly memberTargets: readonly string[];
  readonly cursor: ArtifactRecoveryCursor;
  readonly parents: {
    readonly manifest: ArtifactRecordedParent;
    readonly lock: ArtifactRecordedParent | null;
  };
  readonly before: {
    readonly manifest: ArtifactRecordedBeforeState;
    readonly lock: ArtifactRecordedBeforeState | null;
  };
  readonly after: {
    readonly manifest: ArtifactRecordedAfterState;
    readonly lock: ArtifactRecordedAfterState | null;
  };
  readonly rollbackTarget: {
    readonly manifest: ArtifactRecordedBeforeState;
    readonly lock: ArtifactRecordedBeforeState | null;
  };
  readonly directories: readonly ArtifactRecoveryDirectory[];
  readonly objects: readonly ArtifactRecoveryObject[];
  readonly collisionPaths: readonly string[];
}

export type ArtifactBarrierOperation =
  | 'create-directory-exclusive'
  | 'create-transaction-directory'
  | 'create-file-exclusive'
  | 'set-file-mode'
  | 'fsync-file'
  | 'move-into-owned-transaction'
  | 'link-file-no-replace'
  | 'replace-recovery-record'
  | 'remove-file'
  | 'remove-directory'
  | 'fsync-directory';

export interface ArtifactBarrierIdentity {
  readonly operationId: string;
  readonly occurrence: number;
  readonly recordRevision: string | null;
}

export type ArtifactPairBarrier = ArtifactBarrierIdentity &
  (
    | { readonly kind: 'lock-acquired'; readonly targetClass: 'central' | 'compatibility' }
    | { readonly kind: 'recovery-discovered' }
    | { readonly kind: 'record-durable'; readonly cursor: ArtifactRecoveryCursor }
    | {
        readonly kind: 'mutation-returned';
        readonly cursor: ArtifactRecoveryCursor | 'provisioning';
        readonly operation: ArtifactBarrierOperation;
        readonly role?: 'manifest' | 'lock';
        readonly object?:
          | 'parent'
          | 'transaction'
          | 'stage'
          | 'backup'
          | 'discard'
          | 'live'
          | 'recovery-temp'
          | 'recovery-record';
      }
    | {
        readonly kind: 'object-verified';
        readonly cursor: ArtifactRecoveryCursor;
        readonly role?: 'manifest' | 'lock';
        readonly object:
          | 'transaction'
          | 'stage'
          | 'backup'
          | 'discard'
          | 'live'
          | 'pair'
          | 'recovery-temp'
          | 'recovery-record';
      }
    | { readonly kind: 'record-removed' }
  );

export interface ArtifactRecoveryEnvelope {
  readonly record: ArtifactPairRecoveryRecord;
  readonly revision: string;
}

export interface ArtifactPairRecoveryPort {
  discover(): Promise<readonly ArtifactRecoveryEnvelope[]>;
  create(record: ArtifactPairRecoveryRecord): Promise<ArtifactRecoveryEnvelope>;
  replace(
    record: ArtifactPairRecoveryRecord,
    expectedRevision: string,
  ): Promise<ArtifactRecoveryEnvelope>;
  remove(key: string, expectedRevision: string): Promise<void>;
}

export interface ArtifactCoordinatorPorts {
  readonly coordinationRoot: string;
  observe(path: string): Promise<ArtifactPathObservation>;
  readBytes(path: string): Promise<Uint8Array>;
  makeDirectoryExclusive(path: string, mode: 0o700): Promise<void>;
  createTransactionDirectoryExclusive(
    path: string,
    ownershipToken: string,
  ): Promise<{ readonly identity: string }>;
  writeBytesExclusive(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  setFileMode(path: string, mode: number): Promise<void>;
  moveIntoOwnedTransaction(source: string, destination: string): Promise<void>;
  linkFileNoReplace(source: string, destination: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  removeEmptyDirectory(path: string): Promise<void>;
  fsyncFile(path: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
  withFileLock<T>(
    target: string,
    options: {
      readonly policy: 'central' | 'compatibility';
      readonly centralOperationId: string;
      readonly signal?: AbortSignal;
      readonly retryDelaysMs: readonly number[];
    },
    operation: () => Promise<T>,
  ): Promise<T>;
  readonly recovery: ArtifactPairRecoveryPort;
  nextId(
    purpose: 'artifact-transaction' | 'artifact-operation' | 'artifact-cas' | 'artifact-ownership',
  ): string;
  afterBarrier?(barrier: ArtifactPairBarrier): Promise<void>;
}

export interface ArtifactGroupLockLease {
  acquireCompatibilityTargets(memberTargets: readonly string[]): Promise<void>;
}

export type GeneratedLockAction =
  | { readonly kind: 'keep' }
  | { readonly kind: 'replace'; readonly lock: PortableLockV1 }
  | {
      readonly kind: 'replace-exact';
      readonly lock: PortableLockV1;
      readonly expectedByteRevision: ArtifactDigest | null;
    }
  | {
      readonly kind: 'replace-invalid';
      readonly lock: PortableLockV1;
      readonly expectedByteRevision: ArtifactDigest;
    }
  | { readonly kind: 'remove' };

export type HumanManifestAction =
  | { readonly kind: 'keep' }
  | { readonly kind: 'edit'; readonly request: ManifestEditRequest }
  | { readonly kind: 'replace'; readonly bytes: Uint8Array };

export interface ArtifactPairMutationRequest {
  readonly pair: ResolvedArtifactPair;
  readonly manifest: HumanManifestAction;
  readonly lock: GeneratedLockAction;
  readonly signal?: AbortSignal;
}

export interface ArtifactPairMutationResult {
  readonly outcome: 'unchanged' | 'committed' | 'recovered-and-committed';
  readonly externalBytesReplayed: boolean;
  readonly manifestRevision: ArtifactFileRevision;
  readonly lockRevision: ArtifactFileRevision;
}

export interface CoordinatedHumanFileEdit {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
  readonly mode: number;
}

export interface CoordinatedHumanFileRequest {
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly opaqueManifestBackup?: Readonly<{
    readonly expectedResourceDigest: ArtifactDigest;
  }>;
  readonly edit: (
    current: ArtifactFileRevision,
  ) => Result<CoordinatedHumanFileEdit, ArtifactMutationError>;
}

export interface CoordinatedHumanFileResult {
  readonly outcome: 'unchanged' | 'committed' | 'recovered-and-committed';
  readonly revision: ArtifactFileRevision;
}
