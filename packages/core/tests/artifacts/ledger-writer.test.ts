import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArtifactDigest } from '../../src/artifacts/hash.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import {
  ledgerByteRevision,
  ledgerSemanticRevision,
  ledgerV2Codec,
} from '../../src/artifacts/ledger-codec.ts';
import type { LedgerMigrationJournalSequence } from '../../src/artifacts/ledger-types.ts';
import {
  type LedgerWriterBarrierKind,
  createTestNodeLedgerWriter,
} from '../../src/artifacts/ledger-writer.ts';
import { cleanupHistoryVictim, selectBoundedHistory } from '../../src/place/history.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', '..', 'tests', 'ergonomics', 'fixtures');
const V1_GOLDEN = join(FIXTURES, 'p2-ts08', 'ledger-v1.golden.json');
const V2_GOLDEN = join(FIXTURES, 'p2-ts08', 'ledger-v2.golden.json');

const unwrap = <T, E>(value: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!value.ok) throw new Error(JSON.stringify(value.error));
  return value.value;
};

const migrationSequence = async (): Promise<LedgerMigrationJournalSequence> => {
  const decoded = unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(V2_GOLDEN))));
  const liveSeed = decoded.model.transactions['tx:migrate-ledger-live'];
  const committedSeed = decoded.model.history[0];
  if (liveSeed === undefined || committedSeed === undefined)
    throw new Error('missing journal seed');
  const transactionId = 'tx:migrate-ledger-focused';
  const operationId = 'operation:migrate-ledger-focused';
  const at = (phase: LogicalJournalV1Dto['phase']): LogicalJournalV1Dto => {
    const committed = phase === 'committed';
    const source = committed ? committedSeed : liveSeed;
    return {
      ...source,
      transactionId,
      intent: { ...source.intent, operationId },
      phase,
      actual: {
        ...source.actual,
        after: phase === 'live' || committed ? source.actual.after : [],
        retained: [],
      },
      updatedAt: `2026-07-15T00:00:0${phase === 'committed' ? '5' : '1'}.000Z`,
      completedAt: committed ? '2026-07-15T00:00:05.000Z' : null,
    };
  };
  return Object.freeze({
    prepared: at('prepared'),
    staged: at('staged'),
    backedUp: at('backed-up'),
    live: at('live'),
    committed: at('committed'),
  });
};

