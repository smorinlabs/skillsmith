import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ScanEnv } from '../../src/env/types.ts';
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
import { resumeSwap, runSwap, sweepCommittedAcquireJournals } from '../../src/place/swap.ts';
import type {
  DevRecord,
  Journal,
  LedgerFile,
  OriginRecord,
  PairRecord,
  PinnedRecord,
  SwapCtx,
  SwapPlan,
} from '../../src/place/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const NOW = '2026-07-07T00:00:00Z';
const SKILL = 'zeta'; // a name absent from the fixture skills root (alpha/copied/dangler exist)
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

const origin = (source: string): OriginRecord => ({
  source,
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
  newTxId: () => 'aabbccdd',
});

interface StoreSeed {
  storePath: string;
  rev: string;
  contentHash: string;
}

const seedStore = async (f: FixtureFleet): Promise<StoreSeed> => {
  const prov = await resolveProvenance(f.env, f.alphaSrc);
  if (!prov.ok) throw new Error(msg(prov.error));
  const snap = await snapshotToStore(f.env, {
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

const residue = async (env: ScanEnv, skillsRoot: string): Promise<string[]> =>
  (await env.listDir(skillsRoot)).filter((n) => n.startsWith('.skillsmith-'));

const installPlan = (
  s: StoreSeed,
  skillsRoot: string,
  placementPath: string,
  build: 'symlink' | 'copy',
  extra: Partial<SwapPlan['install']> = {},
  scopeKey: string | null = null,
): SwapPlan => ({
  op: 'install',
  skill: SKILL,
  tool: TOOL,
  skillsRoot,
  placementPath,
  scopeKey,
  install: {
    build,
    storePath: s.storePath,
    contentHash: s.contentHash,
    pinned: pinnedOf(s.storePath, s.rev, s.contentHash, build),
    origin: origin('smorinlabs/fixture-harness/alpha'),
    adoptedDev: null,
    ...extra,
  },
});

describe('runSwap — install', () => {
  let f: FixtureFleet;
  let skillsRoot: string;
  let placementPath: string;
  let ledgerPath: string;
  beforeEach(async () => {
    f = await buildFixtureFleet();
    skillsRoot = join(f.home, '.claude', 'skills');
    placementPath = join(skillsRoot, SKILL);
    ledgerPath = ledgerPathOf(f.data);
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('fresh install, build symlink → live symlink into store, pinned, journal null', async () => {
    const s = await seedStore(f);
    const ledger = emptyLedger(NOW);
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(ctx, installPlan(s, skillsRoot, placementPath, 'symlink'));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.committed).toBe(true);
    expect(await f.env.pathKind(placementPath)).toBe('symlink');
    expect(await f.env.readLink(placementPath)).toBe(s.storePath);
    const pair = getPairAt(ledger, null, SKILL, TOOL);
    expect(pair?.mode).toBe('pinned');
    expect(pair?.pinned?.placement).toBe('symlink');
    expect(pair?.origin?.source).toBe('smorinlabs/fixture-harness/alpha');
    expect(pair?.journal).toBeNull(); // no committed journal at rest
    expect(await residue(f.env, skillsRoot)).toEqual([]);
  });

  test('fresh install, build copy → live real dir with matching content hash, placement copy', async () => {
    const s = await seedStore(f);
    const ledger = emptyLedger(NOW);
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(ctx, installPlan(s, skillsRoot, placementPath, 'copy'));
    if (!r.ok) throw new Error(msg(r.error));
    expect(await f.env.pathKind(placementPath)).toBe('dir');
    const h = await contentHashOf(f.env, placementPath);
    if (!h.ok) throw new Error(msg(h.error));
    expect(h.value).toBe(s.contentHash);
    const pair = getPairAt(ledger, null, SKILL, TOOL);
    expect(pair?.pinned?.placement).toBe('copy');
    expect(pair?.journal).toBeNull();
  });

  test('fresh install into a project scopeKey lands under projects, user tree untouched', async () => {
    const s = await seedStore(f);
    const key = f.projectReal;
    const projPlacement = join(f.project, '.claude', 'skills', SKILL);
    await f.env.makeDir(join(f.project, '.claude', 'skills'));
    const ledger = emptyLedger(NOW);
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(
      ctx,
      installPlan(s, join(f.project, '.claude', 'skills'), projPlacement, 'copy', {}, key),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(getPairAt(ledger, key, SKILL, TOOL)?.mode).toBe('pinned');
    expect(getPairAt(ledger, null, SKILL, TOOL)).toBeNull();
    expect(ledger.skills[SKILL]).toBeUndefined();
  });

  test('replace install over a dev symlink: backup symlink unlinked, dev = adoptedDev retained', async () => {
    const s = await seedStore(f);
    const target = resolve(f.alphaSrc);
    const live = join(skillsRoot, SKILL);
    await f.env.makeSymlink(target, live); // a dev symlink placement
    const ledger = emptyLedger(NOW);
    setPairAt(ledger, null, SKILL, TOOL, {
      placementPath: live,
      mode: 'dev',
      dev: dev(target),
      pinned: null,
      journal: null,
    });
    const adopted = dev(target);
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(ctx, installPlan(s, skillsRoot, live, 'copy', { adoptedDev: adopted }));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.backupKept).toBeNull();
    expect(await f.env.pathKind(live)).toBe('dir');
    const pair = getPairAt(ledger, null, SKILL, TOOL);
    expect(pair?.mode).toBe('pinned');
    expect(pair?.dev).toEqual(adopted);
    expect(pair?.journal).toBeNull();
    expect(await residue(f.env, skillsRoot)).toEqual([]);
  });

  test('replace install over an edited pinned copy: backup dir KEPT + warning (hash mismatch)', async () => {
    // Kind flip (dir → store symlink) so the engine's same-kind guard permits the replace; the old
    // edited copy becomes a dir backup whose hash no longer matches any store entry → KEPT + warning.
    const s = await seedStore(f);
    const live = join(skillsRoot, SKILL);
    await f.env.copyTree(s.storePath, live); // a managed pinned copy
    await appendFile(join(live, 'SKILL.md'), '\nedited in place\n'); // now unmanaged
    const ledger = emptyLedger(NOW);
    setPairAt(ledger, null, SKILL, TOOL, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
      journal: null,
    });
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(ctx, installPlan(s, skillsRoot, live, 'symlink'));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.backupKept).not.toBeNull();
    expect(r.value.warning).not.toBeNull();
    expect(await f.env.pathKind(live)).toBe('symlink');
    expect(await f.env.pathKind(r.value.backupKept as string)).toBe('dir');
    expect(getPairAt(ledger, null, SKILL, TOOL)?.journal).toBeNull();
    // store entry untouched
    expect(await f.env.pathKind(s.storePath)).not.toBe('absent');
  });

  test('same-kind replace (dir → dir) is rejected loudly, not attempted', async () => {
    // A copy-over-copy replace is indistinguishable from the old entry at the P4 rollback window
    // (both dirs), so the engine refuses it — the run layer must route it as a kind change.
    const s = await seedStore(f);
    const live = join(skillsRoot, SKILL);
    await f.env.copyTree(s.storePath, live); // old managed copy (dir)
    const ledger = emptyLedger(NOW);
    setPairAt(ledger, null, SKILL, TOOL, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
      journal: null,
    });
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(ctx, installPlan(s, skillsRoot, live, 'copy')); // new build is also a dir
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('generic');
      expect(msg(r.error)).toContain('same-kind replace');
    }
    // refused before any mutation: live untouched, no journal written, no residue.
    expect(await f.env.pathKind(live)).toBe('dir');
    expect(getPairAt(ledger, null, SKILL, TOOL)?.journal).toBeNull();
    expect(await residue(f.env, skillsRoot)).toEqual([]);
  });

  test('runSwap over an uncommitted install journal → flip-refused naming all remediations', async () => {
    const s = await seedStore(f);
    const live = join(skillsRoot, SKILL);
    const ledger = emptyLedger(NOW);
    const journal: Journal = {
      op: 'install',
      txId: 'deadbeef',
      phase: 'staged',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'absent' },
      stagingPath: join(skillsRoot, '.skillsmith-staging-alpha-deadbeef'),
      backupPath: join(skillsRoot, '.skillsmith-backup-alpha-deadbeef'),
    };
    const pair: PairRecord = {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
      origin: origin('smorinlabs/fixture-harness/alpha'),
      journal,
    };
    setPairAt(ledger, null, SKILL, TOOL, pair);
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(ctx, installPlan(s, skillsRoot, live, 'copy'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('flip-refused');
      expect(msg(r.error)).toContain('promote --rollback');
      expect(msg(r.error)).toContain('dev --rollback');
      expect(msg(r.error)).toContain('skillsmith install');
    }
  });

  test('resumeSwap on a committed install journal → ok({committed:true}) and journal nulled', async () => {
    // Plant a committed replace-install journal with backup residue still on disk.
    const s = await seedStore(f);
    const live = join(skillsRoot, SKILL);
    await f.env.copyTree(s.storePath, live); // the (new) live copy
    const backup = join(skillsRoot, '.skillsmith-backup-alpha-aabbccdd');
    await f.env.copyTree(s.storePath, backup); // reproducible backup
    const ledger = emptyLedger(NOW);
    const journal: Journal = {
      op: 'install',
      txId: 'aabbccdd',
      phase: 'committed',
      startedAt: NOW,
      completedAt: NOW,
      before: {
        mode: 'pinned',
        storePath: s.storePath,
        contentHash: s.contentHash,
        liveKind: 'dir',
      },
      stagingPath: join(skillsRoot, '.skillsmith-staging-alpha-aabbccdd'),
      backupPath: backup,
    };
    setPairAt(ledger, null, SKILL, TOOL, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
      origin: origin('smorinlabs/fixture-harness/alpha'),
      journal,
    });
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await resumeSwap(ctx, SKILL, TOOL);
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.committed).toBe(true);
    expect(getPairAt(ledger, null, SKILL, TOOL)?.journal).toBeNull();
    expect(await f.env.pathKind(backup)).toBe('absent'); // residue reclaimed
    expect(await residue(f.env, skillsRoot)).toEqual([]);
  });
});

