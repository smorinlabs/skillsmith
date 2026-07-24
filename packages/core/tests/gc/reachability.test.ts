import { describe, expect, test } from 'bun:test';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../../src/artifacts/ledger-types.ts';
import { classifyGcReachability } from '../../src/gc/reachability.ts';
import type { GcObjectObservation } from '../../src/gc/types.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';

const digest = (character: string): ArtifactDigest =>
  `sha256:${character.repeat(64)}` as ArtifactDigest;

const object = (
  name: string,
  contentHash: ArtifactDigest,
  modifiedAt = Date.parse('2026-07-23T00:00:00.000Z'),
): GcObjectObservation => ({
  id: name.repeat(64).slice(0, 64),
  kind: 'store',
  path: `/store/fixture/repo@0123456789ab/${name}`,
  relativePath: `fixture/repo@0123456789ab/${name}`,
  namespace: 'fixture',
  repository: 'repo',
  revision: '0123456789ab',
  skill: name,
  contentHash,
  modifiedAt,
  logicalBytes: 10,
  rootIdentity: '1:1',
  namespaceIdentity: '1:2',
  repositoryIdentity: '1:3',
  directoryIdentity: `1:${name}`,
  directoryLinkCount: 2,
  entries: [],
});

const pair = (selected: GcObjectObservation): LedgerPairV1Dto => ({
  placementPath: `/live/${selected.skill}`,
  mode: 'pinned',
  dev: null,
  pinned: {
    storePath: selected.path,
    rev: selected.revision,
    gitSha: null,
    dirty: false,
    contentHash: selected.contentHash,
    snapshotAt: '2026-07-23T00:00:00.000Z',
    verify: 'passed',
    placement: 'symlink',
  },
});

const journal = (
  transactionId: string,
  selected: GcObjectObservation,
  retainUntil: string | null,
): LogicalJournalV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.transaction-journal',
  transactionId,
  intent: {
    operationId: `operation:${transactionId}`,
    groupId: `group:${transactionId}`,
    pairId: null,
    kind: 'migrate-ledger',
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 1,
      byteHash: digest('1'),
      semanticHash: digest('2'),
    },
    after: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 2,
      byteHash: digest('3'),
      semanticHash: digest('2'),
    },
    mutates: { live: false, manifest: false, lock: false, ledger: true },
    reversibility: { kind: 'none', retentionResourceIds: [] },
    conflict: null,
  },
  context: {
    parentOperationId: null,
    command: 'skillsmith:gc-test',
    workflow: 'gc-test',
    attempt: 1,
    startedAt: '2026-07-23T00:00:00.000Z',
  },
  disposition: 'forward',
  phase: 'committed',
  actual: {
    before: [],
    after: [],
    retained: [
      {
        resourceId: `resource:${transactionId}`,
        role: 'store',
        path: selected.path,
        repositoryRevision: { kind: 'resource', digest: selected.contentHash },
        contentHash: selected.contentHash,
        retainUntil,
      },
    ],
  },
  updatedAt: '2026-07-23T00:00:00.000Z',
  completedAt: '2026-07-23T00:00:00.000Z',
});

describe('GC reachability and retention graph', () => {
  test('protects exact path-plus-hash ledger and live edges without basename guessing', () => {
    const protectedObject = object('protected', digest('a'));
    const liveObject = object('live', digest('b'));
    const eligibleObject = object('eligible', digest('c'));
    const base = emptyLedgerModel('2026-07-23T00:00:00.000Z');
    const model: LedgerModel = {
      ...base,
      skills: { protected: { tools: { codex: pair(protectedObject) } } },
    };
    const result = classifyGcReachability({
      model,
      objects: [eligibleObject, liveObject, protectedObject],
      liveTargets: [
        { sourceId: 'live:review', path: liveObject.path, contentHash: liveObject.contentHash },
        { sourceId: 'wrong-hash', path: eligibleObject.path, contentHash: digest('d') },
      ],
      nowMilliseconds: Date.parse('2026-07-23T01:00:00.000Z'),
      olderThanMilliseconds: null,
    });
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error(result.reason);
    expect(result.classifications.map(({ object, outcome }) => [object.skill, outcome])).toEqual([
      ['eligible', 'eligible'],
      ['live', 'protected'],
      ['protected', 'protected'],
    ]);
  });

  test('applies strict age and per-resource history retention boundaries', () => {
    const expired = object('expired', digest('d'), Date.parse('2026-07-22T00:00:00.000Z'));
    const retained = object('retained', digest('e'), Date.parse('2026-07-22T00:00:00.000Z'));
    const equality = object('equality', digest('f'), Date.parse('2026-07-23T00:00:00.000Z'));
    const minusOne = object('minus-one', digest('7'), Date.parse('2026-07-22T23:59:59.999Z'));
    const plusOne = object('plus-one', digest('8'), Date.parse('2026-07-23T00:00:00.001Z'));
    const base = emptyLedgerModel('2026-07-23T00:00:00.000Z');
    const model: LedgerModel = {
      ...base,
      history: [
        journal('history-expired', expired, '2026-07-22T23:59:59.999Z'),
        journal('history-retained', retained, '2026-07-23T01:00:00.000Z'),
      ],
    };
    const result = classifyGcReachability({
      model,
      objects: [expired, retained, equality, minusOne, plusOne],
      nowMilliseconds: Date.parse('2026-07-23T01:00:00.000Z'),
      olderThanMilliseconds: 3_600_000,
    });
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error(result.reason);
    expect(result.classifications.map(({ object, outcome }) => [object.skill, outcome])).toEqual([
      ['equality', 'age-filtered'],
      ['expired', 'eligible'],
      ['minus-one', 'eligible'],
      ['plus-one', 'age-filtered'],
      ['retained', 'protected'],
    ]);
    expect(Object.isFrozen(result.classifications)).toBeTrue();
  });

  test('refuses invalid retention timestamps without exposing classifications', () => {
    const selected = object('invalid', digest('9'));
    const base = emptyLedgerModel('2026-07-23T00:00:00.000Z');
    const result = classifyGcReachability({
      model: { ...base, history: [journal('invalid-history', selected, 'not-a-time')] },
      objects: [selected],
      nowMilliseconds: Date.parse('2026-07-23T01:00:00.000Z'),
      olderThanMilliseconds: null,
    });
    expect(result).toMatchObject({ state: 'refused', classifications: [] });
  });
});
