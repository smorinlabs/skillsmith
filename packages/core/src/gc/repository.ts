import { dirname, join } from 'node:path';
import type {
  EffectiveUserPort,
  ExclusiveCreatePort,
  FileMetadataReadPort,
  FileReadPort,
  FileWritePort,
} from '../ports/types.ts';
import { inventoryGcStore } from './inventory.ts';
import type { GcReclaimRequest, GcReclaimResult, GcTombstoneObservation } from './types.ts';

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
  Pick<FileWritePort, 'fsyncDir' | 'fsyncFile' | 'removeTree' | 'rename'>;

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

const ensurePrivateDirectory = async (ports: RepositoryPorts, path: string): Promise<boolean> => {
  if ((await ports.pathKind(path)) === 'absent') {
    await ports.makeDirExclusive(path, 0o700).catch(() => {});
  }
  return secureDirectory(ports, path);
};

/** Completed runs may leave only empty, owner-only plan namespaces. */
export const observeGcTombstones = async (
  ports: RepositoryPorts,
  storeRoot: string,
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
    if ((await ports.listDir(plan)).length !== 0) {
      return Object.freeze({
        state: 'refused',
        root: tombstones,
        reason: 'GC tombstone action state exists without matching recovery ownership',
      });
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
  const inventory = await inventoryGcStore(ports, request.storeRoot);
  if (inventory.state !== 'ok') {
    return Object.freeze({
      state: 'refused',
      logicalBytes: 0,
      reason: 'GC source inventory is unsafe during revalidation',
    });
  }
  const current = inventory.objects.find(({ id }) => id === request.object.id);
  if (current === undefined) {
    return (await ports.pathKind(request.object.path)) === 'absent'
      ? Object.freeze({ state: 'already-absent', logicalBytes: 0 })
      : Object.freeze({
          state: 'refused',
          logicalBytes: 0,
          reason: 'GC source identity changed before detach',
        });
  }
  if (
    current.path !== request.object.path ||
    current.contentHash !== request.object.contentHash ||
    current.modifiedAt !== request.object.modifiedAt ||
    current.logicalBytes !== request.object.logicalBytes ||
    current.directoryIdentity !== request.object.directoryIdentity
  ) {
    return Object.freeze({
      state: 'refused',
      logicalBytes: 0,
      reason: 'GC source facts changed before detach',
    });
  }
  const tombstones = join(request.storeRoot, '.gc-tombstones');
  const version = join(tombstones, 'v1');
  const plan = join(version, request.planId);
  const action = join(plan, request.actionId);
  const owner = join(action, 'owner.json');
  const payload = join(action, 'payload');
  if (
    !(await ensurePrivateDirectory(ports, tombstones)) ||
    !(await ensurePrivateDirectory(ports, version)) ||
    !(await ensurePrivateDirectory(ports, plan)) ||
    (await ports.pathKind(action)) !== 'absent'
  ) {
    return Object.freeze({
      state: 'refused',
      logicalBytes: 0,
      reason: 'GC action container boundary is unsafe or occupied',
    });
  }
  try {
    await ports.makeDirExclusive(action, 0o700);
    if (!(await secureDirectory(ports, action))) throw new Error();
    const ownerSource = `${JSON.stringify(
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
    await ports.writeTextFileExclusive(owner, ownerSource, 0o600);
    await ports.fsyncFile(owner);
    const ownerMetadata = await ports.readFileMetadata(owner);
    if (
      ownerMetadata.kind !== 'file' ||
      ownerMetadata.mode !== 0o600 ||
      ownerMetadata.linkCount !== 1 ||
      (await ports.readText(owner)) !== ownerSource ||
      (await ports.pathKind(payload)) !== 'absent'
    ) {
      throw new Error();
    }
    await ports.fsyncDir(action);
    await ports.rename(request.object.path, payload);
    await ports.fsyncDir(dirname(request.object.path));
    await ports.fsyncDir(action);
    if (
      (await ports.pathKind(request.object.path)) !== 'absent' ||
      (await ports.pathKind(payload)) !== 'dir'
    ) {
      throw new Error();
    }
    await ports.removeTree(payload);
    await ports.fsyncDir(action);
    await ports.removeTree(owner);
    await ports.removeTree(action);
    await ports.fsyncDir(plan);
    return Object.freeze({ state: 'cleaned', logicalBytes: request.object.logicalBytes });
  } catch {
    return Object.freeze({
      state: 'refused',
      logicalBytes: 0,
      reason: 'GC atomic detach or owner-bound cleanup failed',
    });
  }
};
