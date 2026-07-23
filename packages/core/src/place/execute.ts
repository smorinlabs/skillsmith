import { dirname, join, parse } from 'node:path';
import type {
  RelevantCapabilityQueryV1,
  RelevantCapabilitySnapshotV1,
} from '../agents/capabilities.ts';
import type { LifecycleToolRegistry } from '../agents/registry.ts';
import type { ArtifactCoordinatorPorts } from '../artifacts/coordinator-types.ts';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import { createLedgerRepository } from '../artifacts/ledger-repository.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import type { LedgerWriterPorts } from '../artifacts/ledger-writer.ts';
import { createLockRepository, createManifestRepository } from '../artifacts/repository.ts';
import type { ProjectContext } from '../context/types.ts';
import {
  type SkillSmithError,
  cancelledError,
  errorMessage,
  flipFailedError,
  flipRefusedError,
  permissionDeniedError,
  safeErrorCode,
} from '../errors.ts';
import {
  type DurabilityReceiptV1,
  type ObservedExecutionCoordinatorRequest,
  type ObservedPreparedExecutionBinding,
  type RevisionCursorV1,
  createRevisionCursorV1,
  executeOperationPlanObserved,
  executeRepositoryLifecycleV1,
} from '../execution/coordinator.ts';
import {
  type ExecutionCoordinatorRequest,
  type ExecutionLockDescriptor,
  type ExecutionPrecondition,
  type PreparedExecutionBinding,
  type ValidatedExecutionBinding,
  executeOperationPlan,
} from '../execution/index.ts';
import { createExpectedRevisionExecutionPrecondition } from '../execution/preconditions.ts';
import type { ObservationBundle } from '../observation/index.ts';
import { createOperationExecutionResult } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  BoundedForceEffect,
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
  OperationResourceIdentity,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { readObservedStateSnapshotV1 } from '../state/read.ts';
import {
  type LockRepository,
  type LogicalRepositoryStageV1,
  type ManifestRepository,
  type ObservedStateRepositoriesV1,
  type ProjectStateReaderV1,
  createProjectStateReaderV1,
  createRelevantCapabilityStateReaderV1,
  stageLogicalRepositoryEditV1,
} from '../state/repositories.ts';
import {
  type ExpectedRevisionV1,
  type ObservedStateSnapshotV1,
  createExpectedRevisionPreconditionIdV1,
  createExpectedRevisionV1,
  createFilesystemMetadataIdentityV1,
  sameExpectedRevisionV1,
  semanticValueRevisionV1,
} from '../state/types.ts';
import {
  ledgerMigrationExecutionBinding,
  ledgerMigrationExecutionBindingObserved,
} from './ledger-migration.ts';
import { createLedgerPersistenceGateway } from './ledger-persistence.ts';
import { ledgerModelForMutation, readLedgerState, withLedgerLock } from './ledger.ts';
import { createLivePlacementRepository } from './live-repository.ts';
import type { LivePlacementResourceV1 } from './live-repository.ts';
import type { PairPlan } from './plan.ts';
import { createStoreRepository } from './store-repository.ts';
import type { StoreResourceV1 } from './store-repository.ts';
import {
  type PlacementPublicationGuard,
  commitRecordOnlyLogicalTransaction,
  commitRecordOnlyLogicalTransactionObserved,
  runCommittedPlacementReversal,
  runCommittedPlacementReversalObserved,
  runSwap,
  runSwapObserved,
} from './swap.ts';
import type {
  FlipDeps,
  FlipOp,
  FlipOptions,
  FlipResult,
  FlipTool,
  JournalPhase,
  PairRecord,
  PlacementPorts,
  SwapExecutionResult,
  SwapOutcome,
  SwapPlan,
  SwapRequest,
} from './types.ts';

const pairIdentityKey = (pair: PairPlan): string =>
  JSON.stringify([pair.scope, pair.scopeKey, pair.skill, pair.tool, pair.placement.path]);

export const placementSnapshotResourceId = (domain: string, identity: string): string =>
  (() => {
    const hashed = hashCanonicalInput(
      'resource',
      1,
      JSON.stringify(['skillsmith-placement-snapshot-resource', 1, domain, identity]),
    );
    if (!hashed.ok) throw new Error('placement snapshot resource identity hash failed');
    return `placement-${domain}:v1:${hashed.value.slice('sha256:'.length)}`;
  })();

const siblingLockPath = (manifestPath: string): string => {
  const parts = parse(manifestPath);
  return join(parts.dir, `${parts.name}.lock`);
};

export interface PlacementStoreResource extends StoreResourceV1 {
  readonly contentHash: `sha256:${string}`;
}

export interface PlacementSnapshotAuthority {
  readonly snapshot: ObservedStateSnapshotV1<RelevantCapabilitySnapshotV1>;
  readonly repositories: ObservedStateRepositoriesV1<RelevantCapabilitySnapshotV1>;
  readonly projectRoot: string;
  readonly manifestPath: string;
  readonly lockPath: string;
  readonly ledgerResourceId: string;
  readonly liveResources: readonly LivePlacementResourceV1[];
  readonly storeResources: readonly PlacementStoreResource[];
}

export interface PlacementLedgerBootstrapAuthorityV1 {
  readonly kind: 'placement-ledger-bootstrap-authority';
  readonly ledgerPath: string;
  readonly ledgerDirectory: string;
  readonly createdDirectory: boolean;
}

interface PlacementSnapshotAuthorityRuntimeState {
  readonly env: PlacementPorts;
  readonly snapshotRequest: Readonly<{
    readonly schemaVersion: 1;
    readonly projectResourceId: string;
    readonly manifestResourceId: string;
    readonly lockResourceId: string;
    readonly ledgerResourceId: string;
    readonly liveResourceIds: readonly string[];
    readonly storeResourceIds: readonly string[];
    readonly capabilitiesResourceId: string;
  }>;
  readonly revisionRebinding: Readonly<{
    readonly approved: ExpectedRevisionV1;
    readonly authoritative: ExpectedRevisionV1;
    readonly bootstrap: PlacementLedgerBootstrapAuthorityV1;
  }> | null;
}

const activePlacementLedgerBootstrapAuthorities = new WeakSet<object>();
const placementSnapshotAuthorityRuntime = new WeakMap<
  object,
  PlacementSnapshotAuthorityRuntimeState
>();

