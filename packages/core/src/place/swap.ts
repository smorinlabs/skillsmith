import { dirname, join } from 'node:path';
import type { PathKind } from '../env/types.ts';
import {
  type SkillSmithError,
  errorMessage,
  flipFailedError,
  flipRefusedError,
  genericError,
  permissionDeniedError,
  safeErrorCode,
} from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { deletePairAt, getPairAt, setPairAt } from './ledger.ts';
import { contentHashOf } from './store.ts';
import type {
  FlipTool,
  Journal,
  JournalOp,
  JournalPhase,
  LedgerFile,
  PairRecord,
  SwapCtx,
  SwapOutcome,
  SwapPlan,
  SwapPorts,
} from './types.ts';

const PHASE_INDEX: Record<JournalPhase, number> = {
  prepared: 0,
  staged: 1,
  'backed-up': 2,
  live: 3,
  committed: 4,
};

const isPermError = (e: unknown): boolean => {
  const code = safeErrorCode(e);
  return code === 'EACCES' || code === 'EPERM';
};

const mapFsErr = (e: unknown, context: string): SkillSmithError =>
  isPermError(e)
    ? permissionDeniedError(`${context}: ${errorMessage(e)}`)
    : flipFailedError(`${context}: ${errorMessage(e)}`);

const guardFs = async (
  fn: () => Promise<void>,
  context: string,
): Promise<Result<void, SkillSmithError>> => {
  try {
    await fn();
    return ok(undefined);
  } catch (e) {
    return err(mapFsErr(e, context));
  }
};

const stagingNameOf = (skill: string, txId: string): string =>
  `.skillsmith-staging-${skill}-${txId}`;
const backupNameOf = (skill: string, txId: string): string => `.skillsmith-backup-${skill}-${txId}`;

const kindOf = (probe: PathKind): 'symlink' | 'dir' => (probe === 'symlink' ? 'symlink' : 'dir');

// Recursively fsync every regular file under a freshly copied staging tree (durability of P2).
const fsyncTree = async (env: SwapPorts, dir: string): Promise<void> => {
  const names = await env.listDir(dir);
  for (const name of names) {
    const abs = join(dir, name);
    const kind = await env.pathKind(abs);
    if (kind === 'dir') await fsyncTree(env, abs);
    else if (kind === 'file') await env.fsyncFile(abs);
  }
};

// Test seam: hold in a crash window for 30 s (used only by the CLI E2E via SKILLSMITH_TEST_PAUSE_AT).
const pause = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, 30_000);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

// Persist a phase transition (write-ahead) then, if configured, hold in that crash window.
const advance = async (
  ctx: SwapCtx,
  j: Journal,
  phase: JournalPhase,
): Promise<Result<void, SkillSmithError>> => {
  j.phase = phase;
  const p = await ctx.persist();
  if (!p.ok) return p;
  if (ctx.pauseAt === phase) await pause(ctx.signal);
  return ok(undefined);
};

// P2: materialize the staging entry under its dot-name (never touches the live path).
const buildStaging = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  j: Journal,
): Promise<Result<void, SkillSmithError>> => {
  const env = ctx.env;
  try {
    if (plan.op === 'promote') {
      if (!plan.promote) return err(genericError('promote plan missing promote payload'));
      await env.copyTree(plan.promote.storePath, j.stagingPath);
      await fsyncTree(env, j.stagingPath);
      const h = await contentHashOf(env, j.stagingPath);
      if (!h.ok) return h;
      if (h.value !== plan.promote.contentHash) {
        return err(
          flipFailedError(
            `staging hash mismatch for ${plan.skill}: expected ${plan.promote.contentHash}`,
          ),
        );
      }
      return ok(undefined);
    }
    if (plan.op === 'install') {
      if (!plan.install) return err(genericError('install plan missing install payload'));
      if (plan.install.build === 'symlink') {
        await env.makeSymlink(plan.install.storePath, j.stagingPath);
        return ok(undefined);
      }
      await env.copyTree(plan.install.storePath, j.stagingPath);
      await fsyncTree(env, j.stagingPath);
      const h = await contentHashOf(env, j.stagingPath);
      if (!h.ok) return h;
      if (h.value !== plan.install.contentHash) {
        return err(
          flipFailedError(
            `staging hash mismatch for ${plan.skill}: expected ${plan.install.contentHash}`,
          ),
        );
      }
      return ok(undefined);
    }
    if (plan.op === 'uninstall') return ok(undefined); // no staging phase
    if (!plan.dev) return err(genericError('dev plan missing dev payload'));
    await env.makeSymlink(plan.dev.sourcePath, j.stagingPath);
    return ok(undefined);
  } catch (e) {
    return err(mapFsErr(e, `cannot stage ${plan.skill}`));
  }
};

