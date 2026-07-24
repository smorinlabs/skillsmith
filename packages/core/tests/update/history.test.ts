import { describe, expect, test } from 'bun:test';
import {
  artifactLockImageFromBytesV1,
  artifactManifestImageFromBytesV1,
} from '../../src/artifacts/execution.ts';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { encodeRetainedArtifactPreimageV1 } from '../../src/artifacts/retained-preimage-codec.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import {
  advanceLogicalTransaction,
  commitLogicalTransaction,
} from '../../src/place/logical-transactions.ts';
import { createOperationGroupId, createOperationId } from '../../src/planning/create.ts';
import type { ExecutableOperation } from '../../src/planning/types.ts';
import { createForwardUpdateArtifactJournalSequenceV1 } from '../../src/update/history.ts';

const encoder = new TextEncoder();
const startedAt = '2026-07-23T00:00:00.000Z';

const operationFor = (
  role: 'manifest' | 'lock',
): Readonly<{
  operation: ExecutableOperation;
  beforeBytes: Uint8Array;
}> => {
  const path = role === 'manifest' ? '/workspace/skillsmith.toml' : '/workspace/skillsmith.lock';
  const beforeBytes =
    role === 'manifest'
      ? encoder.encode(
          'version = 1\n\n[[skills]]\nname = "review"\nsource = "acme/review"\ntools = ["codex"]\nscope = "user"\n',
        )
      : (() => {
          const serialized = serializePortableLock({
            version: 1,
            hashSchemaVersion: 1,
            manifestHash: `sha256:${'a'.repeat(64)}` as ArtifactDigest,
            skills: [],
          });
          if (!serialized.ok) throw new TypeError('lock fixture is invalid');
          return encoder.encode(serialized.value);
        })();
  const afterBytes =
    role === 'manifest'
      ? encoder.encode(
          'version = 1\n\n[[skills]]\nname = "review"\nsource = "acme/review"\nref = "v2"\ntools = ["codex"]\nscope = "user"\n',
        )
      : (() => {
          const serialized = serializePortableLock({
            version: 1,
            hashSchemaVersion: 1,
            manifestHash: `sha256:${'b'.repeat(64)}` as ArtifactDigest,
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
    target: `fixture-${role}`,
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
});
