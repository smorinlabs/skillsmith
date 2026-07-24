import { describe, expect, test } from 'bun:test';
import { artifactManifestImageFromBytesV1 } from '../../src/artifacts/execution.ts';
import { encodeRetainedArtifactPreimageV1 } from '../../src/artifacts/retained-preimage-codec.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import {
  advanceLogicalTransaction,
  beginCommittedLogicalTransactionReversal,
  commitLogicalTransaction,
  logicalRollbackExecutionMode,
} from '../../src/place/logical-transactions.ts';
import { createOperationGroupId, createOperationId } from '../../src/planning/create.ts';
import type { ExecutableOperation } from '../../src/planning/types.ts';
import { createForwardUpdateArtifactJournalSequenceV1 } from '../../src/update/history.ts';

const encoder = new TextEncoder();

const committedArtifactFixture = () => {
  const path = '/fixture/custom.toml';
  const beforeBytes = encoder.encode('version = 1\n\n# before\nskills = []\n');
  const afterBytes = encoder.encode('version = 1\n\n# after\nskills = []\n');
  const before = artifactManifestImageFromBytesV1(path, beforeBytes);
  const after = artifactManifestImageFromBytesV1(path, afterBytes);
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'update',
    skill: 'review',
    source: null,
    scope: 'user',
    target: 'logical-artifact-fixture',
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind: 'write-manifest',
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  const operation: ExecutableOperation = {
    operationId,
    groupId,
    pairId: null,
    kind: 'write-manifest',
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
      retentionResourceIds: ['update-artifact-retention:v1:logical-fixture'],
    },
    mutates: { live: false, manifest: true, lock: false, ledger: false },
    conflict: null,
  };
  const envelope = encodeRetainedArtifactPreimageV1({
    operationId,
    role: 'manifest',
    path,
    before: { bytes: beforeBytes, mode: 0o640 },
    after: { digest: after.byteHash, mode: 0o600 },
  });
  if (!envelope.ok) throw new Error(envelope.error.message);
  const sequence = createForwardUpdateArtifactJournalSequenceV1({
    operation,
    transactionId: 'logical-fixture',
    startedAt: '2026-07-23T00:00:00.000Z',
    retainedPath: '/fixture/.skillsmith-artifact-logical-fixture/manifest.backup',
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
  return { model: committed.value, parent: sequence.value.committed };
};

describe('logical artifact reversals', () => {
  test('advances a pair-null retained artifact child without a legacy placement shadow', () => {
    const fixture = committedArtifactFixture();
    const childGroupId = createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'undo',
      skill: 'review',
      source: null,
      scope: 'user',
      target: 'logical-artifact-child',
    });
    const childOperationId = createOperationId({
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId: childGroupId,
      pairId: null,
      kind: 'write-manifest',
      skill: null,
      source: null,
      tool: null,
      scope: null,
    });
    const begun = beginCommittedLogicalTransactionReversal(fixture.model, {
      sourceTransactionId: fixture.parent.transactionId,
      transactionId: 'logical-artifact-child',
      operationId: childOperationId,
      groupId: childGroupId,
      pairId: null,
      command: 'skillsmith-undo',
      workflow: 'undo-artifact-history',
      startedAt: '2026-07-23T01:00:00.000Z',
      updatedAt: '2026-07-23T01:00:00.000Z',
    });
    expect(begun.ok).toBeTrue();
    if (!begun.ok) return;
    let model = begun.value;
    let child = model.transactions['logical-artifact-child'];
    if (child === undefined) throw new Error('artifact rollback child is missing');
    expect(logicalRollbackExecutionMode(model, child)).toEqual({
      ok: true,
      value: 'fresh-reversal',
    });
    expect(child).toMatchObject({
      disposition: 'rollback',
      phase: 'prepared',
      intent: { pairId: null, kind: 'write-manifest' },
      context: { parentOperationId: fixture.parent.intent.operationId },
    });

    for (const phase of ['staged', 'backed-up', 'live'] as const) {
      const next = {
        ...child,
        phase,
        actual: {
          ...child.actual,
          after: phase === 'live' ? fixture.parent.actual.before : [],
        },
        updatedAt: `2026-07-23T01:00:0${phase === 'staged' ? 1 : phase === 'backed-up' ? 2 : 3}.000Z`,
      };
      const advanced = advanceLogicalTransaction(model, next);
      expect(advanced.ok, phase).toBeTrue();
      if (!advanced.ok) return;
      model = advanced.value;
      child = model.transactions['logical-artifact-child'];
      if (child === undefined) throw new Error('artifact rollback child disappeared');
    }
    const committedAt = '2026-07-23T01:00:04.000Z';
    const committed = commitLogicalTransaction(model, {
      ...child,
      phase: 'committed',
      updatedAt: committedAt,
      completedAt: committedAt,
    });
    expect(committed.ok).toBeTrue();
    if (!committed.ok) return;
    expect(committed.value.history.at(-1)).toMatchObject({
      transactionId: 'logical-artifact-child',
      phase: 'committed',
      disposition: 'rollback',
      actual: { after: fixture.parent.actual.before },
    });
  });

  test('refuses to bind a pair-null artifact parent to a placement child identity', () => {
    const fixture = committedArtifactFixture();
    expect(
      beginCommittedLogicalTransactionReversal(fixture.model, {
        sourceTransactionId: fixture.parent.transactionId,
        transactionId: 'logical-artifact-wrong-pair',
        operationId: 'operation:v1:wrong-pair',
        groupId: 'group:v1:wrong-pair',
        pairId: 'pair:v1:wrong-pair',
        command: 'skillsmith-undo',
        workflow: 'undo-artifact-history',
        startedAt: '2026-07-23T02:00:00.000Z',
        updatedAt: '2026-07-23T02:00:00.000Z',
      }),
    ).toMatchObject({ ok: false, error: { reason: 'identity-conflict' } });
  });
});