describe('runSwap — uninstall', () => {
  let f: FixtureFleet;
  let skillsRoot: string;
  let ledgerPath: string;
  beforeEach(async () => {
    f = await buildFixtureFleet();
    skillsRoot = join(f.home, '.claude', 'skills');
    ledgerPath = ledgerPathOf(f.data);
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  const uninstallPlan = (live: string): SwapPlan => ({
    op: 'uninstall',
    skill: SKILL,
    tool: TOOL,
    skillsRoot,
    placementPath: live,
  });

  test('uninstall of a store-symlink placement: live gone, pair deleted, store untouched', async () => {
    const s = await seedStore(f);
    const live = join(skillsRoot, SKILL);
    await f.env.makeSymlink(s.storePath, live); // store-linked placement
    const ledger = emptyLedger(NOW);
    setPairAt(ledger, null, SKILL, TOOL, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'symlink'),
      origin: origin('smorinlabs/fixture-harness/alpha'),
      journal: null,
    });
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(ctx, uninstallPlan(live));
    if (!r.ok) throw new Error(msg(r.error));
    expect(await f.env.pathKind(live)).toBe('absent');
    expect(getPairAt(ledger, null, SKILL, TOOL)).toBeNull();
    expect(await f.env.pathKind(s.storePath)).not.toBe('absent'); // store entry never deleted
    expect(await residue(f.env, skillsRoot)).toEqual([]);
  });

  test('uninstall of a managed pinned copy: backup reclaimed on hash match, pair deleted', async () => {
    const s = await seedStore(f);
    const live = join(skillsRoot, SKILL);
    await f.env.copyTree(s.storePath, live);
    const ledger = emptyLedger(NOW);
    setPairAt(ledger, null, SKILL, TOOL, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
      origin: origin('smorinlabs/fixture-harness/alpha'),
      journal: null,
    });
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(ctx, uninstallPlan(live));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.backupKept).toBeNull();
    expect(await f.env.pathKind(live)).toBe('absent');
    expect(getPairAt(ledger, null, SKILL, TOOL)).toBeNull();
    expect(await residue(f.env, skillsRoot)).toEqual([]);
  });

  test('uninstall of an edited copy: backup KEPT + warning, pair still deleted', async () => {
    const s = await seedStore(f);
    const live = join(skillsRoot, SKILL);
    await f.env.copyTree(s.storePath, live);
    await appendFile(join(live, 'SKILL.md'), '\nedited\n'); // unmanaged now
    const ledger = emptyLedger(NOW);
    setPairAt(ledger, null, SKILL, TOOL, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
      origin: origin('smorinlabs/fixture-harness/alpha'),
      journal: null,
    });
    const ctx = makeCtx(f.env, ledgerPath, ledger);
    const r = await runSwap(ctx, uninstallPlan(live));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.backupKept).not.toBeNull();
    expect(r.value.warning).not.toBeNull();
    expect(await f.env.pathKind(live)).toBe('absent');
    expect(await f.env.pathKind(r.value.backupKept as string)).toBe('dir');
    expect(getPairAt(ledger, null, SKILL, TOOL)).toBeNull();
  });
});

