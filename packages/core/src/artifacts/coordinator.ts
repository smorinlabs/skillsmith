import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { types as utilTypes } from 'node:util';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import {
  ARTIFACT_LOCK_RETRY_DELAYS_MS,
  type ArtifactCoordinatorPorts,
  type ArtifactFileRevision,
  type ArtifactGroupLockLease,
  type ArtifactMutationError,
  type ArtifactPairBarrier,
  type ArtifactPairMutationRequest,
  type ArtifactPairMutationResult,
  type ArtifactPairRecoveryRecord,
  type ArtifactPairSnapshot,
  type ArtifactRecordedAfterState,
  type ArtifactRecordedBeforeState,
  type ArtifactRecoveryDirectory,
  type ArtifactRecoveryEnvelope,
  type ArtifactRecoveryObject,
  type CoordinatedHumanFileRequest,
  type CoordinatedHumanFileResult,
  type HumanManifestAction,
} from './coordinator-types.ts';
import {
  artifactMutationError,
  copyArtifactFileRevision,
  isArtifactMutationError,
  nodeErrorToArtifactMutationError,
  observeArtifactFile,
  observeArtifactPair,
  observeOpaqueLockFile,
  ownDataErrorCode,
  sameArtifactRevision,
} from './file-state.ts';
import {
  type ArtifactDigest,
  HASH_SCHEMA_VERSION,
  hashCanonicalInput,
  hashManifestBytes,
  hashManifestSemantics,
} from './hash.ts';
import { correlatePortableLock, readPortableLockSource, serializePortableLock } from './lock.ts';
import { editManifestBytes } from './manifest-edit.ts';
import { normalizeManifestDocument, readManifestSource } from './manifest.ts';
import type { ResolvedArtifactPair } from './pair.ts';
import { artifactRecoveryKey } from './recovery-file.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const ID_16 = /^[0-9a-f]{16}$/u;
const ID_64 = /^[0-9a-f]{64}$/u;
const containsRejectedSinkMaterial = (value: string): boolean =>
  value.includes('[REDACTED]') || containsSensitiveMaterial(value);

type Role = 'manifest' | 'lock';
type PairRevisions = {
  readonly manifest: ArtifactFileRevision;
  readonly lock: ArtifactFileRevision;
};
type DesiredRole = {
  readonly role: Role;
  readonly digestKind: 'manifest' | 'lock' | 'resource';
  readonly path: string;
  readonly before: ArtifactFileRevision;
  readonly afterBytes: Uint8Array | null;
  readonly afterMode: number | null;
  readonly changed: boolean;
  readonly opaqueBefore: boolean;
  readonly opaqueManifestBackup: boolean;
};

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

const canonicalMembers = (targets: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(targets)].sort(compareUtf8));

const validatePath = (path: string): void => {
  if (path.length === 0 || containsRejectedSinkMaterial(path)) {
    throw artifactMutationError('invalid-request');
  }
};

const allocateId = (
  ports: ArtifactCoordinatorPorts,
  purpose: Parameters<ArtifactCoordinatorPorts['nextId']>[0],
  used: Set<string>,
): string => {
  const descriptor = Object.getOwnPropertyDescriptor(ports, 'nextId');
  if (
    descriptor === undefined ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'function'
  ) {
    throw artifactMutationError('filesystem-failure');
  }
  const id = ports.nextId(purpose);
  if (typeof id !== 'string') throw artifactMutationError('filesystem-failure');
  const valid = purpose === 'artifact-ownership' ? ID_64.test(id) : ID_16.test(id);
  if (!valid || used.has(`${purpose}:${id}`) || containsRejectedSinkMaterial(id)) {
    throw artifactMutationError('filesystem-failure');
  }
  used.add(`${purpose}:${id}`);
  return id;
};

const cancellation = (
  durableState: 'unobserved-before' | 'before' | 'after',
  revisions?: Partial<PairRevisions>,
): ArtifactMutationError =>
  artifactMutationError('cancelled', {
    durableState,
    ...(revisions?.manifest === undefined
      ? {}
      : { manifestRevision: copyArtifactFileRevision(revisions.manifest) }),
    ...(revisions?.lock === undefined
      ? {}
      : { lockRevision: copyArtifactFileRevision(revisions.lock) }),
  });

const nodeCode = ownDataErrorCode;

const asPermissionError = (
  error: unknown,
  role?: ArtifactMutationError['role'],
  path?: string,
): ArtifactMutationError | null => {
  if (isArtifactMutationError(error) && error.reason === 'permission-denied') return error;
  return nodeCode(error) === 'EACCES' || nodeCode(error) === 'EPERM'
    ? nodeErrorToArtifactMutationError(error, role, path)
    : null;
};

const throwIfPermissionError = (
  error: unknown,
  role?: ArtifactMutationError['role'],
  path?: string,
): void => {
  const permission = asPermissionError(error, role, path);
  if (permission !== null) throw permission;
};

class BarrierEmitter {
  readonly #ports: ArtifactCoordinatorPorts;
  readonly #operationId: string;
  readonly #occurrences = new Map<string, number>();
  revision: string | null = null;

  constructor(ports: ArtifactCoordinatorPorts, operationId: string) {
    this.#ports = ports;
    this.#operationId = operationId;
  }

  async emit(barrier: ArtifactPairBarrierInput): Promise<void> {
    const tuple = JSON.stringify([
      barrier.kind,
      'cursor' in barrier ? barrier.cursor : null,
      'role' in barrier ? (barrier.role ?? null) : null,
      'object' in barrier ? (barrier.object ?? null) : null,
      'operation' in barrier ? barrier.operation : null,
      'targetClass' in barrier ? barrier.targetClass : null,
    ]);
    const occurrence = this.#occurrences.get(tuple) ?? 0;
    this.#occurrences.set(tuple, occurrence + 1);
    await this.#ports.afterBarrier?.(
      Object.freeze({
        ...barrier,
        operationId: this.#operationId,
        occurrence,
        recordRevision: this.revision,
      }) as ArtifactPairBarrier,
    );
  }
}

type ArtifactPairBarrierInput = ArtifactPairBarrier extends infer Barrier
  ? Barrier extends ArtifactPairBarrier
    ? Omit<Barrier, 'operationId' | 'occurrence' | 'recordRevision'>
    : never
  : never;

interface HeldLocks {
  readonly release: () => void;
  readonly acquired: Promise<void>;
  readonly finished: Promise<void>;
  readonly releasedSuccessfully: Promise<boolean>;
}

type ArtifactGroupMemberState = 'unrequested' | 'acquiring' | 'held' | 'failed' | 'released';

declare const artifactGroupLeaseScaffoldReceiptBrand: unique symbol;

export type ArtifactGroupLeaseScaffoldReceipt = Readonly<{
  readonly [artifactGroupLeaseScaffoldReceiptBrand]: true;
}>;

interface ArtifactGroupLeaseScaffoldProof {
  readonly targetPath: string;
  readonly parentPath: string;
  readonly parentIdentity: string;
  readonly parentMode: number;
}

interface ArtifactGroupScaffoldDirectoryWitness {
  readonly path: string;
  readonly identity: string;
  readonly mode: number;
  readonly parentPath: string;
  readonly parentIdentity: string;
}

interface ArtifactGroupScaffoldTarget {
  readonly targetPath: string;
  readonly parentPath: string;
  readonly anchorPath: string | null;
  readonly chainPaths: readonly string[];
  eligible: boolean;
}

interface ArtifactGroupScaffoldState {
  readonly leaseState: ArtifactGroupLeaseState;
  readonly created: ArtifactGroupScaffoldDirectoryWitness[];
  readonly createdByPath: Map<string, ArtifactGroupScaffoldDirectoryWitness>;
  readonly anchors: Map<string, ArtifactGroupScaffoldDirectoryWitness>;
  readonly targets: Map<string, ArtifactGroupScaffoldTarget>;
  preparation: Promise<Result<ArtifactGroupLeaseScaffoldReceipt, ArtifactMutationError>> | null;
  status: 'preparing' | 'ready' | 'failed' | 'expired';
  consumed: boolean;
  retain: boolean;
}

interface ArtifactGroupLeaseState {
  readonly ports: ArtifactCoordinatorPorts;
  readonly pair: ResolvedArtifactPair;
  readonly targets: readonly string[];
  readonly operationId: string;
  readonly barrier: BarrierEmitter;
  readonly signal: AbortSignal | undefined;
  readonly usedIds: Set<string>;
  active: boolean;
  memberState: ArtifactGroupMemberState;
  commitActive: boolean;
  recoveredPending: boolean;
  inFlight: Promise<Result<ArtifactPairMutationResult, ArtifactMutationError>> | null;
  scaffold: ArtifactGroupScaffoldState | null;
}

const artifactGroupLeaseStates = new WeakMap<ArtifactGroupLockLease, ArtifactGroupLeaseState>();
const artifactGroupScaffoldReceipts = new WeakMap<
  ArtifactGroupLeaseScaffoldReceipt,
  ArtifactGroupScaffoldState
>();

const samePairPath = (
  left: ResolvedArtifactPair['file'],
  right: ResolvedArtifactPair['file'],
): boolean =>
  left.token === right.token &&
  left.path === right.path &&
  left.portability === right.portability &&
  left.portableToken === right.portableToken;

const sameArtifactPair = (left: ResolvedArtifactPair, right: ResolvedArtifactPair): boolean =>
  samePairPath(left.file, right.file) &&
  samePairPath(left.lockfile, right.lockfile) &&
  left.lockfileSource === right.lockfileSource;

const ownArtifactPair = (pair: ResolvedArtifactPair): ResolvedArtifactPair =>
  Object.freeze({
    file: Object.freeze({
      token: pair.file.token,
      path: pair.file.path,
      portability: pair.file.portability,
      portableToken: pair.file.portableToken,
    }),
    lockfile: Object.freeze({
      token: pair.lockfile.token,
      path: pair.lockfile.path,
      portability: pair.lockfile.portability,
      portableToken: pair.lockfile.portableToken,
    }),
    lockfileSource: pair.lockfileSource,
  });

const beginHeldLocks = (
  ports: ArtifactCoordinatorPorts,
  targets: readonly string[],
  operationId: string,
  signal: AbortSignal | undefined,
  barrier: BarrierEmitter,
): HeldLocks => {
  let release = (): void => {};
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquiredResolve!: () => void;
  let acquiredReject!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  const sorted = canonicalMembers(targets);
  const noCallbackError = Symbol('no-callback-error');
  let releasesSucceeded = true;
  const enter = async (index: number): Promise<void> => {
    const target = sorted[index];
    if (target === undefined) {
      acquiredResolve();
      await releasePromise;
      return;
    }
    let callbackError: unknown = noCallbackError;
    let callbackEntered = false;
    try {
      await ports.withFileLock(
        target,
        {
          policy: 'compatibility',
          centralOperationId: operationId,
          ...(signal === undefined ? {} : { signal }),
          retryDelaysMs: ARTIFACT_LOCK_RETRY_DELAYS_MS,
        },
        async () => {
          callbackEntered = true;
          try {
            await barrier.emit({ kind: 'lock-acquired', targetClass: 'compatibility' });
            await enter(index + 1);
          } catch (error) {
            callbackError = error;
          }
        },
      );
    } catch (error) {
      if (callbackEntered) {
        releasesSucceeded = false;
      } else {
        try {
          if ((await ports.observe(`${target}.lock`)).kind !== 'absent') {
            releasesSucceeded = false;
          }
        } catch {
          releasesSucceeded = false;
        }
      }
      throw error;
    }
    if (callbackError !== noCallbackError) throw callbackError;
  };
  const finished = enter(0).catch((error) => {
    acquiredReject(error);
    throw error;
  });
  const releasedSuccessfully = finished.then(
    () => true,
    () => releasesSucceeded,
  );
  return { acquired, finished, release, releasedSuccessfully };
};

const withMembersHeld = async <T>(
  ports: ArtifactCoordinatorPorts,
  targets: readonly string[],
  operationId: string,
  signal: AbortSignal | undefined,
  barrier: BarrierEmitter,
  operation: () => Promise<T>,
): Promise<T> => {
  const held = beginHeldLocks(ports, targets, operationId, signal, barrier);
  try {
    await held.acquired;
  } catch (error) {
    held.release();
    await held.finished.catch(() => undefined);
    throw error;
  }
  try {
    if (signal?.aborted) throw cancellation('unobserved-before');
    return await operation();
  } finally {
    held.release();
    await held.finished;
  }
};

const withCentralHeld = async <T>(
  ports: ArtifactCoordinatorPorts,
  signal: AbortSignal | undefined,
  operation: (operationId: string, barrier: BarrierEmitter) => Promise<T>,
): Promise<T> => {
  const used = new Set<string>();
  const operationId = allocateId(ports, 'artifact-operation', used);
  const barrier = new BarrierEmitter(ports, operationId);
  if (signal?.aborted) throw cancellation('unobserved-before');
  return ports.withFileLock(
    join(ports.coordinationRoot, 'global'),
    {
      policy: 'central',
      centralOperationId: operationId,
      ...(signal === undefined ? {} : { signal }),
      retryDelaysMs: ARTIFACT_LOCK_RETRY_DELAYS_MS,
    },
    async () => {
      await barrier.emit({ kind: 'lock-acquired', targetClass: 'central' });
      if (signal?.aborted) throw cancellation('unobserved-before');
      return operation(operationId, barrier);
    },
  );
};

const isStrictArtifactPathAncestor = (ancestor: string, target: string): boolean => {
  const displacement = relative(ancestor, target);
  return (
    displacement !== '' &&
    displacement !== '..' &&
    !displacement.startsWith(`..${sep}`) &&
    !isAbsolute(displacement)
  );
};

const artifactGroupTargetTopologyIsSafe = (pair: ResolvedArtifactPair): boolean => {
  const manifest = pair.file.path;
  const lock = pair.lockfile.path;
  if (
    manifest === lock ||
    isStrictArtifactPathAncestor(manifest, lock) ||
    isStrictArtifactPathAncestor(lock, manifest)
  ) {
    return false;
  }
  const manifestSidecar = `${manifest}.lock`;
  const lockSidecar = `${lock}.lock`;
  return !(
    manifestSidecar === lock ||
    isStrictArtifactPathAncestor(manifestSidecar, lock) ||
    lockSidecar === manifest ||
    isStrictArtifactPathAncestor(lockSidecar, manifest)
  );
};

