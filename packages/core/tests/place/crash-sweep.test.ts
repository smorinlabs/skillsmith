import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PathKind, ScanEnv } from '../../src/env/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { emptyLedger, getPair, readLedger, setPair, writeLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf, storeRootOf } from '../../src/place/paths.ts';
import { contentHashOf, resolveProvenance, snapshotToStore } from '../../src/place/store.ts';
import { resumeSwap, rollbackSwap, runSwap } from '../../src/place/swap.ts';
import type {
  DevRecord,
  JournalPhase,
  LedgerFile,
  PinnedRecord,
  SwapCtx,
  SwapPlan,
} from '../../src/place/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';
import { SimulatedCrash, crashingEnv } from './crash-env.ts';

const NOW = '2026-07-07T00:00:00Z';
const TXID = 'sweeptx1';
const SKILL = 'alpha';
const TOOL = 'claude-code';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

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

const makeCtx = (env: ScanEnv, ledgerPath: string, ledger: LedgerFile): SwapCtx => ({
  env,
  ledgerPath,
  ledger,
  persist: () => writeLedger(env, ledgerPath, ledger),
  now: () => NOW,
  newTxId: () => TXID,
});

const ctxFromDisk = async (env: ScanEnv, ledgerPath: string): Promise<SwapCtx> => {
  const read = await readLedger(env, ledgerPath);
  if (!read.ok) throw new Error(msg(read.error));
  return makeCtx(env, ledgerPath, read.value);
};

const hashOf = async (env: ScanEnv, dir: string): Promise<string> => {
  const h = await contentHashOf(env, dir);
  if (!h.ok) throw new Error(msg(h.error));
  return h.value;
};

const residue = async (env: ScanEnv, skillsRoot: string): Promise<string[]> =>
  (await env.listDir(skillsRoot)).filter((n) => n.startsWith('.skillsmith-'));

// fsync is durability-only and uncounted by crashingEnv, so stubbing it leaves the state machine
// identical while sparing the shared runner's disk (real fsync here starves parallel git builds).
const fastEnv = (inner: ScanEnv): ScanEnv => ({
  ...inner,
  fsyncFile: async () => {},
  fsyncDir: async () => {},
});

// Surgical snapshot/restore: only the placement + this op's swap residue + the ledger change during
// a swap, so we copy just those (not the whole fixture skills root — that would starve the shared
// runner's git-based fleet builds).
const managedNames = (skill: string, txId: string): string[] => [
  skill,
  `.skillsmith-staging-${skill}-${txId}`,
  `.skillsmith-backup-${skill}-${txId}`,
];

const saveState = async (
  env: ScanEnv,
  skillsRoot: string,
  ledgerPath: string,
  dest: string,
): Promise<void> => {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const name of managedNames(SKILL, TXID)) {
    const src = join(skillsRoot, name);
    if ((await env.pathKind(src)) !== 'absent') {
      await cp(src, join(dest, name), { recursive: true, verbatimSymlinks: true });
    }
  }
  await cp(ledgerPath, join(dest, 'ledger.json'));
};

const restoreState = async (
  env: ScanEnv,
  skillsRoot: string,
  ledgerPath: string,
  src: string,
): Promise<void> => {
  for (const name of managedNames(SKILL, TXID)) {
    await rm(join(skillsRoot, name), { recursive: true, force: true });
    const saved = join(src, name);
    if ((await env.pathKind(saved)) !== 'absent') {
      await cp(saved, join(skillsRoot, name), { recursive: true, verbatimSymlinks: true });
    }
  }
  await rm(ledgerPath, { force: true });
  await cp(join(src, 'ledger.json'), ledgerPath);
};

interface SweepCfg {
  op: 'promote' | 'dev';
  skillsRoot: string;
  placementPath: string;
  ledgerPath: string;
  storePath: string;
  contentHash: string; // store entry hash (== pinned copy hash)
  target: string; // dev source / restored symlink literal target
  makePlan: () => SwapPlan;
}

