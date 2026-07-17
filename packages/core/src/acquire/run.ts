import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ToolCapabilityScope } from '../agents/adapter-types.ts';
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
import { manifestV1Codec } from '../artifacts/manifest-codec.ts';
import {
  type ManifestEdit,
  type ManifestEditRequest,
  editManifestBytes,
} from '../artifacts/manifest-edit.ts';
import { createNodeArtifactCoordinatorPorts } from '../artifacts/node-coordinator.ts';
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
  withLedgerPairAt,
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
import type {
  FlipTool,
  LedgerFile,
  PairRecord,
  PinnedRecord,
  Provenance,
  SwapPlan,
} from '../place/types.ts';
import {
  createBoundedForceEffect,
  createOperationExecutionResult,
  createOperationGroupId,
} from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  CurrentMutatorOperationPlan,
  ExecutableOperation,
  OperationDigest,
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
  placementBundleFor,
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
  type AcquisitionUninstallIntentV1,
  createAcquisitionDiagnosticPlan,
  createAcquisitionPlan,
  createInstallCapabilityQueries,
  createInstallPlanning,
  createUninstallCapabilityQueries,
  createUninstallPlanning,
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
  CurrentUninstallReport,
  CurrentUninstallResult,
  InstallAction,
  InstallDeps,
  InstallOptions,
  InstallReport,
  InstallResult,
  InstallScope,
  PlannedInstallReport,
  PlannedUninstallReport,
  SourceSpec,
  UninstallAction,
  UninstallDeps,
  UninstallOptions,
  UninstallReport,
  UninstallResult,
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
  } as unknown as PlannedInstallReport;
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
          const encoded = manifestV1Codec.encode(targetManifest);
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
          execution: 'selected',
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

export const defaultUninstallDeps: UninstallDeps = {};
interface UMatch {
  scope: InstallScope;
  scopeKey: string | null;
  tool: FlipTool;
  kind: 'live' | 'stale' | 'duplicate';
  placement: Placement | null; // null for 'stale'
  existing: PairRecord | null;
  notice: string | null; // legacy-root notice
  duplicatePaths?: string[];
  duplicateReason?: string;
}

const matchPathOf = (m: UMatch): string | null => {
  if (m.kind === 'duplicate') return m.duplicatePaths?.[0] ?? null;
  if (m.kind === 'stale') return m.existing?.placementPath ?? null;
  return m.placement?.path ?? null;
};

const emptyUninstallResult = (
  skill: string,
  tool: FlipTool | null,
  scope: InstallScope | null,
  action: UninstallAction,
): UninstallResult => ({
  skill,
  tool,
  scope,
  placementPath: null,
  action,
  reason: null,
  before: null,
  storeRetained: null,
  backupKept: null,
});
const notInstalledResult = (skill: string): UninstallResult => ({
  ...emptyUninstallResult(skill, null, null, 'noop'),
  reason: `'${skill}' is not installed anywhere skillsmith manages`,
});
const uninstallBeforeFromRecord = (
  mode: 'dev' | 'pinned',
  pinned: PinnedRecord | null | undefined,
  dev: PairRecord['dev'],
): UninstallResult['before'] => ({
  mode,
  placement: pinned?.placement ?? null,
  storePath: pinned?.storePath ?? null,
  symlinkTarget:
    mode === 'dev'
      ? (dev?.sourcePath ?? null)
      : pinned && pinned.placement === 'symlink'
        ? pinned.storePath
        : null,
});
const collectUninstallMatches = async (
  env: AcquisitionPorts,
  registry: LifecycleToolRegistry<string>,
  opts: UninstallOptions,
  ledger: LedgerFile,
  storeRoot: string,
  name: string,
  scopesToSearch: readonly InstallScope[],
  toolsToSearch: readonly FlipTool[],
  scopeKeyFor: (scope: InstallScope) => Promise<string | null>,
): Promise<UMatch[]> => {
  const matches: UMatch[] = [];
  for (const scope of scopesToSearch) {
    const scopeKey = await scopeKeyFor(scope);
    for (const tool of toolsToSearch) {
      const ctx = {
        cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
        configuration: opts.configuration,
      };
      const bundle = placementBundleFor(registry, tool);
      const roots = bundle.rootFacts(env, scope, ctx).map(({ path }) => path);
      const existing = getPairAt(ledger, scopeKey, name, tool);
      const resolution = await bundle.resolveScoped(env, ctx, storeRoot, name, scope);
      if (resolution.duplicateReason !== null) {
        const inventory = await bundle.listScoped(env, ctx, storeRoot, scope);
        const duplicatePaths = inventory.placements
          .filter((placement) => placement.skill === name && placement.class !== 'absent')
          .map((placement) => placement.path);
        matches.push({
          scope,
          scopeKey,
          tool,
          kind: 'duplicate',
          placement: resolution.placement,
          existing,
          notice: null,
          duplicatePaths,
          duplicateReason: resolution.duplicateReason,
        });
        continue;
      }
      if (resolution.placement.class !== 'absent') {
        const notice = resolution.notices.length === 0 ? null : resolution.notices.join('; ');
        matches.push({
          scope,
          scopeKey,
          tool,
          kind: 'live',
          placement: resolution.placement,
          existing,
          notice,
        });
        continue;
      }
      // Ledger-recorded custom placements may live outside every standard adapter root.
      if (existing?.placementPath) {
        const recordedRoot = dirname(existing.placementPath);
        if (!roots.includes(recordedRoot)) {
          const custom = await classifyPlacement(env, recordedRoot, name, storeRoot);
          if (custom.class !== 'absent') {
            matches.push({
              scope,
              scopeKey,
              tool,
              kind: 'live',
              placement: custom,
              existing,
              notice: null,
            });
            continue;
          }
        }
      }
      if (existing) {
        matches.push({
          scope,
          scopeKey,
          tool,
          kind: 'stale',
          placement: null,
          existing,
          notice: null,
        });
      }
    }
  }
  return matches;
};
interface PathTargetMatch {
  name: string;
  scope: InstallScope;
  scopeKey: string | null;
  tool: FlipTool;
  root: string;
  notice: string | null;
}
type NormalizedUninstallTarget = Readonly<
  { input: string; name: string } & (
    | { kind: 'name'; resolvedPath: null }
    | { kind: 'path'; resolvedPath: string }
  )
