import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { defaultScanEnv } from '../../src/env/default.ts';
import type { PathKind, ScanEnv } from '../../src/env/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  emptyLedger,
  getPairAt,
  readLedger,
  setPairAt,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf, storeRootOf } from '../../src/place/paths.ts';
import { contentHashOf, resolveProvenance, snapshotToStore } from '../../src/place/store.ts';
import { resumeSwap, rollbackSwap, runSwap } from '../../src/place/swap.ts';
import {
  type DevRecord,
  FLIP_TOOLS,
  type JournalPhase,
  type LedgerFile,
  type OriginRecord,
  type PairRecord,
  type PinnedRecord,
  type SwapCtx,
  type SwapPlan,
} from '../../src/place/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';
import { SimulatedCrash, crashingEnv } from './crash-env.ts';

const NOW = '2026-07-07T00:00:00Z';
const TXID = 'sweeptx1';
const SKILL = 'zeta';
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

const origin = (): OriginRecord => ({
  source: 'smorinlabs/fixture-harness/zeta',
  host: 'github.com',
  repo: 'smorinlabs/fixture-harness',
  skillPath: 'plugins/fh/skills/alpha',
  refRequested: null,
  refResolved: 'a'.repeat(40),
  pin: false,
  installedAt: NOW,
});