// Build the promote baseline: alpha snapshotted into the store + a dev-mode pair on disk.
const setupPromote = async (f: FixtureFleet): Promise<SweepCfg> => {
  const env = fastEnv(f.env);
  const skillsRoot = join(f.home, '.claude', 'skills');
  const placementPath = join(skillsRoot, SKILL);
  const ledgerPath = ledgerPathOf(f.data);
  const target = resolve(f.alphaSrc);
  const prov = await resolveProvenance(env, f.alphaSrc);
  if (!prov.ok) throw new Error(msg(prov.error));
  const snap = await snapshotToStore(env, {
    sourceDir: f.alphaSrc,
    skill: SKILL,
    storeRoot: storeRootOf(f.data),
    provenance: prov.value,
    txId: 'seed0001',
  });
  if (!snap.ok) throw new Error(msg(snap.error));
  const pinned = pinnedOf(snap.value.storePath, snap.value.rev, snap.value.contentHash);
  const ledger = emptyLedger(NOW);
  setPair(ledger, SKILL, TOOL, {
    placementPath,
    mode: 'dev',
    dev: dev(target),
    pinned: null,
    journal: null,
  });
  const w = await writeLedger(env, ledgerPath, ledger);
  if (!w.ok) throw new Error(msg(w.error));
  return {
    op: 'promote',
    skillsRoot,
    placementPath,
    ledgerPath,
    storePath: snap.value.storePath,
    contentHash: snap.value.contentHash,
    target,
    makePlan: () => ({
      op: 'promote',
      skill: SKILL,
      tool: TOOL,
      skillsRoot,
      placementPath,
      promote: {
        storePath: snap.value.storePath,
        contentHash: snap.value.contentHash,
        pinned,
        devRecord: dev(target),
      },
    }),
  };
};

// Build the dev (demote) baseline: promote alpha cleanly first, then sweep the demote.
const setupDev = async (f: FixtureFleet): Promise<SweepCfg> => {
  const env = fastEnv(f.env);
  const base = await setupPromote(f);
  const ctx = await ctxFromDisk(env, base.ledgerPath);
  const up = await runSwap(ctx, base.makePlan());
  if (!up.ok) throw new Error(`baseline promote failed: ${msg(up.error)}`);
  const w = await writeLedger(env, base.ledgerPath, ctx.ledger);
  if (!w.ok) throw new Error(msg(w.error));
  return {
    op: 'dev',
    skillsRoot: base.skillsRoot,
    placementPath: base.placementPath,
    ledgerPath: base.ledgerPath,
    storePath: base.storePath,
    contentHash: base.contentHash,
    target: base.target,
    makePlan: () => ({
      op: 'dev',
      skill: SKILL,
      tool: TOOL,
      skillsRoot: base.skillsRoot,
      placementPath: base.placementPath,
      dev: { sourcePath: base.target, devRecord: dev(base.target) },
    }),
  };
};