const observeArtifactGroupScaffoldDirectory = async (
  ports: ArtifactCoordinatorPorts,
  path: string,
): Promise<ArtifactGroupScaffoldDirectoryWitness> => {
  const observed = await ports.observe(path);
  if (
    observed.kind !== 'directory' ||
    observed.identity === null ||
    observed.mode === null ||
    observed.parent.state !== 'present' ||
    observed.parent.path !== dirname(path)
  ) {
    throw artifactMutationError('invalid-file-kind', { path });
  }
  return Object.freeze({
    path,
    identity: observed.identity,
    mode: observed.mode,
    parentPath: observed.parent.path,
    parentIdentity: observed.parent.identity,
  });
};

const artifactGroupScaffoldDirectoryStillMatches = async (
  ports: ArtifactCoordinatorPorts,
  witness: ArtifactGroupScaffoldDirectoryWitness,
): Promise<boolean> => {
  const observed = await ports.observe(witness.path);
  return (
    observed.kind === 'directory' &&
    observed.identity === witness.identity &&
    observed.mode === witness.mode &&
    observed.parent.state === 'present' &&
    observed.parent.path === witness.parentPath &&
    observed.parent.identity === witness.parentIdentity
  );
};

const cleanupArtifactGroupLeaseScaffold = async (
  scaffold: ArtifactGroupScaffoldState,
): Promise<void> => {
  if (scaffold.retain) return;
  const { ports, barrier } = scaffold.leaseState;
  for (const witness of [...scaffold.anchors.values(), ...scaffold.created]) {
    if (!(await artifactGroupScaffoldDirectoryStillMatches(ports, witness))) {
      scaffold.retain = true;
      return;
    }
  }
  for (const directory of [...scaffold.created].reverse()) {
    if (!(await artifactGroupScaffoldDirectoryStillMatches(ports, directory))) {
      scaffold.retain = true;
      return;
    }
    try {
      await ports.removeEmptyDirectory(directory.path);
    } catch (error) {
      const code = nodeCode(error);
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') {
        scaffold.retain = true;
        return;
      }
      throw error;
    }
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'provisioning',
      operation: 'remove-directory',
      object: 'parent',
    });
    await ports.fsyncDirectory(directory.parentPath);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'provisioning',
      operation: 'fsync-directory',
      object: 'parent',
    });
  }
};

const assertArtifactGroupScaffoldPreparationCurrent = (
  leaseState: ArtifactGroupLeaseState,
  scaffold: ArtifactGroupScaffoldState,
): void => {
  if (
    !leaseState.active ||
    leaseState.scaffold !== scaffold ||
    leaseState.memberState !== 'unrequested' ||
    scaffold.status !== 'preparing'
  ) {
    throw artifactMutationError('invalid-request');
  }
};

export const prepareArtifactGroupLeaseScaffold = async (
  lease: ArtifactGroupLockLease,
  memberTargets: readonly string[],
): Promise<Result<ArtifactGroupLeaseScaffoldReceipt, ArtifactMutationError>> => {
  const leaseState = artifactGroupLeaseStates.get(lease);
  if (
    leaseState === undefined ||
    !leaseState.active ||
    leaseState.memberState !== 'unrequested' ||
    leaseState.commitActive ||
    leaseState.inFlight !== null ||
    leaseState.scaffold !== null ||
    !artifactGroupTargetTopologyIsSafe(leaseState.pair)
  ) {
    return err(artifactMutationError('invalid-request'));
  }
  const targets = canonicalMembers(memberTargets);
  if (
    targets.length !== leaseState.targets.length ||
    targets.some((target, index) => target !== leaseState.targets[index])
  ) {
    return err(artifactMutationError('invalid-request'));
  }
  if (leaseState.signal?.aborted) return err(cancellation('unobserved-before'));

  const receipt = Object.freeze({}) as ArtifactGroupLeaseScaffoldReceipt;
  const scaffold: ArtifactGroupScaffoldState = {
    leaseState,
    created: [],
    createdByPath: new Map(),
    anchors: new Map(),
    targets: new Map(),
    preparation: null,
    status: 'preparing',
    consumed: false,
    retain: false,
  };
  leaseState.scaffold = scaffold;
  artifactGroupScaffoldReceipts.set(receipt, scaffold);

  const preparation = (async (): Promise<
    Result<ArtifactGroupLeaseScaffoldReceipt, ArtifactMutationError>
  > => {
    try {
      const candidates = new Set<string>();
      const knownDirectories = new Map<string, ArtifactGroupScaffoldDirectoryWitness>();
      for (const targetPath of leaseState.targets) {
        const observed = await leaseState.ports.observe(targetPath);
        if (observed.kind !== 'absent' && observed.kind !== 'file') {
          throw artifactMutationError('invalid-file-kind', { path: targetPath });
        }
        if (observed.parent.state === 'present') {
          scaffold.targets.set(targetPath, {
            targetPath,
            parentPath: dirname(targetPath),
            anchorPath: null,
            chainPaths: Object.freeze([]),
            eligible: false,
          });
          continue;
        }

        const anchor = await observeArtifactGroupScaffoldDirectory(
          leaseState.ports,
          observed.parent.nearestExistingPath,
        );
        if (anchor.identity !== observed.parent.nearestExistingIdentity) {
          throw artifactMutationError('external-writer-conflict', {
            path: observed.parent.nearestExistingPath,
          });
        }
        const priorAnchor = scaffold.anchors.get(anchor.path);
        if (
          priorAnchor !== undefined &&
          (priorAnchor.identity !== anchor.identity || priorAnchor.mode !== anchor.mode)
        ) {
          throw artifactMutationError('external-writer-conflict', { path: anchor.path });
        }
        scaffold.anchors.set(anchor.path, priorAnchor ?? anchor);
        knownDirectories.set(anchor.path, priorAnchor ?? anchor);

        const chainPaths: string[] = [];
        let cursor = anchor.path;
        for (const segment of observed.parent.missingSegments) {
          cursor = join(cursor, segment);
          chainPaths.push(cursor);
          candidates.add(cursor);
        }
        scaffold.targets.set(targetPath, {
          targetPath,
          parentPath: dirname(targetPath),
          anchorPath: anchor.path,
          chainPaths: Object.freeze(chainPaths),
          eligible: observed.kind === 'absent',
        });
      }

      const orderedCandidates = [...candidates].sort((left, right) => {
        const leftDepth = left.split(sep).length;
        const rightDepth = right.split(sep).length;
        return leftDepth === rightDepth ? compareUtf8(left, right) : leftDepth - rightDepth;
      });
      for (const path of orderedCandidates) {
        if (leaseState.signal?.aborted) throw cancellation('unobserved-before');
        assertArtifactGroupScaffoldPreparationCurrent(leaseState, scaffold);
        const parentPath = dirname(path);
        const parent = knownDirectories.get(parentPath);
        if (
          parent === undefined ||
          !(await artifactGroupScaffoldDirectoryStillMatches(leaseState.ports, parent))
        ) {
          throw artifactMutationError('external-writer-conflict', { path: parentPath });
        }
        assertArtifactGroupScaffoldPreparationCurrent(leaseState, scaffold);
        try {
          await leaseState.ports.makeDirectoryExclusive(path, 0o700);
        } catch (error) {
          if (nodeCode(error) !== 'EEXIST') throw error;
          const existing = await observeArtifactGroupScaffoldDirectory(leaseState.ports, path);
          if (existing.parentPath !== parent.path || existing.parentIdentity !== parent.identity) {
            throw artifactMutationError('external-writer-conflict', { path });
          }
          knownDirectories.set(path, existing);
          for (const target of scaffold.targets.values()) {
            if (target.chainPaths.includes(path)) target.eligible = false;
          }
          assertArtifactGroupScaffoldPreparationCurrent(leaseState, scaffold);
          continue;
        }

        const created = await observeArtifactGroupScaffoldDirectory(leaseState.ports, path);
        scaffold.created.push(created);
        scaffold.createdByPath.set(path, created);
        knownDirectories.set(path, created);
        assertArtifactGroupScaffoldPreparationCurrent(leaseState, scaffold);
        if (
          created.mode !== 0o700 ||
          created.parentPath !== parent.path ||
          created.parentIdentity !== parent.identity
        ) {
          throw artifactMutationError('external-writer-conflict', { path });
        }
        await leaseState.barrier.emit({
          kind: 'mutation-returned',
          cursor: 'provisioning',
          operation: 'create-directory-exclusive',
          object: 'parent',
        });
        assertArtifactGroupScaffoldPreparationCurrent(leaseState, scaffold);
        await leaseState.ports.fsyncDirectory(parentPath);
        assertArtifactGroupScaffoldPreparationCurrent(leaseState, scaffold);
        await leaseState.barrier.emit({
          kind: 'mutation-returned',
          cursor: 'provisioning',
          operation: 'fsync-directory',
          object: 'parent',
        });
      }

      for (const target of scaffold.targets.values()) {
        if ((await leaseState.ports.observe(target.targetPath)).kind !== 'absent') {
          target.eligible = false;
        }
      }
      if (leaseState.signal?.aborted) throw cancellation('unobserved-before');
      assertArtifactGroupScaffoldPreparationCurrent(leaseState, scaffold);
      scaffold.status = 'ready';
      return ok(receipt);
    } catch (error) {
      if (scaffold.status === 'preparing') scaffold.status = 'failed';
      return err(asResultError(error));
    }
  })();
  scaffold.preparation = preparation;
  return preparation;
};

const artifactGroupScaffoldAuthenticationIsCurrent = (
  leaseState: ArtifactGroupLeaseState,
  scaffold: ArtifactGroupScaffoldState,
): boolean =>
  leaseState.scaffold === scaffold &&
  leaseState.active &&
  leaseState.memberState === 'held' &&
  !leaseState.commitActive &&
  leaseState.inFlight === null &&
  scaffold.status === 'ready' &&
  !scaffold.consumed &&
  !scaffold.retain;

export const authenticateArtifactGroupLeaseScaffold = async (
  lease: ArtifactGroupLockLease,
  receipt: ArtifactGroupLeaseScaffoldReceipt,
  targetPath: string,
): Promise<Result<ArtifactGroupLeaseScaffoldProof | null, ArtifactMutationError>> => {
  const leaseState = artifactGroupLeaseStates.get(lease);
  const scaffold = artifactGroupScaffoldReceipts.get(receipt);
  const target = scaffold?.targets.get(targetPath);
  if (
    leaseState === undefined ||
    scaffold === undefined ||
    scaffold.leaseState !== leaseState ||
    !artifactGroupScaffoldAuthenticationIsCurrent(leaseState, scaffold) ||
    target === undefined ||
    !leaseState.targets.includes(targetPath)
  ) {
    return err(artifactMutationError('invalid-request'));
  }
  if (!target.eligible || target.anchorPath === null) return ok(null);
  const directParent = scaffold.createdByPath.get(target.parentPath);
  const anchor = scaffold.anchors.get(target.anchorPath);
  if (directParent === undefined || anchor === undefined) return ok(null);

  try {
    if (!(await artifactGroupScaffoldDirectoryStillMatches(leaseState.ports, anchor))) {
      if (!artifactGroupScaffoldAuthenticationIsCurrent(leaseState, scaffold)) {
        return err(artifactMutationError('invalid-request'));
      }
      return ok(null);
    }
    for (const path of target.chainPaths) {
      const created = scaffold.createdByPath.get(path);
      if (
        created === undefined ||
        created.mode !== 0o700 ||
        !(await artifactGroupScaffoldDirectoryStillMatches(leaseState.ports, created))
      ) {
        if (!artifactGroupScaffoldAuthenticationIsCurrent(leaseState, scaffold)) {
          return err(artifactMutationError('invalid-request'));
        }
        return ok(null);
      }
    }
    const observedTarget = await leaseState.ports.observe(targetPath);
    if (
      observedTarget.kind !== 'absent' ||
      observedTarget.parent.state !== 'present' ||
      observedTarget.parent.path !== target.parentPath ||
      observedTarget.parent.identity !== directParent.identity
    ) {
      if (!artifactGroupScaffoldAuthenticationIsCurrent(leaseState, scaffold)) {
        return err(artifactMutationError('invalid-request'));
      }
      return ok(null);
    }
    const currentParent = await leaseState.ports.observe(target.parentPath);
    if (
      currentParent.kind !== 'directory' ||
      currentParent.identity !== directParent.identity ||
      currentParent.mode !== 0o700 ||
      currentParent.parent.state !== 'present' ||
      currentParent.parent.path !== directParent.parentPath ||
      currentParent.parent.identity !== directParent.parentIdentity
    ) {
      if (!artifactGroupScaffoldAuthenticationIsCurrent(leaseState, scaffold)) {
        return err(artifactMutationError('invalid-request'));
      }
      return ok(null);
    }
    if (!artifactGroupScaffoldAuthenticationIsCurrent(leaseState, scaffold)) {
      return err(artifactMutationError('invalid-request'));
    }
    return ok(
      Object.freeze({
        targetPath,
        parentPath: target.parentPath,
        parentIdentity: currentParent.identity,
        parentMode: currentParent.mode,
      }) as ArtifactGroupLeaseScaffoldProof,
    );
  } catch (error) {
    return err(asResultError(error));
  }
};

