// eslint-disable-next-line skillsmith/capability-ownership -- This private durable repository is a focused adapter.
import { constants } from 'node:fs';
// eslint-disable-next-line skillsmith/capability-ownership -- This private durable repository is a focused adapter.
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import type {
  ArtifactPairRecoveryPort,
  ArtifactPairRecoveryRecord,
  ArtifactRecordedAfterState,
  ArtifactRecordedBeforeState,
  ArtifactRecoveryCursor,
  ArtifactRecoveryDirectory,
  ArtifactRecoveryEnvelope,
  ArtifactRecoveryObject,
} from './coordinator-types.ts';
import {
  artifactMutationError,
  isArtifactMutationError,
  nodeErrorToArtifactMutationError,
  ownDataErrorCode,
} from './file-state.ts';
import { HASH_SCHEMA_VERSION, hashCanonicalInput, parseArtifactDigest } from './hash.ts';

const RECORD_NAME = /^v1-([0-9a-f]{64})\.json$/u;
const TEMP_NAME = /^\.v1-([0-9a-f]{64})\.cas-([0-9a-f]{64})-([0-9a-f]{16})\.tmp$/u;
const ID_16 = /^[0-9a-f]{16}$/u;
const ID_64 = /^[0-9a-f]{64}$/u;
const REVISION = /^sha256:[0-9a-f]{64}$/u;
const KEY = /^v1-[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const containsRejectedSinkMaterial = (value: string): boolean =>
  value.includes('[REDACTED]') || containsSensitiveMaterial(value);

const CURSORS = Object.freeze([
  'prepared',
  'staging',
  'final-guard',
  'lock-backup',
  'lock-install',
  'manifest-backup',
  'manifest-install',
  'pair-verify',
  'rollback-manifest-remove',
  'rollback-manifest-restore',
  'rollback-lock-remove',
  'rollback-lock-restore',
  'rollback-verify',
  'committed',
  'cleanup',
] as const);
const CURSOR_SET: ReadonlySet<string> = new Set(CURSORS);

type DataRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is DataRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => 'value' in descriptor,
    )
  );
};

const hasKeys = (value: DataRecord, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
};

function invalid(): never {
  throw artifactMutationError('recovery-record-invalid', { role: 'recovery' });
}

const ownStringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  if (Reflect.ownKeys(value).some((key) => key !== 'length' && !/^\d+$/u.test(String(key))))
    invalid();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== 'string') invalid();
    result.push(value[index]);
  }
  return Object.freeze(result);
};

const ownBefore = (value: unknown): ArtifactRecordedBeforeState => {
  if (!isRecord(value)) invalid();
  if (value.state === 'absent' && hasKeys(value, ['state']))
    return Object.freeze({ state: 'absent' });
  if (value.state !== 'file' || !hasKeys(value, ['state', 'digest', 'mode', 'identity'])) invalid();
  const digest = parseArtifactDigest(value.digest);
  if (
    !digest.ok ||
    typeof value.mode !== 'number' ||
    !Number.isInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o7777 ||
    typeof value.identity !== 'string' ||
    value.identity.length === 0
  )
    invalid();
  return Object.freeze({
    state: 'file',
    digest: digest.value,
    mode: value.mode,
    identity: value.identity,
  });
};

const ownAfter = (value: unknown): ArtifactRecordedAfterState => {
  if (!isRecord(value)) invalid();
  if (value.state === 'absent' && hasKeys(value, ['state']))
    return Object.freeze({ state: 'absent' });
  if (value.state !== 'file' || !hasKeys(value, ['state', 'digest', 'mode', 'identity'])) invalid();
  const digest = parseArtifactDigest(value.digest);
  if (
    !digest.ok ||
    typeof value.mode !== 'number' ||
    !Number.isInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o7777 ||
    !(value.identity === null || (typeof value.identity === 'string' && value.identity.length > 0))
  ) {
    invalid();
  }
  return Object.freeze({
    state: 'file',
    digest: digest.value,
    mode: value.mode,
    identity: value.identity,
  });
};

const ownParent = (value: unknown): { readonly path: string; readonly identity: string } => {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['path', 'identity']) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.identity !== 'string' ||
    value.identity.length === 0
  )
    invalid();
  return Object.freeze({ path: value.path, identity: value.identity });
};

const ownNullableParent = (
  value: unknown,
): { readonly path: string; readonly identity: string } | null =>
  value === null ? null : ownParent(value);

