import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type { GcReportV1Dto } from '../../src/contracts/v1/gc.ts';
import { gcRequestDigest } from '../../src/gc/plan.ts';
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

const approvedReport = (root: string): GcReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.gc',
  command: 'gc',
  mode: 'dry-run',
  state: 'planned',
  planId: id('a'),
  selectionSource: 'bounded-default',
  project: { effectiveCwd: root, root, identity: root },
  migration: { sourceVersion: null, action: 'none', outcome: 'not-required' },
  olderThan: null,
  approval: { required: true, outcome: 'pending' },
  recovery: { state: 'none', phase: null },
  projects: [],
  objects: [
    {
      id: 'object',
      kind: 'store',
      path: join(root, 'store', 'fixture', 'repo@0123456789ab', 'review'),
      contentHash: `sha256:${id('d')}`,
      modifiedAt: 1,
      logicalBytes: 10,
      protection: [],
      ageEligible: true,
      outcome: 'eligible',
      reason: null,
    },
  ],
  actions: [
    {
      actionId: id('c'),
      kind: 'reclaim-store',
      target: join(root, 'store', 'fixture', 'repo@0123456789ab', 'review'),
      logicalBytes: 10,
      dependencyIds: [],
      outcome: 'planned',
      reason: null,
    },
  ],
  results: [],
  checks: [{ code: 'gc-safe', outcome: 'passed', message: 'safe' }],
  diagnostics: [],
  summary: {
    observedItems: 1,
    protectedItems: 0,
    ageFilteredItems: 0,
    eligibleItems: 1,
    eligibleBytes: 10,
    forgottenProjects: 0,
    reclaimedItems: 0,
    reclaimedBytes: 0,
    refusedItems: 0,
    failedItems: 0,
  },
});

const record = (root: string, phase: GcRecoveryRecordV1['phase']): GcRecoveryRecordV1 => {
  const objectPath = join(root, 'store', 'fixture', 'repo@0123456789ab', 'review');
  const object = {
    id: 'object',
    kind: 'store' as const,
    path: objectPath,
    relativePath: 'fixture/repo@0123456789ab/review',
    namespace: 'fixture',
    repository: 'repo',
    revision: '0123456789ab',
    skill: 'review',
    contentHash: `sha256:${id('d')}` as ArtifactDigest,
    modifiedAt: 1,
    logicalBytes: 10,
    rootIdentity: 'root-id',
    namespaceIdentity: 'namespace-id',
    repositoryIdentity: 'repository-id',
    directoryIdentity: 'directory-id',
    directoryLinkCount: 2,
    entries: [],
  };
  const seed = {
    schemaVersion: 1 as const,
    kind: 'skillsmith.gc-recovery' as const,
    planId: id('a'),
    requestDigest: gcRequestDigest(null, []),
    phase,
    dataDir: root,
    storeRoot: join(root, 'store'),
    ledgerPath: join(root, 'placements.json'),
    retryArguments: ['gc', '--yes'],
    sourceLedger: {
      state: 'absent' as const,
      sourceVersion: null,
      byteRevision: null,
      semanticRevision: null,
    },
    normalizedForgetRoots: [],
    migrationUpdatedAt: null,
    expectedMigrationSemanticRevision: null,
    forgetUpdatedAt: null,
    expectedPostForgetSemanticRevision: null,
    nowMilliseconds: 1,
    olderThanMilliseconds: null,
    approvedReport: approvedReport(root),
    actions: [
      {
        actionId: id('c'),
        kind: 'reclaim-store' as const,
        path: objectPath,
        contentHash: `sha256:${id('d')}`,
        modifiedAt: 1,
        logicalBytes: 10,
        object,
        ownershipToken: id('e'),
        containerPath: join(root, 'store', '.gc-tombstones', 'v1', id('a'), id('c')),
        payloadPath: join(root, 'store', '.gc-tombstones', 'v1', id('a'), id('c'), 'payload'),
        containerIdentity: phase === 'complete' ? 'container-id' : null,
        payloadIdentity: phase === 'complete' ? 'directory-id' : null,
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

      const { revision: _revision, ...initialSeed } = initialRecord;
      const nextSeed = { ...initialSeed, phase: 'migration-complete' as const };
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
