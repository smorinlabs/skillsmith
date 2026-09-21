import { dirname, join, resolve } from 'node:path';
import {
  type AcquireLiveSnapshotResourceV1,
  type AcquireStoreSnapshotResourceV1,
  type AcquisitionArtifactExecutionActionV1,
  acquireStateResourceId,
  createAcquireExecutionInput,
  createAcquireExecutionLockPort,
  createAcquisitionArtifactExecutionControllerV1,
  createAcquisitionLedgerMigrationBinding,
  createAcquisitionOriginRecord,
  createAcquisitionPinnedRecord,
  createAcquisitionRepositoryLifecycleControllerV1,
  executeAcquireReplacementWithObservation,
  executeRecordOnlyAcquirePlanWithObservation,
  readAcquisitionSnapshotV1,
} from '../acquire/execute.ts';
import { resolveRemoteSource } from '../acquire/resolve.ts';
import type { AcquisitionPorts, SourceSpec } from '../acquire/types.ts';
import type { RelevantCapabilityQueryV1 } from '../agents/capabilities.ts';
import { classifyPlacement } from '../agents/placement-shared.ts';
import { FLIP_TOOLS, type PlacementToolId, toolRegistry } from '../agents/registry.ts';
import type { ArtifactCoordinatorPorts } from '../artifacts/coordinator-types.ts';
import { type ArtifactDigest, hashCanonicalInput } from '../artifacts/hash.ts';
import { normalizeSourceIdentity } from '../artifacts/identity.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import type {
  CapabilityPreconditionV1,
  ResourcePreconditionV1,
  SavedPlanV1,
  SelectionPreconditionV1,
} from '../artifacts/plan-types.ts';
import { readLedgerArtifact } from '../artifacts/repository.ts';
import { hashSourceContentV1, projectSourceContent } from '../artifacts/source-content.ts';
import { permissionDeniedError, safeErrorCode } from '../errors.ts';
import { validateExecutionPreconditions } from '../execution/index.ts';
import type { ValidatedExecutionBinding } from '../execution/types.ts';
import type { ObservationBundle } from '../observation/types.ts';
import {
  type PlacementExecutionInput,
  createPlacementExecutionInput,
  createPlacementSwapRequest,
  executePlacementPlanObserved,
} from '../place/execute.ts';
import {
  getLedgerPairAt,
  ledgerModelForMutation,
  legacyLedgerView,
  readLedgerState,
} from '../place/ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import { recoverPlacementWithObservation } from '../place/recovery.ts';
import {
  type SnapshotResult,
  clampStoreNs,
  contentHashOf,
  snapshotToStore,
} from '../place/store.ts';
import type { PairRecord, Provenance, SwapExecutionResult, SwapPlan } from '../place/types.ts';
import { createOperationExecutionResult, createOperationPlan } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationDigest,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
  OperationPlanInput,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  bindForwardUpdateArtifactHistoryV1,
  recoverPendingUpdateArtifactHistoryV1,
} from '../update/history.ts';
import type {
  SavedReconcileExecutionGuards,
  ValidateSavedReconcilePlanRuntime,
  ValidatedSavedReconcilePlanValue,
} from './apply.ts';
import { validateSavedReconcilePlanValue } from './apply.ts';
import {
  type ReconcileExecutionBindingErrorV1,
  type ReconcileExecutionGuardAuthorityV1,
  type ReconcileRuntimeExecutionAuthoritiesV1,
  createFreshReconcileExecutionPlanV1,
  createReconcileExecutionPreconditionsV1,
  createReconcileMoveScopeExecutionBindingV1,
  executeValidatedReconcilePlanV1,
} from './execute.ts';
import type { PlanReconcileError } from './types.ts';
import type { ReconcileExecutionCommandV1 } from './types.ts';

export interface ExecuteValidatedReconcilePlanRuntime extends ValidateSavedReconcilePlanRuntime {
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly observation: ObservationBundle;
  readonly continueOnError: boolean;
  /** Fresh update's exact artifact-prefixed plan; its guard authority remains the validated base. */
  readonly approvedUpdatePlan?: OperationPlan<'update'>;
  /** Exact attempt-scoped sources already inspected, hashed, and verified by fresh update. */
  readonly preparedSources?: readonly ReconcilePreparedSourceV1[];
  /** Lossless artifact actions for command-specific write-manifest/write-lock operations. */
  readonly artifactActions?: readonly ReconcileArtifactExecutionActionV1[];
  /** Verification-blocked placement operations retained in the immutable approved plan. */
  readonly blockedOperationIds?: ReadonlySet<string>;
  /** Groups whose every selected pair was blocked; their artifact prefix must not mutate. */
  readonly blockedGroupIds?: ReadonlySet<string>;
}

export interface ReconcilePreparedSourceV1 {
  readonly source: Extract<ExecutableOperation['source'], { readonly kind: 'portable' }>;
  readonly skillName: string;
  readonly materializedDir: string;
  readonly cleanupDirectory: string | null;
}

export interface ReconcileArtifactExecutionActionV1 {
  readonly operationId: string;
  readonly action: AcquisitionArtifactExecutionActionV1;
}

export interface ExecuteValidatedReconcilePlanError extends PlanReconcileError {
  /** Completed operation results retained when only attempt-scoped cleanup failed. */
  readonly results?: readonly OperationExecutionResult[];
}

const savedCancelled = (): PlanReconcileError => ({
  code: 'apply-saved-cancelled',
  message: 'saved plan validation was cancelled',
  exitClass: 'cancelled',
});

const isCancellation = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  const code = safeErrorCode(error);
  if (code === 'cancelled' || code === 'ABORT_ERR') return true;
  if (error === null || typeof error !== 'object') return false;
  const name = Object.getOwnPropertyDescriptor(error, 'name');
  return Boolean(name !== undefined && 'value' in name && name.value === 'AbortError');
};

const isPermission = (error: unknown): boolean => {
  const code = safeErrorCode(error);
  if (
    code === 'permission' ||
    code === 'permission-denied' ||
    code === 'EACCES' ||
    code === 'EPERM'
  ) {
    return true;
  }
  if (error === null || typeof error !== 'object') return false;
  const reason = Object.getOwnPropertyDescriptor(error, 'reason');
  return Boolean(
    reason !== undefined &&
      'value' in reason &&
      (reason.value === 'permission' || reason.value === 'permission-denied'),
  );
};

const physicalFailure = (
  error: unknown,
  code: string,
  message: string,
  fallback: PlanReconcileError['exitClass'],
  signal?: AbortSignal,
): PlanReconcileError =>
  isCancellation(error, signal)
    ? savedCancelled()
    : physicalError(code, message, isPermission(error) ? 'permission' : fallback);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const jsonValue = (value: unknown): JsonValue => structuredClone(value) as JsonValue;

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

type PhysicalPlacementKind = 'install' | 'update' | 'remove' | 'repair' | 'move-scope';

type PhysicalPlacementOperation = ExecutableOperation<PlacementToolId> &
  Readonly<{
    readonly kind: PhysicalPlacementKind;
    readonly tool: PlacementToolId;
  }>;

const physicalPlacementKinds: ReadonlySet<string> = new Set<PhysicalPlacementKind>([
  'install',
  'update',
  'remove',
  'repair',
  'move-scope',
]);
const placementToolIds: ReadonlySet<string> = new Set(FLIP_TOOLS);

const isPlacementToolId = (value: unknown): value is PlacementToolId =>
  typeof value === 'string' && placementToolIds.has(value);

const isPhysicalPlacementOperation = (
  operation: ExecutableOperation,
): operation is PhysicalPlacementOperation =>
  physicalPlacementKinds.has(operation.kind) && isPlacementToolId(operation.tool);

interface PreparedExecutionSource {
  readonly source: Extract<ExecutableOperation['source'], { readonly kind: 'portable' }>;
  readonly spec: SourceSpec;
  readonly materializedDir: string;
  readonly cleanupDirectory: string | null;
  readonly storePath: string;
  snapshot: SnapshotResult | null;
}