export const withArtifactGroupLock = async <T>(
  ports: ArtifactCoordinatorPorts,
  pair: ResolvedArtifactPair,
  signal: AbortSignal | undefined,
  operation: (lease: ArtifactGroupLockLease) => Promise<T>,
): Promise<T> => {
  const ownedPair = ownArtifactPair(pair);
  const targets = canonicalMembers([ownedPair.file.path, ownedPair.lockfile.path]);
  targets.forEach(validatePath);
  try {
    return await withCentralHeld(ports, signal, async (operationId, barrier) => {
      const recovered = await resolveOverlaps(ports, targets, operationId, barrier, signal);
      let held: HeldLocks | null = null;
      const lease: ArtifactGroupLockLease = Object.freeze({
        acquireCompatibilityTargets: async (requested: readonly string[]) => {
          const state = artifactGroupLeaseStates.get(lease);
          if (
            state === undefined ||
            !state.active ||
            state.memberState !== 'unrequested' ||
            (state.scaffold !== null && state.scaffold.status !== 'ready')
          ) {
            throw artifactMutationError('invalid-request');
          }
          const members = canonicalMembers(requested);
          if (
            members.length === 0 ||
            members.some((target, index) => target !== targets[index]) ||
            members.length !== targets.length
          )
            throw artifactMutationError('invalid-request');
          state.memberState = 'acquiring';
          try {
            held = beginHeldLocks(ports, members, operationId, signal, barrier);
            await held.acquired;
            state.memberState = 'held';
          } catch (error) {
            state.memberState = 'failed';
            throw error;
          }
        },
      });
      const state: ArtifactGroupLeaseState = {
        ports,
        pair: ownedPair,
        targets,
        operationId,
        barrier,
        signal,
        usedIds: new Set<string>(),
        active: true,
        memberState: 'unrequested',
        commitActive: false,
        recoveredPending: recovered,
        inFlight: null,
        scaffold: null,
      };
      artifactGroupLeaseStates.set(lease, state);
      const outcome = await operation(lease).then(
        (value) => Object.freeze({ ok: true as const, value }),
        (error: unknown) => Object.freeze({ ok: false as const, error }),
      );
      state.active = false;
      const preparingScaffold = state.scaffold;
      if (preparingScaffold !== null) preparingScaffold.status = 'expired';
      if (preparingScaffold !== null && preparingScaffold.preparation !== null) {
        await preparingScaffold.preparation;
      }
      if (state.inFlight !== null) await state.inFlight;
      const scaffold = state.scaffold;
      let heldFailure: unknown = null;
      let membersReleasedSuccessfully = true;
      if (held !== null) {
        (held as HeldLocks).release();
        heldFailure = await (held as HeldLocks).finished.then(
          () => null,
          (error) => error,
        );
        membersReleasedSuccessfully = await (held as HeldLocks).releasedSuccessfully;
      }
      let cleanupFailure: unknown = null;
      if (membersReleasedSuccessfully) {
        state.memberState = 'released';
        if (scaffold !== null) {
          cleanupFailure = await cleanupArtifactGroupLeaseScaffold(scaffold).then(
            () => null,
            (error) => error,
          );
        }
      }
      if (heldFailure !== null) throw heldFailure;
      if (cleanupFailure !== null) throw cleanupFailure;
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
  } catch (error) {
    if (nodeCode(error) === 'ABORT_ERR') throw cancellation('unobserved-before');
    throw error;
  }
};

const revisionToBefore = (revision: ArtifactFileRevision): ArtifactRecordedBeforeState =>
  revision.state === 'absent'
    ? Object.freeze({ state: 'absent' })
    : Object.freeze({
        state: 'file',
        digest: revision.digest,
        mode: revision.mode,
        identity: revision.identity,
      });

const desiredAfter = (role: DesiredRole): ArtifactRecordedAfterState =>
  role.afterBytes === null
    ? Object.freeze({ state: 'absent' })
    : Object.freeze({
        state: 'file',
        digest: hashBytes(role.afterBytes, role.digestKind),
        mode: role.afterMode as number,
        identity: role.changed ? null : role.before.state === 'file' ? role.before.identity : null,
      });

const hashBytes = (bytes: Uint8Array, kind: 'manifest' | 'lock' | 'resource') => {
  if (kind === 'manifest') return hashManifestBytes(bytes);
  const result = hashCanonicalInput(
    kind === 'lock' ? 'lock-canonical' : 'resource',
    HASH_SCHEMA_VERSION,
    bytes,
  );
  if (!result.ok) throw artifactMutationError('invalid-lock', { role: 'lock' });
  return result.value;
};

const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw artifactMutationError('invalid-utf8', { role: 'manifest' });
    }
    return decoder.decode(new Uint8Array(bytes));
  } catch (error) {
    if (isArtifactMutationError(error)) throw error;
    throw artifactMutationError('invalid-utf8', { role: 'manifest' });
  }
};

const validateCandidateBytes = (bytes: Uint8Array, role: 'manifest' | 'lock'): string => {
  let text: string;
  try {
    text = decoder.decode(new Uint8Array(bytes));
  } catch {
    throw artifactMutationError('invalid-utf8', { role });
  }
  if (containsRejectedSinkMaterial(text)) {
    throw artifactMutationError('unsafe-human-edit', { role });
  }
  return text;
};

const normalizedManifest = (bytes: Uint8Array) => {
  const source = decodeUtf8(bytes);
  if (containsRejectedSinkMaterial(source)) {
    throw artifactMutationError('unsafe-human-edit', { role: 'manifest' });
  }
  const read = readManifestSource(source);
  if (!read.ok || read.value.shape !== 'canonical') {
    throw artifactMutationError('invalid-manifest', { role: 'manifest' });
  }
  const normalized = normalizeManifestDocument(read.value);
  if (!normalized.ok) throw artifactMutationError('invalid-manifest', { role: 'manifest' });
  return normalized.value;
};

const sameParent = (
  left: ArtifactFileRevision['parent'],
  right: ArtifactFileRevision['parent'],
): boolean => JSON.stringify(left) === JSON.stringify(right);

const classifyFreshSnapshot = (
  provisional: ArtifactPairSnapshot,
  fresh: ArtifactPairSnapshot,
  desired: readonly DesiredRole[],
): { readonly replayedManifestBytes: boolean; readonly convergedToDesired: boolean } => {
  const matchesDesired = (role: 'manifest' | 'lock'): boolean => {
    const planned = desired.find((entry) => entry.role === role);
    const revision = fresh[role];
    if (planned === undefined) return false;
    const compatibleParent =
      sameParent(planned.before.parent, revision.parent) ||
      (planned.before.parent.state === 'missing' && revision.parent.state === 'present');
    if (!compatibleParent) return false;
    if (planned.afterBytes === null) return revision.state === 'absent';
    return (
      revision.state === 'file' &&
      equalBytes(planned.afterBytes, revision.bytes) &&
      planned.afterMode === revision.mode
    );
  };
  if (matchesDesired('manifest') && matchesDesired('lock')) {
    return Object.freeze({ replayedManifestBytes: false, convergedToDesired: true });
  }
  const sameLock =
    sameArtifactRevision(provisional.lock, fresh.lock) ||
    (provisional.lock.state === 'absent' &&
      fresh.lock.state === 'absent' &&
      provisional.lock.parent.state === 'missing' &&
      fresh.lock.parent.state === 'present');
  if (!sameLock) throw artifactMutationError('external-writer-conflict', { role: 'lock' });
  if (
    sameArtifactRevision(provisional.manifest, fresh.manifest) ||
    (provisional.manifest.state === 'absent' &&
      fresh.manifest.state === 'absent' &&
      provisional.manifest.parent.state === 'missing' &&
      fresh.manifest.parent.state === 'present')
  ) {
    return Object.freeze({ replayedManifestBytes: false, convergedToDesired: false });
  }
  if (
    provisional.manifest.state !== 'file' ||
    fresh.manifest.state !== 'file' ||
    provisional.manifest.mode !== fresh.manifest.mode ||
    provisional.manifest.identity !== fresh.manifest.identity ||
    !sameParent(provisional.manifest.parent, fresh.manifest.parent)
  ) {
    throw artifactMutationError('external-writer-conflict', { role: 'manifest' });
  }
  const before = normalizedManifest(provisional.manifest.bytes);
  const after = normalizedManifest(fresh.manifest.bytes);
  if (hashManifestSemantics(before) !== hashManifestSemantics(after)) {
    throw artifactMutationError('external-writer-conflict', { role: 'manifest' });
  }
  return Object.freeze({ replayedManifestBytes: true, convergedToDesired: false });
};

const assertStableDesiredPlan = (
  provisional: readonly DesiredRole[],
  fresh: readonly DesiredRole[],
): void => {
  for (const role of ['manifest', 'lock'] as const) {
    const before = provisional.find((entry) => entry.role === role);
    const after = fresh.find((entry) => entry.role === role);
    if (before === undefined || after === undefined || before.afterMode !== after.afterMode) {
      throw artifactMutationError('external-writer-conflict', { role });
    }
    if (role === 'lock') {
      if (!equalBytes(before.afterBytes, after.afterBytes)) {
        throw artifactMutationError('external-writer-conflict', { role });
      }
      continue;
    }
    if (before.afterBytes === null || after.afterBytes === null) {
      if (before.afterBytes !== after.afterBytes) {
        throw artifactMutationError('external-writer-conflict', { role });
      }
      continue;
    }
    if (
      hashManifestSemantics(normalizedManifest(before.afterBytes)) !==
      hashManifestSemantics(normalizedManifest(after.afterBytes))
    ) {
      throw artifactMutationError('external-writer-conflict', { role });
    }
  }
};

const prepareManifest = (
  action: HumanManifestAction,
  current: ArtifactFileRevision,
): { readonly bytes: Uint8Array | null; readonly mode: number | null } => {
  if (action.kind === 'keep') {
    return current.state === 'file'
      ? { bytes: new Uint8Array(current.bytes), mode: current.mode }
      : { bytes: null, mode: null };
  }
  if (action.kind === 'replace') {
    if (current.state === 'file') {
      throw artifactMutationError('invalid-request', { role: 'manifest' });
    }
    const bytes = new Uint8Array(action.bytes);
    normalizedManifest(bytes);
    return { bytes, mode: 0o600 };
  }
  if (current.state !== 'file')
    throw artifactMutationError('invalid-manifest', { role: 'manifest' });
  const edited = editManifestBytes(new Uint8Array(current.bytes), action.request);
  if (!edited.ok) {
    throw artifactMutationError(edited.error.reason, {
      ...(edited.error.role === undefined ? {} : { role: edited.error.role }),
      ...(edited.error.field === undefined ? {} : { field: edited.error.field }),
      ...(edited.error.manualPatch === undefined ? {} : { manualPatch: edited.error.manualPatch }),
    });
  }
  const bytes = new Uint8Array(edited.value.bytes);
  validateCandidateBytes(bytes, 'manifest');
  return { bytes, mode: current.mode };
};

const equalBytes = (left: Uint8Array | null, right: Uint8Array | null): boolean => {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
};

const makeDesiredRoles = (
  request: ArtifactPairMutationRequest,
  snapshot: ArtifactPairSnapshot,
): readonly DesiredRole[] => {
  const manifest = prepareManifest(request.manifest, snapshot.manifest);
  let lockBytes: Uint8Array | null;
  let lockMode: number | null;
  if (request.lock.kind === 'keep') {
    lockBytes = snapshot.lock.state === 'file' ? new Uint8Array(snapshot.lock.bytes) : null;
    lockMode = snapshot.lock.state === 'file' ? snapshot.lock.mode : null;
  } else if (request.lock.kind === 'remove') {
    if (manifest.bytes !== null && normalizedManifest(manifest.bytes).skills.length > 0) {
      throw artifactMutationError('invalid-request', { role: 'lock' });
    }
    lockBytes = null;
    lockMode = null;
  } else {
    const serialized = serializePortableLock(request.lock.lock);
    if (!serialized.ok) throw artifactMutationError('invalid-lock', { role: 'lock' });
    lockBytes = encoder.encode(serialized.value);
    validateCandidateBytes(lockBytes, 'lock');
    if (!readPortableLockSource(lockBytes).ok)
      throw artifactMutationError('invalid-lock', { role: 'lock' });
    lockMode = snapshot.lock.state === 'file' ? snapshot.lock.mode : 0o600;
    if (
      manifest.bytes === null ||
      correlatePortableLock(normalizedManifest(manifest.bytes), request.lock.lock).state !==
        'current'
    ) {
      throw artifactMutationError('invalid-lock', { role: 'lock' });
    }
  }
  const currentManifest = snapshot.manifest.state === 'file' ? snapshot.manifest.bytes : null;
  const currentLock = snapshot.lock.state === 'file' ? snapshot.lock.bytes : null;
  return Object.freeze([
    Object.freeze({
      role: 'lock' as const,
      digestKind: 'lock' as const,
      path: request.pair.lockfile.path,
      before: snapshot.lock,
      afterBytes: lockBytes,
      afterMode: lockMode,
      changed:
        !equalBytes(currentLock, lockBytes) ||
        (lockMode !== null && snapshot.lock.state === 'file' && snapshot.lock.mode !== lockMode),
      opaqueBefore: request.lock.kind === 'replace-invalid',
      opaqueManifestBackup: false,
    }),
    Object.freeze({
      role: 'manifest' as const,
      digestKind: 'manifest' as const,
      path: request.pair.file.path,
      before: snapshot.manifest,
      afterBytes: manifest.bytes,
      afterMode: manifest.mode,
      changed:
        !equalBytes(currentManifest, manifest.bytes) ||
        (manifest.mode !== null &&
          snapshot.manifest.state === 'file' &&
          snapshot.manifest.mode !== manifest.mode),
      opaqueBefore: false,
      opaqueManifestBackup: false,
    }),
  ]);
};

const validateLockPrecondition = (
  snapshot: ArtifactPairSnapshot,
  request: ArtifactPairMutationRequest,
  phase: 'provisional' | 'fresh',
): void => {
  if (request.lock.kind === 'replace-exact') {
    const expected = request.lock.expectedByteRevision;
    if (expected === null) {
      if (snapshot.lock.state !== 'absent') {
        throw artifactMutationError('external-writer-conflict', { role: 'lock' });
      }
      return;
    }
    if (snapshot.lock.state !== 'file') {
      throw artifactMutationError('external-writer-conflict', { role: 'lock' });
    }
    const revision = hashCanonicalInput('resource', HASH_SCHEMA_VERSION, snapshot.lock.bytes);
    if (!revision.ok || revision.value !== expected) {
      throw artifactMutationError('external-writer-conflict', { role: 'lock' });
    }
    if (!readPortableLockSource(snapshot.lock.bytes).ok) {
      throw artifactMutationError(
        phase === 'provisional' ? 'invalid-request' : 'external-writer-conflict',
        { role: 'lock' },
      );
    }
    return;
  }
  if (request.lock.kind !== 'replace-invalid') return;
  if (snapshot.lock.state !== 'file') {
    throw artifactMutationError(
      phase === 'provisional' ? 'invalid-request' : 'external-writer-conflict',
      { role: 'lock' },
    );
  }
  if (readPortableLockSource(snapshot.lock.bytes).ok) {
    throw artifactMutationError(
      phase === 'provisional' ? 'invalid-request' : 'external-writer-conflict',
      { role: 'lock' },
    );
  }
  const revision = hashCanonicalInput('resource', HASH_SCHEMA_VERSION, snapshot.lock.bytes);
  if (!revision.ok || revision.value !== request.lock.expectedByteRevision) {
    throw artifactMutationError('external-writer-conflict', { role: 'lock' });
  }
};

