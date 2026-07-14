import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArtifactPairRecoveryRecord,
  ArtifactRecoveryDirectory,
  ArtifactRecoveryObject,
} from '../../src/artifacts/coordinator-types.ts';
import {
  artifactRecoveryKey,
  createFileArtifactRecoveryPort,
} from '../../src/artifacts/recovery-file.ts';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const record = (path: string): ArtifactPairRecoveryRecord =>
  Object.freeze({
    kind: 'skillsmith-artifact-pair-recovery',
    version: 1,
    key: artifactRecoveryKey(path, null),
    transactionId: '0000000000000001',
    attempt: 1,
    disposition: 'forward',
    pair: Object.freeze({ manifest: path, lock: null }),
    memberTargets: Object.freeze([path]),
    cursor: 'prepared',
    parents: Object.freeze({
      manifest: Object.freeze({ path: '/tmp', identity: 'parent-1' }),
      lock: null,
    }),
    before: Object.freeze({ manifest: Object.freeze({ state: 'absent' }), lock: null }),
    after: Object.freeze({ manifest: Object.freeze({ state: 'absent' }), lock: null }),
    rollbackTarget: Object.freeze({ manifest: Object.freeze({ state: 'absent' }), lock: null }),
    directories: Object.freeze([]),
    objects: Object.freeze([]),
    collisionPaths: Object.freeze([]),
  });

const changedRecord = (path: string): ArtifactPairRecoveryRecord => {
  const base = record(path);
  const transactionId = base.transactionId;
  const directoryPath = join('/tmp', `.skillsmith-artifact-${transactionId}`);
  const afterDigest = `sha256:${'1'.repeat(64)}` as never;
  return Object.freeze({
    ...base,
    after: Object.freeze({
      manifest: Object.freeze({
        state: 'file' as const,
        digest: afterDigest,
        mode: 0o600,
        identity: null,
      }),
      lock: null,
    }),
    directories: Object.freeze([
      Object.freeze({
        purpose: 'transaction' as const,
        path: directoryPath,
        before: 'absent' as const,
        ownershipToken: 'a'.repeat(64),
        identity: null,
      }),
    ]),
    objects: Object.freeze([
      Object.freeze({
        role: 'manifest' as const,
        slot: 'stage' as const,
        path: join(directoryPath, 'manifest.stage'),
        expectedDigest: afterDigest,
        expectedMode: 0o600,
        identity: null,
      }),
    ]),
  });
};

const rollbackCaptureRecord = (path: string): ArtifactPairRecoveryRecord => {
  const base = changedRecord(path);
  const baseDirectory = base.directories[0] as ArtifactRecoveryDirectory;
  const baseStage = base.objects[0] as ArtifactRecoveryObject;
  const directory = Object.freeze({ ...baseDirectory, identity: 'directory-1' });
  const beforeDigest = `sha256:${'2'.repeat(64)}` as never;
  const after = Object.freeze({
    state: 'file' as const,
    digest: (
      base.after.manifest as Extract<
        ArtifactPairRecoveryRecord['after']['manifest'],
        { readonly state: 'file' }
      >
    ).digest,
    mode: 0o600,
    identity: 'installed-1',
  });
  const before = Object.freeze({
    state: 'file' as const,
    digest: beforeDigest,
    mode: 0o640,
    identity: 'before-1',
  });
  return Object.freeze({
    ...base,
    disposition: 'rollback',
    cursor: 'rollback-manifest-remove',
    before: Object.freeze({ manifest: before, lock: null }),
    after: Object.freeze({ manifest: after, lock: null }),
    rollbackTarget: Object.freeze({ manifest: before, lock: null }),
    directories: Object.freeze([directory]),
    objects: Object.freeze([
      Object.freeze({
        ...baseStage,
        identity: after.identity,
      }),
      Object.freeze({
        role: 'manifest' as const,
        slot: 'backup' as const,
        path: join(directory.path, 'manifest.backup'),
        expectedDigest: before.digest,
        expectedMode: before.mode,
        identity: before.identity,
      }),
      Object.freeze({
        role: 'manifest' as const,
        slot: 'discard' as const,
        path: join(directory.path, 'manifest.discard'),
        expectedDigest: after.digest,
        expectedMode: after.mode,
        identity: after.identity,
      }),
    ]),
  });
};

