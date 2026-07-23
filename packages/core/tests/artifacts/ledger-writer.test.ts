import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import {
  cleanupHistoryVictim,
  ledgerJournalAnchors,
  selectBoundedHistory,
} from '../../src/place/history.ts';
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

const cleanupHistoryModel = async (
  root: string,
  length: number,
  backupCount: number,
): Promise<
  Readonly<{ model: ReturnType<typeof emptyLedgerModel>; backupPaths: readonly string[] }>
> => {
  const decoded = unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(V2_GOLDEN))));
  const seed = decoded.model.history[0];
  if (seed === undefined) throw new Error('missing committed history seed');
  const backupPaths: string[] = [];
  const history: LogicalJournalV1Dto[] = [];
  for (let index = 0; index < length; index += 1) {
    const transactionId = index.toString(16).padStart(16, '0');
    const backupPath = join(root, `.skillsmith-artifact-${transactionId}`, 'live.backup');
    const bytes = Buffer.from(`history backup ${transactionId}\n`);
    const hash = unwrap(
      parseArtifactDigest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`),
    );
    const retained =
      index < backupCount
        ? [
            {
              resourceId: `backup:${transactionId}`,
              role: 'backup' as const,
              sourceRole: 'live' as const,
              path: backupPath,
              repositoryRevision: { kind: 'resource' as const, digest: hash },
              contentHash: hash,
              retainUntil: null,
            },
          ]
        : [];
    if (retained.length === 1) {
      await mkdir(join(root, `.skillsmith-artifact-${transactionId}`), { recursive: true });
      await chmod(join(root, `.skillsmith-artifact-${transactionId}`), 0o700);
      await writeFile(backupPath, bytes);
      backupPaths.push(backupPath);
    }
    history.push({
      ...seed,
      transactionId,
      intent: {
        ...seed.intent,
        operationId: `operation:${transactionId}`,
        reversibility:
          retained.length === 0
            ? seed.intent.reversibility
            : {
                kind: 'conditional',
                retentionResourceIds: [`backup:${transactionId}`],
              },
      },
      actual: { ...seed.actual, retained },
    });
  }
  return Object.freeze({
    model: { ...emptyLedgerModel('2026-07-15T00:00:00.000Z'), history },
    backupPaths: Object.freeze(backupPaths),
  });
};

const dependencyDigest = unwrap(parseArtifactDigest(`sha256:${'d'.repeat(64)}`));

const dependencyBackup = (
  transactionId: string,
  path: string,
  retainUntil: string | null = null,
): LogicalJournalV1Dto['actual']['retained'][number] => ({
  resourceId: `backup:${transactionId}`,
  role: 'backup',
  sourceRole: 'live',
  path,
  repositoryRevision: { kind: 'resource', digest: dependencyDigest },
  contentHash: dependencyDigest,
  retainUntil,
});

const dependencyForwardJournal = (
  index: number,
  retained: LogicalJournalV1Dto['actual']['retained'] = [],
): LogicalJournalV1Dto => {
  const suffix = index.toString(16).padStart(16, '0');
  const placementPath = '/fixture/dependency/skills/review';
  const resource = {
    kind: 'live' as const,
    skill: 'review',
    tool: 'codex' as const,
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
    contentHash: dependencyDigest,
  };
  const absent = {
    resourceId: 'live:review:codex',
    role: 'live' as const,
    state: 'absent' as const,
    repositoryRevision: null,
    placementPath,
    liveKind: null,
    mode: null,
    symlinkTarget: null,
    contentHash: null,
  };
  const present = {
    resourceId: 'live:review:codex',
    role: 'live' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'resource' as const, digest: dependencyDigest },
    placementPath,
    liveKind: 'directory' as const,
    mode: 'pinned' as const,
    symlinkTarget: null,
    contentHash: dependencyDigest,
  };
  const ledger = {
    resourceId: 'ledger:placements',
    role: 'ledger' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'artifact-bytes' as const, digest: dependencyDigest },
    schemaVersion: 2 as const,
    semanticHash: dependencyDigest,
  };
  return {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId: `tx:dependency:${suffix}`,
    intent: {
      operationId: `operation:dependency:${suffix}`,
      groupId: `group:dependency:${suffix}`,
      pairId: 'pair:review:codex',
      kind: 'install',
      skill: 'review',
      source,
      tool: 'codex',
      scope: 'user',
      before: { kind: 'absent', resource },
      after: {
        kind: 'placement',
        resource,
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source,
        contentHash: dependencyDigest,
      },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      reversibility:
        retained.length === 0
          ? { kind: 'none', retentionResourceIds: [] }
          : {
              kind: 'conditional',
              retentionResourceIds: retained.map(({ resourceId }) => resourceId) as [
                string,
                ...string[],
              ],
            },
      conflict: null,
    },
    context: {
      parentOperationId: null,
      command: 'skillsmith-install',
      workflow: 'dependency-history-fixture',
      attempt: 1,
      startedAt: `2026-07-15T00:${(index % 60).toString().padStart(2, '0')}:00.000Z`,
    },
    disposition: 'forward',
    phase: 'committed',
    actual: { before: [absent, ledger], after: [present, ledger], retained },
    updatedAt: '2026-07-15T01:00:00.000Z',
    completedAt: '2026-07-15T01:00:01.000Z',
  };
};

const dependencyRollbackChild = (
  parent: LogicalJournalV1Dto,
  identity: LogicalJournalV1Dto,
  phase: LogicalJournalV1Dto['phase'] = 'committed',
): LogicalJournalV1Dto => ({
  ...parent,
  transactionId: identity.transactionId,
  intent: {
    ...parent.intent,
    operationId: identity.intent.operationId,
    groupId: identity.intent.groupId,
  },
  context: {
    ...parent.context,
    parentOperationId: parent.intent.operationId,
    workflow: 'dependency-history-rollback',
  },
  disposition: 'rollback',
  phase,
  actual: {
    before: parent.actual.after,
    after: phase === 'live' || phase === 'committed' ? parent.actual.before : [],
    retained: parent.actual.retained,
  },
  completedAt: phase === 'committed' ? '2026-07-15T02:00:01.000Z' : null,
});

const dependencyCleanupModel = async (
  root: string,
): Promise<
  Readonly<{
    model: ReturnType<typeof emptyLedgerModel>;
    parent: LogicalJournalV1Dto;
    child: LogicalJournalV1Dto;
    backupPath: string;
  }>
> => {
  const parentIdentity = dependencyForwardJournal(0);
  const backupPath = join(
    root,
    `.skillsmith-artifact-${parentIdentity.transactionId}`,
    'live.backup',
  );
  const bytes = Buffer.from('dependency-closed retained backup\n');
  const digest = unwrap(
    parseArtifactDigest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`),
  );
  const retained: LogicalJournalV1Dto['actual']['retained'] = [
    {
      ...dependencyBackup(parentIdentity.transactionId, backupPath),
      repositoryRevision: { kind: 'resource', digest },
      contentHash: digest,
    },
  ];
  const parent = dependencyForwardJournal(0, retained);
  const child = dependencyRollbackChild(parent, dependencyForwardJournal(1));
  await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(backupPath), 0o700);
  await writeFile(backupPath, bytes);
  const tail = Array.from({ length: 256 }, (_, index) => dependencyForwardJournal(index + 2));
  return Object.freeze({
    model: {
      ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
      history: [parent, child, ...tail],
    },
    parent,
    child,
    backupPath,
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

  test('a later canonical replacement finishes a committed migration cleanup pointer first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-cleanup-resume-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const source = new Uint8Array(await readFile(V1_GOLDEN));
    await writeFile(path, source);
    const decoded = unwrap(ledgerV2Codec.decode(source));
    const semantic = unwrap(ledgerSemanticRevision(decoded.model));
    const sequence = await migrationSequence();
    let interrupted = false;
    const writer = await createTestNodeLedgerWriter(path, {
      afterBarrier: async ({ kind }) => {
        if (kind === 'migration-directory-cleanup') {
          interrupted = true;
          throw Object.assign(new Error('focused cleanup interruption'), { code: 'cancelled' });
        }
      },
    });
    await expect(
      writer.migrateV1ToV2({
        expectedSourceByteRevision: ledgerByteRevision(source),
        expectedSourceSemanticRevision: semantic,
        journals: sequence,
      }),
    ).rejects.toThrow('focused cleanup interruption');
    expect(interrupted).toBeTrue();
    expect(existsSync(writer.recoveryPointerPath)).toBeTrue();

    const committedBytes = new Uint8Array(await readFile(path));
    const committed = unwrap(ledgerV2Codec.decode(committedBytes));
    const replacement = await createTestNodeLedgerWriter(path, {});
    const receipt = unwrap(
      await replacement.replace({
        model: committed.model,
        expectedByteRevision: ledgerByteRevision(committedBytes),
      }),
    );
    expect(receipt.changed).toBeFalse();
    expect(await replacement.recoverMigration()).toEqual({ ok: true, value: null });
    expect(await readdir(join(root, 'recovery', 'ledger', 'transactions'))).toEqual([]);
  });

  test('refuses a symlinked recovery root without changing its external target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-symlink-root-'));
    const external = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-external-'));
    roots.push(root, external);
    const sentinel = join(external, 'sentinel.txt');
    await writeFile(sentinel, 'unchanged\n');
    await chmod(external, 0o755);
    await mkdir(join(root, 'data'));
    await symlink(external, join(root, 'data', 'recovery'));
    const beforeMode = (await stat(external)).mode & 0o777;

    await expect(
      createTestNodeLedgerWriter(join(root, 'data', 'placements.json'), {}),
    ).rejects.toMatchObject({ code: 'invalid-state' });

    expect((await stat(external)).mode & 0o777).toBe(beforeMode);
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged\n');
    expect(await readdir(external)).toEqual(['sentinel.txt']);
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
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('accepts a net-zero rollback journal while refusing a forward no-op journal', async () => {
    const decoded = unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(V2_GOLDEN))));
    const seed = decoded.model.history[0];
    if (seed === undefined) throw new Error('missing committed history seed');
    const forwardNoop: LogicalJournalV1Dto = {
      ...seed,
      transactionId: 'tx:forward-noop',
      intent: { ...seed.intent, operationId: 'operation:forward-noop' },
      actual: { ...seed.actual, after: seed.actual.before, retained: [] },
    };
    const refused = selectBoundedHistory({
      ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
      history: [forwardNoop],
    });
    expect(refused).toEqual({
      ok: false,
      error: { code: 'invalid-history', transactionId: forwardNoop.transactionId },
    });

    const rollback: LogicalJournalV1Dto = {
      ...forwardNoop,
      transactionId: 'tx:rollback-net-zero',
      intent: { ...forwardNoop.intent, operationId: 'operation:rollback-net-zero' },
      disposition: 'rollback',
    };
    const selected = unwrap(
      selectBoundedHistory({
        ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
        history: [rollback],
      }),
    );
    expect(selected.history).toEqual([rollback]);
  });

  test('protects distinct source and destination placement anchors for one move-scope history row', async () => {
    const decoded = unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(V2_GOLDEN))));
    const seed = decoded.model.history[0];
    if (seed === undefined) throw new Error('missing committed history seed');
    const digest = parseArtifactDigest(`sha256:${'a'.repeat(64)}`);
    if (!digest.ok) throw new Error('fixture digest invalid');
    const sourcePath = '/fixture/user/skills/alpha';
    const destinationRoot = '/fixture/project';
    const destinationPath = `${destinationRoot}/.agents/skills/alpha`;
    const source = {
      kind: 'portable' as const,
      identity: { host: 'fixture.invalid', repository: 'acme/skills', path: 'skills/alpha' },
      requestedRef: null,
      resolvedSha: 'a'.repeat(40),
      sourcePath: 'skills/alpha',
      contentHash: digest.value,
    };
    const before = {
      kind: 'placement' as const,
      resource: {
        kind: 'live' as const,
        skill: 'alpha',
        tool: 'codex' as const,
        scope: 'user' as const,
        projectRoot: null,
        location: { kind: 'machine-bound' as const, path: sourcePath },
      },
      classification: 'pinned' as const,
      representation: 'copy' as const,
      linkTarget: null,
      dangling: false,
      source,
      contentHash: digest.value,
    };
    const after = {
      ...before,
      resource: {
        ...before.resource,
        scope: 'project' as const,
        projectRoot: { kind: 'machine-bound' as const, path: destinationRoot },
        location: { kind: 'machine-bound' as const, path: destinationPath },
      },
    };
    const liveBefore = {
      resourceId: 'live:alpha:codex',
      role: 'live' as const,
      state: 'present' as const,
      repositoryRevision: { kind: 'resource' as const, digest: digest.value },
      placementPath: sourcePath,
      liveKind: 'directory' as const,
      mode: 'pinned' as const,
      symlinkTarget: null,
      contentHash: digest.value,
    };
    const move: LogicalJournalV1Dto = {
      ...seed,
      transactionId: 'tx:move-scope-history',
      intent: {
        operationId: 'operation:move-scope-history',
        groupId: 'group:alpha',
        pairId: 'pair:alpha:codex',
        kind: 'move-scope',
        skill: 'alpha',
        source,
        tool: 'codex',
        scope: 'project',
        before,
        after,
        mutates: { live: true, manifest: false, lock: false, ledger: true },
        reversibility: { kind: 'conditional', retentionResourceIds: ['pair:alpha:codex'] },
        conflict: null,
      },
      actual: {
        before: [liveBefore, ...seed.actual.before],
        after: [{ ...liveBefore, placementPath: destinationPath }, ...seed.actual.after],
        retained: [],
      },
    };

    const anchors = unwrap(ledgerJournalAnchors(move));
    expect(anchors).toHaveLength(2);
    expect(anchors.some((anchor) => anchor.includes(sourcePath))).toBeTrue();
    expect(anchors.some((anchor) => anchor.includes(destinationPath))).toBeTrue();
    const selected = unwrap(
      selectBoundedHistory({
        ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
        history: [move],
      }),
    );
    expect(selected.history).toEqual([move]);
  });

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

  test('admits repeated committed operation identities and rejects a rollback without an exact parent', () => {
    const parent = dependencyForwardJournal(0);
    const duplicate: LogicalJournalV1Dto = {
      ...dependencyForwardJournal(1),
      intent: {
        ...dependencyForwardJournal(1).intent,
        operationId: parent.intent.operationId,
      },
    };
    const repeated = selectBoundedHistory({
      ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
      history: [parent, duplicate],
    });
    expect(repeated.ok).toBeTrue();
    if (repeated.ok) expect(repeated.value.history).toEqual([parent, duplicate]);

    const orphan: LogicalJournalV1Dto = {
      ...dependencyRollbackChild(parent, dependencyForwardJournal(2)),
      context: {
        ...parent.context,
        parentOperationId: 'operation:dependency:missing',
      },
    };
    expect(
      selectBoundedHistory({
        ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
        history: [parent, orphan],
      }),
    ).toEqual({
      ok: false,
      error: { code: 'invalid-history', transactionId: orphan.transactionId },
    });
  });

  test('retains repeated-operation rollback parents and children as exact LIFO units', () => {
    const olderParent = dependencyForwardJournal(0);
    const newerSeed = dependencyForwardJournal(1);
    const newerParent: LogicalJournalV1Dto = {
      ...newerSeed,
      intent: { ...olderParent.intent },
    };
    const newerChild = dependencyRollbackChild(newerParent, dependencyForwardJournal(2));
    const olderChildSeed = dependencyRollbackChild(olderParent, dependencyForwardJournal(3));
    const olderChild: LogicalJournalV1Dto = {
      ...olderChildSeed,
      intent: {
        ...olderChildSeed.intent,
        operationId: newerChild.intent.operationId,
        groupId: newerChild.intent.groupId,
      },
    };
    const tail = Array.from({ length: 254 }, (_, index) => dependencyForwardJournal(index + 4));
    const selected = unwrap(
      selectBoundedHistory({
        ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
        history: [olderParent, newerParent, newerChild, olderChild, ...tail],
      }),
    );
    const retainedIds = new Set(selected.history.map(({ transactionId }) => transactionId));
    for (const [parent, child] of [
      [olderParent, olderChild],
      [newerParent, newerChild],
    ] as const) {
      expect(retainedIds.has(parent.transactionId)).toBe(retainedIds.has(child.transactionId));
    }
  });

  test('admits a fair rollback child and its parent as one unit at the capacity boundary', () => {
    const history = Array.from({ length: 258 }, (_, index) => dependencyForwardJournal(index));
    const parent = history[1];
    const childIdentity = history[2];
    if (parent === undefined || childIdentity === undefined) {
      throw new Error('dependency capacity fixture is incomplete');
    }
    const child = dependencyRollbackChild(parent, childIdentity);
    history[2] = child;
    const selected = unwrap(
      selectBoundedHistory({
        ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
        history,
      }),
    );
    const selectedIds = selected.history.map(({ transactionId }) => transactionId);
    expect(selected.history).toHaveLength(257);
    expect(selectedIds).toContain(parent.transactionId);
    expect(selectedIds).toContain(child.transactionId);
    expect(selectedIds).not.toContain(history[0]?.transactionId);
  });

  test('raises protected capacity and lets newest, retained, and pending children protect parents', () => {
    const parent = dependencyForwardJournal(0);
    const protectedHistory = [parent];
    for (let index = 1; index <= 255; index += 1) {
      const identity = dependencyForwardJournal(index);
      protectedHistory.push(
        dependencyForwardJournal(index, [
          dependencyBackup(
            identity.transactionId,
            `/fixture/protected/${identity.transactionId}/live.backup`,
            '2026-08-01T00:00:00.000Z',
          ),
        ]),
      );
    }
    const newestChild = dependencyRollbackChild(parent, dependencyForwardJournal(256));
    protectedHistory.push(newestChild);
    const protectedSelection = unwrap(
      selectBoundedHistory({
        ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
        history: protectedHistory,
      }),
    );
    expect(protectedSelection.history).toHaveLength(257);
    expect(protectedSelection.history[0]?.transactionId).toBe(parent.transactionId);
    expect(protectedSelection.history.at(-1)?.transactionId).toBe(newestChild.transactionId);

    const parentBackup = dependencyBackup(
      parent.transactionId,
      `/fixture/.skillsmith-artifact-${parent.transactionId}/live.backup`,
    );
    const cleanupParent = dependencyForwardJournal(0, [parentBackup]);
    const pendingChild = dependencyRollbackChild(
      cleanupParent,
      dependencyForwardJournal(300),
      'live',
    );
    const pendingSelection = unwrap(
      selectBoundedHistory({
        ...emptyLedgerModel('2026-07-15T00:00:00.000Z'),
        transactions: { [pendingChild.transactionId]: pendingChild },
        history: [
          cleanupParent,
          ...Array.from({ length: 256 }, (_, index) => dependencyForwardJournal(index + 1)),
        ],
      }),
    );
    expect(pendingSelection.history.map(({ transactionId }) => transactionId)).toContain(
      cleanupParent.transactionId,
    );
    expect(pendingSelection.cleanupVictim?.transactionId).not.toBe(cleanupParent.transactionId);
  });

  test('refuses cleanup when revision authority is stale before filesystem access', async () => {
    const calls: string[] = [];
    const model = emptyLedgerModel('2026-07-15T00:00:00.000Z');
    const result = await cleanupHistoryVictim(
      {
        readFileMetadata: async (path) => {
          calls.push(path);
          return { kind: 'absent', mode: null, identity: null, linkCount: 0 };
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

  test('persists over-capacity history before cleanup and recognizes deletion-complete on restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-history-finalize-restart-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const fixture = await cleanupHistoryModel(root, 257, 1);
    let interrupted = false;
    const writer = await createTestNodeLedgerWriter(path, {
      afterBarrier: async ({ kind }) => {
        if (kind === 'history-backup-cleanup') {
          interrupted = true;
          throw Object.assign(new Error('history cleanup interruption'), { code: 'cancelled' });
        }
      },
    });
    await expect(
      writer.finalizeHistory({ model: fixture.model, expectedByteRevision: null }),
    ).rejects.toThrow('history cleanup interruption');
    expect(interrupted).toBeTrue();
    const durableBytes = new Uint8Array(await readFile(path));
    const durable = unwrap(ledgerV2Codec.decode(durableBytes));
    expect(durable.model.history).toHaveLength(257);
    expect(existsSync(fixture.backupPaths[0] as string)).toBeFalse();

    const resumed = await createTestNodeLedgerWriter(path, {});
    const receipt = unwrap(
      await resumed.finalizeHistory({
        model: durable.model,
        expectedByteRevision: ledgerByteRevision(durableBytes),
      }),
    );
    expect(receipt.model.history).toHaveLength(256);
    expect(
      unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(path)))).model.history,
    ).toEqual(receipt.model.history);
  }, 60_000);

  test('preflights and removes a shared-backup dependency closure as one victim unit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-history-dependency-cleanup-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const fixture = await dependencyCleanupModel(root);
    const selected = unwrap(selectBoundedHistory(fixture.model));
    expect(selected.cleanupVictim?.transactionId).toBe(fixture.child.transactionId);
    expect(selected.history.map(({ transactionId }) => transactionId)).toEqual(
      fixture.model.history.map(({ transactionId }) => transactionId),
    );

    const writer = await createTestNodeLedgerWriter(path, {});
    const receipt = unwrap(
      await writer.finalizeHistory({ model: fixture.model, expectedByteRevision: null }),
    );
    const finalIds = receipt.model.history.map(({ transactionId }) => transactionId);
    expect(receipt.model.history).toHaveLength(256);
    expect(finalIds).not.toContain(fixture.parent.transactionId);
    expect(finalIds).not.toContain(fixture.child.transactionId);
    expect(existsSync(fixture.backupPath)).toBeFalse();
  }, 30_000);

  test('keeps the complete dependency frontier durable when shared-backup proof is unsafe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-history-dependency-unsafe-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const fixture = await dependencyCleanupModel(root);
    const shared = join(root, 'linked-dependency-backup');
    await link(fixture.backupPath, shared);
    const writer = await createTestNodeLedgerWriter(path, {});
    expect(
      await writer.finalizeHistory({ model: fixture.model, expectedByteRevision: null }),
    ).toEqual({ ok: false, error: { code: 'invalid-state', path: fixture.backupPath } });
    const durable = unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(path)))).model;
    const durableIds = durable.history.map(({ transactionId }) => transactionId);
    expect(durableIds).toContain(fixture.parent.transactionId);
    expect(durableIds).toContain(fixture.child.transactionId);
    expect(selectBoundedHistory(durable)).toMatchObject({
      ok: true,
      value: { cleanupVictim: { transactionId: fixture.child.transactionId, status: 'pending' } },
    });
    expect(existsSync(fixture.backupPath)).toBeTrue();
  }, 30_000);

  test('restart never persists a rollback child after its shared-backup parent was cleaned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-history-dependency-restart-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const fixture = await dependencyCleanupModel(root);
    const interrupted = await createTestNodeLedgerWriter(path, {
      afterBarrier: async ({ kind }) => {
        if (kind === 'history-backup-cleanup') {
          throw Object.assign(new Error('dependency cleanup interruption'), { code: 'cancelled' });
        }
      },
    });
    await expect(
      interrupted.finalizeHistory({ model: fixture.model, expectedByteRevision: null }),
    ).rejects.toThrow('dependency cleanup interruption');
    const durableBytes = new Uint8Array(await readFile(path));
    const durable = unwrap(ledgerV2Codec.decode(durableBytes)).model;
    const durableIds = durable.history.map(({ transactionId }) => transactionId);
    expect(durableIds).toContain(fixture.parent.transactionId);
    expect(durableIds).toContain(fixture.child.transactionId);
    expect(existsSync(fixture.backupPath)).toBeFalse();

    const resumed = await createTestNodeLedgerWriter(path, {});
    const receipt = unwrap(
      await resumed.finalizeHistory({
        model: durable,
        expectedByteRevision: ledgerByteRevision(durableBytes),
      }),
    );
    const finalIds = receipt.model.history.map(({ transactionId }) => transactionId);
    expect(receipt.model.history).toHaveLength(256);
    expect(finalIds).not.toContain(fixture.parent.transactionId);
    expect(finalIds).not.toContain(fixture.child.transactionId);
    expect(
      unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(path)))).model.history,
    ).toEqual(receipt.model.history);
  }, 60_000);

  test('recomputes and removes one exact victim at a time until history converges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-history-finalize-repeat-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const fixture = await cleanupHistoryModel(root, 258, 2);
    const writer = await createTestNodeLedgerWriter(path, {});
    const receipt = unwrap(
      await writer.finalizeHistory({ model: fixture.model, expectedByteRevision: null }),
    );
    expect(receipt.model.history).toHaveLength(256);
    expect(fixture.backupPaths.map((backupPath) => existsSync(backupPath))).toEqual([false, false]);
  }, 30_000);

  test('allows a later terminal history change when durable pruning needs no backup proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-history-finalize-benign-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const durable = await cleanupHistoryModel(root, 257, 0);
    const durableTail = durable.model.history.at(-1);
    if (durableTail === undefined) throw new Error('missing durable history tail');
    const terminalTransactionId = (257).toString(16).padStart(16, '0');
    const terminal = {
      model: {
        ...durable.model,
        history: [
          ...durable.model.history,
          {
            ...durableTail,
            transactionId: terminalTransactionId,
            intent: {
              ...durableTail.intent,
              operationId: `operation:${terminalTransactionId}`,
            },
          },
        ],
      },
    };
    const writer = await createTestNodeLedgerWriter(path, {});
    const durableBytes = unwrap(ledgerV2Codec.encode(durable.model));
    await writeFile(path, durableBytes, { mode: 0o600 });
    expect(durable.model.history).toHaveLength(257);

    const finalized = unwrap(
      await writer.finalizeHistory({
        model: terminal.model,
        expectedByteRevision: ledgerByteRevision(durableBytes),
      }),
    );
    expect(finalized.model.history).toHaveLength(256);
    expect(finalized.model.history.at(-1)?.transactionId).toBe(
      terminal.model.history.at(-1)?.transactionId,
    );
  }, 15_000);

  test('leaves an unsafe linked victim durable and blocks a later history mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-history-finalize-unsafe-'));
    roots.push(root);
    const path = join(root, 'placements.json');
    const fixture = await cleanupHistoryModel(root, 257, 1);
    const backupPath = fixture.backupPaths[0] as string;
    await link(backupPath, join(root, 'shared-backup'));
    const writer = await createTestNodeLedgerWriter(path, {});
    const unsafe = await writer.finalizeHistory({
      model: fixture.model,
      expectedByteRevision: null,
    });
    expect(unsafe).toEqual({ ok: false, error: { code: 'invalid-state', path: backupPath } });
    const durableBytes = new Uint8Array(await readFile(path));
    const durable = unwrap(ledgerV2Codec.decode(durableBytes));
    expect(durable.model.history).toHaveLength(257);
    expect(existsSync(backupPath)).toBeTrue();

    const later = await cleanupHistoryModel(root, 258, 0);
    const blocked = await writer.finalizeHistory({
      model: later.model,
      expectedByteRevision: ledgerByteRevision(durableBytes),
    });
    expect(blocked).toEqual({ ok: false, error: { code: 'invalid-state', path: backupPath } });
    expect(new Uint8Array(await readFile(path))).toEqual(durableBytes);

    await rm(join(root, 'shared-backup'));
    const basePorts = await defaultRuntimePorts();
    const missingLinkCount = await createTestNodeLedgerWriter(path, {
      ports: {
        ...basePorts,
        readFileMetadata: async (candidate) => {
          const metadata = await basePorts.readFileMetadata(candidate);
          if (candidate !== backupPath) return metadata;
          const { linkCount: _linkCount, ...withoutLinkCount } = metadata;
          return withoutLinkCount;
        },
      },
    });
    const unavailableProof = await missingLinkCount.finalizeHistory({
      model: durable.model,
      expectedByteRevision: ledgerByteRevision(durableBytes),
    });
    expect(unavailableProof).toEqual({
      ok: false,
      error: { code: 'invalid-state', path: backupPath },
    });
    expect(new Uint8Array(await readFile(path))).toEqual(durableBytes);
  }, 30_000);
});
