import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryGcStore } from '../../src/gc/inventory.ts';
import { observeGcTombstones, reclaimGcStoreObject } from '../../src/gc/repository.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const id = (character: string): string => character.repeat(64);

const seed = async (root: string): Promise<string> => {
  const path = join(root, 'fixture', 'repo@0123456789ab', 'review');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), 'review');
  return path;
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
      const result = await reclaimGcStoreObject(ports, {
        storeRoot: root,
        planId: id('a'),
        actionId: id('b'),
        ownershipToken: id('c'),
        object: selected,
      });
      expect(result).toEqual({ state: 'cleaned', logicalBytes: selected.logicalBytes });
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
      const result = await reclaimGcStoreObject(ports, {
        storeRoot: root,
        planId: id('a'),
        actionId: id('b'),
        ownershipToken: id('c'),
        object: inventory.objects[0],
      });
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
      const result = await reclaimGcStoreObject(ports, {
        storeRoot: root,
        planId: id('a'),
        actionId: id('b'),
        ownershipToken: id('c'),
        object: inventory.objects[0],
      });
      expect(result).toMatchObject({ state: 'refused' });
      expect(await ports.pathKind(path)).toBe('dir');
      expect(await ports.pathKind(join(root, '.gc-tombstones'))).toBe('absent');
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
