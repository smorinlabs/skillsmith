import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import { fromLedgerV1Dto, ledgerV2Codec } from '../../src/artifacts/ledger-codec.ts';
import type { LedgerModel } from '../../src/artifacts/ledger-types.ts';
import { hashSourceContentV1, projectSourceContent } from '../../src/artifacts/source-content.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  emptyLedger,
  emptyLedgerModel,
  getLedgerPairAt,
  setPair,
  withLedgerPairAt,
  withoutLedgerPairAt,
  writeLedger,
} from '../../src/place/ledger.ts';
import {
  abortPendingLogicalTransaction,
  advanceLogicalTransaction,
  commitLogicalTransaction,
} from '../../src/place/logical-transactions.ts';
import { ledgerPathOf, storeRootOf } from '../../src/place/paths.ts';
import { recoverPlacement } from '../../src/place/recovery.ts';
import { contentHashOf, resolveProvenance, snapshotToStore } from '../../src/place/store.ts';
import {
  resumeSwap,
  rollbackMoveScopeTransaction,
  rollbackSwap,
  runCommittedPlacementReversal,
  runMoveScopeTransaction,
  runSwap,
  sweepCommittedAcquireJournals,
} from '../../src/place/swap.ts';
import type {
  DevRecord,
  LedgerFile,
  PairRecord,
  PinnedRecord,
  SwapPlan,
  SwapRequest,
} from '../../src/place/types.ts';
import type { ExecutableOperation, OperationDigest } from '../../src/planning/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const NOW = '2026-07-07T00:00:00Z';
const JOURNAL_NOW = '2026-07-07T00:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}` as ArtifactDigest;
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const canonicalLedger = (ledger: LedgerFile): LedgerModel => {
  const converted = fromLedgerV1Dto(ledger);
  if (!converted.ok) throw new Error(`fixture ledger is invalid: ${converted.error.reason}`);
  return converted.value;
};

const getSwapPair = (ledger: LedgerModel, skill: string, tool: 'claude-code') =>
  getLedgerPairAt(ledger, null, skill, tool);

const dev = (sourcePath: string): DevRecord => ({
  sourcePath,
  resolvedPath: sourcePath,
  repoRoot: null,
  sourceRelPath: null,
  remote: null,
  recordedAt: NOW,
});

const pinnedOf = (storePath: string, rev: string, contentHash: string): PinnedRecord => ({
  storePath,
  rev,
  gitSha: null,
  dirty: false,
  contentHash,
  snapshotAt: NOW,
  verify: 'passed',
});