const pinnedOf = (
  storePath: string,
  rev: string,
  contentHash: string,
  placement: 'symlink' | 'copy',
): PinnedRecord => ({
  storePath,
  rev,
  gitSha: null,
  dirty: false,
  contentHash,
  snapshotAt: NOW,
  verify: 'passed',
  placement,
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
// identical while sparing the shared runner's disk.
const fastEnv = (inner: ScanEnv): ScanEnv => ({
  ...inner,
  fsyncFile: async () => {},
  fsyncDir: async () => {},
});

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

interface StoreSeed {
  storePath: string;
  rev: string;
  contentHash: string;
}

const seedStore = async (f: FixtureFleet, env: ScanEnv): Promise<StoreSeed> => {
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
  return {
    storePath: snap.value.storePath,
    rev: snap.value.rev,
    contentHash: snap.value.contentHash,
  };
};

interface AcquireCfg {
  op: 'install' | 'uninstall';
  isFresh: boolean;
  skillsRoot: string;
  placementPath: string;
  ledgerPath: string;
  storePath: string;
  contentHash: string;
  oldKind: PathKind; // before-state live kind ('absent' for a fresh install)
  newKind: PathKind; // after-state live kind ('absent' for uninstall)
  oldTarget: string | null; // expected readLink when oldKind === 'symlink'
  newTarget: string | null; // expected readLink when newKind === 'symlink'
  expectedPhases: JournalPhase[];
  makePlan: () => SwapPlan;
}

// The generic acquisition crash sweep: crash a clean run at every mutating call, then assert the
// invariants, the --rollback branch (restores the before-state), and the same-op re-run branch
// (converges to the after-state). Adapts the P12 procedure per acquisition op.
const runAcquireSweep = async (f: FixtureFleet, cfg: AcquireCfg): Promise<void> => {
  const env = fastEnv(f.env);
  const { op, isFresh, skillsRoot, placementPath, ledgerPath, storePath, contentHash } = cfg;
  const backupPath = join(skillsRoot, `.skillsmith-backup-${SKILL}-${TXID}`);
  const baseline = join(f.base, `tpl-baseline-${op}-${cfg.newKind}`);
  const crashed = join(f.base, `tpl-crashed-${op}-${cfg.newKind}`);

  await saveState(env, skillsRoot, ledgerPath, baseline);

  const pairOnDisk = async (): Promise<PairRecord | null> => {
    const l = await readLedger(env, ledgerPath);
    if (!l.ok) throw new Error(msg(l.error));
    return getPairAt(l.value, null, SKILL, TOOL);
  };

  const journalPhase = async (): Promise<JournalPhase | 'none'> => {
    const pair = await pairOnDisk();
    const j = pair?.journal ?? null;
    if (!j || j.op !== op) return 'none';
    return j.phase;
  };

  const assertLiveIs = async (kind: PathKind, target: string | null): Promise<void> => {
    expect(await env.pathKind(placementPath)).toBe(kind);
    if (kind === 'symlink' && target !== null)
      expect(await env.readLink(placementPath)).toBe(target);
    if (kind === 'dir') expect(await hashOf(env, placementPath)).toBe(contentHash);
  };

  const assertInvariants = async (jp: JournalPhase | 'none'): Promise<void> => {
    const lk = await env.pathKind(placementPath);
    expect([cfg.oldKind, cfg.newKind, 'absent']).toContain(lk); // live is never partial
    if (lk === 'dir') expect(await hashOf(env, placementPath)).toBe(contentHash);
    if (lk === 'symlink') {
      const t = await env.readLink(placementPath);
      expect([cfg.oldTarget, cfg.newTarget].filter((x): x is string => x !== null)).toContain(t);
    }
    // the store entry is never deleted or mutated
    expect(await env.pathKind(storePath)).not.toBe('absent');
    expect(await hashOf(env, storePath)).toBe(contentHash);
    // whenever live is absent mid-swap, the old state survives at the backup (fresh installs have
    // no old state; a committed uninstall may already have reclaimed its verified backup).
    if (lk === 'absent' && !isFresh && jp !== 'none' && jp !== 'committed') {
      expect(await env.pathKind(backupPath)).not.toBe('absent');
    }
  };

  // Learn the mutation count of a clean run.
  await restoreState(env, skillsRoot, ledgerPath, baseline);
  const counter = crashingEnv(env, 0);
  const dry = await runSwap(await ctxFromDisk(counter.env, ledgerPath), cfg.makePlan());
  if (!dry.ok) throw new Error(`dry run failed: ${msg(dry.error)}`);
  const totalMutations = counter.calls();
  expect(totalMutations).toBeGreaterThan(0);

  const observed = new Set<JournalPhase | 'none'>();

  for (let n = 1; n <= totalMutations; n++) {
    await restoreState(env, skillsRoot, ledgerPath, baseline);

    const crash = crashingEnv(env, n);
    try {
      await runSwap(await ctxFromDisk(crash.env, ledgerPath), cfg.makePlan());
    } catch (e) {
      if (!(e instanceof SimulatedCrash)) throw e;
    }

    const jp = await journalPhase();
    observed.add(jp);
    await assertInvariants(jp);
    await saveState(env, skillsRoot, ledgerPath, crashed);

    // ---- --rollback branch ----
    if (jp === 'none') {
      const rb = await rollbackSwap(await ctxFromDisk(env, ledgerPath), SKILL, TOOL);
      expect(rb.ok).toBe(false); // before-state already intact — nothing to roll back
      if (isFresh) {
        await assertLiveIs('absent', null);
        expect(await pairOnDisk()).toBeNull();
      } else {
        await assertLiveIs(cfg.oldKind, cfg.oldTarget);
      }
    } else if (jp === 'committed') {
      const backupPresent = (await env.pathKind(backupPath)) !== 'absent';
      if (op === 'uninstall' && backupPresent) {
        // committed uninstall, pre-reclaim: the backup still holds the skill — rollback restores it.
        const rb = await rollbackSwap(await ctxFromDisk(env, ledgerPath), SKILL, TOOL);
        if (!rb.ok) throw new Error(`rollback n=${n} (committed uninstall): ${msg(rb.error)}`);
        await assertLiveIs(cfg.oldKind, cfg.oldTarget);
        expect((await pairOnDisk())?.journal).toBeNull();
        expect(await residue(env, skillsRoot)).toEqual([]);
      } else {
        // committed install, or a reclaimed uninstall — the run layer performs any inverse.
        const rb = await rollbackSwap(await ctxFromDisk(env, ledgerPath), SKILL, TOOL);
        expect(rb.ok).toBe(false);
        await assertLiveIs(cfg.newKind, cfg.newTarget);
      }
    } else {
      const rb = await rollbackSwap(await ctxFromDisk(env, ledgerPath), SKILL, TOOL);
      if (!rb.ok) throw new Error(`rollback n=${n} (${jp}): ${msg(rb.error)}`);
      if (isFresh) {
        await assertLiveIs('absent', null); // fresh-install rollback → placement absent…
        expect(await pairOnDisk()).toBeNull(); // …AND the pair record is deleted
      } else {
        await assertLiveIs(cfg.oldKind, cfg.oldTarget); // restored byte-identically
        expect((await pairOnDisk())?.journal).toBeNull();
      }
      expect(await residue(env, skillsRoot)).toEqual([]);
    }

    // ---- same-op re-run branch (on the original crashed state) ----
    await restoreState(env, skillsRoot, ledgerPath, crashed);
    const recovered =
      jp === 'none'
        ? await runSwap(await ctxFromDisk(env, ledgerPath), cfg.makePlan())
        : await resumeSwap(await ctxFromDisk(env, ledgerPath), SKILL, TOOL);
    if (!recovered.ok) throw new Error(`re-run n=${n} (${jp}): ${msg(recovered.error)}`);

    if (op === 'uninstall') {
      await assertLiveIs('absent', null);
      expect(await pairOnDisk()).toBeNull(); // pair gone with the skill
    } else {
      await assertLiveIs(cfg.newKind, cfg.newTarget); // converged to the committed after-state
      const pair = await pairOnDisk();
      expect(pair?.mode).toBe('pinned');
      expect(pair?.journal).toBeNull(); // acquisition ops leave no committed journal at rest
    }
    expect(await residue(env, skillsRoot)).toEqual([]);
  }

  for (const phase of cfg.expectedPhases) {
    expect(observed.has(phase)).toBe(true);
  }
};

// ---- setups ----

const freshInstall = async (f: FixtureFleet, build: 'symlink' | 'copy'): Promise<AcquireCfg> => {
  const env = fastEnv(f.env);
  const skillsRoot = join(f.home, '.claude', 'skills');
  const placementPath = join(skillsRoot, SKILL);
  const ledgerPath = ledgerPathOf(f.data);
  const s = await seedStore(f, env);
  const w = await writeLedger(env, ledgerPath, emptyLedger(NOW));
  if (!w.ok) throw new Error(msg(w.error));
  return {
    op: 'install',
    isFresh: true,
    skillsRoot,
    placementPath,
    ledgerPath,
    storePath: s.storePath,
    contentHash: s.contentHash,
    oldKind: 'absent',
    newKind: build === 'symlink' ? 'symlink' : 'dir',
    oldTarget: null,
    newTarget: build === 'symlink' ? s.storePath : null,
    expectedPhases: ['prepared', 'staged', 'backed-up', 'live'],
    makePlan: () => ({
      op: 'install',
      skill: SKILL,
      tool: TOOL,
      skillsRoot,
      placementPath,
      install: {
        build,
        storePath: s.storePath,
        contentHash: s.contentHash,
        pinned: pinnedOf(s.storePath, s.rev, s.contentHash, build),
        origin: origin(),
        adoptedDev: null,
      },
    }),
  };
};

// Replace a pinned copy (dir) with a store-linked placement (symlink) — a kind flip.
const replaceOverCopy = async (f: FixtureFleet): Promise<AcquireCfg> => {
  const env = fastEnv(f.env);
  const skillsRoot = join(f.home, '.claude', 'skills');
  const placementPath = join(skillsRoot, SKILL);
  const ledgerPath = ledgerPathOf(f.data);
  const s = await seedStore(f, env);
  await env.copyTree(s.storePath, placementPath); // the old managed copy
  const ledger = emptyLedger(NOW);
  setPairAt(ledger, null, SKILL, TOOL, {
    placementPath,
    mode: 'pinned',
    dev: null,
    pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
    origin: origin(),
    journal: null,
  });
  const w = await writeLedger(env, ledgerPath, ledger);
  if (!w.ok) throw new Error(msg(w.error));
  return {
    op: 'install',
    isFresh: false,
    skillsRoot,
    placementPath,
    ledgerPath,
    storePath: s.storePath,
    contentHash: s.contentHash,
    oldKind: 'dir',
    newKind: 'symlink',
    oldTarget: null,
    newTarget: s.storePath,
    expectedPhases: ['prepared', 'staged', 'backed-up', 'live', 'committed'],
    makePlan: () => ({
      op: 'install',
      skill: SKILL,
      tool: TOOL,
      skillsRoot,
      placementPath,
      install: {
        build: 'symlink',
        storePath: s.storePath,
        contentHash: s.contentHash,
        pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'symlink'),
        origin: origin(),
        adoptedDev: null,
      },
    }),
  };
};

// Replace a dev symlink with a store copy (dir) — a kind flip; the plan carries adoptedDev.
const replaceOverDev = async (f: FixtureFleet): Promise<AcquireCfg> => {
  const env = fastEnv(f.env);
  const skillsRoot = join(f.home, '.claude', 'skills');
  const placementPath = join(skillsRoot, SKILL);
  const ledgerPath = ledgerPathOf(f.data);
  const s = await seedStore(f, env);
  const target = resolve(f.alphaSrc);
  await env.makeSymlink(target, placementPath); // the old dev symlink
  const ledger = emptyLedger(NOW);
  setPairAt(ledger, null, SKILL, TOOL, {
    placementPath,
    mode: 'dev',
    dev: dev(target),
    pinned: null,
    journal: null,
  });
  const w = await writeLedger(env, ledgerPath, ledger);
  if (!w.ok) throw new Error(msg(w.error));
  return {
    op: 'install',
    isFresh: false,
    skillsRoot,
    placementPath,
    ledgerPath,
    storePath: s.storePath,
    contentHash: s.contentHash,
    oldKind: 'symlink',
    newKind: 'dir',
    oldTarget: target,
    newTarget: null,
    expectedPhases: ['prepared', 'staged', 'backed-up', 'live', 'committed'],
    makePlan: () => ({
      op: 'install',
      skill: SKILL,
      tool: TOOL,
      skillsRoot,
      placementPath,
      install: {
        build: 'copy',
        storePath: s.storePath,
        contentHash: s.contentHash,
        pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
        origin: origin(),
        adoptedDev: dev(target),
      },
    }),
  };
};

const uninstall = async (f: FixtureFleet, placement: 'symlink' | 'copy'): Promise<AcquireCfg> => {
  const env = fastEnv(f.env);
  const skillsRoot = join(f.home, '.claude', 'skills');
  const placementPath = join(skillsRoot, SKILL);
  const ledgerPath = ledgerPathOf(f.data);
  const s = await seedStore(f, env);
  if (placement === 'symlink') await env.makeSymlink(s.storePath, placementPath);
  else await env.copyTree(s.storePath, placementPath);
  const ledger = emptyLedger(NOW);
  setPairAt(ledger, null, SKILL, TOOL, {
    placementPath,
    mode: 'pinned',
    dev: null,
    pinned: pinnedOf(s.storePath, s.rev, s.contentHash, placement),
    origin: origin(),
    journal: null,
  });
  const w = await writeLedger(env, ledgerPath, ledger);
  if (!w.ok) throw new Error(msg(w.error));
  return {
    op: 'uninstall',
    isFresh: false,
    skillsRoot,
    placementPath,
    ledgerPath,
    storePath: s.storePath,
    contentHash: s.contentHash,
    oldKind: placement === 'symlink' ? 'symlink' : 'dir',
    newKind: 'absent',
    oldTarget: placement === 'symlink' ? s.storePath : null,
    newTarget: null,
    expectedPhases: ['prepared', 'backed-up', 'committed'],
    makePlan: () => ({
      op: 'uninstall',
      skill: SKILL,
      tool: TOOL,
      skillsRoot,
      placementPath,
    }),
  };
};

const suite = (name: string, setup: (f: FixtureFleet) => Promise<AcquireCfg>): void => {
  describe(`crash sweep — ${name}`, () => {
    let f: FixtureFleet;
    beforeEach(async () => {
      f = await buildFixtureFleet();
    }, 60_000);
    afterEach(async () => {
      await destroyFixtureFleet(f);
    }, 60_000);

    test('every crash point holds the invariants, rolls back, and converges', async () => {
      await runAcquireSweep(f, await setup(f));
    }, 180_000);
  });
};

suite('fresh symlink install', (f) => freshInstall(f, 'symlink'));
suite('fresh copy install', (f) => freshInstall(f, 'copy'));
suite('replace install over a pinned copy', replaceOverCopy);
suite('replace install over a dev symlink', replaceOverDev);
suite('uninstall of a symlink placement', (f) => uninstall(f, 'symlink'));
suite('uninstall of a managed copy', (f) => uninstall(f, 'copy'));

// ---- ledger compat probe (D6): a crash-window ledger is valid v0.6.0 but rejected by v0.5.0 ----

describe('ledger compat probe (D6)', () => {
  let env: ScanEnv;
  let base: string;
  beforeEach(async () => {
    env = await defaultScanEnv();
    base = join(tmpdir(), `skillsmith-compat-${Math.random().toString(36).slice(2)}`);
    await mkdir(base, { recursive: true });
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  // A ledger frozen mid-install-crash: an uncommitted install journal with before { mode: 'absent' }.
  const frozenMidCrash = (): unknown => ({
    schemaVersion: 1,
    kind: 'skillsmith.placements',
    updatedAt: NOW,
    skills: {
      zeta: {
        tools: {
          'claude-code': {
            placementPath: '/home/.claude/skills/zeta',
            mode: 'pinned',
            dev: null,
            pinned: pinnedOf('/store/o/r@abc123abc123/zeta', 'abc123abc123', 'sha256:00', 'copy'),
            origin: origin(),
            journal: {
              op: 'install',
              txId: 'deadbeef',
              phase: 'live',
              startedAt: NOW,
              completedAt: null,
              before: { mode: 'absent' },
              stagingPath: '/home/.claude/skills/.skillsmith-staging-zeta-deadbeef',
              backupPath: '/home/.claude/skills/.skillsmith-backup-zeta-deadbeef',
            },
          },
        },
      },
    },
  });

  test('v0.6.0 readLedger parses the crash-window ledger', async () => {
    const p = join(base, 'placements.json');
    await Bun.write(p, JSON.stringify(frozenMidCrash()));
    const r = await readLedger(env, p);
    if (!r.ok) throw new Error(msg(r.error));
    expect(getPairAt(r.value, null, 'zeta', 'claude-code')?.journal?.op).toBe('install');
  });

  test('the frozen P12-era (v0.5.0) JournalSchema REJECTS it — a v0.5.0 binary would exit 3', () => {
    // Inline copy of the P12-era schema: op enum without install/uninstall; before union without
    // the { mode: 'absent' } variant and without liveKind.
    const P12PinnedRecordSchema = z.object({
      storePath: z.string(),
      rev: z.string(),
      gitSha: z.string().nullable(),
      dirty: z.boolean(),
      contentHash: z.string(),
      snapshotAt: z.string(),
      verify: z.enum(['passed', 'warned', 'skipped']),
    });
    const P12DevRecordSchema = z.object({
      sourcePath: z.string(),
      resolvedPath: z.string(),
      repoRoot: z.string().nullable(),
      sourceRelPath: z.string().nullable(),
      remote: z.string().nullable(),
      recordedAt: z.string(),
    });
    const P12JournalSchema = z.object({
      op: z.enum(['promote', 'dev', 'rollback']),
      txId: z.string(),
      phase: z.enum(['prepared', 'staged', 'backed-up', 'live', 'committed']),
      startedAt: z.string(),
      completedAt: z.string().nullable(),
      before: z.union([
        z.object({ mode: z.literal('dev'), symlinkTarget: z.string() }),
        z.object({
          mode: z.literal('pinned'),
          storePath: z.string().nullable(),
          contentHash: z.string().nullable(),
        }),
      ]),
      stagingPath: z.string(),
      backupPath: z.string(),
    });
    const P12PairRecordSchema = z.object({
      placementPath: z.string(),
      mode: z.enum(['dev', 'pinned']),
      dev: P12DevRecordSchema.nullable(),
      pinned: P12PinnedRecordSchema.nullable(),
      journal: P12JournalSchema.nullable(),
    });
    const P12LedgerSchema = z.object({
      schemaVersion: z.literal(1),
      kind: z.literal('skillsmith.placements'),
      updatedAt: z.string(),
      skills: z.record(
        z.string(),
        z.object({ tools: z.record(z.enum(FLIP_TOOLS), P12PairRecordSchema) }),
      ),
    });

    const parsed = P12LedgerSchema.safeParse(frozenMidCrash());
    expect(parsed.success).toBe(false);
  });
});
