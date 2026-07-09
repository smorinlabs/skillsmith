import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ScanEnv } from '../env/types.ts';
import {
  type SkillSmithError,
  flipFailedError,
  flipRefusedError,
  genericError,
  sourceUnresolvableError,
} from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { verifyPlugin } from '../verify/run.ts';
import type { ToolVerdict } from '../verify/types.ts';
import { getPair, readLedger, withLedgerLock, writeLedger } from './ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from './paths.ts';
import { type PairPlan, planFlips } from './plan.ts';
import { contentHashOf, resolveProvenance, snapshotToStore, sweepStaging } from './store.ts';
import { resumeSwap, rollbackSwap, runSwap, sweepCommittedAcquireJournals } from './swap.ts';
import {
  type DevRecord,
  FLIP_TOOLS,
  type FlipAction,
  type FlipDeps,
  type FlipOp,
  type FlipOptions,
  type FlipReport,
  type FlipResult,
  type FlipTool,
  type LedgerFile,
  type PinnedRecord,
  type Provenance,
  type SwapCtx,
  type SwapPlan,
} from './types.ts';

export const defaultFlipDeps: FlipDeps = {
  verify: verifyPlugin,
  now: () => new Date().toISOString(),
  newTxId: () => randomBytes(4).toString('hex'),
};

const errMessage = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

/** Mid-swap `ledgerError` maps to flip-failed (exit 1), not the ledger-unreadable exit 3 — a
 *  persist failure DURING an in-flight flip is a flip failure, not a corrupt/unreadable ledger. */
const midSwapError = (e: SkillSmithError): SkillSmithError =>
  e.code === 'ledger-error' ? flipFailedError(errMessage(e)) : e;

const resolveSymlinkAbsolute = (placementPath: string, literalTarget: string): string =>
  isAbsolute(literalTarget) ? literalTarget : join(dirname(placementPath), literalTarget);

const HASH_PREFIX_LEN = 'sha256:'.length;

const computeRevPreview = async (
  env: ScanEnv,
  provenance: Provenance,
  sourceDir: string,
): Promise<Result<string, SkillSmithError>> => {
  if (provenance.kind === 'git-clean') {
    if (!provenance.gitSha) return err(genericError('git-clean provenance without a gitSha'));
    return ok(provenance.gitSha.slice(0, 12));
  }
  const h = await contentHashOf(env, sourceDir);
  if (!h.ok) return h;
  const hash12 = h.value.slice(HASH_PREFIX_LEN, HASH_PREFIX_LEN + 12);
  return ok(provenance.kind === 'git-dirty' ? `dirty-${hash12}` : `content-${hash12}`);
};

type Base = { skill: string; tool: FlipTool; placementPath: string | null };

const refusedResult = (base: Base, reason: string, error: SkillSmithError): FlipResult => ({
  ...base,
  action: 'refused',
  reason,
  before: null,
  after: null,
  store: null,
  verify: null,
  error,
});

const failedResult = (base: Base, error: SkillSmithError): FlipResult => ({
  ...base,
  action: 'failed',
  reason: errMessage(error),
  before: null,
  after: null,
  store: null,
  verify: null,
  error,
});

const noopResult = (base: Base, reason: string | null): FlipResult => ({
  ...base,
  action: 'noop',
  reason,
  before: null,
  after: null,
  store: null,
  verify: null,
});

const interruptedResult = (pair: PairPlan): FlipResult => ({
  skill: pair.skill,
  tool: pair.tool,
  placementPath: pair.placement.path,
  action: 'skipped',
  reason: 'interrupted',
  before: null,
  after: null,
  store: null,
  verify: null,
});

const makeSwapCtx = (
  env: ScanEnv,
  ledgerPath: string,
  ledger: LedgerFile,
  deps: FlipDeps,
  opts: FlipOptions,
): SwapCtx => ({
  env,
  ledgerPath,
  ledger,
  persist: () => writeLedger(env, ledgerPath, ledger),
  now: deps.now,
  newTxId: deps.newTxId,
  pauseAt: opts.testPauseAt,
  signal: opts.signal,
});

const summarizeFindings = (tv: ToolVerdict | undefined): string => {
  if (!tv) return 'no verdict produced';
  const findings = tv.modes
    .flatMap((m) => m.findings)
    .filter((f) => f.normalizedSeverity !== 'info');
  if (findings.length === 0) return `verdict ${tv.verdict}`;
  return findings.map((f) => `${f.checkId}: ${f.message}`).join('; ');
};

interface GateOutcome {
  blocked: SkillSmithError | null;
  gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive';
  verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | null;
  notice: string | null;
}

/** Promote's verify gate (spec §9/D11): claude-code -> static only; codex -> deep (implies
 *  static). `fail` blocks; `warn` blocks only under --strict; `inconclusive` proceeds with a
 *  notice unless --strict. `--no-verify` skips the gate entirely. */