describe('private canonical ledger writer', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('replaces only the expected revision and emits canonical v2 without mutating input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-writer-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const barriers: LedgerWriterBarrierKind[] = [];
    let id = 0;
    const writer = await createTestNodeLedgerWriter(path, {
      nextId: (purpose) =>
        purpose === 'owner' ? 'a'.repeat(64) : `${(++id).toString(16).padStart(16, '0')}`,
      afterBarrier: async ({ kind }) => {
        barriers.push(kind);
      },
    });
    const model = emptyLedgerModel('2026-07-15T00:00:00.000Z');
    const snapshot = structuredClone(model);
    const first = unwrap(await writer.replace({ model, expectedByteRevision: null }));
    expect(model).toEqual(snapshot);
    expect(first.changed).toBeTrue();
    const source = new Uint8Array(await readFile(path));
    expect(source.at(-1)).toBe(0x0a);
    expect(unwrap(ledgerV2Codec.decode(source)).source).toEqual({ kind: 'version', version: 2 });
    expect(barriers).toEqual([
      'writer-stage-write',
      'writer-stage-fsync',
      'writer-live-replace',
      'writer-live-parent-fsync',
    ]);
    expect(
      (
        await writer.replace({
          model,
          expectedByteRevision: unwrap(
            parseArtifactDigest(
              'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            ),
          ),
        })
      ).ok,
    ).toBeFalse();
  });

  test('migrates exact v1 bytes through the seven-cursor authority and commits once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-migration-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const source = new Uint8Array(await readFile(V1_GOLDEN));
    await writeFile(path, source);
    const decoded = unwrap(ledgerV2Codec.decode(source));
    const semantic = unwrap(ledgerSemanticRevision(decoded.model));
    const barriers: LedgerWriterBarrierKind[] = [];
    let id = 0;
    const writer = await createTestNodeLedgerWriter(path, {
      nextId: (purpose) =>
        purpose === 'owner' ? 'b'.repeat(64) : (++id).toString(16).padStart(16, '0'),
      afterBarrier: async ({ kind }) => {
        barriers.push(kind);
      },
    });
    const sequence = await migrationSequence();
    const migrated = unwrap(
      await writer.migrateV1ToV2({
        expectedSourceByteRevision: ledgerByteRevision(source),
        expectedSourceSemanticRevision: semantic,
        journals: sequence,
      }),
    );
    expect(migrated.resumed).toBeFalse();
    const final = unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(path))));
    expect(final.source).toEqual({ kind: 'version', version: 2 });
    expect(final.model.transactions).toEqual({});
    expect(
      final.model.history.filter(
        ({ transactionId }) => transactionId === sequence.committed.transactionId,
      ),
    ).toHaveLength(1);
    expect(await writer.recoverMigration()).toEqual({ ok: true, value: null });
    expect(barriers).toContain('recovery-pointer-prepared-write');
    expect(barriers).toContain('migration-pointer-cleanup');
  });

  test('uses injected reads for the second CAS observation and refuses stale bytes before write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-injected-stale-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const source = new Uint8Array(await readFile(V2_GOLDEN));
    await writeFile(path, source);
    const decoded = unwrap(ledgerV2Codec.decode(source));
    const changed = ledgerV2Codec.encode({
      ...decoded.model,
      updatedAt: '2026-07-15T00:00:09.000Z',
    });
    if (!changed.ok) throw new Error(JSON.stringify(changed.error));
    const base = await defaultRuntimePorts();
    let reads = 0;
    let writes = 0;
    const writer = await createTestNodeLedgerWriter(path, {
      ports: {
        ...base,
        readBytes: async (candidate) => {
          if (candidate !== path) return base.readBytes(candidate);
          reads += 1;
          return reads === 1 ? source : changed.value;
        },
        writeTextFile: async (candidate, text) => {
          writes += 1;
          await base.writeTextFile(candidate, text);
        },
      },
      nextId: () => 'c'.repeat(64),
    });
    const result = await writer.replace({
      model: { ...decoded.model, updatedAt: '2026-07-15T00:00:10.000Z' },
      expectedByteRevision: ledgerByteRevision(source),
    });
    expect(result).toEqual({ ok: false, error: { code: 'stale-state', path } });
    expect(reads).toBe(2);
    expect(writes).toBe(0);
    expect(new Uint8Array(await readFile(path))).toEqual(source);
  });

  test('maps an injected write denial without bypassing the supplied capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-injected-permission-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const source = new Uint8Array(await readFile(V1_GOLDEN));
    await writeFile(path, source);
    const decoded = unwrap(ledgerV2Codec.decode(source));
    const base = await defaultRuntimePorts();
    let writes = 0;
    const writer = await createTestNodeLedgerWriter(path, {
      ports: {
        ...base,
        writeTextFile: async () => {
          writes += 1;
          throw Object.assign(new Error('synthetic local denial'), { code: 'EACCES' });
        },
      },
      nextId: () => 'd'.repeat(64),
    });
    const result = await writer.migrateV1ToV2({
      expectedSourceByteRevision: ledgerByteRevision(source),
      expectedSourceSemanticRevision: unwrap(ledgerSemanticRevision(decoded.model)),
      journals: await migrationSequence(),
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'permission-denied', path: writer.recoveryPointerPath },
    });
    expect(writes).toBe(1);
    expect(new Uint8Array(await readFile(path))).toEqual(source);
  });

  test('observes injected cancellation only after fsyncing the first written recovery boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-injected-cancel-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const source = new Uint8Array(await readFile(V1_GOLDEN));
    await writeFile(path, source);
    const decoded = unwrap(ledgerV2Codec.decode(source));
    const base = await defaultRuntimePorts();
    const controller = new AbortController();
    let writes = 0;
    let fsyncs = 0;
    const writer = await createTestNodeLedgerWriter(path, {
      ports: {
        ...base,
        writeTextFile: async (candidate, text) => {
          writes += 1;
          await base.writeTextFile(candidate, text);
          controller.abort();
        },
        fsyncFile: async (candidate) => {
          fsyncs += 1;
          await base.fsyncFile(candidate);
        },
      },
      signal: controller.signal,
      nextId: () => 'e'.repeat(64),
    });
    let cancellation: unknown;
    try {
      await writer.migrateV1ToV2({
        expectedSourceByteRevision: ledgerByteRevision(source),
        expectedSourceSemanticRevision: unwrap(ledgerSemanticRevision(decoded.model)),
        journals: await migrationSequence(),
      });
    } catch (error) {
      cancellation = error;
    }
    expect(cancellation).toMatchObject({ code: 'cancelled' });
    expect(writes).toBe(1);
    expect(fsyncs).toBe(1);
    expect(new Uint8Array(await readFile(path))).toEqual(source);
  });
});

describe('bounded history and one-victim cleanup', () => {
  test('keeps the newest 256 complete journals in commit order for one deep anchor', async () => {
    const decoded = unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(V2_GOLDEN))));
    const seed = decoded.model.history[0];
    if (seed === undefined) throw new Error('missing committed history seed');
    const history = Array.from(
      { length: 260 },
      (_, index): LogicalJournalV1Dto => ({
        ...seed,
        transactionId: `tx:${index.toString().padStart(4, '0')}`,
        intent: { ...seed.intent, operationId: `operation:${index.toString().padStart(4, '0')}` },
      }),
    );
    const selected = unwrap(
      selectBoundedHistory({ ...emptyLedgerModel('2026-07-15T00:00:00.000Z'), history }),
    );
    expect(selected.history).toHaveLength(256);
    expect(selected.history[0]?.transactionId).toBe('tx:0004');
    expect(selected.history.at(-1)?.transactionId).toBe('tx:0259');
    expect(selected.cleanupVictim).toBeNull();
  });

  test('refuses cleanup when revision authority is stale before filesystem access', async () => {
    const calls: string[] = [];
    const model = emptyLedgerModel('2026-07-15T00:00:00.000Z');
    const result = await cleanupHistoryVictim(
      {
        pathKind: async (path) => {
          calls.push(path);
          return 'absent';
        },
        readBytes: async () => new Uint8Array(),
        removeTree: async () => undefined,
        fsyncDir: async () => undefined,
      },
      model,
      {
        transactionId: 'tx:missing',
        ledgerRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        expectedLedgerRevision:
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    );
    expect(result.ok).toBeFalse();
    expect(calls).toEqual([]);
  });
});
