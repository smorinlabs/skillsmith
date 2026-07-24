import { dirname, join } from 'node:path';
import { safeErrorCode } from '../errors.ts';
import type {
  EffectiveUserPort,
  ExclusiveCreatePort,
  FileMetadataReadPort,
  FileReadPort,
  FileWritePort,
} from '../ports/types.ts';
import { validateGcObjectAt } from './inventory.ts';
import type {
  GcFinalizeResult,
  GcReclaimRequest,
  GcReclaimResult,
  GcRecoveryObservation,
  GcTombstoneObservation,
} from './types.ts';

type RepositoryPorts = EffectiveUserPort &
  ExclusiveCreatePort &
  FileMetadataReadPort &
  Pick<
    FileReadPort,
    | 'isExecutable'
    | 'listDir'
    | 'modifiedAt'
    | 'pathKind'
    | 'readBytes'
    | 'readLink'
    | 'readText'
    | 'realpath'
  > &
  Pick<FileWritePort, 'fsyncDir' | 'fsyncFile' | 'removeEmptyDirectory' | 'removeTree' | 'rename'>;

const HEX64 = /^[0-9a-f]{64}$/u;

const secureDirectory = async (ports: RepositoryPorts, path: string): Promise<boolean> => {
  const metadata = await ports.readFileMetadata(path).catch(() => null);
  const effective = ports.effectiveUserIdentity();
  return (
    metadata?.kind === 'dir' &&
    metadata.identity !== null &&
    metadata.mode === 0o700 &&
    effective.uid !== null &&
    metadata.uid === effective.uid &&
    (effective.gid === null || metadata.gid === effective.gid)
  );
};

const exactDirectory = async (
  ports: RepositoryPorts,
  path: string,
  identity: string,
): Promise<boolean> => {
  const metadata = await ports.readFileMetadata(path);
  return (await secureDirectory(ports, path)) && metadata.identity === identity;
};

const ensurePrivateDirectory = async (ports: RepositoryPorts, path: string): Promise<boolean> => {
  if ((await ports.pathKind(path)) === 'absent') {
    await ports.makeDirExclusive(path, 0o700).catch(() => {});
    await ports.fsyncDir(dirname(path));
  }
  return secureDirectory(ports, path);
};

const ownerSource = (request: Pick<GcReclaimRequest, 'planId' | 'actionId' | 'ownershipToken'>) =>
  `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'skillsmith.gc-tombstone-owner',
      planId: request.planId,
      actionId: request.actionId,
      ownershipToken: request.ownershipToken,
    },
    null,
    2,
  )}\n`;

const secureOwner = async (
  ports: RepositoryPorts,
  path: string,
  source: string,
): Promise<boolean> => {
  const metadata = await ports.readFileMetadata(path).catch(() => null);
  const effective = ports.effectiveUserIdentity();
  return (
    metadata?.kind === 'file' &&
    metadata.identity !== null &&
    metadata.mode === 0o600 &&
    metadata.linkCount === 1 &&
    effective.uid !== null &&
    metadata.uid === effective.uid &&
    (effective.gid === null || metadata.gid === effective.gid) &&
    (await ports.readText(path).catch(() => '')) === source
  );
};

const exactContainer = async (
  ports: RepositoryPorts,
  request: GcReclaimRequest,
): Promise<boolean> => {
  if (!(await secureDirectory(ports, request.containerPath))) return false;
  const metadata = await ports.readFileMetadata(request.containerPath).catch(() => null);
  return (
    request.containerIdentity !== null &&
    metadata?.identity === request.containerIdentity &&
    (await secureOwner(ports, join(request.containerPath, 'owner.json'), ownerSource(request)))
  );
};

