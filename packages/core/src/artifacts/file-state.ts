import { types as utilTypes } from 'node:util';
import type {
  ArtifactCoordinatorPorts,
  ArtifactFileRevision,
  ArtifactMutationError,
  ArtifactPairSnapshot,
  ArtifactParentRevision,
  ArtifactPathObservation,
} from './coordinator-types.ts';
import {
  type ArtifactDigest,
  HASH_SCHEMA_VERSION,
  hashCanonicalInput,
  hashManifestBytes,
} from './hash.ts';
import { readPortableLockSource } from './lock.ts';

export type ArtifactFileDigestKind = 'manifest' | 'lock' | 'resource';

const MESSAGES: Readonly<Record<ArtifactMutationError['reason'], string>> = Object.freeze({
  'invalid-request': 'artifact mutation request is invalid',
  'unsafe-human-edit': 'the human-authored artifact cannot be edited safely',
  'invalid-utf8': 'artifact bytes are not valid UTF-8',
  'invalid-manifest': 'the manifest is invalid',
  'invalid-lock': 'the lock file is invalid',
  'invalid-file-kind': 'artifact path is not an ordinary one-link file',
  'artifact-alias': 'artifact paths alias the same file',
  'lock-contention': 'artifact mutation lock is contended',
  'external-writer-conflict': 'artifact state changed during the coordinated mutation',
  'stage-collision': 'artifact staging path collided repeatedly',
  'recovery-record-invalid': 'artifact recovery record is invalid',
  'recovery-conflict': 'artifact recovery cannot prove a safe next action',
  'filesystem-failure': 'artifact filesystem operation failed',
  'permission-denied': 'artifact filesystem permission was denied',
  cancelled: 'artifact mutation was cancelled',
});

const artifactMutationErrors = new WeakSet<object>();

/** Reads only an own data property and refuses proxies without entering their handlers. */
export const ownDataErrorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || utilTypes.isProxy(error)) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  } catch {
    return null;
  }
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : null;
};

export const isArtifactMutationError = (value: unknown): value is ArtifactMutationError =>
  typeof value === 'object' && value !== null && artifactMutationErrors.has(value);

export const artifactMutationError = (
  reason: ArtifactMutationError['reason'],
  details: Omit<ArtifactMutationError, 'code' | 'exitCode' | 'reason' | 'message'> = {},
): ArtifactMutationError => {
  const exitCode =
    reason === 'cancelled'
      ? 130
      : reason === 'permission-denied'
        ? 6
        : reason === 'invalid-request' || reason === 'unsafe-human-edit'
          ? 2
          : 3;
  const error = Object.freeze({
    code: 'artifact-mutation' as const,
    exitCode,
    reason,
    ...details,
    message: MESSAGES[reason],
  });
  artifactMutationErrors.add(error);
  return error;
};

export const nodeErrorToArtifactMutationError = (
  error: unknown,
  role?: ArtifactMutationError['role'],
  path?: string,
): ArtifactMutationError => {
  const code = ownDataErrorCode(error);
  return artifactMutationError(
    code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'filesystem-failure',
    {
      ...(role === undefined ? {} : { role }),
      ...(path === undefined ? {} : { path }),
    },
  );
};

const copyParent = (parent: ArtifactParentRevision): ArtifactParentRevision =>
  parent.state === 'present'
    ? Object.freeze({ state: 'present', path: parent.path, identity: parent.identity })
    : Object.freeze({
        state: 'missing',
        nearestExistingPath: parent.nearestExistingPath,
        nearestExistingIdentity: parent.nearestExistingIdentity,
        missingSegments: Object.freeze([...parent.missingSegments]),
      });

export const copyArtifactFileRevision = (revision: ArtifactFileRevision): ArtifactFileRevision =>
  revision.state === 'absent'
    ? Object.freeze({ state: 'absent', parent: copyParent(revision.parent) })
    : Object.freeze({
        state: 'file',
        bytes: new Uint8Array(revision.bytes),
        digest: revision.digest,
        mode: revision.mode,
        identity: revision.identity,
        linkCount: 1 as const,
        parent: copyParent(revision.parent),
      });

