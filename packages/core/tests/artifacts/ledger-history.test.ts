import { describe, expect, test } from 'bun:test';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import {
  freshArtifactRollbackParentMatches,
  freshRollbackShadowOperations,
  resolveFreshRollbackLineage,
  selectBoundedHistory,
} from '../../src/artifacts/ledger-history.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';

const digest = (character: string) => `sha256:${character.repeat(64)}` as ArtifactDigest;
const lockImage = (character: string) => ({
  kind: 'lock' as const,
  location: { kind: 'machine-bound' as const, path: '/fixture/skillsmith.lock' },
  version: 1 as const,
  canonicalHash: digest(character),
  value: {
    version: 1 as const,
    hashSchemaVersion: 1 as const,
    manifestHash: digest('a'),
    skills: [],
  },
});

const artifactParent = (transactionId: string): LogicalJournalV1Dto =>
  ({
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId,
    intent: {
      operationId: 'operation:v1:repeated-forward-artifact',
      groupId: 'group:v1:repeated-forward-artifact',
      pairId: null,
      kind: 'write-lock',
      skill: null,
      source: null,
      tool: null,
      scope: null,
      before: lockImage('b'),
      after: lockImage('c'),
      mutates: { live: false, manifest: false, lock: true, ledger: false },
      reversibility: {
        kind: 'conditional',
        retentionResourceIds: ['update-artifact-retention:v1:fixture'],
      },
      conflict: null,
    },
    context: {
      parentOperationId: 'operation:v1:repeated-forward-artifact',
      command: 'update',
      workflow: 'update-artifact-history',
      attempt: 1,
      startedAt: '2026-07-23T00:00:00.000Z',
    },
    disposition: 'forward',
    phase: 'committed',
    actual: {
      before: [
        {
          resourceId: 'artifact:lock',
          role: 'lock',
          location: lockImage('b').location,
          state: 'present',
          canonicalHash: digest('b'),
        },
      ],
      after: [
        {
          resourceId: 'artifact:lock',
          role: 'lock',
          location: lockImage('c').location,
          state: 'present',
          canonicalHash: digest('c'),
        },
      ],
      retained: [],
    },
    startedAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:01.000Z',
    completedAt: '2026-07-23T00:00:01.000Z',
  }) as unknown as LogicalJournalV1Dto;

const artifactChild = (parent: LogicalJournalV1Dto, transactionId: string): LogicalJournalV1Dto =>
  ({
    ...parent,
    transactionId,
    intent: {
      ...parent.intent,
      operationId: 'operation:v1:repeated-rollback-artifact',
      groupId: 'group:v1:repeated-rollback-artifact',
    },
    context: {
      ...parent.context,
      parentOperationId: parent.intent.operationId,
      command: 'skillsmith-undo',
      workflow: 'undo-artifact-history',
    },
    disposition: 'rollback',
    actual: {
      before: parent.actual.after,
      after: parent.actual.before,
      retained: parent.actual.retained,
    },
  }) as LogicalJournalV1Dto;

const retainedCarrier = (transactionId: string, groupId: string): LogicalJournalV1Dto => {
  const parent = artifactParent(transactionId);
  const retained = {
    resourceId: 'update-artifact-retention:v1:fixture',
    role: 'backup' as const,
    sourceRole: 'lock' as const,
    path: `/fixture/.skillsmith-artifact-${transactionId}/lock.backup`,
    repositoryRevision: { kind: 'resource' as const, digest: digest('d') },
    contentHash: digest('b'),
    retainUntil: null,
  };
  return {
    ...parent,
    intent: { ...parent.intent, groupId },
    actual: { ...parent.actual, retained: [retained] },
  };
};