const ownDirectory = (value: unknown): ArtifactRecoveryDirectory => {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['purpose', 'path', 'before', 'ownershipToken', 'identity']) ||
    value.purpose !== 'transaction' ||
    value.before !== 'absent' ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.ownershipToken !== 'string' ||
    !ID_64.test(value.ownershipToken) ||
    !(value.identity === null || (typeof value.identity === 'string' && value.identity.length > 0))
  ) {
    invalid();
  }
  return Object.freeze({
    purpose: 'transaction',
    path: value.path,
    before: 'absent',
    ownershipToken: value.ownershipToken,
    identity: value.identity,
  });
};

const ownObject = (value: unknown): ArtifactRecoveryObject => {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['role', 'slot', 'path', 'expectedDigest', 'expectedMode', 'identity']) ||
    (value.role !== 'manifest' && value.role !== 'lock') ||
    (value.slot !== 'stage' && value.slot !== 'backup' && value.slot !== 'discard') ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.expectedMode !== 'number' ||
    !Number.isInteger(value.expectedMode) ||
    value.expectedMode < 0 ||
    value.expectedMode > 0o7777 ||
    !(value.identity === null || (typeof value.identity === 'string' && value.identity.length > 0))
  ) {
    invalid();
  }
  const digest = parseArtifactDigest(value.expectedDigest);
  if (!digest.ok) invalid();
  return Object.freeze({
    role: value.role,
    slot: value.slot,
    path: value.path,
    expectedDigest: digest.value,
    expectedMode: value.expectedMode,
    identity: value.identity,
  });
};

const ownArray = <T>(value: unknown, own: (entry: unknown) => T): readonly T[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid();
    result.push(own(value[index]));
  }
  return Object.freeze(result);
};

const pairIdentity = (manifest: string, lock: string | null): string =>
  `{"manifest":${JSON.stringify(manifest)},"lock":${lock === null ? 'null' : JSON.stringify(lock)}}`;

export const artifactRecoveryKey = (manifest: string, lock: string | null): string => {
  const digest = hashCanonicalInput('resource', HASH_SCHEMA_VERSION, pairIdentity(manifest, lock));
  if (!digest.ok || !REVISION.test(digest.value)) invalid();
  return `v1-${digest.value.slice('sha256:'.length)}`;
};

