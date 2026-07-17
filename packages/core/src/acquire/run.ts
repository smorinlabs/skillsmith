import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type Placement, classifyPlacement } from '../agents/placement-shared.ts';
import { type LifecycleToolRegistry, toolRegistry } from '../agents/registry.ts';
import type { GeneratedLockAction, HumanManifestAction } from '../artifacts/coordinator-types.ts';
import {
  type ArtifactDigest,
  HASH_SCHEMA_VERSION,
  hashManifestSemantics,
} from '../artifacts/hash.ts';
import { validateRequestedRef } from '../artifacts/identity.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import {
  type PortableLockSkillV1,
  type PortableLockV1,
  hashPortableLock,
  serializePortableLock,
} from '../artifacts/lock.ts';
import {
  type ManifestEdit,
  type ManifestEditRequest,
  editManifestBytes,
} from '../artifacts/manifest-edit.ts';
import { createNodeArtifactCoordinatorPorts } from '../artifacts/node-coordinator.ts';
import { artifactContractRegistry } from '../artifacts/registry.ts';
import type { NormalizedManifestDeclaration, NormalizedManifestV1 } from '../artifacts/types.ts';
import {
  type SkillSmithError,
  cancelledError,
  configError,
  errorMessage,
  flipFailedError,
  flipRefusedError,
  genericError,
  sourceUnresolvableError,
  toolUnavailableError,
} from '../errors.ts';
import { createContentObservationExecutionPrecondition } from '../execution/preconditions.ts';
import type {
  ExecutionPrecondition,
  PreparedExecutionBinding,
  ValidatedExecutionBinding,
} from '../execution/types.ts';
import type { ObservationBundle } from '../observation/index.ts';
import { prepareLedgerMigration } from '../place/ledger-migration.ts';
import {
  getLedgerPairAt,
  getPairAt as getLegacyPairAt,
  ledgerModelForMutation,
  legacyLedgerView,
  readLedgerState,
  withLedgerLock,
  withoutLedgerPairAt,
} from '../place/ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import {
  type SnapshotResult,
  clampStoreNs,
  contentHashOf,
  snapshotToStore,
  sweepStaging,
} from '../place/store.ts';
import type { FlipTool, LedgerFile, PairRecord, Provenance, SwapPlan } from '../place/types.ts';
import {
  createBoundedForceEffect,
  createOperationExecutionResult,
  createOperationGroupId,
} from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  CurrentMutatorOperationPlan,
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial, redactSensitiveString } from '../safety/redaction.ts';
import { detectTool } from '../scan/index.ts';
import {
  type ContentObservationIdentityV1,
  type ExpectedRevisionV1,
  createContentObservationPreconditionIdV1,
  createStoreSnapshotIdentityV1,
} from '../state/types.ts';
import { evaluateVerificationGate } from '../verify/gate.ts';
import { runVerify, verifyPlugin } from '../verify/run.ts';
import type { ToolVerdict, VerifyReport } from '../verify/types.ts';
import {
  type AcquireContentFacts,
  type AcquireExecutionInput,
  type AcquireLiveSnapshotResourceV1,
  type AcquirePlacementFacts,
  type AcquireStoreSnapshotResourceV1,
  type AcquisitionArtifactExecutionActionV1,
  type AcquisitionPlanObservationState,
  type AcquisitionSnapshotAuthorityV1,
  acquireActualBefore,
  acquireContentFacts,
  acquireContentObservationIdentity,
  acquirePlacementFacts,
  acquireStateResourceId,
  acquisitionLockImageFromBytesV1,
  acquisitionManifestImageFromBytesV1,
  acquisitionPreconditionStateChanged,
  acquisitionRevisionPreconditions,
  acquisitionSnapshotArtifactAuthorityV1,
  createAcquireExecutionInput,
  createAcquireExecutionLockPort,
  createAcquisitionArtifactExecutionControllerV1,
  createAcquisitionLedgerMigrationBinding,
  createAcquisitionOriginRecord,
  createAcquisitionPinnedRecord,
  createAcquisitionRepositoryLifecycleControllerV1,
  destinationSkillRootFor,
  detectAcquireToolWithObservation,
  emitAcquisitionPlanCreated,
  executeAcquirePlanWithObservation,
  executeAcquireReplacementWithObservation,
  executeAcquisitionOperationPlan,
  executeRecordOnlyAcquirePlanWithObservation,
  readAcquisitionSnapshotV1,
  recoverAcquireWithObservation,
  recoverCommittedAcquireJournalsWithObservation,
  resolveAcquisitionArtifactDestinationV1,
  resolveAcquisitionProjectContextV1,
  resolvePlacementFor,
  runAcquisitionWithObservation,
  skillRootFactsFor,
  verificationRegistryFor,
} from './execute.ts';
import { sweepFetchOrphans } from './fetch.ts';
import {
  type AcquisitionArtifactTransitionEnvelopeV1,
  type AcquisitionInstallIntentV1,
  createAcquisitionDiagnosticPlan,
  createAcquisitionPlan,
  createInstallCapabilityQueries,
  createInstallPlanning,
} from './plan.ts';
import { recoveryRefusedMessage } from './recovery.ts';
import {
  type ResolveRemoteSourceOutcome,
  type ResolvedSourceMaterialization,
  resolveRemoteSource,
  safeDependencyResult,
  safeError,
  safeUnknownMessage,
} from './resolve.ts';
export { defaultInstallSourceTransport } from './resolve.ts';
import { parseSource } from './source.ts';
import type {
  AcquisitionPorts,
  CurrentInstallReport,
  CurrentInstallResult,
  InstallAction,
  InstallDeps,
  InstallOptions,
  InstallReport,
  InstallResult,
  InstallScope,
  PlannedInstallReport,
  SourceSpec,
  UninstallDeps,
  UninstallOptions,
} from './types.ts';
const defaultInstallDetect: InstallDeps['detect'] = (env, tool, signal) =>
  detectTool(env, tool, signal);
export const defaultInstallDeps: Omit<InstallDeps, 'pick' | 'transport'> = {
  verify: verifyPlugin,
  detect: defaultInstallDetect,
};
type AcquireLedger = LedgerFile | LedgerModel;
const getPairAt = (
  ledger: AcquireLedger,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
): PairRecord | null =>
  'schemaVersion' in ledger
    ? getLegacyPairAt(ledger, scopeKey, skill, tool)
    : (getLedgerPairAt(ledger, scopeKey, skill, tool) as PairRecord | null);
const nowOf = (ports: AcquisitionPorts, deps: InstallDeps | UninstallDeps): string =>
  deps.now?.() ?? ports.wallNowIso();
const journalNowOf = (ports: AcquisitionPorts, deps: InstallDeps | UninstallDeps): string => {
  const value = nowOf(ports, deps);
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
};
const txIdOf = (ports: AcquisitionPorts, deps: InstallDeps | UninstallDeps): string =>
  deps.newTxId?.() ?? ports.nextId('acquisition-transaction');
const executionInputOf = (
  env: AcquisitionPorts,
  ledgerPath: string,
  ledger: LedgerModel,
  deps: InstallDeps | UninstallDeps,
  opts: Pick<InstallOptions | UninstallOptions, 'testPauseAt' | 'signal'>,
  logicalOperation: ExecutableOperation | null,
): AcquireExecutionInput =>
  createAcquireExecutionInput(
    env,
    ledgerPath,
    ledger,
    [() => journalNowOf(env, deps), () => txIdOf(env, deps)] as const,
    opts,
    logicalOperation,
  );
const installHintFor = (registry: LifecycleToolRegistry<string>, tool: FlipTool): string => {
  const hint = registry.get(tool)?.inventory.installHint;
  if (hint === undefined) throw new Error(`tool registry invariant: ${tool} has no install hint`);
  return hint;
};
const msg = (e: SkillSmithError): string =>
  redactSensitiveString('message' in e ? e.message : e.code);
const selectorLabel = (spec: SourceSpec): string => {
  if (spec.selector.kind === 'path') return spec.selector.path;
  if (spec.selector.kind === 'name') return spec.selector.name;
  return spec.identity.repository;
};
const resolveSymlinkAbsolute = (placementPath: string, literalTarget: string): string =>
  isAbsolute(literalTarget) ? literalTarget : join(dirname(placementPath), literalTarget);
