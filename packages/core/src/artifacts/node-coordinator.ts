import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
// eslint-disable-next-line skillsmith/capability-ownership -- This focused adapter owns the account-helper fd write and private lock filesystem.
import * as nodeFs from 'node:fs';
// eslint-disable-next-line skillsmith/capability-ownership -- This file is the focused artifact runtime adapter.
import { chmod, link, lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
// eslint-disable-next-line skillsmith/capability-ownership -- Account identity is owned by this focused adapter.
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, parse } from 'node:path';
// eslint-disable-next-line skillsmith/capability-ownership -- Locking is the capability implemented by this adapter.
import lockfile from 'proper-lockfile';
import {
  ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS,
  ARTIFACT_CENTRAL_LOCK_STALE_MS,
  ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS,
  ARTIFACT_COMPATIBILITY_LOCK_STALE_MS,
  type ArtifactCoordinatorPorts,
  type ArtifactParentRevision,
  type ArtifactPathObservation,
} from './coordinator-types.ts';
import {
  artifactMutationError,
  isArtifactMutationError,
  nodeErrorToArtifactMutationError,
  ownDataErrorCode,
} from './file-state.ts';
import { HASH_SCHEMA_VERSION, hashCanonicalInput } from './hash.ts';
import {
  type FileArtifactRecoveryPhysicalStep,
  createFileArtifactRecoveryPort,
} from './recovery-file.ts';

const ACCOUNT_HELPER_ARGV0 = 'skillsmith-account-helper-v1';
if (process.argv0 === ACCOUNT_HELPER_ARGV0) {
  nodeFs.writeFileSync(1, JSON.stringify(userInfo()));
  // eslint-disable-next-line no-restricted-syntax -- The private argv0 helper must terminate before CLI module evaluation continues.
  process.exit(0);
}

const ID_16 = /^[0-9a-f]{16}$/u;
const ID_64 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const privateLockFs = {
  ...nodeFs,
  mkdir: (path: nodeFs.PathLike, callback: nodeFs.NoParamCallback): void => {
    nodeFs.mkdir(path, { mode: 0o700 }, callback);
  },
};
let cachedAccountInfo: ReturnType<typeof userInfo> | null = null;
const stableAccountInfo = (): ReturnType<typeof userInfo> => {
  if (cachedAccountInfo !== null) return cachedAccountInfo;
  const observed = userInfo();
  const compiled =
    process.argv[1]?.startsWith('/$bunfs/root/') === true ||
    /^[a-z]:[\\/]~bun[\\/]root[\\/]/iu.test(process.argv[1] ?? '');
  const child = spawnSync(process.execPath, compiled ? [] : [import.meta.path], {
    argv0: ACCOUNT_HELPER_ARGV0,
    encoding: 'utf8',
    env: {},
    maxBuffer: 16_384,
    timeout: 5_000,
    windowsHide: true,
  });
  if (
    child.error !== undefined ||
    child.status !== 0 ||
    child.signal !== null ||
    child.stderr.length !== 0 ||
    child.stdout.length === 0
  ) {
    throw artifactMutationError('permission-denied');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(child.stdout);
  } catch {
    throw artifactMutationError('permission-denied');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw artifactMutationError('permission-denied');
  }
  const account = parsed as Record<string, unknown>;
  const accountKeys = Reflect.ownKeys(account);
  if (
    Object.getPrototypeOf(account) !== Object.prototype ||
    accountKeys.length !== 5 ||
    !['username', 'uid', 'gid', 'shell', 'homedir'].every((key) => accountKeys.includes(key)) ||
    typeof account.username !== 'string' ||
    account.username.length === 0 ||
    typeof account.uid !== 'number' ||
    !Number.isSafeInteger(account.uid) ||
    typeof account.gid !== 'number' ||
    !Number.isSafeInteger(account.gid) ||
    typeof account.homedir !== 'string' ||
    account.homedir.length === 0 ||
    !isAbsolute(account.homedir) ||
    typeof account.shell !== 'string' ||
    account.shell.length === 0 ||
    (process.platform === 'win32' && account.username !== observed.username) ||
    account.uid !== observed.uid ||
    account.gid !== observed.gid
  ) {
    throw artifactMutationError('permission-denied');
  }
  cachedAccountInfo = Object.freeze({
    username: account.username,
    uid: account.uid,
    gid: account.gid,
    homedir: account.homedir,
    shell: account.shell,
  });
  return cachedAccountInfo;
};