const provisionParent = async (
  ports: ArtifactCoordinatorPorts,
  revision: ArtifactFileRevision,
  barrier: BarrierEmitter,
): Promise<void> => {
  if (revision.parent.state === 'present') return;
  let parent = revision.parent.nearestExistingPath;
  let identity = revision.parent.nearestExistingIdentity;
  for (const segment of revision.parent.missingSegments) {
    const parentObservation = await ports.observe(join(parent, '__skillsmith-parent-probe__'));
    if (
      parentObservation.parent.state !== 'present' ||
      parentObservation.parent.identity !== identity
    ) {
      throw artifactMutationError('external-writer-conflict', { path: parent });
    }
    const next = join(parent, segment);
    try {
      await ports.makeDirectoryExclusive(next, 0o700);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: 'provisioning',
        operation: 'create-directory-exclusive',
        object: 'parent',
      });
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
    }
    await ports.fsyncDirectory(parent);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'provisioning',
      operation: 'fsync-directory',
      object: 'parent',
    });
    const observed = await ports.observe(join(next, '__skillsmith-child-probe__'));
    if (observed.parent.state !== 'present') {
      throw artifactMutationError('invalid-file-kind', { path: next });
    }
    parent = next;
    identity = observed.parent.identity;
  }
};

const recordFor = (
  pair: { readonly manifest: string; readonly lock: string | null },
  members: readonly string[],
  roles: readonly DesiredRole[],
  transactionId: string,
  ownership: ReadonlyMap<string, string>,
  parents: ReadonlyMap<string, string>,
): ArtifactPairRecoveryRecord => {
  const directoryByParent = new Map<string, ArtifactRecoveryDirectory>();
  for (const role of roles.filter((entry) => entry.changed)) {
    const parent = dirname(role.path);
    if (!directoryByParent.has(parent)) {
      directoryByParent.set(
        parent,
        Object.freeze({
          purpose: 'transaction',
          path: join(parent, `.skillsmith-artifact-${transactionId}`),
          before: 'absent',
          ownershipToken: ownership.get(parent) as string,
          identity: null,
        }),
      );
    }
  }
  const directories = Object.freeze(
    [...directoryByParent.values()].sort((left, right) => compareUtf8(left.path, right.path)),
  );
  const objects: ArtifactRecoveryObject[] = [];
  for (const role of roles.filter((entry) => entry.changed)) {
    if (role.before.state === 'file' && !role.opaqueManifestBackup) {
      validateCandidateBytes(role.before.bytes, role.role);
    }
    const directory = directoryByParent.get(dirname(role.path)) as ArtifactRecoveryDirectory;
    if (role.afterBytes !== null) {
      objects.push(
        Object.freeze({
          role: role.role,
          slot: 'stage',
          path: join(directory.path, `${role.role}.stage`),
          expectedDigest: hashBytes(role.afterBytes, role.digestKind),
          expectedMode: role.afterMode as number,
          identity: null,
        }),
      );
    }
    if (role.before.state === 'file') {
      objects.push(
        Object.freeze({
          role: role.role,
          slot: 'backup',
          path: join(directory.path, `${role.role}.backup`),
          expectedDigest: role.before.digest,
          expectedMode: role.before.mode,
          identity: role.before.identity,
        }),
      );
    }
  }
  const manifestRole = roles.find((entry) => entry.role === 'manifest') as DesiredRole;
  const lockRole =
    pair.lock === null ? null : (roles.find((entry) => entry.role === 'lock') as DesiredRole);
  return Object.freeze({
    kind: 'skillsmith-artifact-pair-recovery',
    version: 1,
    key: artifactRecoveryKey(pair.manifest, pair.lock),
    transactionId,
    attempt: 1,
    disposition: 'forward',
    pair: Object.freeze(pair),
    memberTargets: members,
    cursor: 'prepared',
    parents: Object.freeze({
      manifest: Object.freeze({
        path: dirname(manifestRole.path),
        identity: parents.get(dirname(manifestRole.path)) as string,
      }),
      lock:
        lockRole === null
          ? null
          : Object.freeze({
              path: dirname(lockRole.path),
              identity: parents.get(dirname(lockRole.path)) as string,
            }),
    }),
    before: Object.freeze({
      manifest: revisionToBefore(manifestRole.before),
      lock: lockRole === null ? null : revisionToBefore(lockRole.before),
    }),
    after: Object.freeze({
      manifest: desiredAfter(manifestRole),
      lock: lockRole === null ? null : desiredAfter(lockRole),
    }),
    rollbackTarget: Object.freeze({
      manifest: revisionToBefore(manifestRole.before),
      lock: lockRole === null ? null : revisionToBefore(lockRole.before),
    }),
    directories,
    objects: Object.freeze(objects),
    collisionPaths: Object.freeze([]),
  });
};

const withRecord = (
  record: ArtifactPairRecoveryRecord,
  changes: Partial<ArtifactPairRecoveryRecord>,
): ArtifactPairRecoveryRecord => Object.freeze({ ...record, ...changes });

const replaceRecord = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  record: ArtifactPairRecoveryRecord,
  barrier: BarrierEmitter,
): Promise<ArtifactRecoveryEnvelope> => {
  const next = await ports.recovery.replace(record, envelope.revision);
  barrier.revision = next.revision;
  await barrier.emit({
    kind: 'mutation-returned',
    cursor: record.cursor,
    operation: 'replace-recovery-record',
    object: 'recovery-record',
  });
  await barrier.emit({ kind: 'record-durable', cursor: record.cursor });
  return next;
};

const exactObject = async (
  ports: ArtifactCoordinatorPorts,
  object: ArtifactRecoveryObject,
  digestKind: 'manifest' | 'lock' | 'resource' = object.role === 'manifest' ? 'manifest' : 'lock',
  allowOpaqueLock = false,
): Promise<Extract<ArtifactFileRevision, { readonly state: 'file' }>> => {
  const revision = await observeRecoveryFile(ports, object.path, digestKind, allowOpaqueLock);
  throwIfPermissionError(revision, object.role, object.path);
  if (
    'code' in revision ||
    revision.state !== 'file' ||
    revision.digest !== object.expectedDigest ||
    revision.mode !== object.expectedMode ||
    (object.identity !== null && revision.identity !== object.identity)
  ) {
    throw artifactMutationError('recovery-conflict', { path: object.path });
  }
  return revision;
};

const observeRecoveryFile = async (
  ports: ArtifactCoordinatorPorts,
  path: string,
  digestKind: 'manifest' | 'lock' | 'resource',
  allowOpaqueLock: boolean,
): Promise<ArtifactFileRevision | ArtifactMutationError> => {
  const revision = await observeArtifactFile(
    ports,
    path,
    allowOpaqueLock && digestKind === 'lock' ? 'resource' : digestKind,
  );
  if (
    'code' in revision ||
    revision.state !== 'file' ||
    !allowOpaqueLock ||
    digestKind !== 'lock'
  ) {
    return revision;
  }
  return Object.freeze({
    ...revision,
    digest: hashBytes(revision.bytes, 'lock'),
  });
};

const removeOwnedDirectoriesForCollision = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  barrier: BarrierEmitter,
): Promise<void> => {
  for (const directory of envelope.record.directories.filter((entry) => entry.identity !== null)) {
    const directoryObservation = await ports.observe(directory.path);
    const ownerPath = join(directory.path, 'owner');
    const ownerBefore = await ports.observe(ownerPath);
    if (
      directoryObservation.kind !== 'directory' ||
      directoryObservation.identity !== directory.identity ||
      ownerBefore.kind !== 'file' ||
      ownerBefore.linkCount !== 1 ||
      ownerBefore.parent.state !== 'present' ||
      ownerBefore.parent.identity !== directory.identity
    ) {
      throw artifactMutationError('recovery-conflict', { path: directory.path });
    }
    let ownerToken: string;
    try {
      ownerToken = decoder.decode(await ports.readBytes(ownerPath));
    } catch (error) {
      if (nodeCode(error) === 'EACCES' || nodeCode(error) === 'EPERM') throw error;
      throw artifactMutationError('recovery-conflict', { path: directory.path });
    }
    if (ownerToken !== `${directory.ownershipToken}\n`) {
      throw artifactMutationError('recovery-conflict', { path: directory.path });
    }
    for (const object of envelope.record.objects.filter(
      (entry) => dirname(entry.path) === directory.path,
    )) {
      if ((await ports.observe(object.path)).kind !== 'absent') {
        throw artifactMutationError('recovery-conflict', { path: object.path });
      }
    }
    const ownerAfter = await ports.observe(ownerPath);
    if (
      ownerAfter.kind !== 'file' ||
      ownerAfter.identity !== ownerBefore.identity ||
      ownerAfter.linkCount !== 1 ||
      ownerAfter.parent.state !== 'present' ||
      ownerAfter.parent.identity !== directory.identity
    ) {
      throw artifactMutationError('recovery-conflict', { path: directory.path });
    }
    await ports.removeFile(ownerPath);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'prepared',
      operation: 'remove-file',
      object: 'transaction',
    });
    await ports.fsyncDirectory(directory.path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'prepared',
      operation: 'fsync-directory',
      object: 'transaction',
    });
    await ports.removeEmptyDirectory(directory.path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'prepared',
      operation: 'remove-directory',
      object: 'transaction',
    });
    await ports.fsyncDirectory(dirname(directory.path));
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'prepared',
      operation: 'fsync-directory',
      object: 'transaction',
    });
  }
};

const advancePreparedCollision = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  collision: string,
  barrier: BarrierEmitter,
  usedIds: Set<string>,
): Promise<ArtifactRecoveryEnvelope> => {
  if (envelope.record.attempt === 8) {
    await ports.recovery.remove(envelope.record.key, envelope.revision);
    barrier.revision = null;
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'prepared',
      operation: 'remove-file',
      object: 'recovery-record',
    });
    await barrier.emit({ kind: 'record-removed' });
    throw artifactMutationError('stage-collision', { role: 'staging', path: collision });
  }
  const nextTransactionId = allocateId(ports, 'artifact-transaction', usedIds);
  const directories = envelope.record.directories.map((directory) =>
    Object.freeze({
      ...directory,
      path: join(dirname(directory.path), `.skillsmith-artifact-${nextTransactionId}`),
      ownershipToken: allocateId(ports, 'artifact-ownership', usedIds),
      identity: null,
    }),
  );
  const directoryByParent = new Map(
    directories.map((directory) => [dirname(directory.path), directory.path]),
  );
  const objects = envelope.record.objects.map((object) =>
    Object.freeze({
      ...object,
      path: join(
        directoryByParent.get(dirname(dirname(object.path))) as string,
        `${object.role}.${object.slot}`,
      ),
      identity: object.slot === 'stage' ? null : object.identity,
    }),
  );
  return replaceRecord(
    ports,
    envelope,
    withRecord(envelope.record, {
      transactionId: nextTransactionId,
      attempt: (envelope.record.attempt + 1) as ArtifactPairRecoveryRecord['attempt'],
      directories: Object.freeze(directories),
      objects: Object.freeze(objects),
      collisionPaths: Object.freeze([...envelope.record.collisionPaths, collision]),
    }),
    barrier,
  );
};

const createOwnedDirectories = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  barrier: BarrierEmitter,
  usedIds: Set<string>,
): Promise<ArtifactRecoveryEnvelope> => {
  let current = envelope;
  while (true) {
    let collision: string | null = null;
    for (let index = 0; index < current.record.directories.length; index += 1) {
      const directory = current.record.directories[index] as ArtifactRecoveryDirectory;
      if (directory.identity !== null) continue;
      try {
        const created = await ports.createTransactionDirectoryExclusive(
          directory.path,
          directory.ownershipToken,
        );
        await barrier.emit({
          kind: 'mutation-returned',
          cursor: 'prepared',
          operation: 'create-transaction-directory',
          object: 'transaction',
        });
        const directories = current.record.directories.map((entry, currentIndex) =>
          currentIndex === index ? Object.freeze({ ...entry, identity: created.identity }) : entry,
        );
        current = await replaceRecord(
          ports,
          current,
          withRecord(current.record, { directories: Object.freeze(directories) }),
          barrier,
        );
        await barrier.emit({ kind: 'object-verified', cursor: 'prepared', object: 'transaction' });
      } catch (error) {
        if (nodeCode(error) !== 'EEXIST') throw error;
        collision = directory.path;
        break;
      }
    }
    if (collision === null) break;
    await removeOwnedDirectoriesForCollision(ports, current, barrier);
    current = await advancePreparedCollision(ports, current, collision, barrier, usedIds);
  }
  return replaceRecord(ports, current, withRecord(current.record, { cursor: 'staging' }), barrier);
};