export const ownArtifactPairRecoveryRecord = (value: unknown): ArtifactPairRecoveryRecord => {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      'kind',
      'version',
      'key',
      'transactionId',
      'attempt',
      'disposition',
      'pair',
      'memberTargets',
      'cursor',
      'parents',
      'before',
      'after',
      'rollbackTarget',
      'directories',
      'objects',
      'collisionPaths',
    ])
  )
    invalid();
  if (
    value.kind !== 'skillsmith-artifact-pair-recovery' ||
    value.version !== 1 ||
    typeof value.key !== 'string' ||
    !KEY.test(value.key) ||
    typeof value.transactionId !== 'string' ||
    !ID_16.test(value.transactionId) ||
    typeof value.attempt !== 'number' ||
    !Number.isInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > 8 ||
    (value.disposition !== 'forward' && value.disposition !== 'rollback') ||
    typeof value.cursor !== 'string' ||
    !CURSOR_SET.has(value.cursor) ||
    !isRecord(value.pair) ||
    !hasKeys(value.pair, ['manifest', 'lock']) ||
    typeof value.pair.manifest !== 'string' ||
    !(value.pair.lock === null || typeof value.pair.lock === 'string') ||
    value.key !== artifactRecoveryKey(value.pair.manifest, value.pair.lock)
  )
    invalid();
  if (
    containsSensitiveMaterial(value.pair.manifest) ||
    (value.pair.lock !== null && containsSensitiveMaterial(value.pair.lock))
  )
    invalid();
  const memberTargets = ownStringArray(value.memberTargets);
  if (
    memberTargets.length === 0 ||
    new Set(memberTargets).size !== memberTargets.length ||
    [...memberTargets].sort(compareUtf8).some((entry, index) => entry !== memberTargets[index])
  )
    invalid();
  if (
    !memberTargets.includes(value.pair.manifest) ||
    (value.pair.lock !== null && !memberTargets.includes(value.pair.lock))
  )
    invalid();
  if (
    !isRecord(value.parents) ||
    !hasKeys(value.parents, ['manifest', 'lock']) ||
    !isRecord(value.before) ||
    !hasKeys(value.before, ['manifest', 'lock']) ||
    !isRecord(value.after) ||
    !hasKeys(value.after, ['manifest', 'lock']) ||
    !isRecord(value.rollbackTarget) ||
    !hasKeys(value.rollbackTarget, ['manifest', 'lock'])
  )
    invalid();
  const lockExpected = value.pair.lock === null;
  if (
    (value.parents.lock === null) !== lockExpected ||
    (value.before.lock === null) !== lockExpected ||
    (value.after.lock === null) !== lockExpected ||
    (value.rollbackTarget.lock === null) !== lockExpected
  ) {
    invalid();
  }
  const directories = ownArray(value.directories, ownDirectory);
  const objects = ownArray(value.objects, ownObject);
  if (
    new Set(directories.map((entry) => entry.path)).size !== directories.length ||
    new Set(objects.map((entry) => entry.path)).size !== objects.length
  )
    invalid();
  const owned = Object.freeze({
    kind: 'skillsmith-artifact-pair-recovery',
    version: 1,
    key: value.key,
    transactionId: value.transactionId,
    attempt: value.attempt as ArtifactPairRecoveryRecord['attempt'],
    disposition: value.disposition,
    pair: Object.freeze({ manifest: value.pair.manifest, lock: value.pair.lock }),
    memberTargets,
    cursor: value.cursor as ArtifactRecoveryCursor,
    parents: Object.freeze({
      manifest: ownParent(value.parents.manifest),
      lock: ownNullableParent(value.parents.lock),
    }),
    before: Object.freeze({
      manifest: ownBefore(value.before.manifest),
      lock: value.before.lock === null ? null : ownBefore(value.before.lock),
    }),
    after: Object.freeze({
      manifest: ownAfter(value.after.manifest),
      lock: value.after.lock === null ? null : ownAfter(value.after.lock),
    }),
    rollbackTarget: Object.freeze({
      manifest: ownBefore(value.rollbackTarget.manifest),
      lock: value.rollbackTarget.lock === null ? null : ownBefore(value.rollbackTarget.lock),
    }),
    directories,
    objects,
    collisionPaths: ownStringArray(value.collisionPaths),
  });
  const expectedMembers = [
    owned.pair.manifest,
    ...(owned.pair.lock === null ? [] : [owned.pair.lock]),
  ].sort(compareUtf8);
  if (
    owned.memberTargets.length !== expectedMembers.length ||
    owned.memberTargets.some((target, index) => target !== expectedMembers[index])
  )
    invalid();
  if (
    owned.parents.manifest.path !== dirname(owned.pair.manifest) ||
    (owned.pair.lock === null
      ? owned.parents.lock !== null
      : owned.parents.lock === null || owned.parents.lock.path !== dirname(owned.pair.lock))
  )
    invalid();
  const changedRoles = (['manifest', 'lock'] as const).filter((role) => {
    const before = owned.before[role];
    const after = owned.after[role];
    if (before === null || after === null) return false;
    if (before.state !== after.state) return true;
    return (
      before.state === 'file' &&
      after.state === 'file' &&
      (before.digest !== after.digest || before.mode !== after.mode)
    );
  });
  const expectedParents = [
    ...new Set(
      changedRoles.map((role) =>
        dirname(role === 'manifest' ? owned.pair.manifest : (owned.pair.lock as string)),
      ),
    ),
  ].sort(compareUtf8);
  if (
    directories.length !== expectedParents.length ||
    directories.some(
      (directory, index) =>
        directory.path !==
        join(expectedParents[index] as string, `.skillsmith-artifact-${owned.transactionId}`),
    ) ||
    new Set(directories.map((directory) => directory.ownershipToken)).size !== directories.length
  )
    invalid();
  const directoryByParent = new Map(
    directories.map((directory) => [dirname(directory.path), directory] as const),
  );
  const seenObjectSlots = new Set<string>();
  for (const object of objects) {
    const target = object.role === 'manifest' ? owned.pair.manifest : owned.pair.lock;
    if (target === null || !changedRoles.includes(object.role)) invalid();
    const directory = directoryByParent.get(dirname(target));
    if (
      directory === undefined ||
      object.path !== join(directory.path, `${object.role}.${object.slot}`) ||
      seenObjectSlots.has(`${object.role}:${object.slot}`) ||
      (object.slot === 'discard' && owned.disposition !== 'rollback')
    )
      invalid();
    seenObjectSlots.add(`${object.role}:${object.slot}`);
    const after = owned.after[object.role];
    const before = owned.before[object.role];
    if (object.slot === 'stage') {
      if (
        after?.state !== 'file' ||
        object.expectedDigest !== after.digest ||
        object.expectedMode !== after.mode ||
        (object.identity !== null && after.identity !== null && object.identity !== after.identity)
      )
        invalid();
    } else if (object.slot === 'backup') {
      const rollback = owned.rollbackTarget[object.role];
      const matchesBefore =
        before?.state === 'file' &&
        object.expectedDigest === before.digest &&
        object.expectedMode === before.mode;
      const matchesRollback =
        rollback?.state === 'file' &&
        object.expectedDigest === rollback.digest &&
        object.expectedMode === rollback.mode;
      if (!matchesBefore && !matchesRollback) invalid();
    }
  }
  for (const role of changedRoles) {
    const after = owned.after[role];
    const before = owned.before[role];
    if (after?.state === 'file' && !seenObjectSlots.has(`${role}:stage`)) invalid();
    if (before?.state === 'file' && !seenObjectSlots.has(`${role}:backup`)) invalid();
  }
  const allowedCollisionParents = new Set([
    dirname(owned.pair.manifest),
    ...(owned.pair.lock === null ? [] : [dirname(owned.pair.lock)]),
  ]);
  if (
    new Set(owned.collisionPaths).size !== owned.collisionPaths.length ||
    owned.collisionPaths.some(
      (path) =>
        !allowedCollisionParents.has(dirname(path)) ||
        !/^\.skillsmith-artifact-[0-9a-f]{16}$/u.test(path.slice(dirname(path).length + 1)),
    )
  )
    invalid();
  const strings = [
    owned.key,
    owned.transactionId,
    owned.pair.manifest,
    ...(owned.pair.lock === null ? [] : [owned.pair.lock]),
    ...owned.memberTargets,
    owned.parents.manifest.path,
    owned.parents.manifest.identity,
    ...(owned.parents.lock === null ? [] : [owned.parents.lock.path, owned.parents.lock.identity]),
    ...owned.directories.flatMap((directory) => [
      directory.path,
      directory.ownershipToken,
      ...(directory.identity === null ? [] : [directory.identity]),
    ]),
    ...owned.objects.flatMap((object) => [
      object.path,
      object.expectedDigest,
      ...(object.identity === null ? [] : [object.identity]),
    ]),
    ...owned.collisionPaths,
  ];
  const stateStrings = [
    owned.before.manifest,
    owned.before.lock,
    owned.after.manifest,
    owned.after.lock,
    owned.rollbackTarget.manifest,
    owned.rollbackTarget.lock,
  ].flatMap((state) =>
    state === null || state.state === 'absent'
      ? []
      : [state.digest, ...(state.identity === null ? [] : [state.identity])],
  );
  if ([...strings, ...stateStrings].some(containsRejectedSinkMaterial)) invalid();
  return owned;
};

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