>;
const resolveUninstallPathTarget = async (
  env: AcquisitionPorts,
  registry: LifecycleToolRegistry<string>,
  opts: UninstallOptions,
  target: Extract<NormalizedUninstallTarget, { readonly kind: 'path' }>,
  projectRoot: string | null,
  storeRoot: string,
  toolsToSearch: readonly FlipTool[],
  explicitTools: boolean,
): Promise<Result<PathTargetMatch, SkillSmithError>> => {
  const parent = dirname(target.resolvedPath);
  const name = target.name;
  const ctxUser = { cwd: opts.cwd, configuration: opts.configuration };
  const candidates: Omit<PathTargetMatch, 'name'>[] = [];
  const uninstallTools = registry.toolsFor('uninstall') as readonly FlipTool[];
  for (const tool of uninstallTools) {
    const bundle = placementBundleFor(registry, tool);
    const resolution = await bundle.resolveScoped(env, ctxUser, storeRoot, name, 'user');
    for (const { path: root } of bundle.rootFacts(env, 'user', ctxUser)) {
      candidates.push({
        scope: 'user',
        scopeKey: null,
        tool,
        root,
        notice:
          resolution.placement.root === root && resolution.notices.length > 0
            ? resolution.notices.join('; ')
            : null,
      });
    }
  }
  if (projectRoot !== null) {
    const ctxProj = { cwd: projectRoot, configuration: opts.configuration };
    for (const tool of uninstallTools) {
      const bundle = placementBundleFor(registry, tool);
      const resolution = await bundle.resolveScoped(env, ctxProj, storeRoot, name, 'project');
      for (const { path: root } of bundle.rootFacts(env, 'project', ctxProj)) {
        candidates.push({
          scope: 'project',
          scopeKey: projectRoot,
          tool,
          root,
          notice:
            resolution.placement.root === root && resolution.notices.length > 0
              ? resolution.notices.join('; ')
              : null,
        });
      }
    }
  }
  const match = candidates.find((c) => c.root === parent);
  if (!match) {
    const roots = candidates.map((c) => c.root).join(', ');
    return err(flipRefusedError(`'${target.input}' is outside every known skills root (${roots})`));
  }
  if (opts.scope !== undefined && opts.scope !== match.scope) {
    return err(
      flipRefusedError(
        `'${target.input}' resolves to ${match.scope} scope, which is not the requested --scope`,
      ),
    );
  }
  if (explicitTools && !toolsToSearch.includes(match.tool)) {
    return err(
      flipRefusedError(
        `'${target.input}' resolves to ${match.tool}, which is not in the requested --tool set`,
      ),
    );
  }
  return ok({ name, ...match });
};
const processUninstallMatch = async (
  env: AcquisitionPorts,
  ledgerCtx: { ledger: LedgerModel },
  ledgerPath: string,
  opts: UninstallOptions,
  deps: UninstallDeps,
  name: string,
  match: UMatch,
  dryRun: boolean,
  logicalOperation: ExecutableOperation | null,
  operationObservation?: ObservationBundle,
): Promise<UninstallResult> => {
  const { scope, scopeKey, tool, existing, notice } = match;
  const executionInput = (): AcquireExecutionInput =>
    executionInputOf(env, ledgerPath, ledgerCtx.ledger, deps, opts, logicalOperation);
  const midSwap = (e: SkillSmithError): SkillSmithError =>
    e.code === 'ledger-error' ? flipFailedError(msg(e)) : e;
  const failed = (e: SkillSmithError, placementPath: string | null): UninstallResult => ({
    skill: name,
    tool,
    scope,
    placementPath,
    action: 'failed',
    reason: msg(e),
    before: null,
    storeRetained: null,
    backupKept: null,
    error: safeError(e),
  });
  if (existing?.journal && existing.journal.phase !== 'committed') {
    const placementPath = existing.placementPath;
    const before = uninstallBeforeFromRecord(existing.mode, existing.pinned, existing.dev);
    const storeRetained = existing.pinned?.storePath ?? null;
    if (existing.journal.op === 'uninstall') {
      if (dryRun) {
        return {
          skill: name,
          tool,
          scope,
          placementPath,
          action: 'removed',
          reason: notice,
          before,
          storeRetained,
          backupKept: null,
        };
      }
      const resumed = await recoverAcquireWithObservation(
        executionInput(),
        { skill: name, tool, scopeKey },
        operationObservation,
      );
      ledgerCtx.ledger = resumed.state.ledger;
      if (!resumed.ok) return failed(midSwap(resumed.error), placementPath);
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'removed',
        reason: resumed.value.warning ?? notice,
        before,
        storeRetained,
        backupKept: resumed.value.backupKept,
      };
    }
    const reason = recoveryRefusedMessage(existing.journal.op, name);
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'refused',
      reason,
      before: null,
      storeRetained: null,
      backupKept: null,
      error: flipRefusedError(reason),
    };
  }
  if (match.kind === 'duplicate') {
    const paths = match.duplicatePaths ?? [];
    const reason =
      match.duplicateReason ??
      `found in multiple adapter roots: ${paths.join(', ')}; resolve the duplicate first`;
    return {
      skill: name,
      tool,
      scope,
      placementPath: paths[0] ?? null,
      action: 'refused',
      reason,
      before: null,
      storeRetained: null,
      backupKept: null,
      error: flipRefusedError(reason),
    };
  }
  if (match.kind === 'stale') {
    const ex = existing as PairRecord;
    const placementPath = ex.placementPath;
    const before = uninstallBeforeFromRecord(ex.mode, ex.pinned, ex.dev);
    const storeRetained = ex.pinned?.storePath ?? null;
    const reason = 'placement was already gone';
    if (dryRun) {
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'removed',
        reason,
        before,
        storeRetained,
        backupKept: null,
      };
    }
    if (logicalOperation === null) {
      return failed(
        flipFailedError('record-only stale uninstall requires logical operation identity'),
        placementPath,
      );
    }
    const persisted = await executeRecordOnlyAcquirePlanWithObservation(
      executionInput(),
      logicalOperation,
      ex,
      scopeKey,
      operationObservation,
    );
    ledgerCtx.ledger = persisted.state.ledger;
    if (!persisted.ok) return failed(persisted.error, placementPath);
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'removed',
      reason,
      before,
      storeRetained,
      backupKept: null,
    };
  }
  const placement = match.placement as Placement;
  const placementPath = placement.path;
  if (existing) {
    const existingPinned = existing.pinned ?? null;
    // `!= null` distinguishes an omitted raw pin from a retained pin that force must protect.
    if (existing.mode === 'dev' && existingPinned !== null && !opts.force) {
      const reason = `'${name}' (${tool}) is in dev mode — a live symlink into a working checkout. Run 'skillsmith promote ${name}' to pin it first, or 'skillsmith dev --rollback ${name}' to restore the pinned copy, or pass --force to remove the symlink — the checkout itself is never touched.`;
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'refused',
        reason,
        before: null,
        storeRetained: null,
        backupKept: null,
        error: flipRefusedError(reason),
      };
    }
    if (
      existing.mode === 'pinned' &&
      existingPinned !== null &&
      (existingPinned.placement ?? 'copy') === 'copy' &&
      placement.class === 'pinned'
    ) {
      const observedHash = await contentHashOf(env, placementPath);
      if (!observedHash.ok) return failed(observedHash.error, placementPath);
      if (observedHash.value !== existingPinned.contentHash && !opts.force) {
        const reason = `'${name}' (${tool}) is a modified managed copy; pass --force to preserve a backup and remove it`;
        return {
          skill: name,
          tool,
          scope,
          placementPath,
          action: 'refused',
          reason,
          before: uninstallBeforeFromRecord(existing.mode, existingPinned, existing.dev),
          storeRetained: existingPinned.storePath,
          backupKept: null,
          error: flipRefusedError(reason),
        };
      }
    }
    const before = uninstallBeforeFromRecord(existing.mode, existing.pinned, existing.dev);
    const storeRetained = existing.pinned?.storePath ?? null;
    if (dryRun) {
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'removed',
        reason: notice,
        before,
        storeRetained,
        backupKept: null,
      };
    }
    const plan: SwapPlan = {
      op: 'uninstall',
      skill: name,
      tool,
      skillsRoot: dirname(placement.path),
      placementPath: placement.path,
      scopeKey,
    };
    const swapRes = await executeAcquirePlanWithObservation(
      executionInput(),
      plan,
      operationObservation,
    );
    ledgerCtx.ledger = swapRes.state.ledger;
    if (!swapRes.ok) return failed(midSwap(swapRes.error), placementPath);
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'removed',
      reason: swapRes.value.warning ?? notice,
      before,
      storeRetained,
      backupKept: swapRes.value.backupKept,
    };
  }
  if (!opts.force) {
    const reason = `'${name}' (${tool}) has no skillsmith record; pass --force to remove it anyway`;
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'refused',
      reason,
      before: null,
      storeRetained: null,
      backupKept: null,
      error: flipRefusedError(reason),
    };
  }
  const mode: 'dev' | 'pinned' = placement.class === 'dev' ? 'dev' : 'pinned';
  const before: UninstallResult['before'] = {
    mode,
    placement: null,
    storePath: null,
    symlinkTarget: placement.symlinkTarget ?? null,
  };
  if (dryRun) {
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'removed',
      reason: notice,
      before,
      storeRetained: null,
      backupKept: null,
    };
  }
  const synth: PairRecord = {
    placementPath: placement.path,
    mode,
    dev: null,
    pinned: null,
    journal: null,
  };
  const staged = withLedgerPairAt(ledgerCtx.ledger, scopeKey, name, tool, synth);
  if (!staged.ok) return failed(staged.error, placementPath);
  ledgerCtx.ledger = staged.value;
  const plan: SwapPlan = {
    op: 'uninstall',
    skill: name,
    tool,
    skillsRoot: dirname(placement.path),
    placementPath: placement.path,
    scopeKey,
  };
  const swapRes = await executeAcquirePlanWithObservation(
    executionInput(),
    plan,
    operationObservation,
  );
  ledgerCtx.ledger = swapRes.state.ledger;
  if (!swapRes.ok) return failed(midSwap(swapRes.error), placementPath);
  return {
    skill: name,
    tool,
    scope,
    placementPath,
    action: 'removed',
    reason: swapRes.value.warning ?? notice,
    before,
    storeRetained: null,
    backupKept: swapRes.value.backupKept,
  };
};
const isUninstallPathTarget = (target: string): boolean =>
  target.includes('/') || isAbsolute(target);
