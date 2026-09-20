import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ToolCapabilityScope } from '../agents/adapter-types.ts';
import { type Placement, classifyPlacement } from '../agents/placement-shared.ts';
import { type LifecycleToolRegistry, toolRegistry } from '../agents/registry.ts';
import {
  type ArtifactDigest,
  HASH_SCHEMA_VERSION,
  hashManifestSemantics,
} from '../artifacts/hash.ts';
import { normalizeSourceIdentity } from '../artifacts/identity.ts';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import {
  type PortableLockSkillV1,
  type PortableLockV1,
  correlatePortableLock,
  serializePortableLock,
} from '../artifacts/lock.ts';
import { type ManifestEditRequest, editManifestBytes } from '../artifacts/manifest-edit.ts';
import { createNodeArtifactCoordinatorPorts } from '../artifacts/node-coordinator.ts';
import type { PlanSourceV1 } from '../artifacts/plan-types.ts';
import { artifactContractRegistry } from '../artifacts/registry.ts';
import type { NormalizedManifestDeclaration, NormalizedManifestV1 } from '../artifacts/types.ts';
import {
  type SkillSmithError,
  cancelledError,
  configError,
  flipFailedError,
  flipRefusedError,
  genericError,
} from '../errors.ts';
import type {
  ExecutionPrecondition,
  PreparedExecutionBinding,
  ValidatedExecutionBinding,
} from '../execution/types.ts';
import { prepareLedgerMigration } from '../place/ledger-migration.ts';
import {
  getLedgerPairAt,
  getPairAt as getLegacyPairAt,
  ledgerModelForMutation,
  legacyLedgerView,
  readLedgerState,
  withLedgerLock,
  withLedgerPairAt,
} from '../place/ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import { contentHashOf, sweepStaging } from '../place/store.ts';
import type { FlipTool, LedgerFile, PairRecord, PinnedRecord, SwapPlan } from '../place/types.ts';
import {
  createBoundedForceEffect,
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationPairId,
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
import type { ExpectedRevisionV1, LivePlacementStateV1 } from '../state/types.ts';
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
  createAcquisitionRepositoryLifecycleControllerV1,
  destinationSkillRootFor,
  emitAcquisitionPlanCreated,
  executeAcquirePlanWithObservation,
  executeAcquisitionOperationPlan,
  executeRecordOnlyAcquirePlanWithObservation,
  placementBundleFor,
  readAcquisitionSnapshotV1,
  recoverAcquireWithObservation,
  recoverCommittedAcquireJournalsWithObservation,
  resolveAcquisitionArtifactDestinationV1,
  resolveAcquisitionProjectContextV1,
  runAcquisitionWithObservation,
  skillRootFactsFor,
} from './execute.ts';
import { sweepFetchOrphans } from './fetch.ts';
import {
  type AcquisitionArtifactTransitionEnvelopeV1,
  type AcquisitionUninstallIntentV1,
  createAcquisitionPlan,
  createUninstallCapabilityQueries,
  createUninstallPlanning,
} from './plan.ts';
import { recoveryRefusedMessage } from './recovery.ts';
import { safeError } from './resolve.ts';
export { defaultInstallSourceTransport } from './resolve.ts';
import type {
  AcquisitionPorts,
  CurrentUninstallReport,
  CurrentUninstallResult,
  InstallDeps,
  InstallOptions,
  InstallScope,
  PlannedUninstallReport,
  UninstallAction,
  UninstallDeps,
  UninstallOptions,
  UninstallReport,
  UninstallResult,
} from './types.ts';
type AcquisitionObservation = NonNullable<Parameters<typeof executeAcquirePlanWithObservation>[2]>;
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
const msg = (e: SkillSmithError): string =>
  redactSensitiveString('message' in e ? e.message : e.code);
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
      // A scope the tool does not manage (muse in project scope) holds no
      // live placements: resolving would throw the registry's no-destination
      // invariant. Ledger-recorded pairs below still resolve to stale matches.
      const resolution =
        roots.length === 0 ? null : await bundle.resolveScoped(env, ctx, storeRoot, name, scope);
      if (resolution !== null) {
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
    const userFacts = bundle.rootFacts(env, 'user', ctxUser);
    if (userFacts.length === 0) continue;
    const resolution = await bundle.resolveScoped(env, ctxUser, storeRoot, name, 'user');
    for (const { path: root } of userFacts) {
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
      const projectFacts = bundle.rootFacts(env, 'project', ctxProj);
      if (projectFacts.length === 0) continue;
      const resolution = await bundle.resolveScoped(env, ctxProj, storeRoot, name, 'project');
      for (const { path: root } of projectFacts) {
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
  operationObservation?: AcquisitionObservation,
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
  allowImplicitMultipleTools: boolean,
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
  const distinctTools = new Set(matches.map((match) => match.tool));
  if (distinctTools.size > 1 && !explicitTools && !allowImplicitMultipleTools) {
    const list = matches
      .map((match) => `${match.tool} (${match.scope} at ${matchPathOf(match) ?? '<unknown>'})`)
      .join(', ');
    const reason = `'${target.input}' is installed for multiple tools: ${list}; disambiguate with --tool`;
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
  readonly artifactFallback?: 'not-written' | 'none';
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
    context.artifactFallback !== 'none'
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
  };
};

const createUninstallExecutionResult = (
  operation: ExecutableOperation,
  result: ProjectedUninstallResult | undefined,
  requested: UninstallReport['requested'],
): OperationExecutionResult => {
  const succeeded = result?.action === 'removed';
  const common = {
    operationId: operation.operationId,
    actualBefore: operation.before,
    actualAfter: succeeded ? operation.after : operation.before,
    force: createInstallForceEffect(operation, requested.force, succeeded),
  } as const;
  if (result?.action === 'skipped') {
    throw new Error('scheduler-owned uninstall outcome entered a pair execution binding');
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
  observation?: AcquisitionObservation,
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
  const fixedNamedScopeProjectContext =
    (opts.scope === 'user' || opts.scope === 'project') &&
    !opts.allScopes &&
    opts.targets.every((target) => !isUninstallPathTarget(target));
  const projectContext = await resolveAcquisitionProjectContextV1({
    env: fixedNamedScopeProjectContext
      ? { ...env, git: { ...env.git, findRepositoryRoot: async () => null } }
      : env,
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
  interface PreparedUninstallPairBinding {
    readonly kind: 'pair';
    readonly preview: UninstallResult;
    readonly reportPreviews: readonly UninstallResult[];
    readonly actualBefore: OperationImage;
    readonly liveResourceId: string;
    observe(): Promise<UninstallPreconditionFacts>;
    execute(
      operation: ExecutableOperation,
      operationObservation?: AcquisitionObservation,
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
      operationObservation?: AcquisitionObservation,
    ): Promise<UninstallResult>;
  }
  interface PreparedUninstallIntent {
    readonly seed: UninstallBindingSeed;
    readonly expectedFacts: UninstallPreconditionFacts;
    readonly intent: AcquisitionUninstallIntentV1;
    readonly capabilityScope: ToolCapabilityScope;
  }
  interface PreparedArtifactOnlyRecovery {
    readonly target: NormalizedUninstallTarget;
    readonly skill: string;
    readonly scope: InstallScope;
    readonly declaration: NormalizedManifestDeclaration;
    readonly lockedSkill: PortableLockSkillV1;
    readonly mode: 'reduced' | 'removed';
    readonly selectedTools: readonly FlipTool[];
    readonly projectRoot: string | null;
    readonly groupIdentity: {
      readonly domain: 'skillsmith.operation-group-identity';
      readonly schemaVersion: 1;
      readonly command: 'uninstall';
      readonly skill: string;
      readonly source: null;
      readonly scope: InstallScope;
      readonly target: string;
    };
    readonly liveResourceIds: readonly string[];
    readonly selectedPairs: readonly Readonly<{
      tool: FlipTool;
      liveResourceId: string;
      placementPath: string;
    }>[];
    readonly retainedSiblings: readonly Readonly<{
      tool: FlipTool;
      liveResourceId: string;
      placementPath: string;
    }>[];
  }
  interface PreparedUninstallArtifactPlanning {
    readonly transition: AcquisitionArtifactTransitionEnvelopeV1 | undefined;
    readonly actions: ReadonlyMap<string, AcquisitionArtifactExecutionActionV1>;
  }
  const recoveryLiveResource = (
    recovery: PreparedArtifactOnlyRecovery,
    tool: FlipTool,
    placementPath: string,
  ) => ({
    kind: 'live' as const,
    skill: recovery.skill,
    tool,
    scope: recovery.scope,
    projectRoot:
      recovery.projectRoot === null
        ? null
        : ({ kind: 'machine-bound' as const, path: recovery.projectRoot } as const),
    location: { kind: 'machine-bound' as const, path: placementPath },
  });
  const journalTouchesRecoveryPair = (
    journal: LogicalJournalV1Dto,
    recovery: PreparedArtifactOnlyRecovery,
    tool: FlipTool,
  ): boolean => {
    if (
      journal.intent.skill !== recovery.skill ||
      journal.intent.tool !== tool ||
      journal.intent.scope !== recovery.scope
    ) {
      return false;
    }
    const projectRoot =
      recovery.projectRoot === null
        ? null
        : ({ kind: 'machine-bound' as const, path: recovery.projectRoot } as const);
    return [journal.intent.before, journal.intent.after].some(
      (image) =>
        (image.kind === 'placement' || image.kind === 'absent') &&
        image.resource.kind === 'live' &&
        canonicalPlanningString(image.resource.projectRoot) ===
          canonicalPlanningString(projectRoot),
    );
  };
  const recoverySourceMatches = (
    recovery: PreparedArtifactOnlyRecovery,
    source: PlanSourceV1 | null,
  ): boolean =>
    source?.kind === 'portable' &&
    canonicalPlanningString(source.identity) ===
      canonicalPlanningString(recovery.declaration.source) &&
    source.requestedRef === recovery.lockedSkill.requestedRef &&
    source.resolvedSha === recovery.lockedSkill.resolvedSha &&
    source.sourcePath === recovery.lockedSkill.sourcePath &&
    source.contentHash === recovery.lockedSkill.contentHash &&
    (recovery.declaration.ref === source.requestedRef ||
      recovery.declaration.ref === source.resolvedSha);
  const observedLiveFor = (
    snapshot: AcquisitionSnapshotAuthorityV1['snapshot'],
    resourceId: string,
  ): LivePlacementStateV1 | null | undefined => {
    const matches = snapshot.live.filter(
      ({ revision }) => revision.domain === 'live' && revision.resourceId === resourceId,
    );
    return matches.length === 1 ? matches[0]?.value : undefined;
  };
  const reducedRecoveryAuthorityError = (
    recovery: PreparedArtifactOnlyRecovery,
    ledger: LedgerModel,
    snapshot: AcquisitionSnapshotAuthorityV1['snapshot'],
  ): string | null => {
    if (recovery.retainedSiblings.length === 0) {
      return 'portable lock handoff has no retained sibling authority';
    }
    for (const sibling of recovery.retainedSiblings) {
      const pair = getPairAt(ledger, recovery.projectRoot, recovery.skill, sibling.tool);
      const live = observedLiveFor(snapshot, sibling.liveResourceId);
      const pinned = pair?.pinned ?? null;
      const origin = pair?.origin;
      const normalizedOrigin =
        origin === undefined
          ? null
          : normalizeSourceIdentity(origin.source, 'ledger origin source');
      if (
        pair === null ||
        pair.mode !== 'pinned' ||
        pinned === null ||
        origin === undefined ||
        normalizedOrigin === null ||
        !normalizedOrigin.ok ||
        live === null ||
        live === undefined ||
        live.placementClass === 'absent' ||
        live.contentRevision === null ||
        pair.placementPath !== sibling.placementPath ||
        live.path !== sibling.placementPath ||
        (pinned.placement ?? 'copy') !== recovery.declaration.placement ||
        canonicalPlanningString(normalizedOrigin.value) !==
          canonicalPlanningString(recovery.declaration.source) ||
        origin.host !== recovery.declaration.source.host ||
        origin.repo !== recovery.declaration.source.repository ||
        origin.skillPath !== (recovery.declaration.source.path ?? '.') ||
        origin.refRequested !== recovery.lockedSkill.requestedRef ||
        !/^[0-9a-f]{40}$/u.test(origin.refResolved) ||
        origin.refResolved !== pinned.gitSha ||
        origin.refResolved !== recovery.lockedSkill.resolvedSha ||
        pinned.contentHash !== recovery.lockedSkill.contentHash ||
        live.contentRevision !== pinned.contentHash ||
        live.skill !== recovery.skill ||
        live.tool !== sibling.tool ||
        live.scope !== recovery.scope ||
        live.projectIdentity !== recovery.projectRoot ||
        (recovery.declaration.placement === 'symlink'
          ? live.representation !== 'symlink'
          : live.representation !== 'directory')
      ) {
        return 'portable lock handoff retained sibling authority is inconsistent';
      }
    }
    return null;
  };
  const finalRecoveryAuthorityError = (
    recovery: PreparedArtifactOnlyRecovery,
    ledger: LedgerModel,
  ): string | null => {
    const expectedGroupId = createOperationGroupId(recovery.groupIdentity);
    for (const selected of recovery.selectedPairs) {
      const resource = recoveryLiveResource(recovery, selected.tool, selected.placementPath);
      const pairId = createOperationPairId({
        domain: 'skillsmith.operation-pair-identity',
        schemaVersion: 1,
        groupId: expectedGroupId,
        tool: selected.tool,
        resource,
      });
      if (
        Object.values(ledger.transactions).some((journal) =>
          journalTouchesRecoveryPair(journal as LogicalJournalV1Dto, recovery, selected.tool),
        )
      ) {
        return 'portable lock handoff has a nonterminal selected-pair authority';
      }
      const journal = [...ledger.history]
        .reverse()
        .find((candidate) =>
          journalTouchesRecoveryPair(candidate as LogicalJournalV1Dto, recovery, selected.tool),
        ) as LogicalJournalV1Dto | undefined;
      if (
        journal === undefined ||
        journal.phase !== 'committed' ||
        journal.disposition !== 'forward' ||
        journal.intent.kind !== 'remove' ||
        journal.intent.groupId !== expectedGroupId ||
        journal.intent.pairId !== pairId ||
        journal.completedAt === null ||
        journal.intent.before.kind !== 'placement' ||
        journal.intent.after.kind !== 'absent' ||
        canonicalPlanningString(journal.intent.before.resource) !==
          canonicalPlanningString(resource) ||
        canonicalPlanningString(journal.intent.after.resource) !==
          canonicalPlanningString(resource) ||
        journal.intent.before.contentHash !== recovery.lockedSkill.contentHash ||
        !recoverySourceMatches(recovery, journal.intent.before.source)
      ) {
        return 'portable lock handoff selected-pair history is not an exact terminal removal';
      }
      const actualBefore = journal.actual.before.filter(
        (actual) => actual.role === 'live' && actual.placementPath === selected.placementPath,
      );
      const actualAfter = journal.actual.after.filter(
        (actual) => actual.role === 'live' && actual.placementPath === selected.placementPath,
      );
      const before = actualBefore[0];
      const after = actualAfter[0];
      if (
        actualBefore.length !== 1 ||
        actualAfter.length !== 1 ||
        before?.role !== 'live' ||
        before.state !== 'present' ||
        before.contentHash !== recovery.lockedSkill.contentHash ||
        after?.role !== 'live' ||
        after.state !== 'absent'
      ) {
        return 'portable lock handoff selected-pair history disagrees with its actual images';
      }
    }
    return recovery.selectedPairs.length === 0
      ? 'portable lock handoff has no selected-pair history authority'
      : null;
  };
  const recoveryAuthorityError = (
    recovery: PreparedArtifactOnlyRecovery,
    ledger: LedgerModel | null,
    snapshot: AcquisitionSnapshotAuthorityV1['snapshot'],
  ): string | null => {
    if (ledger === null) return 'portable lock handoff has no ledger authority';
    for (const selected of recovery.selectedPairs) {
      if (
        getPairAt(ledger, recovery.projectRoot, recovery.skill, selected.tool) !== null ||
        observedLiveFor(snapshot, selected.liveResourceId) !== null
      ) {
        return 'portable lock handoff selected pair is not terminally absent';
      }
    }
    return recovery.mode === 'reduced'
      ? reducedRecoveryAuthorityError(recovery, ledger, snapshot)
      : finalRecoveryAuthorityError(recovery, ledger);
  };
  const artifactBindingKey = (groupId: string, kind: ExecutableOperation['kind']): string =>
    `${groupId}:${kind}`;
  const prepareUninstallArtifactPlanning = async (
    snapshotAuthority: AcquisitionSnapshotAuthorityV1,
    prepared: readonly PreparedUninstallIntent[],
    recoveries: readonly PreparedArtifactOnlyRecovery[],
  ): Promise<PreparedUninstallArtifactPlanning> => {
    const artifact = snapshotAuthority.snapshot.artifact;
    if (artifact.mode === 'none') {
      return Object.freeze({ transition: undefined, actions: new Map() });
    }
    if (
      artifact.manifest.revision.state === 'absent' ||
      artifact.manifest.value === null ||
      (prepared.length === 0 && recoveries.length === 0)
    ) {
      return Object.freeze({ transition: undefined, actions: new Map() });
    }
    if (artifact.manifest.revision.domain !== 'manifest') {
      throw new Error('selected uninstall manifest revision has the wrong domain');
    }
    const initialManifestResourceRevision = artifact.manifest.revision
      .byteRevision as OperationDigest;
    let manifestModel = artifact.manifest.value;
    const manifestPath = artifact.pair.file.path;
    const lockPath = artifact.pair.lockfile.path;
    let manifestBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(
      await env.readBytes(manifestPath),
    );
    const initialManifest = acquisitionManifestImageFromBytesV1(manifestPath, manifestBytes);
    const declarations = manifestModel.skills.filter(({ name }) =>
      prepared.some(({ intent }) => intent.skill === name),
    );
    if (declarations.length === 0 && recoveries.length === 0) {
      if (initialManifest.kind !== 'manifest' || initialManifest.shape !== 'legacy') {
        return Object.freeze({ transition: undefined, actions: new Map() });
      }
      const grouped = new Map<
        string,
        {
          readonly groupIdentity: {
            readonly domain: 'skillsmith.operation-group-identity';
            readonly schemaVersion: 1;
            readonly command: 'uninstall';
            readonly skill: string;
            readonly source: null;
            readonly scope: InstallScope;
            readonly target: string;
          };
        }
      >();
      for (const { intent } of prepared) {
        const groupIdentity = {
          domain: 'skillsmith.operation-group-identity' as const,
          schemaVersion: 1 as const,
          command: 'uninstall' as const,
          skill: intent.skill,
          source: null,
          scope: intent.scope,
          target: intent.skill,
        };
        grouped.set(createOperationGroupId(groupIdentity), { groupIdentity });
      }
      const legacyGroups = [...grouped.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      const selectedGroup = legacyGroups[0];
      if (selectedGroup === undefined) {
        return Object.freeze({ transition: undefined, actions: new Map() });
      }
      const [groupId, { groupIdentity }] = selectedGroup;
      const migrationRequest = Object.freeze({
        edits: Object.freeze([{ kind: 'migrate-legacy' as const }]),
      });
      const migrated = editManifestBytes(manifestBytes, migrationRequest);
      if (!migrated.ok) throw migrated.error;
      manifestBytes = migrated.value.bytes;
      const migrationAfter = acquisitionManifestImageFromBytesV1(manifestPath, manifestBytes);
      if (migrationAfter.kind !== 'manifest') {
        throw new Error('legacy uninstall migration did not produce a manifest image');
      }
      const actions = new Map<string, AcquisitionArtifactExecutionActionV1>();
      actions.set(
        artifactBindingKey(groupId, 'migrate-project-config'),
        Object.freeze({
          role: 'manifest' as const,
          action: Object.freeze({ kind: 'edit' as const, request: migrationRequest }),
        }),
      );
      let initialLock: AcquisitionArtifactTransitionEnvelopeV1['initial']['lock'];
      if (artifact.lock.revision.state === 'absent') {
        initialLock = Object.freeze({
          kind: 'absent' as const,
          resource: Object.freeze({
            kind: 'lock' as const,
            location: Object.freeze({ kind: 'machine-bound' as const, path: lockPath }),
          }),
        });
      } else {
        initialLock = acquisitionLockImageFromBytesV1(
          lockPath,
          new Uint8Array(await env.readBytes(lockPath)),
        );
      }
      const targetLock: PortableLockV1 = Object.freeze({
        version: 1 as const,
        hashSchemaVersion: HASH_SCHEMA_VERSION,
        manifestHash: migrationAfter.semanticHash as ArtifactDigest,
        skills: Object.freeze([]),
      });
      const serializedLock = serializePortableLock(targetLock);
      if (!serializedLock.ok) throw new Error('legacy uninstall lock could not be serialized');
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
          initial: Object.freeze({
            manifest: initialManifest,
            manifestResourceRevision: initialManifestResourceRevision,
            lock: initialLock,
          }),
          groups: Object.freeze([
            Object.freeze({
              groupIdentity,
              migrationAfter,
              manifestAfter: migrationAfter,
              lockAfter,
            }),
          ]),
          unchangedGroups: Object.freeze(
            legacyGroups.slice(1).map(([, { groupIdentity: unchanged }]) => unchanged),
          ),
        }),
        actions,
      });
    }
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
    const grouped = declarations
      .flatMap((declaration) => {
        const declaredPrepared = prepared.filter(
          ({ intent }) =>
            intent.skill === declaration.name &&
            intent.scope === declaration.scope &&
            declaration.tools.includes(intent.tool),
        );
        const seed = declaredPrepared[0];
        if (seed === undefined) return [];
        const groupIdentity = {
          domain: 'skillsmith.operation-group-identity' as const,
          schemaVersion: 1 as const,
          command: 'uninstall' as const,
          skill: seed.intent.skill,
          source: null,
          scope: seed.intent.scope,
          target: seed.intent.skill,
        };
        return [
          {
            declaration,
            declaredPrepared,
            groupIdentity,
            groupId: createOperationGroupId(groupIdentity),
          },
        ];
      })
      .sort((left, right) =>
        left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0,
      );
    if (grouped.length === 0 && recoveries.length === 0) {
      return Object.freeze({ transition: undefined, actions: new Map() });
    }
    const changedGroupIds = new Set(grouped.map(({ groupId }) => groupId));
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
          .filter((identity) => !changedGroupIds.has(createOperationGroupId(identity)))
          .map((identity) => [createOperationGroupId(identity), identity]),
      ).values(),
    ];
    const actions = new Map<string, AcquisitionArtifactExecutionActionV1>();
    const transitionGroups: AcquisitionArtifactTransitionEnvelopeV1['groups'][number][] = [];
    let migrationPending =
      initialManifest.kind === 'manifest' && initialManifest.shape === 'legacy';
    if (recoveries.length > 1 || (recoveries.length > 0 && migrationPending)) {
      throw new Error('selected uninstall artifact recovery is ambiguous');
    }
    for (const recovery of recoveries) {
      if (initialManifest.kind !== 'manifest' || initialManifest.shape !== 'canonical') {
        throw new Error('artifact-only uninstall recovery requires a canonical manifest');
      }
      const relationship = correlatePortableLock(manifestModel, lockModel);
      const expectedFactCount = recovery.mode === 'removed' ? 2 : 1;
      if (
        relationship.state !== 'stale' ||
        relationship.facts.length !== expectedFactCount ||
        (recovery.mode === 'removed' &&
          !relationship.facts.some(
            (fact) => fact.reason === 'extra-entry' && fact.name === recovery.skill,
          )) ||
        !relationship.facts.some((fact) => fact.reason === 'manifest-hash-mismatch')
      ) {
        throw new Error('artifact-only uninstall recovery has unrelated lock drift');
      }
      const currentIndex = manifestModel.skills.findIndex(({ name }) => name === recovery.skill);
      const reconstructedSkills = [...manifestModel.skills];
      if (recovery.mode === 'removed') {
        reconstructedSkills.push(recovery.declaration);
      } else if (currentIndex >= 0) {
        reconstructedSkills[currentIndex] = recovery.declaration;
      } else {
        throw new Error('reduced artifact-only recovery lost its current declaration');
      }
      const reconstructedManifest: NormalizedManifestV1 = Object.freeze({
        ...manifestModel,
        skills: Object.freeze(reconstructedSkills),
      });
      if (
        hashManifestSemantics(reconstructedManifest) !== lockModel.manifestHash ||
        correlatePortableLock(reconstructedManifest, lockModel).state !== 'current'
      ) {
        throw new Error('artifact-only uninstall recovery could not prove its prior declaration');
      }
      const targetLock: PortableLockV1 = Object.freeze({
        ...lockModel,
        manifestHash: initialManifest.semanticHash as ArtifactDigest,
        skills: Object.freeze(
          recovery.mode === 'removed'
            ? lockModel.skills.filter(({ name }) => name !== recovery.skill)
            : [...lockModel.skills],
        ),
      });
      const serializedLock = serializePortableLock(targetLock);
      if (!serializedLock.ok) throw new Error('uninstall recovery lock could not be serialized');
      const lockAfter = acquisitionLockImageFromBytesV1(
        lockPath,
        new TextEncoder().encode(serializedLock.value),
      );
      const groupId = createOperationGroupId(recovery.groupIdentity);
      actions.set(
        artifactBindingKey(groupId, 'write-lock'),
        Object.freeze({
          role: 'lock' as const,
          action: Object.freeze({ kind: 'replace' as const, lock: targetLock }),
        }),
      );
      transitionGroups.push(
        Object.freeze({
          groupIdentity: recovery.groupIdentity,
          manifestAfter: initialManifest,
          lockAfter,
        }),
      );
      lockModel = targetLock;
    }
    for (const group of grouped) {
      let migrationAfter:
        | AcquisitionArtifactTransitionEnvelopeV1['groups'][number]['migrationAfter']
        | undefined;
      if (migrationPending) {
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
        migrationPending = false;
      }
      const selectedTools = new Set(group.declaredPrepared.map(({ intent }) => intent.tool));
      const remainingTools = group.declaration.tools.filter((tool) => !selectedTools.has(tool));
      const declarationIndex = manifestModel.skills.findIndex(
        ({ name }) => name === group.declaration.name,
      );
      if (declarationIndex < 0) {
        throw new Error('selected uninstall declaration prefix is missing');
      }
      const nextSkills = [...manifestModel.skills];
      if (remainingTools.length === 0) {
        nextSkills.splice(declarationIndex, 1);
      } else {
        nextSkills[declarationIndex] = Object.freeze({
          ...group.declaration,
          tools: Object.freeze(remainingTools),
        });
      }
      const nextManifest: NormalizedManifestV1 = Object.freeze({
        ...manifestModel,
        skills: Object.freeze(nextSkills),
      });
      const manifestRequest: ManifestEditRequest = Object.freeze({
        edits: Object.freeze([
          remainingTools.length === 0
            ? ({ kind: 'remove-skill', name: group.declaration.name } as const)
            : ({
                kind: 'set-skill-field',
                name: group.declaration.name,
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
        artifactBindingKey(group.groupId, 'write-manifest'),
        Object.freeze({
          role: 'manifest' as const,
          action: Object.freeze({ kind: 'edit' as const, request: manifestRequest }),
        }),
      );
      const targetLock: PortableLockV1 = Object.freeze({
        ...lockModel,
        version: 1 as const,
        hashSchemaVersion: HASH_SCHEMA_VERSION,
        manifestHash: hashManifestSemantics(nextManifest),
        skills: Object.freeze(
          remainingTools.length === 0
            ? lockModel.skills.filter(({ name }) => name !== group.declaration.name)
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
        artifactBindingKey(group.groupId, 'write-lock'),
        Object.freeze({
          role: 'lock' as const,
          action: Object.freeze({ kind: 'replace' as const, lock: targetLock }),
        }),
      );
      transitionGroups.push(
        Object.freeze({
          groupIdentity: group.groupIdentity,
          ...(migrationAfter === undefined ? {} : { migrationAfter }),
          manifestAfter: manifestAfter as Extract<OperationImage, { readonly kind: 'manifest' }>,
          lockAfter,
        }),
      );
      manifestModel = nextManifest;
      lockModel = targetLock;
    }
    return Object.freeze({
      transition: Object.freeze({
        initial: Object.freeze({
          manifest: initialManifest,
          manifestResourceRevision: initialManifestResourceRevision,
          lock: initialLock,
        }),
        groups: Object.freeze(transitionGroups),
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
    let selectedLock: PortableLockV1 | null = null;
    if (
      artifactResolution.outcome === 'selected' &&
      (await env.pathKind(artifactResolution.pair.file.path)) !== 'absent'
    ) {
      const manifestCodec = artifactContractRegistry.get('manifest', 1);
      if (manifestCodec === undefined) throw new Error('manifest artifact codec 1 is unavailable');
      const decoded = manifestCodec.decode(
        new Uint8Array(await env.readBytes(artifactResolution.pair.file.path)),
      );
      if (!decoded.ok) throw decoded.error;
      selectedManifest = decoded.value.model as NormalizedManifestV1;
      if ((await env.pathKind(artifactResolution.pair.lockfile.path)) !== 'absent') {
        const lockCodec = artifactContractRegistry.get('lock', 1);
        if (lockCodec === undefined) throw new Error('lock artifact codec 1 is unavailable');
        const decodedLock = lockCodec.decode(
          new Uint8Array(await env.readBytes(artifactResolution.pair.lockfile.path)),
        );
        if (!decodedLock.ok) throw decodedLock.error;
        selectedLock = decodedLock.value.model as PortableLockV1;
      }
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
        selectedManifest?.skills.some(({ name }) => name === target.name) === true,
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
    const recoveryCandidates: PreparedArtifactOnlyRecovery[] = [];
    if (selectedManifest !== null && selectedLock !== null) {
      const relationship = correlatePortableLock(selectedManifest, selectedLock);
      for (const target of normalizedTargets) {
        const currentDeclaration = selectedManifest.skills.find(({ name }) => name === target.name);
        const locked = selectedLock.skills.filter(({ name }) => name === target.name);
        if (locked.length === 0) continue;
        const removedHandoffShape =
          currentDeclaration === undefined &&
          locked.length === 1 &&
          relationship.state === 'stale' &&
          relationship.facts.length === 2 &&
          relationship.facts.some(
            (fact) => fact.reason === 'extra-entry' && fact.name === target.name,
          ) &&
          relationship.facts.some((fact) => fact.reason === 'manifest-hash-mismatch');
        const boundedTools = [...new Set(toolsToSearch)].sort();
        const reducedSelectedTools =
          currentDeclaration !== undefined && explicitTools
            ? boundedTools.filter((tool) => !currentDeclaration.tools.includes(tool))
            : [];
        const reducedHandoffShape =
          currentDeclaration !== undefined &&
          reducedSelectedTools.length === boundedTools.length &&
          reducedSelectedTools.length > 0 &&
          locked.length === 1 &&
          relationship.state === 'stale' &&
          relationship.facts.length === 1 &&
          relationship.facts[0]?.reason === 'manifest-hash-mismatch';
        if (!removedHandoffShape && !reducedHandoffShape) {
          if (
            currentDeclaration !== undefined &&
            (reducedSelectedTools.length === 0 || relationship.state === 'current')
          ) {
            continue;
          }
        }
        const lockedSkill = locked[0];
        const source =
          lockedSkill === undefined
            ? null
            : normalizeSourceIdentity(lockedSkill.source, 'skills[].source');
        const toolSets: readonly (readonly FlipTool[])[] = explicitTools
          ? [boundedTools]
          : boundedTools.length > 8
            ? []
            : Array.from({ length: 2 ** boundedTools.length - 1 }, (_unused, index) =>
                boundedTools.filter((_tool, toolIndex) => ((index + 1) & (1 << toolIndex)) !== 0),
              );
        const refs =
          lockedSkill === undefined
            ? []
            : [...new Set([lockedSkill.requestedRef, lockedSkill.resolvedSha])];
        const matches = new Map<
          string,
          Readonly<{
            declaration: NormalizedManifestDeclaration;
            mode: 'reduced' | 'removed';
            selectedTools: readonly FlipTool[];
          }>
        >();
        if (
          removedHandoffShape &&
          lockedSkill !== undefined &&
          source !== null &&
          source.ok &&
          lockedSkill.sourcePath === (source.value.path ?? '.')
        ) {
          for (const scope of scopesToSearch) {
            for (const tools of toolSets) {
              for (const placement of ['symlink', 'copy'] as const) {
                for (const ref of refs) {
                  const declaration: NormalizedManifestDeclaration = Object.freeze({
                    name: target.name,
                    source: source.value,
                    ref,
                    tools: Object.freeze([...tools]),
                    scope,
                    placement,
                    path: null,
                  });
                  const reconstructed: NormalizedManifestV1 = Object.freeze({
                    ...selectedManifest,
                    skills: Object.freeze([...selectedManifest.skills, declaration]),
                  });
                  if (
                    hashManifestSemantics(reconstructed) === selectedLock.manifestHash &&
                    correlatePortableLock(reconstructed, selectedLock).state === 'current'
                  ) {
                    matches.set(canonicalPlanningString(declaration), {
                      declaration,
                      mode: 'removed',
                      selectedTools: Object.freeze([...(tools as readonly FlipTool[])]),
                    });
                  }
                }
              }
            }
          }
        }
        if (reducedHandoffShape && currentDeclaration !== undefined) {
          const declaration: NormalizedManifestDeclaration = Object.freeze({
            ...currentDeclaration,
            tools: Object.freeze([...currentDeclaration.tools, ...reducedSelectedTools]),
          });
          const declarationIndex = selectedManifest.skills.indexOf(currentDeclaration);
          const reconstructedSkills = [...selectedManifest.skills];
          reconstructedSkills[declarationIndex] = declaration;
          const reconstructed: NormalizedManifestV1 = Object.freeze({
            ...selectedManifest,
            skills: Object.freeze(reconstructedSkills),
          });
          if (
            hashManifestSemantics(reconstructed) === selectedLock.manifestHash &&
            correlatePortableLock(reconstructed, selectedLock).state === 'current'
          ) {
            matches.set(canonicalPlanningString(declaration), {
              declaration,
              mode: 'reduced',
              selectedTools: Object.freeze(reducedSelectedTools),
            });
          }
        }
        const match = matches.size === 1 ? [...matches.values()][0] : undefined;
        if (match === undefined) {
          const reason = 'portable lock handoff could not be reconstructed uniquely';
          resultsByTarget.set(target, [
            {
              ...emptyUninstallResult(target.name, null, null, 'refused'),
              reason,
              error: flipRefusedError(reason),
            },
          ]);
          continue;
        }
        if (lockedSkill === undefined) continue;
        const { declaration, mode, selectedTools } = match;
        const scopeKey = await scopeKeyFor(declaration.scope);
        const rootsContext = {
          cwd: scopeKey ?? opts.cwd,
          configuration: opts.configuration,
        };
        const liveResourceIds: string[] = [];
        const selectedPairs: Array<{
          tool: FlipTool;
          liveResourceId: string;
          placementPath: string;
        }> = [];
        let terminallyAbsent = true;
        for (const tool of selectedTools) {
          const root = destinationSkillRootFor(
            registry,
            tool,
            env,
            declaration.scope,
            rootsContext,
          );
          const placementPath = resolve(root, target.name);
          const liveResourceId = acquireStateResourceId('live', [placementPath]);
          liveResourceIds.push(liveResourceId);
          selectedPairs.push({ tool, liveResourceId, placementPath });
          terminallyAbsent &&= getPairAt(legacyLedger, scopeKey, target.name, tool) === null;
          addLiveResource({
            resourceId: liveResourceId,
            skill: target.name,
            tool,
            scope: declaration.scope,
            projectIdentity: declaration.scope === 'project' ? scopeKey : null,
            placementPath,
            storeRoot,
          });
        }
        const retainedSiblings: Array<{
          tool: FlipTool;
          liveResourceId: string;
          placementPath: string;
        }> = [];
        if (mode === 'reduced' && currentDeclaration !== undefined) {
          for (const tool of currentDeclaration.tools) {
            if (!registry.toolsFor('install').includes(tool)) continue;
            const retainedTool = tool as FlipTool;
            const root = destinationSkillRootFor(
              registry,
              retainedTool,
              env,
              declaration.scope,
              rootsContext,
            );
            const placementPath = resolve(root, target.name);
            const liveResourceId = acquireStateResourceId('live', [placementPath]);
            retainedSiblings.push({ tool: retainedTool, liveResourceId, placementPath });
            addLiveResource({
              resourceId: liveResourceId,
              skill: target.name,
              tool: retainedTool,
              scope: declaration.scope,
              projectIdentity: declaration.scope === 'project' ? scopeKey : null,
              placementPath,
              storeRoot,
            });
          }
        }
        if (!terminallyAbsent) {
          const reason = 'portable lock handoff still has managed placement state';
          resultsByTarget.set(target, [
            {
              ...emptyUninstallResult(target.name, null, null, 'refused'),
              reason,
              error: flipRefusedError(reason),
            },
          ]);
          continue;
        }
        const groupIdentity = {
          domain: 'skillsmith.operation-group-identity' as const,
          schemaVersion: 1 as const,
          command: 'uninstall' as const,
          skill: target.name,
          source: null,
          scope: declaration.scope,
          target: target.name,
        };
        const groupId = createOperationGroupId(groupIdentity);
        if (
          !recoveryCandidates.some(
            (candidate) => createOperationGroupId(candidate.groupIdentity) === groupId,
          )
        ) {
          recoveryCandidates.push({
            target,
            skill: target.name,
            scope: declaration.scope,
            declaration,
            lockedSkill,
            mode,
            selectedTools,
            projectRoot: scopeKey,
            groupIdentity,
            liveResourceIds: Object.freeze(liveResourceIds),
            selectedPairs: Object.freeze(selectedPairs),
            retainedSiblings: Object.freeze(retainedSiblings),
          });
        }
      }
    }
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
      ...(fixedNamedScopeProjectContext ? { fixedProjectContext: true } : {}),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    const artifactRecoveries: PreparedArtifactOnlyRecovery[] = [];
    for (const recovery of recoveryCandidates) {
      const authorityError = recoveryAuthorityError(
        recovery,
        snapshotAuthority.snapshot.ledger.value,
        snapshotAuthority.snapshot,
      );
      if (authorityError === null) {
        artifactRecoveries.push(recovery);
        continue;
      }
      resultsByTarget.set(recovery.target, [
        {
          ...emptyUninstallResult(recovery.skill, null, null, 'refused'),
          reason: authorityError,
          error: flipRefusedError(authorityError),
        },
      ]);
    }
    results.length = 0;
    requestIndexByResult.clear();
    for (const [requestIndex, target] of normalizedTargets.entries()) {
      for (const result of resultsByTarget.get(target) ?? []) {
        results.push(result);
        requestIndexByResult.set(result, requestIndex);
      }
    }
    const compatibilityPlanning = createUninstallPlanning(planningRequested, results, projectRoot, {
      registry,
      toolOrder: registry.ids,
    });
    const artifactPlanning = await prepareUninstallArtifactPlanning(
      snapshotAuthority,
      preparedIntents,
      artifactRecoveries,
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
        ...(artifactRecoveries.length === 0
          ? {}
          : {
              artifactRecoveries: artifactRecoveries.map(({ skill, scope, mode }) => ({
                kind: 'artifact-only-lock-repair' as const,
                skill,
                scope,
                mode,
              })),
            }),
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
    for (const recovery of artifactRecoveries) {
      const recoveryGroupId = createOperationGroupId(recovery.groupIdentity);
      for (const recoveryResult of results.filter(
        ({ skill, tool }) => skill === recovery.skill && tool === null,
      )) {
        groupByResult.set(uninstallResultFactKey(recoveryResult), recoveryGroupId);
      }
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
        true,
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
              compatibilityBefore = acquireActualBefore(
                resource,
                facts.live,
                facts.selectedPair,
                true,
              );
              return canonicalPlanningString(compatibilityBefore) ===
                canonicalPlanningString(binding.actualBefore)
                ? operation.before
                : compatibilityBefore;
            },
            execute: async (
              _validatedBinding: ValidatedExecutionBinding,
              operationObservation?: AcquisitionObservation,
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
  observation?: AcquisitionObservation,
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
  observation: AcquisitionObservation,
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runUninstallWithRegistryInternal(env, opts, deps, registry, observation);

export const runUninstall = (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps = { ...defaultUninstallDeps },
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runUninstallWithRegistry(env, opts, deps, toolRegistry);