const physicalError = (
  code: string,
  message: string,
  exitClass: PlanReconcileError['exitClass'],
): PlanReconcileError => Object.freeze({ code, message, exitClass });

const executionSourceKey = (
  source: Extract<ExecutableOperation['source'], { readonly kind: 'portable' }>,
): string => canonicalPlanningString(source);

const executionSourceSpec = (operation: PhysicalPlacementOperation): SourceSpec | null => {
  const source = operation.source;
  if (source?.kind !== 'portable' || operation.skill === null) return null;
  const sourcePath = source.sourcePath === '.' ? '' : source.sourcePath;
  const canonicalSource = `${source.identity.host}/${source.identity.repository}${
    sourcePath.length === 0 ? '' : `//${sourcePath}`
  }`;
  return Object.freeze({
    identity: Object.freeze({ ...source.identity }),
    canonicalSource,
    canonicalInvocation: `${canonicalSource}${
      source.requestedRef === null ? '' : `@${source.requestedRef}`
    }`,
    originSource: canonicalSource,
    cloneUrl: `https://${source.identity.host}/${source.identity.repository}.git`,
    selector: Object.freeze({ kind: 'path' as const, path: sourcePath }),
    ref: source.requestedRef,
  });
};

const executionStorePath = (
  storeRoot: string,
  operation: PhysicalPlacementOperation,
): string | null => {
  const source = operation.source;
  if (source?.kind !== 'portable' || operation.skill === null) return null;
  const identity = clampStoreNs(source.identity.repository);
  return join(
    storeRoot,
    identity.ns,
    `${identity.name}@${source.resolvedSha.slice(0, 12)}`,
    operation.skill,
  );
};

const exactContentHash = async (
  ports: AcquisitionPorts,
  path: string,
): Promise<OperationDigest | null> => {
  const projected = await projectSourceContent(ports, path);
  if (!projected.ok) return null;
  const hashed = hashSourceContentV1(projected.value);
  return hashed.ok ? (hashed.value as OperationDigest) : null;
};

const prepareExecutionSources = async (
  plan: OperationPlan<ReconcileExecutionCommandV1>,
  runtime: ExecuteValidatedReconcilePlanRuntime,
  storeRoot: string,
  legacyLedger: ReturnType<typeof legacyLedgerView>,
): Promise<Result<Map<string, PreparedExecutionSource>, PlanReconcileError>> => {
  const prepared = new Map<string, PreparedExecutionSource>();
  const cleanupDirectories = new Set<string>();
  const supplied = new Map(
    (runtime.preparedSources ?? []).map((source) => [executionSourceKey(source.source), source]),
  );
  let cleanupOwnershipTransferred = false;
  try {
    for (const candidate of plan.operations) {
      if (
        candidate.kind !== 'install' &&
        candidate.kind !== 'update' &&
        candidate.kind !== 'repair'
      ) {
        continue;
      }
      if (!isPhysicalPlacementOperation(candidate)) {
        return err(
          physicalError(
            'apply-tool-capability',
            'the approved operation requires an unsupported placement capability',
            'capability',
          ),
        );
      }
      const operation = candidate;
      const source = operation.source;
      const spec = executionSourceSpec(operation);
      const storePath = executionStorePath(storeRoot, operation);
      if (source?.kind !== 'portable' || spec === null || storePath === null) {
        return err(
          physicalError(
            'apply-source-unsupported',
            'the approved operation does not carry one portable pinned source',
            'source',
          ),
        );
      }
      const key = executionSourceKey(source);
      if (prepared.has(key)) continue;
      if (runtime.signal?.aborted) return err(savedCancelled());

      const held = supplied.get(key);
      if (held !== undefined) {
        const contentHash = await exactContentHash(runtime.ports, held.materializedDir);
        if (held.skillName !== operation.skill || contentHash !== source.contentHash) {
          return err(
            physicalError(
              'apply-source-stale',
              'the prepared source changed after approval',
              'state',
            ),
          );
        }
        if (held.cleanupDirectory !== null) cleanupDirectories.add(held.cleanupDirectory);
        prepared.set(key, {
          source,
          spec,
          materializedDir: held.materializedDir,
          cleanupDirectory: held.cleanupDirectory,
          storePath,
          snapshot: null,
        });
        supplied.delete(key);
        continue;
      }

      if ((await runtime.ports.pathKind(storePath)) === 'dir') {
        const contentHash = await exactContentHash(runtime.ports, storePath);
        if (contentHash !== source.contentHash) {
          return err(
            physicalError(
              'apply-store-integrity',
              'the approved store entry has different content',
              'state',
            ),
          );
        }
        const legacyContentHash = await contentHashOf(runtime.ports, storePath);
        if (!legacyContentHash.ok) {
          return err(
            physicalFailure(
              legacyContentHash.error,
              'apply-store-integrity',
              'the approved store entry could not be hashed',
              'state',
              runtime.signal,
            ),
          );
        }
        prepared.set(key, {
          source,
          spec,
          materializedDir: storePath,
          cleanupDirectory: null,
          storePath,
          snapshot: {
            storePath,
            rev: source.resolvedSha.slice(0, 12),
            contentHash: legacyContentHash.value,
            reused: true,
          },
        });
        continue;
      }

      const fetchSpec = Object.freeze({
        ...spec,
        canonicalInvocation: `${spec.canonicalSource}@${source.resolvedSha}`,
        ref: source.resolvedSha,
      });
      const resolvedSource = await resolveRemoteSource({
        ports: runtime.ports,
        source: fetchSpec,
        ledger: legacyLedger,
        scopeKey: null,
        storeRoot,
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
        createFetchDirectory: () =>
          join(
            runtime.ports.homeDir,
            `.skillsmith-apply-fetch-${runtime.ports.nextId('apply-source-resolution')}`,
          ),
      });
      if (resolvedSource.cleanupDirectory !== null) {
        cleanupDirectories.add(resolvedSource.cleanupDirectory);
      }
      if (runtime.signal?.aborted) return err(savedCancelled());
      if (resolvedSource.kind !== 'resolved') {
        if (resolvedSource.kind === 'source-failure') {
          return err(
            physicalFailure(
              resolvedSource.error,
              'apply-source-resolution',
              'the approved source could not be materialized exactly',
              'source',
              runtime.signal,
            ),
          );
        }
        return err(
          physicalError(
            'apply-source-resolution',
            'the approved source could not be materialized exactly',
            'source',
          ),
        );
      }
      const materialization = resolvedSource.materialization;
      const contentHash = await exactContentHash(runtime.ports, materialization.materializedDir);
      const sourcePath = materialization.skillPath.length === 0 ? '.' : materialization.skillPath;
      if (
        materialization.sha !== source.resolvedSha ||
        materialization.skillName !== operation.skill ||
        sourcePath !== source.sourcePath ||
        contentHash !== source.contentHash
      ) {
        return err(
          physicalError(
            'apply-source-stale',
            'the approved source changed; regenerate and review a new plan',
            'state',
          ),
        );
      }
      prepared.set(key, {
        source,
        spec,
        materializedDir: materialization.materializedDir,
        cleanupDirectory: resolvedSource.cleanupDirectory,
        storePath,
        snapshot: null,
      });
    }
    if (supplied.size > 0) {
      return err(
        physicalError(
          'apply-source-stale',
          'prepared source coverage does not match the approved plan',
          'state',
        ),
      );
    }
    cleanupOwnershipTransferred = true;
    return ok(prepared);
  } finally {
    if (!cleanupOwnershipTransferred) {
      for (const directory of cleanupDirectories) {
        try {
          await runtime.ports.removeTree(directory);
        } catch {
          // The normal bounded orphan sweep owns an unremovable source directory.
        }
      }
    }
  }
};