const processUninstallTarget = async (
  env: AcquisitionPorts,
  registry: LifecycleToolRegistry<string>,
  ledger: LedgerFile,
  ledgerCtx: { ledger: LedgerModel },
  ledgerPath: string,
  storeRoot: string,
  opts: UninstallOptions,
  deps: UninstallDeps,
  target: NormalizedUninstallTarget,
  projectRoot: string | null,
  scopesToSearch: readonly InstallScope[],
  toolsToSearch: readonly FlipTool[],
  explicitTools: boolean,
  scopeKeyFor: (scope: InstallScope) => Promise<string | null>,
  dryRun: boolean,
  bind?: (preview: UninstallResult, name: string, match: UMatch) => void,
): Promise<UninstallResult[]> => {
  if (target.kind === 'path') {
    const resolved = await resolveUninstallPathTarget(
      env,
      registry,
      opts,
      target,
      projectRoot,
      storeRoot,
      toolsToSearch,
      explicitTools,
    );
    if (!resolved.ok) {
      return [
        {
          ...emptyUninstallResult(target.name, null, null, 'refused'),
          reason: msg(resolved.error),
          error: safeError(resolved.error),
        },
      ];
    }
    const { name, scope, scopeKey, tool, root, notice } = resolved.value;
    const existing = getPairAt(ledger, scopeKey, name, tool);
    const placement = await classifyPlacement(env, root, name, storeRoot);
    let match: UMatch;
    if (placement.class !== 'absent') {
      match = { scope, scopeKey, tool, kind: 'live', placement, existing, notice };
    } else if (existing) {
      match = { scope, scopeKey, tool, kind: 'stale', placement: null, existing, notice: null };
    } else {
      return [notInstalledResult(name)];
    }
    const preview = await processUninstallMatch(
      env,
      ledgerCtx,
      ledgerPath,
      opts,
      deps,
      name,
      match,
      dryRun,
      null,
    );
    if (dryRun && (preview.action === 'removed' || preview.action === 'refused')) {
      bind?.(preview, name, match);
    }
    return [preview];
  }
  const matches = await collectUninstallMatches(
    env,
    registry,
    opts,
    ledger,
    storeRoot,
    target.name,
    scopesToSearch,
    toolsToSearch,
    scopeKeyFor,
  );
  if (matches.length === 0) return [notInstalledResult(target.name)];
  const distinctScopes = new Set(matches.map((m) => m.scope));
  if (distinctScopes.size > 1 && opts.scope === undefined && !opts.allScopes) {
    const list = matches
      .map((m) => `${m.scope} (${m.tool} at ${matchPathOf(m) ?? '<unknown>'})`)
      .join(', ');
    const reason = `'${target.input}' is installed in multiple scopes: ${list}; disambiguate with --scope, --tool, or --all-scopes`;
    return [
      {
        ...emptyUninstallResult(target.name, null, null, 'refused'),
        reason,
        error: flipRefusedError(reason),
      },
    ];
  }

  const results: UninstallResult[] = [];
  for (const match of matches) {
    const preview = await processUninstallMatch(
      env,
      ledgerCtx,
      ledgerPath,
      opts,
      deps,
      target.name,
      match,
      dryRun,
      null,
    );
    if (dryRun && (preview.action === 'removed' || preview.action === 'refused')) {
      bind?.(preview, target.name, match);
    }
    results.push(preview);
  }
  return results;
};

type ProjectedUninstallResult = Omit<UninstallResult, 'action'> &
  Readonly<{ action: UninstallAction | 'skipped' }>;
const uninstallSummary = (
  results: readonly ProjectedUninstallResult[],
): UninstallReport['summary'] & Readonly<{ skipped: number }> => {
  const summary = { removed: 0, noop: 0, skipped: 0, refused: 0, failed: 0 };
  for (const result of results) summary[result.action]++;
  return summary;
};

type UninstallArtifactResolution = Awaited<
  ReturnType<typeof resolveAcquisitionArtifactDestinationV1>
>;
interface UninstallReportAssemblyContext {
  readonly artifact?: UninstallArtifactResolution;
  readonly groupByResult?: ReadonlyMap<string, string>;
  readonly requestIndices?: readonly number[];
}
const uninstallResultFactKey = (
  result: Pick<UninstallResult, 'skill' | 'tool' | 'scope' | 'placementPath'>,
): string => JSON.stringify([result.skill, result.tool, result.scope, result.placementPath]);
const currentUninstallArtifactEffects = (
  plan: OperationPlan<'uninstall'>,
  executionResults: readonly OperationExecutionResult[],
  results: readonly ProjectedUninstallResult[],
  groupByResult: ReadonlyMap<string, string>,
  dryRun: boolean,
): CurrentUninstallReport['artifactEffects'] => {
  const executionById = new Map(
    executionResults.map((execution) => [execution.operationId, execution]),
  );
  const groupIds = [
    ...new Set(
      plan.operations
        .filter(
          ({ kind }) =>
            kind === 'migrate-project-config' || kind === 'write-manifest' || kind === 'write-lock',
        )
        .map(({ groupId }) => groupId),
    ),
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
    const retained = !dryRun && (failed !== undefined || skipped !== undefined);
    const manifestAfter =
      manifest?.after.kind === 'manifest' ? manifest.after.value.skills : undefined;
    const lockAfter = lock?.after.kind === 'lock' ? lock.after.value.skills : undefined;
    const skill =
      results.find((result) => groupByResult.get(uninstallResultFactKey(result)) === groupId)
        ?.skill ??
      manifest?.skill ??
      lock?.skill ??
      null;
    return {
      groupId,
      skill,
      manifestAction:
        manifest === undefined
          ? 'keep'
          : retained
            ? 'retain'
            : manifestAfter?.some(({ name }) => name === skill)
              ? 'update'
              : 'remove-declaration',
      lockAction:
        lock === undefined
          ? 'keep'
          : retained
            ? 'retain'
            : lockAfter?.some(({ name }) => name === skill)
              ? 'update'
              : 'remove-entry',
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
          (executions.length === 0 ? 'not-run' : 'succeeded')),
      reason:
        failed?.error?.message ??
        (retained ? 'incomplete uninstall retained portable intent' : null),
    };
  });
};