/** Reclaim a backup left by a two-rename swap. Symlink backups are always removed (the store
 *  target they pointed at is never touched and remains recorded). A dir backup is removed only
 *  when its content matches a store entry recorded on the pair (reproducible); an edited copy is
 *  KEPT with a warning so an unmanaged edit is never silently destroyed. */
const reclaimBackup = async (
  env: SwapPorts,
  backupPath: string,
  acceptableHashes: readonly (string | null | undefined)[],
  label: string,
): Promise<Result<{ backupKept: string | null; warning: string | null }, SkillSmithError>> => {
  try {
    const kind = await env.pathKind(backupPath);
    if (kind === 'absent') return ok({ backupKept: null, warning: null });
    if (kind === 'symlink') {
      await env.removeTree(backupPath);
      return ok({ backupKept: null, warning: null });
    }
    const acceptable = acceptableHashes.filter(
      (h): h is string => typeof h === 'string' && h.length > 0,
    );
    const h = await contentHashOf(env, backupPath);
    if (!h.ok) return h;
    if (acceptable.includes(h.value)) {
      await env.removeTree(backupPath);
      return ok({ backupKept: null, warning: null });
    }
    return ok({
      backupKept: backupPath,
      warning: `kept backup ${backupPath}: the ${label} copy was edited in place (hash mismatch)`,
    });
  } catch (e) {
    return err(mapFsErr(e, `cannot reclaim backup ${backupPath}`));
  }
};

// P5: write-ahead commit (durable committed journal) THEN reclaim the backup. Committing first
// keeps the C5 rollback valid — the backup is the only physical copy of the old state and must
// survive until the new live entry is recorded as committed. Promote/dev leave the committed
// journal at rest; acquisition ops (install/uninstall) finish with a terminal write that nulls the
// journal (install) or deletes the pair (uninstall) so no committed acquisition journal survives.
const commit = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  pair: PairRecord,
  j: Journal,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const env = ctx.env;
  const scopeKey = plan.scopeKey ?? null;
  try {
    await env.fsyncDir(plan.skillsRoot);
  } catch (e) {
    return err(mapFsErr(e, `cannot fsync ${plan.skillsRoot}`));
  }

  if (plan.op === 'promote' || plan.op === 'dev') {
    if (plan.op === 'promote') {
      if (!plan.promote) return err(genericError('promote plan missing promote payload'));
      pair.mode = 'pinned';
      pair.pinned = plan.promote.pinned;
      pair.dev = plan.promote.devRecord;
    } else {
      if (!plan.dev) return err(genericError('dev plan missing dev payload'));
      pair.mode = 'dev';
      pair.dev = plan.dev.devRecord;
    }
    j.phase = 'committed';
    j.completedAt = ctx.now();
    const persisted = await ctx.persist();
    if (!persisted.ok) return persisted;

    // Backup reclamation is authorized by the now-durable committed journal.
    let backupKept: string | null = null;
    let warning: string | null = null;
    try {
      if (plan.op === 'dev') {
        const pinnedHash = pair.pinned?.contentHash ?? null;
        if ((await env.pathKind(j.backupPath)) !== 'absent') {
          if (pinnedHash === null) {
            backupKept = j.backupPath;
            warning = `kept backup ${j.backupPath}: no pinned record to verify the demoted copy`;
          } else {
            const h = await contentHashOf(env, j.backupPath);
            if (!h.ok) return h;
            if (h.value === pinnedHash) {
              await env.removeTree(j.backupPath);
            } else {
              backupKept = j.backupPath;
              warning = `kept backup ${j.backupPath}: demoted copy was edited in place (hash mismatch)`;
            }
          }
        }
      } else if ((await env.pathKind(j.backupPath)) !== 'absent') {
        await env.removeTree(j.backupPath);
      }
      await env.fsyncDir(plan.skillsRoot);
    } catch (e) {
      return err(mapFsErr(e, `cannot reclaim backup for ${plan.skill}`));
    }
    return ok({ committed: true, backupKept, warning });
  }

  if (plan.op === 'install') {
    // The terminal records (mode 'pinned', pinned, origin, dev) were staged at P1. A fresh install
    // (before absent) has no backup: a single terminal write nulls the journal. A replace install
    // needs a write-ahead committed journal to authorize reclaiming the backup, then a terminal
    // write to null the journal.
    if (j.before.mode === 'absent') {
      pair.journal = null;
      const persisted = await ctx.persist();
      if (!persisted.ok) return persisted;
      return ok({ committed: true, backupKept: null, warning: null });
    }
    j.phase = 'committed';
    j.completedAt = ctx.now();
    const committed = await ctx.persist();
    if (!committed.ok) return committed;

    const oldHash = j.before.mode === 'pinned' ? j.before.contentHash : null;
    const newHash = plan.install?.contentHash ?? pair.pinned?.contentHash ?? null;
    const reclaimed = await reclaimBackup(env, j.backupPath, [newHash, oldHash], 'replaced');
    if (!reclaimed.ok) return reclaimed;
    const synced = await guardFs(
      () => env.fsyncDir(plan.skillsRoot),
      `cannot fsync ${plan.skillsRoot}`,
    );
    if (!synced.ok) return synced;

    pair.journal = null;
    const terminal = await ctx.persist();
    if (!terminal.ok) return terminal;
    return ok({ committed: true, ...reclaimed.value });
  }

  // op === 'uninstall'
  j.phase = 'committed';
  j.completedAt = ctx.now();
  const committed = await ctx.persist();
  if (!committed.ok) return committed;

  const reclaimed = await reclaimBackup(
    env,
    j.backupPath,
    [pair.pinned?.contentHash],
    'uninstalled',
  );
  if (!reclaimed.ok) return reclaimed;
  const synced = await guardFs(
    () => env.fsyncDir(plan.skillsRoot),
    `cannot fsync ${plan.skillsRoot}`,
  );
  if (!synced.ok) return synced;

  deletePairAt(ctx.ledger, scopeKey, plan.skill, plan.tool);
  const terminal = await ctx.persist();
  if (!terminal.ok) return terminal;
  return ok({ committed: true, ...reclaimed.value });
};

