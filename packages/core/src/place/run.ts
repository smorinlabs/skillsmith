import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { classifyPlacement } from '../agents/placement-shared.ts';
import { toolRegistry } from '../agents/registry.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import type { PathKind } from '../env/types.ts';
import {
  type SkillSmithError,
  errorMessage,
  flipFailedError,
  flipRefusedError,
  genericError,
  safeErrorCode,
  sourceUnresolvableError,
} from '../errors.ts';
import {
  type ExecutionPrecondition,
  type PreparedExecutionBinding,
  type ValidatedExecutionBinding,
  createExecutionPrecondition,
  executeOperationPlan,
} from '../execution/index.ts';
import {
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
  createPlanCheckId,
  createPlanningDiagnosticId,
} from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
  OperationSource,
  PlanCheck,
  PlanningDiagnostic,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { verifyPlugin } from '../verify/run.ts';
import type { ToolVerdict } from '../verify/types.ts';
import { ledgerMigrationExecutionBinding, prepareLedgerMigration } from './ledger-migration.ts';
import { createLedgerPersistenceGateway } from './ledger-persistence.ts';
import {
  getLedgerPairAt,
  getPairAt,
  ledgerModelForMutation,
  legacyLedgerView,
  readLedgerState,
  withLedgerLock,
} from './ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from './paths.ts';
import { type FlipPlanOutcome, type PairPlan, planFlips } from './plan.ts';
import { contentHashOf, resolveProvenance, snapshotToStore } from './store.ts';
import { commitRecordOnlyLogicalTransaction, resumeSwap, rollbackSwap, runSwap } from './swap.ts';
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
  type Journal,
  type LedgerFile,
  type PairRecord,
  type PinnedRecord,
  type PlacementPorts,
  type PreparedFlipRun,
  type Provenance,
  type SwapCtx,
  type SwapPlan,
} from './types.ts';

export const defaultFlipDeps: FlipDeps = {
  verify: verifyPlugin,
};

const nowOf = (ports: PlacementPorts, deps: FlipDeps): string => deps.now?.() ?? ports.wallNowIso();
const journalNowOf = (ports: PlacementPorts, deps: FlipDeps): string => {
  const value = nowOf(ports, deps);
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
};
const txIdOf = (ports: PlacementPorts, deps: FlipDeps): string =>
  deps.newTxId?.() ?? ports.nextId('placement-transaction');

const errMessage = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

/** Mid-swap `ledgerError` maps to flip-failed (exit 1), not the ledger-unreadable exit 3 — a
 *  persist failure DURING an in-flight flip is a flip failure, not a corrupt/unreadable ledger. */
const midSwapError = (e: SkillSmithError): SkillSmithError =>
  e.code === 'ledger-error' ? flipFailedError(errMessage(e)) : e;

const resolveSymlinkAbsolute = (placementPath: string, literalTarget: string): string =>
  isAbsolute(literalTarget) ? literalTarget : join(dirname(placementPath), literalTarget);

const isEexist = (e: unknown): boolean => safeErrorCode(e) === 'EEXIST';

/** Non-blocking (T5 hard-kill orphan): remove any stale `.skillsmith-staging-<skill>-*` entries for
 *  THIS placement name before an S1 create publishes. A staging entry for this name can only be an
 *  orphan from a SIGKILLed earlier attempt — the single-ledger-lock assumption guarantees no other
 *  skillsmith op is concurrently mid-create for the same name. Best-effort: a listDir failure (root
 *  not yet created) or a removeTree race is swallowed; the create's own no-clobber publish is the
 *  real safety gate. */
const sweepOwnStaging = async (
  env: PlacementPorts,
  skillsRoot: string,
  skill: string,
): Promise<void> => {
  const prefix = `.skillsmith-staging-${skill}-`;
  let entries: readonly string[];
  try {
    entries = await env.listDir(skillsRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(prefix)) await env.removeTree(join(skillsRoot, name)).catch(() => {});
  }
};

const HASH_PREFIX_LEN = 'sha256:'.length;