const stageRoles = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  roles: readonly DesiredRole[],
  barrier: BarrierEmitter,
): Promise<ArtifactRecoveryEnvelope> => {
  let current = envelope;
  for (const role of roles.filter((entry) => entry.changed && entry.afterBytes !== null)) {
    const index = current.record.objects.findIndex(
      (entry) => entry.role === role.role && entry.slot === 'stage',
    );
    const object = current.record.objects[index] as ArtifactRecoveryObject;
    await ports.writeBytesExclusive(
      object.path,
      role.afterBytes as Uint8Array,
      object.expectedMode,
    );
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'staging',
      operation: 'create-file-exclusive',
      role: role.role,
      object: 'stage',
    });
    await ports.setFileMode(object.path, object.expectedMode);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'staging',
      operation: 'set-file-mode',
      role: role.role,
      object: 'stage',
    });
    await ports.fsyncFile(object.path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'staging',
      operation: 'fsync-file',
      role: role.role,
      object: 'stage',
    });
    const revision = await exactObject(ports, object, role.digestKind);
    const objects = current.record.objects.map((entry, currentIndex) =>
      currentIndex === index ? Object.freeze({ ...entry, identity: revision.identity }) : entry,
    );
    const after = {
      ...current.record.after,
      [role.role]: Object.freeze({
        ...(current.record.after[role.role] as Exclude<
          ArtifactRecordedAfterState,
          { state: 'absent' }
        >),
        identity: revision.identity,
      }),
    };
    current = await replaceRecord(
      ports,
      current,
      withRecord(current.record, {
        objects: Object.freeze(objects),
        after: Object.freeze(after),
      }),
      barrier,
    );
    await barrier.emit({
      kind: 'object-verified',
      cursor: 'staging',
      role: role.role,
      object: 'stage',
    });
  }
  return replaceRecord(
    ports,
    current,
    withRecord(current.record, { cursor: 'final-guard' }),
    barrier,
  );
};

const reobserveRoles = async (
  ports: ArtifactCoordinatorPorts,
  roles: readonly DesiredRole[],
  phase: 'before' | 'after',
): Promise<readonly ArtifactFileRevision[]> => {
  const revisions: ArtifactFileRevision[] = [];
  for (const role of roles) {
    const revision =
      phase === 'before' && role.opaqueBefore
        ? await observeOpaqueLockFile(ports, role.path)
        : await observeArtifactFile(ports, role.path, role.digestKind);
    if ('code' in revision) throw revision;
    revisions.push(revision);
  }
  return Object.freeze(revisions);
};

const installRole = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  role: DesiredRole,
  barrier: BarrierEmitter,
): Promise<ArtifactRecoveryEnvelope> => {
  let current = envelope;
  const backupCursor = role.role === 'lock' ? 'lock-backup' : 'manifest-backup';
  const installCursor = role.role === 'lock' ? 'lock-install' : 'manifest-install';
  current = await replaceRecord(
    ports,
    current,
    withRecord(current.record, { cursor: backupCursor }),
    barrier,
  );
  if (role.before.state === 'file') {
    const backup = current.record.objects.find(
      (entry) => entry.role === role.role && entry.slot === 'backup',
    ) as ArtifactRecoveryObject;
    if ((await ports.observe(backup.path)).kind !== 'absent') {
      throw artifactMutationError('recovery-conflict', { path: backup.path });
    }
    await ports.moveIntoOwnedTransaction(role.path, backup.path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: backupCursor,
      operation: 'move-into-owned-transaction',
      role: role.role,
      object: 'backup',
    });
    await ports.fsyncDirectory(dirname(backup.path));
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: backupCursor,
      operation: 'fsync-directory',
      role: role.role,
      object: 'backup',
    });
    await ports.fsyncDirectory(dirname(role.path));
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: backupCursor,
      operation: 'fsync-directory',
      role: role.role,
      object: 'live',
    });
    const moved = await observeRecoveryFile(
      ports,
      backup.path,
      role.digestKind,
      role.role === 'lock',
    );
    throwIfPermissionError(moved, role.role, backup.path);
    if ('code' in moved || moved.state !== 'file') {
      throw artifactMutationError('recovery-conflict', { path: backup.path });
    }
    if (!matchesRecorded(moved, revisionToBefore(role.before))) {
      const objects = current.record.objects.map((entry) =>
        entry === backup
          ? Object.freeze({
              ...entry,
              expectedDigest: moved.digest,
              expectedMode: moved.mode,
              identity: moved.identity,
            })
          : entry,
      );
      const rollbackTarget = Object.freeze({
        ...current.record.rollbackTarget,
        [role.role]: revisionToBefore(moved),
      });
      current = await replaceRecord(
        ports,
        current,
        withRecord(current.record, {
          disposition: 'rollback',
          cursor: 'rollback-manifest-remove',
          rollbackTarget,
          objects: Object.freeze(objects),
        }),
        barrier,
      );
      throw artifactMutationError('external-writer-conflict', { path: role.path });
    }
    await barrier.emit({
      kind: 'object-verified',
      cursor: backupCursor,
      role: role.role,
      object: 'backup',
    });
  }
  current = await replaceRecord(
    ports,
    current,
    withRecord(current.record, { cursor: installCursor }),
    barrier,
  );
  if (role.afterBytes !== null) {
    const stage = current.record.objects.find(
      (entry) => entry.role === role.role && entry.slot === 'stage',
    ) as ArtifactRecoveryObject;
    try {
      await ports.linkFileNoReplace(stage.path, role.path);
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
      const displaced = await observeArtifactFile(ports, role.path, role.digestKind);
      throwIfPermissionError(displaced, role.role, role.path);
      if ('code' in displaced || displaced.state !== 'file') {
        throw artifactMutationError('external-writer-conflict', { path: role.path });
      }
      throw artifactMutationError('external-writer-conflict', { path: role.path });
    }
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: installCursor,
      operation: 'link-file-no-replace',
      role: role.role,
      object: 'live',
    });
    await ports.removeFile(stage.path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: installCursor,
      operation: 'remove-file',
      role: role.role,
      object: 'stage',
    });
    await ports.fsyncDirectory(dirname(stage.path));
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: installCursor,
      operation: 'fsync-directory',
      role: role.role,
      object: 'stage',
    });
    await ports.fsyncDirectory(dirname(role.path));
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: installCursor,
      operation: 'fsync-directory',
      role: role.role,
      object: 'live',
    });
  }
  const revision = await observeArtifactFile(ports, role.path, role.digestKind);
  const expected = current.record.after[role.role];
  throwIfPermissionError(revision, role.role, role.path);
  if ('code' in revision || !matchesRecorded(revision, expected)) {
    throw artifactMutationError('external-writer-conflict', { path: role.path });
  }
  await barrier.emit({
    kind: 'object-verified',
    cursor: installCursor,
    role: role.role,
    object: 'live',
  });
  return current;
};

const matchesRecorded = (
  revision: ArtifactFileRevision,
  expected: ArtifactRecordedBeforeState | ArtifactRecordedAfterState | null,
): boolean => {
  if (expected === null) return false;
  if (expected.state === 'absent') return revision.state === 'absent';
  return (
    revision.state === 'file' &&
    revision.digest === expected.digest &&
    revision.mode === expected.mode &&
    (expected.identity === null || revision.identity === expected.identity)
  );
};

const verifyRecordTargets = async (
  ports: ArtifactCoordinatorPorts,
  record: ArtifactPairRecoveryRecord,
): Promise<void> => {
  const expected = record.disposition === 'forward' ? record.after : record.rollbackTarget;
  for (const role of ['manifest', 'lock'] as const) {
    const path = record.pair[role];
    const target = expected[role];
    const parent = record.parents[role];
    if (path === null || target === null || parent === null) continue;
    const digestKind =
      record.pair.lock === null && role === 'manifest'
        ? 'resource'
        : role === 'manifest'
          ? 'manifest'
          : 'lock';
    const revision = await observeRecoveryFile(
      ports,
      path,
      digestKind,
      record.disposition === 'rollback' && role === 'lock',
    );
    throwIfPermissionError(revision, role, path);
    if (
      'code' in revision ||
      revision.parent.state !== 'present' ||
      revision.parent.path !== parent.path ||
      revision.parent.identity !== parent.identity ||
      !matchesRecorded(revision, target)
    ) {
      throw artifactMutationError('recovery-conflict', { path });
    }
  }
};

const cleanupRecord = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  barrier: BarrierEmitter,
  afterBarrier?: () => void,
): Promise<void> => {
  let current = envelope;
  if (current.record.cursor !== 'cleanup') {
    current = await replaceRecord(
      ports,
      current,
      withRecord(current.record, { cursor: 'cleanup' }),
      barrier,
    );
    afterBarrier?.();
  }
  await verifyRecordTargets(ports, current.record);
  for (const directory of [...current.record.directories].sort((left, right) =>
    compareUtf8(left.path, right.path),
  )) {
    const directoryObservation = await ports.observe(directory.path);
    if (directoryObservation.kind === 'absent') {
      for (const object of current.record.objects.filter(
        (entry) => dirname(entry.path) === directory.path,
      )) {
        if ((await ports.observe(object.path)).kind !== 'absent') {
          throw artifactMutationError('recovery-conflict', { path: object.path });
        }
      }
      continue;
    }
    if (
      directoryObservation.kind !== 'directory' ||
      directoryObservation.identity !== directory.identity
    ) {
      throw artifactMutationError('recovery-conflict', { path: directory.path });
    }
    const observed = await ports.observe(join(directory.path, '__skillsmith-cleanup-probe__'));
    if (observed.parent.state !== 'present' || observed.parent.identity !== directory.identity) {
      throw artifactMutationError('recovery-conflict', { path: directory.path });
    }
    for (const object of current.record.objects.filter(
      (entry) => dirname(entry.path) === directory.path,
    )) {
      await verifyRecordTargets(ports, current.record);
      const value = await ports.observe(object.path);
      if (value.kind === 'absent') continue;
      await exactObject(
        ports,
        object,
        current.record.pair.lock === null && object.role === 'manifest'
          ? 'resource'
          : object.role === 'manifest'
            ? 'manifest'
            : 'lock',
        object.role === 'lock',
      );
      await ports.removeFile(object.path);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: 'cleanup',
        operation: 'remove-file',
        role: object.role,
        object: object.slot,
      });
      afterBarrier?.();
    }
    await verifyRecordTargets(ports, current.record);
    const ownerPath = join(directory.path, 'owner');
    const owner = await ports.observe(ownerPath);
    if (owner.kind !== 'absent') {
      if (
        owner.kind !== 'file' ||
        owner.linkCount !== 1 ||
        owner.parent.state !== 'present' ||
        owner.parent.identity !== directory.identity ||
        decoder.decode(await ports.readBytes(ownerPath)) !== `${directory.ownershipToken}\n`
      ) {
        throw artifactMutationError('recovery-conflict', { path: directory.path });
      }
      await ports.removeFile(ownerPath);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: 'cleanup',
        operation: 'remove-file',
        object: 'transaction',
      });
      afterBarrier?.();
      await ports.fsyncDirectory(directory.path);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: 'cleanup',
        operation: 'fsync-directory',
        object: 'transaction',
      });
      afterBarrier?.();
    }
    await verifyRecordTargets(ports, current.record);
    await ports.removeEmptyDirectory(directory.path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'cleanup',
      operation: 'remove-directory',
      object: 'transaction',
    });
    afterBarrier?.();
    await ports.fsyncDirectory(dirname(directory.path));
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'cleanup',
      operation: 'fsync-directory',
      object: 'transaction',
    });
    afterBarrier?.();
  }
  await verifyRecordTargets(ports, current.record);
  await ports.recovery.remove(current.record.key, current.revision);
  barrier.revision = null;
  await barrier.emit({
    kind: 'mutation-returned',
    cursor: 'cleanup',
    operation: 'remove-file',
    object: 'recovery-record',
  });
  afterBarrier?.();
  await barrier.emit({ kind: 'record-removed' });
  afterBarrier?.();
};

const adoptOwnedDirectories = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  barrier: BarrierEmitter,
): Promise<ArtifactRecoveryEnvelope> => {
  let current = envelope;
  const usedIds = new Set<string>([
    `artifact-transaction:${current.record.transactionId}`,
    ...current.record.directories.map(
      (directory) => `artifact-ownership:${directory.ownershipToken}`,
    ),
  ]);
  while (true) {
    if (current.record.directories.every((directory) => directory.identity !== null))
      return current;
    if (current.record.cursor !== 'prepared') {
      throw artifactMutationError('recovery-conflict', { role: 'recovery' });
    }
    let collision: string | null = null;
    for (let index = 0; index < current.record.directories.length; index += 1) {
      const directory = current.record.directories[index] as ArtifactRecoveryDirectory;
      if (directory.identity !== null) continue;
      const directoryObservation = await ports.observe(directory.path);
      if (directoryObservation.kind === 'absent') {
        for (const object of current.record.objects.filter(
          (entry) => dirname(entry.path) === directory.path,
        )) {
          if ((await ports.observe(object.path)).kind !== 'absent') {
            throw artifactMutationError('recovery-conflict', { path: object.path });
          }
        }
        continue;
      }
      const child = await ports.observe(join(directory.path, '__skillsmith-adoption-probe__'));
      const ownerPath = join(directory.path, 'owner');
      const ownerBefore = await ports.observe(ownerPath);
      if (
        directoryObservation.kind !== 'directory' ||
        child.parent.state !== 'present' ||
        child.parent.identity !== directoryObservation.identity ||
        ownerBefore.kind !== 'file' ||
        ownerBefore.linkCount !== 1 ||
        ownerBefore.parent.state !== 'present' ||
        ownerBefore.parent.identity !== child.parent.identity
      ) {
        collision = directory.path;
        break;
      }
      let markerMatches = false;
      try {
        markerMatches =
          decoder.decode(await ports.readBytes(ownerPath)) === `${directory.ownershipToken}\n`;
      } catch (error) {
        if (nodeCode(error) === 'EACCES' || nodeCode(error) === 'EPERM') throw error;
      }
      if (!markerMatches) {
        collision = directory.path;
        break;
      }
      const directoryIdentity = child.parent.identity;
      const ownerAfter = await ports.observe(ownerPath);
      if (
        ownerAfter.kind !== 'file' ||
        ownerAfter.identity !== ownerBefore.identity ||
        ownerAfter.linkCount !== 1 ||
        ownerAfter.parent.state !== 'present' ||
        ownerAfter.parent.identity !== directoryIdentity
      ) {
        collision = directory.path;
        break;
      }
      const directories = current.record.directories.map((entry, currentIndex) =>
        currentIndex === index ? Object.freeze({ ...entry, identity: directoryIdentity }) : entry,
      );
      current = await replaceRecord(
        ports,
        current,
        withRecord(current.record, { directories: Object.freeze(directories) }),
        barrier,
      );
      await barrier.emit({
        kind: 'object-verified',
        cursor: 'prepared',
        object: 'transaction',
      });
    }
    if (collision === null) return current;
    await removeOwnedDirectoriesForCollision(ports, current, barrier);
    current = await advancePreparedCollision(ports, current, collision, barrier, usedIds);
  }
};