interface NodeIdentity {
  readonly identity: string;
  readonly mode: number;
  readonly linkCount: number;
  readonly kind: ArtifactPathObservation['kind'];
  readonly uid: number;
}

const nodeCode = ownDataErrorCode;

const metadata = async (path: string): Promise<NodeIdentity | null> => {
  try {
    const value = await lstat(path);
    const kind = value.isSymbolicLink()
      ? 'symlink'
      : value.isDirectory()
        ? 'directory'
        : value.isFile()
          ? 'file'
          : 'other';
    return Object.freeze({
      identity: `${value.dev}:${value.ino}`,
      mode: value.mode & 0o7777,
      linkCount: value.nlink,
      kind,
      uid: value.uid,
    });
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return null;
    throw error;
  }
};

const syncPath = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const observeParent = async (path: string): Promise<ArtifactParentRevision> => {
  const segments: string[] = [];
  let cursor = dirname(path);
  while (true) {
    const value = await metadata(cursor);
    if (value !== null) {
      if (value.kind !== 'directory') {
        throw artifactMutationError('invalid-file-kind', { path: cursor });
      }
      if (segments.length === 0) {
        return Object.freeze({ state: 'present', path: cursor, identity: value.identity });
      }
      return Object.freeze({
        state: 'missing',
        nearestExistingPath: cursor,
        nearestExistingIdentity: value.identity,
        missingSegments: Object.freeze(segments),
      });
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw artifactMutationError('invalid-file-kind', { path: cursor });
    segments.unshift(basename(cursor));
    cursor = parent;
  }
};

const observePath = async (path: string): Promise<ArtifactPathObservation> => {
  const parent = await observeParent(path);
  const value = await metadata(path);
  return Object.freeze({
    kind: value?.kind ?? 'absent',
    mode: value?.mode ?? null,
    identity: value?.identity ?? null,
    linkCount: value?.linkCount ?? null,
    parent,
  });
};

const ensurePrivatePath = async (
  path: string,
  expectedUid: number | null,
  protectedRoot = path,
): Promise<void> => {
  const root = parse(path).root;
  const relative = path.slice(root.length).split(/[\\/]/u).filter(Boolean);
  let cursor = root;
  for (const segment of relative) {
    cursor = join(cursor, segment);
    let value = await metadata(cursor);
    const protectedComponent = cursor === protectedRoot || cursor.startsWith(`${protectedRoot}/`);
    if (value === null) {
      await mkdir(cursor, { mode: 0o700 });
      await syncPath(dirname(cursor));
      value = await metadata(cursor);
    }
    if (
      value === null ||
      value.kind !== 'directory' ||
      (protectedComponent && expectedUid !== null && value.uid !== expectedUid)
    ) {
      throw artifactMutationError('permission-denied', { path: cursor });
    }
    if (protectedComponent && (value.mode & 0o077) !== 0) {
      await chmod(cursor, 0o700);
      await syncPath(cursor);
    }
  }
};

interface MemberMarker {
  readonly kind: 'skillsmith-artifact-member-owner';
  readonly version: 1;
  readonly member: { readonly target: string };
  readonly centralOperationId: string;
  readonly lockDirectoryIdentity: string;
}

const markerKey = (target: string): string => {
  const digest = hashCanonicalInput('resource', HASH_SCHEMA_VERSION, target);
  if (!digest.ok) throw artifactMutationError('filesystem-failure');
  return `v1-${digest.value.slice('sha256:'.length)}.json`;
};

const markerBytes = (marker: MemberMarker): Uint8Array =>
  encoder.encode(`${JSON.stringify(marker)}\n`);

const decodeMarker = (bytes: Uint8Array, target: string): MemberMarker => {
  let parsed: unknown;
  try {
    const text = decoder.decode(bytes);
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new Error('invalid');
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    throw artifactMutationError('recovery-conflict');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw artifactMutationError('recovery-conflict');
  }
  const record = parsed as Record<string, unknown>;
  const member = record.member;
  if (
    Reflect.ownKeys(record).join(',') !==
      'kind,version,member,centralOperationId,lockDirectoryIdentity' ||
    record.kind !== 'skillsmith-artifact-member-owner' ||
    record.version !== 1 ||
    typeof member !== 'object' ||
    member === null ||
    Array.isArray(member) ||
    Reflect.ownKeys(member).join(',') !== 'target' ||
    (member as Record<string, unknown>).target !== target ||
    typeof record.centralOperationId !== 'string' ||
    !ID_16.test(record.centralOperationId) ||
    typeof record.lockDirectoryIdentity !== 'string' ||
    record.lockDirectoryIdentity.length === 0
  ) {
    throw artifactMutationError('recovery-conflict');
  }
  const result = Object.freeze({
    kind: 'skillsmith-artifact-member-owner' as const,
    version: 1 as const,
    member: Object.freeze({ target }),
    centralOperationId: record.centralOperationId,
    lockDirectoryIdentity: record.lockDirectoryIdentity,
  });
  if (!Buffer.from(markerBytes(result)).equals(Buffer.from(bytes))) {
    throw artifactMutationError('recovery-conflict');
  }
  return result;
};

const abortError = (): Error & { readonly code: 'ABORT_ERR' } =>
  Object.assign(new Error('artifact lock acquisition cancelled'), { code: 'ABORT_ERR' as const });

const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(abortError());
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
};