const bytesForRecord = (record: ArtifactPairRecoveryRecord): Uint8Array =>
  encoder.encode(`${JSON.stringify(ownArtifactPairRecoveryRecord(record))}\n`);

const revisionForBytes = (bytes: Uint8Array): string => {
  const result = hashCanonicalInput('resource', HASH_SCHEMA_VERSION, bytes);
  if (!result.ok) invalid();
  return result.value;
};

const decodeBytes = (bytes: Uint8Array): ArtifactPairRecoveryRecord => {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    invalid();
  }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) invalid();
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    invalid();
  }
  const record = ownArtifactPairRecoveryRecord(value);
  const canonical = bytesForRecord(record);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index]))
    invalid();
  return record;
};

const equalJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const assertTransition = (
  before: ArtifactPairRecoveryRecord,
  after: ArtifactPairRecoveryRecord,
): void => {
  if (
    before.key !== after.key ||
    !equalJson(before.pair, after.pair) ||
    !equalJson(before.memberTargets, after.memberTargets) ||
    !equalJson(before.parents, after.parents) ||
    !equalJson(before.before, after.before)
  )
    invalid();
  if (before.disposition === 'rollback' && after.disposition !== 'rollback') invalid();
  if (after.attempt < before.attempt || after.attempt > before.attempt + 1) invalid();
  if (
    after.attempt !== before.attempt &&
    (before.cursor !== 'prepared' || after.cursor !== 'prepared')
  )
    invalid();
  if (after.attempt === before.attempt && after.transactionId !== before.transactionId) invalid();
  if (after.attempt !== before.attempt && after.transactionId === before.transactionId) invalid();
  if (
    after.collisionPaths.length < before.collisionPaths.length ||
    before.collisionPaths.some((path, index) => after.collisionPaths[index] !== path)
  )
    invalid();

  const advancingAttempt = after.attempt !== before.attempt;
  if (advancingAttempt) {
    const beforeOwnership = new Set(
      before.directories.map((directory) => directory.ownershipToken),
    );
    const appendedCollision = after.collisionPaths.at(-1);
    if (
      before.disposition !== 'forward' ||
      after.disposition !== 'forward' ||
      !equalJson(before.after, after.after) ||
      !equalJson(before.rollbackTarget, after.rollbackTarget) ||
      after.collisionPaths.length !== before.collisionPaths.length + 1 ||
      appendedCollision === undefined ||
      !before.directories.some((directory) => directory.path === appendedCollision) ||
      before.directories.length !== after.directories.length ||
      before.objects.length !== after.objects.length ||
      after.directories.some((right, index) => {
        const left = before.directories[index] as ArtifactRecoveryDirectory;
        return (
          dirname(left.path) !== dirname(right.path) ||
          left.path === right.path ||
          right.identity !== null ||
          right.ownershipToken === left.ownershipToken ||
          beforeOwnership.has(right.ownershipToken)
        );
      }) ||
      after.objects.some((right, index) => {
        const left = before.objects[index] as ArtifactRecoveryObject;
        return (
          left.role !== right.role ||
          left.slot !== right.slot ||
          left.expectedDigest !== right.expectedDigest ||
          left.expectedMode !== right.expectedMode ||
          (left.slot === 'stage' ? right.identity !== null : left.identity !== right.identity)
        );
      })
    )
      invalid();
    return;
  }
  if (!equalJson(before.collisionPaths, after.collisionPaths)) invalid();

  const switchingToRollback = before.disposition === 'forward' && after.disposition === 'rollback';
  const rollbackCaptureRole =
    before.disposition === 'rollback' &&
    after.disposition === 'rollback' &&
    before.cursor === after.cursor
      ? before.cursor === 'rollback-manifest-remove'
        ? ('manifest' as const)
        : before.cursor === 'rollback-lock-remove'
          ? ('lock' as const)
          : null
      : null;
  const capturesRollbackWriter = (() => {
    if (rollbackCaptureRole === null) return false;
    const otherRole = rollbackCaptureRole === 'manifest' ? 'lock' : 'manifest';
    const beforeTarget = before.rollbackTarget[rollbackCaptureRole];
    const afterTarget = after.rollbackTarget[rollbackCaptureRole];
    const beforeDiscardIndex = before.objects.findIndex(
      (object) => object.role === rollbackCaptureRole && object.slot === 'discard',
    );
    const afterDiscardIndex = after.objects.findIndex(
      (object) => object.role === rollbackCaptureRole && object.slot === 'discard',
    );
    if (
      afterTarget?.state !== 'file' ||
      equalJson(beforeTarget, afterTarget) ||
      !equalJson(before.rollbackTarget[otherRole], after.rollbackTarget[otherRole]) ||
      !equalJson(before.after, after.after) ||
      !equalJson(before.directories, after.directories) ||
      before.objects.length !== after.objects.length ||
      beforeDiscardIndex < 0 ||
      beforeDiscardIndex !== afterDiscardIndex
    )
      return false;
    const beforeDiscard = before.objects[beforeDiscardIndex] as ArtifactRecoveryObject;
    const afterDiscard = after.objects[afterDiscardIndex] as ArtifactRecoveryObject;
    if (
      equalJson(beforeDiscard, afterDiscard) ||
      beforeDiscard.role !== afterDiscard.role ||
      beforeDiscard.slot !== afterDiscard.slot ||
      beforeDiscard.path !== afterDiscard.path ||
      afterDiscard.expectedDigest !== afterTarget.digest ||
      afterDiscard.expectedMode !== afterTarget.mode ||
      afterDiscard.identity !== afterTarget.identity
    )
      return false;
    return before.objects.every((object, index) =>
      index === beforeDiscardIndex ? true : equalJson(object, after.objects[index]),
    );
  })();
  if (
    before.disposition === after.disposition &&
    !equalJson(before.rollbackTarget, after.rollbackTarget) &&
    !capturesRollbackWriter
  )
    invalid();
  {
    const appendedDiscard =
      before.disposition === 'rollback' &&
      after.disposition === 'rollback' &&
      before.cursor === after.cursor &&
      (before.cursor === 'rollback-manifest-remove' || before.cursor === 'rollback-lock-remove') &&
      after.objects.length === before.objects.length + 1 &&
      after.objects.at(-1)?.slot === 'discard' &&
      after.objects.at(-1)?.role ===
        (before.cursor === 'rollback-manifest-remove' ? 'manifest' : 'lock');
    if (
      before.directories.length !== after.directories.length ||
      (before.objects.length !== after.objects.length && !appendedDiscard)
    )
      invalid();
    for (let index = 0; index < before.directories.length; index += 1) {
      const left = before.directories[index] as ArtifactRecoveryDirectory;
      const right = after.directories[index] as ArtifactRecoveryDirectory;
      if (
        left.path !== right.path ||
        left.ownershipToken !== right.ownershipToken ||
        (left.identity !== null && left.identity !== right.identity)
      )
        invalid();
    }
    for (let index = 0; index < before.objects.length; index += 1) {
      const left = before.objects[index] as ArtifactRecoveryObject;
      const right = after.objects[index] as ArtifactRecoveryObject;
      const stableIdentity =
        left.role === right.role && left.slot === right.slot && left.path === right.path;
      const stableExpectedFacts =
        left.expectedDigest === right.expectedDigest && left.expectedMode === right.expectedMode;
      const changedToCapturedBackup =
        switchingToRollback &&
        left.slot === 'backup' &&
        right.slot === 'backup' &&
        after.rollbackTarget[right.role]?.state === 'file' &&
        (
          after.rollbackTarget[right.role] as Extract<
            ArtifactRecordedBeforeState,
            { readonly state: 'file' }
          >
        ).digest === right.expectedDigest &&
        (
          after.rollbackTarget[right.role] as Extract<
            ArtifactRecordedBeforeState,
            { readonly state: 'file' }
          >
        ).mode === right.expectedMode;
      const changedToRollbackCapture =
        capturesRollbackWriter &&
        left.role === rollbackCaptureRole &&
        left.slot === 'discard' &&
        right.role === rollbackCaptureRole &&
        right.slot === 'discard' &&
        after.rollbackTarget[rollbackCaptureRole]?.state === 'file' &&
        right.expectedDigest === after.rollbackTarget[rollbackCaptureRole].digest &&
        right.expectedMode === after.rollbackTarget[rollbackCaptureRole].mode &&
        right.identity === after.rollbackTarget[rollbackCaptureRole].identity;
      if (
        !stableIdentity ||
        ((!stableExpectedFacts || (left.identity !== null && left.identity !== right.identity)) &&
          !changedToCapturedBackup &&
          !changedToRollbackCapture)
      ) {
        invalid();
      }
    }
    for (const role of ['manifest', 'lock'] as const) {
      const left = before.after[role];
      const right = after.after[role];
      if (left === null || right === null) {
        if (left !== right) invalid();
        continue;
      }
      if (left.state !== right.state) invalid();
      if (
        left.state === 'file' &&
        right.state === 'file' &&
        (left.digest !== right.digest ||
          left.mode !== right.mode ||
          (left.identity !== null && left.identity !== right.identity))
      )
        invalid();
    }
  }

  if (switchingToRollback) {
    if (after.cursor !== 'rollback-manifest-remove') invalid();
    for (const role of ['manifest', 'lock'] as const) {
      const target = after.rollbackTarget[role];
      const original = before.before[role];
      if (equalJson(target, original)) continue;
      if (target?.state !== 'file') invalid();
      const captured = after.objects.find(
        (object) =>
          object.role === role &&
          object.slot === 'backup' &&
          object.expectedDigest === target.digest &&
          object.expectedMode === target.mode &&
          object.identity === target.identity,
      );
      if (captured === undefined) invalid();
    }
    return;
  }
  if (before.disposition !== after.disposition) invalid();
  const forwardSuccessors: Readonly<
    Record<ArtifactRecoveryCursor, readonly ArtifactRecoveryCursor[]>
  > = {
    prepared: ['prepared', 'staging'],
    staging: ['staging', 'final-guard'],
    'final-guard': ['lock-backup', 'manifest-backup', 'pair-verify'],
    'lock-backup': ['lock-install'],
    'lock-install': ['manifest-backup', 'pair-verify'],
    'manifest-backup': ['manifest-install'],
    'manifest-install': ['pair-verify'],
    'pair-verify': ['committed'],
    committed: ['committed', 'cleanup'],
    cleanup: ['cleanup'],
    'rollback-manifest-remove': [],
    'rollback-manifest-restore': [],
    'rollback-lock-remove': [],
    'rollback-lock-restore': [],
    'rollback-verify': [],
  };
  if (before.disposition === 'forward' && !forwardSuccessors[before.cursor].includes(after.cursor))
    invalid();
  if (before.disposition === 'rollback') {
    const rollbackOrder: readonly ArtifactRecoveryCursor[] = [
      'rollback-manifest-remove',
      'rollback-manifest-restore',
      'rollback-lock-remove',
      'rollback-lock-restore',
      'rollback-verify',
      'cleanup',
    ];
    const beforeIndex = rollbackOrder.indexOf(before.cursor);
    const afterIndex = rollbackOrder.indexOf(after.cursor);
    if (beforeIndex < 0 || afterIndex < beforeIndex || afterIndex > beforeIndex + 1) invalid();
  }
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const readEnvelope = async (path: string): Promise<ArtifactRecoveryEnvelope> => {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.dev !== before.dev ||
      metadata.ino !== before.ino
    )
      invalid();
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (after.dev !== metadata.dev || after.ino !== metadata.ino || after.nlink !== 1) invalid();
    const record = decodeBytes(bytes);
    return Object.freeze({ record, revision: revisionForBytes(bytes) });
  } finally {
    await handle.close();
  }
};

