import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withArtifactGroupLock } from '../../src/artifacts/coordinator.ts';
import { artifactLockImageFromBytesV1 } from '../../src/artifacts/execution.ts';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { normalizeManifestDocument, readManifestSource } from '../../src/artifacts/manifest.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import {
  decodeRetainedArtifactPreimageV1,
  encodeRetainedArtifactPreimageV1,
} from '../../src/artifacts/retained-preimage-codec.ts';
import type { ValidatedExecutionBinding } from '../../src/execution/types.ts';
import { emptyLedgerModel, readLedgerState, writeLedger } from '../../src/place/ledger.ts';
import {
  advanceLogicalTransaction,
  commitLogicalTransaction,
} from '../../src/place/logical-transactions.ts';
import { createOperationGroupId, createOperationId } from '../../src/planning/create.ts';
import type { ExecutableOperation } from '../../src/planning/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import { bindUndoRetainedArtifactV1 } from '../../src/undo/artifacts.ts';
import type { UndoArtifactCandidate } from '../../src/undo/types.ts';
import { createForwardUpdateArtifactJournalSequenceV1 } from '../../src/update/history.ts';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const encoder = new TextEncoder();

describe('retained undo artifact binding', () => {
  test('restores exact lock bytes and mode while committing pair-null rollback lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-undo-artifact-'));
    roots.push(root);
    const ports = await defaultRuntimePorts();
    const artifactCoordinator = await createTestNodeArtifactCoordinatorPorts(
      join(root, 'coordination'),
    );
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const ledgerPath = join(root, 'placements.json');
    const retainedDirectory = join(root, '.skillsmith-artifact-transaction-forward');
    const retainedPath = join(retainedDirectory, 'lock.backup');
    const manifest = [
      'version = 1',
      '',
      '[[skills]]',
      'name = "review"',
      'source = "example.test/acme/review//skills/review"',
      'ref = "main"',
      'tools = ["codex"]',
      'scope = "user"',
      'placement = "copy"',
      '',
    ].join('\n');
    const manifestSource = readManifestSource(manifest);
    if (!manifestSource.ok) throw new Error('manifest fixture is invalid');
    const normalizedManifest = normalizeManifestDocument(manifestSource.value);
    if (!normalizedManifest.ok) throw new Error('manifest fixture is invalid');
    const manifestHash = hashManifestSemantics(normalizedManifest.value);
    const lockBytes = (resolvedSha: string): Uint8Array => {
      const serialized = serializePortableLock({
        version: 1,
        hashSchemaVersion: 1,
        manifestHash,
        skills: [
          {
            name: 'review',
            source: 'example.test/acme/review//skills/review',
            requestedRef: 'main',
            resolvedSha,
            sourcePath: 'skills/review',
            contentHash: `sha256:${resolvedSha[0]?.repeat(64) ?? '0'.repeat(64)}` as ArtifactDigest,
          },
        ],
      });
      if (!serialized.ok) throw new Error('lock fixture is invalid');
      return encoder.encode(serialized.value);
    };
    const beforeBytes = lockBytes('b'.repeat(40));
    const afterBytes = lockBytes('c'.repeat(40));
    const before = artifactLockImageFromBytesV1(lockPath, beforeBytes);
    const after = artifactLockImageFromBytesV1(lockPath, afterBytes);
    const sourceGroupId = createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'update',
      skill: 'review',
      source: null,
      scope: 'user',
      target: 'retained-lock-fixture',
    });
    const sourceOperationId = createOperationId({
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId: sourceGroupId,
      pairId: null,
      kind: 'write-lock',
      skill: null,
      source: null,
      tool: null,
      scope: null,
    });
    const sourceOperation: ExecutableOperation = {
      operationId: sourceOperationId,
      groupId: sourceGroupId,
      pairId: null,
      kind: 'write-lock',
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
        retentionResourceIds: ['update-artifact-retention:v1:fixture'],
      },
      mutates: { live: false, manifest: false, lock: true, ledger: false },
      conflict: null,
    };
    const envelope = encodeRetainedArtifactPreimageV1({
      operationId: sourceOperationId,
      role: 'lock',
      path: lockPath,
      before: { bytes: beforeBytes, mode: 0o640 },
      after: { digest: after.canonicalHash, mode: 0o600 },
    });
    if (!envelope.ok) throw new Error(envelope.error.message);
    const sequence = createForwardUpdateArtifactJournalSequenceV1({
      operation: sourceOperation,
      transactionId: 'transaction-forward',
      startedAt: '2026-07-23T00:00:00.000Z',
      retainedPath,
      retainedBytes: envelope.value.encoded,
      expectedAfterMode: 0o600,
    });
    if (!sequence.ok) throw new Error(sequence.error.message);
    let model = emptyLedgerModel('2026-07-23T00:00:00.000Z');
    for (const journal of [
      sequence.value.prepared,
      sequence.value.staged,
      sequence.value.backedUp,
      sequence.value.live,
    ]) {
      const advanced = advanceLogicalTransaction(model, journal);
      if (!advanced.ok) throw new Error(advanced.error.message);
      model = advanced.value;
    }
    const committed = commitLogicalTransaction(model, sequence.value.committed);
    if (!committed.ok) throw new Error(committed.error.message);
    model = committed.value;
    await mkdir(retainedDirectory, { mode: 0o700 });
    await writeFile(retainedPath, envelope.value.encoded, { mode: 0o600 });
    await writeFile(manifestPath, manifest, { mode: 0o600 });
    await writeFile(lockPath, afterBytes, { mode: 0o600 });
    await Promise.all([chmod(retainedDirectory, 0o700), chmod(retainedPath, 0o600)]);
    const written = await writeLedger(ports, ledgerPath, model);
    if (!written.ok) throw new Error(JSON.stringify(written.error));

    const undoGroupId = createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'undo',
      skill: 'review',
      source: null,
      scope: 'user',
      target: 'retained-lock-occurrence',
    });
    const undoOperationId = createOperationId({
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId: undoGroupId,
      pairId: null,
      kind: 'write-lock',
      skill: null,
      source: null,
      tool: null,
      scope: null,
    });
    const operation: ExecutableOperation = {
      ...sourceOperation,
      operationId: undoOperationId,
      groupId: undoGroupId,
      before: after,
      after: before,
      mutates: { live: false, manifest: false, lock: true, ledger: true },
    };
    const decoded = decodeRetainedArtifactPreimageV1(envelope.value.encoded, {
      operationId: sourceOperationId,
      role: 'lock',
      path: lockPath,
    });
    if (!decoded.ok) throw new Error(decoded.error.message);
    const candidate: UndoArtifactCandidate = {
      physicalHead: true,
      action: 'restore',
      role: 'lock',
      artifactPath: lockPath,
      retainedPath,
      sourceTransactionId: sequence.value.committed.transactionId,
      sourceOperationId,
      sourceGroupId,
      journal: sequence.value.committed,
      rollbackJournal: null,
      envelope: decoded.value,
    };
    const pair = Object.freeze({
      file: Object.freeze({
        token: null,
        path: manifestPath,
        portability: 'machine-bound' as const,
        portableToken: null,
      }),
      lockfile: Object.freeze({
        token: null,
        path: lockPath,
        portability: 'machine-bound' as const,
        portableToken: null,
      }),
      lockfileSource: 'sibling' as const,
    });
    let result: Awaited<
      ReturnType<ReturnType<typeof bindUndoRetainedArtifactV1>['execute']>
    > | null = null;
    await withArtifactGroupLock(artifactCoordinator, pair, undefined, async (lease) => {
      await lease.acquireCompatibilityTargets([manifestPath, lockPath]);
      const prepared = bindUndoRetainedArtifactV1({
        operation,
        candidate,
        lease,
        artifactCoordinator,
        ports,
        pair,
        ledgerPath,
      });
      const actualBefore = await prepared.observeActualBefore();
      const validated = {
        operationId: operation.operationId,
        groupId: operation.groupId,
        pairId: null,
        actualBefore,
        unstartedForce: null,
        execute: async () => {
          throw new Error('the prepared binding owns execution');
        },
      } as ValidatedExecutionBinding;
      result = await prepared.execute(validated);
    });

    expect(result).toMatchObject({ outcome: 'succeeded', actualAfter: before });
    expect(await readFile(lockPath)).toEqual(Buffer.from(beforeBytes));
    expect((await stat(lockPath)).mode & 0o7777).toBe(0o640);
    const durable = await readLedgerState(ports, ledgerPath);
    expect(durable).toMatchObject({ ok: true, value: { state: 'present' } });
    if (!durable.ok || durable.value.state !== 'present') return;
    expect(durable.value.model.history.at(-1)).toMatchObject({
      disposition: 'rollback',
      phase: 'committed',
      intent: {
        operationId: undoOperationId,
        groupId: undoGroupId,
        pairId: null,
        kind: 'write-lock',
      },
      context: { parentOperationId: sourceOperationId, workflow: 'undo-artifact-history' },
    });
  });
});