// Drive the swap forward from the journal's current phase to committed, probing the filesystem to
// disambiguate the crash window (spec §8.4 right column). Idempotent per phase. Uninstall has no
// staging (P2) and no publish (P4) — only the P3 backup rename and the P5 commit.
const forward = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  pair: PairRecord,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const j = pair.journal;
  if (!j) return err(genericError(`no journal to drive for ${plan.skill}`));
  const env = ctx.env;
  const live = plan.placementPath;
  const idx = (): number => PHASE_INDEX[j.phase];
  const hasStaging = plan.op !== 'uninstall';

  // P2 — build staging (journal at prepared). Skipped for uninstall.
  if (hasStaging && idx() < PHASE_INDEX.staged) {
    if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
    if ((await env.pathKind(j.stagingPath)) !== 'absent') {
      const cleared = await guardFs(() => env.removeTree(j.stagingPath), 'clear staging remnant');
      if (!cleared.ok) return cleared;
    }
    const built = await buildStaging(ctx, plan, j);
    if (!built.ok) return built;
    const p = await advance(ctx, j, 'staged');
    if (!p.ok) return p;
  }

  // P3 — persist backed-up, then rename(live → backup) if the live path is still the old entry.
  if (idx() < PHASE_INDEX['backed-up']) {
    const p = await advance(ctx, j, 'backed-up');
    if (!p.ok) return p;
  }
  if (idx() <= PHASE_INDEX['backed-up']) {
    if ((await env.pathKind(live)) !== 'absent') {
      if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
      const r = await guardFs(() => env.rename(live, j.backupPath), `back up ${plan.skill}`);
      if (!r.ok) return r;
    }
  }

  // P4 — persist live, then rename(staging → live) if the live path is still absent. Skipped for
  // uninstall (nothing is published).
  if (hasStaging) {
    if (idx() < PHASE_INDEX.live) {
      const p = await advance(ctx, j, 'live');
      if (!p.ok) return p;
    }
    if (idx() <= PHASE_INDEX.live) {
      if ((await env.pathKind(live)) === 'absent') {
        if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
        const r = await guardFs(() => env.rename(j.stagingPath, live), `install ${plan.skill}`);
        if (!r.ok) return r;
      }
    }
  }

  // P5 — commit.
  if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
  return commit(ctx, plan, pair, j);
};