/** Completed runs may leave only empty, owner-only plan namespaces. */
export const observeGcTombstones = async (
  ports: RepositoryPorts,
  storeRoot: string,
  recovery: GcRecoveryObservation = Object.freeze({
    state: 'none',
    record: null,
    path: '',
  }),
): Promise<GcTombstoneObservation> => {
  const tombstones = join(storeRoot, '.gc-tombstones');
  if ((await ports.pathKind(tombstones)) === 'absent') {
    return Object.freeze({ state: 'safe', root: tombstones });
  }
  const version = join(tombstones, 'v1');
  if (
    !(await secureDirectory(ports, tombstones)) ||
    (await ports.listDir(tombstones)).some((name) => name !== 'v1') ||
    (await ports.pathKind(version)) !== 'dir' ||
    !(await secureDirectory(ports, version))
  ) {
    return Object.freeze({
      state: 'refused',
      root: tombstones,
      reason: 'GC tombstone namespace ownership, mode, or version is unsafe',
    });
  }
  for (const name of await ports.listDir(version)) {
    const plan = join(version, name);
    if (!HEX64.test(name) || !(await secureDirectory(ports, plan))) {
      return Object.freeze({
        state: 'refused',
        root: tombstones,
        reason: 'GC tombstone plan namespace is unexpected or unsafe',
      });
    }
    const actionNames = await ports.listDir(plan);
    if (actionNames.length === 0) continue;
    if (recovery.state !== 'pending' || name !== recovery.record.planId) {
      return Object.freeze({
        state: 'refused',
        root: tombstones,
        reason: 'GC tombstone action state exists without matching recovery ownership',
      });
    }
    const expected = new Map(recovery.record.actions.map((action) => [action.actionId, action]));
    for (const actionName of actionNames) {
      const recorded = expected.get(actionName);
      const actionPath = join(plan, actionName);
      const actionMetadata = await ports.readFileMetadata(actionPath).catch(() => null);
      if (
        recorded === undefined ||
        recorded.containerPath !== actionPath ||
        recorded.payloadPath !== join(actionPath, 'payload') ||
        recorded.outcome === 'protected-skip' ||
        recorded.outcome === 'already-absent' ||
        !(await secureDirectory(ports, actionPath)) ||
        (recorded.containerIdentity !== null &&
          actionMetadata?.identity !== recorded.containerIdentity)
      ) {
        return Object.freeze({
          state: 'refused',
          root: tombstones,
          reason: 'GC tombstone action is not bound to the pending recovery record',
        });
      }
      const entries = [...(await ports.listDir(actionPath))].sort();
      const hasPayload = entries.includes('payload');
      if (
        entries.length === 0 &&
        recorded.outcome === 'pending' &&
        recorded.containerIdentity === null
      ) {
        continue;
      }
      if (
        entries.length === 0 &&
        recorded.outcome === 'cleaned' &&
        recorded.containerIdentity !== null
      ) {
        continue;
      }
      if (
        !entries.every((entry) => entry === 'owner.json' || entry === 'payload') ||
        entries.length === 0 ||
        !(await secureOwner(
          ports,
          join(actionPath, 'owner.json'),
          ownerSource({ ...recorded, planId: recovery.record.planId }),
        )) ||
        (hasPayload && (await ports.pathKind(join(actionPath, 'payload'))) !== 'dir') ||
        (recorded.outcome === 'pending' && hasPayload) ||
        (recorded.outcome === 'cleaned' && hasPayload)
      ) {
        return Object.freeze({
          state: 'refused',
          root: tombstones,
          reason: 'GC tombstone action state is malformed or has the wrong owner',
        });
      }
      if (hasPayload) {
        const payloadMetadata = await ports
          .readFileMetadata(recorded.payloadPath)
          .catch(() => null);
        if (
          (recorded.payloadIdentity !== null &&
            payloadMetadata?.identity !== recorded.payloadIdentity) ||
          (recorded.outcome !== 'cleanup-started' &&
            !(await validateGcObjectAt(ports, recorded.payloadPath, recorded.object)))
        ) {
          return Object.freeze({
            state: 'refused',
            root: tombstones,
            reason: 'GC tombstone payload does not match pending recovery authority',
          });
        }
      }
    }
  }
  return Object.freeze({ state: 'safe', root: tombstones });
};