const sameParent = (left: ArtifactParentRevision, right: ArtifactParentRevision): boolean =>
  left.state === right.state &&
  (left.state === 'present' && right.state === 'present'
    ? left.path === right.path && left.identity === right.identity
    : left.state === 'missing' &&
      right.state === 'missing' &&
      left.nearestExistingPath === right.nearestExistingPath &&
      left.nearestExistingIdentity === right.nearestExistingIdentity &&
      left.missingSegments.length === right.missingSegments.length &&
      left.missingSegments.every((segment, index) => segment === right.missingSegments[index]));

const sameObservation = (left: ArtifactPathObservation, right: ArtifactPathObservation): boolean =>
  left.kind === right.kind &&
  left.mode === right.mode &&
  left.identity === right.identity &&
  left.linkCount === right.linkCount &&
  sameParent(left.parent, right.parent);

const digestBytes = (
  bytes: Uint8Array,
  kind: ArtifactFileDigestKind,
): ArtifactDigest | ArtifactMutationError => {
  if (kind === 'manifest') return hashManifestBytes(bytes);
  if (kind === 'lock') {
    const lock = readPortableLockSource(bytes);
    if (!lock.ok) return artifactMutationError('invalid-lock', { role: 'lock' });
    const digest = hashCanonicalInput('lock-canonical', HASH_SCHEMA_VERSION, bytes);
    return digest.ok ? digest.value : artifactMutationError('invalid-lock', { role: 'lock' });
  }
  const digest = hashCanonicalInput('resource', HASH_SCHEMA_VERSION, bytes);
  return digest.ok ? digest.value : artifactMutationError('filesystem-failure');
};

export const observeArtifactFile = async (
  ports: Pick<ArtifactCoordinatorPorts, 'observe' | 'readBytes'>,
  path: string,
  digestKind: ArtifactFileDigestKind,
): Promise<ArtifactFileRevision | ArtifactMutationError> => {
  try {
    const before = await ports.observe(path);
    if (before.kind !== 'absent' && before.kind !== 'file') {
      return artifactMutationError('invalid-file-kind', { path });
    }
    if (
      before.kind === 'file' &&
      (before.identity === null || before.mode === null || before.linkCount !== 1)
    ) {
      return artifactMutationError('invalid-file-kind', { path });
    }
    if (before.kind === 'absent') {
      const after = await ports.observe(path);
      if (!sameObservation(before, after)) {
        return artifactMutationError('external-writer-conflict', { path });
      }
      return Object.freeze({ state: 'absent', parent: copyParent(before.parent) });
    }

    const bytes = new Uint8Array(await ports.readBytes(path));
    const after = await ports.observe(path);
    if (!sameObservation(before, after)) {
      return artifactMutationError('external-writer-conflict', { path });
    }
    const digest = digestBytes(bytes, digestKind);
    if (typeof digest !== 'string') return digest;
    return Object.freeze({
      state: 'file',
      bytes,
      digest,
      mode: before.mode as number,
      identity: before.identity as string,
      linkCount: 1 as const,
      parent: copyParent(before.parent),
    });
  } catch (error) {
    return nodeErrorToArtifactMutationError(
      error,
      digestKind === 'lock' ? 'lock' : 'manifest',
      path,
    );
  }
};

export const observeArtifactPair = async (
  ports: Pick<ArtifactCoordinatorPorts, 'observe' | 'readBytes'>,
  manifestPath: string,
  lockPath: string,
): Promise<ArtifactPairSnapshot | ArtifactMutationError> => {
  const manifest = await observeArtifactFile(ports, manifestPath, 'manifest');
  if ('code' in manifest) return manifest;
  const lock = await observeArtifactFile(ports, lockPath, 'lock');
  if ('code' in lock) return lock;
  if (manifest.state === 'file' && lock.state === 'file' && manifest.identity === lock.identity) {
    return artifactMutationError('artifact-alias');
  }
  return Object.freeze({
    manifest: copyArtifactFileRevision(manifest),
    lock: copyArtifactFileRevision(lock),
  });
};

export const sameArtifactRevision = (
  left: ArtifactFileRevision,
  right: ArtifactFileRevision,
): boolean => {
  if (left.state !== right.state) return false;
  if (!sameParent(left.parent, right.parent)) return false;
  return (
    left.state === 'absent' ||
    (right.state === 'file' &&
      left.digest === right.digest &&
      left.mode === right.mode &&
      left.identity === right.identity &&
      left.linkCount === right.linkCount)
  );
};