const placementSnapshotRevisions = (
  snapshot: ObservedStateSnapshotV1<RelevantCapabilitySnapshotV1>,
): readonly ExpectedRevisionV1[] =>
  Object.freeze([
    snapshot.project.revision,
    snapshot.manifest.revision,
    snapshot.lock.revision,
    snapshot.ledger.revision,
    ...snapshot.live.map(({ revision }) => revision),
    ...snapshot.store.map(({ revision }) => revision),
    snapshot.capabilities.revision,
  ]);

const placementLedgerBootstrapCleanupError = (cause: unknown): unknown =>
  Object.freeze({
    code: 'placement-ledger-bootstrap-cleanup' as const,
    message: 'the empty placement ledger directory could not be rolled back',
    cause,
  });

const placementLedgerBootstrapSetupError = (
  error: unknown,
  ledgerPath: string,
): SkillSmithError => {
  const code = safeErrorCode(error);
  if (code === 'cancelled' || code === 'ABORT_ERR' || code === 'AbortError') {
    return cancelledError('placement ledger bootstrap was cancelled');
  }
  if (
    code === 'permission' ||
    code === 'permission-denied' ||
    code === 'EACCES' ||
    code === 'EPERM'
  ) {
    return permissionDeniedError('cannot prepare placement ledger directory', ledgerPath);
  }
  return flipFailedError(`placement ledger bootstrap failed: ${errorMessage(error)}`);
};

/**
 * Hold the stable cross-command bootstrap lock while materializing only the missing ledger parent.
 * The callback receives an opaque, callback-scoped proof. A failed attempt atomically removes only
 * the exact empty directory this authority created; recursive cleanup is intentionally forbidden.
 */
export const withPlacementLedgerBootstrapAuthorityV1 = async <T>(
  input: Readonly<{
    readonly env: Pick<PlacementPorts, 'pathKind' | 'makeDir' | 'withFileLock'>;
    readonly artifactCoordinator: Pick<
      ArtifactCoordinatorPorts,
      'coordinationRoot' | 'removeEmptyDirectory'
    >;
    readonly ledgerPath: string;
    readonly signal?: AbortSignal;
    readonly rollbackOnResult?: (value: T) => boolean;
  }>,
  operation: (authority: PlacementLedgerBootstrapAuthorityV1) => Promise<T>,
): Promise<T> => {
  const bootstrapLockPath = join(
    input.artifactCoordinator.coordinationRoot,
    'apply-ledger-bootstrap',
  );
  let callbackStarted = false;
  try {
    return await input.env.withFileLock(
      bootstrapLockPath,
      async () => {
        const ledgerDirectory = dirname(input.ledgerPath);
        const createdDirectory = (await input.env.pathKind(ledgerDirectory)) === 'absent';
        await input.env.makeDir(ledgerDirectory);
        const authority = Object.freeze({
          kind: 'placement-ledger-bootstrap-authority' as const,
          ledgerPath: input.ledgerPath,
          ledgerDirectory,
          createdDirectory,
        });
        activePlacementLedgerBootstrapAuthorities.add(authority);

        const rollbackEmptyDirectory = async (): Promise<void> => {
          if (!createdDirectory || (await input.env.pathKind(ledgerDirectory)) === 'absent') return;
          try {
            await input.artifactCoordinator.removeEmptyDirectory(ledgerDirectory);
          } catch (error) {
            const code = safeErrorCode(error);
            if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'conflict') return;
            throw placementLedgerBootstrapCleanupError(error);
          }
        };

        try {
          callbackStarted = true;
          const value = await operation(authority);
          if (input.rollbackOnResult?.(value) === true) await rollbackEmptyDirectory();
          return value;
        } catch (error) {
          await rollbackEmptyDirectory();
          throw error;
        } finally {
          activePlacementLedgerBootstrapAuthorities.delete(authority);
        }
      },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
  } catch (error) {
    throw callbackStarted ? error : placementLedgerBootstrapSetupError(error, input.ledgerPath);
  }
};

/**
 * Opaque proof that one explicit project endpoint is the exact canonical directory represented by
 * its ProjectContext. Structural lookalikes are rejected by the shared authority at runtime.
 */
export interface ExplicitPlacementProjectLocationV1 {
  readonly kind: 'explicit-placement-project-location';
  readonly canonicalRoot: string;
  readonly context: ProjectContext;
}

const explicitPlacementProjectLocations = new WeakSet<object>();

export const createExplicitPlacementProjectLocationV1 = async (
  env: Pick<PlacementPorts, 'pathKind' | 'realpath'>,
  projectContext: ProjectContext,
  endpointRoot: string,
): Promise<Result<ExplicitPlacementProjectLocationV1, SkillSmithError>> => {
  try {
    const [canonicalRoot, canonicalContextRoot] = await Promise.all([
      env.realpath(endpointRoot),
      env.realpath(projectContext.projectRoot ?? projectContext.effectiveCwd),
    ]);
    if (
      canonicalRoot !== canonicalContextRoot ||
      (await env.pathKind(canonicalRoot)) !== 'dir' ||
      (projectContext.projectRoot !== null && projectContext.projectRoot !== canonicalRoot) ||
      (projectContext.projectIdentity !== null && projectContext.projectIdentity !== canonicalRoot)
    ) {
      return err(flipRefusedError('explicit project endpoint identity is inconsistent'));
    }
    const location = Object.freeze({
      kind: 'explicit-placement-project-location' as const,
      canonicalRoot,
      context: Object.freeze({ ...projectContext }),
    });
    explicitPlacementProjectLocations.add(location);
    return ok(location);
  } catch {
    return err(flipRefusedError('explicit project endpoint identity could not be revalidated'));
  }
};

const normalizeExplicitProjectContext = (
  context: ProjectContext,
  location: ExplicitPlacementProjectLocationV1,
): ProjectContext =>
  Object.freeze({
    ...context,
    invocationCwd: location.canonicalRoot,
    effectiveCwd: location.canonicalRoot,
    projectRoot: location.canonicalRoot,
    projectIdentity: location.canonicalRoot,
  });