export interface FileArtifactRecoveryOptions {
  readonly nextCasId: () => string;
  readonly expectedDirectoryIdentity?: string;
  readonly afterPhysicalStep?: (step: FileArtifactRecoveryPhysicalStep) => Promise<void>;
}

type FileArtifactRecoveryStep =
  | 'record-opened'
  | 'record-written'
  | 'record-fsynced'
  | 'temp-opened'
  | 'temp-written'
  | 'temp-fsynced'
  | 'temp-renamed'
  | 'file-unlinked'
  | 'directory-fsynced';
export type FileArtifactRecoveryPhysicalStep = Readonly<{
  area: 'recovery';
  step: FileArtifactRecoveryStep;
}>;

export const createFileArtifactRecoveryPort = (
  directory: string,
  options: FileArtifactRecoveryOptions,
): ArtifactPairRecoveryPort => {
  const usedCasIds = new Set<string>();
  let directoryIdentity = options.expectedDirectoryIdentity ?? null;
  const physical = async (step: FileArtifactRecoveryStep): Promise<void> => {
    await options.afterPhysicalStep?.(Object.freeze({ area: 'recovery', step }));
  };

  const nextCasId = (): string => {
    const descriptor = Object.getOwnPropertyDescriptor(options, 'nextCasId');
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'function'
    )
      invalid();
    const id = options.nextCasId();
    if (typeof id !== 'string' || !ID_16.test(id) || usedCasIds.has(id)) invalid();
    usedCasIds.add(id);
    return id;
  };

  const ensureDirectory = async (): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid();
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (directoryIdentity === null) directoryIdentity = identity;
    else if (directoryIdentity !== identity) invalid();
  };

  const syncRecoveryDirectory = async (): Promise<void> => {
    await syncDirectory(directory);
    await physical('directory-fsynced');
  };

  const pathForKey = (key: string): string => {
    if (!KEY.test(key)) invalid();
    return join(directory, `${key}.json`);
  };

  const discover = async (): Promise<readonly ArtifactRecoveryEnvelope[]> => {
    try {
      await ensureDirectory();
      const names = (await readdir(directory)).sort(compareUtf8);
      for (const name of names.filter((entry) => TEMP_NAME.test(entry))) {
        const match = TEMP_NAME.exec(name);
        if (match === null) invalid();
        const [, keyHex, expectedHex] = match;
        const tempPath = join(directory, name);
        const temp = await readEnvelope(tempPath);
        if (temp.record.key !== `v1-${keyHex}`) invalid();
        const livePath = pathForKey(temp.record.key);
        let live: ArtifactRecoveryEnvelope | null = null;
        try {
          live = await readEnvelope(livePath);
        } catch (error) {
          if (ownDataErrorCode(error) !== 'ENOENT') throw error;
        }
        const expected = `sha256:${expectedHex}`;
        if (live?.revision === expected) {
          assertTransition(live.record, temp.record);
          await ensureDirectory();
          await rename(tempPath, livePath);
          await physical('temp-renamed');
          await syncRecoveryDirectory();
        } else if (live?.revision === temp.revision) {
          await unlink(tempPath);
          await physical('file-unlinked');
          await syncRecoveryDirectory();
        } else {
          invalid();
        }
      }

      const records: ArtifactRecoveryEnvelope[] = [];
      const seenPairs = new Set<string>();
      for (const name of (await readdir(directory)).sort(compareUtf8)) {
        const match = RECORD_NAME.exec(name);
        if (match === null) {
          if (!TEMP_NAME.test(name)) invalid();
          continue;
        }
        const envelope = await readEnvelope(join(directory, name));
        if (envelope.record.key !== `v1-${match[1]}`) invalid();
        const identity = pairIdentity(envelope.record.pair.manifest, envelope.record.pair.lock);
        if (seenPairs.has(identity)) invalid();
        seenPairs.add(identity);
        records.push(envelope);
      }
      return Object.freeze(records);
    } catch (error) {
      if (isArtifactMutationError(error)) throw error;
      throw nodeErrorToArtifactMutationError(error, 'recovery', directory);
    }
  };

  const port: ArtifactPairRecoveryPort = {
    discover,
    create: async (candidate: ArtifactPairRecoveryRecord): Promise<ArtifactRecoveryEnvelope> => {
      try {
        await ensureDirectory();
        const record = ownArtifactPairRecoveryRecord(candidate);
        const bytes = bytesForRecord(record);
        const path = pathForKey(record.key);
        const handle = await open(path, 'wx', 0o600);
        await physical('record-opened');
        try {
          await handle.writeFile(bytes);
          await physical('record-written');
          await handle.sync();
          await physical('record-fsynced');
        } finally {
          await handle.close();
        }
        await syncRecoveryDirectory();
        return Object.freeze({ record, revision: revisionForBytes(bytes) });
      } catch (error) {
        if (isArtifactMutationError(error)) throw error;
        throw nodeErrorToArtifactMutationError(error, 'recovery', directory);
      }
    },
    replace: async (
      candidate: ArtifactPairRecoveryRecord,
      expectedRevision: string,
    ): Promise<ArtifactRecoveryEnvelope> => {
      try {
        if (!REVISION.test(expectedRevision)) invalid();
        await ensureDirectory();
        const record = ownArtifactPairRecoveryRecord(candidate);
        const livePath = pathForKey(record.key);
        const live = await readEnvelope(livePath);
        if (live.revision !== expectedRevision) invalid();
        assertTransition(live.record, record);
        const casId = nextCasId();
        const tempName = `.${record.key}.cas-${expectedRevision.slice('sha256:'.length)}-${casId}.tmp`;
        const tempPath = join(directory, tempName);
        const bytes = bytesForRecord(record);
        const handle = await open(tempPath, 'wx', 0o600);
        await physical('temp-opened');
        try {
          await handle.writeFile(bytes);
          await physical('temp-written');
          await handle.sync();
          await physical('temp-fsynced');
        } finally {
          await handle.close();
        }
        const latest = await readEnvelope(livePath);
        if (latest.revision !== expectedRevision) invalid();
        await ensureDirectory();
        await rename(tempPath, livePath);
        await physical('temp-renamed');
        await syncRecoveryDirectory();
        return Object.freeze({ record, revision: revisionForBytes(bytes) });
      } catch (error) {
        if (isArtifactMutationError(error)) throw error;
        throw nodeErrorToArtifactMutationError(error, 'recovery', directory);
      }
    },
    remove: async (key: string, expectedRevision: string): Promise<void> => {
      try {
        if (!REVISION.test(expectedRevision)) invalid();
        await ensureDirectory();
        const path = pathForKey(key);
        const live = await readEnvelope(path);
        if (live.revision !== expectedRevision) invalid();
        await unlink(path);
        await physical('file-unlinked');
        await syncRecoveryDirectory();
      } catch (error) {
        if (isArtifactMutationError(error)) throw error;
        throw nodeErrorToArtifactMutationError(error, 'recovery', directory);
      }
    },
  };
  return Object.freeze(port);
};
