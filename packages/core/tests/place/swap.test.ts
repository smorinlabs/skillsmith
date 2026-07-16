import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fromLedgerV1Dto } from '../../src/artifacts/ledger-codec.ts';
import type { LedgerModel } from '../../src/artifacts/ledger-types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  emptyLedger,
  getLedgerPairAt,
  getPairAt,
  setPair,
  withLedgerPairAt,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf, storeRootOf } from '../../src/place/paths.ts';
import { contentHashOf, resolveProvenance, snapshotToStore } from '../../src/place/store.ts';
import { resumeSwap, rollbackSwap, runSwap } from '../../src/place/swap.ts';
import type {
  DevRecord,
  LedgerFile,
  PinnedRecord,
  SwapCtx,
  SwapPlan,
} from '../../src/place/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const NOW = '2026-07-07T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const canonicalLedger = (ledger: LedgerFile): LedgerModel => {
  const converted = fromLedgerV1Dto(ledger);
  if (!converted.ok) throw new Error(`fixture ledger is invalid: ${converted.error.reason}`);
  return converted.value;
};

const getSwapPair = (ledger: SwapCtx['ledger'], skill: string, tool: 'claude-code') =>
  'schemaVersion' in ledger
    ? getPairAt(ledger, null, skill, tool)
    : getLedgerPairAt(ledger, null, skill, tool);

const canonicalCtxLedger = (ledger: SwapCtx['ledger']): LedgerModel => {
  if ('schemaVersion' in ledger) throw new Error('swap context retained a schema-v1 ledger');
  return ledger;
};

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
  opts: { txId?: string; signal?: AbortSignal } = {},
): SwapCtx => {
  const ctx: SwapCtx = {
    env,
    ledgerPath,
    ledger,
    persist: () => writeLedger(env, ledgerPath, canonicalCtxLedger(ctx.ledger)),
    now: () => NOW,
    newTxId: () => opts.txId ?? 'aabbccdd',
    signal: opts.signal,
  };
  return ctx;
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
    const pair = getSwapPair(ctx.ledger, 'alpha', 'claude-code');
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
    const down = await runSwap(ctx, demotePlan(s));
    if (!down.ok) throw new Error(msg(down.error));
    expect(down.value.backupKept).toBeNull();
    expect(down.value.warning).toBeNull();
    expect(await f.env.pathKind(s.placementPath)).toBe('symlink');
    expect(await f.env.readLink(s.placementPath)).toBe(s.target);
    expect(await residue(f.env, s.skillsRoot)).toEqual([]);
    const pair = getSwapPair(ctx.ledger, 'alpha', 'claude-code');
    expect(pair?.mode).toBe('dev');
    expect(pair?.pinned).not.toBeNull();
  });

  test('demote when the pinned copy was edited in place: backup kept + warning, still flips', async () => {
    const s = await seedAlphaDev(f);
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger);
    const up = await runSwap(ctx, promotePlan(s));
    if (!up.ok) throw new Error(msg(up.error));
    await appendFile(join(s.placementPath, 'SKILL.md'), '\nedited in place\n');
    const down = await runSwap(ctx, demotePlan(s));
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
    expect(getSwapPair(ctx.ledger, 'alpha', 'claude-code')?.journal).toBeNull();
  });

  test('pre-aborted signal → flip-failed, journal left recoverable, resumeSwap completes it', async () => {
    const s = await seedAlphaDev(f);
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger, { signal: controller.signal });
    const r = await runSwap(ctx, promotePlan(s));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('flip-failed');
    const pair = getSwapPair(ctx.ledger, 'alpha', 'claude-code');
    expect(pair?.journal).not.toBeNull();
    expect(pair?.journal?.phase).toBe('prepared');
    expect(await f.env.pathKind(s.placementPath)).toBe('symlink'); // live still old

    const resumeCtx = makeCtx(f.env, s.ledgerPath, canonicalCtxLedger(ctx.ledger));
    const resumed = await resumeSwap(resumeCtx, 'alpha', 'claude-code');
    if (!resumed.ok) throw new Error(msg(resumed.error));
    expect(resumed.value.committed).toBe(true);
    expect(await f.env.pathKind(s.placementPath)).toBe('dir');
    expect(getSwapPair(resumeCtx.ledger, 'alpha', 'claude-code')?.journal?.phase).toBe('committed');
    expect(await residue(f.env, s.skillsRoot)).toEqual([]);
  });

  test('abort persisted with the staged phase is observed before the pause listener is installed', async () => {
    const s = await seedAlphaDev(f);
    const controller = new AbortController();
    const ctx = makeCtx(f.env, s.ledgerPath, s.ledger, { signal: controller.signal });
    ctx.pauseAt = 'staged';
    ctx.persist = async () => {
      const persisted = await writeLedger(f.env, s.ledgerPath, canonicalCtxLedger(ctx.ledger));
      if (getSwapPair(ctx.ledger, 'alpha', 'claude-code')?.journal?.phase === 'staged') {
        controller.abort();
      }
      return persisted;
    };

    const interrupted = await runSwap(ctx, promotePlan(s));
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) expect(interrupted.error.code).toBe('flip-failed');
    expect(getSwapPair(ctx.ledger, 'alpha', 'claude-code')?.journal?.phase).toBe('staged');
    expect(await f.env.pathKind(s.placementPath)).toBe('symlink');
  });
});