describe('private artifact recovery file', () => {
  test('creates, strictly discovers, CAS-replaces, and revision-checks removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-'));
    roots.push(root);
    let id = 1;
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => (id++).toString(16).padStart(16, '0'),
    });
    const initial = await port.create(record('/tmp/config.toml'));
    expect(initial.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await port.discover()).toEqual([initial]);

    const staging = Object.freeze({ ...initial.record, cursor: 'staging' as const });
    const replaced = await port.replace(staging, initial.revision);
    expect(replaced.revision).not.toBe(initial.revision);
    await expect(port.remove(staging.key, initial.revision)).rejects.toMatchObject({
      reason: 'recovery-record-invalid',
    });
    await port.remove(staging.key, replaced.revision);
    expect(await port.discover()).toEqual([]);
  });

  test('exposes a closed awaited recovery physical-step transcript only to tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-physical-'));
    roots.push(root);
    const steps: string[] = [];
    let id = 1;
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => (id++).toString(16).padStart(16, '0'),
      afterPhysicalStep: async ({ area, step }) => {
        steps.push(`${area}:${step}`);
      },
    });
    const initial = await port.create(record('/tmp/config.toml'));
    const staging = await port.replace(
      Object.freeze({ ...initial.record, cursor: 'staging' as const }),
      initial.revision,
    );
    await port.remove(staging.record.key, staging.revision);

    expect(steps).toEqual([
      'recovery:record-opened',
      'recovery:record-written',
      'recovery:record-fsynced',
      'recovery:directory-fsynced',
      'recovery:temp-opened',
      'recovery:temp-written',
      'recovery:temp-fsynced',
      'recovery:temp-renamed',
      'recovery:directory-fsynced',
      'recovery:file-unlinked',
      'recovery:directory-fsynced',
    ]);
  });

  test('rejects non-monotonic cursor and committed-fact changes under CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-transition-'));
    roots.push(root);
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => '0000000000000001',
    });
    const initial = await port.create(record('/tmp/config.toml'));
    const forged = Object.freeze({
      ...initial.record,
      cursor: 'committed' as const,
      after: Object.freeze({
        manifest: Object.freeze({
          state: 'file' as const,
          digest: `sha256:${'0'.repeat(64)}` as never,
          mode: 0o600,
          identity: 'forged',
        }),
        lock: null,
      }),
    });
    await expect(port.replace(forged, initial.revision)).rejects.toMatchObject({
      reason: 'recovery-record-invalid',
    });
  });

  test('constrains prepared attempt advancement to fresh candidates and stable content facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-attempt-transition-'));
    roots.push(root);
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => '0000000000000001',
    });
    const initial = await port.create(changedRecord('/tmp/config.toml'));
    const initialDirectory = initial.record.directories[0] as ArtifactRecoveryDirectory;
    const initialStage = initial.record.objects[0] as ArtifactRecoveryObject;
    const nextTransactionId = '0000000000000002';
    const nextDirectory = join('/tmp', `.skillsmith-artifact-${nextTransactionId}`);
    const advanced: ArtifactPairRecoveryRecord = Object.freeze({
      ...initial.record,
      transactionId: nextTransactionId,
      attempt: 2 as const,
      directories: Object.freeze([
        Object.freeze({
          ...initialDirectory,
          path: nextDirectory,
          ownershipToken: 'b'.repeat(64),
          identity: null,
        }),
      ]),
      objects: Object.freeze([
        Object.freeze({
          ...initialStage,
          path: join(nextDirectory, 'manifest.stage'),
          identity: null,
        }),
      ]),
      collisionPaths: Object.freeze([initialDirectory.path]),
    });
    const forgedDigest = `sha256:${'3'.repeat(64)}` as never;
    const forged: ArtifactPairRecoveryRecord = Object.freeze({
      ...advanced,
      after: Object.freeze({
        manifest: Object.freeze({
          state: 'file' as const,
          digest: forgedDigest,
          mode: 0o644,
          identity: null,
        }),
        lock: null,
      }),
      objects: Object.freeze([
        Object.freeze({
          ...(advanced.objects[0] as ArtifactRecoveryObject),
          expectedDigest: forgedDigest,
          expectedMode: 0o644,
        }),
      ]),
    });

    await expect(port.replace(forged, initial.revision)).rejects.toMatchObject({
      reason: 'recovery-record-invalid',
    });
    const replaced = await port.replace(advanced, initial.revision);
    expect(replaced.record.attempt).toBe(2);
    expect(replaced.record.after).toEqual(initial.record.after);
  });

  test('allows only an exact rollback discard capture to update its rollback target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-rollback-capture-'));
    roots.push(root);
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => '0000000000000001',
    });
    const initial = await port.create(rollbackCaptureRecord('/tmp/config.toml'));
    const capturedTarget = Object.freeze({
      state: 'file' as const,
      digest: `sha256:${'4'.repeat(64)}` as never,
      mode: 0o604,
      identity: 'external-2',
    });
    const capturedObjects = initial.record.objects.map((object) =>
      object.slot === 'discard'
        ? Object.freeze({
            ...object,
            expectedDigest: capturedTarget.digest,
            expectedMode: capturedTarget.mode,
            identity: capturedTarget.identity,
          })
        : object,
    );
    const captured = Object.freeze({
      ...initial.record,
      rollbackTarget: Object.freeze({ manifest: capturedTarget, lock: null }),
      objects: Object.freeze(capturedObjects),
    });
    const targetOnly = Object.freeze({
      ...captured,
      objects: initial.record.objects,
    });
    const unrelatedObjectChange = Object.freeze({
      ...captured,
      objects: Object.freeze(
        captured.objects.map((object) =>
          object.slot === 'backup'
            ? Object.freeze({ ...object, identity: 'forged-backup' })
            : object,
        ),
      ),
    });

    await expect(port.replace(targetOnly, initial.revision)).rejects.toMatchObject({
      reason: 'recovery-record-invalid',
    });
    await expect(port.replace(unrelatedObjectChange, initial.revision)).rejects.toMatchObject({
      reason: 'recovery-record-invalid',
    });
    const replaced = await port.replace(captured, initial.revision);
    expect(replaced.record.rollbackTarget.manifest).toEqual(capturedTarget);
    expect(replaced.record.objects.find((object) => object.slot === 'discard')).toMatchObject({
      expectedDigest: capturedTarget.digest,
      expectedMode: capturedTarget.mode,
      identity: capturedTarget.identity,
    });
  });

  test('derives every authority path from the pair and fixed transaction grammar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-authority-'));
    roots.push(root);
    let id = 1;
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => (id++).toString(16).padStart(16, '0'),
    });
    const baseline = record('/tmp/config.toml');
    const hostile = [
      Object.freeze({
        ...baseline,
        parents: Object.freeze({
          ...baseline.parents,
          manifest: Object.freeze({ path: '/not-parent', identity: 'parent-1' }),
        }),
      }),
      Object.freeze({ ...baseline, memberTargets: Object.freeze(['/tmp/config.toml', '/tmp/x']) }),
      Object.freeze({
        ...baseline,
        directories: Object.freeze([
          Object.freeze({
            purpose: 'transaction' as const,
            path: '/var/tmp/.skillsmith-artifact-0000000000000001',
            before: 'absent' as const,
            ownershipToken: 'a'.repeat(64),
            identity: null,
          }),
        ]),
      }),
      Object.freeze({
        ...baseline,
        objects: Object.freeze([
          Object.freeze({
            role: 'manifest' as const,
            slot: 'stage' as const,
            path: '/tmp/unrelated.stage',
            expectedDigest: `sha256:${'0'.repeat(64)}` as never,
            expectedMode: 0o600,
            identity: null,
          }),
        ]),
      }),
    ];
    for (const candidate of hostile) {
      await expect(port.create(candidate)).rejects.toMatchObject({
        reason: 'recovery-record-invalid',
      });
    }
    expect(await port.discover()).toEqual([]);
  });

  test('rejects forged rollback targets and cleanup jumps under CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-rollback-forgery-'));
    roots.push(root);
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => '0000000000000001',
    });
    const initial = await port.create(record('/tmp/config.toml'));
    const forged = Object.freeze({
      ...initial.record,
      disposition: 'rollback' as const,
      cursor: 'rollback-manifest-remove' as const,
      rollbackTarget: Object.freeze({
        manifest: Object.freeze({
          state: 'file' as const,
          digest: `sha256:${'0'.repeat(64)}` as never,
          mode: 0o600,
          identity: 'forged',
        }),
        lock: null,
      }),
    });
    await expect(port.replace(forged, initial.revision)).rejects.toMatchObject({
      reason: 'recovery-record-invalid',
    });
  });

  test('does not follow a symlinked recovery record during discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-record-symlink-'));
    roots.push(root);
    const directory = join(root, 'records');
    const port = createFileArtifactRecoveryPort(directory, {
      nextCasId: () => '0000000000000001',
    });
    const created = await port.create(record('/tmp/config.toml'));
    const live = join(directory, `${created.record.key}.json`);
    const outside = join(root, 'outside.json');
    await rename(live, outside);
    await symlink(outside, live);

    await expect(port.discover()).rejects.toMatchObject({ reason: 'recovery-record-invalid' });
  });

  test('rejects repeated CAS IDs before forming a second temporary path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-cas-id-'));
    roots.push(root);
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => '0000000000000001',
    });
    const initial = await port.create(record('/tmp/config.toml'));
    const staging = await port.replace(
      Object.freeze({ ...initial.record, cursor: 'staging' as const }),
      initial.revision,
    );

    await expect(
      port.replace(
        Object.freeze({ ...staging.record, cursor: 'final-guard' as const }),
        staging.revision,
      ),
    ).rejects.toMatchObject({ reason: 'recovery-record-invalid' });
    expect((await port.discover()).map(({ revision }) => revision)).toEqual([staging.revision]);
  });

  test('rejects unknown fields and pair/key collisions before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-invalid-'));
    roots.push(root);
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => '0000000000000001',
    });
    const invalid = { ...record('/tmp/config.toml'), secret: 'must-not-persist' };
    await expect(port.create(invalid as ArtifactPairRecoveryRecord)).rejects.toMatchObject({
      reason: 'recovery-record-invalid',
    });
  });

  test('rejects sensitive and redacted record fields before writing recovery state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-sink-'));
    roots.push(root);
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => '0000000000000001',
    });

    for (const collisionPath of ['/tmp/api_key=sk-example-secret-material', '/tmp/[REDACTED]']) {
      const candidate = Object.freeze({
        ...record('/tmp/config.toml'),
        collisionPaths: Object.freeze([collisionPath]),
      });
      await expect(port.create(candidate)).rejects.toMatchObject({
        reason: 'recovery-record-invalid',
      });
      try {
        await port.create(candidate);
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain(collisionPath);
      }
    }

    expect(await port.discover()).toEqual([]);
  });

  test('rejects an arbitrary CAS ID without handler or coercion access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-recovery-hostile-cas-id-'));
    roots.push(root);
    let interactions = 0;
    const hostileId = new Proxy(Object.create(null) as Record<string, unknown>, {
      get: () => {
        interactions += 1;
        return () => '0000000000000001';
      },
      getOwnPropertyDescriptor: () => {
        interactions += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        interactions += 1;
        return null;
      },
      has: () => {
        interactions += 1;
        return true;
      },
      ownKeys: () => {
        interactions += 1;
        return [];
      },
    });
    const port = createFileArtifactRecoveryPort(join(root, 'records'), {
      nextCasId: () => hostileId as unknown as string,
    });
    const initial = await port.create(record('/tmp/config.toml'));

    await expect(
      port.replace(
        Object.freeze({ ...initial.record, cursor: 'staging' as const }),
        initial.revision,
      ),
    ).rejects.toMatchObject({ reason: 'recovery-record-invalid' });
    expect(interactions).toBe(0);
  });
});