const runVerifyGate = async (
  env: ScanEnv,
  deps: FlipDeps,
  tool: FlipTool,
  sourceDir: string,
  opts: FlipOptions,
): Promise<GateOutcome> => {
  if (opts.noVerify) return { blocked: null, gate: 'skipped', verdict: null, notice: null };

  const vr = await deps.verify(env, {
    path: sourceDir,
    tools: [tool],
    deep: tool === 'codex',
    strict: opts.strict ?? false,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!vr.ok) return { blocked: vr.error, gate: 'failed', verdict: 'fail', notice: null };

  const toolVerdict = vr.value.tools.find((t) => t.tool === tool);
  const verdict = toolVerdict?.verdict ?? vr.value.summary.verdict;

  if (verdict === 'fail') {
    const reason = `promotion blocked: '${sourceDir}' failed verification for ${tool}: ${summarizeFindings(toolVerdict)}`;
    return { blocked: flipFailedError(reason), gate: 'failed', verdict: 'fail', notice: null };
  }
  if (verdict === 'warn') {
    if (opts.strict) {
      return {
        blocked: flipFailedError(`verify warnings blocked under --strict for ${tool}`),
        gate: 'failed',
        verdict: 'warn',
        notice: null,
      };
    }
    return { blocked: null, gate: 'warned', verdict: 'warn', notice: null };
  }
  if (verdict === 'inconclusive') {
    if (opts.strict) {
      return {
        blocked: flipFailedError(`verify gate inconclusive under --strict for ${tool}`),
        gate: 'failed',
        verdict: 'inconclusive',
        notice: null,
      };
    }
    return {
      blocked: null,
      gate: 'inconclusive',
      verdict: 'inconclusive',
      notice: `verify gate was inconclusive for ${tool}; proceeding unverified`,
    };
  }
  return { blocked: null, gate: 'passed', verdict: 'pass', notice: null };
};

const ledgerVerifyOf = (gate: GateOutcome['gate']): 'passed' | 'warned' | 'skipped' =>
  gate === 'passed' ? 'passed' : gate === 'warned' ? 'warned' : 'skipped';

// ---------------------------------------------------------------------------------------------
// promote (real)
// ---------------------------------------------------------------------------------------------

const runPromotePair = async (
  env: ScanEnv,
  ledger: LedgerFile,
  ledgerPath: string,
  pair: PairPlan,
  opts: FlipOptions,
  deps: FlipDeps,
): Promise<FlipResult> => {
  const { skill, tool, placement, notices } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getPair(ledger, skill, tool);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    if (existing.journal.op === 'promote') {
      const swapCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts);
      const resumed = await resumeSwap(swapCtx, skill, tool);
      if (!resumed.ok) return failedResult(base, midSwapError(resumed.error));
      const after = getPair(ledger, skill, tool);
      return {
        ...base,
        action: 'flipped',
        reason: resumed.value.warning,
        before: null,
        after: after?.pinned ? { mode: 'pinned', storePath: after.pinned.storePath } : null,
        store: after?.pinned
          ? {
              path: after.pinned.storePath,
              rev: after.pinned.rev,
              gitSha: after.pinned.gitSha,
              dirty: after.pinned.dirty,
              reused: true,
            }
          : null,
        verify: null,
      };
    }
    const reason =
      `'${skill}' (${tool}) has an interrupted ${existing.journal.op} in progress ` +
      `(phase: ${existing.journal.phase}). Run 'skillsmith ${existing.journal.op} --rollback ${skill}' ` +
      `to restore the previous state, or 'skillsmith ${existing.journal.op} ${skill}' to complete it.`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  let devRecord: DevRecord;
  let resolvedSourceDir: string;
  let isReplace = false;

  if (placement.class === 'store-linked') {
    // D9: a hand-made symlink into the store with no ledger pair at all is unmanageable —
    // reinstall is the only way back to a known state (P12 behavior for every OTHER unmanaged
    // placement kind never applied here since store-linked was previously unreachable).
    if (!existing) {
      const reason = "managed state missing; reinstall with 'skillsmith install --force'";
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    if (!existing.dev) return noopResult(base, 'already pinned; no dev source recorded');
    devRecord = existing.dev;
    resolvedSourceDir = existing.dev.resolvedPath;
    isReplace = true;
  } else if (placement.class === 'pinned') {
    if (!existing?.dev) return noopResult(base, 'already pinned; no dev source recorded');
    devRecord = existing.dev;
    resolvedSourceDir = existing.dev.resolvedPath;
    isReplace = true;
  } else {
    if (placement.dangling) {
      const reason = `dev symlink target does not exist: ${placement.symlinkTarget ?? '<unknown>'}`;
      return refusedResult(base, reason, sourceUnresolvableError(reason));
    }
    const target = placement.symlinkTarget;
    if (target === null)
      return failedResult(base, genericError('dev placement missing symlink target'));
    resolvedSourceDir = resolveSymlinkAbsolute(placement.path, target);
    const hasSkillMd = await env.fileExists(join(resolvedSourceDir, 'SKILL.md'));
    if (!hasSkillMd) {
      const reason = 'target of the dev symlink is not a skill directory';
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    devRecord = {
      sourcePath: target,
      resolvedPath: resolvedSourceDir,
      repoRoot: null,
      sourceRelPath: null,
      remote: null,
      recordedAt: deps.now(),
    };
  }

  // D9 re-pin (the heart of D9): a symlink-placement pinned record with a retained origin means
  // the FINAL swap must re-create a store symlink, not a copy — whether reached via the
  // store-linked convergence above, or via a plain promote of a dev symlink whose pair still
  // carries that record (the install -> `dev --source` -> promote loop, PRD scenario 4). The
  // latter is itself a replace (there is a previous rev to converge against), not a fresh flip.
  const symlinkRepin = existing?.pinned?.placement === 'symlink' && existing?.origin !== undefined;
  if (symlinkRepin) isReplace = true;

  const gate = await runVerifyGate(env, deps, tool, resolvedSourceDir, opts);
  if (gate.blocked) {
    return {
      ...base,
      action: 'failed',
      reason: errMessage(gate.blocked),
      before: null,
      after: null,
      store: null,
      verify: { gate: gate.gate, verdict: gate.verdict },
      error: gate.blocked,
    };
  }

  const provRes = await resolveProvenance(env, resolvedSourceDir);
  if (!provRes.ok) return failedResult(base, provRes.error);
  const provenance = provRes.value;

  if (!isReplace) {
    devRecord = {
      ...devRecord,
      repoRoot: provenance.repoRoot,
      sourceRelPath: provenance.sourceRelPath,
      remote: provenance.remote,
    };
  }

  const notesAcc = [...notices];
  if (gate.notice) notesAcc.push(gate.notice);

  if (provenance.kind === 'git-dirty') {
    if (!opts.allowDirty) {
      const reason = `refusing to promote '${skill}': the source tree is dirty.\n${provenance.dirtySummary ?? ''}\nCommit the changes, or pass --allow-dirty to snapshot as dirty-<hash>.`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    notesAcc.push(
      'snapshotted a dirty working tree (--allow-dirty); rev is content-based, not a git SHA',
    );
  } else if (provenance.kind === 'non-git') {
    notesAcc.push('non-git source; pinned by content hash (no git provenance)');
  }

  if (isReplace) {
    const currentRevRes = await computeRevPreview(env, provenance, resolvedSourceDir);
    if (!currentRevRes.ok) return failedResult(base, currentRevRes.error);
    if (existing?.pinned && currentRevRes.value === existing.pinned.rev) {
      const reason = notesAcc.length > 0 ? notesAcc.join('; ') : 'already pinned; source unchanged';
      return noopResult(base, reason);
    }

    if (symlinkRepin) {
      const repinOrigin = existing?.origin;
      if (!repinOrigin)
        return failedResult(base, genericError('symlink re-pin missing origin record'));

      const dataDir = resolveDataDir(env, opts.envVars);
      const txId = deps.newTxId();
      const snapRes = await snapshotToStore(env, {
        sourceDir: resolvedSourceDir,
        skill,
        storeRoot: storeRootOf(dataDir),
        provenance,
        txId,
      });
      if (!snapRes.ok) return failedResult(base, snapRes.error);
      const snap = snapRes.value;

      const pinned: PinnedRecord = {
        storePath: snap.storePath,
        rev: snap.rev,
        gitSha: provenance.gitSha,
        dirty: provenance.kind === 'git-dirty',
        contentHash: snap.contentHash,
        snapshotAt: deps.now(),
        verify: ledgerVerifyOf(gate.gate),
        placement: 'symlink',
      };

      // `adoptedDev` tells the engine the PRE-swap live symlink pointed outside the store (governs
      // its before-state classification): true when we got here via a dev-class placement (the
      // live entry there IS a genuine dev symlink); false for a store-linked convergence (the live
      // entry there already points inside the store).
      const installPlan: SwapPlan = {
        op: 'install',
        skill,
        tool,
        skillsRoot: dirname(placement.path),
        placementPath: placement.path,
        install: {
          build: 'symlink',
          storePath: snap.storePath,
          contentHash: snap.contentHash,
          pinned,
          origin: repinOrigin,
          adoptedDev: placement.class === 'dev' ? devRecord : null,
        },
      };
      const swapCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts);
      const swapRes = await runSwap(swapCtx, installPlan);
      if (!swapRes.ok) return failedResult(base, midSwapError(swapRes.error));
      if (swapRes.value.warning) notesAcc.push(swapRes.value.warning);

      return {
        ...base,
        action: 'updated',
        reason: notesAcc.length > 0 ? notesAcc.join('; ') : null,
        before: { mode: 'pinned', storePath: existing?.pinned?.storePath ?? null },
        after: { mode: 'pinned', storePath: snap.storePath },
        store: {
          path: snap.storePath,
          rev: snap.rev,
          gitSha: provenance.gitSha,
          dirty: provenance.kind === 'git-dirty',
          reused: snap.reused,
        },
        verify: { gate: gate.gate, verdict: gate.verdict },
      };
    }

    // Re-pin (source moved): swap.ts's 'promote' op always reads the live entry as a symlink, so
    // a pinned->pinned replacement first flips back to `dev` (retained record, hash-guarded
    // deletion of the old copy) — a self-contained, separately committed swap — before falling
    // through to the same snapshot+promote path a fresh adoption takes. A crash between the two
    // leaves the pair in `dev` mode with the retained source, which a re-run of `promote` heals.
    const toDevPlan: SwapPlan = {
      op: 'dev',
      skill,
      tool,
      skillsRoot: dirname(placement.path),
      placementPath: placement.path,
      dev: { sourcePath: devRecord.sourcePath, devRecord },
    };
    const toDevCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts);
    const toDevRes = await runSwap(toDevCtx, toDevPlan);
    if (!toDevRes.ok) return failedResult(base, midSwapError(toDevRes.error));
    if (toDevRes.value.warning) notesAcc.push(toDevRes.value.warning);
  }

  const dataDir = resolveDataDir(env, opts.envVars);
  const txId = deps.newTxId();
  const snapRes = await snapshotToStore(env, {
    sourceDir: resolvedSourceDir,
    skill,
    storeRoot: storeRootOf(dataDir),
    provenance,
    txId,
  });
  if (!snapRes.ok) return failedResult(base, snapRes.error);
  const snap = snapRes.value;

  const pinned: PinnedRecord = {
    storePath: snap.storePath,
    rev: snap.rev,
    gitSha: provenance.gitSha,
    dirty: provenance.kind === 'git-dirty',
    contentHash: snap.contentHash,
    snapshotAt: deps.now(),
    verify: ledgerVerifyOf(gate.gate),
  };

  const plan: SwapPlan = {
    op: 'promote',
    skill,
    tool,
    skillsRoot: dirname(placement.path),
    placementPath: placement.path,
    promote: { storePath: snap.storePath, contentHash: snap.contentHash, pinned, devRecord },
  };
  const swapCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts);
  const swapRes = await runSwap(swapCtx, plan);
  if (!swapRes.ok) return failedResult(base, midSwapError(swapRes.error));
  if (swapRes.value.warning) notesAcc.push(swapRes.value.warning);

  const action: FlipAction = isReplace ? 'updated' : 'flipped';
  return {
    ...base,
    action,
    reason: notesAcc.length > 0 ? notesAcc.join('; ') : null,
    before: isReplace
      ? { mode: 'pinned', storePath: existing?.pinned?.storePath ?? null }
      : { mode: 'dev', symlinkTarget: devRecord.sourcePath },
    after: { mode: 'pinned', storePath: snap.storePath },
    store: {
      path: snap.storePath,
      rev: snap.rev,
      gitSha: provenance.gitSha,
      dirty: provenance.kind === 'git-dirty',
      reused: snap.reused,
    },
    verify: { gate: gate.gate, verdict: gate.verdict },
  };
};