describe('sweepCommittedAcquireJournals', () => {
  let f: FixtureFleet;
  let skillsRoot: string;
  let ledgerPath: string;
  beforeEach(async () => {
    f = await buildFixtureFleet();
    skillsRoot = join(f.home, '.claude', 'skills');
    ledgerPath = ledgerPathOf(f.data);
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('finishes a committed install (user tree) and a committed uninstall (project tree); leaves flips alone', async () => {
    const s = await seedStore(f);
    const key = f.projectReal;

    // (1) committed install in the user tree — live present, backup residue reproducible.
    const installLive = join(skillsRoot, 'inst');
    await f.env.copyTree(s.storePath, installLive);
    const installBackup = join(skillsRoot, '.skillsmith-backup-inst-11111111');
    await f.env.copyTree(s.storePath, installBackup);
    const ledger = emptyLedger(NOW);
    setPairAt(ledger, null, 'inst', TOOL, {
      placementPath: installLive,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
      origin: origin('smorinlabs/fixture-harness/inst'),
      journal: {
        op: 'install',
        txId: '11111111',
        phase: 'committed',
        startedAt: NOW,
        completedAt: NOW,
        before: {
          mode: 'pinned',
          storePath: s.storePath,
          contentHash: s.contentHash,
          liveKind: 'dir',
        },
        stagingPath: join(skillsRoot, '.skillsmith-staging-inst-11111111'),
        backupPath: installBackup,
      },
    });

    // (2) committed uninstall in a project tree — live already gone, backup residue reproducible.
    const projSkillsRoot = join(f.project, '.claude', 'skills');
    await f.env.makeDir(projSkillsRoot);
    const uninstBackup = join(projSkillsRoot, '.skillsmith-backup-unins-22222222');
    await f.env.copyTree(s.storePath, uninstBackup);
    setPairAt(ledger, key, 'unins', TOOL, {
      placementPath: join(projSkillsRoot, 'unins'),
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
      origin: origin('smorinlabs/fixture-harness/unins'),
      journal: {
        op: 'uninstall',
        txId: '22222222',
        phase: 'committed',
        startedAt: NOW,
        completedAt: NOW,
        before: {
          mode: 'pinned',
          storePath: s.storePath,
          contentHash: s.contentHash,
          liveKind: 'dir',
        },
        stagingPath: join(projSkillsRoot, '.skillsmith-staging-unins-22222222'),
        backupPath: uninstBackup,
      },
    });

    // (3) a committed PROMOTE journal must be left untouched by the sweep.
    setPairAt(ledger, null, 'prom', TOOL, {
      placementPath: join(skillsRoot, 'prom'),
      mode: 'pinned',
      dev: dev('/src/prom'),
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'copy'),
      journal: {
        op: 'promote',
        txId: '33333333',
        phase: 'committed',
        startedAt: NOW,
        completedAt: NOW,
        before: { mode: 'dev', symlinkTarget: '/src/prom', liveKind: 'symlink' },
        stagingPath: join(skillsRoot, '.skillsmith-staging-prom-33333333'),
        backupPath: join(skillsRoot, '.skillsmith-backup-prom-33333333'),
      },
    });

    const w = await writeLedger(f.env, ledgerPath, ledger);
    if (!w.ok) throw new Error(msg(w.error));
    const read = await readLedger(f.env, ledgerPath);
    if (!read.ok) throw new Error(msg(read.error));
    const ctx = makeCtx(f.env, ledgerPath, read.value);

    const swept = await sweepCommittedAcquireJournals(ctx);
    if (!swept.ok) throw new Error(msg(swept.error));

    // install finished: journal nulled, records intact, backup gone.
    expect(getPairAt(ctx.ledger, null, 'inst', TOOL)?.journal).toBeNull();
    expect(getPairAt(ctx.ledger, null, 'inst', TOOL)?.mode).toBe('pinned');
    expect(await f.env.pathKind(installBackup)).toBe('absent');
    // uninstall finished: pair deleted, backup gone.
    expect(getPairAt(ctx.ledger, key, 'unins', TOOL)).toBeNull();
    expect(await f.env.pathKind(uninstBackup)).toBe('absent');
    // promote journal untouched.
    expect(getPairAt(ctx.ledger, null, 'prom', TOOL)?.journal?.phase).toBe('committed');
  });
});