const assembleUninstallReport = (
  dryRun: boolean,
  requested: UninstallReport['requested'],
  results: ProjectedUninstallResult[],
  plan: OperationPlan<'uninstall'>,
  executionResults: readonly OperationExecutionResult[],
  context: UninstallReportAssemblyContext = {},
): PlannedUninstallReport => {
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
  const currentResults: CurrentUninstallResult[] = results.map((result, resultIndex) => {
    const requestIndex = context.requestIndices?.[resultIndex] ?? resultIndex;
    const groupId = groupByResult.get(uninstallResultFactKey(result)) ?? null;
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
      artifact.outcome === 'selected' &&
      artifactOperations.length > 0 &&
      (dryRun ||
        artifactOperations.every(
          (candidate) => executionById.get(candidate.operationId)?.outcome === 'succeeded',
        ));
    const executionOutcome = dryRun
      ? null
      : (execution?.outcome ??
        (result.action === 'noop' && artifactDurable ? ('succeeded' as const) : null));
    const liveRemovalSucceeded =
      result.action === 'removed' && (dryRun || executionOutcome === 'succeeded');
    const drift: CurrentUninstallResult['drift'] =
      artifact.saveMode === 'live-only' || artifact.outcome !== 'selected'
        ? {
            status: 'not-evaluated',
            futureApply: 'depends-on-selected-manifest',
            reason: null,
          }
        : artifactDurable
          ? { status: 'in-sync', futureApply: 'none', reason: null }
          : liveRemovalSucceeded
            ? {
                status: 'desired-without-live',
                futureApply: 'restore-live',
                reason: 'portable intent was retained after an incomplete uninstall',
              }
            : {
                status: 'in-sync',
                futureApply: 'none',
                reason: result.reason,
              };
    return {
      ...result,
      requestIndex,
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
                execution?.outcome === 'succeeded',
              ))) as CurrentUninstallResult['force'],
    };
  });
  let artifactEffects =
    artifact.saveMode === 'live-only' || artifact.outcome !== 'selected'
      ? []
      : currentUninstallArtifactEffects(plan, executionResults, results, groupByResult, dryRun);
  if (
    artifact.outcome === 'selected' &&
    artifactEffects.length === 0 &&
    results.length > 0 &&
    !results.some(({ reason }) => reason?.includes('deferred to G4A-04') === true)
  ) {
    artifactEffects = [...new Set(results.map(({ skill }) => skill))].map((skill) => ({
      groupId: null,
      skill,
      manifestAction: 'not-write' as const,
      lockAction: 'not-write' as const,
      migration: 'none' as const,
      outcome: 'not-run' as const,
      reason: 'selected artifact pair contains no writable requested declaration',
    }));
  }
  const legacySummary = uninstallSummary(currentResults);
  const desiredState = {
    changed: artifactEffects.filter(
      ({ manifestAction, lockAction, outcome }) =>
        (outcome === 'planned' || outcome === 'succeeded') &&
        (manifestAction === 'update' ||
          manifestAction === 'remove-declaration' ||
          lockAction === 'update' ||
          lockAction === 'remove-entry'),
    ).length,
    unchanged: artifactEffects.filter(
      ({ manifestAction, lockAction }) => manifestAction === 'keep' && lockAction === 'keep',
    ).length,
    retained: artifactEffects.filter(
      ({ manifestAction, lockAction }) => manifestAction === 'retain' || lockAction === 'retain',
    ).length,
    notWritten:
      artifact.saveMode === 'live-only'
        ? currentResults.length
        : artifactEffects.filter(
            ({ manifestAction, lockAction }) =>
              manifestAction === 'not-write' || lockAction === 'not-write',
          ).length,
    failed: artifactEffects.filter(
      ({ outcome }) =>
        outcome !== 'planned' &&
        outcome !== 'succeeded' &&
        outcome !== 'not-run' &&
        outcome !== 'skipped-after-failure',
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
    requested: { ...requested, batchPolicy: plan.batchPolicy },
    results: currentResults,
    summary: { ...legacySummary, desiredState },
    plan,
    executionResults,
  } as unknown as PlannedUninstallReport;
};

const createUninstallExecutionResult = (
  operation: ExecutableOperation,
  result: ProjectedUninstallResult | undefined,
  requested: UninstallReport['requested'],
): OperationExecutionResult => {
  const cancelled = result?.reason === 'interrupted';
  const skippedAfterFailure = result?.action === 'skipped' && result.reason === 'fail-fast';
  const succeeded = result?.action === 'removed';
  const common = {
    operationId: operation.operationId,
    actualBefore: operation.before,
    actualAfter: succeeded ? operation.after : operation.before,
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
        code: result?.error?.code ?? 'uninstall-failed',
        message: closedPlanningText(result?.reason ?? null, 'prepared uninstall binding failed'),
        remediation: 'Resolve the reported condition and retry the same selection.',
      },
    });
  }
  return createOperationExecutionResult({ ...common, outcome: 'succeeded', error: null });
};