export const refusedMessage = (op: JournalOp, skill: string, source?: string): string => {
  if (op === 'install') {
    return (
      `a previous install of ${skill} was interrupted. ` +
      `Run 'skillsmith promote --rollback ${skill}' (or 'skillsmith dev --rollback ${skill}') ` +
      `to restore the previous state, or re-run 'skillsmith install ${source ?? skill}' to complete it.`
    );
  }
  if (op === 'uninstall') {
    return (
      `a previous uninstall of ${skill} was interrupted. ` +
      `Run 'skillsmith promote --rollback ${skill}' (or 'skillsmith dev --rollback ${skill}') ` +
      `to restore the previous state, or re-run 'skillsmith uninstall ${skill}' to complete it.`
    );
  }
  return (
    `a previous ${op} of ${skill} was interrupted. ` +
    `Run 'skillsmith ${op} --rollback ${skill}' to restore the previous state, ` +
    `or re-run 'skillsmith ${op} ${skill}' to complete the swap.`
  );
};

// Compute the journal `before` record (the pre-swap live state) for a fresh swap.
const computeBefore = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  existing: PairRecord | null,
  liveKind: PathKind,
): Promise<Result<Journal['before'], SkillSmithError>> => {
  const readLive = async (): Promise<Result<string, SkillSmithError>> => {
    try {
      return ok(await ctx.env.readLink(plan.placementPath));
    } catch (e) {
      return err(mapFsErr(e, `cannot read live symlink for ${plan.skill}`));
    }
  };

  if (plan.op === 'promote') {
    const t = await readLive();
    if (!t.ok) return t;
    return ok({ mode: 'dev', symlinkTarget: t.value, liveKind: kindOf(liveKind) });
  }
  if (plan.op === 'dev') {
    return ok({
      mode: 'pinned',
      storePath: existing?.pinned?.storePath ?? null,
      contentHash: existing?.pinned?.contentHash ?? null,
      liveKind: kindOf(liveKind),
    });
  }
  if (plan.op === 'install') {
    if (liveKind === 'absent') {
      // Fresh install. The run layer routes any pair holding prior records through the replace
      // path, so a fresh install must land on a genuinely empty slot.
      if (existing?.pinned || existing?.dev) {
        return err(
          genericError(
            `fresh install precondition violated for ${plan.skill}: pair holds prior records`,
          ),
        );
      }
      return ok({ mode: 'absent' });
    }
    // Replace install. `rollbackSwap` decides "live is the new artifact" (P4 done): for a
    // kind-changing swap by the kind flip; for symlink→symlink by the recorded old symlink target
    // (see below + rollbackSwap). dir→dir is BOTH kind- and target-ambiguous at that window, so it
    // stays rejected — the run layer must route a copy re-install as a kind change (promote's
    // demote-first path). symlink→symlink is safe and allowed.
    const newBuildKind = plan.install?.build === 'symlink' ? 'symlink' : 'dir';
    const oldKind = kindOf(liveKind);
    if (newBuildKind === 'dir' && oldKind === 'dir') {
      return err(
        genericError(
          `same-kind replace of ${plan.skill} (dir → dir) must be routed as a kind change by the run layer`,
        ),
      );
    }
    // Record the old symlink target for ANY symlink pre-state so rollback can disambiguate a
    // symlink→symlink replace via the target. `adoptedDev` is the run layer's signal that the live
    // symlink points outside the store (governs dev-vs-pinned mode); if it forgets to set it, that
    // dev record is silently lost (recorded as pinned instead of dev).
    let symlinkTarget: string | null = null;
    if (oldKind === 'symlink') {
      const t = await readLive();
      if (!t.ok) return t;
      symlinkTarget = t.value;
    }
    if (plan.install?.adoptedDev) {
      if (symlinkTarget === null) {
        return err(
          genericError(`cannot adopt dev source for ${plan.skill}: live is not a symlink`),
        );
      }
      return ok({ mode: 'dev', symlinkTarget, liveKind: 'symlink' });
    }
    return ok({
      mode: 'pinned',
      storePath: existing?.pinned?.storePath ?? null,
      contentHash: existing?.pinned?.contentHash ?? null,
      liveKind: oldKind,
      ...(symlinkTarget !== null ? { symlinkTarget } : {}),
    });
  }
  // op === 'uninstall'
  if (!existing) return err(genericError(`cannot uninstall ${plan.skill}: no pair record`));
  if (existing.mode === 'dev') {
    const t = await readLive();
    if (!t.ok) return t;
    return ok({ mode: 'dev', symlinkTarget: t.value, liveKind: kindOf(liveKind) });
  }
  // Record the old symlink target for a store-symlink placement too, so rollback's symlink branch
  // always has it (uninstall is symlink→absent, so a live symlink at rollback is always the OLD one;
  // recording the target keeps that branch well-defined rather than tripping its fail-loud guard).
  let uninstallTarget: string | null = null;
  if (kindOf(liveKind) === 'symlink') {
    const t = await readLive();
    if (!t.ok) return t;
    uninstallTarget = t.value;
  }
  return ok({
    mode: 'pinned',
    storePath: existing.pinned?.storePath ?? null,
    contentHash: existing.pinned?.contentHash ?? null,
    liveKind: kindOf(liveKind),
    ...(uninstallTarget !== null ? { symlinkTarget: uninstallTarget } : {}),
  });
};

