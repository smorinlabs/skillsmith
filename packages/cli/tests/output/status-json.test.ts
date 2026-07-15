import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type UnknownRecord = Readonly<Record<string, unknown>>;

interface StatusGolden extends UnknownRecord {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly selection: UnknownRecord;
  readonly context: UnknownRecord;
  readonly artifacts: UnknownRecord;
  readonly ledger: UnknownRecord;
  readonly journals: readonly unknown[];
  readonly facts: readonly unknown[];
  readonly entries: readonly StatusEntryGolden[];
  readonly summary: UnknownRecord;
}

interface StatusEntryGolden extends UnknownRecord {
  readonly name: string;
  readonly convergence: 'converged' | 'drift';
  readonly placements: readonly StatusPlacementGolden[];
}

interface StatusPlacementGolden extends UnknownRecord {
  readonly identity: UnknownRecord;
  readonly journal: UnknownRecord;
  readonly facts: readonly UnknownRecord[];
}

const ROOT = resolve(import.meta.dir, '../../../..');
const GOLDEN_PATH = resolve(ROOT, 'tests/ergonomics/fixtures/p3a-ts04/status-v1.golden.json');
const goldenText = readFileSync(GOLDEN_PATH, 'utf8');
const status = JSON.parse(goldenText) as StatusGolden;

const ownKeysDeep = (value: unknown, keys: string[] = []): readonly string[] => {
  if (Array.isArray(value)) {
    for (const item of value) ownKeysDeep(item, keys);
    return keys;
  }
  if (typeof value !== 'object' || value === null) return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    ownKeysDeep(nested, keys);
  }
  return keys;
};

const pendingPlacement = (): StatusPlacementGolden => {
  const selected = status.entries
    .flatMap((entry) => entry.placements)
    .find((placement) => placement.journal.state === 'pending');
  if (selected === undefined) throw new Error('status golden has no pending journal placement');
  return selected;
};

describe('status@1 JSON rendering contract', () => {
  test('is canonical two-space JSON with exactly one terminal LF', () => {
    expect(goldenText).toBe(`${JSON.stringify(status, null, 2)}\n`);
    expect(goldenText.endsWith('\n\n')).toBeFalse();
    expect(goldenText).not.toContain('\t');
    expect(goldenText).not.toContain('\r');
  });

  test('has the exact top-level wire identity and closed field set', () => {
    expect(Object.keys(status)).toEqual([
      'schemaVersion',
      'kind',
      'selection',
      'context',
      'artifacts',
      'ledger',
      'journals',
      'facts',
      'entries',
      'summary',
    ]);
    expect(status.schemaVersion).toBe(1);
    expect(status.kind).toBe('skillsmith.status');
  });

  test('pins the selected project pair and current ledger source versions', () => {
    expect(status.selection).toEqual({
      source: 'bounded-default',
      targets: [],
      tools: ['claude-code', 'codex', 'kilo-code', 'opencode'],
      toolSource: 'unbounded-default',
      scopes: ['system', 'user', 'project', 'managed'],
      scopeSource: 'unbounded-default',
      outcome: 'selected',
      reason: null,
    });
    expect(status.artifacts).toMatchObject({
      state: 'selected',
      source: 'project-default',
      lockSource: 'sibling',
      manifest: {
        state: 'present',
        sourceVersion: 1,
        currentVersion: 1,
        canonical: true,
        migrationPending: false,
      },
      lock: {
        state: 'present',
        sourceVersion: 1,
        currentVersion: 1,
        canonical: true,
        migrationPending: false,
      },
      relationship: { state: 'current' },
    });
    expect(status.ledger).toMatchObject({
      state: 'present',
      sourceVersion: 2,
      currentVersion: 2,
      migrationPending: false,
    });
  });

  test('contains the exact sorted 14-name, 15-placement mixed fleet', () => {
    const names = status.entries.map((entry) => entry.name);
    expect(names).toEqual([
      'clean-dev',
      'clean-pinned-copy',
      'clean-store-link',
      'content-drift',
      'declared-locked-absent',
      'ledger-only',
      'ledger-recorded-broken-link',
      'live-only-unmanaged',
      'lock-only',
      'manifest-only',
      'placement-drift',
      'revision-drift',
      'shadowed-fleet',
      'source-drift',
    ]);
    expect(names).toEqual(names.toSorted());
    expect(new Set(names).size).toBe(14);
    expect(status.entries.reduce((count, entry) => count + entry.placements.length, 0)).toBe(15);
    expect(status.summary).toEqual({
      entries: 14,
      converged: 2,
      drifting: 12,
      migrationPending: false,
    });
  });

  test('retains logical journal hashes and argv as typed data, never rendered prose', () => {
    const journal = pendingPlacement().journal;
    expect(journal).toMatchObject({
      state: 'pending',
      transactionId: 'tx-shadowed-fleet',
      phase: 'backed-up',
      before: 'pinned',
      abortEligibility: 'eligible',
      format: 'logical',
      operation: 'update',
      remediation: {
        resume: 'rerun the same operation',
        abort: [
          'skillsmith',
          'undo',
          '/repo/.agents/skills/shadowed-fleet',
          '--tool',
          'codex',
          '--scope',
          'project',
        ],
      },
    });
    expect(journal.retention).toEqual([
      {
        format: 'logical',
        resourceId: 'retained-live',
        retainUntil: '2026-08-01T00:00:00.000Z',
        repositoryRevision: {
          state: 'satisfied',
          expected: { kind: 'resource', digest: 'sha256:retained-revision' },
          observed: { kind: 'resource', digest: 'sha256:retained-revision' },
        },
        contentHash: {
          state: 'satisfied',
          domain: 'source-content',
          expected: 'sha256:retained-content',
          observed: 'sha256:retained-content',
        },
        role: 'backup',
        sourceRole: 'live',
        path: '/data/skillsmith/backups/shadowed-fleet',
        pathState: 'satisfied',
        state: 'satisfied',
      },
    ]);
  });

  test('keeps fact values normalized, including composite tuple strings', () => {
    const facts = status.entries.flatMap((entry) => [
      ...(entry.facts as readonly UnknownRecord[]),
      ...entry.placements.flatMap((placement) => placement.facts),
    ]);
    const placement = facts.find((fact) => fact.code === 'placement-drift');
    const source = facts.find((fact) => fact.code === 'source-drift');
    expect(placement).toMatchObject({
      impact: 'drift',
      subject: 'live',
      expected: '["copy","pinned","/repo/.kilo/skills/placement-drift"]',
      actual: '["symlink","dev","/repo/.kilo/skills/placement-drift"]',
    });
    expect(source).toMatchObject({
      impact: 'drift',
      subject: 'ledger',
      expected: '["github.com","skillsmith/status-fixtures","source-drift"]',
      actual: '["git.example.test","other/repository","source-drift"]',
    });
  });

  test('does not expose repository internals or throwable fields', () => {
    const keys = new Set(ownKeysDeep(status));
    for (const forbidden of [
      'cause',
      'stack',
      'raw',
      'sourceUrl',
      'storePath',
      'legacyJournal',
      'artifactSource',
    ]) {
      expect(keys.has(forbidden), forbidden).toBeFalse();
    }
  });
});