const runCrashSweep = async (f: FixtureFleet, cfg: SweepCfg): Promise<void> => {
  const env = fastEnv(f.env);
  const { op, skillsRoot, placementPath, ledgerPath, storePath, contentHash, target } = cfg;
  const backupPath = join(skillsRoot, `.skillsmith-backup-${SKILL}-${TXID}`);
  const oldKind: PathKind = op === 'promote' ? 'symlink' : 'dir';
  const newKind: PathKind = op === 'promote' ? 'dir' : 'symlink';
  const baseline = join(f.base, `tpl-baseline-${op}`);
  const crashed = join(f.base, `tpl-crashed-${op}`);
  await saveState(env, skillsRoot, ledgerPath, baseline);

  // Invariant 1/2/3 on the crashed state — never a partial artifact; absence recoverable; store OK.
  const assertInvariants = async (): Promise<void> => {
    const lk = await env.pathKind(placementPath);
    expect(['symlink', 'dir', 'absent']).toContain(lk);
    if (lk === 'dir') expect(await hashOf(env, placementPath)).toBe(contentHash);
    if (lk === 'absent') expect(await env.pathKind(backupPath)).not.toBe('absent');
    expect(await env.pathKind(storePath)).not.toBe('absent');
    expect(await hashOf(env, storePath)).toBe(contentHash);
  };

  const assertLiveIs = async (kind: PathKind): Promise<void> => {
    expect(await env.pathKind(placementPath)).toBe(kind);
    if (kind === 'symlink') expect(await env.readLink(placementPath)).toBe(target);
    if (kind === 'dir') expect(await hashOf(env, placementPath)).toBe(contentHash);
  };

  // The crash state belongs to THIS op only when the on-disk journal is for it. A journal from a
  // prior committed op (or none) means this op never persisted its prepared record (C0).
  const journalPhase = async (): Promise<JournalPhase | 'none'> => {
    const l = await readLedger(env, ledgerPath);
    if (!l.ok) throw new Error(msg(l.error));
    const j = getPair(l.value, SKILL, TOOL)?.journal ?? null;
    if (!j || j.op !== op) return 'none';
    return j.phase;
  };

  // Learn the mutation count of a clean run (never-crashing wrapper counts the calls).
  await restoreState(env, skillsRoot, ledgerPath, baseline);
  const counter = crashingEnv(env, 0);
  const dry = await runSwap(await ctxFromDisk(counter.env, ledgerPath), cfg.makePlan());
  if (!dry.ok) throw new Error(`dry run failed: ${msg(dry.error)}`);
  const totalMutations = counter.calls();
  expect(totalMutations).toBeGreaterThan(0);

  const observed = new Set<JournalPhase | 'none'>();

  for (let n = 1; n <= totalMutations; n++) {
    await restoreState(env, skillsRoot, ledgerPath, baseline);

    // Crash the op at the nth mutating call (may surface as err or a thrown SimulatedCrash).
    const crash = crashingEnv(env, n);
    try {
      await runSwap(await ctxFromDisk(crash.env, ledgerPath), cfg.makePlan());
    } catch (e) {
      if (!(e instanceof SimulatedCrash)) throw e;
    }

    const jp = await journalPhase();
    observed.add(jp);
    await assertInvariants();
    await saveState(env, skillsRoot, ledgerPath, crashed);

    // --rollback branch.
    if (jp === 'none') {
      const rb = await rollbackSwap(await ctxFromDisk(env, ledgerPath), SKILL, TOOL);
      expect(rb.ok).toBe(false); // C0: nothing to roll back — before-state already intact
      await assertLiveIs(oldKind);
      expect(await residue(env, skillsRoot)).toEqual([]);
    } else if (jp === 'committed') {
      const rb = await rollbackSwap(await ctxFromDisk(env, ledgerPath), SKILL, TOOL);
      expect(rb.ok).toBe(false); // C6: run layer performs the inverse flip, not rollbackSwap
      await assertLiveIs(newKind);
    } else {
      const rb = await rollbackSwap(await ctxFromDisk(env, ledgerPath), SKILL, TOOL);
      if (!rb.ok) throw new Error(`rollback n=${n} (${jp}): ${msg(rb.error)}`);
      await assertLiveIs(oldKind); // restored byte-identically
      const l = await readLedger(env, ledgerPath);
      if (!l.ok) throw new Error(msg(l.error));
      expect(getPair(l.value, SKILL, TOOL)?.journal).toBeNull();
      expect(await residue(env, skillsRoot)).toEqual([]);
    }

    // Same-op re-run branch (on the original crashed state).
    await restoreState(env, skillsRoot, ledgerPath, crashed);
    const recovered =
      jp === 'none'
        ? await runSwap(await ctxFromDisk(env, ledgerPath), cfg.makePlan())
        : await resumeSwap(await ctxFromDisk(env, ledgerPath), SKILL, TOOL);
    if (!recovered.ok) throw new Error(`re-run n=${n} (${jp}): ${msg(recovered.error)}`);
    await assertLiveIs(newKind); // converged to the committed after-state
    const l = await readLedger(env, ledgerPath);
    if (!l.ok) throw new Error(msg(l.error));
    const pair = getPair(l.value, SKILL, TOOL);
    expect(pair?.journal?.phase).toBe('committed');
    expect(pair?.journal?.completedAt).not.toBeNull();
    expect(await residue(env, skillsRoot)).toEqual([]);
  }

  // Every journal phase was visited across the sweep (C0 aside).
  for (const phase of ['prepared', 'staged', 'backed-up', 'live', 'committed'] as const) {
    expect(observed.has(phase)).toBe(true);
  }
};

describe('crash sweep — promote', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  }, 60_000);
  afterEach(async () => {
    await destroyFixtureFleet(f);
  }, 60_000);

  test('every mutating-call crash point holds the invariants, rolls back, and resumes', async () => {
    await runCrashSweep(f, await setupPromote(f));
  }, 120_000);
});

describe('crash sweep — dev', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  }, 60_000);
  afterEach(async () => {
    await destroyFixtureFleet(f);
  }, 60_000);

  test('every mutating-call crash point holds the invariants, rolls back, and resumes', async () => {
    await runCrashSweep(f, await setupDev(f));
  }, 120_000);
});