export const reclaimGcStoreObject = async (
  ports: RepositoryPorts,
  request: GcReclaimRequest,
): Promise<GcReclaimResult> => {
  if (
    !HEX64.test(request.planId) ||
    !HEX64.test(request.actionId) ||
    !HEX64.test(request.ownershipToken)
  ) {
    return Object.freeze({
      state: 'refused',
      logicalBytes: 0,
      reason: 'GC reclaim IDs are invalid',
    });
  }
  const tombstones = join(request.storeRoot, '.gc-tombstones');
  const version = join(tombstones, 'v1');
  const plan = join(version, request.planId);
  const action = request.containerPath;
  const owner = join(action, 'owner.json');
  const payload = request.payloadPath;
  try {
    if (request.outcome === 'pending') {
      if (
        (await ports.pathKind(request.object.path)) === 'absent' &&
        (await ports.pathKind(action)) === 'absent'
      ) {
        return Object.freeze({
          state: 'already-absent',
          logicalBytes: 0,
          containerIdentity: null,
          payloadIdentity: null,
        });
      }
      if (!(await validateGcObjectAt(ports, request.object.path, request.object))) {
        throw new Error('source');
      }
      if (
        !(await ensurePrivateDirectory(ports, tombstones)) ||
        !(await ensurePrivateDirectory(ports, version)) ||
        !(await ensurePrivateDirectory(ports, plan))
      ) {
        throw new Error('container');
      }
      if ((await ports.pathKind(action)) === 'absent') {
        await ports.makeDirExclusive(action, 0o700);
        if (!(await secureDirectory(ports, action))) throw new Error('container');
        await ports.fsyncDir(plan);
        await ports.writeTextFileExclusive(owner, ownerSource(request), 0o600);
        await ports.fsyncFile(owner);
        await ports.fsyncDir(action);
        await ports.fsyncDir(plan);
      } else {
        if (!(await secureDirectory(ports, action))) throw new Error('collision');
        const entries = await ports.listDir(action);
        if (entries.length === 0) {
          if (ports.removeEmptyDirectory === undefined) throw new Error('atomic-rmdir');
          await ports.removeEmptyDirectory(action);
          await ports.fsyncDir(plan);
          await ports.makeDirExclusive(action, 0o700);
          await ports.fsyncDir(plan);
          await ports.writeTextFileExclusive(owner, ownerSource(request), 0o600);
          await ports.fsyncFile(owner);
          await ports.fsyncDir(action);
        } else if (
          !(await secureOwner(ports, owner, ownerSource(request))) ||
          (await ports.pathKind(payload)) !== 'absent' ||
          entries.some((entry) => entry !== 'owner.json')
        ) {
          throw new Error('collision');
        }
      }
      const metadata = await ports.readFileMetadata(action);
      if (metadata.identity === null) throw new Error('identity');
      return Object.freeze({
        state: 'prepared',
        logicalBytes: 0,
        containerIdentity: metadata.identity,
        payloadIdentity: null,
      });
    }
    if (request.outcome === 'prepared') {
      if (!(await exactContainer(ports, request))) throw new Error('container');
      const sourceKind = await ports.pathKind(request.object.path);
      const payloadKind = await ports.pathKind(payload);
      if (sourceKind === 'dir' && payloadKind === 'absent') {
        if (!(await validateGcObjectAt(ports, request.object.path, request.object))) {
          throw new Error('source');
        }
        await ports.rename(request.object.path, payload);
        await ports.fsyncDir(dirname(request.object.path));
        await ports.fsyncDir(action);
      } else if (sourceKind !== 'absent' || payloadKind !== 'dir') {
        throw new Error('detach');
      }
      if (
        (await ports.pathKind(request.object.path)) !== 'absent' ||
        !(await validateGcObjectAt(ports, payload, request.object))
      ) {
        throw new Error('payload');
      }
      const metadata = await ports.readFileMetadata(payload);
      if (metadata.identity !== request.object.directoryIdentity) throw new Error('identity');
      return Object.freeze({
        state: 'detached',
        logicalBytes: 0,
        containerIdentity: request.containerIdentity as string,
        payloadIdentity: metadata.identity,
      });
    }
    if (request.outcome === 'detached') {
      if (!(await exactContainer(ports, request))) throw new Error('container');
      if ((await ports.pathKind(request.object.path)) !== 'absent') throw new Error('source');
      if ((await ports.pathKind(payload)) === 'dir') {
        const metadata = await ports.readFileMetadata(payload);
        if (
          request.payloadIdentity === null ||
          metadata.identity !== request.payloadIdentity ||
          !(await validateGcObjectAt(ports, payload, request.object))
        ) {
          throw new Error('payload');
        }
      } else if ((await ports.pathKind(payload)) !== 'absent') {
        throw new Error('payload');
      }
      return Object.freeze({
        state: 'cleanup-started',
        logicalBytes: 0,
        containerIdentity: request.containerIdentity as string,
        payloadIdentity: request.payloadIdentity as string,
      });
    }
    if (request.outcome === 'cleanup-started') {
      if (!(await exactContainer(ports, request))) throw new Error('container');
      if ((await ports.pathKind(request.object.path)) !== 'absent') throw new Error('source');
      if ((await ports.pathKind(payload)) === 'dir') {
        const metadata = await ports.readFileMetadata(payload);
        if (request.payloadIdentity === null || metadata.identity !== request.payloadIdentity) {
          throw new Error('payload');
        }
        await ports.removeTree(payload);
        await ports.fsyncDir(action);
      } else if ((await ports.pathKind(payload)) !== 'absent') {
        throw new Error('payload');
      }
      return Object.freeze({
        state: 'cleaned',
        logicalBytes: request.object.logicalBytes,
        containerIdentity: request.containerIdentity as string,
        payloadIdentity: request.payloadIdentity as string,
      });
    }
    throw new Error('phase');
  } catch (error) {
    const code = safeErrorCode(error);
    return Object.freeze({
      state: 'refused',
      logicalBytes: 0,
      reason:
        code === 'EACCES' || code === 'EPERM'
          ? 'GC permission denied during atomic detach or owner-bound cleanup'
          : 'GC atomic detach or owner-bound cleanup failed',
    });
  }
};

