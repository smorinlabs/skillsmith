import { describe, expect, test } from 'bun:test';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import {
  freshArtifactRollbackParentMatches,
  freshRollbackShadowOperations,
  resolveFreshRollbackLineage,
} from '../../src/artifacts/ledger-history.ts';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
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
});