const makeCtx = (
  env: RuntimePorts,
  ledgerPath: string,
  ledger: LedgerModel,
  opts: {
    txId?: string;
    signal?: AbortSignal;
    pauseAt?: 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
    afterPersist?: (ledger: LedgerModel) => void;
    logicalOperation?: ExecutableOperation;
    journalTimestamp?: string;
  } = {},
): SwapRequest => {
  let durableLedger = ledger;
  return {
    context: {
      env,
      ...(opts.logicalOperation === undefined ? {} : { logicalOperation: opts.logicalOperation }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      ...(opts.pauseAt === undefined ? {} : { pauseAt: opts.pauseAt }),
    },
    state: { ledger },
    effects: {
      persistLedger: async (candidate) => {
        const written = await writeLedger(env, ledgerPath, candidate);
        if (!written.ok) return { ok: false, error: written.error, ledger: durableLedger };
        durableLedger = candidate;
        opts.afterPersist?.(candidate);
        return { ok: true, ledger: candidate };
      },
      journalNow: () => opts.journalTimestamp ?? NOW,
      newTransactionId: () => opts.txId ?? 'aabbccdd',
    },
  };
};

interface Seeded {
  ledgerPath: string;
  ledger: LedgerModel;
  skillsRoot: string;
  placementPath: string;
  storePath: string;
  contentHash: string;
  pinned: PinnedRecord;
  target: string; // original literal symlink target of the live placement
}

// Snapshot alpha into the store and record a dev-mode pair for it (the promote baseline).
const seedAlphaDev = async (f: FixtureFleet): Promise<Seeded> => {
  const skillsRoot = join(f.home, '.claude', 'skills');
  const placementPath = join(skillsRoot, 'alpha');
  const target = resolve(f.alphaSrc);
  const storeRoot = storeRootOf(f.data);
  const prov = await resolveProvenance(f.env, f.alphaSrc);
  if (!prov.ok) throw new Error(msg(prov.error));
  const snap = await snapshotToStore(f.env, {
    sourceDir: f.alphaSrc,
    skill: 'alpha',
    storeRoot,
    provenance: prov.value,
    txId: 'seed0001',
  });
  if (!snap.ok) throw new Error(msg(snap.error));
  const pinned = pinnedOf(snap.value.storePath, snap.value.rev, snap.value.contentHash);
  const ledger = emptyLedger(NOW);
  setPair(ledger, 'alpha', 'claude-code', {
    placementPath,
    mode: 'dev',
    dev: dev(target),
    pinned: null,
    journal: null,
  });
  return {
    ledgerPath: ledgerPathOf(f.data),
    ledger: canonicalLedger(ledger),
    skillsRoot,
    placementPath,
    storePath: snap.value.storePath,
    contentHash: snap.value.contentHash,
    pinned,
    target,
  };
};

const promotePlan = (s: Seeded): SwapPlan => ({
  op: 'promote',
  skill: 'alpha',
  tool: 'claude-code',
  skillsRoot: s.skillsRoot,
  placementPath: s.placementPath,
  promote: {
    storePath: s.storePath,
    contentHash: s.contentHash,
    pinned: s.pinned,
    devRecord: dev(s.target),
  },
});

const demotePlan = (s: Seeded): SwapPlan => ({
  op: 'dev',
  skill: 'alpha',
  tool: 'claude-code',
  skillsRoot: s.skillsRoot,
  placementPath: s.placementPath,
  dev: { sourcePath: s.target, devRecord: dev(s.target) },
});

const crossScopeJournal = (
  phase: LogicalJournalV1Dto['phase'],
  disposition: LogicalJournalV1Dto['disposition'] = 'forward',
): LogicalJournalV1Dto => {
  const committed = phase === 'committed';
  const sourcePath = '/fixture/user/skills/alpha';
  const destinationRoot = '/fixture/project';
  const destinationPath = `${destinationRoot}/.agents/skills/alpha`;
  const source = {
    kind: 'portable' as const,
    identity: { host: 'fixture.invalid', repository: 'acme/skills', path: 'skills/alpha' },
    requestedRef: null,
    resolvedSha: 'a'.repeat(40),
    sourcePath: 'skills/alpha',
    contentHash: DIGEST,
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
    contentHash: DIGEST,
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
  const ledgerActual = {
    resourceId: 'ledger:placements',
    role: 'ledger' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'resource' as const, digest: DIGEST },
    schemaVersion: 2 as const,
    semanticHash: DIGEST,
  };
  const liveBefore = {
    resourceId: 'live:alpha:codex',
    role: 'live' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'resource' as const, digest: DIGEST },
    placementPath: sourcePath,
    liveKind: 'directory' as const,
    mode: 'pinned' as const,
    symlinkTarget: null,
    contentHash: DIGEST,
  };
  const journal: LogicalJournalV1Dto = {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId: 'tx:move-scope-alpha',
    intent: {
      operationId: 'operation:move-scope-alpha',
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
    context: {
      parentOperationId: 'operation:move-scope-alpha',
      command: 'skillsmith-apply',
      workflow: 'reconcile-apply',
      attempt: 1,
      startedAt: JOURNAL_NOW,
    },
    disposition,
    phase,
    actual: {
      before: [liveBefore, ledgerActual],
      after:
        phase === 'live' || committed
          ? [{ ...liveBefore, placementPath: destinationPath }, ledgerActual]
          : [],
      retained: [],
    },
    updatedAt: JOURNAL_NOW,
    completedAt: committed ? JOURNAL_NOW : null,
  };
  return JSON.parse(JSON.stringify(journal)) as LogicalJournalV1Dto;
};

const crossScopeLedger = (): LedgerModel => {
  const pair: PairRecord = {
    placementPath: '/fixture/user/skills/alpha',
    mode: 'pinned',
    dev: null,
    pinned: pinnedOf('/fixture/store/alpha', 'a'.repeat(40), DIGEST),
    journal: null,
  };
  const placed = withLedgerPairAt(emptyLedgerModel(NOW), null, 'alpha', 'codex', pair);
  if (!placed.ok) throw new Error(msg(placed.error));
  return placed.value;
};

describe('cross-scope logical placement transaction', () => {
  test('retains the source membership through live and atomically moves it at one terminal commit', () => {
    let ledger = crossScopeLedger();
    for (const phase of ['prepared', 'staged', 'backed-up', 'live'] as const) {
      const advanced = advanceLogicalTransaction(ledger, crossScopeJournal(phase));
      if (!advanced.ok) throw new Error(`${phase}: ${advanced.error.message}`);
      ledger = advanced.value;
      expect(getLedgerPairAt(ledger, null, 'alpha', 'codex')?.journal).toBeNull();
      expect(getLedgerPairAt(ledger, '/fixture/project', 'alpha', 'codex')).toBeNull();
      expect(Object.keys(ledger.transactions)).toEqual(['tx:move-scope-alpha']);
    }

    const committed = commitLogicalTransaction(ledger, crossScopeJournal('committed'));
    if (!committed.ok) throw new Error(committed.error.message);
    expect(getLedgerPairAt(committed.value, null, 'alpha', 'codex')).toBeNull();
    expect(
      getLedgerPairAt(committed.value, '/fixture/project', 'alpha', 'codex')?.placementPath,
    ).toBe('/fixture/project/.agents/skills/alpha');
    expect(
      getLedgerPairAt(committed.value, '/fixture/project', 'alpha', 'codex')?.journal,
    ).toBeNull();
    expect(committed.value.transactions).toEqual({});
    expect(committed.value.history.map(({ transactionId }) => transactionId)).toEqual([
      'tx:move-scope-alpha',
    ]);
  });

  test('rollback keeps the source membership and never creates a destination shadow', () => {
    const prepared = advanceLogicalTransaction(crossScopeLedger(), crossScopeJournal('prepared'));
    if (!prepared.ok) throw new Error(prepared.error.message);
    const rollback = abortPendingLogicalTransaction(prepared.value, {
      transactionId: 'tx:move-scope-alpha',
      pairId: 'pair:alpha:codex',
      command: 'skillsmith-rollback',
      workflow: 'reconcile-apply',
      updatedAt: JOURNAL_NOW,
    });
    if (!rollback.ok) throw new Error(rollback.error.message);
    const rollbackPending = rollback.value.transactions['tx:move-scope-alpha'];
    if (rollbackPending === undefined) throw new Error('rollback transaction missing');
    const terminal = commitLogicalTransaction(rollback.value, {
      ...rollbackPending,
      phase: 'committed',
      actual: {
        ...rollbackPending.actual,
        after: rollbackPending.actual.before,
      },
      completedAt: JOURNAL_NOW,
    });
    if (!terminal.ok) throw new Error(terminal.error.message);
    expect(getLedgerPairAt(terminal.value, null, 'alpha', 'codex')?.placementPath).toBe(
      '/fixture/user/skills/alpha',
    );
    expect(getLedgerPairAt(terminal.value, '/fixture/project', 'alpha', 'codex')).toBeNull();
    expect(terminal.value.history).toHaveLength(1);
    expect(terminal.value.history[0]?.disposition).toBe('rollback');
  });
});

const seedPhysicalMoveScope = async (f: FixtureFleet) => {
  const sourcePath = join(f.home, '.claude', 'skills', 'alpha');
  const destinationPath = join(f.projectReal, '.claude', 'skills', 'alpha');
  await mkdir(join(f.projectReal, '.claude', 'skills'), { recursive: true });
  const provenance = await resolveProvenance(f.env, f.alphaSrc);
  if (!provenance.ok) throw new Error(msg(provenance.error));
  const snapshot = await snapshotToStore(f.env, {
    sourceDir: f.alphaSrc,
    skill: 'alpha',
    storeRoot: storeRootOf(f.data),
    provenance: provenance.value,
    txId: 'move-seed',
  });
  if (!snapshot.ok) throw new Error(msg(snapshot.error));
  const contentHash = snapshot.value.contentHash as `sha256:${string}`;
  await f.env.removeTree(sourcePath);
  await f.env.copyTree(snapshot.value.storePath, sourcePath);
  const pair: PairRecord = {
    placementPath: sourcePath,
    mode: 'pinned',
    dev: null,
    pinned: {
      ...pinnedOf(snapshot.value.storePath, snapshot.value.rev, snapshot.value.contentHash),
      placement: 'copy',
    },
    origin: {
      source: 'https://github.com/smorinlabs/fixture-harness//plugins/fh/skills/alpha',
      host: 'github.com',
      repo: 'smorinlabs/fixture-harness',
      skillPath: 'plugins/fh/skills/alpha',
      refRequested: null,
      refResolved: f.headSha,
      pin: true,
      installedAt: JOURNAL_NOW,
    },
    journal: null,
  };
  const placed = withLedgerPairAt(
    emptyLedgerModel(JOURNAL_NOW),
    null,
    'alpha',
    'claude-code',
    pair,
  );
  if (!placed.ok) throw new Error(msg(placed.error));
  const source = {
    kind: 'portable' as const,
    identity: {
      host: 'github.com',
      repository: 'smorinlabs/fixture-harness',
      path: 'plugins/fh/skills/alpha',
    },
    requestedRef: null,
    resolvedSha: f.headSha,
    sourcePath: 'plugins/fh/skills/alpha',
    contentHash,
  };
  const before = {
    kind: 'placement' as const,
    resource: {
      kind: 'live' as const,
      skill: 'alpha',
      tool: 'claude-code' as const,
      scope: 'user' as const,
      projectRoot: null,
      location: { kind: 'machine-bound' as const, path: sourcePath },
    },
    classification: 'pinned' as const,
    representation: 'copy' as const,
    linkTarget: null,
    dangling: false,
    source,
    contentHash,
  };
  const operation: ExecutableOperation = {
    operationId: 'operation:move-scope-alpha',
    groupId: 'group:move-scope-alpha',
    pairId: 'pair:move-scope-alpha',
    kind: 'move-scope',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: 'alpha',
    source,
    tool: 'claude-code',
    scope: 'project',
    before,
    after: {
      ...before,
      resource: {
        ...before.resource,
        scope: 'project',
        projectRoot: { kind: 'machine-bound', path: f.projectReal },
        location: { kind: 'machine-bound', path: destinationPath },
      },
    },
    reason: { code: 'fixture-move-scope', message: 'Move fixture scope.' },
    selectionSource: 'bounded-default',
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'conditional', retentionResourceIds: ['pair:move-scope-alpha'] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
  return Object.freeze({
    ledger: placed.value,
    ledgerPath: ledgerPathOf(f.data),
    sourcePath,
    destinationPath,
    operation,
  });
};

const seedPortableOperationMoveScope = async (f: FixtureFleet) => {
  const seeded = await seedPhysicalMoveScope(f);
  const projected = await projectSourceContent(f.env, seeded.sourcePath);
  if (!projected.ok) throw new Error(projected.error.message);
  const hashed = hashSourceContentV1(projected.value);
  if (!hashed.ok) throw new Error(hashed.error.message);
  const contentHash = hashed.value as OperationDigest;
  if (seeded.operation.source?.kind !== 'portable') {
    throw new Error('move-scope v1 seed is incomplete');
  }
  const source: NonNullable<ExecutableOperation['source']> = Object.freeze({
    ...seeded.operation.source,
    contentHash,
  });
  const before =
    seeded.operation.before.kind === 'placement'
      ? { ...seeded.operation.before, source, contentHash }
      : seeded.operation.before;
  const after =
    seeded.operation.after.kind === 'placement'
      ? { ...seeded.operation.after, source, contentHash }
      : seeded.operation.after;
  const operation: ExecutableOperation = Object.freeze({
    ...seeded.operation,
    source,
    before,
    after,
  });
  return Object.freeze({
    ...seeded,
    operation,
  });
};

const seedV1PhysicalMoveScope = async (f: FixtureFleet) => {
  const seeded = await seedPortableOperationMoveScope(f);
  const pair = getLedgerPairAt(seeded.ledger, null, 'alpha', 'claude-code');
  if (pair?.pinned == null || seeded.operation.source?.kind !== 'portable') {
    throw new Error('move-scope v1 seed is incomplete');
  }
  const placed = withLedgerPairAt(seeded.ledger, null, 'alpha', 'claude-code', {
    ...pair,
    pinned: { ...pair.pinned, contentHash: seeded.operation.source.contentHash },
  });
  if (!placed.ok) throw new Error(msg(placed.error));
  return Object.freeze({ ...seeded, ledger: placed.value });
};

describe('physical move-scope transaction', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('moves two live locations under one transaction and one terminal history identity', async () => {
    const seeded = await seedPhysicalMoveScope(f);
    const request = makeCtx(f.env, seeded.ledgerPath, seeded.ledger, {
      txId: 'move0001',
    });
    const moved = await runMoveScopeTransaction(
      {
        ...request,
        effects: { ...request.effects, journalNow: () => JOURNAL_NOW },
      },
      seeded.operation,
    );
    if (!moved.ok) throw new Error(msg(moved.error));

    expect(await f.env.pathKind(seeded.sourcePath)).toBe('absent');
    expect(await f.env.pathKind(seeded.destinationPath)).toBe('dir');
    expect(getLedgerPairAt(moved.state.ledger, null, 'alpha', 'claude-code')).toBeNull();
    expect(
      getLedgerPairAt(moved.state.ledger, f.projectReal, 'alpha', 'claude-code')?.placementPath,
    ).toBe(seeded.destinationPath);
    expect(
      getLedgerPairAt(moved.state.ledger, f.projectReal, 'alpha', 'claude-code')?.pinned?.placement,
    ).toBe('copy');
    expect(moved.state.ledger.transactions).toEqual({});
    expect(moved.state.ledger.history.map(({ transactionId }) => transactionId)).toEqual([
      'move0001',
    ]);
  });

  test('moves a portable source while preserving its distinct legacy ledger digest', async () => {
    const seeded = await seedPortableOperationMoveScope(f);
    const pair = getLedgerPairAt(seeded.ledger, null, 'alpha', 'claude-code');
    expect(pair?.pinned?.contentHash).not.toBe(seeded.operation.source?.contentHash);
    const request = makeCtx(f.env, seeded.ledgerPath, seeded.ledger, {
      txId: 'move-portable-legacy',
    });
    const moved = await runMoveScopeTransaction(
      { ...request, effects: { ...request.effects, journalNow: () => JOURNAL_NOW } },
      seeded.operation,
    );
    if (!moved.ok) throw new Error(msg(moved.error));
    expect(await f.env.pathKind(seeded.sourcePath)).toBe('absent');
    expect(await f.env.pathKind(seeded.destinationPath)).toBe('dir');
    expect(
      getLedgerPairAt(moved.state.ledger, f.projectReal, 'alpha', 'claude-code')?.pinned
        ?.contentHash,
    ).toBe(pair?.pinned?.contentHash);
  });

  test('reclaims an unchanged v1 copy backup after a committed scope move', async () => {
    const seeded = await seedV1PhysicalMoveScope(f);
    const transactionId = 'movev101';
    const backupPath = join(
      dirname(seeded.sourcePath),
      `.skillsmith-backup-alpha-${transactionId}`,
    );
    const request = makeCtx(f.env, seeded.ledgerPath, seeded.ledger, { txId: transactionId });
    const moved = await runMoveScopeTransaction(
      { ...request, effects: { ...request.effects, journalNow: () => JOURNAL_NOW } },
      seeded.operation,
    );
    if (!moved.ok) throw new Error(msg(moved.error));

    expect(moved.value).toMatchObject({ backupKept: null, warning: null });
    expect(await f.env.pathKind(backupPath)).toBe('absent');
  });

  test('refuses content metadata drift before persisting prepared', async () => {
    const seeded = await seedPhysicalMoveScope(f);
    const drifted: ExecutableOperation = {
      ...seeded.operation,
      before: {
        ...seeded.operation.before,
        contentHash: `sha256:${'b'.repeat(64)}`,
      } as ExecutableOperation['before'],
    };
    const request = makeCtx(f.env, seeded.ledgerPath, seeded.ledger, { txId: 'move-drift' });
    const refused = await runMoveScopeTransaction(
      { ...request, effects: { ...request.effects, journalNow: () => JOURNAL_NOW } },
      drifted,
    );
    expect(refused.ok).toBeFalse();
    expect(refused.state.ledger.transactions).toEqual({});
    expect(await f.env.pathKind(seeded.sourcePath)).toBe('dir');
    expect(await f.env.pathKind(seeded.destinationPath)).toBe('absent');
  });

  test('moves a pinned symlink from project scope back to user scope', async () => {
    const seeded = await seedPhysicalMoveScope(f);
    const userPair = getLedgerPairAt(seeded.ledger, null, 'alpha', 'claude-code');
    if (userPair?.pinned == null) throw new Error('source pair missing');
    await f.env.removeTree(seeded.sourcePath);
    await f.env.makeSymlink(userPair.pinned.storePath, seeded.destinationPath);
    const withoutUser = withoutLedgerPairAt(seeded.ledger, null, 'alpha', 'claude-code');
    if (!withoutUser.ok) throw new Error(msg(withoutUser.error));
    const projectPair = withLedgerPairAt(withoutUser.value, f.projectReal, 'alpha', 'claude-code', {
      ...userPair,
      placementPath: seeded.destinationPath,
      pinned: { ...userPair.pinned, placement: 'symlink' },
    });
    if (!projectPair.ok) throw new Error(msg(projectPair.error));
    if (
      seeded.operation.before.kind !== 'placement' ||
      seeded.operation.after.kind !== 'placement'
    ) {
      throw new Error('fixture operation images invalid');
    }
    const linkTarget = { kind: 'machine-bound' as const, path: userPair.pinned.storePath };
    const operation: ExecutableOperation = {
      ...seeded.operation,
      scope: 'user',
      before: {
        ...seeded.operation.after,
        classification: 'store-linked',
        representation: 'symlink',
        linkTarget,
      },
      after: {
        ...seeded.operation.before,
        classification: 'pinned',
        representation: 'symlink',
        linkTarget,
      },
    };
    const request = makeCtx(f.env, seeded.ledgerPath, projectPair.value, {
      txId: 'move-symlink',
    });
    const moved = await runMoveScopeTransaction(
      { ...request, effects: { ...request.effects, journalNow: () => JOURNAL_NOW } },
      operation,
    );
    if (!moved.ok) throw new Error(msg(moved.error));
    expect(await f.env.pathKind(seeded.destinationPath)).toBe('absent');
    expect(await f.env.pathKind(seeded.sourcePath)).toBe('symlink');
    expect(await f.env.readLink(seeded.sourcePath)).toBe(userPair.pinned.storePath);
    expect(getLedgerPairAt(moved.state.ledger, f.projectReal, 'alpha', 'claude-code')).toBeNull();
    expect(
      getLedgerPairAt(moved.state.ledger, null, 'alpha', 'claude-code')?.pinned?.placement,
    ).toBe('symlink');
  });

  test('resumes after the source rename crash window and rolls it back from the same durable state', async () => {
    const seeded = await seedPhysicalMoveScope(f);
    const baseRename = f.env.rename;
    let crashRenameSource = seeded.sourcePath;
    const crashingEnv: RuntimePorts = {
      ...f.env,
      rename: async (source, destination) => {
        await baseRename(source, destination);
        if (source === crashRenameSource) {
          crashRenameSource = '';
          throw new Error('simulated process death after move-scope rename');
        }
      },
    };
    const request = makeCtx(crashingEnv, seeded.ledgerPath, seeded.ledger, { txId: 'move0002' });
    const interrupted = await runMoveScopeTransaction(
      { ...request, effects: { ...request.effects, journalNow: () => JOURNAL_NOW } },
      seeded.operation,
    );
    expect(interrupted.ok).toBeFalse();
    expect(interrupted.state.ledger.transactions.move0002?.phase).toBe('backed-up');
    expect(await f.env.pathKind(seeded.sourcePath)).toBe('absent');

    const journal = interrupted.state.ledger.transactions.move0002;
    if (journal === undefined) throw new Error('pending move transaction missing');
    const resumed = await recoverPlacement(
      {
        env: f.env,
        ledgerPath: seeded.ledgerPath,
        ledger: interrupted.state.ledger,
        journalNow: () => JOURNAL_NOW,
        newTransactionId: () => 'unused',
      },
      'resume',
      { skill: 'alpha', tool: 'claude-code' },
    );
    if (!resumed.ok) throw new Error(msg(resumed.error));
    expect(await f.env.pathKind(seeded.destinationPath)).toBe('dir');
    expect(resumed.state.ledger.history).toHaveLength(1);

    await f.env.removeTree(seeded.destinationPath);
    const second = await seedPhysicalMoveScope(f);
    crashRenameSource = join(dirname(second.destinationPath), '.skillsmith-staging-alpha-move0003');
    const rollbackRequest = makeCtx(crashingEnv, second.ledgerPath, second.ledger, {
      txId: 'move0003',
    });
    const secondInterrupted = await runMoveScopeTransaction(
      {
        ...rollbackRequest,
        effects: { ...rollbackRequest.effects, journalNow: () => JOURNAL_NOW },
      },
      second.operation,
    );
    expect(secondInterrupted.state.ledger.transactions.move0003?.phase).toBe('live');
    expect(await f.env.pathKind(second.destinationPath)).toBe('dir');
    const rollbackJournal = secondInterrupted.state.ledger.transactions.move0003;
    if (rollbackJournal === undefined) throw new Error('rollback move transaction missing');
    const rolledBack = await recoverPlacement(
      {
        env: f.env,
        ledgerPath: second.ledgerPath,
        ledger: secondInterrupted.state.ledger,
        journalNow: () => JOURNAL_NOW,
        newTransactionId: () => 'unused',
      },
      'rollback',
      {
        skill: 'alpha',
        tool: 'claude-code',
        rollbackContext: { command: 'skillsmith-undo', workflow: 'undo' },
      },
    );
    if (!rolledBack.ok) throw new Error(msg(rolledBack.error));
    expect(await f.env.pathKind(second.sourcePath)).toBe('dir');
    expect(await f.env.pathKind(second.destinationPath)).toBe('absent');
    expect(rolledBack.state.ledger.history[0]?.disposition).toBe('rollback');
    expect(rolledBack.state.ledger.history[0]?.context).toMatchObject({
      command: 'skillsmith-undo',
      workflow: 'undo',
    });
  });

  test('resume obeys a durable rollback direction after a crash at the rollback boundary', async () => {
    const seeded = await seedPhysicalMoveScope(f);
    const baseRename = f.env.rename;
    let crashAfterSourceRename = true;
    const crashingEnv: RuntimePorts = {
      ...f.env,
      rename: async (source, destination) => {
        await baseRename(source, destination);
        if (crashAfterSourceRename && source === seeded.sourcePath) {
          crashAfterSourceRename = false;
          throw new Error('simulated process death after source rename');
        }
      },
    };
    const request = makeCtx(crashingEnv, seeded.ledgerPath, seeded.ledger, { txId: 'move0004' });
    const interrupted = await runMoveScopeTransaction(
      { ...request, effects: { ...request.effects, journalNow: () => JOURNAL_NOW } },
      seeded.operation,
    );
    const pending = interrupted.state.ledger.transactions.move0004;
    if (pending === undefined) throw new Error('pending move transaction missing');

    const captured: { durableRollback?: LedgerModel } = {};
    const rollbackRequest = makeCtx(f.env, seeded.ledgerPath, interrupted.state.ledger, {
      afterPersist: (candidate) => {
        if (candidate.transactions.move0004?.disposition === 'rollback') {
          captured.durableRollback = candidate;
          throw new Error('simulated process death after durable rollback direction');
        }
      },
    });
    try {
      await rollbackMoveScopeTransaction(
        {
          ...rollbackRequest,
          effects: { ...rollbackRequest.effects, journalNow: () => JOURNAL_NOW },
        },
        pending,
      );
      throw new Error('rollback boundary did not interrupt');
    } catch (error) {
      expect((error as Error).message).toContain('durable rollback direction');
    }
    const durableRollback = captured.durableRollback;
    if (durableRollback === undefined) throw new Error('durable rollback model missing');
    expect(durableRollback.transactions.move0004?.disposition).toBe('rollback');
    expect(await f.env.pathKind(seeded.sourcePath)).toBe('absent');

    const recovered = await recoverPlacement(
      {
        env: f.env,
        ledgerPath: seeded.ledgerPath,
        ledger: durableRollback,
        journalNow: () => JOURNAL_NOW,
        newTransactionId: () => 'unused',
      },
      'resume',
      { skill: 'alpha', tool: 'claude-code' },
    );
    if (!recovered.ok) throw new Error(msg(recovered.error));
    expect(await f.env.pathKind(seeded.sourcePath)).toBe('dir');
    expect(await f.env.pathKind(seeded.destinationPath)).toBe('absent');
    expect(recovered.state.ledger.history[0]?.disposition).toBe('rollback');
  });

  test('reclaims a duplicate unchanged v1 backup while completing move rollback', async () => {
    const seeded = await seedV1PhysicalMoveScope(f);
    const transactionId = 'movev102';
    const backupPath = join(
      dirname(seeded.sourcePath),
      `.skillsmith-backup-alpha-${transactionId}`,
    );
    const baseRename = f.env.rename;
    const crashingEnv: RuntimePorts = {
      ...f.env,
      rename: async (source, destination) => {
        await baseRename(source, destination);
        if (source === seeded.sourcePath) {
          throw new Error('simulated process death after v1 source rename');
        }
      },
    };
    const request = makeCtx(crashingEnv, seeded.ledgerPath, seeded.ledger, {
      txId: transactionId,
    });
    const interrupted = await runMoveScopeTransaction(
      { ...request, effects: { ...request.effects, journalNow: () => JOURNAL_NOW } },
      seeded.operation,
    );
    const pending = interrupted.state.ledger.transactions[transactionId];
    if (pending === undefined) throw new Error('v1 rollback transaction is missing');

    const captured: { durableRollback?: LedgerModel } = {};
    const rollbackRequest = makeCtx(f.env, seeded.ledgerPath, interrupted.state.ledger, {
      afterPersist: (candidate) => {
        if (candidate.transactions[transactionId]?.disposition === 'rollback') {
          captured.durableRollback = candidate;
          throw new Error('simulated process death after v1 rollback direction');
        }
      },
    });
    await expect(
      rollbackMoveScopeTransaction(
        {
          ...rollbackRequest,
          effects: { ...rollbackRequest.effects, journalNow: () => JOURNAL_NOW },
        },
        pending,
      ),
    ).rejects.toThrow('simulated process death after v1 rollback direction');
    if (captured.durableRollback === undefined) throw new Error('v1 rollback model is missing');

    await f.env.copyTree(backupPath, seeded.sourcePath);
    const recovered = await recoverPlacement(
      {
        env: f.env,
        ledgerPath: seeded.ledgerPath,
        ledger: captured.durableRollback,
        journalNow: () => JOURNAL_NOW,
        newTransactionId: () => 'unused',
      },
      'resume',
      { skill: 'alpha', tool: 'claude-code' },
    );
    if (!recovered.ok) throw new Error(msg(recovered.error));
    expect(await f.env.pathKind(seeded.sourcePath)).toBe('dir');
    expect(await f.env.pathKind(backupPath)).toBe('absent');
    expect(recovered.state.ledger.history[0]?.disposition).toBe('rollback');
  });

  test('reclaims an unchanged v1 move backup during committed recovery sweep', async () => {
    const seeded = await seedV1PhysicalMoveScope(f);
    const transactionId = 'movev103';
    const backupPath = join(
      dirname(seeded.sourcePath),
      `.skillsmith-backup-alpha-${transactionId}`,
    );
    const baseRemoveTree = f.env.removeTree;
    const cleanupFaultEnv: RuntimePorts = {
      ...f.env,
      removeTree: async (path) => {
        if (path === backupPath) throw new Error('simulated v1 post-commit cleanup fault');
        await baseRemoveTree(path);
      },
    };
    const request = makeCtx(cleanupFaultEnv, seeded.ledgerPath, seeded.ledger, {
      txId: transactionId,
    });
    const interrupted = await runMoveScopeTransaction(
      { ...request, effects: { ...request.effects, journalNow: () => JOURNAL_NOW } },
      seeded.operation,
    );
    expect(interrupted.ok).toBeFalse();
    expect(interrupted.state.ledger.history.at(-1)?.transactionId).toBe(transactionId);
    expect(await f.env.pathKind(backupPath)).toBe('dir');

    const swept = await sweepCommittedAcquireJournals(
      makeCtx(f.env, seeded.ledgerPath, interrupted.state.ledger),
    );
    if (!swept.ok) throw new Error(msg(swept.error));
    expect(swept.value).toEqual([]);
    expect(await f.env.pathKind(backupPath)).toBe('absent');
  });
});

const residue = async (env: RuntimePorts, skillsRoot: string): Promise<string[]> =>
  (await env.listDir(skillsRoot)).filter((n) => n.startsWith('.skillsmith-'));

describe('runSwap — promote / demote happy paths', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('promote alpha: symlink → pinned dir, backup gone, journal committed, dev retained', async () => {
    const s = await seedAlphaDev(f);
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger);
    const r = await runSwap(ctx, promotePlan(s));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.committed).toBe(true);
    expect(await f.env.pathKind(s.placementPath)).toBe('dir');
    const h = await contentHashOf(f.env, s.placementPath);
    if (!h.ok) throw new Error(msg(h.error));
    expect(h.value).toBe(s.contentHash);
    expect(await residue(f.env, s.skillsRoot)).toEqual([]);
    const pair = getSwapPair(r.state.ledger, 'alpha', 'claude-code');
    expect(pair?.mode).toBe('pinned');
    expect(pair?.journal?.phase).toBe('committed');
    expect(pair?.journal?.completedAt).not.toBeNull();
    expect(pair?.dev).not.toBeNull();
  });

  test('demote back: pinned dir → symlink with verbatim target, old copy gone, pinned retained', async () => {
    const s = await seedAlphaDev(f);
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger);
    const up = await runSwap(ctx, promotePlan(s));
    if (!up.ok) throw new Error(msg(up.error));
    const down = await runSwap(makeCtx(f.env, s.ledgerPath, up.state.ledger), demotePlan(s));
    if (!down.ok) throw new Error(msg(down.error));
    expect(down.value.backupKept).toBeNull();
    expect(down.value.warning).toBeNull();
    expect(await f.env.pathKind(s.placementPath)).toBe('symlink');
    expect(await f.env.readLink(s.placementPath)).toBe(s.target);
    expect(await residue(f.env, s.skillsRoot)).toEqual([]);
    const pair = getSwapPair(down.state.ledger, 'alpha', 'claude-code');
    expect(pair?.mode).toBe('dev');
    expect(pair?.pinned).not.toBeNull();
  });

  test('atomically publishes a fresh rollback child with its inverse shadow and recovery never toggles it', async () => {
    const s = await seedAlphaDev(f);
    const source = {
      kind: 'local-dev' as const,
      path: s.target,
      contentHash: s.contentHash as OperationDigest,
    };
    const resource = {
      kind: 'live' as const,
      skill: 'alpha',
      tool: 'claude-code' as const,
      scope: 'user' as const,
      projectRoot: null,
      location: { kind: 'machine-bound' as const, path: s.placementPath },
    };
    const promoted: ExecutableOperation = {
      operationId: 'operation:promote-alpha',
      groupId: 'group:promote-alpha',
      pairId: 'pair:alpha:claude-code',
      kind: 'promote',
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
      skill: 'alpha',
      source,
      tool: 'claude-code',
      scope: 'user',
      before: {
        kind: 'placement',
        resource,
        classification: 'dev',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: s.target },
        dangling: false,
        source,
        contentHash: source.contentHash,
      },
      after: {
        kind: 'placement',
        resource,
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source,
        contentHash: source.contentHash,
      },
      reason: { code: 'promote-selected', message: 'Promote alpha.' },
      selectionSource: 'explicit-targets',
      preconditionIds: [],
      requiredCheckIds: [],
      reversibility: { kind: 'conditional', retentionResourceIds: ['pair:alpha:claude-code'] },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      conflict: null,
    };
    let currentLedger = s.ledger;
    for (const phase of ['prepared', 'staged', 'backed-up', 'live'] as const) {
      const forwardOperation: ExecutableOperation = {
        ...promoted,
        operationId: `${promoted.operationId}:${phase}`,
        groupId: `${promoted.groupId}:${phase}`,
      };
      const parentTransactionId = `parent-promote-${phase}`;
      const forward = await runSwap(
        makeCtx(f.env, s.ledgerPath, currentLedger, {
          txId: parentTransactionId,
          logicalOperation: forwardOperation,
          journalTimestamp: JOURNAL_NOW,
        }),
        promotePlan(s),
      );
      if (!forward.ok) throw new Error(`${phase}: ${msg(forward.error)}`);
      const parent = forward.state.ledger.history.find(
        (journal) => journal.transactionId === parentTransactionId,
      );
      if (parent === undefined) throw new Error(`${phase}: committed parent journal is missing`);
      expect(parent.actual.retained).toMatchObject([
        {
          resourceId: promoted.pairId,
          path: s.target,
          repositoryRevision: { digest: s.contentHash },
          contentHash: s.contentHash,
        },
      ]);

      const reversal: ExecutableOperation = {
        ...forwardOperation,
        operationId: `operation:reverse-promote-alpha:${phase}`,
        groupId: `group:reverse-promote-alpha:${phase}`,
        before: forwardOperation.after,
        after: forwardOperation.before,
        reason: { code: 'rollback-inverse', message: 'Restore alpha development placement.' },
      };
      const transactionId = `fresh-promote-reversal-${phase}`;
      const controller = new AbortController();
      const persisted: LedgerModel[] = [];
      const interrupted = await runCommittedPlacementReversal(
        makeCtx(f.env, s.ledgerPath, forward.state.ledger, {
          txId: transactionId,
          signal: controller.signal,
          pauseAt: phase,
          logicalOperation: reversal,
          journalTimestamp: JOURNAL_NOW,
          afterPersist: (ledger) => {
            persisted.push(ledger);
            if (getSwapPair(ledger, 'alpha', 'claude-code')?.journal?.phase === phase) {
              controller.abort();
            }
          },
        }),
        parent.transactionId,
      );
      expect(interrupted.ok, phase).toBeFalse();
      expect(persisted.length, phase).toBeGreaterThanOrEqual(1);
      const first = persisted[0];
      if (first === undefined) throw new Error(`${phase}: fresh first publication is missing`);
      const firstChild = first.transactions[transactionId];
      const durableParent = first.history.find(
        (journal) => journal.transactionId === parent.transactionId,
      );
      if (durableParent === undefined) throw new Error(`${phase}: durable parent is missing`);
      expect(firstChild, phase).toMatchObject({
        disposition: 'rollback',
        phase: 'prepared',
        context: { parentOperationId: durableParent.intent.operationId },
        actual: { before: durableParent.actual.after, after: [] },
      });
      expect(getSwapPair(first, 'alpha', 'claude-code')?.journal, phase).toMatchObject({
        op: 'dev',
        txId: firstChild?.transactionId,
        phase: 'prepared',
      });
      expect(ledgerV2Codec.encode(first).ok, phase).toBeTrue();
      const durableChild = interrupted.state.ledger.transactions[transactionId];
      expect(durableChild?.phase, phase).toBe(phase);
      expect(getSwapPair(interrupted.state.ledger, 'alpha', 'claude-code')?.journal?.op).toBe(
        'dev',
      );

      const recovered = await recoverPlacement(
        {
          env: f.env,
          ledgerPath: s.ledgerPath,
          ledger: interrupted.state.ledger,
          journalNow: () => JOURNAL_NOW,
          newTransactionId: () => 'unused-recovery-id',
          logicalOperation: reversal,
        },
        'rollback',
        { skill: 'alpha', tool: 'claude-code' },
      );
      if (!recovered.ok) throw new Error(`${phase}: ${msg(recovered.error)}`);
      expect(await f.env.pathKind(s.placementPath), phase).toBe('symlink');
      expect(await f.env.readLink(s.placementPath), phase).toBe(s.target);
      expect(recovered.state.ledger.transactions, phase).toEqual({});
      const committedChild = recovered.state.ledger.history.find(
        (journal) => journal.transactionId === transactionId,
      );
      expect(committedChild, phase).toMatchObject({
        disposition: 'rollback',
        phase: 'committed',
        intent: { operationId: reversal.operationId },
        actual: { after: durableParent.actual.before },
      });
      currentLedger = recovered.state.ledger;
    }
  }, 20_000);

  test('demote when the pinned copy was edited in place: backup kept + warning, still flips', async () => {
    const s = await seedAlphaDev(f);
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger);
    const up = await runSwap(ctx, promotePlan(s));
    if (!up.ok) throw new Error(msg(up.error));
    await appendFile(join(s.placementPath, 'SKILL.md'), '\nedited in place\n');
    const down = await runSwap(makeCtx(f.env, s.ledgerPath, up.state.ledger), demotePlan(s));
    if (!down.ok) throw new Error(msg(down.error));
    expect(down.value.backupKept).not.toBeNull();
    expect(down.value.warning).not.toBeNull();
    expect(await f.env.pathKind(s.placementPath)).toBe('symlink');
    expect(await f.env.pathKind(down.value.backupKept as string)).toBe('dir');
  });

  test('demote of an adopted hand-copy (pinned: null): backup always kept + warning', async () => {
    const skillsRoot = join(f.home, '.claude', 'skills');
    const placementPath = join(skillsRoot, 'copied'); // fixture real dir
    const ledger = emptyLedger(NOW);
    setPair(ledger, 'copied', 'claude-code', {
      placementPath,
      mode: 'pinned',
      dev: dev(resolve(f.alphaSrc)),
      pinned: null,
      journal: null,
    });
    const ctx = makeCtx(f.env, ledgerPathOf(f.data), canonicalLedger(ledger));
    const r = await runSwap(ctx, {
      op: 'dev',
      skill: 'copied',
      tool: 'claude-code',
      skillsRoot,
      placementPath,
      dev: { sourcePath: resolve(f.alphaSrc), devRecord: dev(resolve(f.alphaSrc)) },
    });
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.backupKept).not.toBeNull();
    expect(r.value.warning).not.toBeNull();
    expect(await f.env.pathKind(placementPath)).toBe('symlink');
    expect(await f.env.pathKind(r.value.backupKept as string)).toBe('dir');
  });

  test('install replacement retains an unmanaged directory backup even when its bytes match the incoming artifact', async () => {
    const skillsRoot = join(f.home, '.claude', 'skills');
    const placementPath = join(skillsRoot, 'copied');
    const provenance = await resolveProvenance(f.env, placementPath);
    if (!provenance.ok) throw new Error(msg(provenance.error));
    const snapshot = await snapshotToStore(f.env, {
      sourceDir: placementPath,
      skill: 'copied',
      storeRoot: storeRootOf(f.data),
      provenance: provenance.value,
      txId: 'seed0002',
    });
    if (!snapshot.ok) throw new Error(msg(snapshot.error));
    const ledger = emptyLedger(NOW);
    const r = await runSwap(makeCtx(f.env, ledgerPathOf(f.data), canonicalLedger(ledger)), {
      op: 'install',
      skill: 'copied',
      tool: 'claude-code',
      skillsRoot,
      placementPath,
      install: {
        build: 'symlink',
        storePath: snapshot.value.storePath,
        contentHash: snapshot.value.contentHash,
        pinned: pinnedOf(snapshot.value.storePath, snapshot.value.rev, snapshot.value.contentHash),
        origin: {
          source: 'fixture/unmanaged-copy',
          host: 'local.skillsmith.invalid',
          repo: 'fixture/unmanaged-copy',
          skillPath: 'copied',
          refRequested: null,
          refResolved: 'a'.repeat(40),
          pin: false,
          installedAt: NOW,
        },
        adoptedDev: null,
      },
    });
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.backupKept).not.toBeNull();
    expect(r.value.warning).toContain('no trusted before-image authorizes removal');
    expect(await f.env.pathKind(r.value.backupKept as string)).toBe('dir');
    const backupHash = await contentHashOf(f.env, r.value.backupKept as string);
    if (!backupHash.ok) throw new Error(msg(backupHash.error));
    expect(backupHash.value).toBe(snapshot.value.contentHash);
  });

  test('resumes an interrupted machine-bound pinned-copy install without synthetic origin', async () => {
    const skill = 'local-sync';
    const skillsRoot = join(f.home, '.claude', 'skills');
    const placementPath = join(skillsRoot, skill);
    const provenance = await resolveProvenance(f.env, f.alphaSrc);
    if (!provenance.ok) throw new Error(msg(provenance.error));
    const snapshot = await snapshotToStore(f.env, {
      sourceDir: f.alphaSrc,
      skill,
      storeRoot: storeRootOf(f.data),
      provenance: provenance.value,
      txId: 'locals01',
    });
    if (!snapshot.ok) throw new Error(msg(snapshot.error));
    const pinned = pinnedOf(
      snapshot.value.storePath,
      snapshot.value.rev,
      snapshot.value.contentHash,
    );
    const source = {
      kind: 'local-dev' as const,
      path: resolve(f.alphaSrc),
      contentHash: snapshot.value.contentHash as OperationDigest,
    };
    const liveResource = {
      kind: 'live' as const,
      skill,
      tool: 'claude-code' as const,
      scope: 'user' as const,
      projectRoot: null,
      location: { kind: 'machine-bound' as const, path: placementPath },
    };
    const logicalOperation: ExecutableOperation = {
      operationId: 'operation:sync-local-install',
      groupId: 'group:sync-local-install',
      pairId: 'pair:sync-local-install',
      kind: 'install',
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
      skill,
      source,
      tool: 'claude-code',
      scope: 'user',
      before: { kind: 'absent', resource: liveResource },
      after: {
        kind: 'placement',
        resource: liveResource,
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source,
        contentHash: source.contentHash,
      },
      reason: { code: 'sync-install-selected', message: 'Install local sync source.' },
      selectionSource: 'bounded-default',
      preconditionIds: [],
      requiredCheckIds: [],
      reversibility: { kind: 'none', retentionResourceIds: [] },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      conflict: null,
    };
    const plan: SwapPlan = {
      op: 'install',
      skill,
      tool: 'claude-code',
      skillsRoot,
      placementPath,
      install: {
        build: 'copy',
        storePath: snapshot.value.storePath,
        contentHash: snapshot.value.contentHash,
        pinned,
        origin: null,
        adoptedDev: null,
      },
    };
    const controller = new AbortController();
    controller.abort();
    const interrupted = await runSwap(
      makeCtx(f.env, ledgerPathOf(f.data), emptyLedgerModel(NOW), {
        signal: controller.signal,
        logicalOperation,
        journalTimestamp: JOURNAL_NOW,
      }),
      plan,
    );
    expect(interrupted.ok).toBeFalse();
    if (interrupted.ok) throw new Error('expected interrupted local install');
    expect(interrupted.error.code).toBe('flip-failed');
    expect(msg(interrupted.error)).toContain('interrupted');
    expect(getSwapPair(interrupted.state.ledger, skill, 'claude-code')).toMatchObject({
      mode: 'pinned',
      pinned: { contentHash: snapshot.value.contentHash },
      journal: { op: 'install', phase: 'prepared' },
    });
    expect(getSwapPair(interrupted.state.ledger, skill, 'claude-code')?.origin).toBeUndefined();
    expect(Object.values(interrupted.state.ledger.transactions)).toMatchObject([
      {
        intent: {
          kind: 'install',
          source: { kind: 'local-dev', contentHash: snapshot.value.contentHash },
        },
      },
    ]);

    const resumed = await resumeSwap(
      makeCtx(f.env, ledgerPathOf(f.data), interrupted.state.ledger, {
        journalTimestamp: JOURNAL_NOW,
      }),
      skill,
      'claude-code',
    );
    if (!resumed.ok) throw new Error(msg(resumed.error));
    expect(await f.env.pathKind(placementPath)).toBe('dir');
    const installedHash = await contentHashOf(f.env, placementPath);
    if (!installedHash.ok) throw new Error(msg(installedHash.error));
    expect(installedHash.value).toBe(snapshot.value.contentHash);
    const pair = getSwapPair(resumed.state.ledger, skill, 'claude-code');
    expect(pair?.origin).toBeUndefined();
    expect(pair?.journal).toBeNull();
  });
});

