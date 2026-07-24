import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactLockImageFromBytesV1,
  artifactManifestImageFromBytesV1,
} from '../../src/artifacts/execution.ts';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import { createTestNodeLedgerWriter } from '../../src/artifacts/ledger-writer.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { encodeRetainedArtifactPreimageV1 } from '../../src/artifacts/retained-preimage-codec.ts';
import { emptyLedgerModel, readLedgerState } from '../../src/place/ledger.ts';
import {
  advanceLogicalTransaction,
  commitLogicalTransaction,
} from '../../src/place/logical-transactions.ts';
import { createOperationGroupId, createOperationId } from '../../src/planning/create.ts';
import type { ExecutableOperation } from '../../src/planning/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import {
  bindForwardUpdateArtifactHistoryV1,
  createForwardUpdateArtifactJournalSequenceV1,
} from '../../src/update/history.ts';

const encoder = new TextEncoder();
const startedAt = '2026-07-23T00:00:00.000Z';

const operationFor = (
  role: 'manifest' | 'lock',
  directory = '/workspace',
  variant = 'v2',
  beforeVariant: string | null = null,
): Readonly<{
  operation: ExecutableOperation;
  beforeBytes: Uint8Array;
  afterBytes: Uint8Array;
}> => {
  const path = join(directory, role === 'manifest' ? 'skillsmith.toml' : 'skillsmith.lock');
  const beforeBytes =
    role === 'manifest'
      ? encoder.encode(
          `version = 1\n\n[[skills]]\nname = "review"\nsource = "acme/review"\n${beforeVariant === null ? '' : `ref = "${beforeVariant}"\n`}tools = ["codex"]\nscope = "user"\n`,
        )
      : (() => {
          const serialized = serializePortableLock({
            version: 1,
            hashSchemaVersion: 1,
            manifestHash: `sha256:${(
              beforeVariant === null ? 'a' : beforeVariant === 'v2' ? 'b' : 'c'
            ).repeat(64)}` as ArtifactDigest,
            skills: [],
          });
          if (!serialized.ok) throw new TypeError('lock fixture is invalid');
          return encoder.encode(serialized.value);
        })();
  const afterBytes =
    role === 'manifest'
      ? encoder.encode(
          `version = 1\n\n[[skills]]\nname = "review"\nsource = "acme/review"\nref = "${variant}"\ntools = ["codex"]\nscope = "user"\n`,
        )
      : (() => {
          const serialized = serializePortableLock({
            version: 1,
            hashSchemaVersion: 1,
            manifestHash: `sha256:${(variant === 'v2' ? 'b' : 'c').repeat(64)}` as ArtifactDigest,
            skills: [],
          });
          if (!serialized.ok) throw new TypeError('lock fixture is invalid');
          return encoder.encode(serialized.value);
        })();
  const before =
    role === 'manifest'
      ? artifactManifestImageFromBytesV1(path, beforeBytes)
      : artifactLockImageFromBytesV1(path, beforeBytes);
  const after =
    role === 'manifest'
      ? artifactManifestImageFromBytesV1(path, afterBytes)
      : artifactLockImageFromBytesV1(path, afterBytes);
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'update',
    skill: 'review',
    source: null,
    scope: 'user',
    target: `fixture-${role}-${beforeVariant ?? 'initial'}-${variant}`,
  });
  const kind = role === 'manifest' ? 'write-manifest' : 'write-lock';
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind,
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  return {
    beforeBytes,
    afterBytes,
    operation: {
      operationId,
      groupId,
      pairId: null,
      kind,
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
      skill: null,
      source: null,
      tool: null,
      scope: null,
      before,
      after,
      reason: { code: 'fixture-update', message: 'Fixture update.' },
      selectionSource: 'explicit-targets',
      preconditionIds: [],
      requiredCheckIds: [],
      reversibility: {
        kind: 'conditional',
        retentionResourceIds: [`update-artifact-retention:v1:${role}`],
      },
      mutates: {
        live: false,
        manifest: role === 'manifest',
        lock: role === 'lock',
        ledger: false,
      },
      conflict: null,
    },
  };
};

