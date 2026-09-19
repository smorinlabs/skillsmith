import {
  ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS,
  ARTIFACT_CENTRAL_LOCK_STALE_MS,
  ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS,
  ARTIFACT_COMPATIBILITY_LOCK_STALE_MS,
  ARTIFACT_LOCK_RETRY_DELAYS_MS,
  commitArtifactPair,
  editManifestBytes,
  readCoordinatedArtifactPair,
  recoverArtifactPair,
  withArtifactGroupLock,
} from '@skillsmith/core';
import type * as publicCore from '@skillsmith/core';
import type {
  ArtifactCoordinatorPorts,
  ArtifactFileRevision,
  ArtifactGroupLockLease,
  ArtifactMutationError,
  ArtifactPairMutationRequest,
  ArtifactPairMutationResult,
  ArtifactPairRecoveryRecord,
  ArtifactPairSnapshot,
  ArtifactRecoveryCursor,
  GeneratedLockAction,
  HumanManifestAction,
  ManifestEdit,
  ManifestEditRequest,
  ManifestEditResult,
  ManifestEditTarget,
  Result,
  RuntimePorts,
} from '@skillsmith/core/public-types';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
// A public contract exported as `any` is not an implementation. Missing imports are also treated
// as `any` by TypeScript after TS2305, so these checks intentionally reinforce the named-export
// red until each authority has a closed shape.
type WhenAvailable<T, Check> = IsAny<T> extends true ? false : Check extends true ? true : false;

type _RetryTuple = Assert<
  Equal<typeof ARTIFACT_LOCK_RETRY_DELAYS_MS, readonly [0, 100, 200, 400, 800, 800]>
>;
type _CentralStale = Assert<Equal<typeof ARTIFACT_CENTRAL_LOCK_STALE_MS, 2000>>;
type _CentralHeartbeat = Assert<Equal<typeof ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS, 1000>>;
type _CompatibilityStale = Assert<Equal<typeof ARTIFACT_COMPATIBILITY_LOCK_STALE_MS, 30000>>;
type _CompatibilityHeartbeat = Assert<Equal<typeof ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS, 5000>>;

type _MutationReasons = Assert<
  WhenAvailable<
    ArtifactMutationError,
    Equal<
      ArtifactMutationError['reason'],
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
      | 'cancelled'
    >
  >
>;
type _RecoveryCursors = Assert<
  WhenAvailable<
    ArtifactRecoveryCursor,
    Equal<
      ArtifactRecoveryCursor,
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
      | 'cleanup'
    >
  >
>;
type _RevisionStates = Assert<
  WhenAvailable<ArtifactFileRevision, Equal<ArtifactFileRevision['state'], 'absent' | 'file'>>
>;
type _TargetKinds = Assert<
  WhenAvailable<
    ManifestEditTarget,
    Equal<
      ManifestEditTarget['kind'],
      'migration' | 'default' | 'registry-default' | 'skill-field' | 'skill-declaration'
    >
  >
>;
type _GeneratedLockIsTyped = Assert<
  WhenAvailable<
    GeneratedLockAction,
    Equal<
      Extract<GeneratedLockAction, { kind: 'replace' }> extends { bytes: unknown } ? true : false,
      false
    >
  >
>;
type _NoRawRecoveryBytes = Assert<
  WhenAvailable<
    ArtifactPairRecoveryRecord,
    Equal<
      | ('manifestBytes' extends keyof ArtifactPairRecoveryRecord ? true : false)
      | ('lockBytes' extends keyof ArtifactPairRecoveryRecord ? true : false),
      false
    >
  >
>;
type _FocusedPortHasNoGit = Assert<
  WhenAvailable<
    ArtifactCoordinatorPorts,
    Equal<'git' extends keyof ArtifactCoordinatorPorts ? true : false, false>
  >
>;
type _FocusedPortHasNoHttp = Assert<
  WhenAvailable<
    ArtifactCoordinatorPorts,
    Equal<'http' extends keyof ArtifactCoordinatorPorts ? true : false, false>
  >
>;
type _RuntimePortsUnchanged = Assert<
  Equal<'recovery' extends keyof RuntimePorts ? true : false, false>
>;
type _OneFileAuthorityIsInternal = Assert<
  Equal<'updateCoordinatedHumanFile' extends keyof typeof publicCore ? true : false, false>
>;
type _SaveConfigRetainsTwoArgumentContract = Assert<
  Equal<Parameters<typeof publicCore.saveConfig>['length'], 2>
>;

const _edit: (
  bytes: Uint8Array,
  request: ManifestEditRequest,
) => Result<ManifestEditResult, ArtifactMutationError> = editManifestBytes;
const _commit: (
  ports: ArtifactCoordinatorPorts,
  request: ArtifactPairMutationRequest,
) => Promise<Result<ArtifactPairMutationResult, ArtifactMutationError>> = commitArtifactPair;
const _recover: typeof recoverArtifactPair = recoverArtifactPair;
const _read: (
  ports: ArtifactCoordinatorPorts,
  pair: ArtifactPairMutationRequest['pair'],
) => Promise<Result<ArtifactPairSnapshot, ArtifactMutationError>> = readCoordinatedArtifactPair;
const _groupLock: <T>(
  ports: ArtifactCoordinatorPorts,
  pair: ArtifactPairMutationRequest['pair'],
  signal: AbortSignal | undefined,
  operation: (lease: ArtifactGroupLockLease) => Promise<T>,
) => Promise<T> = withArtifactGroupLock;

declare const manifestAction: HumanManifestAction;
declare const lockAction: GeneratedLockAction;
declare const edit: ManifestEdit;

void [
  ARTIFACT_LOCK_RETRY_DELAYS_MS,
  ARTIFACT_CENTRAL_LOCK_STALE_MS,
  ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS,
  ARTIFACT_COMPATIBILITY_LOCK_STALE_MS,
  ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS,
  _edit,
  _commit,
  _recover,
  _read,
  _groupLock,
  manifestAction,
  lockAction,
  edit,
];