const computeRevPreview = async (
  env: PlacementPorts,
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

const skippedAfterFailureResult = (pair: PairPlan): FlipResult => ({
  skill: pair.skill,
  tool: pair.tool,
  placementPath: pair.placement.path,
  action: 'skipped',
  reason: 'fail-fast',
  before: null,
  after: null,
  store: null,
  verify: null,
});

const makeSwapCtx = (
  env: PlacementPorts,
  ledgerPath: string,
  ledger: LedgerModel,
  deps: FlipDeps,
  opts: FlipOptions,
  logicalOperation?: ExecutableOperation,
): SwapCtx => {
  const persistence = createLedgerPersistenceGateway(env, ledgerPath, opts.signal);
  const ctx: SwapCtx = {
    env,
    ledgerPath,
    ledger,
    persist: async () => {
      const written = await persistence.persist(ctx.ledger as LedgerModel);
      if (!written.ok) {
        if (written.error.code === 'cancelled') return err(written.error);
        return err(flipFailedError(`ledger write failed: ${written.error.code}`));
      }
      ctx.ledger = written.value.model;
      return ok(undefined);
    },
    now: () => journalNowOf(env, deps),
    newTxId: () => {
      const candidate = txIdOf(env, deps);
      const model = ctx.ledger as LedgerModel;
      return model.transactions[candidate] !== undefined ||
        model.history.some((journal) => journal.transactionId === candidate)
        ? `transaction:${logicalOperation?.operationId ?? candidate}`
        : candidate;
    },
    pauseAt: opts.testPauseAt,
    signal: opts.signal,
    ...(logicalOperation === undefined ? {} : { logicalOperation }),
  };
  return ctx;
};

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
  env: PlacementPorts,
  deps: FlipDeps,
  tool: FlipTool,
  sourceDir: string,
  opts: FlipOptions,
  requestedMode?: 'static' | 'static+deep',
): Promise<GateOutcome> => {
  if (opts.noVerify) return { blocked: null, gate: 'skipped', verdict: null, notice: null };
  const verification = toolRegistry.get(tool)?.verification;
  if (verification === undefined) {
    return {
      blocked: genericError(`tool registry invariant: ${tool} has no verifier`),
      gate: 'failed',
      verdict: 'fail',
      notice: null,
    };
  }
  const deep = (requestedMode ?? verification.gatePolicy.promote) === 'static+deep';

  const vr = await deps.verify(env, {
    path: sourceDir,
    tools: [tool],
    deep,
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
  env: PlacementPorts,
  ledger: LedgerModel,
  ledgerPath: string,
  pair: PairPlan,
  opts: FlipOptions,
  deps: FlipDeps,
  logicalOperation: ExecutableOperation,
): Promise<FlipResult> => {
  const { skill, tool, scopeKey, placement, notices } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  let currentLedger = ledger;
  const existing = getLedgerPairAt(currentLedger, scopeKey, skill, tool);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    if (existing.journal.op === 'promote') {
      const swapCtx = makeSwapCtx(env, ledgerPath, currentLedger, deps, opts, logicalOperation);
      const resumed = await resumeSwap(swapCtx, skill, tool, scopeKey);
      if (!resumed.ok) return failedResult(base, midSwapError(resumed.error));
      currentLedger = swapCtx.ledger as LedgerModel;
      const after = getLedgerPairAt(currentLedger, scopeKey, skill, tool);
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
      recordedAt: nowOf(env, deps),
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

      const dataDir = resolveDataDir(env, opts.configuration);
      const txId = txIdOf(env, deps);
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
        snapshotAt: nowOf(env, deps),
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
        scopeKey,
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
      const swapCtx = makeSwapCtx(env, ledgerPath, currentLedger, deps, opts, logicalOperation);
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
      scopeKey,
      skillsRoot: dirname(placement.path),
      placementPath: placement.path,
      dev: { sourcePath: devRecord.sourcePath, devRecord },
    };
    // This kind-changing demotion is an internal implementation step of the approved update,
    // not a second planned operation. The final promote swap owns the update's logical journal.
    const toDevCtx = makeSwapCtx(env, ledgerPath, currentLedger, deps, opts);
    const toDevRes = await runSwap(toDevCtx, toDevPlan);
    if (!toDevRes.ok) return failedResult(base, midSwapError(toDevRes.error));
    currentLedger = toDevCtx.ledger as LedgerModel;
    if (toDevRes.value.warning) notesAcc.push(toDevRes.value.warning);
  }

  const dataDir = resolveDataDir(env, opts.configuration);
  const txId = txIdOf(env, deps);
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
    snapshotAt: nowOf(env, deps),
    verify: ledgerVerifyOf(gate.gate),
  };

  const plan: SwapPlan = {
    op: 'promote',
    skill,
    tool,
    scopeKey,
    skillsRoot: dirname(placement.path),
    placementPath: placement.path,
    promote: { storePath: snap.storePath, contentHash: snap.contentHash, pinned, devRecord },
  };
  const swapCtx = makeSwapCtx(env, ledgerPath, currentLedger, deps, opts, logicalOperation);
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
// dev --source: create + adopt (P13). Dev-only records — no journal, no pinned (D3). Write order
// for create is symlink-first (direct atomic no-clobber publish) then ledger, so a crash between the
// two leaves state S2, which a re-run adopts and converges. (Design evolved at adversarial review:
// direct EEXIST publish replaces the earlier staged-rename — it eliminates the staging-orphan class;
// convergence semantics are unchanged.)
// ---------------------------------------------------------------------------------------------

/** BF-3: canonicalize a path for source-equality comparison. `resolve` makes it absolute and folds
 *  `.`/`..`/trailing slashes; `realpath` additionally follows symlink chains and normalizes
 *  platform quirks (macOS `/var` → `/private/var`, case-folding). A not-yet-existing path has no
 *  realpath, so we fall back to the resolved (lexically normalized) form — still trailing-slash- and
 *  `..`-tolerant. */
const canonicalizePath = async (env: PlacementPorts, cwd: string, p: string): Promise<string> => {
  const abs = resolve(cwd, p);
  try {
    return await env.realpath(abs);
  } catch {
    return abs;
  }
};

/** BF-3: are two paths the same location? Resolved + realpath'd on BOTH sides, so a trailing slash,
 *  a `..` segment, a symlinked tmp dir (/var vs /private/var), or a symlink chain no longer produces
 *  a false mismatch. Used by S2/S4/S5b in the real AND dry-run paths. */
const samePath = async (env: PlacementPorts, cwd: string, a: string, b: string): Promise<boolean> =>
  (await canonicalizePath(env, cwd, a)) === (await canonicalizePath(env, cwd, b));

/** Resolve the source used to validate/probe a dev flip without changing the literal symlink
 * payload. A recorded `sourcePath` may intentionally be relative to the placement directory, so
 * source-less demotion must use the absolute `resolvedPath` captured at promotion time (#10).
 * Explicit `--source` remains relative to the caller's cwd by CLI contract. */
const resolveDevSource = (
  opts: FlipOptions,
  sourcePath: string,
  recordedResolved: string | null,
): string =>
  opts.source === undefined && recordedResolved !== null
    ? recordedResolved
    : resolve(opts.cwd, sourcePath);

/** BF-6 / R4: a usable `SKILL.md` is a regular FILE *after following symlinks* — a directory named
 *  `SKILL.md` is still rejected (BF-6), but a `SKILL.md` that is a symlink to a regular file is now
 *  accepted (R4: the PRD only requires the source "contains SKILL.md"; the pre-fix `pathKind==='file'`
 *  lstat rejected the symlink case). `env.fileExists` (a follow-`stat`) can't be used alone — it would
 *  also accept a directory. So: a plain regular file passes directly; a symlink is followed via
 *  `realpath` and accepted only when its ultimate target is a regular file (a dangling link or a
 *  symlink-to-directory is rejected). Shared by create/adopt and their dry-run predictions so the two
 *  never diverge. */
const sourceHasSkillMd = async (env: PlacementPorts, sourceDir: string): Promise<boolean> => {
  const p = join(sourceDir, 'SKILL.md');
  const kind = await env.pathKind(p);
  if (kind === 'file') return true;
  if (kind !== 'symlink') return false; // 'dir' (BF-6) or 'absent'
  try {
    return (await env.pathKind(await env.realpath(p))) === 'file';
  } catch {
    return false; // dangling symlink
  }
};

/** Provenance-enriched dev record for a create/adopt. `sourcePath` and `resolvedPath` are BOTH the
 *  ABSOLUTE resolved source (PRD: never record a relative source — sidesteps #10 for new records). */
const buildDevSourceRecord = async (
  env: PlacementPorts,
  resolvedSourceDir: string,
  deps: FlipDeps,
): Promise<DevRecord> => {
  const provRes = await resolveProvenance(env, resolvedSourceDir);
  return {
    sourcePath: resolvedSourceDir,
    resolvedPath: resolvedSourceDir,
    repoRoot: provRes.ok ? provRes.value.repoRoot : null,
    sourceRelPath: provRes.ok ? provRes.value.sourceRelPath : null,
    remote: provRes.ok ? provRes.value.remote : null,
    recordedAt: nowOf(env, deps),
  };
};

/** S1/S2 warning (not a refusal): the source directory's basename differs from the placement name. */
const basenameNotice = (resolvedSourceDir: string, skill: string): string | null =>
  basename(resolvedSourceDir) !== skill
    ? `source basename '${basename(resolvedSourceDir)}' does not match placement name '${skill}'`
    : null;

const gateFailedResult = (base: Base, gate: GateOutcome): FlipResult => ({
  ...base,
  action: 'failed',
  reason: gate.blocked ? errMessage(gate.blocked) : 'verify gate failed',
  before: null,
  after: null,
  store: null,
  verify: { gate: gate.gate, verdict: gate.verdict },
  ...(gate.blocked ? { error: gate.blocked } : {}),
});

const combineNotes = (...notes: (string | null)[]): string | null => {
  const kept = notes.filter((n): n is string => Boolean(n));
  return kept.length > 0 ? kept.join('; ') : null;
};

/** S1: absent placement -> validate source -> static verify gate -> direct atomic no-clobber symlink
 *  publish -> dev record. A foreign real file already occupying the placement path (S6) refuses. */
const createDevPlacement = async (
  env: PlacementPorts,
  ledger: LedgerModel,
  ledgerPath: string,
  base: Base,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null,
  live: string,
  source: string,
  opts: FlipOptions,
  deps: FlipDeps,
  logicalOperation: ExecutableOperation,
): Promise<FlipResult> => {
  // BF-5(e): a stale ledger pair (a lingering managed record whose live placement is gone) is the
  // lifecycle source of truth — never silently overwrite it with a fresh dev-only create. The user
  // must `uninstall` the record first.
  if (getLedgerPairAt(ledger, scopeKey, skill, tool) !== null) {
    const reason = `refusing to create '${skill}' (${tool}): a skillsmith record already exists — remove it first with 'skillsmith uninstall ${skill}'`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  let liveKind: PathKind;
  try {
    liveKind = await env.pathKind(live);
  } catch (e) {
    return failedResult(base, flipFailedError(`cannot probe ${live}: ${errorMessage(e)}`));
  }
  // A real dir classifies as 'pinned' upstream, so 'absent' here is either truly absent or a file.
  if (liveKind !== 'absent') {
    const reason = `refusing to create '${skill}' (${tool}): a foreign ${liveKind} already exists at ${live}`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  const resolvedSourceDir = resolve(opts.cwd, source);
  if (!(await sourceHasSkillMd(env, resolvedSourceDir))) {
    const reason = `--source '${source}' does not contain SKILL.md`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  const gate = await runVerifyGate(env, deps, tool, resolvedSourceDir, opts, 'static');
  if (gate.blocked) return gateFailedResult(base, gate);

  const devRecord = await buildDevSourceRecord(env, resolvedSourceDir, deps);

  const skillsRoot = dirname(live);
  try {
    await env.makeDir(skillsRoot);
    await sweepOwnStaging(env, skillsRoot, skill);
    // BF-5(a): no-replace publish. Create the symlink DIRECTLY at the final path — `makeSymlink`
    // fails atomically with EEXIST if anything appeared at `live` after the absent-check above (a
    // concurrent create), so a replacing `rename` can never clobber a live artifact. Symlink
    // creation is itself atomic, so no staging indirection is needed for crash safety: a crash
    // before this leaves `absent`, a crash after leaves S2 (symlink live, no record) — a re-run
    // adopts and converges (D3).
    await env.makeSymlink(resolvedSourceDir, live);
    await env.fsyncDir(skillsRoot);
  } catch (e) {
    if (isEexist(e)) {
      const reason = `refusing to create '${skill}' (${tool}): a placement appeared at ${live} concurrently`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    return failedResult(base, flipFailedError(`cannot create '${skill}': ${errorMessage(e)}`));
  }

  // P13 dev-only record shape (BF-2): OMIT `pinned` and `journal` keys entirely — not explicit
  // nulls — so `Object.hasOwn(record, 'pinned')` is false and every nullish-safe reader treats the
  // pair as having no pinned/journal state.
  const pairRecord: PairRecord = {
    placementPath: live,
    mode: 'dev',
    dev: devRecord,
  };
  const committed = await commitRecordOnlyLogicalTransaction(
    makeSwapCtx(env, ledgerPath, ledger, deps, opts, logicalOperation),
    logicalOperation,
    pairRecord,
    scopeKey,
  );
  if (!committed.ok) return failedResult(base, midSwapError(committed.error));

  return {
    ...base,
    action: 'created',
    reason: combineNotes(basenameNotice(resolvedSourceDir, skill), gate.notice),
    before: null,
    after: { mode: 'dev', symlinkTarget: resolvedSourceDir },
    store: null,
    verify: { gate: gate.gate, verdict: gate.verdict },
  };
};

/** S2: a matching hand-made symlink not in the ledger -> record-only adopt. Disk is untouched;
 *  the gate still runs (D2). */
const adoptDevPlacement = async (
  env: PlacementPorts,
  ledger: LedgerModel,
  ledgerPath: string,
  base: Base,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null,
  live: string,
  resolvedSourceDir: string,
  opts: FlipOptions,
  deps: FlipDeps,
  logicalOperation: ExecutableOperation,
): Promise<FlipResult> => {
  if (!(await sourceHasSkillMd(env, resolvedSourceDir))) {
    const reason = `--source '${opts.source ?? resolvedSourceDir}' does not contain SKILL.md`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  const gate = await runVerifyGate(env, deps, tool, resolvedSourceDir, opts, 'static');
  if (gate.blocked) return gateFailedResult(base, gate);

  // R1: collect provenance FIRST — its async git work is the widest classify->act window. The record
  // content derives purely from `--source` (never the live link), so building it early is safe and
  // moves the wide async gap OUT from between the live re-read and the ledger write.
  const devRecord = await buildDevSourceRecord(env, resolvedSourceDir, deps);

  // BF-5(b)/R1: re-read the LIVE symlink immediately before recording — AFTER provenance, so a
  // concurrent retarget that lands during provenance collection is still observed here. A mismatch
  // refuses rather than record source A while the disk points at B.
  let literalNow: string;
  try {
    literalNow = await env.readLink(live);
  } catch (e) {
    return failedResult(base, flipFailedError(`cannot re-read ${live}: ${errorMessage(e)}`));
  }
  const resolvedNow = resolveSymlinkAbsolute(live, literalNow);
  // R1 (final window): from this final readLink to setPair the invariant is "record exactly what was
  // read" — `live` and its captured target are NEVER touched on the filesystem again. The check
  // compares the CAPTURED target STRING against the resolved source canonicalized LEXICALLY (`resolve`
  // folds `.`/`..`/trailing slashes; no realpath). A fresh realpath here would re-dereference the
  // live-derived path and open a retarget window: the pre-fix `samePath` trusted that realpath and
  // could record the source while the disk pointed elsewhere (a mix). Post-final-read TOCTOU is out of
  // scope BY CONSTRUCTION — a retarget landing after this read is indistinguishable from one committed
  // just after setPair, and doctor parity reconciles the drift.
  if (resolve(opts.cwd, resolvedNow) !== resolve(opts.cwd, resolvedSourceDir)) {
    const reason = `refusing to adopt '${skill}' (${tool}): the live symlink now points to ${resolvedNow}, not --source ${resolvedSourceDir}`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  // Dev-only record shape (BF-2): OMIT `pinned` and `journal` keys entirely.
  const pairRecord: PairRecord = {
    placementPath: live,
    mode: 'dev',
    dev: devRecord,
  };
  const committed = await commitRecordOnlyLogicalTransaction(
    makeSwapCtx(env, ledgerPath, ledger, deps, opts, logicalOperation),
    logicalOperation,
    pairRecord,
    scopeKey,
  );
  if (!committed.ok) return failedResult(base, midSwapError(committed.error));

  return {
    ...base,
    action: 'adopted',
    reason: combineNotes(basenameNotice(resolvedSourceDir, skill), gate.notice),
    before: { mode: 'dev', symlinkTarget: resolvedSourceDir },
    after: { mode: 'dev', symlinkTarget: resolvedSourceDir },
    store: null,
    verify: { gate: gate.gate, verdict: gate.verdict },
  };
};

// ---------------------------------------------------------------------------------------------
// dev (real)
// ---------------------------------------------------------------------------------------------

const runDevPair = async (
  env: PlacementPorts,
  ledger: LedgerModel,
  ledgerPath: string,
  pair: PairPlan,
  opts: FlipOptions,
  deps: FlipDeps,
  logicalOperation: ExecutableOperation,
): Promise<FlipResult> => {
  const { skill, tool, scopeKey, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getLedgerPairAt(ledger, scopeKey, skill, tool);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    if (existing.journal.op === 'dev') {
      const swapCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts, logicalOperation);
      const resumed = await resumeSwap(swapCtx, skill, tool, scopeKey);
      if (!resumed.ok) return failedResult(base, midSwapError(resumed.error));
      const after = getLedgerPairAt(swapCtx.ledger as LedgerModel, scopeKey, skill, tool);
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

  // P13 S1 create / S6 foreign-object refusal: an absent placement only reaches the run layer when
  // `--source` is present (plan.ts routes it). Without a source there is nothing to create.
  if (placement.class === 'absent') {
    if (opts.source === undefined) {
      const reason = 'no recorded dev source; pass --source <path>';
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    return createDevPlacement(
      env,
      ledger,
      ledgerPath,
      base,
      skill,
      tool,
      scopeKey,
      placement.path,
      opts.source,
      opts,
      deps,
      logicalOperation,
    );
  }

  // P13 S2/S3/S4: an existing dev symlink under `--source`. Without a source this stays the P12
  // "already in dev mode" no-op.
  if (placement.class === 'dev') {
    if (opts.source === undefined) return noopResult(base, null);
    const resolvedSourceDir = resolve(opts.cwd, opts.source);
    const literal = placement.symlinkTarget;
    const resolvedLink = literal !== null ? resolveSymlinkAbsolute(placement.path, literal) : null;
    // BF-3: canonical comparison (realpath both sides) — a trailing slash, `..`, symlink chain, or
    // /var vs /private/var no longer produces a false S4 mismatch.
    const linkMatches =
      resolvedLink !== null && (await samePath(env, opts.cwd, resolvedLink, resolvedSourceDir));
    if (!linkMatches) {
      // S4: never silently repoint an existing dev symlink.
      const reason = `existing dev symlink for '${skill}' (${tool}) points to ${resolvedLink ?? '<unknown>'}, not --source ${resolvedSourceDir}`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    // BF-5(c)/(d): S3 no-op only when the ledger pair genuinely records THIS source in dev mode; S2
    // adopt only when the pair is GENUINELY absent. Any other existing record (e.g. a pinned/origin
    // pair whose live symlink was manually replaced) must refuse — adopting would setPair over it and
    // silently discard the retained pin.
    if (existing !== null) {
      if (
        existing.mode === 'dev' &&
        existing.dev != null &&
        (await samePath(env, opts.cwd, existing.dev.resolvedPath, resolvedSourceDir))
      ) {
        return noopResult(base, null); // S3
      }
      const reason = `refusing to adopt '${skill}' (${tool}): a conflicting skillsmith record already exists for this placement — resolve it with 'skillsmith uninstall' or 'promote'/'dev --rollback' first`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    return adoptDevPlacement(
      env,
      ledger,
      ledgerPath,
      base,
      skill,
      tool,
      scopeKey,
      placement.path,
      resolvedSourceDir,
      opts,
      deps,
      logicalOperation,
    );
  }

  // BF-4: a real dir (class 'pinned') that is neither a skill (no usable SKILL.md) nor
  // skillsmith-managed (no ledger pair) is a FOREIGN object — refuse (S6), never hand-copy-flip it
  // into a dev symlink. A genuine hand-copied skill (has SKILL.md) keeps its P12 flip behavior; a
  // managed pinned pair (has a ledger record) keeps its lifecycle.
  if (placement.class === 'pinned' && existing === null) {
    const placementHasSkillMd = (await env.pathKind(join(placement.path, 'SKILL.md'))) === 'file';
    if (!placementHasSkillMd) {
      const reason = `refusing to flip '${skill}' (${tool}): ${placement.path} is a foreign directory (no SKILL.md, no skillsmith record)`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
  }

  const recordedSource = existing?.dev?.sourcePath ?? null;
  const recordedResolved = existing?.dev?.resolvedPath ?? null;
  const source = opts.source ?? recordedSource;
  // BF-3: S5b compares --source against the recorded RESOLVED (absolute) path via the canonical
  // helper — a relative P12-adoption record resolved against a different cwd no longer falsely
  // mismatches, nor does a trailing slash / symlink chain.
  const updatedRecord =
    opts.source !== undefined &&
    recordedResolved !== null &&
    !(await samePath(env, opts.cwd, opts.source, recordedResolved));

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

  // PRD S5b (behavior change from P12): for a pinned/store-linked pair, a --source that disagrees
  // with the RECORDED dev source now REFUSES rather than silently repointing the record.
  if (updatedRecord) {
    const reason = `refusing to redirect '${skill}' (${tool}): --source ${resolve(opts.cwd, opts.source ?? '')} disagrees with the recorded dev source ${recordedResolved}`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }

  const resolvedSourceDir = resolveDevSource(opts, source, recordedResolved);
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
    recordedAt: nowOf(env, deps),
  };

  const plan: SwapPlan = {
    op: 'dev',
    skill,
    tool,
    scopeKey,
    skillsRoot: dirname(placement.path),
    placementPath: placement.path,
    dev: { sourcePath: source, devRecord },
  };
  const swapCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts, logicalOperation);
  const swapRes = await runSwap(swapCtx, plan);
  if (!swapRes.ok) return failedResult(base, midSwapError(swapRes.error));

  // `updatedRecord` no longer reaches here — S5b refuses a recorded-source disagreement above.
  const notesAcc: string[] = [];
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
  env: PlacementPorts,
  ledger: LedgerModel,
  ledgerPath: string,
  pair: PairPlan,
  opts: FlipOptions,
  deps: FlipDeps,
  logicalOperation: ExecutableOperation,
): Promise<FlipResult> => {
  const { skill, tool, scopeKey, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getLedgerPairAt(ledger, scopeKey, skill, tool);
  const swapCtx = makeSwapCtx(env, ledgerPath, ledger, deps, opts, logicalOperation);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    // Captured BEFORE the call: `rollbackSwap` mutates this same pair record in place (nulls
    // `.journal` on success), so reading `existing.journal` afterward would see the post-mutation
    // state, not the journal that was actually rolled back.
    const journalOp = existing.journal.op;
    const journalBeforeMode = existing.journal.before.mode;
    const rb = await rollbackSwap(swapCtx, skill, tool, scopeKey);
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
      scopeKey,
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
      recordedAt: nowOf(env, deps),
    } satisfies DevRecord);
  const plan: SwapPlan = {
    op: 'promote',
    rollbackOf: 'dev',
    skill,
    tool,
    scopeKey,
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
  const { skill, tool, scopeKey, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getPairAt(ledger, scopeKey, skill, tool);
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
  env: PlacementPorts,
  ledger: LedgerFile,
  op: 'promote' | 'dev',
  pair: PairPlan,
  opts: FlipOptions,
): Promise<FlipResult> => {
  const { skill, tool, scopeKey, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getPairAt(ledger, scopeKey, skill, tool);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    if (existing.journal.op === op) {
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
        const reason = `refusing to promote '${skill}': the source tree is dirty.\n${provenance.dirtySummary ?? ''}\nCommit the changes, or pass --allow-dirty to snapshot as dirty-<hash>.`;
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
        const reason = `refusing to promote '${skill}': the source tree is dirty.\n${provenance.dirtySummary ?? ''}\nCommit the changes, or pass --allow-dirty to snapshot as dirty-<hash>.`;
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
      const reason = `refusing to promote '${skill}': the source tree is dirty.\n${provRes.value.dirtySummary ?? ''}\nCommit the changes, or pass --allow-dirty to snapshot as dirty-<hash>.`;
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
  // P13 S1 create / S6 foreign-object (dry-run predicts without writing). BF-6: the prediction runs
  // the SAME structural source validation as the real path (dir + `pathKind(SKILL.md)==='file'`), so
  // dry-run never reports `created`/`adopted` for a source the real run would refuse. Only the
  // external verify GATE is skipped in dry-run (documented — it needs network/tool auth).
  if (placement.class === 'absent') {
    if (opts.source === undefined) {
      const reason = 'no recorded dev source; pass --source <path>';
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    // BF-5(e): a stale ledger pair would make the real create refuse — mirror it here.
    if (existing !== null) {
      const reason = `refusing to create '${skill}' (${tool}): a skillsmith record already exists — remove it first with 'skillsmith uninstall ${skill}'`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    const liveKind = await env.pathKind(placement.path);
    if (liveKind !== 'absent') {
      const reason = `refusing to create '${skill}' (${tool}): a foreign ${liveKind} already exists at ${placement.path}`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    const resolvedSourceDir = resolve(opts.cwd, opts.source);
    if (!(await sourceHasSkillMd(env, resolvedSourceDir))) {
      const reason = `--source '${opts.source}' does not contain SKILL.md`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    return {
      ...base,
      action: 'created',
      reason: null,
      before: null,
      after: null,
      store: null,
      verify: null,
    };
  }

  // P13 S2/S3/S4 (dry-run) for an existing dev symlink under --source.
  if (placement.class === 'dev') {
    if (opts.source === undefined) return noopResult(base, null);
    const resolvedSourceDir = resolve(opts.cwd, opts.source);
    const literal = placement.symlinkTarget;
    const resolvedLink = literal !== null ? resolveSymlinkAbsolute(placement.path, literal) : null;
    const linkMatches =
      resolvedLink !== null && (await samePath(env, opts.cwd, resolvedLink, resolvedSourceDir));
    if (!linkMatches) {
      const reason = `existing dev symlink for '${skill}' (${tool}) points to ${resolvedLink ?? '<unknown>'}, not --source ${resolvedSourceDir}`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    // BF-5(c)/(d): S3 only on genuine agreement; any other existing record refuses; S2 adopt only
    // when the pair is genuinely absent (and its source has a SKILL.md — BF-6).
    if (existing !== null) {
      if (
        existing.mode === 'dev' &&
        existing.dev != null &&
        (await samePath(env, opts.cwd, existing.dev.resolvedPath, resolvedSourceDir))
      ) {
        return noopResult(base, null);
      }
      const reason = `refusing to adopt '${skill}' (${tool}): a conflicting skillsmith record already exists for this placement`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    if (!(await sourceHasSkillMd(env, resolvedSourceDir))) {
      const reason = `--source '${opts.source}' does not contain SKILL.md`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
    return {
      ...base,
      action: 'adopted',
      reason: null,
      before: null,
      after: null,
      store: null,
      verify: null,
    };
  }

  // BF-4 (dry-run mirror): a foreign real dir (no SKILL.md, no ledger pair) refuses, matching the
  // real path — dry-run must not predict a flip the real run would reject.
  if (placement.class === 'pinned' && existing === null) {
    const placementHasSkillMd = (await env.pathKind(join(placement.path, 'SKILL.md'))) === 'file';
    if (!placementHasSkillMd) {
      const reason = `refusing to flip '${skill}' (${tool}): ${placement.path} is a foreign directory (no SKILL.md, no skillsmith record)`;
      return refusedResult(base, reason, flipRefusedError(reason));
    }
  }

  const recordedSource = existing?.dev?.sourcePath ?? null;
  const recordedResolved = existing?.dev?.resolvedPath ?? null;
  const source = opts.source ?? recordedSource;
  // PRD S5b (dry-run mirror, BF-3): compare against the recorded RESOLVED path via the canonical
  // helper, not a lexical string compare.
  if (
    opts.source !== undefined &&
    recordedResolved !== null &&
    !(await samePath(env, opts.cwd, opts.source, recordedResolved))
  ) {
    const reason = `refusing to redirect '${skill}' (${tool}): --source ${resolve(opts.cwd, opts.source)} disagrees with the recorded dev source ${recordedResolved}`;
    return refusedResult(base, reason, flipRefusedError(reason));
  }
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
  const resolvedSourceDir = resolveDevSource(opts, source, recordedResolved);
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
  created: 0,
  adopted: 0,
});

const ACTION_TO_SUMMARY_KEY: Record<FlipAction, keyof FlipReport['summary']> = {
  flipped: 'flipped',
  updated: 'updated',
  noop: 'noop',
  skipped: 'skipped',
  refused: 'refused',
  failed: 'failed',
  'rolled-back': 'rolledBack',
  created: 'created',
  adopted: 'adopted',
};

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}` as const;

const selectionSourceOf = (opts: FlipOptions): 'explicit-targets' | 'explicit-all' =>
  opts.selectionSource ?? (opts.all ? 'explicit-all' : 'explicit-targets');

const liveResourceOf = (pair: PairPlan) => ({
  kind: 'live' as const,
  skill: pair.skill,
  tool: pair.tool,
  scope: pair.scope,
  projectRoot:
    pair.scopeKey === null
      ? null
      : ({ kind: 'machine-bound' as const, path: pair.scopeKey } as const),
  location: { kind: 'machine-bound' as const, path: pair.placement.path },
});

const placementImageOf = (
  pair: PairPlan,
  mode: 'dev' | 'pinned',
  linkTarget: string | null,
  contentHash: `sha256:${string}` | null,
  sourcePath: string | null = null,
): OperationImage => ({
  kind: 'placement',
  resource: liveResourceOf(pair),
  classification: mode,
  representation: mode === 'dev' ? 'symlink' : 'copy',
  linkTarget: linkTarget === null ? null : { kind: 'machine-bound' as const, path: linkTarget },
  dangling: false,
  source:
    contentHash === null || sourcePath === null
      ? null
      : { kind: 'local-dev', path: sourcePath, contentHash },
  contentHash,
});

const currentRollbackImageOf = (
  pair: PairPlan,
  source: Extract<OperationSource, { kind: 'local-dev' }> | null,
): OperationImage => {
  if (pair.placement.class === 'absent') {
    return { kind: 'absent', resource: liveResourceOf(pair) };
  }
  const symlink = pair.placement.class === 'dev' || pair.placement.class === 'store-linked';
  return {
    kind: 'placement',
    resource: liveResourceOf(pair),
    classification: pair.placement.class,
    representation: symlink ? 'symlink' : 'copy',
    linkTarget:
      symlink && pair.placement.symlinkTarget !== null
        ? { kind: 'machine-bound', path: pair.placement.symlinkTarget }
        : null,
    dangling: pair.placement.dangling,
    source,
    contentHash: source?.contentHash ?? null,
  };
};

const journalBeforeImageOf = (pair: PairPlan, before: Journal['before']): OperationImage => {
  if (before.mode === 'absent') {
    return { kind: 'absent', resource: liveResourceOf(pair) };
  }
  const representation = before.liveKind === 'dir' ? 'copy' : 'symlink';
  const linkTarget =
    before.mode === 'dev'
      ? before.symlinkTarget
      : before.symlinkTarget === undefined
        ? null
        : before.symlinkTarget;
  return {
    kind: 'placement',
    resource: liveResourceOf(pair),
    classification: before.mode,
    representation,
    linkTarget: linkTarget === null ? null : { kind: 'machine-bound', path: linkTarget },
    dangling: false,
    source: null,
    contentHash: null,
  };
};

const beforeImageOf = (pair: PairPlan): OperationImage => {
  if (pair.placement.class === 'absent') {
    return { kind: 'absent', resource: liveResourceOf(pair) };
  }
  if (pair.placement.class === 'dev') {
    return placementImageOf(pair, 'dev', pair.placement.symlinkTarget, null);
  }
  return placementImageOf(pair, 'pinned', null, null);
};

const unmanagedBeforeImageOf = (pair: PairPlan): OperationImage => ({
  kind: 'placement',
  resource: liveResourceOf(pair),
  classification: 'unmanaged',
  representation: pair.placement.class === 'dev' ? 'symlink' : 'other',
  linkTarget:
    pair.placement.class === 'dev' && pair.placement.symlinkTarget !== null
      ? { kind: 'machine-bound', path: pair.placement.symlinkTarget }
      : null,
  dangling: pair.placement.class === 'dev' && pair.placement.dangling,
  source: null,
  contentHash: null,
});

const resultForPair = (results: readonly FlipResult[], pair: PairPlan): FlipResult | undefined => {
  for (let index = results.length - 1; index >= 0; index--) {
    const result = results[index];
    if (
      result?.skill === pair.skill &&
      result.tool === pair.tool &&
      result.placementPath === pair.placement.path
    ) {
      return result;
    }
  }
  return undefined;
};

const digestForPair = async (
  env: PlacementPorts,
  ledger: LedgerFile,
  pair: PairPlan,
): Promise<`sha256:${string}` | null> => {
  const recorded = getPairAt(ledger, pair.scopeKey, pair.skill, pair.tool);
  if (recorded?.pinned?.contentHash?.startsWith('sha256:')) {
    return recorded.pinned.contentHash as `sha256:${string}`;
  }
  const source =
    pair.placement.class === 'dev' && pair.placement.symlinkTarget !== null
      ? resolveSymlinkAbsolute(pair.placement.path, pair.placement.symlinkTarget)
      : recorded?.dev?.resolvedPath;
  if (source === undefined) return null;
  const hashed = await contentHashOf(env, source);
  return hashed.ok ? (hashed.value as `sha256:${string}`) : null;
};

const devOperationSourceOf = async (
  env: PlacementPorts,
  ledger: LedgerFile,
  pair: PairPlan,
  opts: FlipOptions,
): Promise<Extract<OperationSource, { kind: 'local-dev' }> | null> => {
  const current = getPairAt(ledger, pair.scopeKey, pair.skill, pair.tool);
  const path =
    opts.source !== undefined
      ? resolve(opts.cwd, opts.source)
      : (current?.dev?.resolvedPath ??
        (pair.placement.class === 'dev' && pair.placement.symlinkTarget !== null
          ? resolveSymlinkAbsolute(pair.placement.path, pair.placement.symlinkTarget)
          : null));
  if (path === null) return null;
  const hashed = await contentHashOf(env, path);
  return hashed.ok
    ? { kind: 'local-dev', path, contentHash: hashed.value as `sha256:${string}` }
    : null;
};

const canonicalLeafPath = async (env: PlacementPorts, cwd: string, path: string): Promise<string> =>
  join(await canonicalizePath(env, cwd, dirname(path)), basename(path));

const pairRecordSnapshot = (record: ReturnType<typeof getPairAt>): unknown => {
  if (record === null) return null;
  return {
    placementPath: record.placementPath,
    mode: record.mode,
    dev:
      record.dev === null
        ? null
        : {
            sourcePath: record.dev.sourcePath,
            resolvedPath: record.dev.resolvedPath,
            repoRoot: record.dev.repoRoot,
            sourceRelPath: record.dev.sourceRelPath,
            remote: record.dev.remote,
            recordedAt: record.dev.recordedAt,
          },
    pinned:
      record.pinned == null
        ? null
        : {
            storePath: record.pinned.storePath,
            rev: record.pinned.rev,
            gitSha: record.pinned.gitSha,
            dirty: record.pinned.dirty,
            contentHash: record.pinned.contentHash,
            snapshotAt: record.pinned.snapshotAt,
            verify: record.pinned.verify,
            placement: record.pinned.placement ?? null,
          },
    origin:
      record.origin === undefined
        ? null
        : {
            source: record.origin.source,
            host: record.origin.host,
            repo: record.origin.repo,
            skillPath: record.origin.skillPath,
            refRequested: record.origin.refRequested,
            refResolved: record.origin.refResolved,
            pin: record.origin.pin,
            installedAt: record.origin.installedAt,
          },
    journal:
      record.journal == null
        ? null
        : {
            op: record.journal.op,
            txId: record.journal.txId,
            phase: record.journal.phase,
            startedAt: record.journal.startedAt,
            completedAt: record.journal.completedAt,
            before: structuredClone(record.journal.before),
            stagingPath: record.journal.stagingPath,
            backupPath: record.journal.backupPath,
          },
  };
};

const capturePathIdentity = async (
  env: PlacementPorts,
  cwd: string,
  path: string | null,
): Promise<unknown> => {
  if (path === null) return null;
  const pathKind = await env.pathKind(path);
  const symlinkTarget = pathKind === 'symlink' ? await env.readLink(path) : null;
  const canonicalPath =
    pathKind === 'absent' ? resolve(cwd, path) : await canonicalizePath(env, cwd, path);
  let hashable = pathKind === 'dir';
  if (pathKind === 'symlink') {
    try {
      hashable = (await env.pathKind(canonicalPath)) === 'dir';
    } catch {
      hashable = false;
    }
  }
  let contentHash: string | null = null;
  if (hashable) {
    const hashed = await contentHashOf(env, path);
    if (!hashed.ok) throw hashed.error;
    contentHash = hashed.value;
  }
  return { path, canonicalPath, pathKind, symlinkTarget, contentHash };
};

const sourcePathForBinding = (
  command: 'promote' | 'dev',
  pair: PairPlan,
  current: ReturnType<typeof getPairAt>,
  opts: FlipOptions,
): string | null => {
  if (opts.source !== undefined) return resolve(opts.cwd, opts.source);
  if (current?.dev?.resolvedPath) return current.dev.resolvedPath;
  if (pair.placement.class === 'dev' && pair.placement.symlinkTarget !== null) {
    return resolveSymlinkAbsolute(pair.placement.path, pair.placement.symlinkTarget);
  }
  return command === 'dev' ? (current?.dev?.sourcePath ?? null) : null;
};

interface FlipFactIdentity {
  readonly command: 'promote' | 'dev';
  readonly reportOp: FlipOp;
  readonly operationId: string;
  readonly groupId: string;
  readonly pairId: string;
  readonly kind: ExecutableOperation['kind'];
}

const captureFlipFacts = async (
  env: PlacementPorts,
  identity: FlipFactIdentity,
  pair: PairPlan,
  opts: FlipOptions,
  storeRoot: string,
  ledger: LedgerFile,
): Promise<unknown> => {
  const current = getPairAt(ledger, pair.scopeKey, pair.skill, pair.tool);
  const placement = await classifyPlacement(env, pair.placement.root, pair.skill, storeRoot);
  const livePathKind = await env.pathKind(pair.placement.path);
  const liveContent =
    livePathKind === 'dir' ? await capturePathIdentity(env, opts.cwd, pair.placement.path) : null;
  const sourcePath = sourcePathForBinding(identity.command, pair, current, opts);
  const sourceIdentity = await capturePathIdentity(env, opts.cwd, sourcePath);
  let sourceProvenance: Provenance | null = null;
  if (sourcePath !== null && (await env.pathKind(sourcePath)) !== 'absent') {
    const provenance = await resolveProvenance(env, sourcePath);
    if (!provenance.ok) throw provenance.error;
    sourceProvenance = provenance.value;
  }
  const storePath = current?.pinned?.storePath ?? null;
  const journal = current?.journal ?? null;
  return {
    ...identity,
    skill: pair.skill,
    tool: pair.tool,
    scope: pair.scope,
    scopeKey: pair.scopeKey,
    projectRoot:
      opts.projectRoot == null
        ? null
        : {
            path: opts.projectRoot,
            canonicalPath: await canonicalizePath(env, opts.cwd, opts.projectRoot),
          },
    ledger: { pair: pairRecordSnapshot(current) },
    live: {
      path: pair.placement.path,
      canonicalPath: await canonicalLeafPath(env, opts.cwd, pair.placement.path),
      pathKind: livePathKind,
      classification: placement.class,
      symlinkTarget: placement.symlinkTarget,
      dangling: placement.dangling,
      content: liveContent,
    },
    source: { identity: sourceIdentity, provenance: sourceProvenance },
    store: await capturePathIdentity(env, opts.cwd, storePath),
    recovery: {
      staging: await capturePathIdentity(env, opts.cwd, journal?.stagingPath ?? null),
      backup: await capturePathIdentity(env, opts.cwd, journal?.backupPath ?? null),
    },
  };
};

interface PreparedPairFlipBinding {
  readonly kind: 'pair';
  readonly operationId: string;
  readonly pair: PairPlan;
  readonly expectedFacts: unknown;
}

interface PreparedLedgerMigrationBinding {
  readonly kind: 'migrate-ledger';
  readonly operationId: string;
  readonly expectedState: Extract<LedgerReadState, { readonly state: 'present' }>;
}

type PreparedFlipBinding = PreparedPairFlipBinding | PreparedLedgerMigrationBinding;

const createFlipPlanning = async (
  env: PlacementPorts,
  command: 'promote' | 'dev',
  reportOp: FlipOp,
  dryRun: boolean,
  opts: FlipOptions,
  storeRoot: string,
  outcome: FlipPlanOutcome,
  results: readonly FlipResult[],
  ledger: LedgerFile,
  ledgerState: LedgerReadState,
): Promise<
  Readonly<{
    plan: OperationPlan<'dev' | 'promote'>;
    executionResults: readonly OperationExecutionResult[];
    bindings: readonly PreparedFlipBinding[];
    preconditions: readonly ExecutionPrecondition[];
  }>
> => {
  const ledgerPath = ledgerPathOf(resolveDataDir(env, opts.configuration));
  const selectionSource = selectionSourceOf(opts);
  const operations: ExecutableOperation[] = [];
  const checks: PlanCheck[] = [];
  const bindings: PreparedFlipBinding[] = [];
  const preconditions: ExecutionPrecondition[] = [];
  const usedResults = new Set<FlipResult>();

  const migration = prepareLedgerMigration(env, command, selectionSource, ledgerPath, ledgerState);
  if (migration !== null) {
    operations.push(migration.operation);
    preconditions.push(migration.precondition);
    bindings.push({
      kind: 'migrate-ledger',
      operationId: migration.operation.operationId,
      expectedState: migration.expectedState,
    });
  }

  for (const pair of outcome.pairs) {
    const result = resultForPair(results, pair);
    if (result === undefined) continue;
    const current = getPairAt(ledger, pair.scopeKey, pair.skill, pair.tool);
    const retainedCommittedInverse =
      reportOp === 'rollback' &&
      current?.journal?.phase === 'committed' &&
      current.journal.before.mode !== 'absent';
    const executable =
      result.action === 'flipped' ||
      result.action === 'updated' ||
      result.action === 'created' ||
      result.action === 'adopted' ||
      result.action === 'failed' ||
      result.action === 'rolled-back' ||
      retainedCommittedInverse;
    if (!executable) continue;
    usedResults.add(result);

    const rollbackToDev = reportOp === 'rollback' && pair.placement.class !== 'dev';
    const kind: ExecutableOperation['kind'] =
      reportOp === 'rollback'
        ? rollbackToDev
          ? 'link-dev'
          : 'promote'
        : command === 'dev'
          ? 'link-dev'
          : pair.placement.class === 'pinned'
            ? 'update'
            : 'promote';
    const localDevSource = await devOperationSourceOf(env, ledger, pair, opts);
    const digest = localDevSource?.contentHash ?? (await digestForPair(env, ledger, pair));
    const operationSource: OperationSource | null =
      kind === 'link-dev'
        ? localDevSource
        : digest === null
          ? null
          : {
              kind: 'portable',
              identity: {
                host: 'github.com',
                repository: 'local/source',
                path: pair.skill,
              },
              requestedRef: null,
              resolvedSha: '0'.repeat(40),
              sourcePath: pair.skill,
              contentHash: digest,
            };
    const committedForward =
      reportOp === 'rollback' && current?.journal?.phase === 'committed'
        ? ledgerState.state === 'present'
          ? ledgerState.model.history.find(
              (journal) => journal.transactionId === current.journal?.txId,
            )
          : undefined
        : undefined;
    const groupId =
      committedForward?.intent.groupId ??
      createOperationGroupId({
        domain: 'skillsmith.operation-group-identity',
        schemaVersion: 1,
        command,
        skill: pair.skill,
        source: operationSource,
        scope: pair.scope,
        target: null,
      });
    const pairId =
      committedForward?.intent.pairId ??
      createOperationPairId({
        domain: 'skillsmith.operation-pair-identity',
        schemaVersion: 1,
        groupId,
        tool: pair.tool,
        resource: liveResourceOf(pair),
      });
    if (pairId === null) throw new Error('committed placement history has no pair identity');
    const identity = {
      domain: 'skillsmith.operation-identity' as const,
      schemaVersion: 1 as const,
      groupId,
      pairId,
      kind,
      skill: pair.skill,
      source: operationSource,
      tool: pair.tool,
      scope: pair.scope,
    };
    const operationId = createOperationId(identity);
    const desiredDevTarget =
      localDevSource?.path ??
      (result.after?.mode === 'dev'
        ? (result.after.symlinkTarget ?? current?.dev?.sourcePath ?? opts.source ?? null)
        : (current?.dev?.sourcePath ?? opts.source ?? null));
    const promoteSource =
      current?.dev?.resolvedPath ??
      (pair.placement.class === 'dev' && pair.placement.symlinkTarget !== null
        ? resolveSymlinkAbsolute(pair.placement.path, pair.placement.symlinkTarget)
        : null);
    const rollbackCurrentSource =
      reportOp !== 'rollback'
        ? null
        : (localDevSource ??
          (promoteSource === null || digest === null
            ? null
            : { kind: 'local-dev', path: promoteSource, contentHash: digest }));
    const before =
      result.action === 'adopted'
        ? unmanagedBeforeImageOf(pair)
        : reportOp === 'rollback'
          ? currentRollbackImageOf(pair, rollbackCurrentSource)
          : beforeImageOf(pair);
    const after =
      reportOp === 'rollback' && current?.journal != null
        ? journalBeforeImageOf(pair, current.journal.before)
        : kind === 'link-dev'
          ? placementImageOf(
              pair,
              'dev',
              desiredDevTarget,
              reportOp === 'rollback' ? null : (localDevSource?.contentHash ?? null),
              reportOp === 'rollback' ? null : (localDevSource?.path ?? null),
            )
          : reportOp === 'rollback'
            ? placementImageOf(pair, 'pinned', null, null)
            : placementImageOf(pair, 'pinned', null, digest, promoteSource);
    const requiredCheckIds: string[] = [];
    if (reportOp !== 'rollback' && !opts.noVerify) {
      const verification = toolRegistry.get(pair.tool)?.verification;
      if (verification === undefined) {
        throw new Error(`tool registry invariant: ${pair.tool} has no verifier`);
      }
      const verificationMode = command === 'promote' ? verification.gatePolicy.promote : 'static';
      const checkId = createPlanCheckId({
        domain: 'skillsmith.plan-check-identity',
        schemaVersion: 1,
        kind: 'verification',
        operationIds: [operationId],
        tool: pair.tool,
        mode: verificationMode,
        expectedContentHash: digest ?? ZERO_DIGEST,
      });
      requiredCheckIds.push(checkId);
      checks.push({
        checkId,
        blocking: true,
        operationIds: [operationId],
        kind: 'verification',
        tool: pair.tool,
        mode: verificationMode,
        expectedContentHash: digest ?? ZERO_DIGEST,
      });
    }
    const operationWithoutPrecondition = {
      operationId,
      groupId,
      pairId,
      kind,
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
      skill: pair.skill,
      source: operationSource,
      tool: pair.tool,
      scope: pair.scope,
      before,
      after,
      reason:
        reportOp === 'rollback'
          ? { code: 'rollback-inverse', message: `rollback inverse for ${pair.skill}` }
          : { code: kind, message: `${command} ${pair.skill}` },
      selectionSource,
      requiredCheckIds,
      reversibility: { kind: 'conditional', retentionResourceIds: [pairId] },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      conflict: null,
    } as const;
    const factIdentity: FlipFactIdentity = {
      command,
      reportOp,
      operationId,
      groupId,
      pairId,
      kind,
    };
    const expectedFacts = await captureFlipFacts(env, factIdentity, pair, opts, storeRoot, ledger);
    const precondition = createExecutionPrecondition({
      operationIds: [operationId],
      resource: liveResourceOf(pair),
      expected: expectedFacts,
      observe: async () => {
        const currentLedger = await readLedgerState(env, ledgerPath);
        if (!currentLedger.ok) throw currentLedger.error;
        return captureFlipFacts(
          env,
          factIdentity,
          pair,
          opts,
          storeRoot,
          legacyLedgerView(
            ledgerModelForMutation(currentLedger.value, nowOf(env, defaultFlipDeps)),
          ),
        );
      },
    });
    operations.push({
      ...operationWithoutPrecondition,
      preconditionIds: [precondition.preconditionId],
    });
    preconditions.push(precondition);
    bindings.push({
      kind: 'pair',
      operationId,
      pair,
      expectedFacts,
    });
  }

  const diagnostics: PlanningDiagnostic[] = [];
  const diagnosticIds = new Set<string>();
  for (const result of results) {
    if (usedResults.has(result)) continue;
    const pair = outcome.pairs.find(
      (candidate) =>
        candidate.skill === result.skill &&
        candidate.tool === result.tool &&
        candidate.placement.path === result.placementPath,
    );
    const filterNoop =
      result.action === 'skipped' &&
      result.reason === 'no recorded dev source' &&
      Boolean(opts.all);
    const kind =
      result.action === 'noop'
        ? 'noop'
        : result.action === 'skipped'
          ? 'skip'
          : result.action === 'refused' || result.action === 'failed'
            ? 'refuse'
            : 'warning';
    const severity = kind === 'refuse' ? 'error' : kind === 'warning' ? 'warning' : 'info';
    const refusalClass = kind === 'refuse' ? 'state' : null;
    const affectedSource =
      command === 'dev' && pair !== undefined
        ? await devOperationSourceOf(env, ledger, pair, opts)
        : null;
    const affected = {
      skill: result.skill,
      source: affectedSource,
      tool: result.tool,
      scope: pair?.scope ?? opts.scope ?? null,
      path:
        result.placementPath === null
          ? null
          : { kind: 'machine-bound' as const, path: result.placementPath },
    };
    const correlation = { groupId: null, pairId: null, operationId: null };
    const reasonCode = filterNoop ? 'filter-noop' : (result.error?.code ?? kind);
    const diagnosticId = createPlanningDiagnosticId({
      domain: 'skillsmith.planning-diagnostic-identity',
      schemaVersion: 1,
      kind,
      severity,
      refusalClass,
      affected,
      correlation,
      reasonCode,
      selectionSource,
    });
    if (diagnosticIds.has(diagnosticId)) continue;
    diagnosticIds.add(diagnosticId);
    diagnostics.push({
      diagnosticId,
      kind,
      severity,
      refusalClass,
      affected,
      correlation,
      reason: {
        code: reasonCode,
        message: result.reason ?? result.action,
      },
      selectionSource,
    });
  }

  if (operations.length === 0 && diagnostics.length === 0 && opts.all) {
    const affected = {
      skill: null,
      source: null,
      tool: null,
      scope: opts.scope ?? null,
      path: null,
    };
    const correlation = { groupId: null, pairId: null, operationId: null };
    const diagnosticId = createPlanningDiagnosticId({
      domain: 'skillsmith.planning-diagnostic-identity',
      schemaVersion: 1,
      kind: 'noop',
      severity: 'info',
      refusalClass: null,
      affected,
      correlation,
      reasonCode: 'filter-noop',
      selectionSource,
    });
    diagnostics.push({
      diagnosticId,
      kind: 'noop',
      severity: 'info',
      refusalClass: null,
      affected,
      correlation,
      reason: { code: 'filter-noop', message: 'the selected filters matched no eligible work' },
      selectionSource,
    });
  }

  const scopes = [...new Set(outcome.pairs.map((pair) => pair.scope))];
  if (scopes.length === 0 && opts.scope !== undefined) scopes.push(opts.scope);
  const filterNoop =
    operations.length === 0 && diagnostics.some((item) => item.reason.code === 'filter-noop');
  const plan = createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command,
    selection: {
      source: selectionSource,
      outcome: filterNoop ? 'filter-noop' : 'selected',
      targets: [...opts.targets],
      all: Boolean(opts.all),
      tools: opts.tools ? [...opts.tools] : [...FLIP_TOOLS],
      scopes,
      groupIds: [...new Set(operations.map((operation) => operation.groupId))],
    },
    batchPolicy: opts.continueOnError ? 'continue-on-error' : 'fail-fast',
    operations,
    checks,
    diagnostics,
  }) as OperationPlan<'dev' | 'promote'>;
  const executionResults = dryRun
    ? []
    : plan.operations.map((operation) => {
        const pair = outcome.pairs.find(
          (candidate) =>
            candidate.skill === operation.skill &&
            candidate.tool === operation.tool &&
            candidate.scope === operation.scope,
        );
        const result = pair === undefined ? undefined : resultForPair(results, pair);
        const failed = result?.action === 'failed';
        const common = {
          operationId: operation.operationId,
          actualBefore: operation.before,
          actualAfter: operation.after,
          force: null,
        } as const;
        if (failed) {
          return createOperationExecutionResult({
            ...common,
            outcome: 'failed',
            error: {
              code: result.error?.code ?? 'flip-failed',
              message: result.reason ?? 'operation failed',
              remediation: 'Resolve the reported condition and retry the same selection.',
            },
          });
        }
        return createOperationExecutionResult({
          ...common,
          outcome:
            reportOp === 'rollback'
              ? 'rolled-back'
              : result?.reason === 'interrupted'
                ? 'cancelled'
                : 'succeeded',
          error: null,
        });
      });
  return { plan, executionResults, bindings, preconditions };
};

const buildPreparedPreview = async (
  env: PlacementPorts,
  command: 'promote' | 'dev',
  op: FlipOp,
  requested: FlipReport['requested'],
  results: FlipResult[],
  opts: FlipOptions,
  outcome: FlipPlanOutcome,
  ledger: LedgerFile,
  ledgerState: LedgerReadState,
): Promise<
  Readonly<{
    report: FlipReport;
    bindings: readonly PreparedFlipBinding[];
    preconditions: readonly ExecutionPrecondition[];
  }>
> => {
  const summary = emptySummary();
  for (const r of results) summary[ACTION_TO_SUMMARY_KEY[r.action]]++;
  const { plan, executionResults, bindings, preconditions } = await createFlipPlanning(
    env,
    command,
    op,
    true,
    opts,
    storeRootOf(resolveDataDir(env, opts.configuration)),
    outcome,
    results,
    ledger,
    ledgerState,
  );
  return {
    report: { op, dryRun: true, requested, results, summary, plan, executionResults },
    bindings,
    preconditions,
  };
};

type PairProcessor = (
  env: PlacementPorts,
  ledger: LedgerModel,
  ledgerPath: string,
  pair: PairPlan,
  opts: FlipOptions,
  deps: FlipDeps,
  logicalOperation: ExecutableOperation,
) => Promise<FlipResult>;

type PairPredictor = (
  env: PlacementPorts,
  ledger: LedgerFile,
  pair: PairPlan,
  opts: FlipOptions,
) => Promise<FlipResult>;

const normalizeFlipProjectContext = async (
  env: PlacementPorts,
  opts: FlipOptions,
): Promise<FlipOptions> => {
  if (Object.hasOwn(opts, 'projectRoot')) return opts;
  if (opts.scope === 'user') return { ...opts, projectRoot: null };
  let projectRoot: string | null;
  try {
    projectRoot = await env.git.findRepositoryRoot({ cwd: opts.cwd });
  } catch {
    projectRoot = null;
  }
  if (projectRoot !== null) {
    try {
      projectRoot = await env.realpath(projectRoot);
    } catch {
      projectRoot = resolve(projectRoot);
    }
  } else if (opts.scope === 'project') {
    try {
      projectRoot = await env.realpath(opts.cwd);
    } catch {
      projectRoot = resolve(opts.cwd);
    }
  }
  return { ...opts, projectRoot };
};

const executedFlipReport = (
  preview: FlipReport,
  results: FlipResult[],
  executionResults: readonly OperationExecutionResult[],
): FlipReport => {
  const summary = emptySummary();
  for (const result of results) summary[ACTION_TO_SUMMARY_KEY[result.action]]++;
  return {
    ...preview,
    dryRun: false,
    results,
    summary,
    executionResults,
  };
};

const operationResultForFlip = (
  operation: ExecutableOperation,
  binding: ValidatedExecutionBinding,
  result: FlipResult,
  reportOp: FlipOp,
): OperationExecutionResult => {
  const cancelled = result.reason === 'interrupted' || result.error?.code === 'cancelled';
  const failed = result.action === 'failed' || result.action === 'refused';
  const unchanged = failed || cancelled || result.action === 'noop' || result.action === 'skipped';
  const common = {
    operationId: operation.operationId,
    actualBefore: binding.actualBefore,
    actualAfter: unchanged ? binding.actualBefore : operation.after,
    force: null,
  } as const;
  if (cancelled) {
    return createOperationExecutionResult({ ...common, outcome: 'cancelled', error: null });
  }
  if (failed) {
    return createOperationExecutionResult({
      ...common,
      outcome: 'failed',
      error: {
        code: result.error?.code ?? 'flip-failed',
        message: result.reason ?? 'operation failed',
        remediation: 'Resolve the reported condition and retry the same selection.',
      },
    });
  }
  return createOperationExecutionResult({
    ...common,
    outcome: reportOp === 'rollback' ? 'rolled-back' : 'succeeded',
    error: null,
  });
};

const isExecutionStateError = (
  error: unknown,
): error is { readonly code: 'precondition-state-changed' | 'precondition-observation-failed' } =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  (error.code === 'precondition-state-changed' || error.code === 'precondition-observation-failed');

const isSkillSmithError = (error: unknown): error is SkillSmithError =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string';

const prepareFlipBatch = async (
  env: PlacementPorts,
  opts: FlipOptions,
  command: 'promote' | 'dev',
  reportOp: FlipOp,
  deps: FlipDeps,
  process: PairProcessor,
  predict: PairPredictor,
): Promise<Result<PreparedFlipRun, SkillSmithError>> => {
  const normalizedOpts = await normalizeFlipProjectContext(env, opts);
  const dataDir = resolveDataDir(env, normalizedOpts.configuration);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const requested = buildRequested(normalizedOpts);
  const ledgerState = await readLedgerState(env, ledgerPath);
  if (!ledgerState.ok) return ledgerState;
  const ledgerModel = ledgerModelForMutation(ledgerState.value, nowOf(env, deps));
  const ledger = legacyLedgerView(ledgerModel);
  const planningOptions = {
    ...normalizedOpts,
    op: command,
    ...(reportOp === 'rollback' ? { rollback: true } : {}),
  } as FlipOptions & { op: FlipOp };
  const planRes = await planFlips(env, planningOptions, storeRoot, ledger);
  if (!planRes.ok) return planRes;
  if ((planRes.value.unmatchedTargets?.length ?? 0) > 0) {
    const names = planRes.value.unmatchedTargets as readonly string[];
    return err(
      flipRefusedError(`no placement found for ${names.map((name) => `'${name}'`).join(', ')}`),
    );
  }
  const previewResults: FlipResult[] = [...planRes.value.preResults];
  for (const pair of planRes.value.pairs) {
    previewResults.push(await predict(env, ledger, pair, normalizedOpts));
  }
  const preparedPreview = await buildPreparedPreview(
    env,
    command,
    reportOp,
    requested,
    previewResults,
    normalizedOpts,
    planRes.value,
    ledger,
    ledgerState.value,
  );
  const bindingMap = new Map<string, PreparedFlipBinding>();
  const boundPreviewResults = new Set<FlipResult>();
  for (const binding of preparedPreview.bindings) {
    if (bindingMap.has(binding.operationId)) {
      return err(genericError('prepared operation binding is not one-to-one'));
    }
    bindingMap.set(binding.operationId, binding);
    if (binding.kind === 'pair') {
      const result = resultForPair(previewResults, binding.pair);
      if (result !== undefined) boundPreviewResults.add(result);
    }
  }
  if (
    bindingMap.size !== preparedPreview.report.plan.operations.length ||
    preparedPreview.report.plan.operations.some(
      (operation) => !bindingMap.has(operation.operationId),
    )
  ) {
    return err(genericError('prepared plan has no exact execution binding'));
  }
  const staticResults = previewResults.filter((result) => !boundPreviewResults.has(result));
  let consumed = false;
  const prepared: PreparedFlipRun = {
    preview: preparedPreview.report,
    plan: preparedPreview.report.plan,
    execute: async (): Promise<Result<FlipReport, SkillSmithError>> => {
      if (consumed) return err(genericError('prepared flip run has already been executed'));
      consumed = true;
      if (normalizedOpts.dryRun) return ok(preparedPreview.report);
      const operations = preparedPreview.report.plan.operations;
      if (operations.length === 0) {
        return ok(executedFlipReport(preparedPreview.report, [...staticResults], []));
      }

      let executionLedger: LedgerModel | null = null;
      const startedResults = new Map<string, FlipResult>();
      const coordinatorBindings: PreparedExecutionBinding[] = operations.map((operation) => {
        const preparedBinding = bindingMap.get(operation.operationId);
        if (!preparedBinding) throw new Error('prepared operation binding is missing');
        if (preparedBinding.kind === 'migrate-ledger') {
          return ledgerMigrationExecutionBinding({
            env,
            ledgerPath,
            operation,
            expectedState: preparedBinding.expectedState,
            startedAt: journalNowOf(env, deps),
            ...(normalizedOpts.signal === undefined ? {} : { signal: normalizedOpts.signal }),
            onMigrated: (model) => {
              executionLedger = model;
            },
          });
        }
        if (operation.pairId === null)
          throw new Error('prepared operation pair identity is missing');
        const factIdentity: FlipFactIdentity = {
          command,
          reportOp,
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: operation.pairId,
          kind: operation.kind,
        };
        return {
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: operation.pairId,
          unstartedForce: null,
          observeActualBefore: async (): Promise<OperationImage> => {
            const current = await readLedgerState(env, ledgerPath);
            if (!current.ok) throw current.error;
            const currentModel = ledgerModelForMutation(current.value, nowOf(env, deps));
            const actualFacts = await captureFlipFacts(
              env,
              factIdentity,
              preparedBinding.pair,
              normalizedOpts,
              storeRoot,
              legacyLedgerView(currentModel),
            );
            if (
              canonicalPlanningString(actualFacts) !==
              canonicalPlanningString(preparedBinding.expectedFacts)
            ) {
              throw new Error('prepared placement facts changed');
            }
            executionLedger = currentModel;
            return operation.before;
          },
          execute: async (
            validatedBinding: ValidatedExecutionBinding,
          ): Promise<OperationExecutionResult> => {
            const ledger = executionLedger;
            if (ledger === null) throw new Error('validated execution ledger is missing');
            const result = await process(
              env,
              ledger,
              ledgerPath,
              preparedBinding.pair,
              normalizedOpts,
              deps,
              operation,
            );
            startedResults.set(operation.operationId, result);
            if (result.error) {
              const reread = await readLedgerState(env, ledgerPath);
              if (reread.ok) {
                executionLedger = ledgerModelForMutation(reread.value, nowOf(env, deps));
              }
            }
            return operationResultForFlip(operation, validatedBinding, result, reportOp);
          },
        };
      });
      const compatibilityLockPort = {
        withFileLock: async <T>(
          path: string,
          callback: () => Promise<T>,
          options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<T> => {
          let callbackThrew = false;
          let callbackError: unknown;
          const locked = await withLedgerLock(
            env,
            path,
            async () => {
              try {
                return await callback();
              } catch (error) {
                callbackThrew = true;
                callbackError = error;
                throw error;
              }
            },
            options,
          );
          if (callbackThrew) throw callbackError;
          if (!locked.ok) throw locked.error;
          return locked.value;
        },
      };

      let executionResults: readonly OperationExecutionResult[];
      try {
        executionResults = await executeOperationPlan({
          plan: preparedPreview.report.plan,
          bindings: coordinatorBindings,
          preconditions: preparedPreview.preconditions,
          locks: [
            {
              rank: 'ledger',
              key: `placements-ledger:${ledgerPath}`,
              path: ledgerPath,
            },
          ],
          lockPort: compatibilityLockPort,
          ...(normalizedOpts.signal === undefined ? {} : { signal: normalizedOpts.signal }),
        });
      } catch (error) {
        if (isExecutionStateError(error)) {
          const message =
            error.code === 'precondition-observation-failed'
              ? 'prepared placement state could not be validated before execution'
              : 'prepared placement state changed before execution';
          if (operations.some((operation) => operation.kind === 'migrate-ledger')) {
            return err(flipRefusedError(message));
          }
          const refusedByPreview = new Map<FlipResult, FlipResult>();
          for (const operation of operations) {
            const preparedBinding = bindingMap.get(operation.operationId);
            if (!preparedBinding) {
              return err(genericError('prepared operation binding is missing'));
            }
            if (preparedBinding.kind !== 'pair') continue;
            const previewResult = resultForPair(
              preparedPreview.report.results,
              preparedBinding.pair,
            );
            if (previewResult === undefined) {
              return err(genericError('prepared operation result projection is missing'));
            }
            refusedByPreview.set(previewResult, {
              ...previewResult,
              action: 'refused',
              reason: message,
              before: null,
              after: null,
              store: null,
              verify: null,
              error: flipRefusedError(message),
            });
          }
          executionResults = operations.map((operation) =>
            createOperationExecutionResult({
              operationId: operation.operationId,
              outcome: 'failed',
              actualBefore: operation.before,
              actualAfter: operation.before,
              force: null,
              error: {
                code: 'flip-refused',
                message,
                remediation: 'Re-run the command to prepare and approve the current state.',
              },
            }),
          );
          const results = preparedPreview.report.results.map(
            (previewResult) => refusedByPreview.get(previewResult) ?? previewResult,
          );
          return ok(executedFlipReport(preparedPreview.report, results, executionResults));
        }
        if (isSkillSmithError(error)) return err(error);
        throw error;
      }

      const results: FlipResult[] = [...staticResults];
      for (const [index, operationResult] of executionResults.entries()) {
        const operation = operations[index];
        if (!operation) return err(genericError('execution result has no planned operation'));
        const preparedBinding = bindingMap.get(operation.operationId);
        if (!preparedBinding) return err(genericError('prepared operation binding is missing'));
        if (preparedBinding.kind === 'migrate-ledger') continue;
        const started = startedResults.get(operation.operationId);
        if (started !== undefined) {
          results.push(started);
        } else if (operationResult.outcome === 'skipped-after-failure') {
          results.push(skippedAfterFailureResult(preparedBinding.pair));
        } else if (operationResult.outcome === 'cancelled') {
          results.push(interruptedResult(preparedBinding.pair));
        } else {
          return err(genericError('execution result has no exact started binding result'));
        }
      }
      return ok(executedFlipReport(preparedPreview.report, results, executionResults));
    },
  };
  return ok(prepared);
};

export const preparePromote = (
  env: PlacementPorts,
  opts: FlipOptions,
  deps: FlipDeps = defaultFlipDeps,
): Promise<Result<PreparedFlipRun, SkillSmithError>> =>
  prepareFlipBatch(env, opts, 'promote', 'promote', deps, runPromotePair, (e, l, p, o) =>
    predictPair(e, l, 'promote', p, o),
  );

export const prepareDev = (
  env: PlacementPorts,
  opts: FlipOptions,
  deps: FlipDeps = defaultFlipDeps,
): Promise<Result<PreparedFlipRun, SkillSmithError>> => {
  // BF-1(f): validate `--dest` constraints in CORE (not CLI-only) — a library consumer calling
  // runDev directly must get the same refusals. `--dest` needs `--source` (an unscoped destination
  // is only meaningful for a create) and exactly one `--tool` (a path is ambiguous across tools).
  if (opts.dest !== undefined) {
    if (opts.source === undefined) {
      return Promise.resolve(
        err(flipRefusedError('--dest requires --source (it only overrides a create destination)')),
      );
    }
    const toolCount = opts.tools?.length ?? 0;
    if (toolCount !== 1) {
      return Promise.resolve(
        err(flipRefusedError(`--dest requires exactly one --tool (got ${toolCount})`)),
      );
    }
  }
  return prepareFlipBatch(env, opts, 'dev', 'dev', deps, runDevPair, (e, l, p, o) =>
    predictPair(e, l, 'dev', p, o),
  );
};

export const prepareRollback = async (
  env: PlacementPorts,
  opts: FlipOptions & { op: 'promote' | 'dev' },
  deps: FlipDeps = defaultFlipDeps,
): Promise<Result<PreparedFlipRun, SkillSmithError>> => {
  // BF-1(f)/BF-7(c): rollback restores prior state — it takes no create/gate flags. Reject them in
  // CORE too (the CLI also rejects them) so a direct library call can't silently ignore a --source.
  if (opts.source !== undefined || opts.dest !== undefined) {
    return err(flipRefusedError('--rollback does not accept --source or --dest'));
  }

  return prepareFlipBatch(
    env,
    opts,
    opts.op,
    'rollback',
    deps,
    runRollbackPair,
    async (_env, ledger, pair) => predictRollbackPair(ledger, pair),
  );
};

const runPrepared = async (
  prepared: Promise<Result<PreparedFlipRun, SkillSmithError>>,
  dryRun: boolean | undefined,
): Promise<Result<FlipReport, SkillSmithError>> => {
  const result = await prepared;
  if (!result.ok) return result;
  return dryRun ? ok(result.value.preview) : result.value.execute();
};

export const runPromote = (
  env: PlacementPorts,
  opts: FlipOptions,
  deps: FlipDeps = defaultFlipDeps,
): Promise<Result<FlipReport, SkillSmithError>> =>
  runPrepared(preparePromote(env, opts, deps), opts.dryRun);

export const runDev = (
  env: PlacementPorts,
  opts: FlipOptions,
  deps: FlipDeps = defaultFlipDeps,
): Promise<Result<FlipReport, SkillSmithError>> =>
  runPrepared(prepareDev(env, opts, deps), opts.dryRun);

export const runRollback = (
  env: PlacementPorts,
  opts: FlipOptions & { op: 'promote' | 'dev' },
  deps: FlipDeps = defaultFlipDeps,
): Promise<Result<FlipReport, SkillSmithError>> =>
  runPrepared(prepareRollback(env, opts, deps), opts.dryRun);