const projectReaderForExplicitLocation = (
  reader: ProjectStateReaderV1,
  resourceId: string,
  location: ExplicitPlacementProjectLocationV1,
): ProjectStateReaderV1 => {
  const observe: ProjectStateReaderV1['observe'] = async (requestedResourceId) => {
    const observed = await reader.observe(requestedResourceId);
    if (!observed.ok || observed.value.value === null) return observed;
    const raw = observed.value.value;
    if (raw.projectRoot !== null && raw.projectRoot !== location.canonicalRoot) return observed;
    const value = normalizeExplicitProjectContext(raw, location);
    try {
      const revision = createExpectedRevisionV1({
        schemaVersion: 1,
        domain: 'project',
        resourceId,
        state: 'present',
        targetKind: 'semantic',
        semanticRevision: semanticValueRevisionV1('project', value),
      });
      return revision.ok
        ? ok(Object.freeze({ revision: revision.value, value }))
        : err(
            Object.freeze({
              code: 'state-repository' as const,
              domain: 'project' as const,
              reason: 'observation-failed' as const,
            }),
          );
    } catch {
      return err(
        Object.freeze({
          code: 'state-repository' as const,
          domain: 'project' as const,
          reason: 'observation-failed' as const,
        }),
      );
    }
  };
  return Object.freeze({
    observe,
    observeRevision: async (requestedResourceId: string) => {
      const observed = await observe(requestedResourceId);
      return observed.ok ? ok(observed.value.revision) : observed;
    },
  });
};

export interface PlacementLifecycleExecutor {
  readonly execute: (
    operation: ExecutableOperation,
    stageResourceIds: readonly string[],
    commit: () => Promise<OperationExecutionResult>,
  ) => Promise<OperationExecutionResult>;
}

const createSyntheticAbsentArtifactRepository = <Domain extends 'manifest' | 'lock'>(
  domain: Domain,
  resourceId: string,
  path: string,
): Domain extends 'manifest' ? ManifestRepository : LockRepository => {
  const revision = createExpectedRevisionV1({
    schemaVersion: 1,
    domain,
    resourceId,
    state: 'absent',
    targetIdentity: path,
    targetKind: 'absent',
    parentIdentity: parse(path).dir,
    parentKind: 'absent',
    parentMetadataIdentity: 'synthetic-live-only-artifact-parent',
  });
  if (!revision.ok) throw new Error('synthetic placement artifact revision is invalid');
  const invalid = () =>
    err(
      Object.freeze({
        code: 'state-repository' as const,
        domain,
        reason: 'invalid-request' as const,
      }),
    );
  const observe = async (requestedResourceId: string) =>
    requestedResourceId === resourceId
      ? ok(Object.freeze({ revision: revision.value, value: null }))
      : invalid();
  const repository = Object.freeze({
    observe,
    observeRevision: async (requestedResourceId: string) => {
      const observed = await observe(requestedResourceId);
      return observed.ok ? ok(observed.value.revision) : observed;
    },
    stage: async (request: import('../state/repositories.ts').RepositoryStageRequestV1) => {
      if (request.domain !== domain || request.resourceId !== resourceId) {
        return err(Object.freeze({ code: 'invalid-logical-stage' as const }));
      }
      return stageLogicalRepositoryEditV1({ ...request, observedRevision: revision.value });
    },
  });
  return repository as Domain extends 'manifest' ? ManifestRepository : LockRepository;
};

export const createPlacementSnapshotAuthority = async (
  registry: LifecycleToolRegistry,
  capabilityQueries: readonly RelevantCapabilityQueryV1[],
  env: PlacementPorts,
  projectContext: ProjectContext,
  ledgerPath: string,
  storeRoot: string,
  pairs: readonly PairPlan[],
  stores: readonly PlacementStoreResource[],
  selectedArtifacts?: Readonly<{
    readonly manifestPath: string;
    readonly lockPath: string;
    readonly observe?: boolean;
  }>,
  explicitProjectLocation?: ExplicitPlacementProjectLocationV1,
): Promise<Result<PlacementSnapshotAuthority, SkillSmithError>> => {
  if (
    explicitProjectLocation !== undefined &&
    (!explicitPlacementProjectLocations.has(explicitProjectLocation) ||
      canonicalPlanningString(explicitProjectLocation.context) !==
        canonicalPlanningString(projectContext) ||
      pairs.some(
        (pair) =>
          pair.scope !== 'project' || pair.scopeKey !== explicitProjectLocation.canonicalRoot,
      ))
  ) {
    return err(flipRefusedError('explicit project endpoint authority is invalid'));
  }
  const effectiveProjectContext =
    explicitProjectLocation === undefined
      ? projectContext
      : normalizeExplicitProjectContext(projectContext, explicitProjectLocation);
  const contextOptions = {
    invocationCwd: effectiveProjectContext.invocationCwd,
    ...(effectiveProjectContext.explicitConfigPath === null
      ? {}
      : { explicitConfigPath: effectiveProjectContext.explicitConfigPath }),
  };
  const projectRoot =
    explicitProjectLocation?.canonicalRoot ??
    effectiveProjectContext.projectRoot ??
    effectiveProjectContext.effectiveCwd;
  const manifestPath =
    selectedArtifacts?.manifestPath ??
    projectContext.explicitConfigPath ??
    projectContext.discoveredConfigPath ??
    join(projectRoot, 'skillsmith.toml');
  const lockPath = selectedArtifacts?.lockPath ?? siblingLockPath(manifestPath);
  const projectResourceId = placementSnapshotResourceId('project', projectRoot);
  const manifestResourceId = placementSnapshotResourceId('manifest', manifestPath);
  const lockResourceId = placementSnapshotResourceId('lock', lockPath);
  const ledgerResourceId = placementSnapshotResourceId('ledger', ledgerPath);
  const capabilities = createRelevantCapabilityStateReaderV1(registry, capabilityQueries);
  const capabilitiesResourceId = capabilities.resourceId;
  const ledgerWriterPorts = (
    env as PlacementPorts & {
      readonly ledgerWriterPorts?: LedgerWriterPorts;
    }
  ).ledgerWriterPorts;
  const liveResources = pairs.map(
    (pair): LivePlacementResourceV1 => ({
      resourceId: placementSnapshotResourceId('live', pairIdentityKey(pair)),
      skill: pair.skill,
      tool: pair.tool,
      scope: pair.scope,
      projectIdentity: pair.scopeKey,
      placementPath: pair.placement.path,
      storeRoot,
    }),
  );
  const repositories: ObservedStateRepositoriesV1<RelevantCapabilitySnapshotV1> = Object.freeze({
    project: (() => {
      const reader = createProjectStateReaderV1({
        resourceId: projectResourceId,
        ports: env,
        context: contextOptions,
      });
      return explicitProjectLocation === undefined
        ? reader
        : projectReaderForExplicitLocation(reader, projectResourceId, explicitProjectLocation);
    })(),
    manifest:
      selectedArtifacts?.observe === false
        ? createSyntheticAbsentArtifactRepository('manifest', manifestResourceId, manifestPath)
        : createManifestRepository({
            resourceId: manifestResourceId,
            path: manifestPath,
            ports: env,
          }),
    lock:
      selectedArtifacts?.observe === false
        ? createSyntheticAbsentArtifactRepository('lock', lockResourceId, lockPath)
        : createLockRepository({ resourceId: lockResourceId, path: lockPath, ports: env }),
    ledger: createLedgerRepository({
      resourceId: ledgerResourceId,
      reader: {
        ledgerPath,
        read: () => readLedgerState(ledgerWriterPorts ?? env, ledgerPath),
      },
      metadata: env,
    }),
    live: createLivePlacementRepository({ resources: liveResources, ports: env }),
    store: createStoreRepository({ resources: stores, ports: env }),
    capabilities,
  });
  const snapshotRequest = Object.freeze({
    schemaVersion: 1 as const,
    projectResourceId,
    manifestResourceId,
    lockResourceId,
    ledgerResourceId,
    liveResourceIds: Object.freeze(liveResources.map((resource) => resource.resourceId)),
    storeResourceIds: Object.freeze(stores.map((resource) => resource.resourceId)),
    capabilitiesResourceId,
  });
  const observed = await readObservedStateSnapshotV1(snapshotRequest, repositories);
  if (!observed.ok) {
    return err(
      flipRefusedError(
        observed.error.code === 'snapshot-changed'
          ? 'placement state changed while preparing the operation; retry'
          : `placement state could not be observed (${observed.error.code})`,
      ),
    );
  }
  if (
    observed.value.project.value === null ||
    canonicalPlanningString(observed.value.project.value) !==
      canonicalPlanningString(effectiveProjectContext)
  ) {
    return err(flipRefusedError('project context changed while preparing the operation; retry'));
  }
  const authority: PlacementSnapshotAuthority = {
    snapshot: observed.value,
    repositories,
    projectRoot,
    manifestPath,
    lockPath,
    ledgerResourceId,
    liveResources,
    storeResources: stores,
  };
  placementSnapshotAuthorityRuntime.set(authority, {
    env,
    snapshotRequest,
    revisionRebinding: null,
  });
  return ok(authority);
};