const liveResource = (image: OperationImage) =>
  image.kind === 'placement'
    ? image.resource
    : image.kind === 'absent' && image.resource.kind === 'live'
      ? image.resource
      : null;

const livePath = (image: OperationImage): string | null => {
  const resource = liveResource(image);
  return resource?.location.kind === 'machine-bound' ? resolve(resource.location.path) : null;
};

const liveProjectKey = (image: OperationImage): string | null => {
  const resource = liveResource(image);
  if (resource === null || resource.scope === 'user') return null;
  return resource.projectRoot?.kind === 'machine-bound' ? resolve(resource.projectRoot.path) : null;
};

const exactPendingPlacementOperation = (
  ledger: LedgerModel,
  operation: PhysicalPlacementOperation,
): boolean => {
  const expectedIntent = {
    operationId: operation.operationId,
    groupId: operation.groupId,
    pairId: operation.pairId,
    kind: operation.kind,
    skill: operation.skill,
    source: operation.source,
    tool: operation.tool,
    scope: operation.scope,
    before: operation.before,
    after: operation.after,
    mutates: operation.mutates,
    reversibility:
      operation.kind === 'move-scope'
        ? operation.reversibility
        : { kind: 'none' as const, retentionResourceIds: [] },
    conflict: operation.kind === 'move-scope' ? operation.conflict : null,
  };
  return (
    Object.values(ledger.transactions).filter(
      (journal) =>
        journal.disposition === 'forward' &&
        canonicalPlanningString(journal.intent) === canonicalPlanningString(expectedIntent),
    ).length === 1
  );
};

const observePhysicalPlacement = async (
  operation: PhysicalPlacementOperation,
  runtime: ExecuteValidatedReconcilePlanRuntime,
  ledgerPath: string,
  storeRoot: string,
): Promise<OperationImage> => {
  const path = livePath(operation.before);
  if (path === null || operation.skill === null) {
    throw new TypeError('approved placement identity is incomplete');
  }
  const state = await readLedgerState(runtime.ports, ledgerPath);
  if (!state.ok) throw state.error;
  const ledger = ledgerModelForMutation(state.value, runtime.ports.wallNowIso());
  if (exactPendingPlacementOperation(ledger, operation)) return operation.before;
  const pair = getLedgerPairAt(
    ledger,
    liveProjectKey(operation.before),
    operation.skill,
    operation.tool,
  );
  const placement = await classifyPlacement(
    runtime.ports,
    dirname(path),
    operation.skill,
    storeRoot,
  );
  if (operation.before.kind === 'absent') {
    if (placement.class === 'absent' && pair === null) return operation.before;
    return Object.freeze({
      kind: 'absent' as const,
      resource: Object.freeze({
        ...operation.before.resource,
        location: Object.freeze({ kind: 'machine-bound' as const, path: `${path}.changed` }),
      }),
    });
  }
  if (operation.before.kind !== 'placement') return operation.before;
  let contentHash: OperationDigest | null = null;
  if (placement.class !== 'absent' && !placement.dangling) {
    const contentRoot =
      placement.class === 'dev' || placement.class === 'store-linked'
        ? await runtime.ports.realpath(path)
        : path;
    contentHash = await exactContentHash(runtime.ports, contentRoot);
  }
  const approvedSource =
    operation.before.source?.kind === 'portable' ? operation.before.source : null;
  const expectedStorePath = executionStorePath(storeRoot, operation);
  const originIdentity = normalizeSourceIdentity(pair?.origin?.source ?? '', 'apply.ledger.origin');
  const ledgerOwnsApprovedSource =
    approvedSource !== null &&
    expectedStorePath !== null &&
    pair?.mode === 'pinned' &&
    pair.pinned != null &&
    pair.origin !== undefined &&
    pair.journal == null &&
    pair.placementPath === path &&
    resolve(pair.pinned.storePath) === resolve(expectedStorePath) &&
    (pair.pinned.placement ?? 'copy') === operation.before.representation &&
    pair.origin.host === approvedSource.identity.host &&
    pair.origin.repo === approvedSource.identity.repository &&
    (pair.origin.skillPath.length === 0 ? '.' : pair.origin.skillPath) ===
      approvedSource.sourcePath &&
    pair.origin.refRequested === approvedSource.requestedRef &&
    pair.origin.refResolved === approvedSource.resolvedSha &&
    (pair.pinned.gitSha === null || pair.pinned.gitSha === approvedSource.resolvedSha) &&
    originIdentity.ok &&
    canonicalPlanningString(originIdentity.value) ===
      canonicalPlanningString(approvedSource.identity);
  const source =
    contentHash === null
      ? null
      : ledgerOwnsApprovedSource && contentHash === approvedSource.contentHash
        ? approvedSource
        : ({ kind: 'local-dev', path, contentHash } as const);
  const observed: OperationImage = Object.freeze({
    kind: 'placement' as const,
    resource: operation.before.resource,
    classification: pair === null || placement.class === 'absent' ? 'unmanaged' : placement.class,
    representation:
      placement.class === 'dev' || placement.class === 'store-linked'
        ? 'symlink'
        : placement.class === 'pinned'
          ? 'copy'
          : 'other',
    linkTarget:
      placement.symlinkTarget === null
        ? null
        : Object.freeze({
            kind: 'machine-bound' as const,
            path: resolve(dirname(path), placement.symlinkTarget),
          }),
    dangling: placement.dangling,
    source,
    contentHash,
  });
  return canonicalPlanningString(observed) === canonicalPlanningString(operation.before)
    ? operation.before
    : observed;
};

const physicalOperationResult = (
  operation: PhysicalPlacementOperation,
  binding: ValidatedExecutionBinding,
  result: Readonly<{ readonly ok: boolean; readonly error?: unknown }>,
  durableAfter = false,
): OperationExecutionResult => {
  const code = result.error === undefined ? null : safeErrorCode(result.error);
  const cancelled = code === 'cancelled' || code === 'ABORT_ERR';
  const permissionDenied = result.error !== undefined && isPermission(result.error);
  if (result.ok) {
    return createOperationExecutionResult({
      operationId: operation.operationId,
      outcome: 'succeeded',
      actualBefore: binding.actualBefore,
      actualAfter: operation.after,
      force: null,
      error: null,
    });
  }
  return createOperationExecutionResult({
    operationId: operation.operationId,
    outcome: cancelled ? 'cancelled' : 'failed',
    actualBefore: binding.actualBefore,
    actualAfter: durableAfter ? operation.after : binding.actualBefore,
    force: null,
    error: cancelled
      ? null
      : {
          code: permissionDenied ? 'permission-denied' : (code ?? 'apply-operation-failed'),
          message: durableAfter
            ? 'the approved operation reached its durable after-state but cleanup did not complete'
            : 'the approved operation did not reach its durable after-state',
          remediation: 'Resolve the reported state and retry the same reviewed selection.',
        },
  });
};

const committedOperationTransactions = (model: LedgerModel, operationId: string): Set<string> =>
  new Set(
    [...Object.values(model.transactions), ...model.history]
      .filter(
        (journal) =>
          journal.intent.operationId === operationId &&
          journal.disposition === 'forward' &&
          journal.phase === 'committed',
      )
      .map(({ transactionId }) => transactionId),
  );

const reachedNewDurableAfter = (
  operation: PhysicalPlacementOperation,
  before: LedgerModel,
  result: SwapExecutionResult<unknown>,
): boolean => {
  if (result.ok) return true;
  const beforeTransactions = committedOperationTransactions(before, operation.operationId);
  return [...committedOperationTransactions(result.state.ledger, operation.operationId)].some(
    (transactionId) => !beforeTransactions.has(transactionId),
  );
};

