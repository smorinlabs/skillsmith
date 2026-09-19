import { describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryGcStore } from '../../src/gc/inventory.ts';
import { contentHashOf } from '../../src/place/store.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

describe('GC store inventory', () => {
  test('treats an absent configured root as an immutable empty inventory', async () => {
    const ports = await defaultRuntimePorts();
    const root = join(tmpdir(), `skillsmith-gc-absent-${crypto.randomUUID()}`);
    const inventory = await inventoryGcStore(ports, root);
    expect(inventory).toEqual({
      state: 'ok',
      root,
      rootIdentity: null,
      objects: [],
      issues: [],
    });
    expect(Object.isFrozen(inventory)).toBeTrue();
  });

  test('accepts final revision suffixes, current publisher basenames, and exact logical bytes', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-inventory-'));
    const first = join(root, 'local', 'my repo@content-0123456789ab', 'review');
    const second = join(root, 'local', 'acme@tools@abcdefabcdef', 'lint');
    try {
      await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
      await Promise.all([
        writeFile(join(first, 'SKILL.md'), 'review'),
        writeFile(join(first, 'payload.txt'), 'abc'),
        symlink('payload.txt', join(first, 'alias')),
        writeFile(join(second, 'SKILL.md'), 'lint'),
        mkdir(join(root, '.staging', 'ignored'), { recursive: true }),
        mkdir(join(root, '.gc-tombstones'), { recursive: true }),
      ]);
      const expectedHash = await contentHashOf(ports, first);
      if (!expectedHash.ok) throw new Error(`content hash failed: ${expectedHash.error.code}`);
      const inventory = await inventoryGcStore(ports, root);
      expect(inventory.state).toBe('ok');
      if (inventory.state !== 'ok') throw new Error('valid inventory was refused');
      expect(inventory.objects).toHaveLength(2);
      expect(inventory.objects.find(({ path }) => path === first)).toMatchObject({
        path: first,
        namespace: 'local',
        repository: 'my repo',
        revision: 'content-0123456789ab',
        skill: 'review',
        contentHash: expectedHash.value,
        logicalBytes: 6 + 3 + 'payload.txt'.length,
      });
      expect(inventory.objects.find(({ path }) => path === second)).toMatchObject({
        path: second,
        repository: 'acme@tools',
        revision: 'abcdefabcdef',
      });
      expect(JSON.stringify(inventory)).not.toContain('.staging/ignored');
      expect(inventory.objects.every(({ entries }) => Object.isFrozen(entries))).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails the whole inventory closed for unknown layout, escaping links, and hard links', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-unsafe-'));
    const safe = join(root, 'fixture', 'repo@0123456789ab', 'safe');
    const hard = join(root, 'fixture', 'repo@0123456789ab', 'hard');
    const escaping = join(root, 'fixture', 'repo@0123456789ab', 'escaping');
    try {
      await Promise.all([
        mkdir(safe, { recursive: true }),
        mkdir(hard, { recursive: true }),
        mkdir(escaping, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(safe, 'SKILL.md'), 'safe'),
        writeFile(join(hard, 'SKILL.md'), 'hard'),
        writeFile(join(escaping, 'SKILL.md'), 'escaping'),
      ]);
      await link(join(hard, 'SKILL.md'), join(hard, 'duplicate'));
      await symlink('../../../../outside', join(escaping, 'escape'));
      await writeFile(join(root, 'unexpected'), 'not a namespace directory');
      const inventory = await inventoryGcStore(ports, root);
      expect(inventory.state).toBe('refused');
      if (inventory.state !== 'refused') throw new Error('unsafe inventory was accepted');
      expect(inventory.objects).toEqual([]);
      expect(inventory.issues.map(({ code }) => code)).toEqual(
        expect.arrayContaining(['unsafe-hard-link', 'unsafe-symlink', 'unsafe-layout']),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