const updatePlacement = (
  transactionId: string,
  groupId: string,
  placementPath: string,
  tool = 'codex',
): LogicalJournalV1Dto => {
  const resource = {
    kind: 'live' as const,
    skill: 'review',
    tool,
    scope: 'user' as const,
    projectRoot: null,
    location: { kind: 'machine-bound' as const, path: placementPath },
  };
  const source = {
    kind: 'portable' as const,
    identity: { host: 'fixture.invalid', repository: 'acme/skills', path: 'review' },
    requestedRef: null,
    resolvedSha: 'd'.repeat(40),
    sourcePath: 'review',
    contentHash: digest('c'),
  };
  const image = (contentHash: ReturnType<typeof digest>) => ({
    kind: 'placement' as const,
    resource,
    classification: 'store-linked' as const,
    representation: 'copy' as const,
    linkTarget: null,
    dangling: false,
    source,
    contentHash,
  });
  const actual = (contentHash: ReturnType<typeof digest>) => ({
    resourceId: `live:review:${tool}`,
    role: 'live' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'resource' as const, digest: contentHash },
    placementPath,
    liveKind: 'directory' as const,
    mode: 'pinned' as const,
    symlinkTarget: null,
    contentHash,
  });
  return {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId,
    intent: {
      operationId: `operation:v1:${transactionId}`,
      groupId,
      pairId: `pair:v1:${transactionId}`,
      kind: 'update',
      skill: 'review',
      source,
      tool,
      scope: 'user',
      before: image(digest('b')),
      after: image(digest('c')),
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      reversibility: { kind: 'conditional', retentionResourceIds: [`store:v1:${transactionId}`] },
      conflict: null,
    },
    context: {
      parentOperationId: `operation:v1:${transactionId}`,
      command: 'update',
      workflow: 'update-placement-history',
      attempt: 1,
      startedAt: '2026-07-23T00:00:00.000Z',
    },
    disposition: 'forward',
    phase: 'committed',
    actual: {
      before: [actual(digest('b'))],
      after: [actual(digest('c'))],
      retained: [],
    },
    updatedAt: '2026-07-23T00:00:01.000Z',
    completedAt: '2026-07-23T00:00:01.000Z',
  } as unknown as LogicalJournalV1Dto;
};