// Build the pair record to stage behind the uncommitted journal at P1.
const stagePair = (
  plan: SwapPlan,
  existing: PairRecord | null,
  before: Journal['before'],
  journal: Journal,
): Result<PairRecord, SkillSmithError> => {
  if (plan.op === 'install') {
    if (!plan.install) return err(genericError('install plan missing install payload'));
    return ok({
      placementPath: plan.placementPath,
      mode: 'pinned',
      dev: plan.install.adoptedDev ?? existing?.dev ?? null,
      pinned: plan.install.pinned,
      origin: plan.install.origin,
      journal,
    });
  }
  if (plan.op === 'uninstall') {
    if (!existing) return err(genericError(`cannot uninstall ${plan.skill}: no pair record`));
    return ok({ ...existing, journal });
  }
  // promote / dev — mode stays the before-mode until P5 (P12 shape, unchanged).
  const mode = before.mode === 'dev' ? 'dev' : 'pinned';
  return ok({
    placementPath: plan.placementPath,
    mode,
    dev: plan.op === 'promote' ? (plan.promote?.devRecord ?? null) : (plan.dev?.devRecord ?? null),
    pinned: plan.op === 'promote' ? (plan.promote?.pinned ?? null) : (existing?.pinned ?? null),
    ...(existing?.origin ? { origin: existing.origin } : {}),
    journal,
  });
};

/** Start a fresh journaled swap. Refuses (flip-refused) when the pair carries an uncommitted
 *  journal — the caller must rollback or resume it first (Global Constraint 6). */
export const runSwap = async (
  ctx: SwapCtx,
  plan: SwapPlan,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const scopeKey = plan.scopeKey ?? null;
  const existing = getPairAt(ctx.ledger, scopeKey, plan.skill, plan.tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    return err(
      flipRefusedError(
        refusedMessage(existing.journal.op, plan.skill, plan.install?.origin.source),
      ),
    );
  }

  let liveKind: PathKind;
  try {
    liveKind = await ctx.env.pathKind(plan.placementPath);
  } catch (e) {
    return err(mapFsErr(e, `cannot probe live path for ${plan.skill}`));
  }

  const beforeRes = await computeBefore(ctx, plan, existing, liveKind);
  if (!beforeRes.ok) return beforeRes;
  const before = beforeRes.value;

  const txId = ctx.newTxId();
  const journal: Journal = {
    op: plan.op,
    txId,
    phase: 'prepared',
    startedAt: ctx.now(),
    completedAt: null,
    before,
    stagingPath: join(plan.skillsRoot, stagingNameOf(plan.skill, txId)),
    backupPath: join(plan.skillsRoot, backupNameOf(plan.skill, txId)),
  };

  const pairRes = stagePair(plan, existing, before, journal);
  if (!pairRes.ok) return pairRes;
  const pair = pairRes.value;
  setPairAt(ctx.ledger, scopeKey, plan.skill, plan.tool, pair);

  const p1 = await ctx.persist();
  if (!p1.ok) return p1;
  if (ctx.pauseAt === 'prepared') await pause(ctx.signal);

  return forward(ctx, plan, pair);
};