const resumeRecord = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  barrier: BarrierEmitter,
): Promise<void> => {
  if (envelope.record.disposition !== 'forward') {
    throw artifactMutationError('recovery-conflict', { role: 'recovery' });
  }
  let current = envelope;
  const changed = (role: 'manifest' | 'lock'): boolean => {
    const before = current.record.before[role];
    const after = current.record.after[role];
    if (before === null || after === null) return false;
    if (before.state !== after.state) return true;
    return (
      before.state === 'file' &&
      after.state === 'file' &&
      (before.digest !== after.digest || before.mode !== after.mode)
    );
  };
  const digestKindFor = (role: 'manifest' | 'lock') =>
    current.record.pair.lock === null && role === 'manifest'
      ? ('resource' as const)
      : role === 'manifest'
        ? ('manifest' as const)
        : ('lock' as const);
  const observeRole = async (role: 'manifest' | 'lock') => {
    const path = current.record.pair[role];
    const parent = current.record.parents[role];
    if (path === null || parent === null) return null;
    const revision = await observeArtifactFile(ports, path, digestKindFor(role));
    throwIfPermissionError(revision, role, path);
    if (
      'code' in revision ||
      revision.parent.state !== 'present' ||
      revision.parent.path !== parent.path ||
      revision.parent.identity !== parent.identity
    ) {
      throw artifactMutationError('recovery-conflict', { path });
    }
    return revision;
  };
  const advance = async (cursor: ArtifactPairRecoveryRecord['cursor']): Promise<void> => {
    current = await replaceRecord(ports, current, withRecord(current.record, { cursor }), barrier);
  };
  const nextAfterInstall = (role: 'manifest' | 'lock'): 'manifest-backup' | 'pair-verify' =>
    role === 'lock' && changed('manifest') ? 'manifest-backup' : 'pair-verify';
  const backupRole = async (role: 'manifest' | 'lock'): Promise<void> => {
    const path = current.record.pair[role];
    const before = current.record.before[role];
    if (path === null || before === null) return;
    const backup = current.record.objects.find(
      (object) => object.role === role && object.slot === 'backup',
    );
    if (before.state === 'absent') {
      const live = await observeRole(role);
      if (live?.state !== 'absent' || backup !== undefined) {
        throw artifactMutationError('external-writer-conflict', { path });
      }
      return;
    }
    if (backup === undefined) throw artifactMutationError('recovery-conflict', { path });
    const rawLive = await ports.observe(path);
    let backupObservation = await ports.observe(backup.path);
    if (
      rawLive.kind === 'file' &&
      backupObservation.kind === 'file' &&
      rawLive.identity === backupObservation.identity &&
      rawLive.linkCount === 2 &&
      backupObservation.linkCount === 2
    ) {
      await ports.removeFile(path);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'remove-file',
        role,
        object: 'live',
      });
      await ports.fsyncDirectory(dirname(path));
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'fsync-directory',
        role,
        object: 'live',
      });
      backupObservation = await ports.observe(backup.path);
    }
    const live = await observeRole(role);
    if (
      matchesRecorded(live as ArtifactFileRevision, before) &&
      backupObservation.kind === 'absent'
    ) {
      await ports.moveIntoOwnedTransaction(path, backup.path);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'move-into-owned-transaction',
        role,
        object: 'backup',
      });
      await ports.fsyncDirectory(dirname(backup.path));
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'fsync-directory',
        role,
        object: 'backup',
      });
      await ports.fsyncDirectory(dirname(path));
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'fsync-directory',
        role,
        object: 'live',
      });
    } else if (live?.state !== 'absent') {
      throw artifactMutationError('external-writer-conflict', { path });
    }
    const moved = await observeRecoveryFile(
      ports,
      backup.path,
      digestKindFor(role),
      role === 'lock',
    );
    throwIfPermissionError(moved, role, backup.path);
    if ('code' in moved || moved.state !== 'file') {
      throw artifactMutationError('recovery-conflict', { path: backup.path });
    }
    if (!matchesRecorded(moved, before)) {
      const capturedBackup = Object.freeze({
        ...backup,
        expectedDigest: moved.digest,
        expectedMode: moved.mode,
        identity: moved.identity,
      });
      const objects = current.record.objects.map((object) =>
        object === backup ? capturedBackup : object,
      );
      const rollbackTarget = Object.freeze({
        ...current.record.rollbackTarget,
        [role]: revisionToBefore(moved),
      });
      current = await replaceRecord(
        ports,
        current,
        withRecord(current.record, {
          disposition: 'rollback',
          cursor: 'rollback-manifest-remove',
          rollbackTarget,
          objects: Object.freeze(objects),
        }),
        barrier,
      );
      await rollbackRecord(ports, current, barrier);
      throw artifactMutationError('external-writer-conflict', { path });
    }
    await exactObject(ports, backup, digestKindFor(role), role === 'lock');
    await barrier.emit({
      kind: 'object-verified',
      cursor: current.record.cursor,
      role,
      object: 'backup',
    });
  };
  const installRecordedRole = async (role: 'manifest' | 'lock'): Promise<void> => {
    const path = current.record.pair[role];
    const after = current.record.after[role];
    if (path === null || after === null) return;
    const stage = current.record.objects.find(
      (object) => object.role === role && object.slot === 'stage',
    );
    if (after.state === 'absent') {
      const live = await observeRole(role);
      if (live?.state !== 'absent' || stage !== undefined) {
        throw artifactMutationError('recovery-conflict', { path });
      }
      return;
    }
    if (stage === undefined) throw artifactMutationError('recovery-conflict', { path });
    let rawStage = await ports.observe(stage.path);
    let rawLive = await ports.observe(path);
    if (rawStage.kind === 'file' && rawLive.kind === 'absent') {
      await exactObject(ports, stage, digestKindFor(role));
      await ports.linkFileNoReplace(stage.path, path);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'link-file-no-replace',
        role,
        object: 'live',
      });
      rawStage = await ports.observe(stage.path);
      rawLive = await ports.observe(path);
    }
    if (
      rawStage.kind === 'file' &&
      rawLive.kind === 'file' &&
      rawStage.identity === rawLive.identity &&
      rawStage.linkCount === 2 &&
      rawLive.linkCount === 2
    ) {
      await ports.removeFile(stage.path);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'remove-file',
        role,
        object: 'stage',
      });
      await ports.fsyncDirectory(dirname(stage.path));
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'fsync-directory',
        role,
        object: 'stage',
      });
      await ports.fsyncDirectory(dirname(path));
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'fsync-directory',
        role,
        object: 'live',
      });
    } else if (!(rawStage.kind === 'absent' && rawLive.kind === 'file')) {
      throw artifactMutationError('recovery-conflict', { path });
    }
    const live = await observeRole(role);
    if (live === null || !matchesRecorded(live, after)) {
      throw artifactMutationError('recovery-conflict', { path });
    }
  };

  while (true) {
    switch (current.record.cursor) {
      case 'prepared':
        throw artifactMutationError('recovery-conflict', { role: 'recovery' });
      case 'staging': {
        for (let index = 0; index < current.record.objects.length; index += 1) {
          const object = current.record.objects[index] as ArtifactRecoveryObject;
          if (object.slot !== 'stage') continue;
          let revision = await observeArtifactFile(ports, object.path, digestKindFor(object.role));
          throwIfPermissionError(revision, object.role, object.path);
          const directory = current.record.directories.find(
            (entry) => entry.path === dirname(object.path),
          );
          if (
            'code' in revision ||
            revision.state !== 'file' ||
            directory?.identity === null ||
            directory === undefined ||
            revision.parent.state !== 'present' ||
            revision.parent.identity !== directory.identity ||
            revision.digest !== object.expectedDigest ||
            (object.identity !== null &&
              (revision.identity !== object.identity || revision.mode !== object.expectedMode))
          ) {
            throw artifactMutationError('recovery-conflict', { path: object.path });
          }
          if (object.identity === null && revision.mode !== object.expectedMode) {
            await ports.setFileMode(object.path, object.expectedMode);
            await barrier.emit({
              kind: 'mutation-returned',
              cursor: 'staging',
              operation: 'set-file-mode',
              role: object.role,
              object: 'stage',
            });
            await ports.fsyncFile(object.path);
            await barrier.emit({
              kind: 'mutation-returned',
              cursor: 'staging',
              operation: 'fsync-file',
              role: object.role,
              object: 'stage',
            });
            revision = await exactObject(ports, object, digestKindFor(object.role));
          }
          if (object.identity === null) {
            const objects = current.record.objects.map((entry, currentIndex) =>
              currentIndex === index
                ? Object.freeze({ ...entry, identity: revision.identity })
                : entry,
            );
            const after = Object.freeze({
              ...current.record.after,
              [object.role]: Object.freeze({
                ...(current.record.after[object.role] as Extract<
                  ArtifactRecordedAfterState,
                  { readonly state: 'file' }
                >),
                identity: revision.identity,
              }),
            });
            current = await replaceRecord(
              ports,
              current,
              withRecord(current.record, { objects: Object.freeze(objects), after }),
              barrier,
            );
          }
        }
        await advance('final-guard');
        break;
      }
      case 'final-guard':
        for (const role of ['manifest', 'lock'] as const) {
          const before = current.record.before[role];
          if (before === null) continue;
          const live = await observeRole(role);
          if (live === null || !matchesRecorded(live, before)) {
            throw artifactMutationError('external-writer-conflict', {
              path: current.record.pair[role] as string,
            });
          }
        }
        await advance(
          changed('lock') ? 'lock-backup' : changed('manifest') ? 'manifest-backup' : 'pair-verify',
        );
        break;
      case 'lock-backup':
        await backupRole('lock');
        await advance('lock-install');
        break;
      case 'lock-install':
        await installRecordedRole('lock');
        await advance(nextAfterInstall('lock'));
        break;
      case 'manifest-backup':
        await backupRole('manifest');
        await advance('manifest-install');
        break;
      case 'manifest-install':
        await installRecordedRole('manifest');
        await advance('pair-verify');
        break;
      case 'pair-verify':
        await verifyRecordTargets(ports, current.record);
        await advance('committed');
        break;
      case 'committed':
      case 'cleanup':
        await cleanupRecord(ports, current, barrier);
        return;
      default:
        throw artifactMutationError('recovery-conflict', { role: 'recovery' });
    }
  }
};

const removeProvenStagingPartialsForRollback = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  barrier: BarrierEmitter,
): Promise<void> => {
  if (envelope.record.disposition !== 'forward' || envelope.record.cursor !== 'staging') return;
  for (const object of envelope.record.objects) {
    if (object.slot !== 'stage' || object.identity !== null) continue;
    const directory = envelope.record.directories.find(
      (entry) => entry.path === dirname(object.path),
    );
    if (directory?.identity === null || directory === undefined) {
      throw artifactMutationError('recovery-conflict', { path: object.path });
    }
    const directoryObservation = await ports.observe(directory.path);
    const ownerPath = join(directory.path, 'owner');
    const owner = await ports.observe(ownerPath);
    if (
      directoryObservation.kind !== 'directory' ||
      directoryObservation.identity !== directory.identity ||
      owner.kind !== 'file' ||
      owner.linkCount !== 1 ||
      owner.parent.state !== 'present' ||
      owner.parent.identity !== directory.identity ||
      decoder.decode(await ports.readBytes(ownerPath)) !== `${directory.ownershipToken}\n`
    ) {
      throw artifactMutationError('recovery-conflict', { path: directory.path });
    }
    const observed = await ports.observe(object.path);
    if (observed.kind === 'absent') continue;
    if (
      observed.kind !== 'file' ||
      observed.linkCount !== 1 ||
      observed.parent.state !== 'present' ||
      observed.parent.identity !== directory.identity
    ) {
      throw artifactMutationError('recovery-conflict', { path: object.path });
    }
    await ports.removeFile(object.path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'staging',
      operation: 'remove-file',
      role: object.role,
      object: 'stage',
    });
    await ports.fsyncDirectory(directory.path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: 'staging',
      operation: 'fsync-directory',
      role: object.role,
      object: 'stage',
    });
  }
};