const sourceSnapshot = async (
  prepared: PreparedExecutionSource,
  operation: PhysicalPlacementOperation,
  runtime: ExecuteValidatedReconcilePlanRuntime,
  storeRoot: string,
): Promise<SnapshotResult> => {
  if (prepared.snapshot !== null) return prepared.snapshot;
  if (operation.skill === null) throw new TypeError('approved source has no skill identity');
  const namespace = clampStoreNs(prepared.source.identity.repository);
  const provenance: Provenance = {
    kind: 'git-clean',
    repoRoot: null,
    sourceRelPath: null,
    remote: prepared.source.identity.repository,
    gitSha: prepared.source.resolvedSha,
    ns: namespace.ns,
    name: namespace.name,
    dirtySummary: null,
  };
  const snap = await snapshotToStore(runtime.ports, {
    sourceDir: prepared.materializedDir,
    skill: operation.skill,
    storeRoot,
    provenance,
    txId: runtime.ports.nextId('apply-store-snapshot'),
  });
  if (!snap.ok) throw snap.error;
  const projectedStoreHash = await exactContentHash(runtime.ports, snap.value.storePath);
  if (
    resolve(snap.value.storePath) !== resolve(prepared.storePath) ||
    projectedStoreHash !== prepared.source.contentHash
  ) {
    throw new TypeError('approved source snapshot differs from the reviewed after-state');
  }
  prepared.snapshot = snap.value;
  return snap.value;
};

/** Build the mandatory directory-to-symlink bridge for an approved copy-over-copy replacement. */
export const createReconcileCopyReplacementIntermediatePinnedV1 = (
  snapshot: SnapshotResult,
  sha: string,
  actualBefore: OperationImage,
  afterRepresentation: 'copy' | 'symlink',
  now: string,
) =>
  afterRepresentation === 'copy' &&
  actualBefore.kind === 'placement' &&
  actualBefore.representation === 'copy'
    ? deepFreeze(createAcquisitionPinnedRecord(snapshot, sha, 'symlink', 'skipped', now))
    : null;

const executePhysicalPlacement = async (
  operation: PhysicalPlacementOperation,
  binding: ValidatedExecutionBinding,
  runtime: ExecuteValidatedReconcilePlanRuntime,
  ledgerPath: string,
  storeRoot: string,
  sources: ReadonlyMap<string, PreparedExecutionSource>,
): Promise<OperationExecutionResult> => {
  let state: Awaited<ReturnType<typeof readLedgerState>>;
  try {
    state = await readLedgerState(runtime.ports, ledgerPath);
  } catch (error) {
    return physicalOperationResult(operation, binding, { ok: false, error });
  }
  if (!state.ok)
    return physicalOperationResult(operation, binding, { ok: false, error: state.error });
  const ledger = ledgerModelForMutation(state.value, runtime.ports.wallNowIso());
  const currentPair =
    operation.skill === null || operation.tool === null
      ? null
      : getLedgerPairAt(ledger, liveProjectKey(operation.before), operation.skill, operation.tool);
  const beforeHash = operation.before.kind === 'placement' ? operation.before.contentHash : null;
  const updateArtifactBackedRepair =
    operation.kind === 'repair' &&
    ledger.history.some(
      (journal) =>
        journal.phase === 'committed' &&
        journal.disposition === 'forward' &&
        journal.intent.groupId === operation.groupId &&
        journal.intent.pairId === null &&
        (journal.intent.kind === 'write-manifest' || journal.intent.kind === 'write-lock') &&
        journal.context.command === 'update' &&
        journal.context.workflow === 'update-artifact-history',
    );
  let retainedPlacementBefore: PlacementExecutionInput['retainedPlacementBefore'];
  let logicalPlacementBefore: PlacementExecutionInput['logicalPlacementBefore'];
  if (
    (operation.kind === 'update' || updateArtifactBackedRepair) &&
    operation.pairId !== null &&
    beforeHash !== null &&
    currentPair?.pinned !== null &&
    currentPair?.pinned !== undefined
  ) {
    const observedRetained = await exactContentHash(runtime.ports, currentPair.pinned.storePath);
    if (observedRetained === beforeHash) {
      retainedPlacementBefore = Object.freeze({
        resourceId: operation.pairId,
        role: 'store' as const,
        path: currentPair.pinned.storePath,
        repositoryRevision: {
          kind: 'resource' as const,
          digest: beforeHash as ArtifactDigest,
        },
        contentHash: beforeHash as ArtifactDigest,
        retainUntil: null,
      });
      const origin = currentPair.origin;
      if (origin !== undefined && operation.before.kind === 'placement') {
        logicalPlacementBefore = Object.freeze({
          ...operation.before,
          source: Object.freeze({
            kind: 'portable' as const,
            identity: Object.freeze({
              host: origin.host,
              repository: origin.repo,
              path: origin.skillPath.length === 0 ? null : origin.skillPath,
            }),
            requestedRef: origin.refRequested,
            resolvedSha: origin.refResolved,
            sourcePath: origin.skillPath.length === 0 ? '.' : origin.skillPath,
            contentHash: beforeHash,
          }),
        });
      }
    }
  }
  const baseInput = createAcquireExecutionInput(
    runtime.ports,
    ledgerPath,
    ledger,
    [() => runtime.ports.wallNowIso(), () => runtime.ports.nextId('apply-placement-transaction')],
    { ...(runtime.signal === undefined ? {} : { signal: runtime.signal }) },
    operation,
  );
  const input =
    retainedPlacementBefore === undefined
      ? baseInput
      : Object.freeze({
          ...baseInput,
          retainedPlacementBefore,
          ...(logicalPlacementBefore === undefined ? {} : { logicalPlacementBefore }),
        });
  if (operation.skill !== null && exactPendingPlacementOperation(ledger, operation)) {
    const resumed = await recoverPlacementWithObservation(
      input,
      'resume',
      {
        skill: operation.skill,
        tool: operation.tool,
        scopeKey: liveProjectKey(operation.before),
      },
      runtime.observation,
    );
    return physicalOperationResult(
      operation,
      binding,
      resumed,
      reachedNewDurableAfter(operation, ledger, resumed),
    );
  }
  if (operation.kind === 'remove') {
    const path = livePath(operation.before);
    if (path === null || operation.skill === null) {
      return physicalOperationResult(operation, binding, { ok: false });
    }
    const plan: SwapPlan = {
      op: 'uninstall',
      skill: operation.skill,
      tool: operation.tool,
      skillsRoot: dirname(path),
      placementPath: path,
      scopeKey: liveProjectKey(operation.before),
    };
    const removed = await executePlacementPlanObserved(input, plan, runtime.observation);
    return physicalOperationResult(
      operation,
      binding,
      removed,
      reachedNewDurableAfter(operation, ledger, removed),
    );
  }
  const source =
    operation.source?.kind === 'portable'
      ? sources.get(executionSourceKey(operation.source))
      : undefined;
  const path = livePath(operation.after);
  if (
    source === undefined ||
    path === null ||
    operation.skill === null ||
    operation.after.kind !== 'placement' ||
    (operation.after.representation !== 'copy' && operation.after.representation !== 'symlink')
  ) {
    return physicalOperationResult(operation, binding, { ok: false });
  }
  try {
    const snapshot = await sourceSnapshot(source, operation, runtime, storeRoot);
    const pinned = createAcquisitionPinnedRecord(
      snapshot,
      source.source.resolvedSha,
      operation.after.representation,
      'skipped',
      runtime.ports.wallNowIso(),
    );
    const origin = createAcquisitionOriginRecord(
      source.spec,
      source.source.resolvedSha,
      source.source.sourcePath === '.' ? '' : source.source.sourcePath,
      false,
      runtime.ports.wallNowIso(),
    );
    if (
      operation.kind === 'repair' &&
      binding.actualBefore.kind === 'placement' &&
      binding.actualBefore.contentHash === operation.after.contentHash
    ) {
      const existing = getLedgerPairAt(
        ledger,
        liveProjectKey(operation.after),
        operation.skill,
        operation.tool,
      );
      const repaired: PairRecord = {
        placementPath: path,
        mode: 'pinned',
        dev: existing?.dev ?? null,
        pinned,
        origin,
        journal: null,
      };
      const committed = await executeRecordOnlyAcquirePlanWithObservation(
        input,
        operation,
        repaired,
        liveProjectKey(operation.after),
        runtime.observation,
      );
      return physicalOperationResult(
        operation,
        binding,
        committed,
        reachedNewDurableAfter(operation, ledger, committed),
      );
    }
    const plan: SwapPlan = {
      op: 'install',
      skill: operation.skill,
      tool: operation.tool,
      skillsRoot: dirname(path),
      placementPath: path,
      scopeKey: liveProjectKey(operation.after),
      install: {
        build: operation.after.representation,
        storePath: snapshot.storePath,
        contentHash: snapshot.contentHash,
        pinned,
        origin,
        adoptedDev: null,
      },
    };
    const installed = await executeAcquireReplacementWithObservation(
      input,
      plan,
      createReconcileCopyReplacementIntermediatePinnedV1(
        snapshot,
        source.source.resolvedSha,
        binding.actualBefore,
        operation.after.representation,
        runtime.ports.wallNowIso(),
      ),
      runtime.observation,
    );
    return physicalOperationResult(
      operation,
      binding,
      installed,
      reachedNewDurableAfter(operation, ledger, installed),
    );
  } catch (error) {
    return physicalOperationResult(operation, binding, { ok: false, error });
  }
};