// ---------------------------------------------------------------------------------------------
// dev (real)
// ---------------------------------------------------------------------------------------------

const runDevPair = async (
  env: ScanEnv,
  ledger: LedgerFile,
  ledgerPath: string,
  pair: PairPlan,
  opts: FlipOptions,
  deps: FlipDeps,
): Promise<FlipResult> => {
  const { skill, tool, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getPair(ledger, skill, tool);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    if (existing.journal.op === 'dev') {
      const swapCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts);
      const resumed = await resumeSwap(swapCtx, skill, tool);
      if (!resumed.ok) return failedResult(base, midSwapError(resumed.error));
      const after = getPair(ledger, skill, tool);
      return {
        ...base,
        action: 'flipped',
        reason: resumed.value.warning,
        before: null,
        after: after?.dev ? { mode: 'dev', symlinkTarget: after.dev.sourcePath } : null,
        store: after?.pinned
          ? {
              path: after.pinned.storePath,
              rev: after.pinned.rev,
              gitSha: after.pinned.gitSha,
              dirty: after.pinned.dirty,
              reused: true,
            }
          : null,
        verify: null,
      };
    }
    const reason =
      `'${skill}' (${tool}) has an interrupted ${existing.journal.op} in progress ` +
      `(phase: ${existing.journal.phase}). Run 'skillsmith ${existing.journal.op} --rollback ${skill}' ` +
      `to restore the previous state, or 'skillsmith ${existing.journal.op} ${skill}' to complete it.`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  if (placement.class === 'dev') return noopResult(base, null);

  const recordedSource = existing?.dev?.sourcePath ?? null;
  const source = opts.source ?? recordedSource;
  const updatedRecord =
    opts.source !== undefined &&
    recordedSource !== null &&
    resolve(opts.cwd, opts.source) !== resolve(opts.cwd, recordedSource);

  if (source === null) {
    // D9: a recordless store-linked placement (hand-made symlink into the store) has no dev
    // history to point at — the reinstall guidance applies, not the generic --source hint.
    if (placement.class === 'store-linked' && !existing) {
      const reason = "managed state missing; reinstall with 'skillsmith install --force'";
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    if (opts.all) {
      return {
        ...base,
        action: 'skipped',
        reason: 'no recorded dev source',
        before: null,
        after: null,
        store: null,
        verify: null,
      };
    }
    const reason = 'no recorded dev source; pass --source <path>';
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  const resolvedSourceDir = resolve(opts.cwd, source);
  const hasSkillMd = await env.fileExists(join(resolvedSourceDir, 'SKILL.md'));
  if (!hasSkillMd) {
    if (opts.source !== undefined) {
      const reason = `--source '${opts.source}' does not contain SKILL.md`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    const reason = `the recorded dev source for '${skill}' (${tool}) no longer exists: ${resolvedSourceDir}`;
    return refusedResult(base, reason, sourceUnresolvableError(reason));
  }

  const provRes = await resolveProvenance(env, resolvedSourceDir);
  const repoRoot = provRes.ok ? provRes.value.repoRoot : null;
  const sourceRelPath = provRes.ok ? provRes.value.sourceRelPath : null;
  const remote = provRes.ok ? provRes.value.remote : null;

  const devRecord: DevRecord = {
    sourcePath: source,
    resolvedPath: resolvedSourceDir,
    repoRoot,
    sourceRelPath,
    remote,
    recordedAt: deps.now(),
  };

  const plan: SwapPlan = {
    op: 'dev',
    skill,
    tool,
    skillsRoot: dirname(placement.path),
    placementPath: placement.path,
    dev: { sourcePath: source, devRecord },
  };
  const swapCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts);
  const swapRes = await runSwap(swapCtx, plan);
  if (!swapRes.ok) return failedResult(base, midSwapError(swapRes.error));

  const notesAcc: string[] = [];
  if (updatedRecord) notesAcc.push('dev source updated from --source');
  if (swapRes.value.warning) notesAcc.push(swapRes.value.warning);

  return {
    ...base,
    action: 'flipped',
    reason: notesAcc.length > 0 ? notesAcc.join('; ') : null,
    before: { mode: 'pinned', storePath: existing?.pinned?.storePath ?? null },
    after: { mode: 'dev', symlinkTarget: source },
    store: existing?.pinned
      ? {
          path: existing.pinned.storePath,
          rev: existing.pinned.rev,
          gitSha: existing.pinned.gitSha,
          dirty: existing.pinned.dirty,
          reused: true,
        }
      : null,
    verify: null,
  };
};

// ---------------------------------------------------------------------------------------------
// rollback (real) — D10, direction-agnostic
// ---------------------------------------------------------------------------------------------

const runRollbackPair = async (
  env: ScanEnv,
  ledger: LedgerFile,
  ledgerPath: string,
  pair: PairPlan,
  opts: FlipOptions,
  deps: FlipDeps,
): Promise<FlipResult> => {
  const { skill, tool, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getPair(ledger, skill, tool);
  const swapCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    // Captured BEFORE the call: `rollbackSwap` mutates this same pair record in place (nulls
    // `.journal` on success), so reading `existing.journal` afterward would see the post-mutation
    // state, not the journal that was actually rolled back.
    const journalOp = existing.journal.op;
    const journalBeforeMode = existing.journal.before.mode;
    const rb = await rollbackSwap(swapCtx, skill, tool);
    if (!rb.ok) return failedResult(base, midSwapError(rb.error));

    // I2: an uncommitted install REPLACE (before-state was a real placement, not a fresh install)
    // restores the OLD live bytes but the engine never captures the OLD pinned/origin records, so
    // they're left stranded on the pair pointing at the un-materialized new rev — a silent ledger/
    // disk mismatch until the next `install` reconciles it. Scoped to exactly that case: a fresh
    // install rollback deletes the pair (coherent), and uninstall/promote/dev rollbacks never
    // overwrote records (coherent) — neither needs this warning.
    const isInterruptedInstallReplace = journalOp === 'install' && journalBeforeMode !== 'absent';
    const reconcileWarning = `placement bytes were restored to the previous state, but the ledger still records the interrupted install's rev for '${skill}' — re-run 'skillsmith install' to reconcile it (it self-corrects on the next install)`;
    const reason = isInterruptedInstallReplace
      ? rb.value.warning
        ? `${rb.value.warning}; ${reconcileWarning}`
        : reconcileWarning
      : rb.value.warning;

    return {
      ...base,
      action: 'rolled-back',
      reason,
      before: null,
      after: null,
      store: null,
      verify: null,
    };
  }

  if (
    !existing ||
    (existing.mode === 'pinned' && !existing.dev) ||
    (existing.mode === 'dev' && !existing.pinned)
  ) {
    const reason = 'nothing to roll back';
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  if (existing.mode === 'pinned') {
    const devRecord = existing.dev as DevRecord;
    const plan: SwapPlan = {
      op: 'dev',
      rollbackOf: 'promote',
      skill,
      tool,
      skillsRoot: dirname(placement.path),
      placementPath: placement.path,
      dev: { sourcePath: devRecord.sourcePath, devRecord },
    };
    const swapRes = await runSwap(swapCtx, plan);
    if (!swapRes.ok) return failedResult(base, midSwapError(swapRes.error));
    return {
      ...base,
      action: 'rolled-back',
      reason: swapRes.value.warning,
      before: { mode: 'pinned', storePath: existing.pinned?.storePath ?? null },
      after: { mode: 'dev', symlinkTarget: devRecord.sourcePath },
      store: existing.pinned
        ? {
            path: existing.pinned.storePath,
            rev: existing.pinned.rev,
            gitSha: existing.pinned.gitSha,
            dirty: existing.pinned.dirty,
            reused: true,
          }
        : null,
      verify: null,
    };
  }

  const pinned = existing.pinned as PinnedRecord;
  const devRecordForPlan: DevRecord =
    existing.dev ??
    ({
      sourcePath: placement.symlinkTarget ?? '',
      resolvedPath: placement.symlinkTarget ?? '',
      repoRoot: null,
      sourceRelPath: null,
      remote: null,
      recordedAt: deps.now(),
    } satisfies DevRecord);
  const plan: SwapPlan = {
    op: 'promote',
    rollbackOf: 'dev',
    skill,
    tool,
    skillsRoot: dirname(placement.path),
    placementPath: placement.path,
    promote: {
      storePath: pinned.storePath,
      contentHash: pinned.contentHash,
      pinned,
      devRecord: devRecordForPlan,
    },
  };
  const swapRes = await runSwap(swapCtx, plan);
  if (!swapRes.ok) return failedResult(base, midSwapError(swapRes.error));
  return {
    ...base,
    action: 'rolled-back',
    reason: swapRes.value.warning,
    before:
      placement.symlinkTarget !== null
        ? { mode: 'dev', symlinkTarget: placement.symlinkTarget }
        : { mode: 'dev' },
    after: { mode: 'pinned', storePath: pinned.storePath },
    store: {
      path: pinned.storePath,
      rev: pinned.rev,
      gitSha: pinned.gitSha,
      dirty: pinned.dirty,
      reused: true,
    },
    verify: null,
  };
};

const predictRollbackPair = (ledger: LedgerFile, pair: PairPlan): FlipResult => {
  const { skill, tool, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getPair(ledger, skill, tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    return {
      ...base,
      action: 'rolled-back',
      reason: null,
      before: null,
      after: null,
      store: null,
      verify: null,
    };
  }
  if (
    !existing ||
    (existing.mode === 'pinned' && !existing.dev) ||
    (existing.mode === 'dev' && !existing.pinned)
  ) {
    const reason = 'nothing to roll back';
    return refusedResult(base, reason, flipRefusedError(reason));
  }
  return {
    ...base,
    action: 'rolled-back',
    reason: null,
    before: null,
    after: null,
    store: null,
    verify: null,
  };
};

// ---------------------------------------------------------------------------------------------
// dry-run prediction (read-only; no verify, no lock, no journal, no store writes)
// ---------------------------------------------------------------------------------------------

const predictPair = async (
  env: ScanEnv,
  ledger: LedgerFile,
  op: 'promote' | 'dev',
  pair: PairPlan,
  opts: FlipOptions,
): Promise<FlipResult> => {
  const { skill, tool, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getPair(ledger, skill, tool);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    const reason = `an interrupted ${existing.journal.op} is in progress for '${skill}' (${tool})`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  if (op === 'promote') {
    if (placement.class === 'store-linked') {
      if (!existing) {
        const reason = "managed state missing; reinstall with 'skillsmith install --force'";
        return refusedResult(base, reason, flipRefusedError(reason));
      }
      if (!existing.dev) return noopResult(base, 'already pinned; no dev source recorded');
      const provRes = await resolveProvenance(env, existing.dev.resolvedPath);
      if (!provRes.ok) return failedResult(base, provRes.error);
      const provenance = provRes.value;
      if (provenance.kind === 'git-dirty' && !opts.allowDirty) {
        const reason = `refusing to promote '${skill}': the source tree is dirty`;
        return refusedResult(base, reason, flipRefusedError(reason));
      }
      const revRes = await computeRevPreview(env, provenance, existing.dev.resolvedPath);
      if (!revRes.ok) return failedResult(base, revRes.error);
      if (existing.pinned && revRes.value === existing.pinned.rev) {
        return noopResult(base, 'already pinned; source unchanged');
      }
      return {
        ...base,
        action: 'updated',
        reason: null,
        before: null,
        after: null,
        store: null,
        verify: null,
      };
    }

    if (placement.class === 'pinned') {
      if (!existing?.dev) return noopResult(base, 'already pinned; no dev source recorded');
      const provRes = await resolveProvenance(env, existing.dev.resolvedPath);
      if (!provRes.ok) return failedResult(base, provRes.error);
      const provenance = provRes.value;
      if (provenance.kind === 'git-dirty' && !opts.allowDirty) {
        const reason = `refusing to promote '${skill}': the source tree is dirty`;
        return refusedResult(base, reason, flipRefusedError(reason));
      }
      const revRes = await computeRevPreview(env, provenance, existing.dev.resolvedPath);
      if (!revRes.ok) return failedResult(base, revRes.error);
      if (existing.pinned && revRes.value === existing.pinned.rev) {
        return noopResult(base, 'already pinned; source unchanged');
      }
      return {
        ...base,
        action: 'updated',
        reason: null,
        before: null,
        after: null,
        store: null,
        verify: null,
      };
    }

    if (placement.dangling) {
      const reason = `dev symlink target does not exist: ${placement.symlinkTarget ?? '<unknown>'}`;
      return refusedResult(base, reason, sourceUnresolvableError(reason));
    }
    const target = placement.symlinkTarget;
    if (target === null)
      return failedResult(base, genericError('dev placement missing symlink target'));
    const resolvedTarget = resolveSymlinkAbsolute(placement.path, target);
    const hasSkillMd = await env.fileExists(join(resolvedTarget, 'SKILL.md'));
    if (!hasSkillMd) {
      const reason = 'target of the dev symlink is not a skill directory';
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    const provRes = await resolveProvenance(env, resolvedTarget);
    if (!provRes.ok) return failedResult(base, provRes.error);
    if (provRes.value.kind === 'git-dirty' && !opts.allowDirty) {
      const reason = `refusing to promote '${skill}': the source tree is dirty`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }

    // D9: mirror runPromotePair's re-pin convergence for a dev symlink whose pair still carries a
    // symlink-placement pinned record + origin (install -> `dev --source` -> promote loop).
    if (existing?.pinned?.placement === 'symlink' && existing?.origin !== undefined) {
      const revRes = await computeRevPreview(env, provRes.value, resolvedTarget);
      if (!revRes.ok) return failedResult(base, revRes.error);
      if (existing.pinned && revRes.value === existing.pinned.rev) {
        return noopResult(base, 'already pinned; source unchanged');
      }
      return {
        ...base,
        action: 'updated',
        reason: null,
        before: null,
        after: null,
        store: null,
        verify: null,
      };
    }

    return {
      ...base,
      action: 'flipped',
      reason: null,
      before: null,
      after: null,
      store: null,
      verify: null,
    };
  }

  // op === 'dev'
  if (placement.class === 'dev') return noopResult(base, null);

  const recordedSource = existing?.dev?.sourcePath ?? null;
  const source = opts.source ?? recordedSource;
  if (source === null) {
    if (placement.class === 'store-linked' && !existing) {
      const reason = "managed state missing; reinstall with 'skillsmith install --force'";
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    if (opts.all) {
      return {
        ...base,
        action: 'skipped',
        reason: 'no recorded dev source',
        before: null,
        after: null,
        store: null,
        verify: null,
      };
    }
    const reason = 'no recorded dev source; pass --source <path>';
    return refusedResult(base, reason, flipRefusedError(reason));
  }
  const resolvedSourceDir = resolve(opts.cwd, source);
  const hasSkillMd = await env.fileExists(join(resolvedSourceDir, 'SKILL.md'));
  if (!hasSkillMd) {
    const reason = `the recorded dev source for '${skill}' (${tool}) no longer exists: ${resolvedSourceDir}`;
    return refusedResult(base, reason, sourceUnresolvableError(reason));
  }
  return {
    ...base,
    action: 'flipped',
    reason: null,
    before: null,
    after: null,
    store: null,
    verify: null,
  };
};

// ---------------------------------------------------------------------------------------------
// batch orchestration
// ---------------------------------------------------------------------------------------------

const buildRequested = (opts: FlipOptions): FlipReport['requested'] => {
  const requestedTools = opts.tools;
  const explicitTools = requestedTools !== undefined && requestedTools.length > 0;
  const tools = explicitTools ? [...requestedTools] : [...FLIP_TOOLS];
  return { targets: [...opts.targets], all: Boolean(opts.all), tools, explicitTools };
};

const emptySummary = (): FlipReport['summary'] => ({
  flipped: 0,
  updated: 0,
  noop: 0,
  skipped: 0,
  refused: 0,
  failed: 0,
  rolledBack: 0,
});

const ACTION_TO_SUMMARY_KEY: Record<FlipAction, keyof FlipReport['summary']> = {
  flipped: 'flipped',
  updated: 'updated',
  noop: 'noop',
  skipped: 'skipped',
  refused: 'refused',
  failed: 'failed',
  'rolled-back': 'rolledBack',
};

const buildReport = (
  op: FlipOp,
  dryRun: boolean,
  requested: FlipReport['requested'],
  results: FlipResult[],
): FlipReport => {
  const summary = emptySummary();
  for (const r of results) summary[ACTION_TO_SUMMARY_KEY[r.action]]++;
  return { op, dryRun, requested, results, summary };
};

type PairProcessor = (
  env: ScanEnv,
  ledger: LedgerFile,
  ledgerPath: string,
  pair: PairPlan,
  opts: FlipOptions,
  deps: FlipDeps,
) => Promise<FlipResult>;

const runFlipBatch = async (
  env: ScanEnv,
  opts: FlipOptions,
  op: 'promote' | 'dev',
  deps: FlipDeps,
  process: PairProcessor,
  predict: (env: ScanEnv, ledger: LedgerFile, pair: PairPlan) => Promise<FlipResult>,
): Promise<Result<FlipReport, SkillSmithError>> => {
  const dataDir = resolveDataDir(env, opts.envVars);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const requested = buildRequested(opts);

  if (opts.dryRun) {
    const ledgerRes = await readLedger(env, ledgerPath);
    if (!ledgerRes.ok) return ledgerRes;
    const planRes = await planFlips(env, { ...opts, op }, storeRoot, ledgerRes.value);
    if (!planRes.ok) return planRes;
    const results: FlipResult[] = [...planRes.value.preResults];
    for (const pair of planRes.value.pairs) results.push(await predict(env, ledgerRes.value, pair));
    return ok(buildReport(op, true, requested, results));
  }

  const locked = await withLedgerLock(
    env,
    ledgerPath,
    async (): Promise<Result<FlipReport, SkillSmithError>> => {
      await sweepStaging(env, storeRoot);
      const ledgerRes = await readLedger(env, ledgerPath);
      if (!ledgerRes.ok) return ledgerRes;
      let ledger = ledgerRes.value;

      // §8.5 hygiene: finish any committed install/uninstall left mid-terminal by a crash. Notes
      // are not surfaced by flips; a sweep failure aborts the batch (recovery must complete first).
      const swept = await sweepCommittedAcquireJournals(
        makeSwapCtx(env, ledgerPath, ledger, deps, opts),
      );
      if (!swept.ok) return err(midSwapError(swept.error));

      const planRes = await planFlips(env, { ...opts, op }, storeRoot, ledger);
      if (!planRes.ok) return planRes;
      const { pairs, preResults } = planRes.value;

      const results: FlipResult[] = [...preResults];
      for (let i = 0; i < pairs.length; i++) {
        if (opts.signal?.aborted) {
          for (let j = i; j < pairs.length; j++) {
            const remaining = pairs[j];
            if (remaining) results.push(interruptedResult(remaining));
          }
          break;
        }
        const pair = pairs[i];
        if (!pair) continue;
        const result = await process(env, ledger, ledgerPath, pair, opts, deps);
        results.push(result);
        if (result.error) {
          const reread = await readLedger(env, ledgerPath);
          if (reread.ok) ledger = reread.value;
        }
      }

      return ok(buildReport(op, false, requested, results));
    },
  );

  if (!locked.ok) return locked;
  return locked.value;
};

export const runPromote = (
  env: ScanEnv,
  opts: FlipOptions,
  deps: FlipDeps = defaultFlipDeps,
): Promise<Result<FlipReport, SkillSmithError>> =>
  runFlipBatch(env, opts, 'promote', deps, runPromotePair, (e, l, p) =>
    predictPair(e, l, 'promote', p, opts),
  );

export const runDev = (
  env: ScanEnv,
  opts: FlipOptions,
  deps: FlipDeps = defaultFlipDeps,
): Promise<Result<FlipReport, SkillSmithError>> =>
  runFlipBatch(env, opts, 'dev', deps, runDevPair, (e, l, p) => predictPair(e, l, 'dev', p, opts));

export const runRollback = async (
  env: ScanEnv,
  opts: FlipOptions & { op: 'promote' | 'dev' },
  deps: FlipDeps = defaultFlipDeps,
): Promise<Result<FlipReport, SkillSmithError>> => {
  const dataDir = resolveDataDir(env, opts.envVars);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const requested = buildRequested(opts);

  if (opts.dryRun) {
    const ledgerRes = await readLedger(env, ledgerPath);
    if (!ledgerRes.ok) return ledgerRes;
    const planRes = await planFlips(env, opts, storeRoot, ledgerRes.value);
    if (!planRes.ok) return planRes;
    const results: FlipResult[] = [...planRes.value.preResults];
    for (const pair of planRes.value.pairs)
      results.push(predictRollbackPair(ledgerRes.value, pair));
    return ok(buildReport('rollback', true, requested, results));
  }

  const locked = await withLedgerLock(
    env,
    ledgerPath,
    async (): Promise<Result<FlipReport, SkillSmithError>> => {
      await sweepStaging(env, storeRoot);
      const ledgerRes = await readLedger(env, ledgerPath);
      if (!ledgerRes.ok) return ledgerRes;
      let ledger = ledgerRes.value;

      // §8.5 hygiene: finish any committed install/uninstall left mid-terminal by a crash.
      const swept = await sweepCommittedAcquireJournals(
        makeSwapCtx(env, ledgerPath, ledger, deps, opts),
      );
      if (!swept.ok) return err(midSwapError(swept.error));

      const planRes = await planFlips(env, opts, storeRoot, ledger);
      if (!planRes.ok) return planRes;
      const { pairs, preResults } = planRes.value;

      const results: FlipResult[] = [...preResults];
      for (let i = 0; i < pairs.length; i++) {
        if (opts.signal?.aborted) {
          for (let j = i; j < pairs.length; j++) {
            const remaining = pairs[j];
            if (remaining) results.push(interruptedResult(remaining));
          }
          break;
        }
        const pair = pairs[i];
        if (!pair) continue;
        const result = await runRollbackPair(env, ledger, ledgerPath, pair, opts, deps);
        results.push(result);
        if (result.error) {
          const reread = await readLedger(env, ledgerPath);
          if (reread.ok) ledger = reread.value;
        }
      }

      return ok(buildReport('rollback', false, requested, results));
    },
  );

  if (!locked.ok) return locked;
  return locked.value;
};