const rollbackRecord = async (
  ports: ArtifactCoordinatorPorts,
  envelope: ArtifactRecoveryEnvelope,
  barrier: BarrierEmitter,
): Promise<void> => {
  let current = await adoptOwnedDirectories(ports, envelope, barrier);
  let displacedWriterPath: string | null = null;
  await removeProvenStagingPartialsForRollback(ports, current, barrier);
  if (current.record.disposition === 'forward') {
    current = await replaceRecord(
      ports,
      current,
      withRecord(current.record, {
        disposition: 'rollback',
        cursor: 'rollback-manifest-remove',
      }),
      barrier,
    );
  }
  const digestKindFor = (role: 'manifest' | 'lock') =>
    current.record.pair.lock === null && role === 'manifest'
      ? ('resource' as const)
      : role === 'manifest'
        ? ('manifest' as const)
        : ('lock' as const);
  const assertParent = async (role: 'manifest' | 'lock'): Promise<void> => {
    const path = current.record.pair[role];
    const parent = current.record.parents[role];
    if (path === null || parent === null) return;
    const observed = await ports.observe(path);
    if (
      observed.parent.state !== 'present' ||
      observed.parent.path !== parent.path ||
      observed.parent.identity !== parent.identity
    ) {
      throw artifactMutationError('recovery-conflict', { path });
    }
  };
  const advance = async (cursor: ArtifactPairRecoveryRecord['cursor']): Promise<void> => {
    current = await replaceRecord(ports, current, withRecord(current.record, { cursor }), barrier);
  };
  const removeInstalled = async (role: 'manifest' | 'lock'): Promise<void> => {
    const path = current.record.pair[role];
    const target = current.record.rollbackTarget[role];
    const after = current.record.after[role];
    if (path === null || target === null || after === null) return;
    await assertParent(role);
    const rawLive = await ports.observe(path);
    const stage = current.record.objects.find(
      (object) => object.role === role && object.slot === 'stage',
    );
    if (
      rawLive.kind === 'file' &&
      rawLive.linkCount === 2 &&
      rawLive.identity !== null &&
      stage?.identity === rawLive.identity
    ) {
      const rawStage = await ports.observe(stage.path);
      if (
        rawStage.kind !== 'file' ||
        rawStage.identity !== rawLive.identity ||
        rawStage.linkCount !== 2
      )
        throw artifactMutationError('recovery-conflict', { path });
      await ports.removeFile(path);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'remove-file',
        role,
        object: 'live',
      });
      await ports.fsyncDirectory(dirname(path));
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'fsync-directory',
        role,
        object: 'live',
      });
      return;
    }
    const live = await observeRecoveryFile(ports, path, digestKindFor(role), role === 'lock');
    if ('code' in live) throw live;
    if (matchesRecorded(live, target)) return;
    if (live.state === 'absent') return;
    if (!matchesRecorded(live, after) || live.state !== 'file') {
      throw artifactMutationError('external-writer-conflict', { path });
    }
    const directory = current.record.directories.find(
      (entry) => dirname(path) === dirname(entry.path),
    );
    if (directory?.identity === null || directory === undefined) {
      throw artifactMutationError('recovery-conflict', { path });
    }
    let discard = current.record.objects.find(
      (object) => object.role === role && object.slot === 'discard',
    );
    if (discard === undefined) {
      discard = Object.freeze({
        role,
        slot: 'discard' as const,
        path: join(directory.path, `${role}.discard`),
        expectedDigest: live.digest,
        expectedMode: live.mode,
        identity: live.identity,
      });
      current = await replaceRecord(
        ports,
        current,
        withRecord(current.record, {
          objects: Object.freeze([...current.record.objects, discard]),
        }),
        barrier,
      );
    }
    const rawDiscard = await ports.observe(discard.path);
    let movedIntoDiscard = false;
    if (rawDiscard.kind === 'absent') {
      await ports.moveIntoOwnedTransaction(path, discard.path);
      movedIntoDiscard = true;
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'move-into-owned-transaction',
        role,
        object: 'discard',
      });
      await ports.fsyncDirectory(dirname(path));
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'fsync-directory',
        role,
        object: 'live',
      });
      await ports.fsyncDirectory(directory.path);
      await barrier.emit({
        kind: 'mutation-returned',
        cursor: current.record.cursor,
        operation: 'fsync-directory',
        role,
        object: 'discard',
      });
    } else if (rawLive.kind !== 'absent') {
      throw artifactMutationError('recovery-conflict', { path: discard.path });
    }
    if (movedIntoDiscard) {
      const moved = await observeRecoveryFile(
        ports,
        discard.path,
        digestKindFor(role),
        role === 'lock',
      );
      throwIfPermissionError(moved, role, discard.path);
      if ('code' in moved || moved.state !== 'file') {
        throw artifactMutationError('recovery-conflict', { path: discard.path });
      }
      if (!matchesRecorded(moved, revisionToBefore(live))) {
        const discardPath = discard.path;
        const captured = Object.freeze({
          ...discard,
          expectedDigest: moved.digest,
          expectedMode: moved.mode,
          identity: moved.identity,
        });
        const objects = current.record.objects.map((object) =>
          object.role === role && object.slot === 'discard' && object.path === discardPath
            ? captured
            : object,
        );
        const rollbackTarget = Object.freeze({
          ...current.record.rollbackTarget,
          [role]: revisionToBefore(moved),
        });
        current = await replaceRecord(
          ports,
          current,
          withRecord(current.record, {
            rollbackTarget,
            objects: Object.freeze(objects),
          }),
          barrier,
        );
        discard = captured;
        displacedWriterPath ??= path;
      }
    }
    await exactObject(ports, discard, digestKindFor(role), role === 'lock');
  };
  const restoreTarget = async (role: 'manifest' | 'lock'): Promise<void> => {
    const path = current.record.pair[role];
    const target = current.record.rollbackTarget[role];
    if (path === null || target === null) return;
    await assertParent(role);
    const rawLive = await ports.observe(path);
    if (
      target.state === 'file' &&
      rawLive.kind === 'file' &&
      rawLive.identity === target.identity
    ) {
      const source = current.record.objects.find(
        (object) =>
          object.role === role &&
          (object.slot === 'backup' || object.slot === 'discard') &&
          object.identity === target.identity,
      );
      if (rawLive.linkCount === 2 && source !== undefined) {
        const rawSource = await ports.observe(source.path);
        if (
          rawSource.kind !== 'file' ||
          rawSource.identity !== target.identity ||
          rawSource.linkCount !== 2
        )
          throw artifactMutationError('recovery-conflict', { path });
        await ports.removeFile(source.path);
        await barrier.emit({
          kind: 'mutation-returned',
          cursor: current.record.cursor,
          operation: 'remove-file',
          role,
          object: source.slot,
        });
        await ports.fsyncDirectory(dirname(source.path));
        await barrier.emit({
          kind: 'mutation-returned',
          cursor: current.record.cursor,
          operation: 'fsync-directory',
          role,
          object: source.slot,
        });
        await ports.fsyncDirectory(dirname(path));
        await barrier.emit({
          kind: 'mutation-returned',
          cursor: current.record.cursor,
          operation: 'fsync-directory',
          role,
          object: 'live',
        });
      }
    }
    const live = await observeRecoveryFile(ports, path, digestKindFor(role), role === 'lock');
    if ('code' in live) throw live;
    if (matchesRecorded(live, target)) return;
    if (live.state !== 'absent' || target.state !== 'file') {
      throw artifactMutationError('external-writer-conflict', { path });
    }
    const source = current.record.objects.find(
      (object) =>
        object.role === role &&
        (object.slot === 'backup' || object.slot === 'discard') &&
        object.expectedDigest === target.digest &&
        object.expectedMode === target.mode &&
        object.identity === target.identity,
    );
    if (source === undefined) throw artifactMutationError('recovery-conflict', { path });
    await exactObject(ports, source, digestKindFor(role), role === 'lock');
    await ports.linkFileNoReplace(source.path, path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: current.record.cursor,
      operation: 'link-file-no-replace',
      role,
      object: 'live',
    });
    await ports.removeFile(source.path);
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: current.record.cursor,
      operation: 'remove-file',
      role,
      object: source.slot,
    });
    await ports.fsyncDirectory(dirname(source.path));
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: current.record.cursor,
      operation: 'fsync-directory',
      role,
      object: source.slot,
    });
    await ports.fsyncDirectory(dirname(path));
    await barrier.emit({
      kind: 'mutation-returned',
      cursor: current.record.cursor,
      operation: 'fsync-directory',
      role,
      object: 'live',
    });
    const restored = await observeRecoveryFile(ports, path, digestKindFor(role), role === 'lock');
    throwIfPermissionError(restored, role, path);
    if ('code' in restored || !matchesRecorded(restored, target)) {
      throw artifactMutationError('recovery-conflict', { path });
    }
  };

  while (current.record.cursor !== 'cleanup') {
    switch (current.record.cursor) {
      case 'rollback-manifest-remove':
        await removeInstalled('manifest');
        await advance('rollback-manifest-restore');
        break;
      case 'rollback-manifest-restore':
        await restoreTarget('manifest');
        await advance('rollback-lock-remove');
        break;
      case 'rollback-lock-remove':
        await removeInstalled('lock');
        await advance('rollback-lock-restore');
        break;
      case 'rollback-lock-restore':
        await restoreTarget('lock');
        await advance('rollback-verify');
        break;
      case 'rollback-verify':
        await verifyRecordTargets(ports, current.record);
        await advance('cleanup');
        break;
      default:
        throw artifactMutationError('recovery-conflict', { role: 'recovery' });
    }
  }
  await cleanupRecord(ports, current, barrier);
  if (displacedWriterPath !== null) {
    throw artifactMutationError('external-writer-conflict', { path: displacedWriterPath });
  }
};

const recordsOverlap = (record: ArtifactPairRecoveryRecord, targets: readonly string[]): boolean =>
  record.memberTargets.some((target) => targets.includes(target));

const resolveOverlaps = async (
  ports: ArtifactCoordinatorPorts,
  targets: readonly string[],
  operationId: string,
  barrier: BarrierEmitter,
  signal?: AbortSignal,
): Promise<boolean> => {
  let recovered = false;
  while (true) {
    const discovered = await ports.recovery.discover();
    await barrier.emit({ kind: 'recovery-discovered' });
    const overlap = discovered.find((entry) => recordsOverlap(entry.record, targets));
    if (overlap === undefined) {
      if (signal?.aborted) throw cancellation('unobserved-before');
      return recovered;
    }
    recovered = true;
    await withMembersHeld(
      ports,
      overlap.record.memberTargets,
      operationId,
      undefined,
      barrier,
      async () => {
        barrier.revision = overlap.revision;
        if (
          overlap.record.cursor === 'committed' ||
          (overlap.record.cursor === 'cleanup' && overlap.record.disposition === 'forward')
        ) {
          await cleanupRecord(ports, overlap, barrier);
        } else {
          await rollbackRecord(ports, overlap, barrier);
        }
      },
    );
  }
};

const commitRoles = async (
  ports: ArtifactCoordinatorPorts,
  pair: { readonly manifest: string; readonly lock: string | null },
  members: readonly string[],
  roles: readonly DesiredRole[],
  barrier: BarrierEmitter,
  usedIds: Set<string>,
  observeAllParents: boolean,
  signal?: AbortSignal,
): Promise<PairRevisions> => {
  const changed = roles.filter((entry) => entry.changed);
  const transactionId = allocateId(ports, 'artifact-transaction', usedIds);
  const parentIdentities = new Map<string, string>();
  const ownership = new Map<string, string>();
  for (const role of observeAllParents ? roles : changed) {
    const observed = await ports.observe(role.path);
    if (observed.parent.state !== 'present')
      throw artifactMutationError('external-writer-conflict');
    parentIdentities.set(dirname(role.path), observed.parent.identity);
    if (role.changed && !ownership.has(dirname(role.path))) {
      ownership.set(dirname(role.path), allocateId(ports, 'artifact-ownership', usedIds));
    }
  }
  const record = recordFor(pair, members, roles, transactionId, ownership, parentIdentities);
  const manifestBefore = roles.find((entry) => entry.role === 'manifest')?.before;
  const lockBefore = roles.find((entry) => entry.role === 'lock')?.before;
  if (manifestBefore === undefined) throw artifactMutationError('filesystem-failure');
  const beforeRevisions: Partial<PairRevisions> = {
    manifest: manifestBefore,
    ...(pair.lock === null || lockBefore === undefined ? {} : { lock: lockBefore }),
  };
  let committedRevisions: Partial<PairRevisions> | null = null;
  let envelope = await ports.recovery.create(record);
  barrier.revision = envelope.revision;
  await barrier.emit({
    kind: 'mutation-returned',
    cursor: 'prepared',
    operation: 'create-file-exclusive',
    object: 'recovery-record',
  });
  await barrier.emit({ kind: 'record-durable', cursor: 'prepared' });
  if (signal?.aborted) {
    await rollbackRecord(ports, envelope, barrier);
    throw cancellation('before', beforeRevisions);
  }
  try {
    envelope = await createOwnedDirectories(ports, envelope, barrier, usedIds);
    if (signal?.aborted) throw cancellation('before', beforeRevisions);
    envelope = await stageRoles(ports, envelope, roles, barrier);
    if (signal?.aborted) throw cancellation('before', beforeRevisions);
    const guard = await reobserveRoles(ports, roles, 'before');
    if (
      guard.some(
        (revision, index) =>
          !sameArtifactRevision(revision, roles[index]?.before as ArtifactFileRevision),
      )
    ) {
      throw artifactMutationError('external-writer-conflict');
    }
    if (signal?.aborted) throw cancellation('before', beforeRevisions);
    for (const role of changed) {
      envelope = await installRole(ports, envelope, role, barrier);
      if (signal?.aborted) throw cancellation('before', beforeRevisions);
    }
    envelope = await replaceRecord(
      ports,
      envelope,
      withRecord(envelope.record, { cursor: 'pair-verify' }),
      barrier,
    );
    if (signal?.aborted) throw cancellation('before', beforeRevisions);
    const final = await reobserveRoles(ports, roles, 'after');
    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index] as DesiredRole;
      if (
        !matchesRecorded(final[index] as ArtifactFileRevision, envelope.record.after[role.role])
      ) {
        throw artifactMutationError('recovery-conflict');
      }
    }
    const finalManifest = final.find(
      (_entry, index) => roles[index]?.role === 'manifest',
    ) as ArtifactFileRevision;
    const finalLock = final.find((_entry, index) => roles[index]?.role === 'lock') as
      | ArtifactFileRevision
      | undefined;
    const afterRevisions: Partial<PairRevisions> = {
      manifest: finalManifest,
      ...(pair.lock === null || finalLock === undefined ? {} : { lock: finalLock }),
    };
    committedRevisions = afterRevisions;
    const cancelAfterBarrier = (): void => {
      if (signal?.aborted) throw cancellation('after', afterRevisions);
    };
    envelope = await replaceRecord(
      ports,
      envelope,
      withRecord(envelope.record, { cursor: 'committed' }),
      barrier,
    );
    if (signal?.aborted) {
      await cleanupRecord(ports, envelope, barrier);
      throw cancellation('after', afterRevisions);
    }
    await cleanupRecord(ports, envelope, barrier, cancelAfterBarrier);
    return {
      manifest: finalManifest,
      lock:
        pair.lock === null
          ? (Object.freeze({
              state: 'absent',
              parent: roles.find((entry) => entry.role === 'manifest')?.before.parent,
            }) as ArtifactFileRevision)
          : (finalLock as ArtifactFileRevision),
    };
  } catch (error) {
    try {
      const latest = (await ports.recovery.discover()).find(
        (entry) => entry.record.key === record.key,
      );
      if (
        latest !== undefined &&
        (latest.record.cursor === 'committed' ||
          (latest.record.cursor === 'cleanup' && latest.record.disposition === 'forward'))
      ) {
        barrier.revision = latest.revision;
        await cleanupRecord(ports, latest, barrier);
      } else if (latest !== undefined) {
        barrier.revision = latest.revision;
        await rollbackRecord(ports, latest, barrier);
      }
    } catch (recoveryError) {
      const recoveryPermission = asPermissionError(recoveryError, 'recovery');
      if (recoveryPermission !== null) throw recoveryPermission;
      const operationPermission = asPermissionError(error);
      if (operationPermission !== null) throw operationPermission;
      if (isArtifactMutationError(error) && error.reason === 'external-writer-conflict') {
        throw error;
      }
      if (
        isArtifactMutationError(recoveryError) &&
        recoveryError.reason === 'external-writer-conflict'
      ) {
        throw recoveryError;
      }
      throw artifactMutationError('recovery-conflict', { role: 'recovery' });
    }
    if (isArtifactMutationError(error) && error.reason === 'cancelled') {
      if (error.durableState === 'after') {
        if (committedRevisions === null) {
          throw artifactMutationError('recovery-conflict', { role: 'recovery' });
        }
        throw cancellation('after', committedRevisions);
      }
      throw cancellation('before', beforeRevisions);
    }
    throw error;
  }
};