const exactPlacementLedgerBootstrapDelta = async (
  state: PlacementSnapshotAuthorityRuntimeState,
  bootstrap: PlacementLedgerBootstrapAuthorityV1,
  approved: ExpectedRevisionV1,
  authoritative: ExpectedRevisionV1,
): Promise<boolean> => {
  if (
    !activePlacementLedgerBootstrapAuthorities.has(bootstrap) ||
    !bootstrap.createdDirectory ||
    approved.domain !== 'ledger' ||
    authoritative.domain !== 'ledger' ||
    approved.state !== 'absent' ||
    authoritative.state !== 'absent' ||
    approved.resourceId !== authoritative.resourceId ||
    approved.targetIdentity !== bootstrap.ledgerPath ||
    authoritative.targetIdentity !== bootstrap.ledgerPath ||
    approved.targetKind !== 'absent' ||
    authoritative.targetKind !== 'absent' ||
    approved.parentIdentity !== bootstrap.ledgerDirectory ||
    authoritative.parentIdentity !== bootstrap.ledgerDirectory ||
    approved.parentKind !== 'absent' ||
    authoritative.parentKind !== 'directory'
  ) {
    return false;
  }
  const metadata = await state.env.readFileMetadata(bootstrap.ledgerDirectory);
  return (
    metadata.kind === 'dir' &&
    authoritative.parentMetadataIdentity ===
      createFilesystemMetadataIdentityV1(bootstrap.ledgerDirectory, metadata, 'parent')
  );
};

/**
 * Recapture one prepared placement authority under the stable ledger-bootstrap lock. Every
 * repository revision must remain exact except the authenticated directory this callback created.
 * The returned authority changes no approved operation, dependency, source, effect, or report.
 */
export const rebindPlacementSnapshotAuthorityForLedgerBootstrapV1 = async (
  approved: PlacementSnapshotAuthority,
  bootstrap: PlacementLedgerBootstrapAuthorityV1,
): Promise<Result<PlacementSnapshotAuthority, SkillSmithError>> => {
  const state = placementSnapshotAuthorityRuntime.get(approved);
  const approvedLedgerRevision = approved.snapshot.ledger.revision;
  if (
    state === undefined ||
    state.revisionRebinding !== null ||
    !activePlacementLedgerBootstrapAuthorities.has(bootstrap) ||
    approvedLedgerRevision.domain !== 'ledger' ||
    bootstrap.ledgerPath !== approvedLedgerRevision.targetIdentity
  ) {
    return err(flipRefusedError('placement ledger bootstrap authority is invalid'));
  }
  const observed = await readObservedStateSnapshotV1(state.snapshotRequest, approved.repositories);
  if (!observed.ok) {
    return err(flipRefusedError('placement state could not be recaptured under ledger authority'));
  }
  const expected = placementSnapshotRevisions(approved.snapshot);
  const actual = new Map(
    placementSnapshotRevisions(observed.value).map((revision) => [
      `${revision.domain}\0${revision.resourceId}`,
      revision,
    ]),
  );
  let revisionRebinding: PlacementSnapshotAuthorityRuntimeState['revisionRebinding'] = null;
  for (const revision of expected) {
    const current = actual.get(`${revision.domain}\0${revision.resourceId}`);
    if (current === undefined) {
      return err(flipRefusedError('placement state changed under ledger bootstrap authority'));
    }
    actual.delete(`${revision.domain}\0${revision.resourceId}`);
    if (sameExpectedRevisionV1(revision, current)) continue;
    if (
      revisionRebinding !== null ||
      !(await exactPlacementLedgerBootstrapDelta(state, bootstrap, revision, current))
    ) {
      return err(flipRefusedError('placement state changed under ledger bootstrap authority'));
    }
    revisionRebinding = Object.freeze({
      approved: revision,
      authoritative: current,
      bootstrap,
    });
  }
  if (actual.size !== 0 || (bootstrap.createdDirectory && revisionRebinding === null)) {
    return err(flipRefusedError('placement state changed under ledger bootstrap authority'));
  }
  const authority: PlacementSnapshotAuthority = {
    ...approved,
    snapshot: observed.value,
  };
  placementSnapshotAuthorityRuntime.set(authority, {
    ...state,
    revisionRebinding,
  });
  return ok(authority);
};