describe('artifact rollback history lineage', () => {
  test('resolves repeated artifact identities to nearest unconsumed parents in LIFO order', () => {
    const first = artifactParent('artifact-parent-first');
    const second = artifactParent('artifact-parent-second');
    const secondChild = artifactChild(second, 'artifact-child-second');
    const firstChild = artifactChild(first, 'artifact-child-first');
    const resolved = resolveFreshRollbackLineage([first, second, secondChild, firstChild], {});

    expect(resolved).toEqual({
      ok: true,
      value: {
        parentTransactionIdByChildTransactionId: {
          'artifact-child-second': 'artifact-parent-second',
          'artifact-child-first': 'artifact-parent-first',
        },
        childTransactionIdByParentTransactionId: {
          'artifact-parent-second': 'artifact-child-second',
          'artifact-parent-first': 'artifact-child-first',
        },
      },
    });

    expect(
      resolveFreshRollbackLineage(
        [first, second, secondChild, firstChild, artifactChild(first, 'artifact-child-third')],
        {},
      ),
    ).toEqual({ ok: false, error: { transactionId: 'artifact-child-third' } });
  });

  test('admits only exact pair-null artifact parents and the managed update shadow orientation', () => {
    const parent = artifactParent('artifact-parent');
    const child = artifactChild(parent, 'artifact-child');
    expect(freshArtifactRollbackParentMatches(child, parent)).toBeTrue();
    expect(
      freshArtifactRollbackParentMatches(
        { ...child, intent: { ...child.intent, pairId: 'pair:v1:wrong' } },
        parent,
      ),
    ).toBeFalse();

    const update = {
      ...parent,
      intent: {
        ...parent.intent,
        pairId: 'pair:v1:update',
        kind: 'update',
        before: {
          kind: 'placement',
          resource: {
            kind: 'live',
            skill: 'review',
            tool: 'codex',
            scope: 'user',
            projectRoot: null,
            location: { kind: 'machine-bound', path: '/fixture/skills/review' },
          },
          classification: 'pinned',
          representation: 'copy',
          linkTarget: null,
          dangling: false,
          source: null,
          contentHash: digest('b'),
        },
        after: {
          kind: 'placement',
          resource: {
            kind: 'live',
            skill: 'review',
            tool: 'codex',
            scope: 'user',
            projectRoot: null,
            location: { kind: 'machine-bound', path: '/fixture/skills/review' },
          },
          classification: 'store-linked',
          representation: 'copy',
          linkTarget: null,
          dangling: false,
          source: null,
          contentHash: digest('c'),
        },
      },
    } as LogicalJournalV1Dto;
    expect(freshRollbackShadowOperations(update)).toEqual(['promote']);
  });

  test('protects one complete update occurrence when its placement anchors exhaust capacity', () => {
    const groupId = 'group:v1:update-occurrence';
    const carrier = retainedCarrier('artifact-occurrence-carrier', groupId);
    const placement = updatePlacement(
      'artifact-occurrence-placement',
      groupId,
      '/fixture/occurrence/review',
    );
    const unrelated = Array.from({ length: 255 }, (_, index) =>
      updatePlacement(
        `unrelated-placement-${index.toString().padStart(3, '0')}`,
        `group:v1:unrelated-${index.toString().padStart(3, '0')}`,
        `/fixture/unrelated/${index.toString().padStart(3, '0')}/review`,
      ),
    );
    const selected = selectBoundedHistory({
      ...emptyLedgerModel('2026-07-23T00:00:00.000Z'),
      history: [carrier, placement, ...unrelated],
    });

    expect(selected.ok).toBeTrue();
    if (!selected.ok) return;
    expect(selected.value.history).toHaveLength(257);
    expect(selected.value.cleanupVictim).toBeNull();
    expect(selected.value.history.map(({ transactionId }) => transactionId)).toContain(
      carrier.transactionId,
    );
  });

  test('keeps exact repeated transition groups as separate commit-order occurrences', () => {
    const groupId = 'group:v1:exact-repeated-transition';
    const olderCarrier = retainedCarrier('older-repeated-carrier', groupId);
    const olderPlacement = updatePlacement(
      'older-repeated-placement',
      groupId,
      '/fixture/repeated/review',
    );
    const unrelated = Array.from({ length: 254 }, (_, index) =>
      updatePlacement(
        `repeated-unrelated-${index.toString().padStart(3, '0')}`,
        `group:v1:repeated-unrelated-${index.toString().padStart(3, '0')}`,
        `/fixture/repeated/unrelated/${index.toString().padStart(3, '0')}/review`,
      ),
    );
    const newerCarrier = retainedCarrier('newer-repeated-carrier', groupId);
    const newerPlacement = updatePlacement(
      'newer-repeated-placement',
      groupId,
      '/fixture/repeated/review',
    );
    const model = {
      ...emptyLedgerModel('2026-07-23T00:00:00.000Z'),
      history: [olderCarrier, olderPlacement, ...unrelated, newerCarrier, newerPlacement],
    };
    const selected = selectBoundedHistory(model);

    expect(selected.ok).toBeTrue();
    if (!selected.ok) return;
    expect(selected.value.cleanupVictim?.transactionId).toBe(olderCarrier.transactionId);
    const projected = selectBoundedHistory(model, {
      cleanup: { transactionId: olderCarrier.transactionId, outcome: 'deleted' },
    });
    expect(projected.ok).toBeTrue();
    if (!projected.ok) return;
    const retained = projected.value.history.map(({ transactionId }) => transactionId);
    expect(retained).not.toContain(olderCarrier.transactionId);
    expect(retained).not.toContain(olderPlacement.transactionId);
    expect(retained).toContain(newerCarrier.transactionId);
    expect(retained).toContain(newerPlacement.transactionId);
  });
});