const reconstructPlan = (
  pair: PairRecord,
  j: Journal,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null,
): Result<SwapPlan, SkillSmithError> => {
  const base = {
    skill,
    tool,
    skillsRoot: dirname(pair.placementPath),
    placementPath: pair.placementPath,
    scopeKey,
  };
  if (j.op === 'promote') {
    if (!pair.pinned) return err(genericError(`cannot resume promote of ${skill}: pinned missing`));
    if (!pair.dev) return err(genericError(`cannot resume promote of ${skill}: dev missing`));
    return ok({
      ...base,
      op: 'promote',
      promote: {
        storePath: pair.pinned.storePath,
        contentHash: pair.pinned.contentHash,
        pinned: pair.pinned,
        devRecord: pair.dev,
      },
    });
  }
  if (j.op === 'dev') {
    if (!pair.dev) return err(genericError(`cannot resume dev of ${skill}: dev missing`));
    return ok({
      ...base,
      op: 'dev',
      dev: { sourcePath: pair.dev.sourcePath, devRecord: pair.dev },
    });
  }
  if (j.op === 'install') {
    if (!pair.pinned) return err(genericError(`cannot resume install of ${skill}: pinned missing`));
    if (!pair.origin) return err(genericError(`cannot resume install of ${skill}: origin missing`));
    return ok({
      ...base,
      op: 'install',
      install: {
        build: pair.pinned.placement === 'symlink' ? 'symlink' : 'copy',
        storePath: pair.pinned.storePath,
        contentHash: pair.pinned.contentHash,
        pinned: pair.pinned,
        origin: pair.origin,
        adoptedDev: pair.dev,
      },
    });
  }
  if (j.op === 'uninstall') {
    return ok({ ...base, op: 'uninstall' });
  }
  return err(genericError(`cannot resume journal op '${j.op}' for ${skill}`));
};

/** Same-op re-run continuation (spec §8.4 right column). Reconstructs the plan from the ledger and
 *  drives the journal forward to committed; a committed journal only reclaims residue and finishes
 *  the terminal transition.
 *  Warning: called on an already-`committed` journal, this still returns `ok({committed: true})` —
 *  that means "residue reclaimed", never "this call just performed the swap"; callers must not
 *  count it as a fresh success. */
export const resumeSwap = async (
  ctx: SwapCtx,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null = null,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pair = getPairAt(ctx.ledger, scopeKey, skill, tool);
  const j = pair?.journal ?? null;
  if (!pair || !j) return err(flipRefusedError(`nothing to resume for ${skill}`));
  const plan = reconstructPlan(pair, j, skill, tool, scopeKey);
  if (!plan.ok) return plan;
  return forward(ctx, plan.value, pair);
};

/** Uncommitted-journal recovery (spec §8.4 --rollback column). Restores the before-state with at
 *  most two renames and clears the journal. A committed promote/dev/install is refused — the run
 *  layer performs the inverse via the retained records. A committed uninstall is still reversible
 *  while its backup survives (rename it back); once reclaimed it is terminal. A fresh install
 *  (before absent) rolls back to "nothing there": the new artifact and pair record are removed. */