const runUninstallInternal = async (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation?: ObservationBundle,
  planObservation?: AcquisitionPlanObservationState,
): Promise<Result<PlannedUninstallReport, SkillSmithError>> => {
  const dataDir = resolveDataDir(env, opts.configuration);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const explicitTools = opts.tools !== undefined && opts.tools.length > 0;
  const toolsToSearch: FlipTool[] = explicitTools
    ? [...(opts.tools as FlipTool[])]
    : [...(registry.toolsFor('uninstall') as readonly FlipTool[])];

  const requested: UninstallReport['requested'] = {
    targets: [...opts.targets],
    tools: toolsToSearch,
    explicitTools,
    scope: opts.scope ?? null,
    allScopes: Boolean(opts.allScopes),
    force: Boolean(opts.force),
  };
  const planningTargets = [...new Set(requested.targets)].filter((target) => target.length > 0);
  const planningRequested = {
    ...requested,
    targets: planningTargets.length === 0 ? ['[unresolved target]'] : planningTargets,
  };
  const projectContext = await resolveAcquisitionProjectContextV1({
    env,
    cwd: opts.cwd,
    ...(opts.configuration.explicitConfigPath === undefined
      ? {}
      : { explicitConfigPath: opts.configuration.explicitConfigPath }),
  });
  const projectRoot = projectContext.projectRoot;
  const scopesToSearch: InstallScope[] =
    opts.scope !== undefined ? [opts.scope] : projectRoot !== null ? ['user', 'project'] : ['user'];
  const scopeKeyFor = async (scope: InstallScope): Promise<string | null> =>
    scope === 'project' ? (projectRoot ?? (await env.realpath(opts.cwd))) : null;
  const normalizedTargets: readonly NormalizedUninstallTarget[] = opts.targets.map((input) => {
    if (!isUninstallPathTarget(input))
      return { input, kind: 'name', name: input, resolvedPath: null };
    const resolvedPath = resolve(projectContext.effectiveCwd, input);
    return { input, kind: 'path', name: basename(resolvedPath), resolvedPath };
  });
  const artifactResolution = await resolveAcquisitionArtifactDestinationV1({
    ports: env,
    projectContext,
    names: [...new Set(normalizedTargets.map(({ name }) => name))],
    scope: opts.scope ?? (projectRoot === null ? 'user' : 'project'),
    mode: 'remove',
    ...(opts.file === undefined ? {} : { file: opts.file }),
    ...(opts.lockfile === undefined ? {} : { lockfile: opts.lockfile }),
    ...(opts.noSave === undefined ? {} : { noSave: opts.noSave }),
  });
  const preResolutionFailure =
    normalizedTargets.length === 0 ||
    normalizedTargets.some(({ name }) => name.length === 0) ||
    (artifactResolution.outcome === 'none' &&
      artifactResolution.saveMode === 'desired-state' &&
      artifactResolution.selection.reason === 'pre-resolution-failure');
  if (artifactResolution.outcome === 'refused' || preResolutionFailure) {
    const reason =
      artifactResolution.outcome === 'refused'
        ? artifactResolution.cause.message
        : 'uninstall targets must resolve to nonempty declaration names';
    const error =
      artifactResolution.outcome !== 'refused' || artifactResolution.cause.exitClass === 'usage'
        ? flipRefusedError(reason)
        : configError(reason);
    const results = (normalizedTargets.length === 0 ? [{ name: '' }] : normalizedTargets).map(
      ({ name }) => ({
        ...emptyUninstallResult(
          name.length === 0 ? '[unresolved target]' : name,
          null,
          null,
          'refused' as const,
        ),
        reason,
        error,
      }),
    );
    const plan = createUninstallPlanning(planningRequested, results, projectRoot, {
      registry,
      toolOrder: registry.ids,
    }).plan;
    return ok(
      assembleUninstallReport(Boolean(opts.dryRun), requested, results, plan, [], {
        artifact: artifactResolution,
      }),
    );
  }
  const requestedDeclarationNames =
    artifactResolution.outcome === 'selected'
      ? [
          ...new Set(
            normalizedTargets
              .map(({ name }) => name)
              .filter((name) => artifactResolution.declaredNames.includes(name)),
          ),
        ]
      : [];
  if (requestedDeclarationNames.length > 1) {
    const reason = 'multiple saving declaration groups are deferred to G4A-04';
    const results = normalizedTargets.map(({ name }) => ({
      ...emptyUninstallResult(name, null, null, 'refused' as const),
      reason,
      error: flipRefusedError(reason),
    }));
    const plan = createUninstallPlanning(planningRequested, results, projectRoot, {
      registry,
      toolOrder: registry.ids,
    }).plan;
    return ok(
      assembleUninstallReport(Boolean(opts.dryRun), requested, results, plan, [], {
        artifact: artifactResolution,
      }),
    );
  }
  interface PreparedUninstallPairBinding {
    readonly kind: 'pair';
    readonly preview: UninstallResult;
    readonly reportPreviews: readonly UninstallResult[];
    readonly actualBefore: OperationImage;
    readonly liveResourceId: string;
    observe(): Promise<UninstallPreconditionFacts>;
    execute(
      operation: ExecutableOperation,
      operationObservation?: ObservationBundle,
    ): Promise<UninstallResult>;
  }
  interface PreparedUninstallMigrationBinding {
    readonly kind: 'migrate-ledger';
    readonly expectedState: Extract<LedgerReadState, { readonly state: 'present' }>;
    onMigrated(model: LedgerModel): void;
  }
  interface PreparedUninstallArtifactBinding {
    readonly kind: 'artifact';
    readonly action: AcquisitionArtifactExecutionActionV1;
  }
  type PreparedUninstallBinding =
    | PreparedUninstallPairBinding
    | PreparedUninstallMigrationBinding
    | PreparedUninstallArtifactBinding;
  interface PreparedUninstallBatch {
    readonly preview: PlannedUninstallReport;
    readonly legacyPreviewResults: readonly UninstallResult[];
    readonly requestIndices: readonly number[];
    readonly bindings: ReadonlyMap<string, PreparedUninstallBinding>;
    readonly preconditions: readonly ExecutionPrecondition[];
    readonly snapshotAuthority: AcquisitionSnapshotAuthorityV1;
    readonly expectedRevisions: readonly ExpectedRevisionV1[];
    readonly snapshotId: `snapshot:v1:${string}`;
    readonly artifactResolution: typeof artifactResolution;
    readonly groupByResult: ReadonlyMap<string, string>;
  }
  interface UninstallPreconditionFacts {
    readonly projectRoot: string | null;
    readonly selectedPair: PairRecord | null;
    readonly live: AcquirePlacementFacts;
    readonly store: AcquireContentFacts | null;
    readonly selectionKind: 'live' | 'stale' | 'absent';
    readonly selection: readonly Readonly<{
      scope: InstallScope;
      scopeKey: string | null;
      tool: FlipTool;
      kind: UMatch['kind'];
      paths: readonly string[];
      pair: PairRecord | null;
    }>[];
  }
  interface UninstallBindingSeed {
    readonly preview: UninstallResult;
    readonly target: NormalizedUninstallTarget;
    readonly name: string;
    readonly match: UMatch;
    execute(
      operation: ExecutableOperation,
      operationObservation?: ObservationBundle,
    ): Promise<UninstallResult>;
  }
  interface PreparedUninstallIntent {
    readonly seed: UninstallBindingSeed;
    readonly expectedFacts: UninstallPreconditionFacts;
    readonly intent: AcquisitionUninstallIntentV1;
    readonly capabilityScope: ToolCapabilityScope;
  }
  interface PreparedUninstallArtifactPlanning {
    readonly transition: AcquisitionArtifactTransitionEnvelopeV1 | undefined;
    readonly actions: ReadonlyMap<string, AcquisitionArtifactExecutionActionV1>;
  }
  const artifactBindingKey = (groupId: string, kind: ExecutableOperation['kind']): string =>
    `${groupId}:${kind}`;
  const prepareUninstallArtifactPlanning = async (
    snapshotAuthority: AcquisitionSnapshotAuthorityV1,
    prepared: readonly PreparedUninstallIntent[],
  ): Promise<PreparedUninstallArtifactPlanning> => {
    const artifact = snapshotAuthority.snapshot.artifact;
    if (artifact.mode === 'none') {
      return Object.freeze({ transition: undefined, actions: new Map() });
    }
    if (
      artifact.manifest.revision.state === 'absent' ||
      artifact.manifest.value === null ||
      prepared.length === 0
    ) {
      return Object.freeze({ transition: undefined, actions: new Map() });
    }
    const manifestModel = artifact.manifest.value;
    const declarations = manifestModel.skills.filter(({ name }) =>
      prepared.some(({ intent }) => intent.skill === name),
    );
    if (declarations.length === 0) {
      return Object.freeze({ transition: undefined, actions: new Map() });
    }
    if (declarations.length > 1) {
      throw new Error('selected uninstall artifact has multiple requested declarations');
    }
    const declaration = declarations[0];
    if (declaration === undefined) {
      return Object.freeze({ transition: undefined, actions: new Map() });
    }
    const declaredPrepared = prepared.filter(
      ({ intent }) =>
        intent.skill === declaration.name &&
        intent.scope === declaration.scope &&
        declaration.tools.includes(intent.tool),
    );
    const seed = declaredPrepared[0];
    if (seed === undefined) {
      return Object.freeze({ transition: undefined, actions: new Map() });
    }
    const groupIdentity = {
      domain: 'skillsmith.operation-group-identity' as const,
      schemaVersion: 1 as const,
      command: 'uninstall' as const,
      skill: seed.intent.skill,
      source: null,
      scope: seed.intent.scope,
      target: seed.intent.skill,
    };
    const groupId = createOperationGroupId(groupIdentity);
    const unchangedGroups = [
      ...new Map(
        prepared
          .map(({ intent }) => ({
            domain: 'skillsmith.operation-group-identity' as const,
            schemaVersion: 1 as const,
            command: 'uninstall' as const,
            skill: intent.skill,
            source: null,
            scope: intent.scope,
            target: intent.skill,
          }))
          .filter((identity) => createOperationGroupId(identity) !== groupId)
          .map((identity) => [createOperationGroupId(identity), identity]),
      ).values(),
    ];
    const manifestPath = artifact.pair.file.path;
    const lockPath = artifact.pair.lockfile.path;
    let manifestBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(
      await env.readBytes(manifestPath),
    );
    const initialManifest = acquisitionManifestImageFromBytesV1(manifestPath, manifestBytes);
    const selectedTools = new Set(declaredPrepared.map(({ intent }) => intent.tool));
    const remainingTools = declaration.tools.filter((tool) => !selectedTools.has(tool));
    const declarationIndex = manifestModel.skills.findIndex(
      ({ name }) => name === declaration.name,
    );
    const nextSkills = [...manifestModel.skills];
    if (remainingTools.length === 0) {
      nextSkills.splice(declarationIndex, 1);
    } else {
      nextSkills[declarationIndex] = Object.freeze({
        ...declaration,
        tools: Object.freeze(remainingTools),
      });
    }
    const nextManifest: NormalizedManifestV1 = Object.freeze({
      ...manifestModel,
      skills: Object.freeze(nextSkills),
    });
    const actions = new Map<string, AcquisitionArtifactExecutionActionV1>();
    let migrationAfter:
      | AcquisitionArtifactTransitionEnvelopeV1['groups'][number]['migrationAfter']
      | undefined;
    if (initialManifest.kind === 'manifest' && initialManifest.shape === 'legacy') {
      const request = Object.freeze({
        edits: Object.freeze([{ kind: 'migrate-legacy' as const }]),
      });
      const migrated = editManifestBytes(manifestBytes, request);
      if (!migrated.ok) throw migrated.error;
      manifestBytes = migrated.value.bytes;
      migrationAfter = acquisitionManifestImageFromBytesV1(manifestPath, manifestBytes);
      actions.set(
        artifactBindingKey(groupId, 'migrate-project-config'),
        Object.freeze({
          role: 'manifest' as const,
          action: Object.freeze({ kind: 'edit' as const, request }),
        }),
      );
    }
    const manifestRequest: ManifestEditRequest = Object.freeze({
      edits: Object.freeze([
        remainingTools.length === 0
          ? ({ kind: 'remove-skill', name: declaration.name } as const)
          : ({
              kind: 'set-skill-field',
              name: declaration.name,
              field: 'tools',
              value: Object.freeze(remainingTools),
            } as const),
      ]),
    });
    const editedManifest = editManifestBytes(manifestBytes, manifestRequest);
    if (!editedManifest.ok) throw editedManifest.error;
    manifestBytes = editedManifest.value.bytes;
    const manifestAfter = acquisitionManifestImageFromBytesV1(manifestPath, manifestBytes);
    actions.set(
      artifactBindingKey(groupId, 'write-manifest'),
      Object.freeze({
        role: 'manifest' as const,
        action: Object.freeze({ kind: 'edit' as const, request: manifestRequest }),
      }),
    );

    let initialLock: AcquisitionArtifactTransitionEnvelopeV1['initial']['lock'];
    let lockModel: PortableLockV1;
    if (artifact.lock.revision.state === 'absent') {
      initialLock = Object.freeze({
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
      initialLock = acquisitionLockImageFromBytesV1(lockPath, lockBytes);
      if (artifact.lock.value === null) {
        throw new Error('selected uninstall lock model is missing');
      }
      lockModel = artifact.lock.value;
    }
    const targetLock: PortableLockV1 = Object.freeze({
      ...lockModel,
      version: 1 as const,
      hashSchemaVersion: HASH_SCHEMA_VERSION,
      manifestHash: hashManifestSemantics(nextManifest),
      skills: Object.freeze(
        remainingTools.length === 0
          ? lockModel.skills.filter(({ name }) => name !== declaration.name)
          : [...lockModel.skills],
      ),
    });
    const serializedLock = serializePortableLock(targetLock);
    if (!serializedLock.ok) throw new Error('uninstall portable lock could not be serialized');
    const lockAfter = acquisitionLockImageFromBytesV1(
      lockPath,
      new TextEncoder().encode(serializedLock.value),
    );
    actions.set(
      artifactBindingKey(groupId, 'write-lock'),
      Object.freeze({
        role: 'lock' as const,
        action: Object.freeze({ kind: 'replace' as const, lock: targetLock }),
      }),
    );
    return Object.freeze({
      transition: Object.freeze({
        initial: Object.freeze({ manifest: initialManifest, lock: initialLock }),
        groups: Object.freeze([
          Object.freeze({
            groupIdentity,
            ...(migrationAfter === undefined ? {} : { migrationAfter }),
            manifestAfter: manifestAfter as Extract<OperationImage, { readonly kind: 'manifest' }>,
            lockAfter,
          }),
        ]),
        unchangedGroups: Object.freeze(unchangedGroups),
      }),
      actions,
    });
  };

  const observeUninstallFacts = async (
    seed: UninstallBindingSeed,
  ): Promise<UninstallPreconditionFacts> => {
    const expectedPath = seed.preview.placementPath;
    if (expectedPath === null) throw new Error('prepared uninstall facts require a live path');
    const ledgerResult = await readLedgerState(env, ledgerPath);
    if (!ledgerResult.ok) throw ledgerResult.error;
    const ledger = ledgerModelForMutation(ledgerResult.value, nowOf(env, deps));
    const selectedPair = getPairAt(ledger, seed.match.scopeKey, seed.name, seed.match.tool);
    const live = await acquirePlacementFacts(env, dirname(expectedPath), seed.name, storeRoot);
    const storePath = selectedPair?.pinned?.storePath ?? null;
    const selectionMatches =
      seed.target.kind === 'path'
        ? [
            {
              scope: seed.match.scope,
              scopeKey: seed.match.scopeKey,
              tool: seed.match.tool,
              kind: live.placement.class === 'absent' ? ('stale' as const) : ('live' as const),
              placement: live.placement.class === 'absent' ? null : live.placement,
              existing: selectedPair,
              notice: seed.match.notice,
            } satisfies UMatch,
          ]
        : await collectUninstallMatches(
            env,
            registry,
            opts,
            legacyLedgerView(ledger),
            storeRoot,
            seed.target.name,
            scopesToSearch,
            toolsToSearch,
            scopeKeyFor,
          );
    return {
      projectRoot,
      selectedPair: structuredClone(selectedPair),
      live,
      store: storePath === null ? null : await acquireContentFacts(env, storePath),
      selectionKind:
        live.placement.class === 'absent' ? (selectedPair === null ? 'absent' : 'stale') : 'live',
      selection: selectionMatches.map((match) => ({
        scope: match.scope,
        scopeKey: match.scopeKey,
        tool: match.tool,
        kind: match.kind,
        paths:
          match.kind === 'duplicate'
            ? [...(match.duplicatePaths ?? [])]
            : [matchPathOf(match)].filter((path): path is string => path !== null),
        pair: structuredClone(match.existing),
      })),
    };
  };

  const prepareAll = async (ledgerState: LedgerReadState): Promise<PreparedUninstallBatch> => {
    const ledger = ledgerModelForMutation(ledgerState, nowOf(env, deps));
    const legacyLedger = legacyLedgerView(ledger);
    const ledgerCtx = { ledger };
    const results: UninstallResult[] = [];
    const requestIndexByResult = new Map<UninstallResult, number>();
    const resultsByTarget = new Map<NormalizedUninstallTarget, UninstallResult[]>();
    const candidateBindings = new Map<UninstallResult, UninstallBindingSeed>();
    let selectedManifest: NormalizedManifestV1 | null = null;
    if (
      artifactResolution.outcome === 'selected' &&
      (await env.pathKind(artifactResolution.pair.file.path)) !== 'absent'
    ) {
      const decoded = manifestV1Codec.decode(
        new Uint8Array(await env.readBytes(artifactResolution.pair.file.path)),
      );
      if (!decoded.ok) throw decoded.error;
      selectedManifest = decoded.value.model;
    }
    for (const [requestIndex, target] of normalizedTargets.entries()) {
      const targetResults = await processUninstallTarget(
        env,
        registry,
        legacyLedger,
        ledgerCtx,
        ledgerPath,
        storeRoot,
        opts,
        deps,
        target,
        projectRoot,
        scopesToSearch,
        toolsToSearch,
        explicitTools,
        scopeKeyFor,
        true,
        (preview, name, match) => {
          candidateBindings.set(preview, {
            preview,
            target,
            name,
            match,
            execute: (operation, operationObservation) =>
              processUninstallMatch(
                env,
                ledgerCtx,
                ledgerPath,
                opts,
                deps,
                name,
                match,
                false,
                operation,
                operationObservation,
              ),
          });
        },
      );
      resultsByTarget.set(target, targetResults);
      for (const result of targetResults) {
        results.push(result);
        requestIndexByResult.set(result, requestIndex);
      }
    }
    if (selectedManifest !== null) {
      for (const target of normalizedTargets) {
        const declaration = selectedManifest.skills.find(({ name }) => name === target.name);
        if (declaration === undefined || !scopesToSearch.includes(declaration.scope)) continue;
        const targetResults = resultsByTarget.get(target) ?? [];
        if (
          targetResults.some(
            (result) =>
              result.skill === target.name && result.tool === null && result.action === 'refused',
          )
        ) {
          continue;
        }
        const selectedTools = declaration.tools.filter((tool): tool is FlipTool =>
          toolsToSearch.includes(tool as FlipTool),
        );
        const alreadyPrepared = new Set(
          [...candidateBindings.values()]
            .filter((seed) => seed.target === target)
            .map((seed) => JSON.stringify([seed.match.scope, seed.match.tool])),
        );
        const synthesized: UninstallResult[] = [];
        for (const tool of selectedTools) {
          const scope = declaration.scope;
          if (alreadyPrepared.has(JSON.stringify([scope, tool]))) continue;
          const scopeKey = await scopeKeyFor(scope);
          const rootsContext = {
            cwd: scopeKey ?? opts.cwd,
            configuration: opts.configuration,
          };
          const root =
            declaration.path === null
              ? destinationSkillRootFor(registry, tool, env, scope, rootsContext)
              : declaration.path.startsWith('~/')
                ? resolve(env.homeDir, declaration.path.slice(2))
                : declaration.path.startsWith('./')
                  ? resolve(scopeKey ?? opts.cwd, declaration.path.slice(2))
                  : resolve(rootsContext.cwd, declaration.path);
          const placementPath = join(root, target.name);
          const preview: UninstallResult = {
            skill: target.name,
            tool,
            scope,
            placementPath,
            action: 'noop',
            reason: 'placement was already absent; portable intent will be removed',
            before: null,
            storeRetained: null,
            backupKept: null,
          };
          const match: UMatch = {
            scope,
            scopeKey,
            tool,
            kind: 'stale',
            placement: null,
            existing: null,
            notice: null,
          };
          candidateBindings.set(preview, {
            preview,
            target,
            name: target.name,
            match,
            execute: async () => {
              throw new Error('artifact-only uninstall binding cannot execute live state');
            },
          });
          synthesized.push(preview);
        }
        if (synthesized.length > 0) {
          resultsByTarget.set(
            target,
            targetResults
              .filter((result) => result.tool !== null || result.action !== 'noop')
              .concat(synthesized),
          );
        }
      }
    }
    results.length = 0;
    requestIndexByResult.clear();
    for (const [requestIndex, target] of normalizedTargets.entries()) {
      for (const result of resultsByTarget.get(target) ?? []) {
        results.push(result);
        requestIndexByResult.set(result, requestIndex);
      }
    }
    const migration = prepareLedgerMigration(
      env,
      'uninstall',
      'explicit-targets',
      ledgerPath,
      ledgerState,
    );
    const compatibilityPlanning = createUninstallPlanning(planningRequested, results, projectRoot, {
      registry,
      toolOrder: registry.ids,
    });
    const preparedIntents: PreparedUninstallIntent[] = [];
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
        throw new Error('acquisition uninstall live resource path is ambiguous');
      }
      liveResourcesByPath.set(resource.placementPath, existing ?? resource);
    };
    for (const seed of candidateBindings.values()) {
      if (seed.preview.placementPath === null) {
        throw new Error('prepared uninstall intent requires a live path');
      }
      const expectedFacts = await observeUninstallFacts(seed);
      const livePath = resolve(seed.preview.placementPath);
      const rootsCtx = {
        cwd: seed.match.scopeKey ?? opts.cwd,
        configuration: opts.configuration,
      };
      const placementRoot = seed.match.placement?.root ?? dirname(livePath);
      const capabilityScope = skillRootFactsFor(
        registry,
        seed.match.tool,
        env,
        seed.match.scope,
        rootsCtx,
      ).some((fact) => fact.path === placementRoot)
        ? seed.match.scope
        : 'custom';
      const liveResourceId = acquireStateResourceId('live', [livePath]);
      addLiveResource({
        resourceId: liveResourceId,
        skill: seed.name,
        tool: seed.match.tool,
        scope: seed.match.scope,
        projectIdentity: seed.match.scope === 'project' ? seed.match.scopeKey : null,
        placementPath: livePath,
        storeRoot,
      });
      for (const selection of expectedFacts.selection) {
        for (const path of selection.paths) {
          const placementPath = resolve(path);
          addLiveResource({
            resourceId: acquireStateResourceId('live', [placementPath]),
            skill: seed.name,
            tool: selection.tool,
            scope: selection.scope,
            projectIdentity: selection.scope === 'project' ? selection.scopeKey : null,
            placementPath,
            storeRoot,
          });
        }
      }
      let storeResourceId: string | null = null;
      const pinned = expectedFacts.selectedPair?.pinned ?? null;
      if (pinned !== null) {
        const storePath = resolve(pinned.storePath);
        storeResourceId = acquireStateResourceId('store', [storePath]);
        const existingStore = storeResourcesByPath.get(storePath);
        if (existingStore !== undefined && existingStore.contentHash !== pinned.contentHash) {
          throw new Error('acquisition uninstall store resource content is ambiguous');
        }
        storeResourcesByPath.set(
          storePath,
          existingStore ?? {
            resource: { resourceId: storeResourceId, storePath },
            contentHash: pinned.contentHash as OperationDigest,
          },
        );
      }
      preparedIntents.push({
        seed,
        expectedFacts,
        capabilityScope,
        intent: {
          kind: 'remove',
          skill: seed.name,
          tool: seed.match.tool,
          scope: seed.match.scope,
          projectRoot:
            seed.match.scope === 'project' && seed.match.scopeKey !== null
              ? { kind: 'machine-bound', path: seed.match.scopeKey }
              : null,
          liveResourceId,
          storeResourceId,
          force: Boolean(opts.force),
        },
      });
    }
    const snapshotAuthority = await readAcquisitionSnapshotV1({
      env,
      registry,
      capabilityQueries: createUninstallCapabilityQueries(preparedIntents),
      projectContext,
      artifact: acquisitionSnapshotArtifactAuthorityV1(artifactResolution),
      ledgerPath,
      liveResources: [...liveResourcesByPath.values()],
      storeResources: [...storeResourcesByPath.values()],
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    const artifactPlanning = await prepareUninstallArtifactPlanning(
      snapshotAuthority,
      preparedIntents,
    );
    const boundPlanning = createAcquisitionPlan(
      {
        schemaVersion: 1,
        command: 'uninstall',
        selection: {
          source: 'explicit-targets',
          skills: [...new Set(preparedIntents.map(({ intent }) => intent.skill))],
          tools: [...new Set(preparedIntents.map(({ intent }) => intent.tool))],
          scopes: [...new Set(preparedIntents.map(({ intent }) => intent.scope))],
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
    if (!boundPlanning.ok) throw new Error(boundPlanning.error.message);
    const plan = boundPlanning.value.plan;
    const groupByResult = new Map<string, string>();
    for (const item of preparedIntents) {
      const groupId = createOperationGroupId({
        domain: 'skillsmith.operation-group-identity',
        schemaVersion: 1,
        command: 'uninstall',
        skill: item.intent.skill,
        source: null,
        scope: item.intent.scope,
        target: item.intent.skill,
      });
      groupByResult.set(uninstallResultFactKey(item.seed.preview), groupId);
    }
    const canonicalOperations = plan.operations.filter(
      (operation) =>
        migration === null || operation.operationId !== migration.operation.operationId,
    );
    const artifactOperations = canonicalOperations.filter(
      ({ kind }) =>
        kind === 'migrate-project-config' || kind === 'write-manifest' || kind === 'write-lock',
    );
    const liveOperations = canonicalOperations.filter(
      ({ kind }) =>
        kind !== 'migrate-project-config' && kind !== 'write-manifest' && kind !== 'write-lock',
    );
    const operationByLivePath = new Map<string, ExecutableOperation>();
    for (const operation of liveOperations) {
      if (
        (operation.before.kind !== 'absent' && operation.before.kind !== 'placement') ||
        operation.before.resource.kind !== 'live' ||
        operation.before.resource.location.kind !== 'machine-bound' ||
        operationByLivePath.has(operation.before.resource.location.path)
      ) {
        throw new Error('acquisition uninstall operation binding is ambiguous');
      }
      operationByLivePath.set(operation.before.resource.location.path, operation);
    }
    const preparedBindings = new Map<string, PreparedUninstallBinding>();
    const preconditions: ExecutionPrecondition[] = [
      ...acquisitionRevisionPreconditions(snapshotAuthority, plan.operations),
    ];
    const preparedByOperationId = new Map<string, PreparedUninstallIntent[]>();
    for (const prepared of preparedIntents) {
      const operation = operationByLivePath.get(
        resolve(prepared.seed.preview.placementPath as string),
      );
      if (operation === undefined) {
        if (
          prepared.expectedFacts.live.placement.class === 'absent' &&
          prepared.expectedFacts.selectedPair === null
        ) {
          continue;
        }
        throw new Error('prepared uninstall operation binding is missing');
      }
      const operationIntents = preparedByOperationId.get(operation.operationId);
      if (operationIntents === undefined) {
        preparedByOperationId.set(operation.operationId, [prepared]);
      } else {
        operationIntents.push(prepared);
      }
    }
    for (const [operationId, operationIntents] of preparedByOperationId) {
      const operation = liveOperations.find((candidate) => candidate.operationId === operationId);
      const prepared = operationIntents[0];
      if (operation === undefined || prepared === undefined) {
        throw new Error('prepared uninstall operation binding is missing');
      }
      const resource =
        operation.before.kind === 'absent' || operation.before.kind === 'placement'
          ? operation.before.resource
          : null;
      if (resource === null || resource.kind !== 'live') {
        throw new Error('prepared uninstall resource is not live');
      }
      const actualBefore = acquireActualBefore(
        resource,
        prepared.expectedFacts.live,
        prepared.expectedFacts.selectedPair,
      );
      preparedBindings.set(operation.operationId, {
        kind: 'pair',
        preview: prepared.seed.preview,
        reportPreviews: Object.freeze(operationIntents.map(({ seed }) => seed.preview)),
        actualBefore,
        liveResourceId: prepared.intent.liveResourceId,
        observe: () => observeUninstallFacts(prepared.seed),
        execute: (logicalOperation, operationObservation) =>
          prepared.seed.execute(logicalOperation, operationObservation),
      });
    }
    for (const operation of artifactOperations) {
      const action = artifactPlanning.actions.get(
        artifactBindingKey(operation.groupId, operation.kind),
      );
      if (action === undefined) {
        throw new Error('prepared uninstall artifact action is missing');
      }
      preparedBindings.set(operation.operationId, { kind: 'artifact', action });
    }
    if (migration !== null) {
      preconditions.unshift(migration.precondition);
      preparedBindings.set(migration.operation.operationId, {
        kind: 'migrate-ledger',
        expectedState: migration.expectedState,
        onMigrated: (model) => {
          ledgerCtx.ledger = model;
        },
      });
    }
    const bindings = new Map<string, PreparedUninstallBinding>();
    for (const operation of plan.operations) {
      const binding = preparedBindings.get(operation.operationId);
      if (binding === undefined || bindings.has(operation.operationId)) {
        throw new Error('prepared uninstall operation binding is not one-to-one');
      }
      bindings.set(operation.operationId, binding);
    }
    if (
      bindings.size !== plan.operations.length ||
      plan.operations.some((operation) => !bindings.has(operation.operationId))
    ) {
      throw new Error('prepared uninstall plan has no exact execution binding');
    }
    const preview = assembleUninstallReport(true, requested, results, plan, [], {
      artifact: artifactResolution,
      groupByResult,
      requestIndices: results.map((result) => requestIndexByResult.get(result) ?? 0),
    });
    emitAcquisitionPlanCreated(observation, plan, planObservation);
    deps.observePreparedPlan?.(plan);
    return {
      preview,
      legacyPreviewResults: Object.freeze(results),
      requestIndices: Object.freeze(results.map((result) => requestIndexByResult.get(result) ?? 0)),
      bindings,
      preconditions: Object.freeze(preconditions),
      snapshotAuthority,
      expectedRevisions: boundPlanning.value.expectedRevisions,
      snapshotId: boundPlanning.value.snapshotId,
      artifactResolution,
      groupByResult,
    };
  };

  const executePrepared = async (
    prepared: PreparedUninstallBatch,
  ): Promise<PlannedUninstallReport> => {
    const actualByPreview = new Map<UninstallResult, ProjectedUninstallResult>();
    const actualByOperation = new Map<string, ProjectedUninstallResult>();
    const projectActual = (
      binding: PreparedUninstallPairBinding,
      actual: ProjectedUninstallResult,
    ): void => {
      for (const preview of binding.reportPreviews) {
        actualByPreview.set(preview, { ...actual });
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
        if (binding === undefined)
          throw new Error('prepared uninstall operation binding is missing');
        if (binding.kind === 'artifact') {
          if (artifactController === null) {
            throw new Error('prepared uninstall artifact controller is missing');
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
          throw new Error('prepared uninstall operation pair is missing');
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
                throw new Error('prepared uninstall actual-before resource is not live');
              }
              compatibilityBefore = acquireActualBefore(resource, facts.live, facts.selectedPair);
              return canonicalPlanningString(compatibilityBefore) ===
                canonicalPlanningString(binding.actualBefore)
                ? operation.before
                : compatibilityBefore;
            },
            execute: async (
              _validatedBinding: ValidatedExecutionBinding,
              operationObservation?: ObservationBundle,
            ): Promise<OperationExecutionResult> => {
              const actual = await binding.execute(
                compatibilityBefore.kind === 'absent' && operation.before.kind === 'placement'
                  ? operation
                  : { ...operation, before: compatibilityBefore },
                operationObservation,
              );
              projectActual(binding, actual);
              actualByOperation.set(operation.operationId, actual);
              return createUninstallExecutionResult(operation, actual, requested);
            },
          },
          [prepared.snapshotAuthority.ledgerResourceId, binding.liveResourceId],
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
        if (binding === undefined)
          throw new Error('prepared uninstall operation binding is missing');
        if (binding.kind !== 'pair') continue;
        const actual: UninstallResult = {
          ...binding.preview,
          action: 'refused',
          reason,
          error: flipRefusedError(reason),
        };
        projectActual(binding, actual);
        actualByOperation.set(operation.operationId, actual);
      }
      executionResults = prepared.preview.plan.operations.map((operation) => {
        const binding = prepared.bindings.get(operation.operationId);
        if (binding?.kind === 'pair') {
          return createUninstallExecutionResult(
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
        throw new Error('prepared uninstall result projection is missing');
      }
      if (binding.kind !== 'pair') continue;
      const actual =
        execution.outcome === 'skipped-after-failure'
          ? {
              ...binding.preview,
              action: 'skipped' as const,
              reason: 'fail-fast',
            }
          : execution.outcome === 'cancelled'
            ? {
                ...binding.preview,
                action: 'skipped' as const,
                reason: 'interrupted',
                error: cancelledError('interrupted'),
              }
            : {
                ...binding.preview,
                action: 'failed' as const,
                reason: 'a prerequisite operation failed before placement execution',
                error: genericError('a prerequisite operation failed before placement execution'),
              };
      projectActual(binding, actual);
      actualByOperation.set(operation.operationId, actual);
    }
    const results = prepared.legacyPreviewResults.map(
      (previewResult) => actualByPreview.get(previewResult) ?? previewResult,
    );
    return assembleUninstallReport(
      false,
      requested,
      results,
      prepared.preview.plan,
      executionResults,
      {
        artifact: prepared.artifactResolution,
        groupByResult: prepared.groupByResult,
        requestIndices: prepared.requestIndices,
      },
    );
  };

  if (opts.dryRun) {
    const ledgerRes = await readLedgerState(env, ledgerPath);
    if (!ledgerRes.ok) return err(safeError(ledgerRes.error));
    const prepared = await prepareAll(ledgerRes.value);
    return ok(prepared.preview);
  }

  const prepareLocked = async (): Promise<Result<PreparedUninstallBatch, SkillSmithError>> => {
    await sweepStaging(env, storeRoot);
    await sweepFetchOrphans(env, dataDir);
    const ledgerRes = await readLedgerState(env, ledgerPath);
    if (!ledgerRes.ok) return err(safeError(ledgerRes.error));
    if (ledgerRes.value.state === 'present' && ledgerRes.value.sourceVersion === 1) {
      return ok(await prepareAll(ledgerRes.value));
    }
    const ledger = ledgerModelForMutation(ledgerRes.value, nowOf(env, deps));

    const swept = await recoverCommittedAcquireJournalsWithObservation(
      executionInputOf(env, ledgerPath, ledger, deps, opts, null),
      observation,
    );
    if (!swept.ok) {
      const sweepError = safeError(swept.error);
      return err(
        sweepError.code === 'ledger-error' ? flipFailedError(msg(sweepError)) : sweepError,
      );
    }

    const current = await readLedgerState(env, ledgerPath);
    if (!current.ok) return err(safeError(current.error));
    return ok(await prepareAll(current.value));
  };
  const completed = Symbol('uninstall-prepare-lock-completed');
  let preparedResult: Result<PreparedUninstallBatch, SkillSmithError> | undefined;
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
  return ok(await executePrepared(settled.value));
};

const runUninstallWithRegistryInternal = async (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation?: ObservationBundle,
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runAcquisitionWithObservation(
    (state) => runUninstallInternal(env, opts, deps, registry, observation, state),
    safeError,
    observation,
  );

export const runUninstallWithRegistry = (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps,
  registry: LifecycleToolRegistry<string>,
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runUninstallWithRegistryInternal(env, opts, deps, registry);

export const runUninstallWithRegistryObserved = (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation: ObservationBundle,
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runUninstallWithRegistryInternal(env, opts, deps, registry, observation);

export const runUninstall = (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps = { ...defaultUninstallDeps },
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runUninstallWithRegistry(env, opts, deps, toolRegistry);
