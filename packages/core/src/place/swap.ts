import { dirname, join } from 'node:path';
import type { ScanEnv } from '../env/types.ts';
import {
  type SkillSmithError,
  errorMessage,
  flipFailedError,
  flipRefusedError,
  genericError,
  permissionDeniedError,
} from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { getPair } from './ledger.ts';
import { contentHashOf } from './store.ts';
import type {
  FlipTool,
  Journal,
  JournalPhase,
  PairRecord,
  SwapCtx,
  SwapOutcome,
  SwapPlan,
} from './types.ts';

const PHASE_INDEX: Record<JournalPhase, number> = {
  prepared: 0,
  staged: 1,
  'backed-up': 2,
  live: 3,
  committed: 4,
};

const isPermError = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  'code' in e &&
  ((e as { code: unknown }).code === 'EACCES' || (e as { code: unknown }).code === 'EPERM');

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

// Recursively fsync every regular file under a freshly copied staging tree (durability of P2).
const fsyncTree = async (env: ScanEnv, dir: string): Promise<void> => {
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
    if (!plan.dev) return err(genericError('dev plan missing dev payload'));
    await env.makeSymlink(plan.dev.sourcePath, j.stagingPath);
    return ok(undefined);
  } catch (e) {
    return err(mapFsErr(e, `cannot stage ${plan.skill}`));
  }
};

// P5: write-ahead commit (durable committed journal) THEN reclaim the backup. Committing first
// keeps the C5 rollback valid — the backup is the only physical copy of the old state and must
// survive until the new live entry is recorded as committed.
const commit = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  pair: PairRecord,
  j: Journal,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const env = ctx.env;
  try {
    await env.fsyncDir(plan.skillsRoot);
  } catch (e) {
    return err(mapFsErr(e, `cannot fsync ${plan.skillsRoot}`));
  }

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
};

// Drive the swap forward from the journal's current phase to committed, probing the filesystem to
// disambiguate the crash window (spec §8.4 right column). Idempotent per phase.
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

  // P2 — build staging (journal at prepared).
  if (idx() < PHASE_INDEX.staged) {
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

  // P4 — persist live, then rename(staging → live) if the live path is still absent.
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

  // P5 — commit.
  if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
  return commit(ctx, plan, pair, j);
};

const refusedMessage = (op: string, skill: string): string =>
  `a previous ${op} of ${skill} was interrupted. ` +
  `Run 'skillsmith ${op} --rollback ${skill}' to restore the previous state, ` +
  `or re-run 'skillsmith ${op} ${skill}' to complete the swap.`;

/** Start a fresh journaled swap. Refuses (flip-refused) when the pair carries an uncommitted
 *  journal — the caller must rollback or resume it first (Global Constraint 6). */
export const runSwap = async (
  ctx: SwapCtx,
  plan: SwapPlan,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const existing = getPair(ctx.ledger, plan.skill, plan.tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    return err(flipRefusedError(refusedMessage(existing.journal.op, plan.skill)));
  }

  let before: Journal['before'];
  if (plan.op === 'promote') {
    if (!plan.promote) return err(genericError('promote plan missing promote payload'));
    let symlinkTarget: string;
    try {
      symlinkTarget = await ctx.env.readLink(plan.placementPath);
    } catch (e) {
      return err(mapFsErr(e, `cannot read live symlink for ${plan.skill}`));
    }
    before = { mode: 'dev', symlinkTarget };
  } else {
    if (!plan.dev) return err(genericError('dev plan missing dev payload'));
    before = {
      mode: 'pinned',
      storePath: existing?.pinned?.storePath ?? null,
      contentHash: existing?.pinned?.contentHash ?? null,
    };
  }

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

  // Stage the target records behind the uncommitted journal so a same-op resume can reconstruct
  // the plan from the ledger alone (resumeSwap takes no plan). mode is unchanged until P5.
  const pair: PairRecord = {
    placementPath: plan.placementPath,
    mode: before.mode,
    dev: plan.op === 'promote' ? (plan.promote?.devRecord ?? null) : (plan.dev?.devRecord ?? null),
    pinned: plan.op === 'promote' ? (plan.promote?.pinned ?? null) : (existing?.pinned ?? null),
    journal,
  };
  const entry = ctx.ledger.skills[plan.skill] ?? { tools: {} };
  entry.tools[plan.tool] = pair;
  ctx.ledger.skills[plan.skill] = entry;

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
): Result<SwapPlan, SkillSmithError> => {
  const base = {
    skill,
    tool,
    skillsRoot: dirname(pair.placementPath),
    placementPath: pair.placementPath,
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
  return err(genericError(`cannot resume journal op '${j.op}' for ${skill}`));
};

/** Same-op re-run continuation (spec §8.4 right column). Reconstructs the plan from the ledger and
 *  drives the journal forward to committed; a committed journal only reclaims residue. */
export const resumeSwap = async (
  ctx: SwapCtx,
  skill: string,
  tool: FlipTool,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pair = getPair(ctx.ledger, skill, tool);
  const j = pair?.journal ?? null;
  if (!pair || !j) return err(flipRefusedError(`nothing to resume for ${skill}`));
  const plan = reconstructPlan(pair, j, skill, tool);
  if (!plan.ok) return plan;
  return forward(ctx, plan.value, pair);
};

/** Uncommitted-journal recovery (spec §8.4 --rollback column). Restores the before-state with at
 *  most two renames and clears the journal. Committed journals are refused — the run layer performs
 *  the inverse flip via the retained records. */
export const rollbackSwap = async (
  ctx: SwapCtx,
  skill: string,
  tool: FlipTool,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pair = getPair(ctx.ledger, skill, tool);
  const j = pair?.journal ?? null;
  if (!pair || !j) return err(flipRefusedError(`nothing to roll back for ${skill}`));
  if (j.phase === 'committed') {
    return err(flipRefusedError(`cannot roll back a committed ${j.op} of ${skill}`));
  }

  const env = ctx.env;
  const live = pair.placementPath;
  const oldKind = j.before.mode === 'dev' ? 'symlink' : 'dir';
  try {
    const liveKind = await env.pathKind(live);
    if (liveKind === 'absent') {
      // P3 done, P4 not: the old entry lives at the backup — one rename restores it.
      if ((await env.pathKind(j.backupPath)) !== 'absent') {
        await env.rename(j.backupPath, live);
      }
    } else if (liveKind !== oldKind) {
      // Live is the NEW entry (P4 done): move it aside, restore the backup, drop the new one.
      if ((await env.pathKind(j.backupPath)) !== 'absent') {
        if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
        await env.rename(live, j.stagingPath);
        await env.rename(j.backupPath, live);
      }
    }
    // else: live is still the old entry — nothing to restore.
    if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
  } catch (e) {
    return err(mapFsErr(e, `cannot roll back ${skill}`));
  }

  pair.mode = j.before.mode;
  pair.journal = null;
  const persisted = await ctx.persist();
  if (!persisted.ok) return persisted;
  return ok({ committed: false, backupKept: null, warning: null });
};