export const rollbackSwap = async (
  ctx: SwapCtx,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null = null,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pair = getPairAt(ctx.ledger, scopeKey, skill, tool);
  const j = pair?.journal ?? null;
  if (!pair || !j) return err(flipRefusedError(`nothing to roll back for ${skill}`));

  const env = ctx.env;
  const live = pair.placementPath;
  const before = j.before;

  if (j.phase === 'committed') {
    if (j.op === 'uninstall' && (await env.pathKind(j.backupPath)) !== 'absent') {
      try {
        if ((await env.pathKind(live)) === 'absent') await env.rename(j.backupPath, live);
      } catch (e) {
        return err(mapFsErr(e, `cannot roll back ${skill}`));
      }
      pair.journal = null;
      const persisted = await ctx.persist();
      if (!persisted.ok) return persisted;
      return ok({ committed: false, backupKept: null, warning: null });
    }
    return err(flipRefusedError(`cannot roll back a committed ${j.op} of ${skill}`));
  }

  // Fresh install: the only live entry that can exist is the new artifact. Restore "nothing there".
  if (before.mode === 'absent') {
    try {
      if ((await env.pathKind(live)) !== 'absent') await env.removeTree(live);
      if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
    } catch (e) {
      return err(mapFsErr(e, `cannot roll back ${skill}`));
    }
    deletePairAt(ctx.ledger, scopeKey, skill, tool);
    const persisted = await ctx.persist();
    if (!persisted.ok) return persisted;
    return ok({ committed: false, backupKept: null, warning: null });
  }

  const oldKind = before.liveKind ?? (before.mode === 'dev' ? 'symlink' : 'dir');
  try {
    const liveKind = await env.pathKind(live);
    if (liveKind === 'absent') {
      // P3 done, P4 not: the old entry lives at the backup — one rename restores it.
      if ((await env.pathKind(j.backupPath)) !== 'absent') {
        await env.rename(j.backupPath, live);
      }
    } else {
      // Live is present: decide whether it is the NEW artifact (P4 done) or still the OLD one. A kind
      // change tells them apart; a symlink→symlink replace can't be told apart by kind, so compare
      // the recorded old symlink target — this is what makes symlink→symlink replace safe to allow.
      let liveIsNew: boolean;
      if (oldKind === 'symlink' && liveKind === 'symlink') {
        if (before.symlinkTarget == null) {
          return err(
            genericError(`cannot roll back ${skill}: symlink before-state is missing its target`),
          );
        }
        liveIsNew = (await env.readLink(live)) !== before.symlinkTarget;
      } else {
        liveIsNew = liveKind !== oldKind;
      }
      if (liveIsNew) {
        // Move the new entry aside, restore the backup, drop the new one.
        if ((await env.pathKind(j.backupPath)) !== 'absent') {
          if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
          await env.rename(live, j.stagingPath);
          await env.rename(j.backupPath, live);
        }
      }
      // else: live is still the old entry — nothing to restore.
    }
    if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
  } catch (e) {
    return err(mapFsErr(e, `cannot roll back ${skill}`));
  }

  // Restores the old live BYTES but keeps whatever records `stagePair` wrote at P1: for an
  // uncommitted replace-install rollback that means the NEW pinned/origin/placement records survive
  // (mirrors P12 promote-rollback — the engine never retains the old PinnedRecord/origin, so it
  // cannot restore them). The run layer (Task 7) MUST reconcile the ledger record after such a rollback.
  pair.mode = before.mode;
  pair.journal = null;
  const persisted = await ctx.persist();
  if (!persisted.ok) return persisted;
  return ok({ committed: false, backupKept: null, warning: null });
};

/** §8.5: finish any committed acquisition journal left by a crash between the committed write and
 *  the terminal write. Walks the user `skills` tree AND every `projects` subtree. Runs at the start
 *  of every locked batch (install, uninstall, promote, dev, rollback). Idempotent. */
export const sweepCommittedAcquireJournals = async (
  ctx: SwapCtx,
): Promise<Result<string[], SkillSmithError>> => {
  type Target = { scopeKey: string | null; skill: string; tool: FlipTool };
  const targets: Target[] = [];

  const collect = (tree: LedgerFile['skills'], scopeKey: string | null): void => {
    for (const skill of Object.keys(tree)) {
      const entry = tree[skill];
      if (!entry) continue;
      for (const tool of Object.keys(entry.tools) as FlipTool[]) {
        const j = entry.tools[tool]?.journal;
        if (j && j.phase === 'committed' && (j.op === 'install' || j.op === 'uninstall')) {
          targets.push({ scopeKey, skill, tool });
        }
      }
    }
  };

  collect(ctx.ledger.skills, null);
  if (ctx.ledger.projects) {
    for (const key of Object.keys(ctx.ledger.projects)) {
      const scope = ctx.ledger.projects[key];
      if (scope) collect(scope.skills, key);
    }
  }

  const notes: string[] = [];
  for (const t of targets) {
    const pair = getPairAt(ctx.ledger, t.scopeKey, t.skill, t.tool);
    const j = pair?.journal ?? null;
    if (!pair || !j) continue;
    const plan = reconstructPlan(pair, j, t.skill, t.tool, t.scopeKey);
    if (!plan.ok) return plan;
    const done = await forward(ctx, plan.value, pair);
    if (!done.ok) return done;
    if (done.value.warning) notes.push(done.value.warning);
  }
  return ok(notes);
};