// ---------------------------------------------------------------------------------------------
// result builders
// ---------------------------------------------------------------------------------------------
const emptyResult = (
  source: string,
  scope: InstallScope,
  action: InstallAction,
  requestIndex?: number,
): InstallResult => ({
  source,
  skill: null,
  tool: null,
  scope,
  placementPath: null,
  action,
  reason: null,
  placement: null,
  store: null,
  origin: null,
  verify: null,
  candidates: null,
  ...(requestIndex === undefined ? {} : { requestIndex }),
});
// ---------------------------------------------------------------------------------------------
// verify gate (D11 mirror; install-specific --deep wiring)
// ---------------------------------------------------------------------------------------------
interface Gate {
  blocked: SkillSmithError | null;
  gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive';
  verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | null;
  mode: 'static' | 'static+deep' | null;
  notice: string | null;
}
const summarizeFindings = (tv: ToolVerdict<string> | undefined): string => {
  if (!tv) return 'no verdict produced';
  const findings = tv.modes
    .flatMap((m) => m.findings)
    .filter((fnd) => fnd.normalizedSeverity !== 'info');
  if (findings.length === 0) return `verdict ${tv.verdict}`;
  return findings.map((fnd) => `${fnd.checkId}: ${fnd.message}`).join('; ');
};
const runInstallVerifyGate = async (
  env: AcquisitionPorts,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
  tool: FlipTool,
  path: string,
  opts: InstallOptions,
  observation?: ObservationBundle,
): Promise<Gate> => {
  if (opts.noVerify) {
    return { blocked: null, gate: 'skipped', verdict: null, mode: null, notice: null };
  }
  const verification = registry.get(tool)?.verification;
  if (verification === undefined) {
    const blocked = genericError(`tool registry invariant: ${tool} has no verifier`);
    return { blocked, gate: 'failed', verdict: 'fail', mode: 'static', notice: null };
  }
  const deep = verification.gatePolicy.installDeep && opts.deep === true;
  const mode: 'static' | 'static+deep' = deep ? 'static+deep' : 'static';
  let untrustedVerification: unknown;
  try {
    const request = {
      path,
      tools: [tool],
      deep,
      strict: opts.strict ?? false,
      ...(observation === undefined ? {} : { observation }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    untrustedVerification =
      deps.verify === verifyPlugin
        ? await runVerify(env, request, verificationRegistryFor(registry))
        : await deps.verify(env, request);
  } catch (error) {
    const blocked = sourceUnresolvableError(`verification failed: ${safeUnknownMessage(error)}`);
    return { blocked, gate: 'failed', verdict: 'fail', mode, notice: null };
  }
  const vr = safeDependencyResult<VerifyReport<string>>(untrustedVerification);
  if (!vr.ok) {
    return {
      blocked: safeError(vr.error),
      gate: 'failed',
      verdict: 'fail',
      mode,
      notice: null,
    };
  }
  const tv = vr.value.tools.find((t) => t.tool === tool);
  const verdict = tv?.verdict ?? vr.value.summary.verdict;
  const outcome = evaluateVerificationGate({
    verdict,
    strict: opts.strict ?? false,
    requestedMode: mode,
  });
  let blocked: SkillSmithError | null = null;
  if (outcome.blocked) {
    if (verdict === 'fail') {
      blocked = flipFailedError(
        `installation blocked: '${path}' failed verification for ${tool}: ${summarizeFindings(tv)}`,
      );
    } else if (verdict === 'warn') {
      blocked = flipFailedError(`verify warnings blocked under --strict for ${tool}`);
    } else {
      blocked = flipFailedError(`verify gate inconclusive under --strict for ${tool}`);
    }
  }
  return {
    blocked,
    gate: outcome.gate,
    verdict,
    mode,
    notice:
      outcome.gate === 'inconclusive'
        ? `verify gate was inconclusive for ${tool}; proceeding unverified`
        : null,
  };
};
// ---------------------------------------------------------------------------------------------
// placement (per tool, scope)
// ---------------------------------------------------------------------------------------------
interface PlaceCtx {
  env: AcquisitionPorts;
  registry: LifecycleToolRegistry<string>;
  deps: InstallDeps;
  opts: InstallOptions;
  ledger: LedgerModel;
  ledgerPath: string;
  storeRoot: string;
  scope: InstallScope;
  scopeKey: string | null;
  projectRoot: string | null;
  installRootFor(tool: FlipTool): string;
  logicalOperation: ExecutableOperation | null;
  operationObservation: ObservationBundle | undefined;
}
const placeExecutionInput = (p: PlaceCtx): AcquireExecutionInput =>
  executionInputOf(p.env, p.ledgerPath, p.ledger, p.deps, p.opts, p.logicalOperation);
const resolveSelectedInstallPlacement = async (p: PlaceCtx, tool: FlipTool, skill: string) => {
  const roots = {
    cwd: p.scope === 'project' ? (p.scopeKey as string) : p.opts.cwd,
    configuration: p.opts.configuration,
  };
  const adapterResolution = await resolvePlacementFor(
    p.registry,
    tool,
    p.env,
    p.scope,
    roots,
    p.storeRoot,
    skill,
  );
  if (p.opts.path === undefined) return adapterResolution;
  const selected = await classifyPlacement(p.env, p.installRootFor(tool), skill, p.storeRoot);
  if (adapterResolution.duplicateReason !== null) return adapterResolution;
  if (
    selected.class !== 'absent' &&
    adapterResolution.placement.class !== 'absent' &&
    adapterResolution.placement.path !== selected.path
  ) {
    return {
      ...adapterResolution,
      placement: selected,
      duplicateReason: `'${skill}' exists at both ${selected.path} and ${adapterResolution.placement.path}`,
    };
  }
  if (
    selected.class !== 'absent' ||
    adapterResolution.placement.class === 'absent' ||
    adapterResolution.placement.path === selected.path
  ) {
    return { ...adapterResolution, placement: selected };
  }
  return adapterResolution;
};
// dir→dir routing: the swap engine rejects a same-kind copy-over-copy replace, so a copy re-install
// over a real dir is routed as two kind changes (dir→store-symlink, then store-symlink→dir). Every
// other transition (symlink→symlink re-pin, dir→symlink, symlink→dir) is a single swap the engine
// handles directly.
const replaceSwap = async (
  p: PlaceCtx,
  plan: SwapPlan,
  build: 'symlink' | 'copy',
  live: Placement,
  snap: SnapshotResult,
  sha: string,
  gate: Gate,
): Promise<Result<void, SkillSmithError>> => {
  const intermediatePinned =
    build === 'copy' && live.class === 'pinned'
      ? createAcquisitionPinnedRecord(snap, sha, 'symlink', gate.gate, nowOf(p.env, p.deps))
      : null;
  const executed = await executeAcquireReplacementWithObservation(
    placeExecutionInput(p),
    plan,
    intermediatePinned,
    p.operationObservation,
  );
  p.ledger = executed.state.ledger;
  if (!executed.ok) return err(executed.error);
  return ok(undefined);
};
const placePair = async (
  p: PlaceCtx,
  spec: SourceSpec,
  resolved: ResolvedSourceMaterialization,
  tool: FlipTool,
  snap: SnapshotResult,
  gate: Gate,
  storeReused: boolean,
): Promise<InstallResult> => {
  const { env, opts } = p;
  const skill = resolved.skillName;
  const sha = resolved.sha;
  const build: 'symlink' | 'copy' = opts.direct ? 'copy' : 'symlink';
  const installRoot = p.installRootFor(tool);
  const placementPath = join(installRoot, skill);
  const resultVerify =
    gate.gate === 'skipped' ? null : { gate: gate.gate, verdict: gate.verdict, mode: gate.mode };
  const originOut = {
    host: spec.identity.host,
    repo: spec.identity.repository,
    skillPath: resolved.skillPath,
    refRequested: spec.ref,
    refResolved: sha,
    pin: opts.pin ?? false,
  };
  const storeOut = {
    path: snap.storePath,
    rev: sha.slice(0, 12),
    gitSha: sha,
    reused: storeReused,
  };
  const base: InstallResult = {
    source: spec.canonicalInvocation,
    skill,
    tool,
    scope: p.scope,
    placementPath,
    action: 'installed',
    reason: null,
    placement: build,
    store: storeOut,
    origin: originOut,
    verify: resultVerify,
    candidates: null,
  };
  const refuse = (reason: string): InstallResult => ({
    ...base,
    action: 'refused',
    reason,
    placement: null,
    store: null,
    origin: null,
    error: flipRefusedError(reason),
  });
  const fail = (e: SkillSmithError): InstallResult => ({
    ...base,
    ...(e.code === 'cancelled' || (opts.signal?.aborted && msg(e) === 'interrupted')
      ? {
          action: 'skipped' as const,
          reason: 'interrupted',
          placement: null,
          store: null,
          origin: null,
          error: cancelledError('interrupted'),
        }
      : {
          action: 'failed' as const,
          reason: msg(e),
          placement: null,
          store: null,
          origin: null,
          error: safeError(e),
        }),
  });
  const currentResolution = await resolveSelectedInstallPlacement(p, tool, skill);
  if (currentResolution.duplicateReason !== null) {
    return refuse(currentResolution.duplicateReason);
  }
  if (
    currentResolution.placement.class !== 'absent' &&
    currentResolution.placement.root !== installRoot
  ) {
    const notice =
      currentResolution.notices.length === 0 ? '' : ` ${currentResolution.notices.join('; ')}`;
    return refuse(
      `'${skill}' already exists at ${currentResolution.placement.path}.${notice} Remove it first: skillsmith uninstall ${skill} --tool ${tool}`,
    );
  }
  try {
    await env.makeDir(installRoot);
  } catch (e) {
    return fail(genericError(`cannot create skills root ${installRoot}: ${errorMessage(e)}`));
  }
  // F5: cross-scope shadowing (project shadows user for this repo).
  let shadowWarning: string | null = null;
  const otherScope: InstallScope = p.scope === 'project' ? 'user' : 'project';
  const otherKey = otherScope === 'project' ? p.projectRoot : null;
  if (!(otherScope === 'project' && otherKey === null)) {
    const otherCtx = {
      cwd: otherScope === 'project' ? (otherKey as string) : opts.cwd,
      configuration: opts.configuration,
    };
    const otherResolution = await resolvePlacementFor(
      p.registry,
      tool,
      env,
      otherScope,
      otherCtx,
      p.storeRoot,
      skill,
    );
    const hasPair = getPairAt(p.ledger, otherKey, skill, tool) !== null;
    if (
      otherResolution.duplicateReason !== null ||
      otherResolution.placement.class !== 'absent' ||
      hasPair
    ) {
      const reason = `project-scope skills shadow user-scope skills of the same name for this repo: ${placementPath} vs ${otherResolution.placement.path}`;
      if (!opts.force) return refuse(reason);
      shadowWarning = `proceeding despite shadow (--force): ${reason}`;
    }
  }
  const existing = getPairAt(p.ledger, p.scopeKey, skill, tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    // Global Constraint #6: an unresolved journal refuses every operation EXCEPT a same-op re-run
    // (which RESUMES it to completion) and --rollback. A same-op install re-run drives the recorded
    // swap forward via the generic resumeSwap; a DIFFERENT interrupted op still refuses, naming that
    // journal's op for the same-op-re-run / --rollback recovery.
    if (existing.journal.op === 'install') {
      const wasFresh = existing.journal.before.mode === 'absent';
      const resumed = await recoverAcquireWithObservation(
        placeExecutionInput(p),
        { skill, tool, scopeKey: p.scopeKey },
        p.operationObservation,
      );
      p.ledger = resumed.state.ledger;
      if (!resumed.ok) {
        return fail(
          resumed.error.code === 'ledger-error'
            ? flipFailedError(msg(resumed.error))
            : resumed.error,
        );
      }
      const after = getPairAt(p.ledger, p.scopeKey, skill, tool);
      return {
        ...base,
        action: wasFresh ? 'installed' : 'updated',
        reason: resumed.value.warning ?? shadowWarning ?? gate.notice,
        placement: after?.pinned?.placement ?? base.placement,
        store: after?.pinned
          ? {
              path: after.pinned.storePath,
              rev: after.pinned.rev,
              gitSha: after.pinned.gitSha ?? sha,
              reused: true,
            }
          : base.store,
      };
    }
    return refuse(recoveryRefusedMessage(existing.journal.op, skill, spec.canonicalInvocation));
  }
  const live = currentResolution.placement;
  // Does the live placement already materialize THIS resolved store entry?
  let liveKind: 'symlink' | 'copy' | null = null;
  if (live.class === 'store-linked' && live.symlinkTarget === snap.storePath) {
    liveKind = 'symlink';
  } else if (live.class === 'pinned') {
    const h = await contentHashOf(env, live.path);
    if (h.ok && h.value === snap.contentHash) liveKind = 'copy';
  }
  const finalize = (action: InstallAction): InstallResult => ({
    ...base,
    action,
    reason: shadowWarning ?? gate.notice,
  });
  // Idempotence / repair (F7 / D14) — only when not forcing.
  if (liveKind !== null && !opts.force) {
    const recordMatches =
      existing?.origin?.refResolved === sha &&
      existing.pinned?.storePath === snap.storePath &&
      (existing.pinned?.placement ?? 'copy') === liveKind;
    if (recordMatches) {
      return { ...finalize('noop'), reason: `already installed at ${sha.slice(0, 12)}` };
    }
    // Placement intact + matching the resolved store entry but the record is missing/stale →
    // rewrite the pair record only (no filesystem change).
    const pinned = createAcquisitionPinnedRecord(
      snap,
      sha,
      liveKind,
      gate.gate,
      nowOf(p.env, p.deps),
    );
    const origin = createAcquisitionOriginRecord(
      spec,
      sha,
      resolved.skillPath,
      opts.pin ?? false,
      nowOf(p.env, p.deps),
    );
    const repaired: PairRecord = {
      placementPath,
      mode: 'pinned',
      dev: existing?.dev ?? null,
      pinned,
      origin,
      journal: null,
    };
    if (p.logicalOperation === null) {
      return fail(
        flipFailedError('record-only install repair requires logical operation identity'),
      );
    }
    const persisted = await executeRecordOnlyAcquirePlanWithObservation(
      placeExecutionInput(p),
      p.logicalOperation,
      repaired,
      p.scopeKey,
      p.operationObservation,
    );
    p.ledger = persisted.state.ledger;
    if (!persisted.ok) return fail(persisted.error);
    return { ...finalize('repaired'), placement: liveKind };
  }
  const pinned = createAcquisitionPinnedRecord(snap, sha, build, gate.gate, nowOf(p.env, p.deps));
  const origin = createAcquisitionOriginRecord(
    spec,
    sha,
    resolved.skillPath,
    opts.pin ?? false,
    nowOf(p.env, p.deps),
  );
  // Adopt a genuine dev symlink (points outside the store) so nothing is lost on rollback.
  const adoptedDev =
    live.class === 'dev' && live.symlinkTarget !== null
      ? {
          sourcePath: live.symlinkTarget,
          resolvedPath: resolveSymlinkAbsolute(placementPath, live.symlinkTarget),
          repoRoot: null,
          sourceRelPath: null,
          remote: null,
          recordedAt: nowOf(p.env, p.deps),
        }
      : null;
  const plan: SwapPlan = {
    op: 'install',
    skill,
    tool,
    skillsRoot: installRoot,
    placementPath,
    scopeKey: p.scopeKey,
    install: {
      build,
      storePath: snap.storePath,
      contentHash: snap.contentHash,
      pinned,
      origin,
      adoptedDev,
    },
  };
  // Fresh install: the slot is empty. Clear any stale records so the engine lands on an empty slot.
  if (live.class === 'absent') {
    if (existing && (existing.pinned || existing.dev)) {
      const cleared = withoutLedgerPairAt(p.ledger, p.scopeKey, skill, tool);
      if (!cleared.ok) return fail(cleared.error);
      p.ledger = cleared.value;
    }
    const r = await executeAcquirePlanWithObservation(
      placeExecutionInput(p),
      plan,
      p.operationObservation,
    );
    p.ledger = r.state.ledger;
    if (!r.ok)
      return fail(r.error.code === 'ledger-error' ? flipFailedError(msg(r.error)) : r.error);
    if (r.value.warning)
      shadowWarning = shadowWarning ? `${shadowWarning}; ${r.value.warning}` : r.value.warning;
    return { ...finalize('installed'), store: { ...storeOut, reused: storeReused } };
  }
  // Replace. A managed pair for this same repo may update freely; anything else needs --force.
  const managed = existing?.origin?.repo === spec.identity.repository;
  if (!managed && !opts.force) {
    const recorded = existing?.origin ? existing.origin.repo : 'unmanaged';
    return refuse(
      `'${skill}' (${tool}) already exists at ${placementPath} (recorded origin: ${recorded}); re-run with --force to overwrite`,
    );
  }
  const swapRes = await replaceSwap(p, plan, build, live, snap, sha, gate);
  if (!swapRes.ok) {
    return fail(
      swapRes.error.code === 'ledger-error' ? flipFailedError(msg(swapRes.error)) : swapRes.error,
    );
  }
  return { ...finalize('updated'), store: { ...storeOut, reused: storeReused } };
};
// ---------------------------------------------------------------------------------------------
// dry-run prediction (read-only)
// ---------------------------------------------------------------------------------------------
const desiredInstallPreview = (
  p: PlaceCtx,
  spec: SourceSpec,
  resolved: ResolvedSourceMaterialization,
  tool: FlipTool,
): InstallResult => {
  const { opts } = p;
  const skill = resolved.skillName;
  const sha = resolved.sha;
  const build: 'symlink' | 'copy' = opts.direct ? 'copy' : 'symlink';
  const installRoot = p.installRootFor(tool);
  const placementPath = join(installRoot, skill);
  const { ns, name } = clampStoreNs(spec.identity.repository);
  const expectedStorePath = join(p.storeRoot, ns, `${name}@${sha.slice(0, 12)}`, skill);
  const base: InstallResult = {
    source: spec.canonicalInvocation,
    skill,
    tool,
    scope: p.scope,
    placementPath,
    action: 'installed',
    reason: null,
    placement: build,
    store: { path: expectedStorePath, rev: sha.slice(0, 12), gitSha: sha, reused: false },
    origin: {
      host: spec.identity.host,
      repo: spec.identity.repository,
      skillPath: resolved.skillPath,
      refRequested: spec.ref,
      refResolved: sha,
      pin: opts.pin ?? false,
    },
    verify: null,
    candidates: null,
  };
  return base;
};
const predictPair = async (
  p: PlaceCtx,
  spec: SourceSpec,
  resolved: ResolvedSourceMaterialization,
  tool: FlipTool,
): Promise<InstallResult> => {
  const { env, opts } = p;
  const skill = resolved.skillName;
  const sha = resolved.sha;
  const base = desiredInstallPreview(p, spec, resolved, tool);
  const installRoot = p.installRootFor(tool);
  const placementPath = base.placementPath;
  const expectedStorePath = base.store?.path;
  if (placementPath === null || expectedStorePath === undefined) {
    throw new Error('install desired preview placement facts are missing');
  }
  const refuse = (reason: string): InstallResult => ({
    ...base,
    action: 'refused',
    reason,
    placement: null,
    store: null,
    origin: null,
    error: flipRefusedError(reason),
  });
  const currentResolution = await resolveSelectedInstallPlacement(p, tool, skill);
  if (currentResolution.duplicateReason !== null) {
    return refuse(currentResolution.duplicateReason);
  }
  if (
    currentResolution.placement.class !== 'absent' &&
    currentResolution.placement.root !== installRoot
  ) {
    const notice =
      currentResolution.notices.length === 0 ? '' : ` ${currentResolution.notices.join('; ')}`;
    return refuse(
      `'${skill}' already exists at ${currentResolution.placement.path}.${notice} Remove it first: skillsmith uninstall ${skill} --tool ${tool}`,
    );
  }
  const otherScope: InstallScope = p.scope === 'project' ? 'user' : 'project';
  const otherKey = otherScope === 'project' ? p.projectRoot : null;
  if (!(otherScope === 'project' && otherKey === null)) {
    const otherCtx = {
      cwd: otherScope === 'project' ? (otherKey as string) : opts.cwd,
      configuration: opts.configuration,
    };
    const otherResolution = await resolvePlacementFor(
      p.registry,
      tool,
      env,
      otherScope,
      otherCtx,
      p.storeRoot,
      skill,
    );
    const shadowed =
      otherResolution.duplicateReason !== null ||
      otherResolution.placement.class !== 'absent' ||
      getPairAt(p.ledger, otherKey, skill, tool) !== null;
    if (shadowed && !opts.force) {
      return refuse(
        `project-scope skills shadow user-scope skills of the same name for this repo: ${placementPath} vs ${otherResolution.placement.path}`,
      );
    }
  }
  const existing = getPairAt(p.ledger, p.scopeKey, skill, tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    // A same-op install re-run would RESUME to completion (#6); a different op still refuses.
    if (existing.journal.op === 'install') {
      return {
        ...base,
        action: existing.journal.before.mode === 'absent' ? 'installed' : 'updated',
      };
    }
    return refuse(recoveryRefusedMessage(existing.journal.op, skill, spec.canonicalInvocation));
  }
  const live = currentResolution.placement;
  if (live.class === 'absent') return { ...base, action: 'installed' };
  const matchesResolved =
    (live.class === 'store-linked' && live.symlinkTarget === expectedStorePath) ||
    live.class === 'pinned';
  if (matchesResolved && !opts.force) {
    if (existing?.origin?.refResolved === sha) {
      return { ...base, action: 'noop', reason: `already installed at ${sha.slice(0, 12)}` };
    }
    return { ...base, action: 'repaired', placement: null };
  }
  const managed = existing?.origin?.repo === spec.identity.repository;
  if (!managed && !opts.force) {
    const recorded = existing?.origin ? existing.origin.repo : 'unmanaged';
    return refuse(
      `'${skill}' (${tool}) already exists at ${placementPath} (recorded origin: ${recorded}); re-run with --force to overwrite`,
    );
  }
  return { ...base, action: 'updated' };
};
// ---------------------------------------------------------------------------------------------
// report assembly
// ---------------------------------------------------------------------------------------------
const closedPlanningText = (value: string | null, fallback: string): string =>
  value !== null && value.length > 0 && !containsSensitiveMaterial(value) ? value : fallback;
const createInstallForceEffect = (
  operation: ExecutableOperation,
  requested: boolean,
  applied = false,
) =>
  !requested || operation.conflict === null
    ? createBoundedForceEffect({
        supported: true,
        requested,
        conflict: null,
      })
    : createBoundedForceEffect({
        supported: true,
        requested: true,
        applied,
        conflict: operation.conflict,
      });
const createInstallExecutionResult = (
  operation: ExecutableOperation,
  result: InstallResult | undefined,
  requested: InstallReport['requested'],
  actualBefore: OperationImage = operation.before,
): OperationExecutionResult => {
  const cancelled =
    result?.action === 'skipped' &&
    (result.reason === 'interrupted' || result.error?.code === 'cancelled');
  const skippedAfterFailure = result?.action === 'skipped' && result.reason === 'fail-fast';
  const succeeded =
    result?.action === 'installed' || result?.action === 'updated' || result?.action === 'repaired';
  const actualAfter = succeeded ? operation.after : actualBefore;
  const common = {
    operationId: operation.operationId,
    actualBefore,
    actualAfter,
    force: createInstallForceEffect(operation, requested.force, succeeded),
  } as const;
  if (cancelled) {
    return createOperationExecutionResult({ ...common, outcome: 'cancelled', error: null });
  }
  if (skippedAfterFailure) {
    return createOperationExecutionResult({
      ...common,
      outcome: 'skipped-after-failure',
      error: null,
    });
  }
  if (!succeeded) {
    return createOperationExecutionResult({
      ...common,
      outcome: 'failed',
      error: {
        code: result?.error?.code ?? 'install-failed',
        message: closedPlanningText(result?.reason ?? null, 'prepared install binding failed'),
        remediation: 'Resolve the reported condition and retry the same selection.',
      },
    });
  }
  return createOperationExecutionResult({ ...common, outcome: 'succeeded', error: null });
};
const installSummary = (results: readonly InstallResult[]): InstallReport['summary'] => {
  const summary = {
    installed: 0,
    updated: 0,
    repaired: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
  };
  for (const result of results) summary[result.action]++;
  return summary;
};
type InstallArtifactResolution = Awaited<
  ReturnType<typeof resolveAcquisitionArtifactDestinationV1>
>;
interface InstallReportAssemblyContext {
  readonly artifact?: InstallArtifactResolution;
  readonly path?: string;
  readonly groupByResult?: ReadonlyMap<string, string>;
}
const installResultFactKey = (
  result: Pick<InstallResult, 'requestIndex' | 'skill' | 'tool' | 'scope'>,
): string => JSON.stringify([result.requestIndex ?? null, result.skill, result.tool, result.scope]);
const currentInstallArtifactEffects = (
  plan: OperationPlan<'install'>,
  executionResults: readonly OperationExecutionResult[],
  results: readonly InstallResult[],
  groupByResult: ReadonlyMap<string, string>,
  dryRun: boolean,
): CurrentInstallReport['artifactEffects'] => {
  const executionById = new Map(
    executionResults.map((execution) => [execution.operationId, execution]),
  );
  const groupIds = [
    ...new Set([
      ...groupByResult.values(),
      ...plan.operations
        .filter(
          ({ kind }) =>
            kind === 'migrate-project-config' || kind === 'write-manifest' || kind === 'write-lock',
        )
        .map(({ groupId }) => groupId),
    ]),
  ].sort();
  return groupIds.map((groupId) => {
    const operations = plan.operations.filter((operation) => operation.groupId === groupId);
    const migration = operations.find(({ kind }) => kind === 'migrate-project-config');
    const manifest = operations.find(({ kind }) => kind === 'write-manifest');
    const lock = operations.find(({ kind }) => kind === 'write-lock');
    const executions = [migration, manifest, lock].flatMap((operation) => {
      if (operation === undefined) return [];
      const execution = executionById.get(operation.operationId);
      return execution === undefined ? [] : [execution];
    });
    const failed = executions.find(
      ({ outcome }) => outcome !== 'succeeded' && outcome !== 'skipped-after-failure',
    );
    const skipped = executions.find(({ outcome }) => outcome === 'skipped-after-failure');
    const skill =
      results.find((result) => groupByResult.get(installResultFactKey(result)) === groupId)
        ?.skill ?? null;
    return {
      groupId,
      skill,
      manifestAction:
        manifest === undefined ? 'keep' : manifest.before.kind === 'absent' ? 'create' : 'update',
      lockAction: lock === undefined ? 'keep' : lock.before.kind === 'absent' ? 'create' : 'update',
      migration:
        migration === undefined
          ? 'none'
          : dryRun
            ? 'planned'
            : executionById.get(migration.operationId)?.outcome === 'succeeded'
              ? 'applied'
              : 'failed',
      outcome: dryRun
        ? 'planned'
        : (failed?.outcome ??
          skipped?.outcome ??
          (executions.length === 0 ? 'succeeded' : 'succeeded')),
      reason: failed?.error?.message ?? null,
    };
  });
};
const assembleInstallReport = (
  dryRun: boolean,
  requested: InstallReport['requested'],
  results: InstallResult[],
  plan: OperationPlan<'install'>,
  executionResults: readonly OperationExecutionResult[],
  context: InstallReportAssemblyContext = {},
): PlannedInstallReport => {
  const artifact =
    context.artifact ??
    ({
      outcome: 'none',
      saveMode: 'desired-state',
      pair: null,
      selection: { outcome: 'none', reason: 'pre-resolution-failure' },
    } as const);
  const groupByResult = context.groupByResult ?? new Map<string, string>();
  const executionById = new Map(
    executionResults.map((execution) => [execution.operationId, execution]),
  );
  const currentResults: CurrentInstallResult[] = results.map((result, requestIndex) => {
    const groupId = groupByResult.get(installResultFactKey(result)) ?? null;
    const operation =
      groupId === null
        ? undefined
        : plan.operations.find(
            (candidate) =>
              candidate.groupId === groupId &&
              candidate.tool === result.tool &&
              candidate.skill === result.skill &&
              candidate.pairId !== null,
          );
    const execution =
      operation === undefined ? undefined : executionById.get(operation.operationId);
    const artifactOperations =
      groupId === null
        ? []
        : plan.operations.filter(
            (candidate) =>
              candidate.groupId === groupId &&
              (candidate.kind === 'migrate-project-config' ||
                candidate.kind === 'write-manifest' ||
                candidate.kind === 'write-lock'),
          );
    const artifactDurable =
      artifact.saveMode === 'desired-state' &&
      (dryRun ||
        artifactOperations.every(
          (candidate) => executionById.get(candidate.operationId)?.outcome === 'succeeded',
        ));
    const executionOutcome = dryRun
      ? null
      : (execution?.outcome ?? (result.action === 'noop' && artifactDurable ? 'succeeded' : null));
    const dryRunWouldSucceed =
      dryRun &&
      (result.action === 'installed' ||
        result.action === 'updated' ||
        result.action === 'repaired' ||
        result.action === 'noop');
    const drift: CurrentInstallResult['drift'] =
      artifact.saveMode === 'live-only'
        ? {
            status: 'not-evaluated',
            futureApply: 'depends-on-selected-manifest',
            reason: null,
          }
        : executionOutcome === 'succeeded' || dryRunWouldSucceed
          ? { status: 'in-sync', futureApply: 'none', reason: null }
          : artifactDurable
            ? {
                status: 'desired-without-live',
                futureApply: 'restore-live',
                reason: result.reason ?? 'selected live placement did not complete',
              }
            : {
                status: 'not-evaluated',
                futureApply: 'restore-live',
                reason: result.reason ?? 'portable intent did not complete',
              };
    return {
      ...result,
      requestIndex: result.requestIndex ?? requestIndex,
      groupId,
      pairId: operation?.pairId ?? null,
      executionOutcome,
      drift,
      force: (execution?.force ??
        (result.tool === null
          ? createBoundedForceEffect({
              supported: false,
              requested: false,
              conflict: null,
            })
          : operation === undefined
            ? createBoundedForceEffect({
                supported: true,
                requested: requested.force,
                conflict: null,
              })
            : createInstallForceEffect(
                operation,
                requested.force,
              ))) as CurrentInstallResult['force'],
    };
  });
  const artifactEffects =
    artifact.saveMode === 'live-only'
      ? []
      : currentInstallArtifactEffects(plan, executionResults, results, groupByResult, dryRun);
  const legacySummary = installSummary(results);
  const desiredState = {
    changed: artifactEffects.filter(
      ({ manifestAction, lockAction }) =>
        manifestAction === 'create' ||
        manifestAction === 'update' ||
        lockAction === 'create' ||
        lockAction === 'update',
    ).length,
    unchanged: artifactEffects.filter(
      ({ manifestAction, lockAction }) => manifestAction === 'keep' && lockAction === 'keep',
    ).length,
    retained: 0,
    notWritten: artifact.saveMode === 'live-only' ? currentResults.length : 0,
    failed: artifactEffects.filter(
      ({ outcome }) => outcome !== 'planned' && outcome !== 'succeeded' && outcome !== 'not-run',
    ).length,
  };
  return {
    reportVersion: 2,
    dryRun,
    saveMode: artifact.saveMode,
    artifactPair:
      artifact.outcome === 'selected'
        ? {
            manifestPath: artifact.pair.file.path,
            lockPath: artifact.pair.lockfile.path,
            lockSource: artifact.pair.lockfileSource,
          }
        : null,
    artifactSelection: artifact.selection,
    artifactEffects,
    requested: {
      ...requested,
      batchPolicy: plan.batchPolicy,
      path: context.path ?? null,
    },
    results: currentResults,
    summary: { ...legacySummary, desiredState },
    plan,
    executionResults,
  };
};
const createInstallDiagnosticReport = (
  dryRun: boolean,
  requested: InstallReport['requested'],
  results: InstallResult[],
  continueOnError: boolean,
  registry: LifecycleToolRegistry<string>,
  reportContext: InstallReportAssemblyContext = {},
): PlannedInstallReport => {
  const planningContext = { registry, toolOrder: registry.ids };
  const compatibility = createInstallPlanning(
    requested,
    results,
    continueOnError,
    null,
    planningContext,
  );
  const planned = createAcquisitionDiagnosticPlan(
    {
      schemaVersion: 1,
      command: 'install',
      selection: {
        source: 'explicit-targets',
        skills: [...new Set(results.flatMap(({ skill }) => (skill === null ? [] : [skill])))],
        tools: [...new Set(results.flatMap(({ tool }) => (tool === null ? [] : [tool])))],
        scopes: [requested.scope],
      },
      batchPolicy: continueOnError ? 'continue-on-error' : 'fail-fast',
      diagnostics: compatibility.plan.diagnostics,
    },
    planningContext,
  );
  if (!planned.ok) throw new Error(planned.error.message);
  return assembleInstallReport(dryRun, requested, results, planned.value, [], reportContext);
};
const rejectedSourceLabel = (input: string): string => {
  const safe = redactSensitiveString(input);
  return safe === input ? '[REJECTED_SOURCE]' : safe;
};
const rejectedRefLabel = (input: string): string => {
  const safe = redactSensitiveString(input);
  return safe === input ? '[REJECTED_REF]' : safe;
};
// ---------------------------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------------------------
const runInstallInternal = async (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation?: ObservationBundle,
  planObservation?: AcquisitionPlanObservationState,
): Promise<Result<PlannedInstallReport, SkillSmithError>> => {
  const dataDir = resolveDataDir(env, opts.configuration);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const explicitTools = opts.tools !== undefined && opts.tools.length > 0;
  // ---- Phase 0: pure pre-flight (no I/O) ----
  const overrideAllowed = opts.ref !== undefined && opts.sources.length === 1;
  const parsed = opts.sources.map((input, requestIndex) => {
    const baseRes = parseSource(input);
    const res = overrideAllowed ? parseSource(input, { overrideRef: opts.ref as string }) : baseRes;
    return { input, requestIndex, baseRes, res };
  });
  const sourceLabel = (
    input: string,
    baseRes: (typeof parsed)[number]['baseRes'],
    res: (typeof parsed)[number]['res'],
  ): string =>
    res.ok
      ? res.value.canonicalInvocation
      : baseRes.ok
        ? baseRes.value.canonicalInvocation
        : rejectedSourceLabel(input);
  const sourceLabels = parsed.map(({ input, baseRes, res }) => sourceLabel(input, baseRes, res));
  const fallbackScope: InstallScope = opts.scope ?? 'user';
  const requestedRef =
    opts.ref === undefined
      ? null
      : containsSensitiveMaterial(opts.ref) || !validateRequestedRef(opts.ref, 'install.ref').ok
        ? rejectedRefLabel(opts.ref)
        : opts.ref;
  const requestedBase = {
    sources: sourceLabels,
    explicitTools,
    ref: requestedRef,
    pin: opts.pin ?? false,
    direct: opts.direct ?? false,
    force: opts.force ?? false,
    verify: (opts.noVerify ? 'skipped' : 'static') as 'static' | 'skipped',
    deep: Boolean(opts.deep),
  };
  const earlyReportContext: InstallReportAssemblyContext = {
    ...(opts.noSave
      ? {
          artifact: Object.freeze({
            outcome: 'none' as const,
            saveMode: 'live-only' as const,
            pair: null,
            selection: Object.freeze({
              outcome: 'none' as const,
              reason: 'no-save' as const,
            }),
          }) as InstallArtifactResolution,
        }
      : {}),
    ...(opts.path === undefined ? {} : { path: opts.path }),
  };
  const anyParseFail = parsed.some((x) => !x.res.ok);
  if (anyParseFail) {
    // Resolution 3: whole invocation refuses before any I/O.
    const results: InstallResult[] = parsed.map(({ input, requestIndex, baseRes, res }) => {
      const label = sourceLabel(input, baseRes, res);
      if (!res.ok) {
        return {
          ...emptyResult(label, fallbackScope, 'refused', requestIndex),
          reason: msg(res.error),
          error: safeError(res.error),
        };
      }
      return {
        ...emptyResult(label, fallbackScope, 'skipped', requestIndex),
        reason: 'fail-fast',
      };
    });
    return ok(
      createInstallDiagnosticReport(
        false,
        {
          ...requestedBase,
          tools: [],
          scope: fallbackScope,
          explicitScope: opts.scope !== undefined,
        },
        results,
        Boolean(opts.continueOnError),
        registry,
        earlyReportContext,
      ),
    );
  }
  // --ref rules.
  if (opts.ref !== undefined && opts.sources.length > 1) {
    const results = parsed.map(({ input, requestIndex, baseRes, res }) => ({
      ...emptyResult(sourceLabel(input, baseRes, res), fallbackScope, 'refused', requestIndex),
      reason: '--ref is only valid with exactly one <source>',
      error: flipRefusedError('--ref is only valid with exactly one <source>'),
    }));
    return ok(
      createInstallDiagnosticReport(
        false,
        {
          ...requestedBase,
          tools: [],
          scope: fallbackScope,
          explicitScope: opts.scope !== undefined,
        },
        results,
        Boolean(opts.continueOnError),
        registry,
        earlyReportContext,
      ),
    );
  }
  const specs: { source: string; spec: SourceSpec; requestIndex: number }[] = parsed.map(
    ({ requestIndex, res }) => {
      const spec = (res as { ok: true; value: SourceSpec }).value;
      return { source: spec.canonicalInvocation, spec, requestIndex };
    },
  );
  // ---- Phase 1: target planning (local I/O only) ----
  const projectContext = await resolveAcquisitionProjectContextV1({
    env,
    cwd: opts.cwd,
    ...(opts.configuration.explicitConfigPath === undefined
      ? {}
      : { explicitConfigPath: opts.configuration.explicitConfigPath }),
  });
  const projectRoot = projectContext.projectRoot;
  const scope: InstallScope = opts.scope ?? (projectRoot ? 'project' : 'user');
  const scopeKey = scope === 'project' ? (projectRoot ?? (await env.realpath(opts.cwd))) : null;
  const explicitScope = opts.scope !== undefined;
  const selectedInstallRootFor = (tool: FlipTool, roots: { cwd: string }): string => {
    if (opts.path === undefined) {
      return destinationSkillRootFor(registry, tool, env, scope, {
        cwd: roots.cwd,
        configuration: opts.configuration,
      });
    }
    if (opts.path.startsWith('~/')) return resolve(env.homeDir, opts.path.slice(2));
    if (opts.path.startsWith('./')) {
      return resolve(scope === 'project' ? (scopeKey as string) : roots.cwd, opts.path.slice(2));
    }
    return isAbsolute(opts.path) ? resolve(opts.path) : resolve(roots.cwd, opts.path);
  };
  const installTools = registry.toolsFor('install') as readonly FlipTool[];
  const candidateTools = explicitTools
    ? [...(opts.tools as readonly FlipTool[])]
    : [...installTools];
  const detectedTools: FlipTool[] = [];
  const undetectedExplicit: FlipTool[] = [];
  for (const tool of candidateTools) {
    const d = safeDependencyResult<readonly unknown[]>(
      await detectAcquireToolWithObservation(
        env,
        tool,
        opts.signal,
        deps,
        defaultInstallDetect,
        registry,
        observation,
      ),
    );
    if (!d.ok) return d;
    if (!Array.isArray(d.value)) return err(genericError('tool detection failed'));
    if (d.value.length > 0) detectedTools.push(tool);
    else if (explicitTools) undetectedExplicit.push(tool);
  }
  const requested: InstallReport['requested'] = {
    ...requestedBase,
    tools: detectedTools,
    scope,
    explicitScope,
  };
  // Planning refusals: explicitly named but undetected tools → exit-4 per source.
  const planningRefusals: InstallResult[] = [];
  for (const tool of undetectedExplicit) {
    const e = toolUnavailableError(
      `${tool} is not detected; install it first: ${installHintFor(registry, tool)}`,
    );
    for (const { source, requestIndex } of specs) {
      planningRefusals.push({
        ...emptyResult(source, scope, 'refused', requestIndex),
        tool,
        reason: msg(e),
        error: safeError(e),
      });
    }
  }
  if (detectedTools.length === 0) {
    if (!explicitTools) {
      const e = toolUnavailableError(`no supported tool detected (${installTools.join(', ')})`);
      const results = specs.map(({ source, requestIndex }) => ({
        ...emptyResult(source, scope, 'refused', requestIndex),
        reason: msg(e),
        error: safeError(e),
      }));
      return ok(
        createInstallDiagnosticReport(
          false,
          requested,
          results,
          Boolean(opts.continueOnError),
          registry,
          earlyReportContext,
        ),
      );
    }
    return ok(
      createInstallDiagnosticReport(
        false,
        requested,
        planningRefusals,
        Boolean(opts.continueOnError),
        registry,
        earlyReportContext,
      ),
    );
  }
  interface PreparedInstallPairBinding {
    readonly kind: 'pair';
    readonly preview: InstallResult;
    readonly reportPreviews: readonly InstallResult[];
    readonly actualBefore: OperationImage;
    readonly liveResourceId: string;
    readonly storeResourceId: string;
    observe(): Promise<InstallPreconditionFacts>;
    execute(
      operation: ExecutableOperation,
      operationObservation?: ObservationBundle,
    ): Promise<InstallResult>;
  }
  interface PreparedInstallMigrationBinding {
    readonly kind: 'migrate-ledger';
    readonly expectedState: Extract<LedgerReadState, { readonly state: 'present' }>;
    onMigrated(model: LedgerModel): void;
  }
  interface PreparedInstallArtifactBinding {
    readonly kind: 'artifact';
    readonly action: AcquisitionArtifactExecutionActionV1;
  }
  type PreparedInstallBinding =
    | PreparedInstallPairBinding
    | PreparedInstallMigrationBinding
    | PreparedInstallArtifactBinding;
  interface PreparedInstallBatch {
    readonly preview: PlannedInstallReport;
    readonly legacyPreviewResults: readonly InstallResult[];
    readonly bindings: ReadonlyMap<string, PreparedInstallBinding>;
    readonly preconditions: readonly ExecutionPrecondition[];
    readonly snapshotAuthority: AcquisitionSnapshotAuthorityV1;
    readonly expectedRevisions: readonly ExpectedRevisionV1[];
    readonly snapshotId: `snapshot:v1:${string}`;
    readonly artifactResolution: InstallArtifactResolution;
    readonly groupByResult: ReadonlyMap<string, string>;
  }
  type PreparedInstallOutcome = PreparedInstallBatch | Readonly<{ terminal: PlannedInstallReport }>;
  interface InstallPreconditionFacts {
    readonly projectRoot: string | null;
    readonly selectedPair: PairRecord | null;
    readonly live: AcquirePlacementFacts;
    readonly alternates: readonly AcquirePlacementFacts[];
    readonly shadow: Readonly<{
      pair: PairRecord | null;
      live: readonly AcquirePlacementFacts[];
    }> | null;
    readonly source: Readonly<{
      canonicalSource: string;
      repository: string;
      resolvedSha: string;
      skillPath: string;
      content: Readonly<{
        pathKind: AcquireContentFacts['pathKind'];
        contentHash: string | null;
      }>;
    }>;
    readonly store: AcquireContentFacts;
  }
  interface InstallBindingSeed {
    readonly preview: InstallResult;
    readonly reportPreviews: readonly InstallResult[];
    readonly requestIndex: number;
    readonly spec: SourceSpec;
    readonly resolved: ResolvedSourceMaterialization;
    readonly tool: FlipTool;
    readonly execution: 'selected' | 'desired-only';
    execute(): Promise<InstallResult>;
  }
  interface PreparedInstallIntent {
    readonly seed: InstallBindingSeed;
    readonly expectedFacts: InstallPreconditionFacts;
    readonly intent: AcquisitionInstallIntentV1;
  }
  interface PreparedInstallArtifactPlanning {
    readonly transition: AcquisitionArtifactTransitionEnvelopeV1 | undefined;
    readonly actions: ReadonlyMap<string, AcquisitionArtifactExecutionActionV1>;
  }
  type InstallVerificationGate = Awaited<ReturnType<typeof runInstallVerifyGate>>;
  interface InstallResolutionAuthority {
    readonly sources: ReadonlyMap<number, ResolveRemoteSourceOutcome>;
    readonly gates: ReadonlyMap<string, InstallVerificationGate>;
    readonly duplicateNames: readonly string[];
    readonly artifact: Awaited<ReturnType<typeof resolveAcquisitionArtifactDestinationV1>>;
    cleanup(): Promise<void>;
  }
  const gateKey = (requestIndex: number, tool: FlipTool): string => `${requestIndex}:${tool}`;
  const artifactBindingKey = (groupId: string, kind: ExecutableOperation['kind']): string =>
    `${groupId}:${kind}`;
  const portableSourceToken = (declaration: NormalizedManifestDeclaration): string =>
    `${declaration.source.host}/${declaration.source.repository}${
      declaration.source.path === null ? '' : `//${declaration.source.path}`
    }`;
  const samePortableValue = (left: unknown, right: unknown): boolean =>
    canonicalPlanningString(left) === canonicalPlanningString(right);
  const manifestEditsForDeclaration = (
    current: NormalizedManifestDeclaration | undefined,
    desired: NormalizedManifestDeclaration,
  ): readonly ManifestEdit[] => {
    if (current === undefined) return [{ kind: 'add-skill', declaration: desired }];
    const edits: ManifestEdit[] = [];
    if (!samePortableValue(current.source, desired.source)) {
      edits.push({
        kind: 'set-skill-field',
        name: desired.name,
        field: 'source',
        value: portableSourceToken(desired),
      });
    }
    for (const field of ['ref', 'path'] as const) {
      if (current[field] === desired[field]) continue;
      if (desired[field] === null) {
        edits.push({ kind: 'unset-skill-field', name: desired.name, field });
      } else {
        edits.push({
          kind: 'set-skill-field',
          name: desired.name,
          field,
          value: desired[field],
        });
      }
    }
    if (!samePortableValue(current.tools, desired.tools)) {
      edits.push({
        kind: 'set-skill-field',
        name: desired.name,
        field: 'tools',
        value: desired.tools,
      });
    }
    for (const field of ['scope', 'placement'] as const) {
      if (current[field] === desired[field]) continue;
      edits.push({
        kind: 'set-skill-field',
        name: desired.name,
        field,
        value: desired[field],
      } as ManifestEdit);
    }
    return edits;
  };
  const manifestWithDeclaration = (
    manifest: NormalizedManifestV1,
    declaration: NormalizedManifestDeclaration,
  ): NormalizedManifestV1 => {
    const index = manifest.skills.findIndex(({ name }) => name === declaration.name);
    const skills = [...manifest.skills];
    if (index < 0) skills.push(declaration);
    else skills[index] = declaration;
    return Object.freeze({ ...manifest, skills: Object.freeze(skills) });
  };
  const lockWithEntry = (
    lock: PortableLockV1,
    manifest: NormalizedManifestV1,
    entry: PortableLockSkillV1,
  ): PortableLockV1 =>
    Object.freeze({
      version: 1,
      hashSchemaVersion: HASH_SCHEMA_VERSION,
      manifestHash: hashManifestSemantics(manifest),
      skills: Object.freeze(
        [...lock.skills.filter(({ name }) => name !== entry.name), entry].sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        ),
      ),
    });
  const prepareInstallArtifactPlanning = async (
    snapshotAuthority: AcquisitionSnapshotAuthorityV1,
    prepared: readonly PreparedInstallIntent[],
  ): Promise<PreparedInstallArtifactPlanning> => {
    const artifact = snapshotAuthority.snapshot.artifact;
    if (artifact.mode === 'none') {
      return Object.freeze({ transition: undefined, actions: new Map() });
    }
    if (prepared.length === 0) {
      throw new Error('selected install artifact has no complete intent');
    }
    const manifestPath = artifact.pair.file.path;
    const lockPath = artifact.pair.lockfile.path;
    let manifestBytes: Uint8Array | null;
    let manifestImage: AcquisitionArtifactTransitionEnvelopeV1['initial']['manifest'];
    let manifestModel: NormalizedManifestV1;
    if (artifact.manifest.revision.state === 'absent') {
      manifestBytes = null;
      manifestImage = Object.freeze({
        kind: 'absent' as const,
        resource: Object.freeze({
          kind: 'manifest-bytes' as const,
          location: Object.freeze({ kind: 'machine-bound' as const, path: manifestPath }),
        }),
      });
      manifestModel = Object.freeze({ version: 1 as const, skills: Object.freeze([]) });
    } else {
      manifestBytes = new Uint8Array(await env.readBytes(manifestPath));
      manifestImage = acquisitionManifestImageFromBytesV1(manifestPath, manifestBytes);
      if (artifact.manifest.value === null) {
        throw new Error('selected install manifest model is missing');
      }
      manifestModel = artifact.manifest.value;
    }
    let lockImage: AcquisitionArtifactTransitionEnvelopeV1['initial']['lock'];
    let lockModel: PortableLockV1;
    if (artifact.lock.revision.state === 'absent') {
      lockImage = Object.freeze({
        kind: 'absent' as const,
        resource: Object.freeze({
          kind: 'lock' as const,
          location: Object.freeze({ kind: 'machine-bound' as const, path: lockPath }),
        }),
      });
      lockModel = Object.freeze({
        version: 1 as const,
        hashSchemaVersion: HASH_SCHEMA_VERSION,
        manifestHash: hashManifestSemantics(manifestModel),
        skills: Object.freeze([]),
      });
    } else {
      const lockBytes = new Uint8Array(await env.readBytes(lockPath));
      lockImage = acquisitionLockImageFromBytesV1(lockPath, lockBytes);
      if (artifact.lock.value === null) {
        throw new Error('selected install lock model is missing');
      }
      lockModel = artifact.lock.value;
    }
    const initialManifestImage = manifestImage;
    const initialLockImage = lockImage;

    const grouped = new Map<
      string,
      Readonly<{
        groupId: string;
        groupIdentity: AcquisitionArtifactTransitionEnvelopeV1['groups'][number]['groupIdentity'];
        intents: PreparedInstallIntent[];
      }>
    >();
    for (const item of prepared) {
      const groupIdentity = {
        domain: 'skillsmith.operation-group-identity' as const,
        schemaVersion: 1 as const,
        command: 'install' as const,
        skill: item.intent.skill,
        source: item.intent.source,
        scope: item.intent.scope,
        target: null,
      };
      const groupId = createOperationGroupId(groupIdentity);
      const existing = grouped.get(groupId);
      if (existing === undefined) {
        grouped.set(groupId, { groupId, groupIdentity, intents: [item] });
      } else {
        existing.intents.push(item);
      }
    }
    const groups = [...grouped.values()].sort((left, right) =>
      left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0,
    );
    const transitionGroups: AcquisitionArtifactTransitionEnvelopeV1['groups'][number][] = [];
    const unchangedGroups: AcquisitionArtifactTransitionEnvelopeV1['unchangedGroups'] extends
      | readonly (infer Identity)[]
      | undefined
      ? Identity[]
      : never = [];
    const actions = new Map<string, AcquisitionArtifactExecutionActionV1>();
    let migrationPending = manifestImage.kind === 'manifest' && manifestImage.shape === 'legacy';

    for (const group of groups) {
      const first = group.intents[0];
      if (
        first === undefined ||
        first.intent.source.kind !== 'portable' ||
        first.intent.declaration === undefined
      ) {
        throw new Error('install artifact group lacks a portable source');
      }
      const tools = registry.ids.filter((tool) =>
        group.intents.some(({ intent }) => intent.tool === tool),
      ) as NormalizedManifestDeclaration['tools'];
      const desired: NormalizedManifestDeclaration = Object.freeze({
        name: first.intent.skill,
        source: first.intent.source.identity,
        ref: first.intent.declaration.ref,
        tools: Object.freeze(tools),
        scope: first.intent.scope,
        placement: first.intent.placement.representation,
        path: first.intent.declaration.path,
      });
      const desiredLockEntry: PortableLockSkillV1 = Object.freeze({
        name: desired.name,
        source: portableSourceToken(desired),
        requestedRef: first.intent.source.requestedRef,
        resolvedSha: first.intent.source.resolvedSha,
        sourcePath: first.intent.source.sourcePath,
        contentHash: first.intent.source.contentHash as ArtifactDigest,
      });
      let migrationAfter:
        | AcquisitionArtifactTransitionEnvelopeV1['groups'][number]['migrationAfter']
        | undefined;
      if (migrationPending) {
        if (manifestBytes === null) throw new Error('legacy manifest bytes are missing');
        const request = Object.freeze({
          edits: Object.freeze([{ kind: 'migrate-legacy' as const }]),
        });
        const migrated = editManifestBytes(manifestBytes, request);
        if (!migrated.ok) throw migrated.error;
        manifestBytes = migrated.value.bytes;
        migrationAfter = acquisitionManifestImageFromBytesV1(manifestPath, manifestBytes);
        actions.set(
          artifactBindingKey(group.groupId, 'migrate-project-config'),
          Object.freeze({
            role: 'manifest' as const,
            action: Object.freeze({ kind: 'edit' as const, request }),
          }),
        );
        manifestImage = migrationAfter;
        migrationPending = false;
      }
      const edits = manifestEditsForDeclaration(
        manifestModel.skills.find(({ name }) => name === desired.name),
        desired,
      );
      let manifestAction: HumanManifestAction | null = null;
      let manifestAfter = manifestImage;
      if (edits.length > 0) {
        const targetManifest = manifestWithDeclaration(manifestModel, desired);
        if (manifestBytes === null) {
          const manifestCodec = artifactContractRegistry.get('manifest', 1);
          if (manifestCodec === undefined) {
            throw new Error('manifest artifact codec 1 is unavailable');
          }
          const encoded = manifestCodec.encode(targetManifest);
          if (!encoded.ok) throw new Error(encoded.error.message);
          manifestBytes = encoded.value;
          manifestAction = Object.freeze({
            kind: 'replace' as const,
            bytes: new Uint8Array(manifestBytes),
          });
        } else {
          const request: ManifestEditRequest = Object.freeze({ edits: Object.freeze([...edits]) });
          const edited = editManifestBytes(manifestBytes, request);
          if (!edited.ok) throw edited.error;
          manifestBytes = edited.value.bytes;
          manifestAction = Object.freeze({ kind: 'edit' as const, request });
        }
        manifestModel = targetManifest;
        manifestAfter = acquisitionManifestImageFromBytesV1(manifestPath, manifestBytes);
      }
      const targetLock = lockWithEntry(lockModel, manifestModel, desiredLockEntry);
      const currentLockHash = hashPortableLock(lockModel);
      const targetLockHash = hashPortableLock(targetLock);
      if (!currentLockHash.ok || !targetLockHash.ok) {
        throw new Error('install portable lock could not be hashed');
      }
      const lockChanged = currentLockHash.value !== targetLockHash.value;
      if (manifestAction === null && !lockChanged && migrationAfter === undefined) {
        unchangedGroups.push(group.groupIdentity);
        continue;
      }
      if (!lockChanged) {
        throw new Error('install manifest transition did not produce a correlated lock change');
      }
      const serializedLock = serializePortableLock(targetLock);
      if (!serializedLock.ok) throw new Error('install portable lock could not be serialized');
      const lockAfter = acquisitionLockImageFromBytesV1(
        lockPath,
        new TextEncoder().encode(serializedLock.value),
      );
      transitionGroups.push({
        groupIdentity: group.groupIdentity,
        ...(migrationAfter === undefined ? {} : { migrationAfter }),
        manifestAfter: manifestAfter as Extract<OperationImage, { readonly kind: 'manifest' }>,
        lockAfter,
      });
      if (manifestAction !== null) {
        actions.set(
          artifactBindingKey(group.groupId, 'write-manifest'),
          Object.freeze({ role: 'manifest' as const, action: manifestAction }),
        );
      }
      const lockAction: GeneratedLockAction = Object.freeze({
        kind: 'replace' as const,
        lock: targetLock,
      });
      actions.set(
        artifactBindingKey(group.groupId, 'write-lock'),
        Object.freeze({ role: 'lock' as const, action: lockAction }),
      );
      manifestImage = manifestAfter;
      lockImage = lockAfter;
      lockModel = targetLock;
    }
    return Object.freeze({
      transition: Object.freeze({
        initial: Object.freeze({
          manifest: initialManifestImage,
          lock: initialLockImage,
        }),
        groups: Object.freeze(transitionGroups),
        unchangedGroups: Object.freeze(unchangedGroups),
      }),
      actions,
    });
  };
  const observeInstallState = async (
    seed: InstallBindingSeed,
  ): Promise<Readonly<{ ledger: LedgerModel; facts: InstallPreconditionFacts }>> => {
    const { preview, spec, resolved: resolvedSource, tool } = seed;
    if (preview.skill === null || preview.placementPath === null || preview.store === null) {
      throw new Error('prepared install facts require an executable result');
    }
    const rootsCtx = {
      cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
      configuration: opts.configuration,
    };
    const installRoot = selectedInstallRootFor(tool, rootsCtx);
    const ledgerResult = await readLedgerState(env, ledgerPath);
    if (!ledgerResult.ok) throw ledgerResult.error;
    const ledger = ledgerModelForMutation(ledgerResult.value, nowOf(env, deps));
    const selectedPair = getPairAt(ledger, scopeKey, preview.skill, tool);
    const live = await acquirePlacementFacts(env, installRoot, preview.skill, storeRoot);
    const alternates = await Promise.all(
      skillRootFactsFor(registry, tool, env, scope, rootsCtx)
        .filter((fact) => fact.role === 'alternate')
        .map((fact) => acquirePlacementFacts(env, fact.path, preview.skill as string, storeRoot)),
    );
    const otherScope: InstallScope = scope === 'project' ? 'user' : 'project';
    const otherKey = otherScope === 'project' ? projectRoot : null;
    let shadow: InstallPreconditionFacts['shadow'] = null;
    if (!(otherScope === 'project' && otherKey === null)) {
      const otherCtx = {
        cwd: otherScope === 'project' ? (otherKey as string) : opts.cwd,
        configuration: opts.configuration,
      };
      shadow = {
        pair: structuredClone(getPairAt(ledger, otherKey, preview.skill, tool)),
        live: await Promise.all(
          skillRootFactsFor(registry, tool, env, otherScope, otherCtx).map((fact) =>
            acquirePlacementFacts(env, fact.path, preview.skill as string, storeRoot),
          ),
        ),
      };
    }
    const sourceContent = await acquireContentFacts(env, resolvedSource.materializedDir);
    return {
      ledger,
      facts: {
        projectRoot,
        selectedPair: structuredClone(selectedPair),
        live,
        alternates,
        shadow,
        source: {
          canonicalSource: spec.canonicalSource,
          repository: spec.identity.repository,
          resolvedSha: resolvedSource.sha,
          skillPath: resolvedSource.skillPath,
          content: {
            pathKind: sourceContent.pathKind,
            contentHash: sourceContent.contentHash,
          },
        },
        store: await acquireContentFacts(env, preview.store.path),
      },
    };
  };
  const resolveAll = async (ledgerState: LedgerReadState): Promise<InstallResolutionAuthority> => {
    const ledger = legacyLedgerView(ledgerModelForMutation(ledgerState, nowOf(env, deps)));
    const sources = new Map<number, ResolveRemoteSourceOutcome>();
    const gates = new Map<string, InstallVerificationGate>();
    const cleanupDirs = new Set<string>();
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      for (const dir of cleanupDirs) await env.removeTree(dir).catch(() => {});
    };
    try {
      const names: string[] = [];
      for (const { spec, requestIndex } of specs) {
        if (opts.signal?.aborted) break;
        const outcome = await resolveRemoteSource({
          ports: env,
          source: spec,
          ...(deps.transport === undefined ? {} : { transport: deps.transport }),
          ledger,
          scopeKey,
          storeRoot,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          ...(deps.pick === undefined ? {} : { pick: deps.pick }),
          createFetchDirectory: () => join(dataDir, '.fetch', txIdOf(env, deps)),
        });
        if (outcome.cleanupDirectory !== null) cleanupDirs.add(outcome.cleanupDirectory);
        const resolved =
          outcome.kind === 'resolved'
            ? Object.freeze({
                ...outcome,
                materialization: Object.freeze({ ...outcome.materialization }),
              })
            : outcome;
        sources.set(requestIndex, resolved);
        if (resolved.kind !== 'resolved') {
          if (!opts.continueOnError) break;
          continue;
        }
        const r = resolved.materialization;
        if (
          [dataDir, storeRoot, r.materializedDir, r.skillName, r.skillPath].some(
            containsSensitiveMaterial,
          )
        ) {
          if (!opts.continueOnError) break;
          continue;
        }
        names.push(r.skillName);
        let sourceFailed = false;
        for (const tool of detectedTools) {
          if (opts.signal?.aborted) continue;
          const roots = {
            cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
            configuration: opts.configuration,
          };
          const placementPath = join(selectedInstallRootFor(tool, roots), r.skillName);
          if (containsSensitiveMaterial(placementPath)) {
            sourceFailed = true;
            continue;
          }
          const gate = await runInstallVerifyGate(
            env,
            deps,
            registry,
            tool,
            r.materializedDir,
            opts,
            observation,
          );
          gates.set(gateKey(requestIndex, tool), gate);
          if (gate.blocked) sourceFailed = true;
        }
        if (sourceFailed && !opts.continueOnError) break;
      }
      const duplicateNames = [
        ...new Set(names.filter((name, index) => names.indexOf(name) !== index)),
      ];
      const artifact = await resolveAcquisitionArtifactDestinationV1({
        ports: env,
        projectContext,
        names,
        scope,
        mode: 'save',
        ...(opts.file === undefined ? {} : { file: opts.file }),
        ...(opts.lockfile === undefined ? {} : { lockfile: opts.lockfile }),
        ...(opts.noSave === undefined ? {} : { noSave: opts.noSave }),
        ...(opts.path === undefined ? {} : { path: opts.path }),
      });
      return Object.freeze({
        sources,
        gates,
        duplicateNames: Object.freeze(duplicateNames),
        artifact,
        cleanup,
      });
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
  const artifactBlocksBinding = (resolution: InstallResolutionAuthority): boolean =>
    resolution.artifact.outcome === 'refused' ||
    (resolution.artifact.saveMode === 'desired-state' && resolution.duplicateNames.length > 0);
  const artifactStopsRecovery = (resolution: InstallResolutionAuthority): boolean =>
    opts.signal?.aborted === true ||
    resolution.artifact.outcome === 'refused' ||
    ![...resolution.gates.values()].some((gate) => gate.blocked === null) ||
    (resolution.artifact.outcome === 'none' &&
      resolution.artifact.saveMode === 'desired-state' &&
      resolution.artifact.selection.reason === 'pre-resolution-failure');
  const prepareAll = async (
    ledgerState: LedgerReadState,
    resolution: InstallResolutionAuthority,
  ): Promise<PreparedInstallOutcome> => {
    const ledger = ledgerModelForMutation(ledgerState, nowOf(env, deps));
    const results: InstallResult[] = [...planningRefusals];
    const candidateBindings = new Map<InstallResult, InstallBindingSeed>();
    const placeCtx: PlaceCtx = {
      env,
      registry,
      deps,
      opts,
      ledger,
      ledgerPath,
      storeRoot,
      scope,
      scopeKey,
      projectRoot,
      installRootFor: (tool) =>
        selectedInstallRootFor(tool, {
          cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
        }),
      logicalOperation: null,
      operationObservation: undefined,
    };
    let planningFailFast = false;
    for (const { source, spec, requestIndex } of specs) {
      if (opts.signal?.aborted) {
        results.push({
          ...emptyResult(source, scope, 'skipped', requestIndex),
          reason: 'interrupted',
        });
        continue;
      }
      if (planningFailFast) {
        results.push({
          ...emptyResult(source, scope, 'skipped', requestIndex),
          reason: 'fail-fast',
        });
        continue;
      }
      const resolved = resolution.sources.get(requestIndex);
      if (resolved === undefined) throw new Error('install source resolution is missing');
      if (resolved.kind === 'source-failure') {
        results.push({
          ...emptyResult(spec.canonicalInvocation, scope, 'failed', requestIndex),
          reason: msg(resolved.error),
          error: resolved.error,
        });
        if (!opts.continueOnError) planningFailFast = true;
        continue;
      }
      if (resolved.kind === 'no-match') {
        const error = {
          code: 'source-unresolvable' as const,
          message: `'${selectorLabel(spec)}' matched no skills in ${spec.identity.repository} @ ${resolved.resolvedSha.slice(0, 12)}: searched ${resolved.searched} SKILL.md directories`,
        };
        results.push({
          ...emptyResult(spec.canonicalInvocation, scope, 'failed', requestIndex),
          reason: error.message,
          error,
        });
        if (!opts.continueOnError) planningFailFast = true;
        continue;
      }
      if (resolved.kind === 'ambiguous') {
        const reason = `'${selectorLabel(spec)}' matches ${resolved.candidates.length} skills — re-run with one of the exact paths above`;
        results.push({
          ...emptyResult(spec.canonicalInvocation, scope, 'refused', requestIndex),
          reason,
          candidates: [...resolved.candidates],
          error: flipRefusedError(reason),
        });
        if (!opts.continueOnError) planningFailFast = true;
        continue;
      }
      const r = resolved.materialization;
      if (
        [dataDir, storeRoot, r.materializedDir, r.skillName, r.skillPath].some(
          containsSensitiveMaterial,
        )
      ) {
        const error = sourceUnresolvableError(
          'remote source produced invalid or sensitive derived metadata',
        );
        results.push({
          ...emptyResult(source, scope, 'failed', requestIndex),
          reason: msg(error),
          error,
        });
        if (!opts.continueOnError) planningFailFast = true;
        continue;
      }
      if (artifactBlocksBinding(resolution)) {
        const refusal = resolution.artifact.outcome === 'refused' ? resolution.artifact : undefined;
        const reason =
          refusal === undefined
            ? `multiple resolved sources declare duplicate skill names: ${resolution.duplicateNames.join(', ')}`
            : refusal.cause.message;
        const error =
          refusal === undefined || refusal.cause.exitClass === 'usage'
            ? flipRefusedError(reason)
            : configError(reason);
        for (const tool of detectedTools) {
          results.push({
            ...emptyResult(source, scope, 'refused', requestIndex),
            skill: r.skillName,
            tool,
            reason,
            candidates: refusal === undefined ? null : [...refusal.selection.candidates],
            error,
          });
        }
        continue;
      }
      const sourceResults: InstallResult[] = [];
      let snap: SnapshotResult | null = null;
      let snapErr: SkillSmithError | null = null;
      let snapConsumed = false;
      for (const tool of detectedTools) {
        if (opts.signal?.aborted) {
          sourceResults.push({
            ...emptyResult(source, scope, 'skipped', requestIndex),
            skill: r.skillName,
            tool,
            reason: 'interrupted',
          });
          continue;
        }
        const derivedRootsContext = {
          cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
          configuration: opts.configuration,
        };
        const derivedPlacementPath = join(
          selectedInstallRootFor(tool, derivedRootsContext),
          r.skillName,
        );
        if (containsSensitiveMaterial(derivedPlacementPath)) {
          const error = sourceUnresolvableError(
            'remote source produced invalid or sensitive derived metadata',
          );
          sourceResults.push({
            ...emptyResult(source, scope, 'failed', requestIndex),
            skill: r.skillName,
            tool,
            reason: msg(error),
            error,
          });
          continue;
        }
        const gate = resolution.gates.get(gateKey(requestIndex, tool));
        if (gate === undefined) {
          sourceResults.push({
            ...emptyResult(source, scope, 'skipped', requestIndex),
            skill: r.skillName,
            tool,
            reason: 'interrupted',
          });
          continue;
        }
        if (gate.blocked) {
          const blocked: InstallResult = {
            ...emptyResult(source, scope, 'failed', requestIndex),
            skill: r.skillName,
            tool,
            placementPath: derivedPlacementPath,
            reason: msg(gate.blocked),
            verify: { gate: gate.gate, verdict: gate.verdict, mode: gate.mode },
            error: safeError(gate.blocked),
          };
          sourceResults.push(blocked);
          candidateBindings.set(blocked, {
            preview: desiredInstallPreview(placeCtx, spec, r, tool),
            reportPreviews: [blocked],
            requestIndex,
            spec,
            resolved: r,
            tool,
            execution: 'desired-only',
            execute: async () => blocked,
          });
          continue;
        }
        let preview = { ...(await predictPair(placeCtx, spec, r, tool)), requestIndex };
        if (preview.action === 'noop' && preview.store !== null) {
          const [fetchedHash, storedHash] = await Promise.all([
            contentHashOf(env, r.materializedDir),
            contentHashOf(env, preview.store.path),
          ]);
          const integrityError = !fetchedHash.ok
            ? fetchedHash.error
            : !storedHash.ok
              ? storedHash.error
              : fetchedHash.value !== storedHash.value
                ? flipFailedError(
                    `store integrity violation: ${preview.store.path} exists with different content`,
                  )
                : null;
          if (integrityError !== null) {
            preview = {
              ...preview,
              action: 'failed',
              reason: msg(integrityError),
              store: null,
              error: safeError(integrityError),
            };
          }
        }
        sourceResults.push(preview);
        candidateBindings.set(preview, {
          preview: desiredInstallPreview(placeCtx, spec, r, tool),
          reportPreviews: [preview],
          requestIndex,
          spec,
          resolved: r,
          tool,
          execution: preview.action === 'failed' ? 'desired-only' : 'selected',
          execute: async (): Promise<InstallResult> => {
            if (snap === null && snapErr === null) {
              const { ns, name } = clampStoreNs(spec.identity.repository);
              const provenance: Provenance = {
                kind: 'git-clean',
                gitSha: r.sha,
                ns,
                name,
                repoRoot: null,
                sourceRelPath: null,
                remote: spec.identity.repository,
                dirtySummary: null,
              };
              const snapshot = await snapshotToStore(env, {
                sourceDir: r.materializedDir,
                skill: r.skillName,
                storeRoot,
                provenance,
                txId: txIdOf(env, deps),
              });
              if (!snapshot.ok) snapErr = snapshot.error;
              else snap = snapshot.value;
            }
            if (snapErr !== null) {
              return {
                ...preview,
                action: 'failed',
                reason: msg(snapErr),
                store: null,
                error: safeError(snapErr),
              };
            }
            const storeReused = snapConsumed ? true : (snap as SnapshotResult).reused;
            const placed = await placePair(
              placeCtx,
              spec,
              r,
              tool,
              snap as SnapshotResult,
              gate,
              storeReused,
            );
            snapConsumed = true;
            return { ...placed, requestIndex };
          },
        });
      }
      results.push(...sourceResults);
      if (!opts.continueOnError && sourceResults.some((x) => x.error)) {
        planningFailFast = true;
      }
    }
    if (artifactStopsRecovery(resolution)) {
      return {
        terminal: createInstallDiagnosticReport(
          Boolean(opts.dryRun),
          requested,
          results,
          Boolean(opts.continueOnError),
          registry,
          {
            artifact: resolution.artifact,
            ...(opts.path === undefined ? {} : { path: opts.path }),
          },
        ),
      };
    }
    const preparedIntents: PreparedInstallIntent[] = [];
    const liveResourcesByPath = new Map<string, AcquireLiveSnapshotResourceV1>();
    const storeResourcesByPath = new Map<string, AcquireStoreSnapshotResourceV1>();
    const addLiveResource = (resource: AcquireLiveSnapshotResourceV1): void => {
      const existing = liveResourcesByPath.get(resource.placementPath);
      if (
        existing !== undefined &&
        (existing.skill !== resource.skill ||
          existing.tool !== resource.tool ||
          existing.scope !== resource.scope ||
          existing.projectIdentity !== resource.projectIdentity)
      ) {
        throw new Error('acquisition live resource path is ambiguous');
      }
      liveResourcesByPath.set(resource.placementPath, existing ?? resource);
    };
    for (const seed of candidateBindings.values()) {
      if (
        seed.preview.skill === null ||
        seed.preview.placementPath === null ||
        seed.preview.store === null
      ) {
        throw new Error('prepared install intent requires an executable result');
      }
      const expectedFacts = (await observeInstallState(seed)).facts;
      const requestIndex = seed.requestIndex;
      if (!Number.isSafeInteger(requestIndex) || (requestIndex as number) < 0) {
        throw new Error('prepared install request occurrence is invalid');
      }
      const sourceResourceId = acquireStateResourceId('store', [
        'materialized-source',
        requestIndex,
        seed.spec.identity.host,
        seed.spec.identity.repository,
        seed.resolved.sha,
        seed.resolved.skillPath,
      ]);
      const sourceContent = acquireContentObservationIdentity(
        sourceResourceId,
        await acquireContentFacts(env, seed.resolved.materializedDir),
      );
      const livePath = resolve(seed.preview.placementPath);
      const liveResourceId = acquireStateResourceId('live', [livePath]);
      addLiveResource({
        resourceId: liveResourceId,
        skill: seed.preview.skill,
        tool: seed.tool,
        scope,
        projectIdentity: scope === 'project' ? scopeKey : null,
        placementPath: livePath,
        storeRoot,
      });
      for (const alternate of expectedFacts.alternates) {
        addLiveResource({
          resourceId: acquireStateResourceId('live', [alternate.canonicalPath]),
          skill: seed.preview.skill,
          tool: seed.tool,
          scope,
          projectIdentity: scope === 'project' ? scopeKey : null,
          placementPath: alternate.canonicalPath,
          storeRoot,
        });
      }
      if (expectedFacts.shadow !== null) {
        const shadowScope: InstallScope = scope === 'project' ? 'user' : 'project';
        for (const shadow of expectedFacts.shadow.live) {
          addLiveResource({
            resourceId: acquireStateResourceId('live', [shadow.canonicalPath]),
            skill: seed.preview.skill,
            tool: seed.tool,
            scope: shadowScope,
            projectIdentity: shadowScope === 'project' ? projectRoot : null,
            placementPath: shadow.canonicalPath,
            storeRoot,
          });
        }
      }
      const storePath = resolve(seed.preview.store.path);
      const storeResourceId = acquireStateResourceId('store', [storePath]);
      const existingStore = storeResourcesByPath.get(storePath);
      if (
        existingStore !== undefined &&
        existingStore.contentHash !== sourceContent.contentRevision
      ) {
        throw new Error('acquisition store resource content is ambiguous');
      }
      storeResourcesByPath.set(
        storePath,
        existingStore ?? {
          resource: { resourceId: storeResourceId, storePath },
          contentHash: sourceContent.contentRevision,
        },
      );
      preparedIntents.push({
        seed,
        expectedFacts,
        intent: {
          kind: 'install',
          execution: seed.execution,
          skill: seed.preview.skill,
          tool: seed.tool,
          scope,
          projectRoot:
            scope === 'project' && scopeKey !== null
              ? { kind: 'machine-bound', path: scopeKey }
              : null,
          liveResourceId,
          storeResourceId,
          force: Boolean(opts.force),
          sourceContent,
          sourcePreconditionId: createContentObservationPreconditionIdV1(sourceContent),
          source: {
            kind: 'portable',
            identity: {
              host: seed.spec.identity.host,
              repository: seed.spec.identity.repository,
              path: seed.resolved.skillPath.length === 0 ? null : seed.resolved.skillPath,
            },
            requestedRef: seed.spec.ref,
            resolvedSha: seed.resolved.sha,
            sourcePath: seed.resolved.skillPath.length === 0 ? '.' : seed.resolved.skillPath,
            contentHash: sourceContent.contentRevision,
          },
          ...(opts.noSave
            ? {}
            : {
                declaration: {
                  ref: opts.pin ? seed.resolved.sha : seed.spec.ref,
                  path: opts.path ?? null,
                },
              }),
          placement: {
            classification: 'pinned',
            representation: opts.direct ? 'copy' : 'symlink',
            location: { kind: 'machine-bound', path: livePath },
          },
          store: {
            location: { kind: 'machine-bound', path: storePath },
            contentHash: sourceContent.contentRevision,
            snapshotIdentity: createStoreSnapshotIdentityV1(
              storeResourceId,
              sourceContent.contentRevision,
            ),
          },
        },
      });
    }
    if (preparedIntents.length === 0) {
      return {
        terminal: createInstallDiagnosticReport(
          Boolean(opts.dryRun),
          requested,
          results,
          Boolean(opts.continueOnError),
          registry,
          {
            artifact: resolution.artifact,
            ...(opts.path === undefined ? {} : { path: opts.path }),
          },
        ),
      };
    }
    const migration = prepareLedgerMigration(
      env,
      'install',
      'explicit-targets',
      ledgerPath,
      ledgerState,
    );
    const compatibilityPlanning = createInstallPlanning(
      requested,
      results,
      Boolean(opts.continueOnError),
      scopeKey,
      { registry, toolOrder: registry.ids },
    );
    const snapshotAuthority = await readAcquisitionSnapshotV1({
      env,
      registry,
      capabilityQueries: createInstallCapabilityQueries(
        registry,
        preparedIntents.map(({ intent }) => intent),
        opts,
      ),
      projectContext,
      artifact: acquisitionSnapshotArtifactAuthorityV1(resolution.artifact),
      ledgerPath,
      liveResources: [...liveResourcesByPath.values()],
      storeResources: [...storeResourcesByPath.values()],
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    const artifactPlanning = await prepareInstallArtifactPlanning(
      snapshotAuthority,
      preparedIntents,
    );
    const boundPlanning = createAcquisitionPlan(
      {
        schemaVersion: 1,
        command: 'install',
        selection: {
          source: 'explicit-targets',
          skills: [...new Set(preparedIntents.map(({ intent }) => intent.skill))],
          tools: [...new Set(preparedIntents.map(({ intent }) => intent.tool))],
          scopes: [scope],
        },
        batchPolicy: opts.continueOnError ? 'continue-on-error' : 'fail-fast',
        diagnostics: compatibilityPlanning.plan.diagnostics,
        compatibilityOperations: migration === null ? [] : [migration.operation],
        intents: preparedIntents.map(({ intent }) => intent),
        ...(artifactPlanning.transition === undefined
          ? {}
          : { artifactTransition: artifactPlanning.transition }),
      },
      snapshotAuthority.snapshot,
      { registry, toolOrder: registry.ids },
    );
    if (!boundPlanning.ok) {
      throw new Error(boundPlanning.error.message);
    }
    const plan = boundPlanning.value.plan;
    const groupByResult = new Map<string, string>();
    for (const item of preparedIntents) {
      const groupId = createOperationGroupId({
        domain: 'skillsmith.operation-group-identity',
        schemaVersion: 1,
        command: 'install',
        skill: item.intent.skill,
        source: item.intent.source,
        scope: item.intent.scope,
        target: null,
      });
      for (const reportPreview of item.seed.reportPreviews) {
        groupByResult.set(installResultFactKey(reportPreview), groupId);
      }
    }
    const canonicalOperations = plan.operations.filter(
      (operation) =>
        migration === null || operation.operationId !== migration.operation.operationId,
    );
    const artifactOperations = canonicalOperations.filter(
      (operation) =>
        operation.kind === 'migrate-project-config' ||
        operation.kind === 'write-manifest' ||
        operation.kind === 'write-lock',
    );
    const liveOperations = canonicalOperations.filter(
      (operation) =>
        operation.kind !== 'migrate-project-config' &&
        operation.kind !== 'write-manifest' &&
        operation.kind !== 'write-lock',
    );
    const operationByLivePath = new Map<string, ExecutableOperation>();
    for (const operation of liveOperations) {
      if (operation.before.kind !== 'absent' && operation.before.kind !== 'placement') {
        throw new Error('acquisition install operation does not target live state');
      }
      if (
        operation.before.resource.kind !== 'live' ||
        operation.before.resource.location.kind !== 'machine-bound' ||
        operationByLivePath.has(operation.before.resource.location.path)
      ) {
        throw new Error('acquisition install operation binding is ambiguous');
      }
      operationByLivePath.set(operation.before.resource.location.path, operation);
    }
    const canonicalPreviewByOriginal = new Map<InstallResult, InstallResult>();
    const preparedIntentsByOperationId = new Map<string, Array<(typeof preparedIntents)[number]>>();
    for (const prepared of preparedIntents) {
      const placementPath = resolve(prepared.seed.preview.placementPath as string);
      const operation = operationByLivePath.get(placementPath);
      const plannedAction: InstallAction =
        operation === undefined
          ? 'noop'
          : operation.kind === 'install'
            ? 'installed'
            : operation.kind === 'update'
              ? 'updated'
              : 'repaired';
      const reportPreview = prepared.seed.reportPreviews[0] ?? prepared.seed.preview;
      const preserveRefusal =
        reportPreview.action === 'refused' ||
        reportPreview.action === 'failed' ||
        reportPreview.action === 'skipped';
      const canonicalPreview = {
        ...(preserveRefusal ? reportPreview : prepared.seed.preview),
        action: preserveRefusal ? reportPreview.action : plannedAction,
        reason:
          !preserveRefusal && operation === undefined
            ? `already installed at ${prepared.seed.resolved.sha.slice(0, 12)}`
            : reportPreview.reason,
      };
      canonicalPreviewByOriginal.set(prepared.seed.preview, canonicalPreview);
      for (const occurrence of prepared.seed.reportPreviews) {
        canonicalPreviewByOriginal.set(occurrence, {
          ...canonicalPreview,
          ...(occurrence.requestIndex === undefined
            ? {}
            : { requestIndex: occurrence.requestIndex }),
        });
      }
      if (operation !== undefined) {
        const operationIntents = preparedIntentsByOperationId.get(operation.operationId);
        if (operationIntents === undefined) {
          preparedIntentsByOperationId.set(operation.operationId, [prepared]);
        } else {
          operationIntents.push(prepared);
        }
      }
    }
    const canonicalResults = results.map(
      (result) => canonicalPreviewByOriginal.get(result) ?? result,
    );
    const preparedBindings = new Map<string, PreparedInstallBinding>();
    const preconditions: ExecutionPrecondition[] = [
      ...acquisitionRevisionPreconditions(snapshotAuthority, plan.operations),
    ];
    const sourcePreconditionGroups = new Map<
      string,
      Readonly<{
        expectedContent: ContentObservationIdentityV1;
        operations: ExecutableOperation[];
        seed: InstallBindingSeed;
      }>
    >();
    for (const prepared of preparedIntents) {
      const currentGroup = sourcePreconditionGroups.get(prepared.intent.sourcePreconditionId);
      if (currentGroup === undefined) {
        sourcePreconditionGroups.set(prepared.intent.sourcePreconditionId, {
          expectedContent: prepared.intent.sourceContent,
          operations: [],
          seed: prepared.seed,
        });
      } else if (
        JSON.stringify(currentGroup.expectedContent) !==
          JSON.stringify(prepared.intent.sourceContent) ||
        currentGroup.seed.resolved.materializedDir !== prepared.seed.resolved.materializedDir
      ) {
        throw new Error('acquisition source precondition identity collision');
      }
    }
    for (const operation of artifactOperations) {
      const action = artifactPlanning.actions.get(
        artifactBindingKey(operation.groupId, operation.kind),
      );
      if (action === undefined) {
        throw new Error('prepared install artifact action is missing');
      }
      preparedBindings.set(operation.operationId, { kind: 'artifact', action });
    }
    for (const operation of liveOperations) {
      const operationIntents = preparedIntentsByOperationId.get(operation.operationId);
      if (operationIntents === undefined || operationIntents[0] === undefined) {
        throw new Error('prepared install operation binding is missing');
      }
      const prepared = operationIntents[0];
      for (const occurrence of operationIntents) {
        const currentGroup = sourcePreconditionGroups.get(occurrence.intent.sourcePreconditionId);
        if (currentGroup === undefined) {
          throw new Error('acquisition source precondition group is missing');
        }
        if (
          !currentGroup.operations.some(({ operationId }) => operationId === operation.operationId)
        ) {
          currentGroup.operations.push(operation);
        }
      }
      const resource =
        operation.before.kind === 'absent' || operation.before.kind === 'placement'
          ? operation.before.resource
          : null;
      if (resource === null || resource.kind !== 'live') {
        throw new Error('prepared install resource is not live');
      }
      const actualBefore = acquireActualBefore(
        resource,
        prepared.expectedFacts.live,
        prepared.expectedFacts.selectedPair,
      );
      const canonicalPreview = canonicalPreviewByOriginal.get(prepared.seed.preview);
      if (canonicalPreview === undefined) {
        throw new Error('prepared install canonical preview is missing');
      }
      preparedBindings.set(operation.operationId, {
        kind: 'pair',
        preview: canonicalPreview,
        reportPreviews: operationIntents.flatMap(({ seed }) =>
          seed.reportPreviews.map(
            (reportPreview) => canonicalPreviewByOriginal.get(reportPreview) ?? reportPreview,
          ),
        ),
        actualBefore,
        liveResourceId: prepared.intent.liveResourceId,
        storeResourceId: prepared.intent.storeResourceId,
        observe: async () => {
          const current = await observeInstallState(prepared.seed);
          // Preparation and approval may be separated from execution by another completed
          // ledger mutation. Rebind the mutation closure to the whole current under-lock ledger;
          // the exact approved operation and its expected selected/live facts remain unchanged.
          placeCtx.ledger = current.ledger;
          return current.facts;
        },
        execute: async (logicalOperation, operationObservation) => {
          placeCtx.logicalOperation = logicalOperation;
          placeCtx.operationObservation = operationObservation;
          try {
            return await prepared.seed.execute();
          } finally {
            placeCtx.operationObservation = undefined;
          }
        },
      });
    }
    for (const operation of artifactOperations) {
      for (const [preconditionId, group] of sourcePreconditionGroups) {
        if (
          operation.preconditionIds.includes(preconditionId) &&
          !group.operations.some(({ operationId }) => operationId === operation.operationId)
        ) {
          group.operations.push(operation);
        }
      }
    }
    for (const group of sourcePreconditionGroups.values()) {
      if (group.operations.length === 0) continue;
      preconditions.push(
        createContentObservationExecutionPrecondition({
          operationIds: group.operations.map(({ operationId }) => operationId),
          resource: {
            kind: 'store',
            contentHash: group.expectedContent.contentRevision,
          },
          expectedContent: group.expectedContent,
          observeContent: async () => {
            const observed = acquireContentObservationIdentity(
              group.expectedContent.resourceId,
              await acquireContentFacts(env, group.seed.resolved.materializedDir),
            );
            return observed;
          },
        }),
      );
    }
    if (migration !== null) {
      preconditions.unshift(migration.precondition);
      preparedBindings.set(migration.operation.operationId, {
        kind: 'migrate-ledger',
        expectedState: migration.expectedState,
        onMigrated: (model) => {
          placeCtx.ledger = model;
        },
      });
    }
    const bindings = new Map<string, PreparedInstallBinding>();
    for (const operation of plan.operations) {
      const binding = preparedBindings.get(operation.operationId);
      if (binding === undefined || bindings.has(operation.operationId)) {
        throw new Error('prepared install operation binding is not one-to-one');
      }
      bindings.set(operation.operationId, binding);
    }
    if (
      bindings.size !== plan.operations.length ||
      plan.operations.some((operation) => !bindings.has(operation.operationId))
    ) {
      throw new Error('prepared install plan has no exact execution binding');
    }
    const preview = assembleInstallReport(true, requested, canonicalResults, plan, [], {
      artifact: resolution.artifact,
      ...(opts.path === undefined ? {} : { path: opts.path }),
      groupByResult,
    });
    emitAcquisitionPlanCreated(observation, plan, planObservation);
    deps.observePreparedPlan?.(plan);
    return {
      preview,
      legacyPreviewResults: Object.freeze(canonicalResults),
      bindings,
      preconditions: Object.freeze(preconditions),
      snapshotAuthority,
      expectedRevisions: boundPlanning.value.expectedRevisions,
      snapshotId: boundPlanning.value.snapshotId,
      artifactResolution: resolution.artifact,
      groupByResult,
    };
  };
  const executePrepared = async (prepared: PreparedInstallBatch): Promise<PlannedInstallReport> => {
    const actualByPreview = new Map<InstallResult, InstallResult>();
    const actualByOperation = new Map<string, InstallResult>();
    const projectActual = (binding: PreparedInstallPairBinding, actual: InstallResult): void => {
      for (const preview of binding.reportPreviews) {
        const projected = { ...actual };
        if (preview.requestIndex === undefined) Reflect.deleteProperty(projected, 'requestIndex');
        else projected.requestIndex = preview.requestIndex;
        actualByPreview.set(preview, projected);
      }
    };
    const lifecycle = createAcquisitionRepositoryLifecycleControllerV1({
      authority: prepared.snapshotAuthority,
      snapshotId: prepared.snapshotId,
      expectedRevisions: prepared.expectedRevisions,
    });
    const ledgerLockPort = createAcquireExecutionLockPort(env, ledgerPath, safeError, msg);
    const artifactController =
      prepared.snapshotAuthority.snapshot.artifact.mode === 'selected'
        ? createAcquisitionArtifactExecutionControllerV1({
            authority: prepared.snapshotAuthority,
            artifactCoordinator:
              deps.artifactCoordinator ?? (await createNodeArtifactCoordinatorPorts()),
            ledgerLockPort,
            ledgerPath,
            ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          })
        : null;
    const schedulerBindings: PreparedExecutionBinding[] = prepared.preview.plan.operations.map(
      (operation) => {
        const binding = prepared.bindings.get(operation.operationId);
        if (binding === undefined) throw new Error('prepared install operation binding is missing');
        if (binding.kind === 'artifact') {
          if (artifactController === null) {
            throw new Error('prepared install artifact controller is missing');
          }
          return artifactController.bind(operation, binding.action);
        }
        if (binding.kind === 'migrate-ledger') {
          return lifecycle.bind(
            operation,
            createAcquisitionLedgerMigrationBinding({
              env,
              ledgerPath,
              operation,
              expectedState: binding.expectedState,
              startedAt: journalNowOf(env, deps),
              ...(opts.signal === undefined ? {} : { signal: opts.signal }),
              onMigrated: binding.onMigrated,
            }),
            [prepared.snapshotAuthority.ledgerResourceId],
          );
        }
        if (operation.pairId === null)
          throw new Error('prepared install operation pair is missing');
        let compatibilityBefore = binding.actualBefore;
        return lifecycle.bind(
          operation,
          {
            operationId: operation.operationId,
            groupId: operation.groupId,
            pairId: operation.pairId,
            unstartedForce: createInstallForceEffect(operation, requested.force),
            observeActualBefore: async (): Promise<OperationImage> => {
              const facts = await binding.observe();
              const resource =
                operation.before.kind === 'absent' || operation.before.kind === 'placement'
                  ? operation.before.resource
                  : null;
              if (resource === null || resource.kind !== 'live') {
                throw new Error('prepared install actual-before resource is not live');
              }
              compatibilityBefore = acquireActualBefore(resource, facts.live, facts.selectedPair);
              return operation.before;
            },
            execute: async (
              validatedBinding: ValidatedExecutionBinding,
              operationObservation?: ObservationBundle,
            ): Promise<OperationExecutionResult> => {
              const actual = await binding.execute(
                { ...operation, before: compatibilityBefore },
                operationObservation,
              );
              projectActual(binding, actual);
              actualByOperation.set(operation.operationId, actual);
              return createInstallExecutionResult(
                operation,
                actual,
                requested,
                validatedBinding.actualBefore,
              );
            },
          },
          [
            prepared.snapshotAuthority.ledgerResourceId,
            binding.liveResourceId,
            binding.storeResourceId,
          ],
        );
      },
    );
    let executionResults: readonly OperationExecutionResult[];
    try {
      executionResults = await executeAcquisitionOperationPlan(
        {
          plan: prepared.preview.plan as CurrentMutatorOperationPlan,
          bindings: schedulerBindings,
          preconditions:
            artifactController === null
              ? prepared.preconditions
              : artifactController.bindPreconditions(prepared.preconditions),
          locks:
            artifactController === null
              ? [{ rank: 'ledger', key: 'placements-ledger', path: ledgerPath }]
              : artifactController.locks,
          lockPort: artifactController === null ? ledgerLockPort : artifactController.lockPort,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        },
        observation,
      );
    } catch (error) {
      if (!acquisitionPreconditionStateChanged(error)) throw error;
      const reason = 'prepared placement state changed before execution';
      for (const operation of prepared.preview.plan.operations) {
        const binding = prepared.bindings.get(operation.operationId);
        if (binding === undefined) throw new Error('prepared install operation binding is missing');
        if (binding.kind !== 'pair') continue;
        const actual: InstallResult = {
          ...binding.preview,
          action: 'refused',
          reason,
          store: null,
          error: flipRefusedError(reason),
        };
        projectActual(binding, actual);
        actualByOperation.set(operation.operationId, actual);
      }
      executionResults = prepared.preview.plan.operations.map((operation) => {
        const binding = prepared.bindings.get(operation.operationId);
        if (binding?.kind === 'pair') {
          return createInstallExecutionResult(
            operation,
            actualByOperation.get(operation.operationId),
            requested,
          );
        }
        return createOperationExecutionResult({
          operationId: operation.operationId,
          outcome: 'failed',
          actualBefore: operation.before,
          actualAfter: operation.before,
          force: null,
          error: {
            code: 'precondition-state-changed',
            message: reason,
            remediation: 'Re-read portable and placement state, then retry.',
          },
        });
      });
    }
    for (const [index, operation] of prepared.preview.plan.operations.entries()) {
      if (actualByOperation.has(operation.operationId)) continue;
      const binding = prepared.bindings.get(operation.operationId);
      const execution = executionResults[index];
      if (binding === undefined || execution === undefined) {
        throw new Error('prepared install result projection is missing');
      }
      if (binding.kind !== 'pair') continue;
      if (execution.outcome === 'skipped-after-failure') {
        const actual = {
          ...binding.preview,
          action: 'skipped' as const,
          reason: 'fail-fast',
          store: null,
        };
        projectActual(binding, actual);
        actualByOperation.set(operation.operationId, actual);
      } else if (execution.outcome === 'cancelled') {
        const actual = {
          ...binding.preview,
          action: 'skipped' as const,
          reason: 'interrupted',
          store: null,
          error: cancelledError('interrupted'),
        };
        projectActual(binding, actual);
        actualByOperation.set(operation.operationId, actual);
      }
    }
    const results = prepared.legacyPreviewResults.map(
      (previewResult) => actualByPreview.get(previewResult) ?? previewResult,
    );
    return assembleInstallReport(
      false,
      requested,
      results,
      prepared.preview.plan,
      executionResults,
      {
        artifact: prepared.artifactResolution,
        ...(opts.path === undefined ? {} : { path: opts.path }),
        groupByResult: prepared.groupByResult,
      },
    );
  };
  // ---- dry-run: no lock, no writes ----
  if (opts.dryRun) {
    const ledgerRes = await readLedgerState(env, ledgerPath);
    if (!ledgerRes.ok) return err(safeError(ledgerRes.error));
    let resolution: InstallResolutionAuthority | undefined;
    try {
      resolution = await resolveAll(ledgerRes.value);
      const prepared = await prepareAll(ledgerRes.value, resolution);
      return ok('terminal' in prepared ? prepared.terminal : prepared.preview);
    } finally {
      await resolution?.cleanup();
    }
  }
  // ---- Phase 2: compatibility recovery/preparation, followed by final coordinator validation ----
  let resolution: InstallResolutionAuthority | undefined;
  const prepareLocked = async (): Promise<Result<PreparedInstallOutcome, SkillSmithError>> => {
    const ledgerRes = await readLedgerState(env, ledgerPath);
    if (!ledgerRes.ok) return err(safeError(ledgerRes.error));
    resolution = await resolveAll(ledgerRes.value);
    if (artifactStopsRecovery(resolution)) {
      return ok(await prepareAll(ledgerRes.value, resolution));
    }
    await sweepStaging(env, storeRoot);
    await sweepFetchOrphans(env, dataDir);
    if (ledgerRes.value.state === 'present' && ledgerRes.value.sourceVersion === 1) {
      return ok(await prepareAll(ledgerRes.value, resolution));
    }
    const ledger = ledgerModelForMutation(ledgerRes.value, nowOf(env, deps));
    const sweepPlaceCtx: PlaceCtx = {
      env,
      registry,
      deps,
      opts,
      ledger,
      ledgerPath,
      storeRoot,
      scope,
      scopeKey,
      projectRoot,
      installRootFor: (tool) =>
        selectedInstallRootFor(tool, {
          cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
        }),
      logicalOperation: null,
      operationObservation: undefined,
    };
    const swept = await recoverCommittedAcquireJournalsWithObservation(
      placeExecutionInput(sweepPlaceCtx),
      observation,
    );
    sweepPlaceCtx.ledger = swept.state.ledger;
    if (!swept.ok) {
      const sweepError = safeError(swept.error);
      return err(
        sweepError.code === 'ledger-error' ? flipFailedError(msg(sweepError)) : sweepError,
      );
    }
    const current = await readLedgerState(env, ledgerPath);
    if (!current.ok) return err(safeError(current.error));
    return ok(await prepareAll(current.value, resolution));
  };
  const completed = Symbol('install-prepare-lock-completed');
  let preparedResult: Result<PreparedInstallOutcome, SkillSmithError> | undefined;
  try {
    const locked = await withLedgerLock(
      env,
      ledgerPath,
      async (): Promise<typeof completed> => {
        preparedResult = await prepareLocked();
        return completed;
      },
      opts.signal === undefined ? undefined : { signal: opts.signal },
    );
    if (!locked.ok) return err(safeError(locked.error));
    const settled = preparedResult;
    if (locked.value !== completed || settled === undefined) {
      return err(genericError('operation failed'));
    }
    if (!settled.ok) return err(safeError(settled.error));
    if ('terminal' in settled.value) return ok(settled.value.terminal);
    return ok(await executePrepared(settled.value));
  } finally {
    await resolution?.cleanup();
  }
};

const runInstallWithRegistryInternal = async (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation?: ObservationBundle,
): Promise<Result<PlannedInstallReport, SkillSmithError>> =>
  runAcquisitionWithObservation(
    (state) => runInstallInternal(env, opts, deps, registry, observation, state),
    safeError,
    observation,
  );

export const runInstallWithRegistry = (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
): Promise<Result<PlannedInstallReport, SkillSmithError>> =>
  runInstallWithRegistryInternal(env, opts, deps, registry);

export const runInstallWithRegistryObserved = (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation: ObservationBundle,
): Promise<Result<PlannedInstallReport, SkillSmithError>> =>
  runInstallWithRegistryInternal(env, opts, deps, registry, observation);

export const runInstall = (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps = { ...defaultInstallDeps },
): Promise<Result<PlannedInstallReport, SkillSmithError>> =>
  runInstallWithRegistry(env, opts, deps, toolRegistry);

export {
  defaultUninstallDeps,
  runUninstall,
  runUninstallWithRegistry,
  runUninstallWithRegistryObserved,
} from './uninstall.ts';
