import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { toolRegistry } from '../agents/registry.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
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
  executeOperationPlan,
} from '../execution/index.ts';
import {
  createContentObservationExecutionPrecondition,
  createExpectedRevisionExecutionPrecondition,
} from '../execution/preconditions.ts';
import { createOperationExecutionResult, createPlanningDiagnosticId } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
  OperationResourceIdentity,
  OperationSource,
  PlanningDiagnostic,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type ContentObservationIdentityV1,
  type ExpectedRevisionV1,
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionPreconditionIdV1,
} from '../state/types.ts';
import { verifyPlugin } from '../verify/run.ts';
import type { ToolVerdict } from '../verify/types.ts';
import {
  type PlacementSnapshotAuthority,
  type PlacementStoreResource,
  createPlacementExecutionInput,
  createPlacementLifecycleExecutor,
  createPlacementSnapshotAuthority,
  executePlacementPlan,
  executeRecordOnlyPlacementPlan,
  placementSnapshotResourceId,
} from './execute.ts';
import { ledgerMigrationExecutionBinding, prepareLedgerMigration } from './ledger-migration.ts';
import {
  getLedgerPairAt,
  getPairAt,
  ledgerModelForMutation,
  legacyLedgerView,
  readLedgerState,
  withLedgerLock,
} from './ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from './paths.ts';
import {
  type FlipPlanOutcome,
  type PairPlan,
  type PlacementDevIntentV1,
  type PlacementPromoteIntentV1,
  type PlacementRollbackIntentV1,
  createPlacementPlan,
  planFlips,
} from './plan.ts';
import { recoverPlacement } from './recovery.ts';
import { contentHashOf, resolveProvenance, snapshotToStore } from './store.ts';
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
  type PairRecord,
  type PinnedRecord,
  type PlacementPorts,
  type PreparedFlipRun,
  type Provenance,
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
  preparedPromote: PreparedPromoteExecution | null,
): Promise<FlipResult> => {
  const { skill, tool, scopeKey, placement, notices } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  let currentLedger = ledger;
  const existing = getLedgerPairAt(currentLedger, scopeKey, skill, tool);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    if (existing.journal.op === 'promote') {
      const resumed = await recoverPlacement(
        createPlacementExecutionInput(env, ledgerPath, currentLedger, deps, opts, logicalOperation),
        'resume',
        { skill, tool, scopeKey },
      );
      if (!resumed.ok) return failedResult(base, midSwapError(resumed.error));
      currentLedger = resumed.state.ledger;
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

  if (
    preparedPromote === null ||
    resolve(preparedPromote.sourcePath) !== resolve(resolvedSourceDir)
  ) {
    return failedResult(base, genericError('planned promotion execution seed is missing'));
  }
  const observedProvenance = await resolveProvenance(env, resolvedSourceDir);
  if (!observedProvenance.ok) return failedResult(base, observedProvenance.error);
  const observedRev = await computeRevPreview(env, observedProvenance.value, resolvedSourceDir);
  if (!observedRev.ok) return failedResult(base, observedRev.error);
  const observedStorePath = join(
    storeRootOf(resolveDataDir(env, opts.configuration)),
    observedProvenance.value.ns,
    `${observedProvenance.value.name}@${observedRev.value}`,
    skill,
  );
  if (
    canonicalPlanningString(observedProvenance.value) !==
      canonicalPlanningString(preparedPromote.provenance) ||
    observedRev.value !== preparedPromote.rev ||
    resolve(observedStorePath) !== resolve(preparedPromote.storePath)
  ) {
    const reason = 'prepared promotion provenance changed before execution';
    return refusedResult(base, reason, flipRefusedError(reason));
  }
  const provenance = preparedPromote.provenance;

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
      if (
        resolve(snap.storePath) !== resolve(preparedPromote.storePath) ||
        snap.rev !== preparedPromote.rev ||
        snap.contentHash !== preparedPromote.contentHash
      ) {
        return failedResult(base, flipFailedError('promotion snapshot differs from prepared plan'));
      }

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
      const swapRes = await executePlacementPlan(
        createPlacementExecutionInput(env, ledgerPath, currentLedger, deps, opts, logicalOperation),
        installPlan,
      );
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
    const toDevRes = await executePlacementPlan(
      createPlacementExecutionInput(env, ledgerPath, currentLedger, deps, opts),
      toDevPlan,
    );
    if (!toDevRes.ok) return failedResult(base, midSwapError(toDevRes.error));
    currentLedger = toDevRes.state.ledger;
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
  if (
    resolve(snap.storePath) !== resolve(preparedPromote.storePath) ||
    snap.rev !== preparedPromote.rev ||
    snap.contentHash !== preparedPromote.contentHash
  ) {
    return failedResult(base, flipFailedError('promotion snapshot differs from prepared plan'));
  }

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
  const swapRes = await executePlacementPlan(
    createPlacementExecutionInput(env, ledgerPath, currentLedger, deps, opts, logicalOperation),
    plan,
  );
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
  const committed = await executeRecordOnlyPlacementPlan(
    createPlacementExecutionInput(env, ledgerPath, ledger, deps, opts, logicalOperation),
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
  const committed = await executeRecordOnlyPlacementPlan(
    createPlacementExecutionInput(env, ledgerPath, ledger, deps, opts, logicalOperation),
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
  _preparedPromote: PreparedPromoteExecution | null,
): Promise<FlipResult> => {
  const { skill, tool, scopeKey, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getLedgerPairAt(ledger, scopeKey, skill, tool);

  if (existing?.journal && existing.journal.phase !== 'committed') {
    if (existing.journal.op === 'dev') {
      const resumed = await recoverPlacement(
        createPlacementExecutionInput(env, ledgerPath, ledger, deps, opts, logicalOperation),
        'resume',
        { skill, tool, scopeKey },
      );
      if (!resumed.ok) return failedResult(base, midSwapError(resumed.error));
      const after = getLedgerPairAt(resumed.state.ledger, scopeKey, skill, tool);
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
  const swapRes = await executePlacementPlan(
    createPlacementExecutionInput(env, ledgerPath, ledger, deps, opts, logicalOperation),
    plan,
  );
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
  _preparedPromote: PreparedPromoteExecution | null,
): Promise<FlipResult> => {
  const { skill, tool, scopeKey, placement } = pair;
  const base: Base = { skill, tool, placementPath: placement.path };
  const existing = getLedgerPairAt(ledger, scopeKey, skill, tool);
  const executionInput = createPlacementExecutionInput(
    env,
    ledgerPath,
    ledger,
    deps,
    opts,
    logicalOperation,
  );

  if (existing?.journal && existing.journal.phase !== 'committed') {
    // Captured BEFORE the call: `rollbackSwap` mutates this same pair record in place (nulls
    // `.journal` on success), so reading `existing.journal` afterward would see the post-mutation
    // state, not the journal that was actually rolled back.
    const journalOp = existing.journal.op;
    const journalBeforeMode = existing.journal.before.mode;
    const rb = await recoverPlacement(executionInput, 'rollback', { skill, tool, scopeKey });
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
    const swapRes = await executePlacementPlan(executionInput, plan);
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
  const swapRes = await executePlacementPlan(executionInput, plan);
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

const selectionSourceOf = (opts: FlipOptions): 'explicit-targets' | 'explicit-all' =>
  opts.selectionSource ?? (opts.all ? 'explicit-all' : 'explicit-targets');

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
  if ((await env.pathKind(path)) !== 'dir') return null;
  const hashed = await contentHashOf(env, path);
  return hashed.ok
    ? { kind: 'local-dev', path, contentHash: hashed.value as `sha256:${string}` }
    : null;
};

const pairIdentityKey = (pair: PairPlan): string =>
  JSON.stringify([pair.scope, pair.scopeKey, pair.skill, pair.tool, pair.placement.path]);

const contentObservationForSource = (
  path: string,
  contentHash: `sha256:${string}`,
): ContentObservationIdentityV1 =>
  createContentObservationIdentityV1({
    schemaVersion: 1,
    resourceId: placementSnapshotResourceId('source', resolve(path)),
    targetIdentity: resolve(path),
    targetKind: 'directory',
    contentRevision: contentHash,
  });

const observeSourceContent = async (
  env: PlacementPorts,
  expected: ContentObservationIdentityV1,
): Promise<ContentObservationIdentityV1> => {
  const kind = await env.pathKind(expected.targetIdentity);
  if (kind !== 'dir') {
    throw new Error('prepared placement source is no longer a directory');
  }
  const hashed = await contentHashOf(env, expected.targetIdentity);
  if (!hashed.ok) throw hashed.error;
  return createContentObservationIdentityV1({
    ...expected,
    contentRevision: hashed.value,
  });
};

interface PreparedPairFlipBinding {
  readonly kind: 'pair';
  readonly operationId: string;
  readonly pair: PairPlan;
  readonly promote: PreparedPromoteExecution | null;
  readonly stageResourceIds: readonly string[];
}

interface PreparedLedgerMigrationBinding {
  readonly kind: 'migrate-ledger';
  readonly operationId: string;
  readonly expectedState: Extract<LedgerReadState, { readonly state: 'present' }>;
}

type PreparedFlipBinding = PreparedPairFlipBinding | PreparedLedgerMigrationBinding;

interface PreparedPromoteExecution {
  readonly sourcePath: string;
  readonly provenance: Provenance;
  readonly rev: string;
  readonly storePath: string;
  readonly contentHash: `sha256:${string}`;
}

const createFlipPlanning = async (
  env: PlacementPorts,
  command: 'promote' | 'dev',
  reportOp: FlipOp,
  opts: FlipOptions,
  projectContext: ProjectContext,
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
    authority: PlacementSnapshotAuthority;
  }>
> => {
  const ledgerPath = ledgerPathOf(resolveDataDir(env, opts.configuration));
  const selectionSource = selectionSourceOf(opts);
  const compatibilityOperations: ExecutableOperation[] = [];
  const intents: (PlacementDevIntentV1 | PlacementPromoteIntentV1 | PlacementRollbackIntentV1)[] =
    [];
  const stores = new Map<string, PlacementStoreResource>();
  const promoteExecutions = new Map<string, PreparedPromoteExecution>();
  const bindings: PreparedFlipBinding[] = [];
  const preconditions: ExecutionPrecondition[] = [];
  const usedResults = new Set<FlipResult>();

  const migration = prepareLedgerMigration(env, command, selectionSource, ledgerPath, ledgerState);
  if (migration !== null) {
    compatibilityOperations.push(migration.operation);
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
    usedResults.add(result);

    const liveResourceId = placementSnapshotResourceId('live', pairIdentityKey(pair));
    const projectRoot =
      pair.scopeKey === null ? null : ({ kind: 'machine-bound', path: pair.scopeKey } as const);
    const addStore = (path: string, contentHash: string): string => {
      if (!/^sha256:[0-9a-f]{64}$/u.test(contentHash)) {
        throw new Error('placement store content hash is invalid');
      }
      const resourceId = placementSnapshotResourceId('store', resolve(path));
      const existing = stores.get(resourceId);
      if (existing !== undefined && existing.contentHash !== contentHash) {
        throw new Error('placement store resource has conflicting content expectations');
      }
      stores.set(resourceId, {
        resourceId,
        storePath: path,
        contentHash: contentHash as `sha256:${string}`,
      });
      return resourceId;
    };
    if (current?.pinned != null) {
      addStore(current.pinned.storePath, current.pinned.contentHash);
    }
    if (reportOp === 'rollback') {
      const rollbackBefore =
        (current?.journal?.phase === 'committed' ? null : current?.journal?.before) ??
        (current?.mode === 'pinned' && current.dev != null
          ? { mode: 'dev' as const, symlinkTarget: current.dev.resolvedPath }
          : current?.mode === 'dev' && current.pinned != null
            ? {
                mode: 'pinned' as const,
                storePath: current.pinned.storePath,
                contentHash: current.pinned.contentHash,
              }
            : null);
      if (rollbackBefore === null) {
        usedResults.delete(result);
        continue;
      }
      let storeResourceId: string | null = null;
      let sourceContent: ContentObservationIdentityV1 | undefined;
      if (rollbackBefore?.mode === 'pinned' && rollbackBefore.storePath != null) {
        if (rollbackBefore.contentHash != null) {
          storeResourceId = addStore(rollbackBefore.storePath, rollbackBefore.contentHash);
        }
        if (current?.dev != null) {
          const target = resolve(current.dev.resolvedPath);
          const hashed = await contentHashOf(env, target);
          if (hashed.ok) {
            sourceContent = contentObservationForSource(target, hashed.value as `sha256:${string}`);
          }
        }
      } else if (rollbackBefore?.mode === 'dev') {
        const target = resolve(dirname(pair.placement.path), rollbackBefore.symlinkTarget);
        const hashed = await contentHashOf(env, target);
        if (!hashed.ok) throw hashed.error;
        sourceContent = contentObservationForSource(target, hashed.value as `sha256:${string}`);
      }
      intents.push({
        kind: 'rollback',
        skill: pair.skill,
        tool: pair.tool,
        scope: pair.scope,
        projectRoot,
        liveResourceId,
        storeResourceId,
        ...(sourceContent === undefined ? {} : { sourceContent }),
      });
      continue;
    }
    const source = await devOperationSourceOf(env, ledger, pair, opts);
    if (source === null) {
      usedResults.delete(result);
      continue;
    }
    const sourceContent = contentObservationForSource(source.path, source.contentHash);
    const verification = opts.noVerify
      ? undefined
      : {
          mode:
            command === 'promote'
              ? (toolRegistry.get(pair.tool)?.verification?.gatePolicy.promote ?? 'static')
              : ('static' as const),
          expectedContentHash: source.contentHash,
        };
    if (command === 'dev') {
      intents.push({
        kind: 'link-dev',
        skill: pair.skill,
        tool: pair.tool,
        scope: pair.scope,
        projectRoot,
        liveResourceId,
        source,
        sourceContent,
        ...(verification === undefined ? {} : { verification }),
      });
      continue;
    }
    const provenance = await resolveProvenance(env, source.path);
    if (!provenance.ok) {
      usedResults.delete(result);
      continue;
    }
    const rev = await computeRevPreview(env, provenance.value, source.path);
    if (!rev.ok) {
      usedResults.delete(result);
      continue;
    }
    const storePath = join(
      storeRoot,
      provenance.value.ns,
      `${provenance.value.name}@${rev.value}`,
      pair.skill,
    );
    promoteExecutions.set(pairIdentityKey(pair), {
      sourcePath: source.path,
      provenance: provenance.value,
      rev: rev.value,
      storePath,
      contentHash: source.contentHash,
    });
    intents.push({
      kind: 'promote',
      skill: pair.skill,
      tool: pair.tool,
      scope: pair.scope,
      projectRoot,
      liveResourceId,
      storeResourceId: addStore(storePath, source.contentHash),
      source,
      sourceContent,
      representation:
        current?.pinned?.placement === 'symlink' && current.origin !== undefined
          ? 'symlink'
          : 'copy',
      desiredContentHash: source.contentHash,
      ...(verification === undefined ? {} : { verification }),
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

  if (intents.length === 0 && diagnostics.length === 0 && opts.all) {
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
    intents.length === 0 && diagnostics.some((item) => item.reason.code === 'filter-noop');
  const authorityResult = await createPlacementSnapshotAuthority(
    env,
    projectContext,
    ledgerPath,
    storeRoot,
    outcome.pairs,
    [...stores.values()],
  );
  if (!authorityResult.ok) throw authorityResult.error;
  const authority = authorityResult.value;
  const commonRequest = {
    schemaVersion: 1 as const,
    selection: {
      source: selectionSource,
      outcome: filterNoop ? ('filter-noop' as const) : ('selected' as const),
      targets: [...opts.targets],
      all: Boolean(opts.all),
      tools: opts.tools ? [...opts.tools] : [...FLIP_TOOLS],
      scopes,
    },
    batchPolicy: opts.continueOnError ? ('continue-on-error' as const) : ('fail-fast' as const),
    diagnostics,
    compatibilityOperations,
  };
  const planned =
    reportOp === 'rollback'
      ? createPlacementPlan(
          {
            ...commonRequest,
            command,
            mode: 'rollback',
            intents: intents as PlacementRollbackIntentV1[],
          },
          authority.snapshot,
        )
      : command === 'dev'
        ? createPlacementPlan(
            {
              ...commonRequest,
              command: 'dev',
              mode: 'forward',
              intents: intents as PlacementDevIntentV1[],
            },
            authority.snapshot,
          )
        : createPlacementPlan(
            {
              ...commonRequest,
              command: 'promote',
              mode: 'forward',
              intents: intents as PlacementPromoteIntentV1[],
            },
            authority.snapshot,
          );
  if (!planned.ok) throw new Error(planned.error.message);
  const plan = planned.value.plan;
  const revisionResource = (revision: ExpectedRevisionV1): OperationResourceIdentity => {
    if (revision.domain === 'manifest') {
      return {
        kind: 'manifest-bytes',
        location: { kind: 'machine-bound', path: authority.manifestPath },
      };
    }
    if (revision.domain === 'lock') {
      return { kind: 'lock', location: { kind: 'machine-bound', path: authority.lockPath } };
    }
    if (revision.domain === 'ledger') return { kind: 'ledger', projectRoot: null };
    if (revision.domain === 'store') {
      const store = authority.storeResources.find(
        (item) => item.resourceId === revision.resourceId,
      );
      if (store === undefined) throw new Error('placement store revision resource is missing');
      return { kind: 'store', contentHash: store.contentHash };
    }
    if (revision.domain === 'live') {
      const live = authority.liveResources.find((item) => item.resourceId === revision.resourceId);
      if (live === undefined) throw new Error('placement live revision resource is missing');
      return {
        kind: 'live',
        skill: live.skill,
        tool: live.tool as FlipTool,
        scope: live.scope === 'project' ? 'project' : 'user',
        projectRoot:
          live.projectIdentity === null
            ? null
            : { kind: 'machine-bound', path: live.projectIdentity },
        location: { kind: 'machine-bound', path: live.placementPath },
      };
    }
    return {
      kind: 'project-context',
      root: { kind: 'machine-bound', path: authority.projectRoot },
    };
  };
  for (const revision of planned.value.expectedRevisions) {
    const preconditionId = createExpectedRevisionPreconditionIdV1(revision);
    const operationIds = plan.operations
      .filter((operation) => operation.preconditionIds.includes(preconditionId))
      .map((operation) => operation.operationId);
    if (operationIds.length === 0) continue;
    preconditions.push(
      createExpectedRevisionExecutionPrecondition({
        operationIds,
        resource: revisionResource(revision),
        expectedRevision: revision,
        observeRevision: () =>
          authority.repositories[revision.domain]
            .observeRevision(revision.resourceId)
            .then((observed) => {
              if (!observed.ok) throw observed.error;
              if (
                revision.domain === 'ledger' &&
                revision.state === 'absent' &&
                observed.value.domain === 'ledger' &&
                observed.value.state === 'absent' &&
                revision.targetIdentity === observed.value.targetIdentity &&
                revision.parentIdentity === observed.value.parentIdentity
              ) {
                return revision;
              }
              return observed.value;
            }),
      }),
    );
  }
  const contents = intents
    .map((intent) => intent.sourceContent)
    .filter((value): value is ContentObservationIdentityV1 => value !== undefined);
  const contentByResource = new Map<string, ContentObservationIdentityV1>();
  for (const content of contents) {
    const existing = contentByResource.get(content.resourceId);
    if (
      existing !== undefined &&
      canonicalPlanningString(existing) !== canonicalPlanningString(content)
    ) {
      throw new Error('placement source content resource identity is ambiguous');
    }
    contentByResource.set(content.resourceId, content);
  }
  for (const content of contentByResource.values()) {
    const preconditionId = createContentObservationPreconditionIdV1(content);
    const covered = plan.operations.filter((operation) =>
      operation.preconditionIds.includes(preconditionId),
    );
    if (covered.length === 0) continue;
    preconditions.push(
      createContentObservationExecutionPrecondition({
        operationIds: covered.map((operation) => operation.operationId),
        resource:
          covered[0]?.before.kind === 'placement' || covered[0]?.before.kind === 'absent'
            ? covered[0].before.resource
            : {
                kind: 'project-context',
                root: { kind: 'machine-bound', path: authority.projectRoot },
              },
        expectedContent: content,
        observeContent: () => observeSourceContent(env, content),
      }),
    );
  }
  for (const operation of plan.operations) {
    if (bindings.some((binding) => binding.operationId === operation.operationId)) continue;
    const pair = outcome.pairs.find(
      (candidate) =>
        candidate.skill === operation.skill &&
        candidate.tool === operation.tool &&
        candidate.scope === operation.scope,
    );
    if (pair === undefined) throw new Error('planned placement pair binding is missing');
    const intent = intents.find(
      (candidate) =>
        candidate.skill === operation.skill &&
        candidate.tool === operation.tool &&
        candidate.scope === operation.scope,
    );
    const ownResourceIds = new Set([
      placementSnapshotResourceId('live', pairIdentityKey(pair)),
      ...(intent !== undefined && 'storeResourceId' in intent && intent.storeResourceId !== null
        ? [intent.storeResourceId]
        : []),
    ]);
    const mutable = [...authority.snapshot.live, ...authority.snapshot.store]
      .map(({ revision }) => revision)
      .filter(
        (revision): revision is ExpectedRevisionV1 & Readonly<{ parentIdentity: string }> =>
          'parentIdentity' in revision,
      );
    const parentIdentities = new Set(
      mutable
        .filter(({ resourceId }) => ownResourceIds.has(resourceId))
        .map(({ parentIdentity }) => parentIdentity),
    );
    bindings.push({
      kind: 'pair',
      operationId: operation.operationId,
      pair,
      promote: promoteExecutions.get(pairIdentityKey(pair)) ?? null,
      stageResourceIds: mutable
        .filter(
          ({ resourceId, parentIdentity }) =>
            ownResourceIds.has(resourceId) || parentIdentities.has(parentIdentity),
        )
        .map(({ resourceId }) => resourceId),
    });
  }
  return { plan, executionResults: [], bindings, preconditions, authority };
};

const buildPreparedPreview = async (
  env: PlacementPorts,
  command: 'promote' | 'dev',
  op: FlipOp,
  requested: FlipReport['requested'],
  results: FlipResult[],
  opts: FlipOptions,
  projectContext: ProjectContext,
  outcome: FlipPlanOutcome,
  ledger: LedgerFile,
  ledgerState: LedgerReadState,
): Promise<
  Readonly<{
    report: FlipReport;
    bindings: readonly PreparedFlipBinding[];
    preconditions: readonly ExecutionPrecondition[];
    authority: PlacementSnapshotAuthority;
  }>
> => {
  const summary = emptySummary();
  for (const r of results) summary[ACTION_TO_SUMMARY_KEY[r.action]]++;
  const { plan, executionResults, bindings, preconditions, authority } = await createFlipPlanning(
    env,
    command,
    op,
    opts,
    projectContext,
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
    authority,
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
  preparedPromote: PreparedPromoteExecution | null,
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
): Promise<
  Result<Readonly<{ opts: FlipOptions; projectContext: ProjectContext }>, SkillSmithError>
> => {
  const projectContext = await resolveProjectContext(env, {
    invocationCwd: opts.cwd,
    ...(opts.configuration.explicitConfigPath === undefined
      ? {}
      : { explicitConfigPath: opts.configuration.explicitConfigPath }),
  });
  return projectContext.ok
    ? ok({
        projectContext: projectContext.value,
        opts: {
          ...opts,
          projectRoot:
            opts.scope === 'project' || typeof opts.projectRoot === 'string'
              ? (projectContext.value.projectRoot ?? projectContext.value.effectiveCwd)
              : null,
        },
      })
    : projectContext;
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

const failClosedPlannedNoop = (operation: ExecutableOperation, result: FlipResult): FlipResult => {
  if (result.action !== 'noop' && result.action !== 'skipped') return result;
  const reason = `planned ${operation.kind} operation did not execute its approved mutation`;
  return {
    ...result,
    action: 'failed',
    reason,
    before: null,
    after: null,
    store: null,
    verify: null,
    error: flipFailedError(reason),
  };
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
  const normalized = await normalizeFlipProjectContext(env, opts);
  if (!normalized.ok) return normalized;
  const { opts: normalizedOpts, projectContext } = normalized.value;
  const dataDir = resolveDataDir(env, normalizedOpts.configuration);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const requested = buildRequested(normalizedOpts);
  const prepareSnapshot = async (): Promise<
    Result<
      Readonly<{
        preparedPreview: Awaited<ReturnType<typeof buildPreparedPreview>>;
        previewResults: readonly FlipResult[];
      }>,
      SkillSmithError
    >
  > => {
    const ledgerState = await readLedgerState(env, ledgerPath);
    if (!ledgerState.ok) return ledgerState;
    const ledger = legacyLedgerView(ledgerModelForMutation(ledgerState.value, nowOf(env, deps)));
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
    let preparedPreview: Awaited<ReturnType<typeof buildPreparedPreview>>;
    try {
      preparedPreview = await buildPreparedPreview(
        env,
        command,
        reportOp,
        requested,
        previewResults,
        normalizedOpts,
        projectContext,
        planRes.value,
        ledger,
        ledgerState.value,
      );
    } catch (error) {
      if (isSkillSmithError(error)) return err(error);
      throw error;
    }
    return ok({
      preparedPreview,
      previewResults,
    });
  };
  let snapshotResult: Awaited<ReturnType<typeof prepareSnapshot>>;
  if (normalizedOpts.dryRun) {
    snapshotResult = await prepareSnapshot();
  } else {
    const preparedSnapshot = await withLedgerLock(env, ledgerPath, prepareSnapshot, {
      ...(normalizedOpts.signal === undefined ? {} : { signal: normalizedOpts.signal }),
    });
    if (!preparedSnapshot.ok) return preparedSnapshot;
    snapshotResult = preparedSnapshot.value;
  }
  if (!snapshotResult.ok) return snapshotResult;
  const { preparedPreview, previewResults } = snapshotResult.value;
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
      const lifecycle = createPlacementLifecycleExecutor(preparedPreview.authority);
      const startedResults = new Map<string, FlipResult>();
      const coordinatorBindings: PreparedExecutionBinding[] = operations.map((operation) => {
        const preparedBinding = bindingMap.get(operation.operationId);
        if (!preparedBinding) throw new Error('prepared operation binding is missing');
        if (preparedBinding.kind === 'migrate-ledger') {
          const migrationBinding = ledgerMigrationExecutionBinding({
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
          return {
            ...migrationBinding,
            execute: (binding: ValidatedExecutionBinding) =>
              lifecycle.execute(operation, [], () => migrationBinding.execute(binding)),
          };
        }
        if (operation.pairId === null)
          throw new Error('prepared operation pair identity is missing');
        return {
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: operation.pairId,
          unstartedForce: null,
          observeActualBefore: async (): Promise<OperationImage> => {
            const current = await readLedgerState(env, ledgerPath);
            if (!current.ok) throw current.error;
            executionLedger = ledgerModelForMutation(current.value, nowOf(env, deps));
            return operation.before;
          },
          execute: async (
            validatedBinding: ValidatedExecutionBinding,
          ): Promise<OperationExecutionResult> => {
            const ledger = executionLedger;
            if (ledger === null) throw new Error('validated execution ledger is missing');
            return lifecycle.execute(operation, preparedBinding.stageResourceIds, async () => {
              const result = failClosedPlannedNoop(
                operation,
                await process(
                  env,
                  ledger,
                  ledgerPath,
                  preparedBinding.pair,
                  normalizedOpts,
                  deps,
                  operation,
                  preparedBinding.promote,
                ),
              );
              startedResults.set(operation.operationId, result);
              const reread = await readLedgerState(env, ledgerPath);
              // The durable ledger is the sole composition source after a started operation.
              if (!reread.ok) throw reread.error;
              executionLedger = ledgerModelForMutation(reread.value, nowOf(env, deps));
              return operationResultForFlip(operation, validatedBinding, result, reportOp);
            });
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