interface NodeCoordinatorTestFaults {
  readonly beforeLockStat?: (path: nodeFs.PathLike) => Promise<void>;
  readonly afterLockStat?: (path: nodeFs.PathLike) => void;
  readonly failAfterLockRelease?: () => void;
  readonly failBeforeMarkerRemoval?: () => void;
  readonly failExclusiveWriteAfterBytes?: number;
  readonly afterPhysicalStep?: (step: NodeArtifactCoordinatorPhysicalStep) => Promise<void>;
}

type NodeArtifactCoordinatorPhysicalStep =
  | Readonly<{
      area: 'transaction';
      step:
        | 'directory-created'
        | 'owner-opened'
        | 'owner-written'
        | 'owner-fsynced'
        | 'directory-fsynced'
        | 'parent-fsynced';
    }>
  | Readonly<{
      area: 'stage';
      step: 'file-opened' | 'bytes-written' | 'file-closed' | 'partial-removed';
    }>
  | Readonly<{
      area: 'move';
      step: 'atomic-renamed';
    }>
  | FileArtifactRecoveryPhysicalStep;

const makeNodePorts = async (
  coordinationRoot: string,
  expectedUid: number | null,
  testFaults: NodeCoordinatorTestFaults = {},
): Promise<ArtifactCoordinatorPorts> => {
  const physical = async (step: NodeArtifactCoordinatorPhysicalStep): Promise<void> => {
    await testFaults.afterPhysicalStep?.(step);
  };
  const lockFs =
    testFaults.beforeLockStat === undefined && testFaults.afterLockStat === undefined
      ? privateLockFs
      : {
          ...privateLockFs,
          stat: (
            path: nodeFs.PathLike,
            callback: (error: NodeJS.ErrnoException | null, stats: nodeFs.Stats) => void,
          ): void => {
            const run = (): void => {
              nodeFs.stat(path, (error, stats) => {
                callback(error, stats);
                testFaults.afterLockStat?.(path);
              });
            };
            const before = testFaults.beforeLockStat?.(path);
            if (before === undefined) {
              run();
              return;
            }
            void before.then(run, (error: unknown) => {
              const failure =
                error instanceof Error ? error : new Error('lock stat test fault rejected');
              callback(failure as NodeJS.ErrnoException, undefined as never);
              testFaults.afterLockStat?.(path);
            });
          },
        };
  await ensurePrivatePath(coordinationRoot, expectedUid);
  const recoveryDirectory = join(coordinationRoot, 'recovery');
  const memberOwners = join(coordinationRoot, 'member-owners');
  await ensurePrivatePath(recoveryDirectory, expectedUid);
  await ensurePrivatePath(memberOwners, expectedUid);
  const recoveryIdentity = await metadata(recoveryDirectory);
  if (recoveryIdentity === null || recoveryIdentity.kind !== 'directory') {
    throw artifactMutationError('permission-denied', { path: recoveryDirectory });
  }

  const nextId: ArtifactCoordinatorPorts['nextId'] = (purpose) =>
    randomBytes(purpose === 'artifact-ownership' ? 32 : 8).toString('hex');

  const markerPath = (target: string): string => join(memberOwners, markerKey(target));

  const readMarker = async (target: string): Promise<MemberMarker | null> => {
    const path = markerPath(target);
    try {
      const value = await metadata(path);
      if (value === null) return null;
      if (value.kind !== 'file' || value.linkCount !== 1 || value.mode !== 0o600) {
        throw artifactMutationError('recovery-conflict', { path });
      }
      const beforeIdentity = value.identity;
      const bytes = new Uint8Array(await readFile(path));
      const after = await metadata(path);
      if (after === null || after.identity !== beforeIdentity || after.linkCount !== 1) {
        throw artifactMutationError('recovery-conflict', { path });
      }
      return decodeMarker(bytes, target);
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return null;
      throw error;
    }
  };

  const reclaimMarkedMember = async (target: string): Promise<void> => {
    const marker = await readMarker(target);
    if (marker === null) return;
    const lockDirectory = `${target}.lock`;
    const current = await metadata(lockDirectory);
    if (current === null) {
      await unlink(markerPath(target));
      await syncPath(memberOwners);
      return;
    }
    if (current.kind !== 'directory' || current.identity !== marker.lockDirectoryIdentity) {
      throw artifactMutationError('recovery-conflict', { path: lockDirectory });
    }
    await rmdir(lockDirectory);
    await syncPath(dirname(lockDirectory));
    const observedMarker = await readMarker(target);
    if (observedMarker?.lockDirectoryIdentity !== marker.lockDirectoryIdentity) {
      throw artifactMutationError('recovery-conflict', { path: markerPath(target) });
    }
    await unlink(markerPath(target));
    await syncPath(memberOwners);
  };

  const createMarker = async (
    target: string,
    centralOperationId: string,
  ): Promise<MemberMarker> => {
    const lockDirectory = `${target}.lock`;
    const lockIdentity = await metadata(lockDirectory);
    if (lockIdentity === null || lockIdentity.kind !== 'directory') {
      throw artifactMutationError('recovery-conflict', { path: lockDirectory });
    }
    const marker = Object.freeze({
      kind: 'skillsmith-artifact-member-owner' as const,
      version: 1 as const,
      member: Object.freeze({ target }),
      centralOperationId,
      lockDirectoryIdentity: lockIdentity.identity,
    });
    const path = markerPath(target);
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(markerBytes(marker));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncPath(memberOwners);
    const observed = await readMarker(target);
    if (
      observed?.lockDirectoryIdentity !== marker.lockDirectoryIdentity ||
      observed.centralOperationId !== centralOperationId
    ) {
      throw artifactMutationError('recovery-conflict', { path });
    }
    return marker;
  };

  const removeMarker = async (target: string, expected: MemberMarker): Promise<void> => {
    const observed = await readMarker(target);
    if (
      observed === null ||
      observed.centralOperationId !== expected.centralOperationId ||
      observed.lockDirectoryIdentity !== expected.lockDirectoryIdentity
    ) {
      throw artifactMutationError('recovery-conflict', { path: markerPath(target) });
    }
    testFaults.failBeforeMarkerRemoval?.();
    await unlink(markerPath(target));
    await syncPath(memberOwners);
  };

  const ports: ArtifactCoordinatorPorts = {
    coordinationRoot,
    observe: observePath,
    readBytes: async (path) => new Uint8Array(await readFile(path)),
    makeDirectoryExclusive: async (path, mode) => {
      await mkdir(path, { mode });
    },
    createTransactionDirectoryExclusive: async (path, ownershipToken) => {
      if (typeof ownershipToken !== 'string' || !ID_64.test(ownershipToken)) {
        throw artifactMutationError('filesystem-failure');
      }
      await mkdir(path, { mode: 0o700 });
      await physical({ area: 'transaction', step: 'directory-created' });
      const owner = join(path, 'owner');
      const handle = await open(owner, 'wx', 0o600);
      await physical({ area: 'transaction', step: 'owner-opened' });
      try {
        await handle.writeFile(`${ownershipToken}\n`);
        await physical({ area: 'transaction', step: 'owner-written' });
        await handle.sync();
        await physical({ area: 'transaction', step: 'owner-fsynced' });
      } finally {
        await handle.close();
      }
      await syncPath(path);
      await physical({ area: 'transaction', step: 'directory-fsynced' });
      await syncPath(dirname(path));
      await physical({ area: 'transaction', step: 'parent-fsynced' });
      const value = await metadata(path);
      if (value === null || value.kind !== 'directory') {
        throw artifactMutationError('filesystem-failure', { path });
      }
      return Object.freeze({ identity: value.identity });
    },
    writeBytesExclusive: async (path, bytes, mode) => {
      const handle = await open(path, 'wx', mode & 0o600);
      await physical({ area: 'stage', step: 'file-opened' });
      const opened = await handle.stat();
      let failure: unknown = null;
      try {
        const partial = testFaults.failExclusiveWriteAfterBytes;
        if (partial === undefined) {
          await handle.writeFile(new Uint8Array(bytes));
          await physical({ area: 'stage', step: 'bytes-written' });
        } else {
          await handle.write(new Uint8Array(bytes).subarray(0, partial));
          await physical({ area: 'stage', step: 'bytes-written' });
          throw new Error('injected partial exclusive write');
        }
      } catch (error) {
        failure = error;
      } finally {
        await handle.close();
        await physical({ area: 'stage', step: 'file-closed' });
      }
      if (failure !== null) {
        const partial = await metadata(path);
        if (
          partial === null ||
          partial.kind !== 'file' ||
          partial.linkCount !== 1 ||
          partial.identity !== `${opened.dev}:${opened.ino}`
        ) {
          throw artifactMutationError('recovery-conflict', { path });
        }
        await unlink(path);
        await physical({ area: 'stage', step: 'partial-removed' });
        await syncPath(dirname(path));
        throw failure;
      }
    },
    setFileMode: async (path, mode) => chmod(path, mode),
    moveIntoOwnedTransaction: async (source, destination) => {
      await rename(source, destination);
      await physical({ area: 'move', step: 'atomic-renamed' });
    },
    linkFileNoReplace: async (source, destination) => link(source, destination),
    removeFile: async (path) => unlink(path),
    removeEmptyDirectory: async (path) => rmdir(path),
    fsyncFile: syncPath,
    fsyncDirectory: syncPath,
    withFileLock: async (target, options, operation) => {
      if (
        typeof options.centralOperationId !== 'string' ||
        !ID_16.test(options.centralOperationId)
      ) {
        throw artifactMutationError('filesystem-failure');
      }
      if (options.policy === 'compatibility') await reclaimMarkedMember(target);
      let release: (() => Promise<void>) | null = null;
      let releaseStarted = false;
      for (const wait of options.retryDelaysMs) {
        await delay(wait, options.signal);
        if (options.signal?.aborted) throw abortError();
        try {
          release = await lockfile.lock(target, {
            fs: lockFs,
            realpath: false,
            stale:
              options.policy === 'central'
                ? ARTIFACT_CENTRAL_LOCK_STALE_MS
                : ARTIFACT_COMPATIBILITY_LOCK_STALE_MS,
            update:
              options.policy === 'central'
                ? ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS
                : ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS,
            retries: 0,
            onCompromised: (error) => {
              if (!releaseStarted) throw error;
            },
          });
          break;
        } catch (error) {
          if (nodeCode(error) === 'EACCES' || nodeCode(error) === 'EPERM') {
            throw nodeErrorToArtifactMutationError(error, undefined, target);
          }
          if (nodeCode(error) !== 'ELOCKED') {
            throw nodeErrorToArtifactMutationError(error, undefined, target);
          }
        }
      }
      if (release === null) {
        throw artifactMutationError('lock-contention', { path: target });
      }
      let marker: MemberMarker | null = null;
      let operationValue: Awaited<ReturnType<typeof operation>> | undefined;
      let operationError: unknown = null;
      try {
        if (options.signal?.aborted) throw abortError();
        if (options.policy === 'compatibility') {
          marker = await createMarker(target, options.centralOperationId);
        }
        operationValue = await operation();
      } catch (error) {
        operationError =
          nodeCode(error) === 'ABORT_ERR' || isArtifactMutationError(error)
            ? error
            : nodeErrorToArtifactMutationError(error, undefined, target);
      }
      let markerError: unknown = null;
      if (marker !== null) {
        try {
          await removeMarker(target, marker);
        } catch (error) {
          markerError = error;
        }
      }
      let releaseError: unknown = null;
      releaseStarted = true;
      try {
        await release();
        testFaults.failAfterLockRelease?.();
      } catch (error) {
        releaseError = error;
      }
      if (releaseError !== null) {
        throw nodeErrorToArtifactMutationError(releaseError, undefined, target);
      }
      if (markerError !== null) {
        if (isArtifactMutationError(markerError)) {
          throw markerError;
        }
        throw nodeErrorToArtifactMutationError(markerError, undefined, target);
      }
      if (operationError !== null) throw operationError;
      return operationValue as Awaited<ReturnType<typeof operation>>;
    },
    recovery: createFileArtifactRecoveryPort(recoveryDirectory, {
      nextCasId: () => nextId('artifact-cas'),
      expectedDirectoryIdentity: recoveryIdentity.identity,
      afterPhysicalStep: physical,
    }),
    nextId,
  };
  return Object.freeze(ports);
};

/** Account-stable production adapter; HOME and XDG variables are deliberately ignored. */
export const createNodeArtifactCoordinatorPorts = async (): Promise<ArtifactCoordinatorPorts> => {
  const account = stableAccountInfo();
  if (typeof account.homedir !== 'string') throw artifactMutationError('permission-denied');
  const accountHome = account.homedir;
  const root = join(accountHome, '.skillsmith', 'coordination', 'artifacts-v1');
  await ensurePrivatePath(
    root,
    process.platform === 'win32' ? null : account.uid,
    join(accountHome, '.skillsmith'),
  );
  return makeNodePorts(root, process.platform === 'win32' ? null : account.uid);
};

/** Internal hermetic adapter factory. It is intentionally not re-exported from the package root. */
export const createTestNodeArtifactCoordinatorPorts = async (
  root: string,
  testFaults: NodeCoordinatorTestFaults = {},
): Promise<ArtifactCoordinatorPorts> => makeNodePorts(root, null, testFaults);
