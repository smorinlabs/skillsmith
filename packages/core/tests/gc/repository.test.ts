import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inventoryGcStore } from '../../src/gc/inventory.ts';
import {
  finalizeGcStoreReclaim,
  observeGcTombstones,
  reclaimGcStoreObject,
} from '../../src/gc/repository.ts';
import type {
  GcObjectObservation,
  GcReclaimRequest,
  GcRecoveryObservation,
} from '../../src/gc/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const id = (character: string): string => character.repeat(64);

const seed = async (root: string): Promise<string> => {
  const path = join(root, 'fixture', 'repo@0123456789ab', 'review');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), 'review');
  return path;
};

const requestFor = (root: string, object: GcObjectObservation): GcReclaimRequest => {
  const containerPath = join(root, '.gc-tombstones', 'v1', id('a'), id('b'));
  return {
    storeRoot: root,
    planId: id('a'),
    actionId: id('b'),
    ownershipToken: id('c'),
    object,
    containerPath,
    payloadPath: join(containerPath, 'payload'),
    outcome: 'pending',
    containerIdentity: null,
    payloadIdentity: null,
  };
};

describe('GC owner-bound store repository', () => {
  test('atomically detaches to a private absent payload before recursive cleanup', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-reclaim-'));
    try {
      const path = await seed(root);
      const inventory = await inventoryGcStore(ports, root);
      expect(inventory.state).toBe('ok');
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      const selected = inventory.objects[0];
      const request = requestFor(root, selected);
      const prepared = await reclaimGcStoreObject(ports, request);
      expect(prepared).toMatchObject({ state: 'prepared' });
      if (prepared.state !== 'prepared') throw new Error('prepare failed');
      const detached = await reclaimGcStoreObject(ports, {
        ...request,
        ...prepared,
        outcome: prepared.state,
      });
      expect(detached).toMatchObject({ state: 'detached' });
      if (detached.state !== 'detached') throw new Error('detach failed');
      const cleanupStarted = await reclaimGcStoreObject(ports, {
        ...request,
        ...detached,
        outcome: detached.state,
      });
      expect(cleanupStarted).toMatchObject({ state: 'cleanup-started' });
      if (cleanupStarted.state !== 'cleanup-started') throw new Error('cleanup start failed');
      const cleaned = await reclaimGcStoreObject(ports, {
        ...request,
        ...cleanupStarted,
        outcome: cleanupStarted.state,
      });
      expect(cleaned).toMatchObject({ state: 'cleaned', logicalBytes: selected.logicalBytes });
      if (cleaned.state !== 'cleaned') throw new Error('cleanup failed');
      const repositoryPath = dirname(path);
      const concurrent = join(repositoryPath, 'concurrent');
      let raced = false;
      const racePorts = Object.assign(Object.create(ports) as typeof ports, {
        removeEmptyDirectory: async (target: string) => {
          if (!raced && target === repositoryPath) {
            raced = true;
            await mkdir(concurrent);
            await writeFile(join(concurrent, 'keep'), 'keep');
          }
          await ports.removeEmptyDirectory?.(target);
        },
      });
      expect(
        await finalizeGcStoreReclaim(racePorts, {
          ...request,
          ...cleaned,
          outcome: cleaned.state,
        }),
      ).toEqual({ ok: true });
      expect(await ports.readText(join(concurrent, 'keep'))).toBe('keep');
      expect(await ports.pathKind(path)).toBe('absent');
      expect(await ports.pathKind(join(root, '.gc-tombstones', 'v1', id('a'), id('b')))).toBe(
        'absent',
      );
      expect(await ports.listDir(join(root, '.gc-tombstones', 'v1', id('a')))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a planted action container without deleting the live source', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-planted-'));
    try {
      const path = await seed(root);
      const inventory = await inventoryGcStore(ports, root);
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      const planted = join(root, '.gc-tombstones', 'v1', id('a'), id('b'));
      await mkdir(planted, { recursive: true, mode: 0o700 });
      await writeFile(join(planted, 'planted'), 'unsafe');
      const result = await reclaimGcStoreObject(ports, requestFor(root, inventory.objects[0]));
      expect(result).toMatchObject({ state: 'refused' });
      expect(await ports.pathKind(path)).toBe('dir');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses changed source facts before creating a tombstone', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-race-'));
    try {
      const path = await seed(root);
      const inventory = await inventoryGcStore(ports, root);
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      await writeFile(join(path, 'changed'), 'changed');
      const result = await reclaimGcStoreObject(ports, requestFor(root, inventory.objects[0]));
      expect(result).toMatchObject({ state: 'refused' });
      expect(await ports.pathKind(path)).toBe('dir');
      expect(await ports.pathKind(join(root, '.gc-tombstones'))).toBe('absent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recreates an exact empty pre-identity action container after interrupted owner publish', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-empty-action-'));
    try {
      await seed(root);
      const inventory = await inventoryGcStore(ports, root);
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      const request = requestFor(root, inventory.objects[0]);
      await mkdir(join(root, '.gc-tombstones'), { mode: 0o700 });
      await mkdir(join(root, '.gc-tombstones', 'v1'), { mode: 0o700 });
      await mkdir(join(root, '.gc-tombstones', 'v1', id('a')), { mode: 0o700 });
      await mkdir(request.containerPath, { mode: 0o700 });
      const prepared = await reclaimGcStoreObject(ports, request);
      expect(prepared).toMatchObject({ state: 'prepared' });
      if (prepared.state !== 'prepared') throw new Error('empty action adoption failed');
      expect(await ports.listDir(request.containerPath)).toEqual(['owner.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('adopts a cleaned exact empty action container after final owner removal was interrupted', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-cleaned-empty-'));
    try {
      await seed(root);
      const inventory = await inventoryGcStore(ports, root);
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      const request = requestFor(root, inventory.objects[0]);
      const prepared = await reclaimGcStoreObject(ports, request);
      if (prepared.state !== 'prepared') throw new Error('prepare failed');
      const detached = await reclaimGcStoreObject(ports, {
        ...request,
        ...prepared,
        outcome: 'prepared',
      });
      if (detached.state !== 'detached') throw new Error('detach failed');
      const cleanupStarted = await reclaimGcStoreObject(ports, {
        ...request,
        ...detached,
        outcome: 'detached',
      });
      if (cleanupStarted.state !== 'cleanup-started') throw new Error('cleanup start failed');
      const cleaned = await reclaimGcStoreObject(ports, {
        ...request,
        ...cleanupStarted,
        outcome: 'cleanup-started',
      });
      if (cleaned.state !== 'cleaned') throw new Error('cleanup failed');
      let interrupted = false;
      const interruptedPorts = Object.assign(Object.create(ports) as typeof ports, {
        removeEmptyDirectory: async (target: string) => {
          if (!interrupted && target === request.containerPath) {
            interrupted = true;
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          await ports.removeEmptyDirectory?.(target);
        },
      });
      const failed = await finalizeGcStoreReclaim(interruptedPorts, {
        ...request,
        ...cleaned,
        outcome: 'cleaned',
      });
      expect(failed).toEqual({
        ok: false,
        reason: 'GC permission denied during tombstone metadata cleanup',
      });
      expect(await ports.listDir(request.containerPath)).toEqual([]);
      const recovery = {
        state: 'pending',
        path: '',
        record: {
          planId: request.planId,
          actions: [
            {
              ...request,
              path: request.object.path,
              contentHash: request.object.contentHash,
              modifiedAt: request.object.modifiedAt,
              ...cleaned,
              outcome: 'cleaned',
            },
          ],
        },
      } as unknown as Extract<GcRecoveryObservation, { readonly state: 'pending' }>;
      expect(await observeGcTombstones(ports, root, recovery)).toMatchObject({ state: 'safe' });
      expect(
        await finalizeGcStoreReclaim(ports, {
          ...request,
          ...cleaned,
          outcome: 'cleaned',
        }),
      ).toEqual({ ok: true });
      expect(await ports.pathKind(request.containerPath)).toBe('absent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses an owner container for an already-absent record outcome', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-already-absent-owner-'));
    try {
      await seed(root);
      const inventory = await inventoryGcStore(ports, root);
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      const request = requestFor(root, inventory.objects[0]);
      const prepared = await reclaimGcStoreObject(ports, request);
      if (prepared.state !== 'prepared') throw new Error('prepare failed');
      const recovery = {
        state: 'pending',
        path: '',
        record: {
          planId: request.planId,
          actions: [
            {
              ...request,
              path: request.object.path,
              contentHash: request.object.contentHash,
              modifiedAt: request.object.modifiedAt,
              logicalBytes: request.object.logicalBytes,
              outcome: 'already-absent',
              containerIdentity: null,
              payloadIdentity: null,
            },
          ],
        },
      } as unknown as Extract<GcRecoveryObservation, { readonly state: 'pending' }>;
      expect(await observeGcTombstones(ports, root, recovery)).toMatchObject({ state: 'refused' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('accepts empty completed plan namespaces and refuses planted action state', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-tombstone-observe-'));
    try {
      const completed = join(root, '.gc-tombstones', 'v1', id('a'));
      await mkdir(completed, { recursive: true, mode: 0o700 });
      expect(await observeGcTombstones(ports, root)).toMatchObject({ state: 'safe' });
      const planted = join(root, '.gc-tombstones', 'v1', 'planted');
      await mkdir(planted, { mode: 0o700 });
      expect(await observeGcTombstones(ports, root)).toMatchObject({
        state: 'refused',
        reason: expect.stringContaining('unexpected'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