const asResultError = (error: unknown): ArtifactMutationError => {
  if (isArtifactMutationError(error)) return error;
  if (nodeCode(error) === 'ABORT_ERR') return cancellation('unobserved-before');
  return nodeErrorToArtifactMutationError(error);
};

const commitArtifactPairWithinAuthority = async (
  ports: ArtifactCoordinatorPorts,
  request: ArtifactPairMutationRequest,
  paths: readonly string[],
  operationId: string,
  barrier: BarrierEmitter,
  usedIds: Set<string>,
  recovered: boolean,
  membersAlreadyHeld: boolean,
): Promise<Result<ArtifactPairMutationResult, ArtifactMutationError>> => {
  const allowOpaqueLock =
    request.lock.kind === 'replace-invalid' || request.lock.kind === 'replace-exact';
  const provisional = await observeArtifactPair(
    ports,
    request.pair.file.path,
    request.pair.lockfile.path,
    { allowOpaqueLock },
  );
  if ('code' in provisional) throw provisional;
  validateLockPrecondition(provisional, request, 'provisional');
  const provisionalRoles = makeDesiredRoles(request, provisional);
  if (membersAlreadyHeld && request.signal?.aborted) throw cancellation('unobserved-before');
  if (provisionalRoles.every((role) => !role.changed)) {
    return ok(
      Object.freeze({
        outcome: 'unchanged' as const,
        externalBytesReplayed: false,
        manifestRevision: copyArtifactFileRevision(provisional.manifest),
        lockRevision: copyArtifactFileRevision(provisional.lock),
      }),
    );
  }
  for (const role of provisionalRoles.filter((entry) => entry.changed)) {
    await provisionParent(ports, role.before, barrier);
  }
  if (request.signal?.aborted) throw cancellation('unobserved-before');

  const commitFresh = async (): Promise<
    Result<ArtifactPairMutationResult, ArtifactMutationError>
  > => {
    const fresh = await observeArtifactPair(
      ports,
      request.pair.file.path,
      request.pair.lockfile.path,
      { allowOpaqueLock },
    );
    if ('code' in fresh) {
      if (
        fresh.reason === 'invalid-lock' ||
        fresh.reason === 'artifact-alias' ||
        (fresh.reason === 'invalid-file-kind' && fresh.path === request.pair.lockfile.path)
      ) {
        throw artifactMutationError('external-writer-conflict', { role: 'lock' });
      }
      throw fresh;
    }
    validateLockPrecondition(fresh, request, 'fresh');
    const replay = classifyFreshSnapshot(provisional, fresh, provisionalRoles);
    if (replay.convergedToDesired) {
      return ok(
        Object.freeze({
          outcome: 'unchanged' as const,
          externalBytesReplayed: false,
          manifestRevision: copyArtifactFileRevision(fresh.manifest),
          lockRevision: copyArtifactFileRevision(fresh.lock),
        }),
      );
    }
    const roles = makeDesiredRoles(request, fresh);
    assertStableDesiredPlan(provisionalRoles, roles);
    if (roles.every((role) => !role.changed)) {
      return ok(
        Object.freeze({
          outcome: 'unchanged' as const,
          externalBytesReplayed: replay.replayedManifestBytes,
          manifestRevision: copyArtifactFileRevision(fresh.manifest),
          lockRevision: copyArtifactFileRevision(fresh.lock),
        }),
      );
    }
    if (request.signal?.aborted) throw cancellation('before', fresh);
    const final = await commitRoles(
      ports,
      { manifest: request.pair.file.path, lock: request.pair.lockfile.path },
      paths,
      roles,
      barrier,
      usedIds,
      membersAlreadyHeld,
      request.signal,
    );
    return ok(
      Object.freeze({
        outcome: recovered ? ('recovered-and-committed' as const) : ('committed' as const),
        externalBytesReplayed: replay.replayedManifestBytes,
        manifestRevision: copyArtifactFileRevision(final.manifest),
        lockRevision: copyArtifactFileRevision(final.lock),
      }),
    );
  };

  return membersAlreadyHeld
    ? commitFresh()
    : withMembersHeld(ports, paths, operationId, request.signal, barrier, commitFresh);
};

export const commitArtifactPair = async (
  ports: ArtifactCoordinatorPorts,
  request: ArtifactPairMutationRequest,
): Promise<Result<ArtifactPairMutationResult, ArtifactMutationError>> => {
  try {
    const paths = canonicalMembers([request.pair.file.path, request.pair.lockfile.path]);
    paths.forEach(validatePath);
    const usedIds = new Set<string>();
    return await withCentralHeld(ports, request.signal, async (operationId, barrier) => {
      const recovered = await resolveOverlaps(ports, paths, operationId, barrier, request.signal);
      return commitArtifactPairWithinAuthority(
        ports,
        request,
        paths,
        operationId,
        barrier,
        usedIds,
        recovered,
        false,
      );
    });
  } catch (error) {
    return err(asResultError(error));
  }
};

export const commitArtifactPairWithLease = async (
  lease: ArtifactGroupLockLease,
  request: ArtifactPairMutationRequest,
): Promise<Result<ArtifactPairMutationResult, ArtifactMutationError>> => {
  const state = artifactGroupLeaseStates.get(lease);
  if (
    state === undefined ||
    !state.active ||
    state.memberState !== 'held' ||
    state.commitActive ||
    state.inFlight !== null ||
    request.signal !== state.signal ||
    !sameArtifactPair(request.pair, state.pair)
  ) {
    return err(artifactMutationError('invalid-request'));
  }
  if (state.signal?.aborted) return err(cancellation('unobserved-before'));
  const paths = canonicalMembers([request.pair.file.path, request.pair.lockfile.path]);
  if (
    paths.length !== state.targets.length ||
    paths.some((path, index) => path !== state.targets[index])
  ) {
    return err(artifactMutationError('invalid-request'));
  }

  if (state.scaffold !== null) state.scaffold.consumed = true;
  state.commitActive = true;
  const execution = (async () => {
    try {
      const result = await commitArtifactPairWithinAuthority(
        state.ports,
        request,
        state.targets,
        state.operationId,
        state.barrier,
        state.usedIds,
        state.recoveredPending,
        true,
      );
      if (
        (result.ok && result.value.outcome !== 'unchanged') ||
        (!result.ok && result.error.durableState === 'after')
      ) {
        state.recoveredPending = false;
        if (state.scaffold !== null) state.scaffold.retain = true;
      }
      return result;
    } catch (error) {
      const mapped = asResultError(error);
      if (mapped.durableState === 'after') {
        state.recoveredPending = false;
        if (state.scaffold !== null) state.scaffold.retain = true;
      }
      return err(mapped);
    } finally {
      state.commitActive = false;
      state.inFlight = null;
    }
  })();
  state.inFlight = execution;
  return execution;
};

export const readCoordinatedArtifactPair = async (
  ports: ArtifactCoordinatorPorts,
  pair: ResolvedArtifactPair,
): Promise<Result<ArtifactPairSnapshot, ArtifactMutationError>> => {
  try {
    const paths = canonicalMembers([pair.file.path, pair.lockfile.path]);
    paths.forEach(validatePath);
    return await withCentralHeld(ports, undefined, async (operationId, barrier) => {
      await resolveOverlaps(ports, paths, operationId, barrier);
      return withMembersHeld(ports, paths, operationId, undefined, barrier, async () => {
        const snapshot = await observeArtifactPair(ports, pair.file.path, pair.lockfile.path);
        return 'code' in snapshot ? err(snapshot) : ok(snapshot);
      });
    });
  } catch (error) {
    return err(asResultError(error));
  }
};

export const recoverArtifactPair = async (
  ports: ArtifactCoordinatorPorts,
  pair: ResolvedArtifactPair,
  direction: 'resume' | 'rollback',
): Promise<Result<'clean' | 'rolled-back' | 'finalized', ArtifactMutationError>> => {
  try {
    const paths = canonicalMembers([pair.file.path, pair.lockfile.path]);
    paths.forEach(validatePath);
    return await withCentralHeld(ports, undefined, async (operationId, barrier) => {
      const records = await ports.recovery.discover();
      const overlap = records.find((entry) => recordsOverlap(entry.record, paths));
      if (overlap === undefined) return ok('clean' as const);
      return withMembersHeld(
        ports,
        overlap.record.memberTargets,
        operationId,
        undefined,
        barrier,
        async () => {
          barrier.revision = overlap.revision;
          if (direction === 'resume') {
            await resumeRecord(ports, overlap, barrier);
            return ok('finalized' as const);
          }
          if (
            overlap.record.cursor === 'committed' ||
            (overlap.record.cursor === 'cleanup' && overlap.record.disposition === 'forward')
          ) {
            await cleanupRecord(ports, overlap, barrier);
            return ok('finalized' as const);
          }
          await rollbackRecord(ports, overlap, barrier);
          return ok('rolled-back' as const);
        },
      );
    });
  } catch (error) {
    return err(asResultError(error));
  }
};

export const updateCoordinatedHumanFile = async (
  ports: ArtifactCoordinatorPorts,
  request: CoordinatedHumanFileRequest,
): Promise<Result<CoordinatedHumanFileResult, ArtifactMutationError>> => {
  try {
    validatePath(request.path);
    const opaqueAuthorization = request.opaqueManifestBackup;
    let opaqueDigest: ArtifactDigest | undefined;
    if (opaqueAuthorization !== undefined) {
      const prototype =
        typeof opaqueAuthorization === 'object' && opaqueAuthorization !== null
          ? Object.getPrototypeOf(opaqueAuthorization)
          : null;
      const descriptors: { readonly expectedResourceDigest?: PropertyDescriptor } =
        typeof opaqueAuthorization === 'object' && opaqueAuthorization !== null
          ? Object.getOwnPropertyDescriptors(opaqueAuthorization)
          : {};
      const digestDescriptor = descriptors.expectedResourceDigest;
      if (
        typeof opaqueAuthorization !== 'object' ||
        opaqueAuthorization === null ||
        utilTypes.isProxy(opaqueAuthorization) ||
        (prototype !== Object.prototype && prototype !== null) ||
        Reflect.ownKeys(opaqueAuthorization).length !== 1 ||
        digestDescriptor === undefined ||
        !('value' in digestDescriptor) ||
        typeof digestDescriptor.value !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(digestDescriptor.value)
      ) {
        throw artifactMutationError('invalid-request', { role: 'manifest' });
      }
      opaqueDigest = digestDescriptor.value as ArtifactDigest;
    }
    const usedIds = new Set<string>();
    return await withCentralHeld(ports, request.signal, async (operationId, barrier) => {
      await resolveOverlaps(ports, [request.path], operationId, barrier, request.signal);
      const provisional = await observeArtifactFile(ports, request.path, 'resource');
      if ('code' in provisional) throw provisional;
      let edited = request.edit(copyArtifactFileRevision(provisional));
      if (!edited.ok) return err(edited.error);
      const editedBytes = new Uint8Array(edited.value.bytes);
      if (
        !edited.value.changed ||
        (provisional.state === 'file' &&
          equalBytes(provisional.bytes, editedBytes) &&
          provisional.mode === edited.value.mode)
      ) {
        return ok(Object.freeze({ outcome: 'unchanged' as const, revision: provisional }));
      }
      await provisionParent(ports, provisional, barrier);
      return withMembersHeld(
        ports,
        [request.path],
        operationId,
        request.signal,
        barrier,
        async () => {
          const fresh = await observeArtifactFile(ports, request.path, 'resource');
          if ('code' in fresh) throw fresh;
          if (!sameArtifactRevision(provisional, fresh)) {
            edited = request.edit(copyArtifactFileRevision(fresh));
            if (!edited.ok) return err(edited.error);
          }
          if (!edited.ok) return err(edited.error);
          const finalEdit = edited.value;
          const bytes = new Uint8Array(finalEdit.bytes);
          validateCandidateBytes(bytes, 'manifest');
          if (
            !finalEdit.changed ||
            (fresh.state === 'file' &&
              equalBytes(fresh.bytes, bytes) &&
              fresh.mode === finalEdit.mode)
          ) {
            return ok(Object.freeze({ outcome: 'unchanged' as const, revision: fresh }));
          }
          if (
            opaqueDigest !== undefined &&
            (fresh.state !== 'file' || fresh.digest !== opaqueDigest)
          ) {
            return err(artifactMutationError('external-writer-conflict'));
          }
          const role: DesiredRole = Object.freeze({
            role: 'manifest',
            digestKind: 'resource',
            path: request.path,
            before: fresh,
            afterBytes: bytes,
            afterMode: finalEdit.mode,
            changed: true,
            opaqueBefore: false,
            opaqueManifestBackup: opaqueDigest !== undefined,
          });
          const final = await commitRoles(
            ports,
            { manifest: request.path, lock: null },
            Object.freeze([request.path]),
            Object.freeze([role]),
            barrier,
            usedIds,
            false,
            request.signal,
          );
          return ok(Object.freeze({ outcome: 'committed' as const, revision: final.manifest }));
        },
      );
    });
  } catch (error) {
    return err(asResultError(error));
  }
};