const sequenceFor = (role: 'manifest' | 'lock') => {
  const fixture = operationFor(role);
  const afterDigest =
    fixture.operation.after.kind === 'manifest'
      ? fixture.operation.after.byteHash
      : fixture.operation.after.kind === 'lock'
        ? fixture.operation.after.canonicalHash
        : null;
  if (afterDigest === null) throw new TypeError('artifact fixture after image is invalid');
  const envelope = encodeRetainedArtifactPreimageV1({
    operationId: fixture.operation.operationId,
    role,
    path: role === 'manifest' ? '/workspace/skillsmith.toml' : '/workspace/skillsmith.lock',
    before: { bytes: fixture.beforeBytes, mode: 0o640 },
    after: { digest: afterDigest, mode: 0o640 },
  });
  if (!envelope.ok) throw new TypeError(envelope.error.message);
  const transactionId = `transaction:v1:${role}`;
  const sequence = createForwardUpdateArtifactJournalSequenceV1({
    operation: fixture.operation,
    transactionId,
    startedAt,
    retainedPath: `/data/.skillsmith-artifact-${transactionId}/${role}.backup`,
    retainedBytes: envelope.value.encoded,
    expectedAfterMode: 0o640,
  });
  if (!sequence.ok) throw new TypeError(sequence.error.message);
  return sequence.value;
};