const placementRevisionResource = (
  authority: PlacementSnapshotAuthority,
  revision: ExpectedRevisionV1,
): OperationResourceIdentity => {
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
      (candidate) => candidate.resourceId === revision.resourceId,
    );
    if (store === undefined) throw new Error('placement store revision resource is missing');
    return { kind: 'store', contentHash: store.contentHash };
  }
  if (revision.domain === 'live') {
    const live = authority.liveResources.find(
      (candidate) => candidate.resourceId === revision.resourceId,
    );
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

/** Bind one snapshot-bound placement plan to its exact command-neutral repository observers. */
export const createPlacementRevisionExecutionPreconditionsV1 = (
  authority: PlacementSnapshotAuthority,
  plan: OperationPlan,
  expectedRevisions: readonly ExpectedRevisionV1[],
): readonly ExecutionPrecondition[] => {
  const rebinding = placementSnapshotAuthorityRuntime.get(authority)?.revisionRebinding ?? null;
  const preconditions: ExecutionPrecondition[] = [];
  for (const revision of expectedRevisions) {
    const preconditionId = createExpectedRevisionPreconditionIdV1(revision);
    const operationIds = plan.operations
      .filter((operation) => operation.preconditionIds.includes(preconditionId))
      .map((operation) => operation.operationId);
    if (operationIds.length === 0) continue;
    preconditions.push(
      createExpectedRevisionExecutionPrecondition({
        operationIds,
        resource: placementRevisionResource(authority, revision),
        expectedRevision: revision,
        observeRevision: () =>
          authority.repositories[revision.domain]
            .observeRevision(revision.resourceId)
            .then((observed) => {
              if (!observed.ok) throw observed.error;
              // Preserve the immutable prepared plan's revision identity only for the exact
              // self-change authenticated by the active outer bootstrap authority. Repository
              // staging remains bound to the freshly recaptured authoritative revision.
              if (
                rebinding !== null &&
                activePlacementLedgerBootstrapAuthorities.has(rebinding.bootstrap) &&
                sameExpectedRevisionV1(revision, rebinding.approved) &&
                sameExpectedRevisionV1(observed.value, rebinding.authoritative)
              ) {
                return revision;
              }
              return observed.value;
            }),
      }),
    );
  }
  return Object.freeze(preconditions);
};

const createPlacementRevisionCursor = (authority: PlacementSnapshotAuthority): RevisionCursorV1 =>
  createRevisionCursorV1({
    schemaVersion: 1,
    snapshotId: authority.snapshot.snapshotId,
    expectedRevisions: [
      authority.snapshot.project.revision,
      authority.snapshot.manifest.revision,
      authority.snapshot.lock.revision,
      authority.snapshot.ledger.revision,
      ...authority.snapshot.live.map(({ revision }) => revision),
      ...authority.snapshot.store.map(({ revision }) => revision),
      authority.snapshot.capabilities.revision,
    ],
  });

export const createPlacementLifecycleExecutor = (
  authority: PlacementSnapshotAuthority,
): PlacementLifecycleExecutor => {
  let cursor = createPlacementRevisionCursor(authority);

  const stageOperation = async (
    operation: ExecutableOperation,
    stageResourceIds: readonly string[],
  ): Promise<readonly LogicalRepositoryStageV1[]> => {
    const edit = hashCanonicalInput(
      'resource',
      1,
      JSON.stringify(['skillsmith-placement-stage', 1, operation.operationId]),
    );
    if (!edit.ok) throw new Error('placement stage digest failed');
    const stages: LogicalRepositoryStageV1[] = [];
    for (const resourceId of [...new Set([authority.ledgerResourceId, ...stageResourceIds])]) {
      const expected = cursor.revisions.find((revision) => revision.resourceId === resourceId);
      if (expected === undefined) throw new Error('placement revision cursor resource missing');
      if (
        expected.domain !== 'ledger' &&
        expected.domain !== 'live' &&
        expected.domain !== 'store'
      ) {
        throw new Error('placement mutable repository domain is invalid');
      }
      const staged = await authority.repositories[expected.domain].stage({
        schemaVersion: 1,
        operationId: operation.operationId,
        domain: expected.domain,
        resourceId,
        expectedRevision: expected,
        editDigest: edit.value,
      });
      if (!staged.ok) {
        throw Object.freeze({
          code:
            staged.error.code === 'stale-revision'
              ? 'precondition-state-changed'
              : 'precondition-observation-failed',
          message: 'prepared placement repository stage failed',
        });
      }
      stages.push(staged.value);
    }
    return stages;
  };

  const observeReceipt = async (
    operationId: string,
    stages: readonly LogicalRepositoryStageV1[],
    disposition: 'committed' | 'rolled-back' = 'committed',
  ): Promise<Result<DurabilityReceiptV1, unknown>> => {
    try {
      const revisions = [];
      for (const stage of stages) {
        if (stage.domain !== 'ledger' && stage.domain !== 'live' && stage.domain !== 'store') {
          throw new Error('placement staged repository domain is invalid');
        }
        const observed = await authority.repositories[stage.domain].observeRevision(
          stage.resourceId,
        );
        if (!observed.ok) throw observed.error;
        revisions.push({
          resourceId: stage.resourceId,
          beforeRevision: stage.beforeRevision,
          afterRevision: observed.value,
        });
      }
      return ok({ schemaVersion: 1, operationId, disposition, revisions });
    } catch (error) {
      return err(error);
    }
  };

  return Object.freeze({
    execute: async (
      operation: ExecutableOperation,
      stageResourceIds: readonly string[],
      commit: () => Promise<OperationExecutionResult>,
    ): Promise<OperationExecutionResult> => {
      let value: OperationExecutionResult | undefined;
      let committed = false;
      let commitFailed = false;
      let commitFailure: unknown;
      let mandatoryLedgerReadFailed = false;
      const lifecycle = await executeRepositoryLifecycleV1(cursor, {
        operationId: operation.operationId,
        stage: async () => {
          try {
            return ok(await stageOperation(operation, stageResourceIds));
          } catch (error) {
            return err(error);
          }
        },
        commit: async (stages) => {
          try {
            value = await commit();
            committed = true;
            const observed = await observeReceipt(operation.operationId, stages);
            if (!observed.ok) return observed;
            const unchanged = observed.value.revisions.every((revision) =>
              sameExpectedRevisionV1(revision.beforeRevision, revision.afterRevision),
            );
            return ok({
              ...observed.value,
              disposition:
                (value.outcome === 'failed' || value.outcome === 'cancelled') && unchanged
                  ? 'rolled-back'
                  : 'committed',
            });
          } catch (error) {
            commitFailed = true;
            commitFailure = error;
            mandatoryLedgerReadFailed = safeErrorCode(error) === 'ledger-error';
            return err(error);
          }
        },
        rollback: async (stages) => {
          if (mandatoryLedgerReadFailed) {
            return ok({
              schemaVersion: 1,
              operationId: operation.operationId,
              disposition: 'indeterminate',
              revisions: [],
            });
          }
          const observed = await observeReceipt(operation.operationId, stages);
          if (!observed.ok) return observed;
          const unchanged = observed.value.revisions.every((revision) =>
            sameExpectedRevisionV1(revision.beforeRevision, revision.afterRevision),
          );
          return ok({
            ...observed.value,
            disposition: unchanged ? 'rolled-back' : 'committed',
          });
        },
        cleanup: async () => ok(undefined),
      });
      if (!lifecycle.ok) {
        if (
          committed &&
          lifecycle.error.disposition === 'rolled-back' &&
          lifecycle.error.cursor !== null
        ) {
          cursor = lifecycle.error.cursor as RevisionCursorV1;
          return value as OperationExecutionResult;
        }
        throw lifecycle.error;
      }
      cursor = lifecycle.value.cursor;
      if (commitFailed) throw commitFailure;
      if (!committed) throw new Error('placement lifecycle resolved without a commit result');
      return value as OperationExecutionResult;
    },
  });
};

export interface PlacementOperationExecutionBindingInput {
  readonly operation: ExecutableOperation;
  readonly lifecycle: PlacementLifecycleExecutor;
  readonly stageResourceIds: readonly string[];
  readonly unstartedForce: PreparedExecutionBinding['unstartedForce'];
  readonly observeActualBefore: () => Promise<OperationImage>;
  readonly execute: (
    binding: ValidatedExecutionBinding,
    observation?: ObservationBundle,
  ) => Promise<OperationExecutionResult>;
}

export const createPlacementOperationExecutionBindingV1 = (
  input: PlacementOperationExecutionBindingInput,
): ObservedPreparedExecutionBinding => {
  const operation = input.operation;
  const lifecycle = input.lifecycle;
  const unstartedForce = input.unstartedForce;
  const observeActualBefore = input.observeActualBefore;
  const execute = input.execute;
  if (operation.pairId === null) {
    throw new Error('prepared operation pair identity is missing');
  }
  const stageResourceIds = Object.freeze([...input.stageResourceIds]);
  if (stageResourceIds.some((resourceId) => resourceId.length === 0)) {
    throw new Error('prepared placement stage resource identity is empty');
  }
  if (new Set(stageResourceIds).size !== stageResourceIds.length) {
    throw new Error('prepared placement stage resource identities must be unique');
  }

  return Object.freeze({
    operationId: operation.operationId,
    groupId: operation.groupId,
    pairId: operation.pairId,
    unstartedForce,
    observeActualBefore,
    execute: (binding: ValidatedExecutionBinding, observation?: ObservationBundle) =>
      lifecycle.execute(operation, stageResourceIds, () => execute(binding, observation)),
  });
};

export type PlacementCoordinatorBinding =
  | Readonly<{
      kind: 'external';
      binding: ObservedPreparedExecutionBinding;
    }>
  | Readonly<{
      kind: 'migrate-ledger';
      expectedState: Extract<LedgerReadState, { readonly state: 'present' }>;
    }>
  | Readonly<{
      kind: 'pair';
      stageResourceIds: readonly string[];
    }>;

export interface PlacementOperationPlanExecutionInput {
  readonly env: PlacementPorts;
  readonly ledgerPath: string;
  readonly plan: OperationPlan<'dev' | 'promote' | 'sync' | 'undo'>;
  readonly preconditions: readonly ExecutionPrecondition[];
  readonly authority: PlacementSnapshotAuthority;
  readonly reportOp: FlipOp | 'sync';
  readonly modelNow: () => string;
  readonly journalNow: () => string;
  readonly bindingForOperation: (operation: ExecutableOperation) => PlacementCoordinatorBinding;
  readonly forceForOperation?: (operation: ExecutableOperation) => BoundedForceEffect | null;
  readonly executePair: (
    operation: ExecutableOperation,
    ledger: LedgerModel,
    observation?: ObservationBundle,
    firstPersistenceGuard?: PlacementFirstPersistenceGuard,
  ) => Promise<FlipResult>;
  /**
   * Runs under the coordinator locks after preconditions and bindings have been validated.
   * The returned model is the ledger seed for the first scheduled placement mutation.
   */
  readonly beforeSchedule?: (ledger: LedgerModel) => Promise<PlacementSchedulePreparation>;
  readonly onStarted: (operation: ExecutableOperation, result: FlipResult) => void;
  readonly signal?: AbortSignal;
  readonly observation?: ObservationBundle;
  /** Omit only when an enclosing artifact-pair authority already holds the placement ledger. */
  readonly locks?: readonly ExecutionLockDescriptor[];
}

export interface PlacementSchedulePreparation {
  readonly ledger: LedgerModel;
  readonly publicationGuards: readonly PlacementPublicationGuard[];
}

export interface PlacementFirstPersistenceGuard {
  readonly validate: () => Promise<Result<void, SkillSmithError>>;
  readonly run: <T extends { readonly ok: boolean }>(
    write: () => Promise<T>,
  ) => Promise<Result<T, SkillSmithError>>;
}

const createPlacementFirstPersistenceGuard = (
  guards: readonly PlacementPublicationGuard[],
): PlacementFirstPersistenceGuard => {
  let published = false;
  const validate = async (): Promise<Result<void, SkillSmithError>> => {
    if (published) return ok(undefined);
    for (const guard of guards) {
      const valid = await guard.validate();
      if (!valid.ok) return valid;
    }
    return ok(undefined);
  };
  return Object.freeze({
    validate,
    run: async <T extends { readonly ok: boolean }>(
      write: () => Promise<T>,
    ): Promise<Result<T, SkillSmithError>> => {
      const valid = await validate();
      if (!valid.ok) return valid;
      const written = await write();
      if (written.ok) published = true;
      return ok(written);
    },
  });
};

const operationResultForFlip = (
  operation: ExecutableOperation,
  binding: ValidatedExecutionBinding,
  result: FlipResult,
  reportOp: FlipOp | 'sync',
): OperationExecutionResult => {
  const cancelled = result.reason === 'interrupted' || result.error?.code === 'cancelled';
  const failed = result.action === 'failed' || result.action === 'refused';
  const unchanged = failed || cancelled || result.action === 'noop' || result.action === 'skipped';
  const common = {
    operationId: operation.operationId,
    actualBefore: binding.actualBefore,
    actualAfter: unchanged ? binding.actualBefore : operation.after,
    force:
      binding.unstartedForce === null
        ? null
        : binding.unstartedForce.conflictType === null
          ? binding.unstartedForce
          : { ...binding.unstartedForce, applied: !unchanged },
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

export const executePlacementOperationPlan = async (
  input: PlacementOperationPlanExecutionInput,
): Promise<readonly OperationExecutionResult[]> => {
  let executionLedger: LedgerModel | null = null;
  let firstPersistenceGuard: PlacementFirstPersistenceGuard | undefined;
  const beforeSchedule = input.beforeSchedule;
  const lifecycle = createPlacementLifecycleExecutor(input.authority);
  const placementBindings = input.plan.operations.map((operation) =>
    input.bindingForOperation(operation),
  );
  if (
    beforeSchedule !== undefined &&
    placementBindings.some((binding) => binding.kind === 'migrate-ledger')
  ) {
    throw flipRefusedError('placement cleanup cannot be combined with ledger migration');
  }
  const coordinatorBindings: ObservedPreparedExecutionBinding[] = input.plan.operations.map(
    (operation, index) => {
      const binding = placementBindings[index];
      if (binding === undefined) throw new Error('prepared operation binding is missing');
      if (binding.kind === 'external') return binding.binding;
      if (binding.kind === 'migrate-ledger') {
        const migrationInput = {
          env: input.env,
          ledgerPath: input.ledgerPath,
          operation,
          expectedState: binding.expectedState,
          startedAt: input.journalNow(),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          onMigrated: (model: LedgerModel) => {
            executionLedger = model;
          },
        };
        const migrationBinding = ledgerMigrationExecutionBinding(migrationInput);
        return {
          ...migrationBinding,
          execute: (validatedBinding: ValidatedExecutionBinding, observation?: ObservationBundle) =>
            lifecycle.execute(operation, [], () =>
              observation === undefined
                ? migrationBinding.execute(validatedBinding)
                : ledgerMigrationExecutionBindingObserved(migrationInput, observation).execute(
                    validatedBinding,
                  ),
            ),
        };
      }
      return createPlacementOperationExecutionBindingV1({
        operation,
        lifecycle,
        stageResourceIds: binding.stageResourceIds,
        unstartedForce: input.forceForOperation?.(operation) ?? null,
        observeActualBefore: async (): Promise<OperationImage> => {
          const current = await readLedgerState(input.env, input.ledgerPath);
          if (!current.ok) throw current.error;
          executionLedger = ledgerModelForMutation(current.value, input.modelNow());
          return operation.before;
        },
        execute: async (
          validatedBinding: ValidatedExecutionBinding,
          observation?: ObservationBundle,
        ): Promise<OperationExecutionResult> => {
          const ledger = executionLedger;
          if (ledger === null) throw new Error('validated execution ledger is missing');
          const result = failClosedPlannedNoop(
            operation,
            await input.executePair(operation, ledger, observation, firstPersistenceGuard),
          );
          input.onStarted(operation, result);
          const reread = await readLedgerState(input.env, input.ledgerPath);
          // The durable ledger is the sole composition source after a started operation.
          if (!reread.ok) throw reread.error;
          executionLedger = ledgerModelForMutation(reread.value, input.modelNow());
          return operationResultForFlip(operation, validatedBinding, result, input.reportOp);
        },
      });
    },
  );
  const compatibilityLockPort = {
    withFileLock: async <T>(
      path: string,
      callback: () => Promise<T>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<T> => {
      let callbackThrew = false;
      let callbackError: unknown;
      const locked = await withLedgerLock(
        input.env,
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
  const request = {
    plan: input.plan,
    bindings: coordinatorBindings,
    preconditions: input.preconditions,
    locks:
      input.locks ??
      ([
        {
          rank: 'ledger' as const,
          key: `placements-ledger:${input.ledgerPath}`,
          path: input.ledgerPath,
        },
      ] satisfies readonly ExecutionLockDescriptor[]),
    lockPort: compatibilityLockPort,
    ...(beforeSchedule === undefined
      ? {}
      : {
          beforeSchedule: async (): Promise<void> => {
            let captured = executionLedger;
            if (captured === null) {
              const current = await readLedgerState(input.env, input.ledgerPath);
              if (!current.ok) throw current.error;
              captured = ledgerModelForMutation(current.value, input.modelNow());
            }
            const preparation = await beforeSchedule(captured);
            executionLedger = preparation.ledger;
            firstPersistenceGuard = createPlacementFirstPersistenceGuard(
              preparation.publicationGuards,
            );
            const valid = await firstPersistenceGuard.validate();
            if (!valid.ok) throw valid.error;
            if (input.plan.operations.length !== 0) return;

            const persistence = createLedgerPersistenceGateway(
              input.env,
              input.ledgerPath,
              input.signal,
            );
            const guarded = await firstPersistenceGuard.run(() =>
              persistence.persist(preparation.ledger),
            );
            if (!guarded.ok) throw guarded.error;
            const written = guarded.value;
            if (!written.ok) {
              throw written.error.code === 'cancelled'
                ? written.error
                : flipFailedError(`ledger write failed: ${written.error.code}`);
            }
            executionLedger = written.value.model;
          },
        }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  return input.observation === undefined
    ? executeOperationPlan(request as ExecutionCoordinatorRequest)
    : executeOperationPlanObserved(
        request as ObservedExecutionCoordinatorRequest,
        input.observation,
      );
};

export interface PlacementExecutionInput {
  readonly env: PlacementPorts;
  readonly ledgerPath: string;
  readonly ledger: LedgerModel;
  readonly journalNow: () => string;
  readonly newTransactionId: (ledger: LedgerModel) => string;
  readonly logicalOperation?: ExecutableOperation;
  readonly pauseAt?: JournalPhase;
  readonly signal?: AbortSignal;
  readonly firstPersistenceGuard?: PlacementFirstPersistenceGuard;
}

export const createPlacementExecutionInput = (
  env: PlacementPorts,
  ledgerPath: string,
  ledger: LedgerModel,
  deps: Pick<FlipDeps, 'now' | 'newTxId'>,
  opts: Pick<FlipOptions, 'testPauseAt' | 'signal'>,
  logicalOperation?: ExecutableOperation,
  firstPersistenceGuard?: PlacementFirstPersistenceGuard,
): PlacementExecutionInput => ({
  env,
  ledgerPath,
  ledger,
  journalNow: () => {
    const value = deps.now?.() ?? env.wallNowIso();
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
  },
  newTransactionId: (model) => {
    const candidate = deps.newTxId?.() ?? env.nextId('placement-transaction');
    return model.transactions[candidate] !== undefined ||
      model.history.some((journal) => journal.transactionId === candidate)
      ? `transaction:${logicalOperation?.operationId ?? candidate}`
      : candidate;
  },
  ...(opts.testPauseAt === undefined ? {} : { pauseAt: opts.testPauseAt }),
  ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  ...(logicalOperation === undefined ? {} : { logicalOperation }),
  ...(firstPersistenceGuard === undefined ? {} : { firstPersistenceGuard }),
});

export const createPlacementSwapRequest = (input: PlacementExecutionInput): SwapRequest => {
  const persistence = createLedgerPersistenceGateway(input.env, input.ledgerPath, input.signal);
  return Object.freeze({
    context: Object.freeze({
      env: input.env,
      ...(input.logicalOperation === undefined ? {} : { logicalOperation: input.logicalOperation }),
      ...(input.pauseAt === undefined ? {} : { pauseAt: input.pauseAt }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
    state: Object.freeze({ ledger: input.ledger }),
    effects: Object.freeze({
      persistLedger: async (candidate: LedgerModel) => {
        const guarded =
          input.firstPersistenceGuard === undefined
            ? ok(await persistence.persist(candidate))
            : await input.firstPersistenceGuard.run(() => persistence.persist(candidate));
        if (!guarded.ok) throw guarded.error;
        const written = guarded.value;
        if (!written.ok) {
          return Object.freeze({
            ok: false as const,
            error:
              written.error.code === 'cancelled'
                ? written.error
                : flipFailedError(`ledger write failed: ${written.error.code}`),
            ledger: written.acknowledgedModel ?? input.ledger,
          });
        }
        return Object.freeze({ ok: true as const, ledger: written.value.model });
      },
      journalNow: input.journalNow,
      newTransactionId: input.newTransactionId,
    }),
  });
};

export const executePlacementPlan = (
  input: PlacementExecutionInput,
  plan: SwapPlan,
): Promise<SwapExecutionResult<SwapOutcome>> => runSwap(createPlacementSwapRequest(input), plan);

export const executePlacementPlanObserved = (
  input: PlacementExecutionInput,
  plan: SwapPlan,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  runSwapObserved(createPlacementSwapRequest(input), plan, observation);

export const executePlacementPlanWithObservation = (
  input: PlacementExecutionInput,
  plan: SwapPlan,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  observation === undefined
    ? executePlacementPlan(input, plan)
    : executePlacementPlanObserved(input, plan, observation);

/** Atomically publish and execute a fresh reversal of one committed placement transaction. */
export const executeCommittedPlacementReversal = (
  input: PlacementExecutionInput,
  sourceTransactionId: string,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  runCommittedPlacementReversal(createPlacementSwapRequest(input), sourceTransactionId);

export const executeCommittedPlacementReversalObserved = (
  input: PlacementExecutionInput,
  sourceTransactionId: string,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  runCommittedPlacementReversalObserved(
    createPlacementSwapRequest(input),
    sourceTransactionId,
    observation,
  );

export const executeCommittedPlacementReversalWithObservation = (
  input: PlacementExecutionInput,
  sourceTransactionId: string,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  observation === undefined
    ? executeCommittedPlacementReversal(input, sourceTransactionId)
    : executeCommittedPlacementReversalObserved(input, sourceTransactionId, observation);

export const executePlacementPlans = async (
  input: PlacementExecutionInput,
  plans: readonly SwapPlan[],
): Promise<SwapExecutionResult<readonly SwapOutcome[]>> => {
  let request = createPlacementSwapRequest(input);
  const outcomes: SwapOutcome[] = [];
  for (const plan of plans) {
    const executed = await runSwap(request, plan);
    if (!executed.ok) return executed;
    outcomes.push(executed.value);
    request = Object.freeze({ ...request, state: executed.state });
  }
  return Object.freeze({ ok: true, value: Object.freeze(outcomes), state: request.state });
};

export const executePlacementPlansObserved = async (
  input: PlacementExecutionInput,
  plans: readonly SwapPlan[],
  observation: ObservationBundle,
): Promise<SwapExecutionResult<readonly SwapOutcome[]>> => {
  let request = createPlacementSwapRequest(input);
  const outcomes: SwapOutcome[] = [];
  for (const plan of plans) {
    const executed = await runSwapObserved(request, plan, observation);
    if (!executed.ok) return executed;
    outcomes.push(executed.value);
    request = Object.freeze({ ...request, state: executed.state });
  }
  return Object.freeze({ ok: true, value: Object.freeze(outcomes), state: request.state });
};

export const executeRecordOnlyPlacementPlan = (
  input: PlacementExecutionInput,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null = null,
): Promise<SwapExecutionResult<void>> =>
  commitRecordOnlyLogicalTransaction(createPlacementSwapRequest(input), operation, pair, scopeKey);

export const executeRecordOnlyPlacementPlanObserved = (
  input: PlacementExecutionInput,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<void>> =>
  commitRecordOnlyLogicalTransactionObserved(
    createPlacementSwapRequest(input),
    operation,
    pair,
    scopeKey,
    observation,
  );

export const executeRecordOnlyPlacementPlanWithObservation = (
  input: PlacementExecutionInput,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<void>> =>
  observation === undefined
    ? executeRecordOnlyPlacementPlan(input, operation, pair, scopeKey)
    : executeRecordOnlyPlacementPlanObserved(input, operation, pair, scopeKey, observation);

export const mapPlacementExecutionError = (
  result: SwapExecutionResult<unknown>,
): SkillSmithError | null => (result.ok ? null : result.error);