const lockAfter = (operation: ExecutableOperation): PortableLockV1 => {
  if (operation.after.kind !== 'lock') {
    throw new TypeError('approved lock operation has no lock after-state');
  }
  return structuredClone(operation.after.value) as unknown as PortableLockV1;
};

const executionExitClass = (
  error: ReconcileExecutionBindingErrorV1,
): PlanReconcileError['exitClass'] =>
  error.code === 'reconcile-execution-cancelled'
    ? 'cancelled'
    : error.code === 'reconcile-execution-permission'
      ? 'permission'
      : error.code === 'reconcile-execution-stale' ||
          error.code === 'reconcile-execution-guards-invalid' ||
          error.code === 'reconcile-execution-plan-invalid'
        ? 'state'
        : 'failure';

type ReconcileGuardVectorName = keyof SavedReconcileExecutionGuards;

const sortedResolvedTokenEntries = (
  tokens: ReadonlyMap<string, string>,
): readonly (readonly [string, string])[] =>
  deepFreeze(
    [...tokens.entries()]
      .map(([token, path]) => [token, path] as const)
      .sort(([leftToken, leftPath], [rightToken, rightPath]) => {
        const tokenOrder = leftToken.localeCompare(rightToken);
        return tokenOrder === 0 ? leftPath.localeCompare(rightPath) : tokenOrder;
      }),
  );

const guardObservationError = (
  code: 'cancelled' | 'precondition-state-changed' | 'precondition-observation-failed',
): Readonly<{ readonly code: typeof code; readonly message: string }> =>
  Object.freeze({
    code,
    message:
      code === 'cancelled'
        ? 'reconciliation execution guard observation was cancelled'
        : code === 'precondition-observation-failed'
          ? 'reconciliation execution guard state could not be observed'
          : 'reconciliation execution guard state changed',
  });