const pruneIfExactEmpty = async (
  ports: RepositoryPorts,
  path: string,
  identity: string,
): Promise<void> => {
  const metadata = await ports.readFileMetadata(path).catch(() => null);
  if (
    metadata?.kind !== 'dir' ||
    metadata.identity !== identity ||
    ports.removeEmptyDirectory === undefined
  ) {
    return;
  }
  await ports.removeEmptyDirectory(path).catch(() => {});
  if ((await ports.pathKind(path)) === 'absent') await ports.fsyncDir(dirname(path));
};

/** Removes only cleanup metadata already made authoritative by a `cleaned` record transition. */
export const finalizeGcStoreReclaim = async (
  ports: RepositoryPorts,
  request: GcReclaimRequest,
): Promise<GcFinalizeResult> => {
  try {
    if (request.outcome !== 'cleaned' || (await ports.pathKind(request.object.path)) !== 'absent') {
      return Object.freeze({ ok: false, reason: 'GC cleaned reclaim state is invalid' });
    }
    if ((await ports.pathKind(request.containerPath)) !== 'absent') {
      const entries = [...(await ports.listDir(request.containerPath))].sort();
      if (
        request.containerIdentity === null ||
        !(await exactDirectory(ports, request.containerPath, request.containerIdentity)) ||
        (await ports.pathKind(request.payloadPath)) !== 'absent'
      ) {
        return Object.freeze({ ok: false, reason: 'GC cleaned tombstone identity is invalid' });
      }
      if (entries.length === 1 && entries[0] === 'owner.json') {
        if (!(await exactContainer(ports, request))) {
          return Object.freeze({ ok: false, reason: 'GC cleaned tombstone owner is invalid' });
        }
        await ports.removeTree(join(request.containerPath, 'owner.json'));
        await ports.fsyncDir(request.containerPath);
      } else if (entries.length !== 0) {
        return Object.freeze({ ok: false, reason: 'GC cleaned tombstone contains planted state' });
      }
      if (ports.removeEmptyDirectory === undefined) {
        return Object.freeze({ ok: false, reason: 'GC atomic tombstone removal is unavailable' });
      }
      await ports.removeEmptyDirectory(request.containerPath);
      if ((await ports.pathKind(request.containerPath)) !== 'absent') {
        return Object.freeze({ ok: false, reason: 'GC tombstone metadata cleanup failed' });
      }
      await ports.fsyncDir(dirname(request.containerPath));
    }
    const repositoryPath = dirname(request.object.path);
    const namespacePath = dirname(repositoryPath);
    await pruneIfExactEmpty(ports, repositoryPath, request.object.repositoryIdentity);
    await pruneIfExactEmpty(ports, namespacePath, request.object.namespaceIdentity);
    return Object.freeze({ ok: true });
  } catch (error) {
    const code = safeErrorCode(error);
    return Object.freeze({
      ok: false,
      reason:
        code === 'EACCES' || code === 'EPERM'
          ? 'GC permission denied during tombstone metadata cleanup'
          : 'GC tombstone metadata cleanup failed',
    });
  }
};