describe('forward update artifact history', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test.each(['manifest', 'lock'] as const)(
    'advances exact %s retention through every adjacent durable journal phase',
    (role) => {
      const sequence = sequenceFor(role);
      expect(sequence.prepared.actual.retained).toEqual([]);
      expect(sequence.staged.actual.retained).toEqual([sequence.retained]);
      expect(sequence.retained).toMatchObject({
        role: 'backup',
        sourceRole: role,
        repositoryRevision: { kind: 'resource' },
        retainUntil: null,
      });
      expect(sequence.retained.repositoryRevision.digest).not.toBe(sequence.retained.contentHash);

      let model = emptyLedgerModel(startedAt);
      for (const journal of [
        sequence.prepared,
        sequence.staged,
        sequence.backedUp,
        sequence.live,
      ]) {
        const advanced = advanceLogicalTransaction(model, journal);
        expect(advanced.ok, journal.phase).toBeTrue();
        if (!advanced.ok) return;
        model = advanced.value;
      }
      const committed = commitLogicalTransaction(model, sequence.committed);
      expect(committed.ok).toBeTrue();
      if (committed.ok) {
        expect(committed.value.transactions).toEqual({});
        expect(committed.value.history).toEqual([sequence.committed]);
      }
    },
  );

  test('rejects retention enrichment outside the one exact prepared-to-staged exception', () => {
    const sequence = sequenceFor('manifest');
    const prepared = advanceLogicalTransaction(emptyLedgerModel(startedAt), sequence.prepared);
    expect(prepared.ok).toBeTrue();
    if (!prepared.ok) return;
    const wrongDigest = {
      ...sequence.staged,
      actual: {
        ...sequence.staged.actual,
        retained: [
          {
            ...sequence.retained,
            contentHash: `sha256:${'f'.repeat(64)}` as ArtifactDigest,
          },
        ],
      },
    };
    expect(advanceLogicalTransaction(prepared.value, wrongDigest)).toMatchObject({
      ok: false,
      error: { reason: 'identity-conflict' },
    });

    const staged = advanceLogicalTransaction(prepared.value, sequence.staged);
    expect(staged.ok).toBeTrue();
    if (!staged.ok) return;
    expect(
      advanceLogicalTransaction(staged.value, {
        ...sequence.backedUp,
        actual: { ...sequence.backedUp.actual, retained: [] },
      }),
    ).toMatchObject({ ok: false, error: { reason: 'identity-conflict' } });
  });

  test.each([false, true])(
    'abandons a superseded prepared carrier and its deterministic orphan (present=%s)',
    async (orphanPresent) => {
      const root = await mkdtemp(join(tmpdir(), 'skillsmith-update-history-orphan-'));
      roots.push(root);
      const ledgerPath = join(root, 'placements.json');
      const oldFixture = operationFor('manifest', root, 'v2');
      const oldAfter = oldFixture.operation.after;
      if (oldAfter.kind !== 'manifest') throw new TypeError('old fixture is not a manifest write');
      const oldEnvelope = encodeRetainedArtifactPreimageV1({
        operationId: oldFixture.operation.operationId,
        role: 'manifest',
        path: join(root, 'skillsmith.toml'),
        before: { bytes: oldFixture.beforeBytes, mode: 0o640 },
        after: { digest: oldAfter.byteHash, mode: 0o640 },
      });
      if (!oldEnvelope.ok) throw new TypeError(oldEnvelope.error.message);
      const oldTransactionId = 'transaction:v1:abandoned-prepared-manifest';
      const retainedPath = join(
        root,
        `.skillsmith-artifact-${oldTransactionId}`,
        'manifest.backup',
      );
      const oldSequence = createForwardUpdateArtifactJournalSequenceV1({
        operation: oldFixture.operation,
        transactionId: oldTransactionId,
        startedAt,
        retainedPath,
        retainedBytes: oldEnvelope.value.encoded,
        expectedAfterMode: 0o640,
      });
      if (!oldSequence.ok) throw new TypeError(oldSequence.error.message);
      const writer = await createTestNodeLedgerWriter(ledgerPath, {});
      const seeded = await writer.replace({
        model: {
          ...emptyLedgerModel(startedAt),
          transactions: { [oldTransactionId]: oldSequence.value.prepared },
        },
        expectedByteRevision: null,
      });
      if (!seeded.ok) throw new TypeError(JSON.stringify(seeded.error));
      await writeFile(join(root, 'skillsmith.toml'), oldFixture.beforeBytes);
      await chmod(join(root, 'skillsmith.toml'), 0o640);
      if (orphanPresent) {
        await mkdir(join(root, `.skillsmith-artifact-${oldTransactionId}`), { mode: 0o700 });
        await writeFile(retainedPath, oldEnvelope.value.encoded);
        await chmod(retainedPath, 0o600);
      }

      const nextFixture = operationFor('manifest', root, 'v3');
      const ports = await defaultRuntimePorts();
      const artifactCoordinator = await createTestNodeArtifactCoordinatorPorts(
        join(root, 'coordination'),
      );
      const physicalBinding = {
        operationId: nextFixture.operation.operationId,
        groupId: nextFixture.operation.groupId,
        pairId: null,
        unstartedForce: null,
        observeActualBefore: async () => nextFixture.operation.before,
        execute: async () => {
          await writeFile(join(root, 'skillsmith.toml'), nextFixture.afterBytes);
          await chmod(join(root, 'skillsmith.toml'), 0o640);
          return {
            operationId: nextFixture.operation.operationId,
            outcome: 'succeeded' as const,
            actualBefore: nextFixture.operation.before,
            actualAfter: nextFixture.operation.after,
            force: null,
            error: null,
          };
        },
      };
      const binding = bindForwardUpdateArtifactHistoryV1({
        operation: nextFixture.operation,
        binding: physicalBinding,
        artifactCoordinator,
        ports,
        ledgerPath,
      });
      const executed = await binding.execute({
        operationId: nextFixture.operation.operationId,
        groupId: nextFixture.operation.groupId,
        pairId: null,
        actualBefore: nextFixture.operation.before,
        unstartedForce: null,
        execute: physicalBinding.execute,
      });
      const durable = await readLedgerState(ports, ledgerPath);

      expect(executed).toMatchObject({ outcome: 'succeeded', error: null });
      expect(durable.ok).toBeTrue();
      if (!durable.ok || durable.value.state !== 'present') return;
      expect(durable.value.model.transactions[oldTransactionId]).toBeUndefined();
      expect(existsSync(retainedPath)).toBeFalse();
    },
    30_000,
  );

  test.each([
    [false, false],
    [true, false],
    [true, true],
  ] as const)(
    'handles a durable artifact cleanup marker after restart (envelope present=%s, workflow corrupted=%s)',
    async (envelopePresent, workflowCorrupted) => {
      const root = await mkdtemp(join(tmpdir(), 'skillsmith-update-history-cleanup-restart-'));
      roots.push(root);
      const ledgerPath = join(root, 'placements.json');
      const oldFixture = operationFor('manifest', root, 'v2');
      const oldAfter = oldFixture.operation.after;
      if (oldAfter.kind !== 'manifest') throw new TypeError('old fixture is not a manifest write');
      const oldEnvelope = encodeRetainedArtifactPreimageV1({
        operationId: oldFixture.operation.operationId,
        role: 'manifest',
        path: join(root, 'skillsmith.toml'),
        before: { bytes: oldFixture.beforeBytes, mode: 0o640 },
        after: { digest: oldAfter.byteHash, mode: 0o640 },
      });
      if (!oldEnvelope.ok) throw new TypeError(oldEnvelope.error.message);
      const oldTransactionId = `transaction:v1:cleanup-restart-${envelopePresent}`;
      const retainedPath = join(
        root,
        `.skillsmith-artifact-${oldTransactionId}`,
        'manifest.backup',
      );
      const oldSequence = createForwardUpdateArtifactJournalSequenceV1({
        operation: oldFixture.operation,
        transactionId: oldTransactionId,
        startedAt,
        retainedPath,
        retainedBytes: oldEnvelope.value.encoded,
        expectedAfterMode: 0o640,
      });
      if (!oldSequence.ok) throw new TypeError(oldSequence.error.message);
      const cleanupMarker = {
        ...oldSequence.value.staged,
        context: {
          ...oldSequence.value.staged.context,
          command: 'update',
          workflow: workflowCorrupted
            ? 'corrupt-update-artifact-orphan-cleanup'
            : 'update-artifact-orphan-cleanup',
          attempt: oldSequence.value.staged.context.attempt + 1,
        },
        disposition: 'rollback' as const,
        phase: 'prepared' as const,
        actual: {
          ...oldSequence.value.staged.actual,
          after: [],
          retained: [],
        },
        updatedAt: '2026-07-23T00:01:00.000Z',
        completedAt: null,
      };
      const writer = await createTestNodeLedgerWriter(ledgerPath, {});
      const seeded = await writer.replace({
        model: {
          ...emptyLedgerModel(startedAt),
          transactions: { [oldTransactionId]: cleanupMarker },
        },
        expectedByteRevision: null,
      });
      if (!seeded.ok) throw new TypeError(JSON.stringify(seeded.error));
      await writeFile(join(root, 'skillsmith.toml'), oldFixture.beforeBytes);
      await chmod(join(root, 'skillsmith.toml'), 0o640);
      if (envelopePresent) {
        await mkdir(join(root, `.skillsmith-artifact-${oldTransactionId}`), { mode: 0o700 });
        await writeFile(retainedPath, oldEnvelope.value.encoded);
        await chmod(retainedPath, 0o600);
      }

      const nextFixture = operationFor('manifest', root, 'v3');
      const ports = await defaultRuntimePorts();
      const artifactCoordinator = await createTestNodeArtifactCoordinatorPorts(
        join(root, 'coordination'),
      );
      let physicalExecutions = 0;
      const physicalBinding = {
        operationId: nextFixture.operation.operationId,
        groupId: nextFixture.operation.groupId,
        pairId: null,
        unstartedForce: null,
        observeActualBefore: async () => nextFixture.operation.before,
        execute: async () => {
          physicalExecutions += 1;
          if (workflowCorrupted) throw new TypeError('physical execution must not run');
          await writeFile(join(root, 'skillsmith.toml'), nextFixture.afterBytes);
          await chmod(join(root, 'skillsmith.toml'), 0o640);
          return {
            operationId: nextFixture.operation.operationId,
            outcome: 'succeeded' as const,
            actualBefore: nextFixture.operation.before,
            actualAfter: nextFixture.operation.after,
            force: null,
            error: null,
          };
        },
      };
      const binding = bindForwardUpdateArtifactHistoryV1({
        operation: nextFixture.operation,
        binding: physicalBinding,
        artifactCoordinator,
        ports,
        ledgerPath,
      });
      const executed = await binding.execute({
        operationId: nextFixture.operation.operationId,
        groupId: nextFixture.operation.groupId,
        pairId: null,
        actualBefore: nextFixture.operation.before,
        unstartedForce: null,
        execute: physicalBinding.execute,
      });
      const durable = await readLedgerState(ports, ledgerPath);

      expect(durable.ok).toBeTrue();
      if (!durable.ok || durable.value.state !== 'present') return;
      if (workflowCorrupted) {
        expect(executed).toMatchObject({
          outcome: 'failed',
          error: { code: 'update-artifact-history-failed' },
        });
        expect(physicalExecutions).toBe(0);
        expect([...new Uint8Array(await readFile(join(root, 'skillsmith.toml')))]).toEqual([
          ...oldFixture.beforeBytes,
        ]);
        expect(durable.value.model.transactions).toEqual({
          [oldTransactionId]: cleanupMarker,
        });
        expect(existsSync(retainedPath)).toBeTrue();
        return;
      }
      expect(executed).toMatchObject({ outcome: 'succeeded', error: null });
      expect(physicalExecutions).toBe(1);
      expect(durable.value.model.transactions[oldTransactionId]).toBeUndefined();
      expect(
        durable.value.model.history.find(({ transactionId }) => transactionId === oldTransactionId),
      ).toMatchObject({
        disposition: 'rollback',
        phase: 'committed',
        context: { command: 'update', workflow: 'update-artifact-orphan-cleanup' },
        actual: { retained: [] },
      });
      expect(existsSync(retainedPath)).toBeFalse();
    },
    30_000,
  );

  test.each(['envelope', 'command', 'workflow'] as const)(
    'refuses corrupted superseded %s authority before physical execution',
    async (corruption) => {
      const root = await mkdtemp(join(tmpdir(), 'skillsmith-update-history-corrupt-orphan-'));
      roots.push(root);
      const ledgerPath = join(root, 'placements.json');
      const oldFixture = operationFor('manifest', root, 'v2');
      const oldAfter = oldFixture.operation.after;
      if (oldAfter.kind !== 'manifest') throw new TypeError('old fixture is not a manifest write');
      const oldEnvelope = encodeRetainedArtifactPreimageV1({
        operationId: oldFixture.operation.operationId,
        role: 'manifest',
        path: join(root, 'skillsmith.toml'),
        before: { bytes: oldFixture.beforeBytes, mode: 0o640 },
        after: { digest: oldAfter.byteHash, mode: 0o640 },
      });
      if (!oldEnvelope.ok) throw new TypeError(oldEnvelope.error.message);
      const oldTransactionId = 'transaction:v1:corrupt-superseded-envelope';
      const retainedPath = join(
        root,
        `.skillsmith-artifact-${oldTransactionId}`,
        'manifest.backup',
      );
      const oldSequence = createForwardUpdateArtifactJournalSequenceV1({
        operation: oldFixture.operation,
        transactionId: oldTransactionId,
        startedAt,
        retainedPath,
        retainedBytes: oldEnvelope.value.encoded,
        expectedAfterMode: 0o640,
      });
      if (!oldSequence.ok) throw new TypeError(oldSequence.error.message);
      const writer = await createTestNodeLedgerWriter(ledgerPath, {});
      const pending =
        corruption === 'command'
          ? {
              ...oldSequence.value.staged,
              context: { ...oldSequence.value.staged.context, command: 'wrong-update-command' },
            }
          : corruption === 'workflow'
            ? {
                ...oldSequence.value.staged,
                context: {
                  ...oldSequence.value.staged.context,
                  workflow: 'corrupt-update-artifact-history',
                },
              }
            : oldSequence.value.staged;
      const seeded = await writer.replace({
        model: {
          ...emptyLedgerModel(startedAt),
          transactions: { [oldTransactionId]: pending },
        },
        expectedByteRevision: null,
      });
      if (!seeded.ok) throw new TypeError(JSON.stringify(seeded.error));
      await writeFile(join(root, 'skillsmith.toml'), oldFixture.beforeBytes);
      await chmod(join(root, 'skillsmith.toml'), 0o640);
      await mkdir(join(root, `.skillsmith-artifact-${oldTransactionId}`), { mode: 0o700 });
      await writeFile(
        retainedPath,
        corruption === 'envelope'
          ? encoder.encode('corrupt retained envelope')
          : oldEnvelope.value.encoded,
      );
      await chmod(retainedPath, 0o600);

      const nextFixture = operationFor('manifest', root, 'v3');
      const ports = await defaultRuntimePorts();
      const artifactCoordinator = await createTestNodeArtifactCoordinatorPorts(
        join(root, 'coordination'),
      );
      let physicalExecutions = 0;
      const physicalBinding = {
        operationId: nextFixture.operation.operationId,
        groupId: nextFixture.operation.groupId,
        pairId: null,
        unstartedForce: null,
        observeActualBefore: async () => nextFixture.operation.before,
        execute: async () => {
          physicalExecutions += 1;
          throw new TypeError('physical execution must not run');
        },
      };
      const binding = bindForwardUpdateArtifactHistoryV1({
        operation: nextFixture.operation,
        binding: physicalBinding,
        artifactCoordinator,
        ports,
        ledgerPath,
      });
      const executed = await binding.execute({
        operationId: nextFixture.operation.operationId,
        groupId: nextFixture.operation.groupId,
        pairId: null,
        actualBefore: nextFixture.operation.before,
        unstartedForce: null,
        execute: physicalBinding.execute,
      });
      const durable = await readLedgerState(ports, ledgerPath);

      expect(executed).toMatchObject({
        outcome: 'failed',
        error: { code: 'update-artifact-history-failed' },
      });
      expect(physicalExecutions).toBe(0);
      expect([...new Uint8Array(await readFile(join(root, 'skillsmith.toml')))]).toEqual([
        ...oldFixture.beforeBytes,
      ]);
      expect(durable.ok).toBeTrue();
      if (!durable.ok || durable.value.state !== 'present') return;
      expect(durable.value.model.transactions[oldTransactionId]).toEqual(pending);
      expect(existsSync(retainedPath)).toBeTrue();
    },
    30_000,
  );

  test.each([
    ['staged', 'before', 'rollback'],
    ['backed-up', 'before', 'rollback'],
    ['backed-up', 'after', 'forward'],
    ['live', 'after', 'forward'],
  ] as const)(
    'recovers a superseded %s carrier from its authenticated physical %s image',
    async (phase, physicalState, expectedDisposition) => {
      const root = await mkdtemp(join(tmpdir(), 'skillsmith-update-history-phase-'));
      roots.push(root);
      const ledgerPath = join(root, 'placements.json');
      const oldFixture = operationFor('manifest', root, 'v2');
      const oldAfter = oldFixture.operation.after;
      if (oldAfter.kind !== 'manifest') throw new TypeError('old fixture is not a manifest write');
      const oldEnvelope = encodeRetainedArtifactPreimageV1({
        operationId: oldFixture.operation.operationId,
        role: 'manifest',
        path: join(root, 'skillsmith.toml'),
        before: { bytes: oldFixture.beforeBytes, mode: 0o640 },
        after: { digest: oldAfter.byteHash, mode: 0o640 },
      });
      if (!oldEnvelope.ok) throw new TypeError(oldEnvelope.error.message);
      const oldTransactionId = `transaction:v1:superseded-${phase}-${physicalState}`;
      const retainedPath = join(
        root,
        `.skillsmith-artifact-${oldTransactionId}`,
        'manifest.backup',
      );
      const oldSequence = createForwardUpdateArtifactJournalSequenceV1({
        operation: oldFixture.operation,
        transactionId: oldTransactionId,
        startedAt,
        retainedPath,
        retainedBytes: oldEnvelope.value.encoded,
        expectedAfterMode: 0o640,
      });
      if (!oldSequence.ok) throw new TypeError(oldSequence.error.message);
      const pending =
        phase === 'staged'
          ? oldSequence.value.staged
          : phase === 'backed-up'
            ? oldSequence.value.backedUp
            : oldSequence.value.live;
      const writer = await createTestNodeLedgerWriter(ledgerPath, {});
      const seeded = await writer.replace({
        model: {
          ...emptyLedgerModel(startedAt),
          transactions: { [oldTransactionId]: pending },
        },
        expectedByteRevision: null,
      });
      if (!seeded.ok) throw new TypeError(JSON.stringify(seeded.error));
      await writeFile(
        join(root, 'skillsmith.toml'),
        physicalState === 'before' ? oldFixture.beforeBytes : oldFixture.afterBytes,
      );
      await chmod(join(root, 'skillsmith.toml'), 0o640);
      await mkdir(join(root, `.skillsmith-artifact-${oldTransactionId}`), { mode: 0o700 });
      await writeFile(retainedPath, oldEnvelope.value.encoded);
      await chmod(retainedPath, 0o600);

      const nextFixture = operationFor(
        'manifest',
        root,
        'v3',
        physicalState === 'after' ? 'v2' : null,
      );
      const ports = await defaultRuntimePorts();
      const artifactCoordinator = await createTestNodeArtifactCoordinatorPorts(
        join(root, 'coordination'),
      );
      const physicalBinding = {
        operationId: nextFixture.operation.operationId,
        groupId: nextFixture.operation.groupId,
        pairId: null,
        unstartedForce: null,
        observeActualBefore: async () => nextFixture.operation.before,
        execute: async () => {
          await writeFile(join(root, 'skillsmith.toml'), nextFixture.afterBytes);
          await chmod(join(root, 'skillsmith.toml'), 0o640);
          return {
            operationId: nextFixture.operation.operationId,
            outcome: 'succeeded' as const,
            actualBefore: nextFixture.operation.before,
            actualAfter: nextFixture.operation.after,
            force: null,
            error: null,
          };
        },
      };
      const binding = bindForwardUpdateArtifactHistoryV1({
        operation: nextFixture.operation,
        binding: physicalBinding,
        artifactCoordinator,
        ports,
        ledgerPath,
      });
      const executed = await binding.execute({
        operationId: nextFixture.operation.operationId,
        groupId: nextFixture.operation.groupId,
        pairId: null,
        actualBefore: nextFixture.operation.before,
        unstartedForce: null,
        execute: physicalBinding.execute,
      });
      const durable = await readLedgerState(ports, ledgerPath);

      expect(executed).toMatchObject({ outcome: 'succeeded', error: null });
      expect(durable.ok).toBeTrue();
      if (!durable.ok || durable.value.state !== 'present') return;
      expect(durable.value.model.transactions[oldTransactionId]).toBeUndefined();
      expect(
        durable.value.model.history.find(({ transactionId }) => transactionId === oldTransactionId)
          ?.disposition,
      ).toBe(expectedDisposition);
      expect(existsSync(retainedPath)).toBe(expectedDisposition === 'forward');
    },
    30_000,
  );
});