const ownValidationRuntime = (
  runtime: ValidateSavedReconcilePlanRuntime,
): ValidateSavedReconcilePlanRuntime => {
  const ports = Object.freeze({
    ...runtime.ports,
    executableSearchPath: Object.freeze([...runtime.ports.executableSearchPath]),
    xdg: deepFreeze(structuredClone(runtime.ports.xdg)),
    git: Object.freeze({ ...runtime.ports.git }),
  });
  return Object.freeze({
    ports,
    configuration: deepFreeze(structuredClone(runtime.configuration)),
    projectContext: deepFreeze(structuredClone(runtime.projectContext)),
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
};

const guardVectorCanonical = (
  guards: SavedReconcileExecutionGuards,
  name: ReconcileGuardVectorName,
): string => canonicalPlanningString(guards[name]);

/** Expand the exact signed capability guard vector into the scoped snapshot query authority. */
export const createReconcileCapabilityQueriesV1 = (
  guards: SavedReconcileExecutionGuards,
): readonly RelevantCapabilityQueryV1[] =>
  deepFreeze(
    guards.capabilityPreconditions.flatMap((guard) =>
      guard.scopes.map((scope) => ({
        schemaVersion: 1 as const,
        tool: guard.tool,
        operation: guard.operation,
        scope,
      })),
    ),
  );

/**
 * Create one immutable under-lock guard authority for a single execution attempt.
 *
 * The first ordinary guard observation reruns the complete saved-plan validator and every later
 * ordinary observation shares that exact result. The accepted result must reproduce the approved
 * plan, token bindings, and all three guard vectors exactly. Legacy ledger byte aliases additionally
 * read the physical ledger on every observation so cached validation can never hide a byte change.
 */
export const createReconcileExecutionGuardAuthorityV1 = <
  Command extends ReconcileExecutionCommandV1,
>(
  validated: ValidatedSavedReconcilePlanValue<Command>,
  runtime: ValidateSavedReconcilePlanRuntime,
): ReconcileExecutionGuardAuthorityV1 => {
  const savedPlan = deepFreeze(jsonValue(validated.savedPlan) as unknown as SavedPlanV1);
  const approvedPlanCanonical = canonicalPlanningString(jsonValue(validated.plan));
  const approvedPairCanonical = canonicalPlanningString(jsonValue(validated.pair));
  const approvedContinueOnError = validated.plan.batchPolicy === 'continue-on-error';
  const approvedTokensCanonical = canonicalPlanningString(
    sortedResolvedTokenEntries(validated.resolvedTokens),
  );
  const approvedGuards = deepFreeze(
    jsonValue(validated.guards) as unknown as SavedReconcileExecutionGuards,
  );
  const approvedGuardCanonicals = Object.freeze({
    resourcePreconditions: guardVectorCanonical(approvedGuards, 'resourcePreconditions'),
    selectionPreconditions: guardVectorCanonical(approvedGuards, 'selectionPreconditions'),
    capabilityPreconditions: guardVectorCanonical(approvedGuards, 'capabilityPreconditions'),
  });
  const ownedRuntime = ownValidationRuntime(runtime);
  let revalidated: Promise<Readonly<ValidatedSavedReconcilePlanValue<Command>>> | null = null;

  const revalidate = (): Promise<Readonly<ValidatedSavedReconcilePlanValue<Command>>> => {
    revalidated ??= (async () => {
      const current = await validateSavedReconcilePlanValue(
        savedPlan,
        ownedRuntime,
        validated.plan.command,
      );
      if (!current.ok) {
        throw guardObservationError(
          current.error.exitClass === 'cancelled' ? 'cancelled' : 'precondition-state-changed',
        );
      }
      const currentExecutionPlan = createFreshReconcileExecutionPlanV1(
        current.value.plan,
        approvedContinueOnError,
      );
      if (!currentExecutionPlan.ok) {
        throw guardObservationError('precondition-state-changed');
      }
      if (
        canonicalPlanningString(currentExecutionPlan.value) !== approvedPlanCanonical ||
        canonicalPlanningString(current.value.pair) !== approvedPairCanonical ||
        canonicalPlanningString(sortedResolvedTokenEntries(current.value.resolvedTokens)) !==
          approvedTokensCanonical ||
        guardVectorCanonical(current.value.guards, 'resourcePreconditions') !==
          approvedGuardCanonicals.resourcePreconditions ||
        guardVectorCanonical(current.value.guards, 'selectionPreconditions') !==
          approvedGuardCanonicals.selectionPreconditions ||
        guardVectorCanonical(current.value.guards, 'capabilityPreconditions') !==
          approvedGuardCanonicals.capabilityPreconditions
      ) {
        throw guardObservationError('precondition-state-changed');
      }
      return current.value;
    })();
    return revalidated;
  };

  const exactGuard = <Guard extends { readonly preconditionId: string }>(
    vector: readonly Guard[],
    requested: Guard,
  ): Guard => {
    const matches = vector.filter(
      ({ preconditionId }) => preconditionId === requested.preconditionId,
    );
    const match = matches[0];
    if (
      matches.length !== 1 ||
      match === undefined ||
      canonicalPlanningString(match) !== canonicalPlanningString(requested)
    ) {
      throw guardObservationError('precondition-state-changed');
    }
    return match;
  };

  const resourceFact = (guard: ResourcePreconditionV1): unknown =>
    deepFreeze({
      expectedState: guard.expectedState,
      expectedHash: guard.expectedHash,
      expectedRevision: guard.expectedRevision,
    });
  const selectionFact = (guard: SelectionPreconditionV1): unknown => {
    const { preconditionId: _preconditionId, ...fact } = guard;
    return deepFreeze(fact);
  };
  const capabilityFact = (guard: CapabilityPreconditionV1): unknown => {
    const { preconditionId: _preconditionId, ...fact } = guard;
    return deepFreeze(fact);
  };

  const authority: ReconcileExecutionGuardAuthorityV1 = {
    beginValidationCycle: () => {
      revalidated = null;
    },
    observeResource: async (guard, _expected) => {
      const current = await revalidate();
      return resourceFact(exactGuard(current.guards.resourcePreconditions, guard));
    },
    observeSelection: async (guard, _expected) => {
      const current = await revalidate();
      return selectionFact(exactGuard(current.guards.selectionPreconditions, guard));
    },
    observeCapability: async (guard, _expected) => {
      const current = await revalidate();
      return capabilityFact(exactGuard(current.guards.capabilityPreconditions, guard));
    },
    observeLegacyLedgerBytes: async (_operation, guard, _expected) => {
      const current = await revalidate();
      const selected = exactGuard(current.guards.resourcePreconditions, guard);
      const observed = await readLedgerArtifact(
        ownedRuntime.ports,
        ledgerPathOf(resolveDataDir(ownedRuntime.ports, ownedRuntime.configuration)),
      );
      if (!observed.ok) {
        throw guardObservationError(
          ownedRuntime.signal?.aborted ? 'cancelled' : 'precondition-observation-failed',
        );
      }
      if (observed.value.state === 'present') {
        return deepFreeze({
          expectedState: 'present' as const,
          expectedHash: { ...selected.expectedHash, digest: observed.value.byteRevision },
          expectedRevision: {
            kind: 'artifact-bytes' as const,
            digest: observed.value.byteRevision,
          },
        });
      }
      const absentDigest = hashCanonicalInput(
        'resource',
        1,
        canonicalPlanningString({ kind: 'ledger-bytes', state: 'absent' }),
      );
      if (!absentDigest.ok) throw guardObservationError('precondition-observation-failed');
      return deepFreeze({
        expectedState: 'absent' as const,
        expectedHash: { ...selected.expectedHash, digest: absentDigest.value },
        expectedRevision: null,
      });
    },
  };
  return Object.freeze(authority);
};

/** Execute the exact fresh/saved validation product without invoking the planner again. */
export const executeValidatedReconcilePlan = async <Command extends ReconcileExecutionCommandV1>(
  validated: ValidatedSavedReconcilePlanValue<Command>,
  runtime: ExecuteValidatedReconcilePlanRuntime,
): Promise<Result<readonly OperationExecutionResult[], ExecuteValidatedReconcilePlanError>> => {
  if (runtime.signal?.aborted) return err(savedCancelled());
  let plan: OperationPlan<Command | 'update'>;
  try {
    const hasApprovedUpdatePlan = Object.prototype.hasOwnProperty.call(
      runtime,
      'approvedUpdatePlan',
    );
    if (
      hasApprovedUpdatePlan &&
      (validated.plan.command !== 'update' || runtime.approvedUpdatePlan?.command !== 'update')
    ) {
      throw new TypeError('update execution authority cannot be attached to another command');
    }
    const approved =
      validated.plan.command === 'update' && hasApprovedUpdatePlan
        ? (runtime.approvedUpdatePlan ?? validated.plan)
        : validated.plan;
    plan = createOperationPlan(approved as OperationPlanInput<Command | 'update'>);
    if (
      (plan.batchPolicy === 'continue-on-error') !== runtime.continueOnError ||
      canonicalPlanningString(plan) !== canonicalPlanningString(approved)
    ) {
      throw new TypeError('approved execution policy was not derived before execution');
    }
  } catch {
    return err(
      physicalError('apply-execution-plan', 'approved execution plan is invalid', 'state'),
    );
  }
  if (plan.operations.length === 0) return ok(Object.freeze([]));
  if (plan.operations.some(({ conflict }) => conflict !== null)) {
    return err(
      physicalError(
        'apply-execution-conflict',
        'the approved plan contains a conflict that apply is not authorized to force',
        'state',
      ),
    );
  }
  const physicalOperations = new Map<string, PhysicalPlacementOperation>();
  for (const operation of plan.operations) {
    if (!physicalPlacementKinds.has(operation.kind)) continue;
    if (!isPhysicalPlacementOperation(operation)) {
      return err(
        physicalError(
          'apply-tool-capability',
          'the approved operation requires an unsupported placement capability',
          'capability',
        ),
      );
    }
    physicalOperations.set(operation.operationId, operation);
  }

  const guardAuthority = createReconcileExecutionGuardAuthorityV1(validated, runtime);
  const preconditions = createReconcileExecutionPreconditionsV1(
    plan,
    validated.guards,
    guardAuthority,
  );
  if (!preconditions.ok) {
    return err(
      physicalError(
        preconditions.error.code,
        preconditions.error.message,
        executionExitClass(preconditions.error),
      ),
    );
  }
  try {
    guardAuthority.beginValidationCycle?.();
    await validateExecutionPreconditions(plan, preconditions.value, {
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });
  } catch (error) {
    return err(
      isCancellation(error, runtime.signal)
        ? savedCancelled()
        : physicalError(
            'apply-execution-stale',
            'reconciliation execution state changed before physical preparation',
            'state',
          ),
    );
  }

  const dataDir = resolveDataDir(runtime.ports, runtime.configuration);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  let initialLedger: Awaited<ReturnType<typeof readLedgerState>>;
  try {
    initialLedger = await readLedgerState(runtime.ports, ledgerPath);
  } catch (error) {
    return err(
      physicalFailure(
        error,
        'apply-ledger-read',
        'the placement ledger could not be read',
        'failure',
        runtime.signal,
      ),
    );
  }
  if (!initialLedger.ok) {
    return err(
      physicalFailure(
        initialLedger.error,
        'apply-ledger-read',
        'the placement ledger could not be read',
        'failure',
        runtime.signal,
      ),
    );
  }
  const initialModel = ledgerModelForMutation(initialLedger.value, runtime.ports.wallNowIso());
  let sources: Awaited<ReturnType<typeof prepareExecutionSources>>;
  try {
    sources = await prepareExecutionSources(
      plan,
      runtime,
      storeRoot,
      legacyLedgerView(initialModel),
    );
  } catch (error) {
    return err(
      physicalFailure(
        error,
        'apply-source-preparation',
        'the approved source could not be prepared',
        'source',
        runtime.signal,
      ),
    );
  }
  if (!sources.ok) return sources;

  const executePreparedSources = async (): Promise<
    Result<readonly OperationExecutionResult[], ExecuteValidatedReconcilePlanError>
  > => {
    const liveByPath = new Map<string, AcquireLiveSnapshotResourceV1>();
    const storesByPath = new Map<string, AcquireStoreSnapshotResourceV1>();
    for (const operation of physicalOperations.values()) {
      for (const image of [operation.before, operation.after]) {
        const resource = liveResource(image);
        const path = livePath(image);
        if (resource === null || path === null) continue;
        if (!isPlacementToolId(resource.tool) || resource.tool !== operation.tool) {
          return err(
            physicalError(
              'apply-tool-capability',
              'the approved live resource requires an unsupported placement capability',
              'capability',
            ),
          );
        }
        liveByPath.set(path, {
          resourceId: acquireStateResourceId('live', [path]),
          skill: resource.skill,
          tool: resource.tool,
          scope: resource.scope,
          projectIdentity:
            resource.scope === 'project' && resource.projectRoot?.kind === 'machine-bound'
              ? resolve(resource.projectRoot.path)
              : null,
          placementPath: path,
          storeRoot,
        });
      }
      if (operation.source?.kind !== 'portable' || operation.skill === null) continue;
      const path = executionStorePath(storeRoot, operation);
      if (path === null) continue;
      const resolvedPath = resolve(path);
      const resourceId = acquireStateResourceId('store', [resolvedPath]);
      storesByPath.set(resolvedPath, {
        resource: { resourceId, storePath: resolvedPath },
        contentHash: operation.source.contentHash,
      });
    }

    const capabilityQueries = createReconcileCapabilityQueriesV1(validated.guards);
    const captureSnapshot = async (): Promise<
      Result<
        Awaited<ReturnType<typeof readAcquisitionSnapshotV1>>,
        ExecuteValidatedReconcilePlanError
      >
    > => {
      try {
        return ok(
          await readAcquisitionSnapshotV1({
            env: runtime.ports,
            registry: toolRegistry,
            capabilityQueries,
            projectContext: runtime.projectContext,
            artifact: { mode: 'selected', pair: validated.pair },
            ledgerPath,
            liveResources: [...liveByPath.values()],
            storeResources: [...storesByPath.values()],
            fixedProjectContext: true,
            ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
          }),
        );
      } catch (error) {
        return err(
          physicalFailure(
            error,
            'apply-execution-snapshot',
            'current execution state could not be captured safely',
            'state',
            runtime.signal,
          ),
        );
      }
    };
    // Prove snapshot readability before any bootstrap write. The lock-owned capture below is the
    // authoritative one; this pass preserves a physically empty failure path.
    const preliminarySnapshot = await captureSnapshot();
    if (!preliminarySnapshot.ok) return preliminarySnapshot;

    const executeCapturedSnapshot = async (
      snapshotAuthority: Awaited<ReturnType<typeof readAcquisitionSnapshotV1>>,
    ): Promise<Result<readonly OperationExecutionResult[], ExecuteValidatedReconcilePlanError>> => {
      const ledgerLockPort = createAcquireExecutionLockPort(
        runtime.ports,
        ledgerPath,
        (error) =>
          isPermission(error)
            ? permissionDeniedError('placement ledger directory or lock permission denied')
            : (error as never),
        () => 'placement ledger lock failed',
      );
      let artifactController: ReturnType<typeof createAcquisitionArtifactExecutionControllerV1>;
      try {
        artifactController = createAcquisitionArtifactExecutionControllerV1({
          authority: snapshotAuthority,
          artifactCoordinator: runtime.artifactCoordinator,
          ledgerLockPort,
          ledgerPath,
          ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
        });
      } catch {
        return err(
          physicalError(
            'apply-artifact-authority',
            'artifact execution authority is invalid',
            'state',
          ),
        );
      }
      const expectedRevisions = Object.freeze([
        snapshotAuthority.snapshot.project.revision,
        ...(snapshotAuthority.snapshot.artifact.mode === 'selected'
          ? [
              snapshotAuthority.snapshot.artifact.manifest.revision,
              snapshotAuthority.snapshot.artifact.lock.revision,
            ]
          : []),
        snapshotAuthority.snapshot.ledger.revision,
        ...snapshotAuthority.snapshot.live.map(({ revision }) => revision),
        ...snapshotAuthority.snapshot.store.map(({ revision }) => revision),
        snapshotAuthority.snapshot.capabilities.revision,
      ]);
      const lifecycle = createAcquisitionRepositoryLifecycleControllerV1({
        authority: snapshotAuthority,
        snapshotId: snapshotAuthority.snapshot.snapshotId,
        expectedRevisions,
      });
      const artifactActions = new Map(
        (runtime.artifactActions ?? []).map(({ operationId, action }) => [operationId, action]),
      );
      const currentArtifactOperations = Object.freeze(
        plan.operations.filter(({ kind }) => kind === 'write-manifest' || kind === 'write-lock'),
      );
      const verificationBlockedResult = (
        operation: ExecutableOperation,
        actualBefore: OperationImage,
      ): OperationExecutionResult =>
        createOperationExecutionResult({
          operationId: operation.operationId,
          outcome: 'failed',
          actualBefore,
          actualAfter: actualBefore,
          force: null,
          error: {
            code: 'update-verification-blocked',
            message: 'the selected update verification gate blocked this operation',
            remediation: 'resolve verification findings and retry the same update selection',
          },
        });
      const liveIds = (operation: PhysicalPlacementOperation): string[] => [
        ...new Set(
          [operation.before, operation.after].flatMap((image) => {
            const path = livePath(image);
            const id = path === null ? undefined : liveByPath.get(path)?.resourceId;
            return id === undefined ? [] : [id];
          }),
        ),
      ];
      const storeIds = (operation: PhysicalPlacementOperation): string[] => {
        const path = executionStorePath(storeRoot, operation);
        const store = path === null ? undefined : storesByPath.get(resolve(path));
        return store === undefined ? [] : [store.resource.resourceId];
      };
      const mutableRevisions = [
        ...snapshotAuthority.snapshot.live,
        ...snapshotAuthority.snapshot.store,
      ]
        .map(({ revision }) => revision)
        .filter(
          (revision): revision is typeof revision & Readonly<{ parentIdentity: string }> =>
            'parentIdentity' in revision,
        );
      const lifecycleResourceIds = (operation: PhysicalPlacementOperation): string[] => {
        const ownedResourceIds = new Set([...liveIds(operation), ...storeIds(operation)]);
        const parentIdentities = new Set(
          mutableRevisions
            .filter(({ resourceId }) => ownedResourceIds.has(resourceId))
            .map(({ parentIdentity }) => parentIdentity),
        );
        return mutableRevisions
          .filter(
            ({ resourceId, parentIdentity }) =>
              ownedResourceIds.has(resourceId) || parentIdentities.has(parentIdentity),
          )
          .map(({ resourceId }) => resourceId);
      };

      const authorities: ReconcileRuntimeExecutionAuthoritiesV1 = {
        ...(plan.command === 'update'
          ? {
              beforeSchedule: async () => {
                const changed = await recoverPendingUpdateArtifactHistoryV1({
                  artifactCoordinator: runtime.artifactCoordinator,
                  ports: runtime.ports,
                  ledgerPath,
                  currentArtifactOperations,
                  ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
                });
                if (changed) {
                  await lifecycle.rebase([snapshotAuthority.ledgerResourceId]);
                }
              },
            }
          : {}),
        placement: {
          bind: (operation) => {
            const physical = physicalOperations.get(operation.operationId);
            if (physical === undefined) {
              throw new TypeError(
                'approved placement operation lacks a supported physical binding',
              );
            }
            let actualBefore = operation.before;
            return lifecycle.bind(
              operation,
              Object.freeze({
                operationId: operation.operationId,
                groupId: operation.groupId,
                pairId: operation.pairId,
                unstartedForce: null,
                observeActualBefore: async () => {
                  actualBefore = await observePhysicalPlacement(
                    physical,
                    runtime,
                    ledgerPath,
                    storeRoot,
                  );
                  return actualBefore;
                },
                execute: (binding: ValidatedExecutionBinding) =>
                  runtime.blockedOperationIds?.has(operation.operationId)
                    ? Promise.resolve(verificationBlockedResult(operation, binding.actualBefore))
                    : executePhysicalPlacement(
                        physical,
                        { ...binding, actualBefore },
                        runtime,
                        ledgerPath,
                        storeRoot,
                        sources.value,
                      ),
              }),
              [snapshotAuthority.ledgerResourceId, ...lifecycleResourceIds(physical)],
            );
          },
        },
        artifact: {
          bind: (operation) => {
            const action =
              artifactActions.get(operation.operationId) ??
              (operation.kind === 'migrate-project-config'
                ? {
                    role: 'manifest' as const,
                    action: {
                      kind: 'edit' as const,
                      request: { edits: [{ kind: 'migrate-legacy' as const }] },
                    },
                  }
                : operation.kind === 'write-lock'
                  ? {
                      role: 'lock' as const,
                      action: { kind: 'replace' as const, lock: lockAfter(operation) },
                    }
                  : null);
            if (action === null) return null;
            const binding = artifactController.bind(operation, action);
            if (runtime.blockedGroupIds?.has(operation.groupId)) {
              return Object.freeze({
                ...binding,
                execute: (validatedBinding: ValidatedExecutionBinding) =>
                  Promise.resolve(
                    verificationBlockedResult(operation, validatedBinding.actualBefore),
                  ),
              });
            }
            return plan.command === 'update' &&
              (operation.kind === 'write-manifest' || operation.kind === 'write-lock')
              ? bindForwardUpdateArtifactHistoryV1({
                  operation,
                  binding,
                  artifactCoordinator: runtime.artifactCoordinator,
                  ports: runtime.ports,
                  ledgerPath,
                  currentArtifactOperations,
                  onLedgerCommitted: () => lifecycle.rebase([snapshotAuthority.ledgerResourceId]),
                  ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
                })
              : binding;
          },
        },
        ledgerMigration: {
          bind: (operation) =>
            initialLedger.value.state === 'present'
              ? lifecycle.bind(
                  operation,
                  createAcquisitionLedgerMigrationBinding({
                    env: runtime.ports,
                    ledgerPath,
                    operation,
                    expectedState: initialLedger.value,
                    startedAt: runtime.ports.wallNowIso(),
                    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
                    onMigrated: () => undefined,
                  }),
                  [snapshotAuthority.ledgerResourceId],
                )
              : null,
        },
        moveScope: {
          bind: (operation) => {
            const physical = physicalOperations.get(operation.operationId);
            if (physical === undefined) {
              throw new TypeError('approved scope move lacks a supported physical binding');
            }
            const binding = createReconcileMoveScopeExecutionBindingV1(operation, {
              observeActualBefore: () =>
                observePhysicalPlacement(physical, runtime, ledgerPath, storeRoot),
              createRequest: async () => {
                const current = await readLedgerState(runtime.ports, ledgerPath);
                if (!current.ok) throw current.error;
                return createPlacementSwapRequest(
                  createPlacementExecutionInput(
                    runtime.ports,
                    ledgerPath,
                    ledgerModelForMutation(current.value, runtime.ports.wallNowIso()),
                    {
                      now: () => runtime.ports.wallNowIso(),
                      newTxId: () => runtime.ports.nextId('apply-move-scope-transaction'),
                    },
                    { ...(runtime.signal === undefined ? {} : { signal: runtime.signal }) },
                    physical,
                  ),
                );
              },
            });
            return lifecycle.bind(operation, binding, [
              snapshotAuthority.ledgerResourceId,
              ...lifecycleResourceIds(physical),
            ]);
          },
        },
        guards: guardAuthority,
        lockPort: artifactController.lockPort,
        locks: artifactController.locks,
      };
      const executed = await executeValidatedReconcilePlanV1({
        plan,
        guards: validated.guards,
        authorities,
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
        observation: runtime.observation,
      });
      if (executed.ok) return ok(executed.value);
      const mapped = physicalError(
        executed.error.code,
        executed.error.message,
        executionExitClass(executed.error),
      );
      return err(
        executed.error.results === undefined
          ? mapped
          : deepFreeze({
              ...mapped,
              results: jsonValue(
                executed.error.results,
              ) as unknown as readonly OperationExecutionResult[],
            }),
      );
    };

    // The ledger target cannot be locked until its parent exists. A stable outer bootstrap lock
    // encloses creation, the authoritative snapshot, final coordinator validation, and execution.
    // This avoids both pre-lock residue and a self-inflicted stale parent revision.
    const bootstrapLockPath = join(
      runtime.artifactCoordinator.coordinationRoot,
      'apply-ledger-bootstrap',
    );
    try {
      return await runtime.ports.withFileLock(
        bootstrapLockPath,
        async () => {
          const ledgerDirectory = dirname(ledgerPath);
          const createdBootstrapDirectory =
            (await runtime.ports.pathKind(ledgerDirectory)) === 'absent';
          await runtime.ports.makeDir(ledgerDirectory);

          const removeEmptyBootstrapDirectory = async (): Promise<unknown | null> => {
            if (!createdBootstrapDirectory) return null;
            try {
              if ((await runtime.ports.pathKind(ledgerDirectory)) !== 'absent') {
                // The coordinator port exposes an atomic empty-directory removal. It cannot race
                // an intervening writer into a recursive deletion.
                await runtime.artifactCoordinator.removeEmptyDirectory(ledgerDirectory);
              }
              return null;
            } catch (error) {
              return error;
            }
          };

          try {
            const lockedSnapshot = await captureSnapshot();
            const executed = lockedSnapshot.ok
              ? await executeCapturedSnapshot(lockedSnapshot.value)
              : lockedSnapshot;
            if (!executed.ok && executed.error.results === undefined) {
              const cleanupError = await removeEmptyBootstrapDirectory();
              if (cleanupError !== null) {
                return err(
                  physicalFailure(
                    cleanupError,
                    'apply-ledger-bootstrap-cleanup',
                    'the empty placement ledger directory could not be rolled back',
                    'failure',
                    runtime.signal,
                  ),
                );
              }
            }
            return executed;
          } catch (error) {
            const cleanupError = await removeEmptyBootstrapDirectory();
            if (cleanupError !== null) {
              return err(
                physicalFailure(
                  cleanupError,
                  'apply-ledger-bootstrap-cleanup',
                  'the empty placement ledger directory could not be rolled back',
                  'failure',
                  runtime.signal,
                ),
              );
            }
            throw error;
          }
        },
        runtime.signal === undefined ? undefined : { signal: runtime.signal },
      );
    } catch (error) {
      return err(
        physicalFailure(
          error,
          isPermission(error) ? 'reconcile-execution-permission' : 'apply-ledger-bootstrap',
          'the placement ledger directory could not be prepared under lock',
          'failure',
          runtime.signal,
        ),
      );
    }
  };

  let outcome: Result<readonly OperationExecutionResult[], ExecuteValidatedReconcilePlanError>;
  let cleanupFailed = false;
  let cleanupPermissionDenied = false;
  try {
    outcome = await executePreparedSources();
  } catch (error) {
    outcome = err(
      physicalFailure(
        error,
        'apply-execution-failed',
        'reconciliation execution failed during physical setup',
        'failure',
        runtime.signal,
      ),
    );
  } finally {
    for (const source of sources.value.values()) {
      if (source.cleanupDirectory === null) continue;
      try {
        await runtime.ports.removeTree(source.cleanupDirectory);
      } catch (error) {
        cleanupFailed = true;
        if (isPermission(error)) cleanupPermissionDenied = true;
      }
    }
  }
  if (!cleanupFailed || !outcome.ok) return outcome;
  return err(
    deepFreeze({
      ...physicalError(
        'reconcile-execution-cleanup-failed',
        'reconciliation execution completed but temporary source cleanup failed',
        cleanupPermissionDenied ? 'permission' : 'failure',
      ),
      results: jsonValue(outcome.value) as unknown as readonly OperationExecutionResult[],
    }),
  );
};
