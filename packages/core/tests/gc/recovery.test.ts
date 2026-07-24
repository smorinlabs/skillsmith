import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGcRecoveryRecord,
  gcRecoveryRevision,
  observeGcRecovery,
  removeGcRecoveryRecord,
  replaceGcRecoveryRecord,
} from '../../src/gc/recovery.ts';
import type { GcRecoveryRecordV1 } from '../../src/gc/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const id = (character: string): string => character.repeat(64);

const record = (root: string, phase: GcRecoveryRecordV1['phase']): GcRecoveryRecordV1 => {
  const seed = {
    schemaVersion: 1 as const,
    kind: 'skillsmith.gc-recovery' as const,
    planId: id('a'),
    requestDigest: id('b'),
    phase,
    retryArguments: ['gc', '--yes'],
    actions: [
      {
        actionId: id('c'),
        kind: 'reclaim-store' as const,
        path: join(root, 'store', 'fixture', 'repo@0123456789ab', 'review'),
        contentHash: `sha256:${id('d')}`,
        modifiedAt: 1,
        logicalBytes: 10,
        ownershipToken: id('e'),
        containerPath: join(root, 'store', '.gc-tombstones', 'v1', id('a'), id('c')),
        payloadPath: join(root, 'store', '.gc-tombstones', 'v1', id('a'), id('c'), 'payload'),
        outcome: phase === 'complete' ? ('cleaned' as const) : ('pending' as const),
      },
    ],
  };
  return Object.freeze({ ...seed, revision: gcRecoveryRevision(seed) });
};

describe('GC private recovery repository', () => {
  test('observes absence without creating directories or lock state', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-recovery-read-'));
    try {
      const before = await ports.listDir(root);
      expect(await observeGcRecovery(ports, root)).toEqual({
        state: 'none',
        record: null,
        path: join(root, '.gc-recovery', 'v1'),
      });
      expect(await ports.listDir(root)).toEqual(before);
      expect(await ports.pathKind(join(root, '.gc-recovery'))).toBe('absent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('publishes, CAS-replaces, discovers, and removes owner-only canonical records', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-recovery-cas-'));
    try {
      await chmod(root, 0o700);
      const initialRecord = record(root, 'approved');
      const created = await createGcRecoveryRecord(ports, root, initialRecord);
      expect(created.state).toBe('pending');
      if (created.state !== 'pending') throw new Error(`recovery create failed: ${created.state}`);
      expect((await stat(join(root, '.gc-recovery'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, '.gc-recovery', 'v1'))).mode & 0o777).toBe(0o700);
      expect((await stat(created.path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(created.path, 'utf8'))).toEqual(initialRecord);

      const nextSeed = { ...initialRecord, phase: 'reclaiming' as const };
      const next = Object.freeze({ ...nextSeed, revision: gcRecoveryRevision(nextSeed) });
      const replaced = await replaceGcRecoveryRecord(ports, created, next);
      expect(replaced.state).toBe('pending');
      if (replaced.state !== 'pending')
        throw new Error(`recovery replace failed: ${replaced.state}`);
      expect(await observeGcRecovery(ports, root)).toEqual(replaced);
      expect(await ports.listDir(join(root, '.gc-recovery', 'v1'))).toEqual([
        `${initialRecord.planId}.json`,
      ]);
      expect(await removeGcRecoveryRecord(ports, replaced)).toBeTrue();
      expect(await observeGcRecovery(ports, root)).toMatchObject({ state: 'none' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses unsafe data ownership modes and malformed planted recovery state', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-recovery-unsafe-'));
    try {
      await chmod(root, 0o777);
      expect(await createGcRecoveryRecord(ports, root, record(root, 'approved'))).toMatchObject({
        state: 'refused',
        reason: expect.stringContaining('data directory'),
      });
      await chmod(root, 0o700);
      const recovery = join(root, '.gc-recovery', 'v1');
      await mkdir(recovery, { recursive: true, mode: 0o700 });
      await writeFile(join(recovery, `${id('a')}.json`), '{}\n', { mode: 0o600 });
      expect(await observeGcRecovery(ports, root)).toMatchObject({
        state: 'refused',
        reason: expect.stringContaining('malformed'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