describe('runSwap / rollbackSwap — guards and abort', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('runSwap on an uncommitted journal → flip-refused naming both remediations', async () => {
    const s = await seedAlphaDev(f);
    const pair = getSwapPair(s.ledger, 'alpha', 'claude-code');
    if (!pair) throw new Error('seed pair missing');
    const pending = withLedgerPairAt(s.ledger, null, 'alpha', 'claude-code', {
      ...pair,
      journal: {
        op: 'promote',
        txId: 'deadbeef',
        phase: 'staged',
        startedAt: NOW,
        completedAt: null,
        before: { mode: 'dev', symlinkTarget: s.target },
        stagingPath: join(s.skillsRoot, '.skillsmith-staging-alpha-deadbeef'),
        backupPath: join(s.skillsRoot, '.skillsmith-backup-alpha-deadbeef'),
      },
    });
    if (!pending.ok) throw new Error(msg(pending.error));
    s.ledger = pending.value;
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger);
    const r = await runSwap(ctx, promotePlan(s));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('flip-refused');
      expect(msg(r.error)).toContain('--rollback');
      expect(msg(r.error)).toContain('re-run');
    }
  });

  test('rollbackSwap with no journal → flip-refused (nothing to roll back)', async () => {
    const s = await seedAlphaDev(f);
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger);
    const r = await rollbackSwap(ctx, 'alpha', 'claude-code');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('flip-refused');
      expect(msg(r.error)).toContain('nothing to roll back');
    }
  });

  test('rollbackSwap preserves the migrated compatibility path when no logical transaction exists', async () => {
    const s = await seedAlphaDev(f);
    const pair = getSwapPair(s.ledger, 'alpha', 'claude-code');
    if (!pair) throw new Error('seed pair missing');
    const stagingPath = join(s.skillsRoot, '.skillsmith-staging-alpha-deadbeef');
    await f.env.copyTree(s.storePath, stagingPath);
    const pending = withLedgerPairAt(s.ledger, null, 'alpha', 'claude-code', {
      ...pair,
      journal: {
        op: 'promote',
        txId: 'deadbeef',
        phase: 'staged',
        startedAt: NOW,
        completedAt: null,
        before: { mode: 'dev', symlinkTarget: s.target },
        stagingPath,
        backupPath: join(s.skillsRoot, '.skillsmith-backup-alpha-deadbeef'),
      },
    });
    if (!pending.ok) throw new Error(msg(pending.error));
    const ctx = makeCtx(f.env, s.ledgerPath, pending.value);

    const rolledBack = await rollbackSwap(ctx, 'alpha', 'claude-code');
    if (!rolledBack.ok) throw new Error(msg(rolledBack.error));
    expect(await f.env.readLink(s.placementPath)).toBe(s.target);
    expect(await f.env.pathKind(stagingPath)).toBe('absent');
    expect(getSwapPair(rolledBack.state.ledger, 'alpha', 'claude-code')?.journal).toBeNull();
  });

  test('pre-aborted signal → flip-failed, journal left recoverable, resumeSwap completes it', async () => {
    const s = await seedAlphaDev(f);
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger, { signal: controller.signal });
    const r = await runSwap(ctx, promotePlan(s));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('flip-failed');
    const pair = getSwapPair(r.state.ledger, 'alpha', 'claude-code');
    expect(pair?.journal).not.toBeNull();
    expect(pair?.journal?.phase).toBe('prepared');
    expect(await f.env.pathKind(s.placementPath)).toBe('symlink'); // live still old

    const resumeCtx = makeCtx(f.env, s.ledgerPath, r.state.ledger);
    const resumed = await resumeSwap(resumeCtx, 'alpha', 'claude-code');
    if (!resumed.ok) throw new Error(msg(resumed.error));
    expect(resumed.value.committed).toBe(true);
    expect(await f.env.pathKind(s.placementPath)).toBe('dir');
    expect(getSwapPair(resumed.state.ledger, 'alpha', 'claude-code')?.journal?.phase).toBe(
      'committed',
    );
    expect(await residue(f.env, s.skillsRoot)).toEqual([]);
  });

  test('abort persisted with the staged phase is observed before the pause listener is installed', async () => {
    const s = await seedAlphaDev(f);
    const controller = new AbortController();
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger, {
      signal: controller.signal,
      pauseAt: 'staged',
      afterPersist: (ledger) => {
        if (getSwapPair(ledger, 'alpha', 'claude-code')?.journal?.phase === 'staged') {
          controller.abort();
        }
      },
    });

    const interrupted = await runSwap(ctx, promotePlan(s));
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) expect(interrupted.error.code).toBe('flip-failed');
    expect(getSwapPair(interrupted.state.ledger, 'alpha', 'claude-code')?.journal?.phase).toBe(
      'staged',
    );
    expect(await f.env.pathKind(s.placementPath)).toBe('symlink');
  });
});
