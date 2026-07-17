import { join, resolve } from 'node:path';
import type { RegisteredPlacementBundle, SkillRootsCtx } from '../agents/adapter-types.ts';
import type {
  RelevantCapabilityQueryV1,
  RelevantCapabilitySnapshotV1,
} from '../agents/capabilities.ts';
import { type Placement, classifyPlacement } from '../agents/placement-shared.ts';
import type { LifecycleToolRegistry } from '../agents/registry.ts';
import {
  type ArtifactDiscoveryError,
  type ArtifactDiscoveryPorts,
  type ArtifactDiscoverySnapshot,
  type ManifestDestination,
  discoverArtifactSnapshot,
  selectManifestDestination,
} from '../artifacts/discovery.ts';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import { createLedgerRepository } from '../artifacts/ledger-repository.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import type { LedgerWriterPorts } from '../artifacts/ledger-writer.ts';
import {
  type ArtifactPairError,
  type ArtifactPairPorts,
  type ResolvedArtifactPair,
  resolveArtifactPair,
} from '../artifacts/pair.ts';
import { createLockRepository, createManifestRepository } from '../artifacts/repository.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import { type SkillSmithError, flipFailedError, genericError, safeErrorCode } from '../errors.ts';
import {
  type DurabilityReceiptV1,
  type ObservedExecutionCoordinatorRequest,
  type RevisionCursorV1,
  createRevisionCursorV1,
  executeOperationPlan,
  executeOperationPlanObserved,
  executeRepositoryLifecycleV1,
} from '../execution/coordinator.ts';
import {
  beginToolDetectionObservation,
  completeToolDetectionObservation,
  emitOperationPlanCreated,
} from '../execution/observation.ts';
import { createExpectedRevisionExecutionPrecondition } from '../execution/preconditions.ts';
import type {
  ExecutionCoordinatorRequest,
  ExecutionPrecondition,
  PreparedExecutionBinding,
  ValidatedExecutionBinding,
} from '../execution/types.ts';
import type { ObservationBundle } from '../observation/index.ts';
import {
  type PlacementExecutionInput,
  executePlacementPlan,
  executePlacementPlanObserved,
  executePlacementPlans,
  executePlacementPlansObserved,
  executeRecordOnlyPlacementPlan,
  executeRecordOnlyPlacementPlanWithObservation,
} from '../place/execute.ts';
import {
  ledgerMigrationExecutionBinding,
  ledgerMigrationExecutionBindingObserved,
} from '../place/ledger-migration.ts';
import { readLedgerState } from '../place/ledger.ts';
import {
  type LivePlacementResourceV1,
  createLivePlacementRepository,
} from '../place/live-repository.ts';
import {
  type PlacementRecoveryTarget,
  recoverCommittedAcquirePlacements,
  recoverCommittedAcquirePlacementsObserved,
  recoverPlacement,
  recoverPlacementObserved,
} from '../place/recovery.ts';
import { type StoreResourceV1, createStoreRepository } from '../place/store-repository.ts';
import { type SnapshotResult, contentHashOf } from '../place/store.ts';
import type {
  FlipTool,
  OriginRecord,
  PairRecord,
  PinnedRecord,
  PlacementPorts,
  SwapExecutionResult,
  SwapOutcome,
  SwapPlan,
} from '../place/types.ts';
import { createOperationExecutionResult } from '../planning/create.ts';
import type {
  ExecutableOperation,
  OperationDigest,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
  OperationResourceIdentity,
} from '../planning/types.ts';
import type { LockPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { readObservedStateSnapshotV1 } from '../state/read.ts';
import {
  type LogicalRepositoryStageV1,
  type ObservedStateRepositoriesV1,
  createProjectStateReaderV1,
  createRelevantCapabilityStateReaderV1,
} from '../state/repositories.ts';
import {
  type ContentObservationIdentityV1,
  type ExpectedRevisionV1,
  type ObservedComponentV1,
  type StateDomainV1,
  createContentObservationIdentityV1,
  isExpectedRevisionV1,
  sameExpectedRevisionV1,
} from '../state/types.ts';
import type { AcquisitionObservedStateSnapshotV1 } from './plan.ts';
import type {
  AcquisitionArtifactSelection,
  AcquisitionPorts,
  InstallDeps,
  InstallOptions,
  InstallScope,
  SourceSpec,
  UninstallOptions,
} from './types.ts';

export type AcquireExecutionInput = PlacementExecutionInput;

type AcquisitionArtifactDestinationPortsV1 = ArtifactDiscoveryPorts & ArtifactPairPorts;

interface ResolveAcquisitionArtifactDestinationInputV1 {
  readonly ports: AcquisitionArtifactDestinationPortsV1;
  readonly projectContext: ProjectContext;
  readonly names: readonly string[];
  readonly scope: InstallScope;
  readonly mode: 'save' | 'remove';
  readonly file?: string;
  readonly lockfile?: string;
  readonly noSave?: boolean;
}

type SelectedAcquisitionArtifactSelection = Extract<
  AcquisitionArtifactSelection,
  Readonly<{ outcome: 'selected' }>
>;
type RefusedAcquisitionArtifactSelection = Extract<
  AcquisitionArtifactSelection,
  Readonly<{ outcome: 'refused' }>
>;

type LiveOnlyAcquisitionArtifactSelection = Readonly<{
  outcome: 'none';
  reason: 'no-save';
}>;
type DesiredStateNoneAcquisitionArtifactSelection = Readonly<{
  outcome: 'none';
  reason: 'no-owner' | 'pre-resolution-failure';
}>;
type AcquisitionArtifactDestinationRefusalCauseV1 =
  | Readonly<{
      kind: 'discovery';
      code: ArtifactDiscoveryError['code'];
      message: string;
      exitClass: ArtifactDiscoveryError['exitClass'];
      paths?: readonly string[];
    }>
  | Readonly<{
      kind: 'pair';
      code: ArtifactPairError['code'];
      message: string;
      exitClass: ArtifactPairError['exitClass'];
      paths?: readonly string[];
    }>;

type AcquisitionArtifactDestinationResolutionV1 =
  | Readonly<{
      outcome: 'selected';
      saveMode: 'desired-state';
      pair: ResolvedArtifactPair;
      selection: SelectedAcquisitionArtifactSelection;
    }>
  | Readonly<{
      outcome: 'none';
      saveMode: 'live-only';
      pair: null;
      selection: LiveOnlyAcquisitionArtifactSelection;
    }>
  | Readonly<{
      outcome: 'none';
      saveMode: 'desired-state';
      pair: null;
      selection: DesiredStateNoneAcquisitionArtifactSelection;
    }>
  | Readonly<{
      outcome: 'refused';
      saveMode: 'desired-state';
      pair: null;
      selection: RefusedAcquisitionArtifactSelection;
      cause: AcquisitionArtifactDestinationRefusalCauseV1;
    }>;

const liveOnlyArtifactDestination = (): AcquisitionArtifactDestinationResolutionV1 =>
  Object.freeze({
    outcome: 'none' as const,
    saveMode: 'live-only' as const,
    pair: null,
    selection: Object.freeze({ outcome: 'none' as const, reason: 'no-save' as const }),
  });

const desiredStateWithoutArtifact = (
  reason: DesiredStateNoneAcquisitionArtifactSelection['reason'],
): AcquisitionArtifactDestinationResolutionV1 =>
  Object.freeze({
    outcome: 'none' as const,
    saveMode: 'desired-state' as const,
    pair: null,
    selection: Object.freeze({ outcome: 'none' as const, reason }),
  });

const refusalCandidates = (paths: readonly string[] | undefined): string[] => [
  ...new Set(paths ?? []),
];

const frozenCausePaths = (paths: readonly string[]): readonly string[] => Object.freeze([...paths]);

const discoveryCause = (
  error: ArtifactDiscoveryError,
): AcquisitionArtifactDestinationRefusalCauseV1 =>
  Object.freeze({
    kind: 'discovery' as const,
    code: error.code,
    message: error.message,
    exitClass: error.exitClass,
    ...(error.paths === undefined ? {} : { paths: frozenCausePaths(error.paths) }),
  });

const pairCause = (error: ArtifactPairError): AcquisitionArtifactDestinationRefusalCauseV1 =>
  Object.freeze({
    kind: 'pair' as const,
    code: error.code,
    message: error.message,
    exitClass: error.exitClass,
    ...(error.paths === undefined ? {} : { paths: frozenCausePaths(error.paths) }),
  });

const refusedArtifactDestination = (
  reason: RefusedAcquisitionArtifactSelection['reason'],
  cause: AcquisitionArtifactDestinationRefusalCauseV1,
): AcquisitionArtifactDestinationResolutionV1 =>
  Object.freeze({
    outcome: 'refused' as const,
    saveMode: 'desired-state' as const,
    pair: null,
    selection: Object.freeze({
      outcome: 'refused' as const,
      reason,
      candidates: refusalCandidates(cause.paths),
    }),
    cause,
  });

const discoveryRefusal = (
  error: ArtifactDiscoveryError,
): AcquisitionArtifactDestinationResolutionV1 =>
  refusedArtifactDestination(
    error.code === 'manifest-owner-ambiguous'
      ? 'ambiguous-owner'
      : error.code === 'manifest-owner-split'
        ? 'split-owner'
        : 'invalid-candidate',
    discoveryCause(error),
  );

const pairRefusal = (error: ArtifactPairError): AcquisitionArtifactDestinationResolutionV1 =>
  refusedArtifactDestination(
    error.code === 'artifact-selector-nonportable' || error.code === 'artifact-selector-escape'
      ? 'nonportable-path'
      : 'invalid-candidate',
    pairCause(error),
  );

const automaticUserLegacyError = (path: string): ArtifactDiscoveryError =>
  Object.freeze({
    code: 'manifest-candidate-invalid' as const,
    exitClass: 'state' as const,
    message: `automatic user manifest candidate cannot use the project-only legacy migration: ${path}`,
    paths: Object.freeze([path]),
  });

const selectedByForDestination = (
  snapshot: ArtifactDiscoverySnapshot,
  destination: ManifestDestination,
): SelectedAcquisitionArtifactSelection['selectedBy'] => {
  if (
    destination.role === 'explicit' ||
    (destination.kind === 'absent' && snapshot.explicitArtifactPath !== null)
  ) {
    return 'explicit-file';
  }
  const selectedCandidate =
    destination.path === null
      ? undefined
      : snapshot.candidates.find((candidate) => candidate.path === destination.path);
  if (selectedCandidate?.shape === 'legacy') return 'legacy-project-migration';

  const ownsRequestedName =
    selectedCandidate !== undefined &&
    destination.names.some((name) => selectedCandidate.declaredNames.includes(name));
  if (ownsRequestedName) {
    if (destination.role === 'selected-project') return 'selected-project-owner';
    if (destination.role === 'project-root') return 'project-root-owner';
    if (destination.role === 'user') return 'user-owner';
  }
  return destination.role === 'user' ? 'new-user' : 'new-project';
};

/** Resolve one acquisition destination without introducing a second discovery or pair authority. */
export const resolveAcquisitionArtifactDestinationV1 = async (
  input: ResolveAcquisitionArtifactDestinationInputV1,
): Promise<AcquisitionArtifactDestinationResolutionV1> => {
  if (input.noSave === true) return liveOnlyArtifactDestination();

  if (
    input.names.length === 0 ||
    input.names.some((name) => name.length === 0) ||
    new Set(input.names).size !== input.names.length
  ) {
    return desiredStateWithoutArtifact('pre-resolution-failure');
  }

  const discovered = await discoverArtifactSnapshot(input.ports, input.projectContext, {
    ...(input.file === undefined ? {} : { explicitFile: input.file }),
    ...(input.scope === 'project' ? { explicitProjectScope: true } : {}),
  });
  if (!discovered.ok) return discoveryRefusal(discovered.error);

  const automaticUserLegacy =
    input.file === undefined
      ? discovered.value.candidates.find(
          (candidate) => candidate.role === 'user' && candidate.shape === 'legacy',
        )
      : undefined;
  if (automaticUserLegacy !== undefined) {
    return discoveryRefusal(automaticUserLegacyError(automaticUserLegacy.path));
  }

  const destination = selectManifestDestination(discovered.value, {
    names: input.names,
    scope: input.scope,
    mode: input.mode,
    ...(input.file === undefined ? {} : { explicitFile: input.file }),
  });
  if (!destination.ok) return discoveryRefusal(destination.error);

  const explicitAbsentRemove =
    input.mode === 'remove' && destination.value.kind === 'absent' && input.file !== undefined;
  if (destination.value.kind === 'absent' && !explicitAbsentRemove) {
    return desiredStateWithoutArtifact('no-owner');
  }

  const pair = await resolveArtifactPair(
    input.ports,
    input.projectContext,
    input.file === undefined
      ? {
          discoveredFile: destination.value.path,
          ...(input.lockfile === undefined ? {} : { lockfile: input.lockfile }),
        }
      : {
          file: input.file,
          ...(input.lockfile === undefined ? {} : { lockfile: input.lockfile }),
        },
  );
  if (!pair.ok) return pairRefusal(pair.error);

  return Object.freeze({
    outcome: 'selected' as const,
    saveMode: 'desired-state' as const,
    pair: pair.value,
    selection: Object.freeze({
      outcome: 'selected' as const,
      selectedBy: selectedByForDestination(discovered.value, destination.value),
    }),
  });
};

export type AcquisitionSnapshotArtifactAuthorityV1 =
  | Readonly<{ mode: 'selected'; pair: ResolvedArtifactPair }>
  | Readonly<{ mode: 'none' }>;

export const acquisitionSnapshotArtifactAuthorityV1 = (
  resolution: AcquisitionArtifactDestinationResolutionV1,
): AcquisitionSnapshotArtifactAuthorityV1 => {
  if (resolution.outcome === 'selected') {
    return Object.freeze({ mode: 'selected' as const, pair: resolution.pair });
  }
  if (resolution.outcome === 'none' && resolution.selection.reason !== 'pre-resolution-failure') {
    return Object.freeze({ mode: 'none' as const });
  }
  throw new Error('acquisition snapshot requires selected or artifact-free snapshot authority');
};

export const detectAcquireTool = (
  env: AcquisitionPorts,
  tool: FlipTool,
  signal: AbortSignal | undefined,
  deps: InstallDeps,
  defaultDetect: InstallDeps['detect'],
  registry: LifecycleToolRegistry<string>,
): ReturnType<InstallDeps['detect']> => {
  if (deps.detect !== defaultDetect) return deps.detect(env, tool, signal);
  const inventory = registry.get(tool)?.inventory;
  return inventory === undefined ? deps.detect(env, tool, signal) : inventory.detect(env, signal);
};

export const detectAcquireToolObserved = async (
  env: AcquisitionPorts,
  tool: FlipTool,
  signal: AbortSignal | undefined,
  deps: InstallDeps,
  defaultDetect: InstallDeps['detect'],
  registry: LifecycleToolRegistry<string>,
  observation: ObservationBundle,
): Promise<Awaited<ReturnType<InstallDeps['detect']>>> => {
  const span = beginToolDetectionObservation(observation, tool);
  try {
    const detected = await detectAcquireTool(env, tool, signal, deps, defaultDetect, registry);
    completeToolDetectionObservation(
      observation,
      span,
      detected.ok ? 'success' : 'failure',
      detected.ok ? null : (safeErrorCode(detected.error) ?? 'generic'),
      detected.ok ? detected.value.length : 0,
    );
    return detected;
  } catch (error) {
    completeToolDetectionObservation(
      observation,
      span,
      'failure',
      safeErrorCode(error) ?? 'generic',
      0,
    );
    throw error;
  }
};

export const detectAcquireToolWithObservation = (
  env: AcquisitionPorts,
  tool: FlipTool,
  signal: AbortSignal | undefined,
  deps: InstallDeps,
  defaultDetect: InstallDeps['detect'],
  registry: LifecycleToolRegistry<string>,
  observation?: ObservationBundle,
): ReturnType<InstallDeps['detect']> =>
  observation === undefined
    ? detectAcquireTool(env, tool, signal, deps, defaultDetect, registry)
    : detectAcquireToolObserved(env, tool, signal, deps, defaultDetect, registry, observation);

export interface AcquirePlacementFacts {
  readonly pathKind: 'absent' | 'file' | 'dir' | 'symlink';
  readonly canonicalPath: string;
  readonly placement: Placement;
  readonly contentHash: string | null;
}

export interface AcquireContentFacts {
  readonly path: string;
  readonly pathKind: 'absent' | 'file' | 'dir' | 'symlink';
  readonly contentHash: string | null;
}

export const acquireContentFacts = async (
  env: AcquisitionPorts,
  path: string,
): Promise<AcquireContentFacts> => {
  const pathKind = await env.pathKind(path);
  const hash = pathKind === 'dir' ? await contentHashOf(env, path) : null;
  if (hash !== null && !hash.ok) throw hash.error;
  return { path: resolve(path), pathKind, contentHash: hash?.value ?? null };
};

export const acquireContentObservationIdentity = (
  resourceId: string,
  facts: AcquireContentFacts,
): ContentObservationIdentityV1 => {
  if (facts.pathKind !== 'dir' || facts.contentHash === null) {
    throw new Error('acquisition materialized source is not a content-addressed directory');
  }
  return createContentObservationIdentityV1({
    schemaVersion: 1,
    resourceId,
    targetIdentity: facts.path,
    targetKind: 'directory',
    contentRevision: facts.contentHash,
  });
};

export const acquirePlacementFacts = async (
  env: AcquisitionPorts,
  root: string,
  skill: string,
  storeRoot: string,
): Promise<AcquirePlacementFacts> => {
  const path = join(root, skill);
  const [pathKind, placement] = await Promise.all([
    env.pathKind(path),
    classifyPlacement(env, root, skill, storeRoot),
  ]);
  const hash = pathKind === 'dir' ? await contentHashOf(env, path) : null;
  if (hash !== null && !hash.ok) throw hash.error;
  return {
    pathKind,
    canonicalPath: resolve(path),
    placement,
    contentHash: hash?.value ?? null,
  };
};

export const acquireActualBefore = (
  resource: Extract<OperationImage, { kind: 'placement' }>['resource'],
  facts: AcquirePlacementFacts,
  pair: PairRecord | null,
): OperationImage => {
  if (facts.placement.class === 'absent') return { kind: 'absent', resource };
  const representation =
    facts.pathKind === 'symlink' ? 'symlink' : facts.pathKind === 'dir' ? 'copy' : 'other';
  return {
    kind: 'placement',
    resource,
    classification: pair === null ? 'unmanaged' : facts.placement.class,
    representation,
    linkTarget:
      facts.placement.symlinkTarget === null
        ? null
        : { kind: 'machine-bound', path: facts.placement.symlinkTarget },
    dangling: facts.placement.dangling,
    source: null,
    contentHash: null,
  };
};

export const acquisitionPreconditionStateChanged = (error: unknown): boolean =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  (error.code === 'precondition-state-changed' || error.code === 'precondition-observation-failed');

export const createAcquireExecutionInput = (
  env: AcquisitionPorts,
  ledgerPath: string,
  ledger: LedgerModel,
  effects: readonly [journalNow: () => string, newTransactionId: () => string],
  opts: Pick<InstallOptions | UninstallOptions, 'testPauseAt' | 'signal'>,
  logicalOperation: ExecutableOperation | null,
): AcquireExecutionInput => ({
  env,
  ledgerPath,
  ledger,
  journalNow: effects[0],
  newTransactionId: effects[1],
  ...(opts.testPauseAt === undefined ? {} : { pauseAt: opts.testPauseAt }),
  ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  ...(logicalOperation === null ? {} : { logicalOperation }),
});

const ledgerVerificationState = (
  gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive',
): 'passed' | 'warned' | 'skipped' =>
  gate === 'passed' ? 'passed' : gate === 'warned' ? 'warned' : 'skipped';

export const createAcquisitionPinnedRecord = (
  snapshot: SnapshotResult,
  sha: string,
  placement: 'symlink' | 'copy',
  gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive',
  now: string,
): PinnedRecord => ({
  storePath: snapshot.storePath,
  rev: sha.slice(0, 12),
  gitSha: sha,
  dirty: false,
  contentHash: snapshot.contentHash,
  snapshotAt: now,
  verify: ledgerVerificationState(gate),
  placement,
});

export const createAcquisitionOriginRecord = (
  source: SourceSpec,
  sha: string,
  skillPath: string,
  pin: boolean,
  now: string,
): OriginRecord => ({
  source: source.originSource,
  host: source.identity.host,
  repo: source.identity.repository,
  skillPath,
  refRequested: source.ref,
  refResolved: sha,
  pin,
  installedAt: now,
});

export const executeAcquireReplacement = async (
  input: AcquireExecutionInput,
  plan: SwapPlan,
  intermediatePinned: PinnedRecord | null,
): Promise<SwapExecutionResult<void>> => {
  const install = plan.install;
  if (install === undefined) {
    return {
      ok: false,
      error: genericError('install plan missing install payload'),
      state: { ledger: input.ledger },
    };
  }
  const executed =
    intermediatePinned === null
      ? await executePlacementPlan(input, plan)
      : await executePlacementPlans(input, [
          {
            ...plan,
            install: {
              ...install,
              build: 'symlink',
              pinned: intermediatePinned,
              adoptedDev: null,
            },
          },
          plan,
        ]);
  return executed.ok
    ? { ok: true, value: undefined, state: executed.state }
    : { ok: false, error: executed.error, state: executed.state };
};

export const executeAcquireReplacementObserved = async (
  input: AcquireExecutionInput,
  plan: SwapPlan,
  intermediatePinned: PinnedRecord | null,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<void>> => {
  const install = plan.install;
  if (install === undefined) {
    return {
      ok: false,
      error: genericError('install plan missing install payload'),
      state: { ledger: input.ledger },
    };
  }
  const executed =
    intermediatePinned === null
      ? await executePlacementPlanObserved(input, plan, observation)
      : await executePlacementPlansObserved(
          input,
          [
            {
              ...plan,
              install: {
                ...install,
                build: 'symlink',
                pinned: intermediatePinned,
                adoptedDev: null,
              },
            },
            plan,
          ],
          observation,
        );
  return executed.ok
    ? { ok: true, value: undefined, state: executed.state }
    : { ok: false, error: executed.error, state: executed.state };
};

export const executeAcquireReplacementWithObservation = (
  input: AcquireExecutionInput,
  plan: SwapPlan,
  intermediatePinned: PinnedRecord | null,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<void>> =>
  observation === undefined
    ? executeAcquireReplacement(input, plan, intermediatePinned)
    : executeAcquireReplacementObserved(input, plan, intermediatePinned, observation);

export const verificationRegistryFor = (registry: LifecycleToolRegistry<string>) =>
  Object.freeze({
    adapters: Object.freeze(
      registry.ids.flatMap((id) => {
        const adapter = registry.get(id);
        return adapter === undefined ? [] : [adapter];
      }),
    ),
    ids: registry.ids,
    get: (id: string) => registry.get(id),
    toolsFor: (operation: Parameters<LifecycleToolRegistry<string>['toolsFor']>[0]) =>
      registry.toolsFor(operation),
  });

export const placementBundleFor = (
  registry: LifecycleToolRegistry<string>,
  tool: FlipTool,
): RegisteredPlacementBundle => {
  const placement = registry.get(tool)?.placement;
  if (placement === undefined) throw new Error(`tool registry invariant: ${tool} has no placement`);
  return placement;
};

export const skillRootFactsFor = (
  registry: LifecycleToolRegistry<string>,
  tool: FlipTool,
  env: PlacementPorts,
  scope: InstallScope,
  ctx: SkillRootsCtx,
): ReturnType<RegisteredPlacementBundle['rootFacts']> =>
  placementBundleFor(registry, tool).rootFacts(env, scope, ctx);

export const destinationSkillRootFor = (
  registry: LifecycleToolRegistry<string>,
  tool: FlipTool,
  env: PlacementPorts,
  scope: InstallScope,
  ctx: SkillRootsCtx,
): string => {
  const destination = skillRootFactsFor(registry, tool, env, scope, ctx).find(
    ({ role }) => role === 'destination',
  );
  if (destination === undefined) {
    throw new Error(`tool registry invariant: ${tool} has no ${scope} destination root`);
  }
  return destination.path;
};

export const resolvePlacementFor = (
  registry: LifecycleToolRegistry<string>,
  tool: FlipTool,
  env: PlacementPorts,
  scope: InstallScope,
  ctx: SkillRootsCtx,
  storeRoot: string,
  skill: string,
) => placementBundleFor(registry, tool).resolveScoped(env, ctx, storeRoot, skill, scope);

export interface AcquireStoreSnapshotResourceV1 {
  readonly resource: StoreResourceV1;
  readonly contentHash: OperationDigest;
}

export interface AcquireLiveSnapshotResourceV1 extends LivePlacementResourceV1 {
  readonly tool: FlipTool;
  readonly scope: InstallScope;
}

type AcquisitionCommonSnapshotRepositoriesV1 = Pick<
  ObservedStateRepositoriesV1<RelevantCapabilitySnapshotV1>,
  'project' | 'ledger' | 'live' | 'store' | 'capabilities'
>;

type AcquisitionArtifactSnapshotRepositoriesV1 =
  | Readonly<{
      mode: 'selected';
      manifest: ObservedStateRepositoriesV1['manifest'];
      lock: ObservedStateRepositoriesV1['lock'];
    }>
  | Readonly<{ mode: 'none' }>;

export type AcquisitionSnapshotRepositoriesV1 = AcquisitionCommonSnapshotRepositoriesV1 &
  Readonly<{ artifact: AcquisitionArtifactSnapshotRepositoriesV1 }>;

export interface AcquisitionSnapshotAuthorityV1 {
  readonly snapshot: AcquisitionObservedStateSnapshotV1<RelevantCapabilitySnapshotV1>;
  readonly repositories: AcquisitionSnapshotRepositoriesV1;
  readonly projectContext: ProjectContext;
  readonly ledgerResourceId: string;
  readonly liveResources: ReadonlyMap<string, AcquireLiveSnapshotResourceV1>;
  readonly storeResources: ReadonlyMap<string, AcquireStoreSnapshotResourceV1>;
}

export const acquireStateResourceId = (
  domain: 'project' | 'manifest' | 'lock' | 'ledger' | 'live' | 'store' | 'capabilities',
  identity: readonly unknown[],
): string => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-acquire-state-resource', 1, domain, identity]),
  );
  if (!hashed.ok) throw new Error('acquire state resource identity invariant failed');
  return `acquire-${domain}:v1:${hashed.value.slice('sha256:'.length)}`;
};

const sameProjectContext = (left: ProjectContext, right: ProjectContext): boolean =>
  left.invocationCwd === right.invocationCwd &&
  left.effectiveCwd === right.effectiveCwd &&
  left.projectRoot === right.projectRoot &&
  left.projectIdentity === right.projectIdentity &&
  left.projectKind === right.projectKind &&
  left.discoveredConfigPath === right.discoveredConfigPath &&
  left.explicitConfigPath === right.explicitConfigPath;

export const resolveAcquisitionProjectContextV1 = async (input: {
  readonly env: PlacementPorts;
  readonly cwd: string;
  readonly explicitConfigPath?: string;
}): Promise<ProjectContext> => {
  const resolved = await resolveProjectContext(input.env, {
    invocationCwd: input.cwd,
    ...(input.explicitConfigPath === undefined
      ? {}
      : { explicitConfigPath: input.explicitConfigPath }),
  });
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
};

type AcquisitionCommonSnapshotDomainV1 = Extract<
  StateDomainV1,
  'project' | 'ledger' | 'live' | 'store' | 'capabilities'
>;

interface AcquisitionCommonSnapshotDescriptorV1 {
  readonly domain: AcquisitionCommonSnapshotDomainV1;
  readonly resourceId: string;
}

const acquisitionCommonRepository = (
  repositories: AcquisitionCommonSnapshotRepositoriesV1,
  domain: AcquisitionCommonSnapshotDomainV1,
) => {
  if (domain === 'project') return repositories.project;
  if (domain === 'ledger') return repositories.ledger;
  if (domain === 'live') return repositories.live;
  if (domain === 'store') return repositories.store;
  return repositories.capabilities;
};

const acquisitionSnapshotId = (
  descriptors: readonly Readonly<{ domain: StateDomainV1; resourceId: string }>[],
  observations: readonly ObservedComponentV1<unknown>[],
): `snapshot:v1:${string}` => {
  const vector = descriptors.map((descriptor, index) => {
    const revision = observations[index]?.revision;
    if (revision === undefined) throw new Error('acquisition snapshot vector invariant failed');
    return [descriptor.domain, descriptor.resourceId, revision.state, revision.revisionDigest];
  });
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-acquisition-state-snapshot', 1, ['artifact', 'none'], vector]),
  );
  if (!hashed.ok) throw new Error('acquisition snapshot identity invariant failed');
  return `snapshot:v1:${hashed.value.slice('sha256:'.length)}`;
};

const readArtifactFreeAcquisitionSnapshotV1 = async (input: {
  readonly repositories: AcquisitionCommonSnapshotRepositoriesV1;
  readonly projectResourceId: string;
  readonly ledgerResourceId: string;
  readonly liveResourceIds: readonly string[];
  readonly storeResourceIds: readonly string[];
  readonly capabilitiesResourceId: string;
}): Promise<AcquisitionObservedStateSnapshotV1<RelevantCapabilitySnapshotV1>> => {
  const live = [...input.liveResourceIds].sort();
  const store = [...input.storeResourceIds].sort();
  const descriptors: readonly AcquisitionCommonSnapshotDescriptorV1[] = Object.freeze([
    { domain: 'project', resourceId: input.projectResourceId },
    { domain: 'ledger', resourceId: input.ledgerResourceId },
    ...live.map((resourceId) => ({ domain: 'live' as const, resourceId })),
    ...store.map((resourceId) => ({ domain: 'store' as const, resourceId })),
    { domain: 'capabilities', resourceId: input.capabilitiesResourceId },
  ]);
  if (
    descriptors.some(({ resourceId }) => resourceId.length === 0) ||
    new Set(descriptors.map(({ resourceId }) => resourceId)).size !== descriptors.length
  ) {
    throw new Error('acquisition snapshot resource identity is invalid');
  }

  const observations: ObservedComponentV1<unknown>[] = [];
  for (const descriptor of descriptors) {
    const observed = await acquisitionCommonRepository(
      input.repositories,
      descriptor.domain,
    ).observe(descriptor.resourceId);
    if (!observed.ok) throw observed.error;
    observations.push(observed.value);
  }
  for (const [index, descriptor] of descriptors.entries()) {
    const observed = observations[index];
    const revision = await acquisitionCommonRepository(
      input.repositories,
      descriptor.domain,
    ).observeRevision(descriptor.resourceId);
    if (
      observed === undefined ||
      !revision.ok ||
      !isExpectedRevisionV1(observed.revision) ||
      !isExpectedRevisionV1(revision.value) ||
      observed.revision.domain !== descriptor.domain ||
      observed.revision.resourceId !== descriptor.resourceId ||
      revision.value.domain !== descriptor.domain ||
      revision.value.resourceId !== descriptor.resourceId ||
      (observed.revision.state === 'absent') !== (observed.value === null) ||
      !sameExpectedRevisionV1(observed.revision, revision.value)
    ) {
      if (!revision.ok) throw revision.error;
      throw new Error('acquisition snapshot observation changed or is invalid');
    }
  }

  const liveStart = 2;
  const storeStart = liveStart + live.length;
  const capabilitiesIndex = storeStart + store.length;
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: acquisitionSnapshotId(descriptors, observations),
    project: observations[0] as AcquisitionObservedStateSnapshotV1['project'],
    artifact: Object.freeze({ mode: 'none' as const }),
    ledger: observations[1] as AcquisitionObservedStateSnapshotV1['ledger'],
    live: Object.freeze(
      observations.slice(liveStart, storeStart) as AcquisitionObservedStateSnapshotV1['live'],
    ),
    store: Object.freeze(
      observations.slice(
        storeStart,
        capabilitiesIndex,
      ) as AcquisitionObservedStateSnapshotV1['store'],
    ),
    capabilities: observations[
      capabilitiesIndex
    ] as AcquisitionObservedStateSnapshotV1<RelevantCapabilitySnapshotV1>['capabilities'],
  });
};

export const readAcquisitionSnapshotV1 = async (input: {
  readonly env: PlacementPorts;
  readonly registry: LifecycleToolRegistry<string>;
  readonly capabilityQueries: readonly RelevantCapabilityQueryV1[];
  readonly projectContext: ProjectContext;
  readonly artifact: AcquisitionSnapshotArtifactAuthorityV1;
  readonly ledgerPath: string;
  readonly liveResources: readonly AcquireLiveSnapshotResourceV1[];
  readonly storeResources: readonly AcquireStoreSnapshotResourceV1[];
  readonly signal?: AbortSignal;
}): Promise<AcquisitionSnapshotAuthorityV1> => {
  const projectOptions = {
    invocationCwd: input.projectContext.invocationCwd,
    ...(input.projectContext.explicitConfigPath === null
      ? {}
      : { explicitConfigPath: input.projectContext.explicitConfigPath }),
  } as const;
  const initialProject = input.projectContext;
  const projectResourceId = acquireStateResourceId('project', [
    initialProject.invocationCwd,
    initialProject.effectiveCwd,
  ]);
  const ledgerResourceId = acquireStateResourceId('ledger', [resolve(input.ledgerPath)]);
  const capabilities = createRelevantCapabilityStateReaderV1(
    input.registry,
    input.capabilityQueries,
  );
  const capabilitiesResourceId = capabilities.resourceId;
  const ledgerWriterPorts = (
    input.env as PlacementPorts & {
      readonly ledgerWriterPorts?: LedgerWriterPorts;
    }
  ).ledgerWriterPorts;
  const stateReadPorts =
    ledgerWriterPorts === undefined
      ? input.env
      : { ...input.env, readFileMetadata: ledgerWriterPorts.readFileMetadata };
  const commonRepositories = {
    project: createProjectStateReaderV1({
      resourceId: projectResourceId,
      ports: input.env,
      context: projectOptions,
    }),
    ledger: createLedgerRepository({
      resourceId: ledgerResourceId,
      reader: {
        ledgerPath: input.ledgerPath,
        read: () => readLedgerState(ledgerWriterPorts ?? input.env, input.ledgerPath),
      },
      metadata: stateReadPorts,
    }),
    live: createLivePlacementRepository({
      resources: input.liveResources,
      ports: stateReadPorts,
    }),
    store: createStoreRepository({
      resources: input.storeResources.map(({ resource }) => resource),
      ports: stateReadPorts,
    }),
    capabilities,
  } satisfies AcquisitionCommonSnapshotRepositoriesV1;
  const liveResourceIds = input.liveResources.map(({ resourceId }) => resourceId);
  const storeResourceIds = input.storeResources.map(({ resource }) => resource.resourceId);
  let snapshot: AcquisitionObservedStateSnapshotV1<RelevantCapabilitySnapshotV1>;
  let repositories: AcquisitionSnapshotRepositoriesV1;
  if (input.artifact.mode === 'selected') {
    const pair = input.artifact.pair;
    const manifestResourceId = acquireStateResourceId('manifest', [pair.file.path]);
    const lockResourceId = acquireStateResourceId('lock', [pair.lockfile.path]);
    const manifest = createManifestRepository({
      resourceId: manifestResourceId,
      path: pair.file.path,
      ports: stateReadPorts,
    });
    const lock = createLockRepository({
      resourceId: lockResourceId,
      path: pair.lockfile.path,
      ports: stateReadPorts,
    });
    const selectedRepositories = {
      ...commonRepositories,
      manifest,
      lock,
    } satisfies ObservedStateRepositoriesV1<RelevantCapabilitySnapshotV1>;
    const observed = await readObservedStateSnapshotV1(
      {
        schemaVersion: 1,
        projectResourceId,
        manifestResourceId,
        lockResourceId,
        ledgerResourceId,
        liveResourceIds,
        storeResourceIds,
        capabilitiesResourceId,
      },
      selectedRepositories,
    );
    if (!observed.ok) throw observed.error;
    snapshot = Object.freeze({
      schemaVersion: 1,
      snapshotId: observed.value.snapshotId,
      project: observed.value.project,
      artifact: Object.freeze({
        mode: 'selected' as const,
        pair,
        manifest: observed.value.manifest,
        lock: observed.value.lock,
      }),
      ledger: observed.value.ledger,
      live: observed.value.live,
      store: observed.value.store,
      capabilities: observed.value.capabilities,
    });
    repositories = { ...commonRepositories, artifact: { mode: 'selected', manifest, lock } };
  } else {
    snapshot = await readArtifactFreeAcquisitionSnapshotV1({
      repositories: commonRepositories,
      projectResourceId,
      ledgerResourceId,
      liveResourceIds,
      storeResourceIds,
      capabilitiesResourceId,
    });
    repositories = { ...commonRepositories, artifact: { mode: 'none' } };
  }
  if (
    snapshot.project.value === null ||
    !sameProjectContext(initialProject, snapshot.project.value)
  ) {
    throw new Error('acquisition project context changed during snapshot observation');
  }
  return Object.freeze({
    snapshot,
    repositories,
    projectContext: snapshot.project.value,
    ledgerResourceId,
    liveResources: new Map(input.liveResources.map((resource) => [resource.resourceId, resource])),
    storeResources: new Map(
      input.storeResources.map((resource) => [resource.resource.resourceId, resource]),
    ),
  });
};

const acquisitionRevisionResource = (
  authority: AcquisitionSnapshotAuthorityV1,
  revision: ExpectedRevisionV1,
): OperationResourceIdentity => {
  const projectRoot = authority.projectContext.projectRoot;
  const projectLocation = {
    kind: 'machine-bound' as const,
    path: projectRoot ?? authority.projectContext.effectiveCwd,
  };
  if (revision.domain === 'project' || revision.domain === 'capabilities') {
    return { kind: 'project-context', root: projectLocation };
  }
  if (revision.domain === 'manifest') {
    const artifact = authority.snapshot.artifact;
    if (artifact.mode !== 'selected') {
      throw new Error('acquisition manifest revision has no selected artifact authority');
    }
    return {
      kind: 'manifest-bytes',
      location: { kind: 'machine-bound', path: artifact.pair.file.path },
    };
  }
  if (revision.domain === 'lock') {
    const artifact = authority.snapshot.artifact;
    if (artifact.mode !== 'selected') {
      throw new Error('acquisition lock revision has no selected artifact authority');
    }
    return {
      kind: 'lock',
      location: { kind: 'machine-bound', path: artifact.pair.lockfile.path },
    };
  }
  if (revision.domain === 'ledger') {
    return {
      kind: 'ledger',
      projectRoot: projectRoot === null ? null : { kind: 'machine-bound', path: projectRoot },
    };
  }
  if (revision.domain === 'live') {
    const resource = authority.liveResources.get(revision.resourceId);
    if (resource === undefined) throw new Error('acquisition live revision resource is missing');
    return {
      kind: 'live',
      skill: resource.skill,
      tool: resource.tool,
      scope: resource.scope,
      projectRoot:
        resource.scope === 'project' && resource.projectIdentity !== null
          ? { kind: 'machine-bound', path: resource.projectIdentity }
          : null,
      location: { kind: 'machine-bound', path: resource.placementPath },
    };
  }
  const resource = authority.storeResources.get(revision.resourceId);
  if (resource === undefined) throw new Error('acquisition store revision resource is missing');
  return { kind: 'store', contentHash: resource.contentHash };
};

export const acquisitionRevisionPreconditions = (
  authority: AcquisitionSnapshotAuthorityV1,
  operations: readonly ExecutableOperation[],
): readonly ExecutionPrecondition[] => {
  if (operations.length === 0) return Object.freeze([]);
  const operationIds = operations.map(({ operationId }) => operationId);
  const artifactRevisions =
    authority.snapshot.artifact.mode === 'selected'
      ? [authority.snapshot.artifact.manifest.revision, authority.snapshot.artifact.lock.revision]
      : [];
  return Object.freeze(
    [
      authority.snapshot.project.revision,
      ...artifactRevisions,
      authority.snapshot.ledger.revision,
      ...authority.snapshot.live.map(({ revision }) => revision),
      ...authority.snapshot.store.map(({ revision }) => revision),
      authority.snapshot.capabilities.revision,
    ].map((expectedRevision) =>
      createExpectedRevisionExecutionPrecondition({
        operationIds,
        resource: acquisitionRevisionResource(authority, expectedRevision),
        expectedRevision,
        observeRevision: async () => {
          const artifact = authority.repositories.artifact;
          const repository =
            expectedRevision.domain === 'manifest' || expectedRevision.domain === 'lock'
              ? artifact.mode === 'selected'
                ? artifact[expectedRevision.domain]
                : undefined
              : authority.repositories[expectedRevision.domain];
          if (repository === undefined) {
            throw new Error('acquisition artifact revision repository is missing');
          }
          const observed = await repository.observeRevision(expectedRevision.resourceId);
          if (!observed.ok) throw observed.error;
          return observed.value;
        },
      }),
    ),
  );
};

export interface AcquisitionRepositoryLifecycleControllerV1 {
  bind(
    operation: ExecutableOperation,
    binding: PreparedExecutionBinding,
    resourceIds: readonly string[],
  ): PreparedExecutionBinding;
}

export const createAcquisitionExecutionLockPortV1 = (input: {
  readonly lockPort: LockPort;
  readonly ledgerPath: string;
  readonly lockFailure: (error: unknown) => unknown;
}): LockPort =>
  Object.freeze({
    withFileLock: async <T>(
      path: string,
      operation: () => Promise<T>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<T> => {
      if (path !== input.ledgerPath) throw new Error('unexpected acquire execution lock path');
      let callbackStarted = false;
      try {
        return await input.lockPort.withFileLock(
          path,
          async () => {
            callbackStarted = true;
            return operation();
          },
          options,
        );
      } catch (error) {
        if (callbackStarted) throw error;
        throw input.lockFailure(error);
      }
    },
  });

export const createAcquireExecutionLockPort = (
  env: AcquisitionPorts,
  ledgerPath: string,
  sanitize: (error: unknown) => SkillSmithError,
  message: (error: SkillSmithError) => string,
): LockPort =>
  createAcquisitionExecutionLockPortV1({
    lockPort: env,
    ledgerPath,
    lockFailure: (error) => {
      const safe = sanitize(error);
      return safe.code === 'cancelled'
        ? safe
        : flipFailedError(`another skillsmith operation is running: ${message(safe)}`);
    },
  });

export const createAcquisitionLedgerMigrationBinding = (
  args: Parameters<typeof ledgerMigrationExecutionBinding>[0],
): PreparedExecutionBinding => {
  const binding = ledgerMigrationExecutionBinding(args);
  return Object.freeze({
    ...binding,
    execute: (
      validated: ValidatedExecutionBinding,
      observation?: ObservationBundle,
    ): Promise<OperationExecutionResult> =>
      observation === undefined
        ? binding.execute(validated)
        : ledgerMigrationExecutionBindingObserved(args, observation).execute(validated),
  });
};

export const executeAcquisitionOperationPlan = (
  request: ExecutionCoordinatorRequest,
  observation?: ObservationBundle,
): Promise<readonly OperationExecutionResult[]> =>
  observation === undefined
    ? executeOperationPlan(request)
    : executeOperationPlanObserved(request as ObservedExecutionCoordinatorRequest, observation);

export interface AcquisitionPlanObservationState {
  emitted: boolean;
}

export const emitAcquisitionPlanCreated = (
  observation: ObservationBundle | undefined,
  plan: OperationPlan,
  state: AcquisitionPlanObservationState | undefined,
): void => {
  if (observation === undefined) return;
  emitOperationPlanCreated(observation, plan);
  if (state !== undefined) state.emitted = true;
};

export const runAcquisitionWithObservation = async <
  Report extends Readonly<{ plan: OperationPlan }>,
>(
  operation: (state: AcquisitionPlanObservationState) => Promise<Result<Report, SkillSmithError>>,
  sanitize: (error: unknown) => SkillSmithError,
  observation?: ObservationBundle,
): Promise<Result<Report, SkillSmithError>> => {
  const state = { emitted: false };
  try {
    const result = await operation(state);
    if (observation !== undefined && result.ok && !state.emitted) {
      emitOperationPlanCreated(observation, result.value.plan);
    }
    return result.ok ? result : err(sanitize(result.error));
  } catch (error) {
    return err(sanitize(error));
  }
};

const lifecycleRepository = (
  authority: AcquisitionSnapshotAuthorityV1,
  revision: ExpectedRevisionV1,
) => {
  if (revision.domain === 'ledger') return authority.repositories.ledger;
  if (revision.domain === 'live') return authority.repositories.live;
  if (revision.domain === 'store') return authority.repositories.store;
  throw new Error('acquisition lifecycle resource domain is not mutable');
};

const lifecycleEditDigest = (operation: ExecutableOperation): OperationDigest => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-acquisition-repository-edit', 1, operation]),
  );
  if (!hashed.ok) throw new Error('acquisition lifecycle edit digest invariant failed');
  return hashed.value as OperationDigest;
};

const observeLifecycleReceipt = async (
  authority: AcquisitionSnapshotAuthorityV1,
  operationId: string,
  stages: readonly LogicalRepositoryStageV1[],
  requestedDisposition: 'committed' | 'rolled-back',
): Promise<Result<DurabilityReceiptV1, unknown>> => {
  const revisions = [];
  let unchanged = true;
  for (const stage of stages) {
    const observed = await lifecycleRepository(authority, stage.beforeRevision).observeRevision(
      stage.resourceId,
    );
    if (!observed.ok) return err(observed.error);
    if (!sameExpectedRevisionV1(stage.beforeRevision, observed.value)) unchanged = false;
    revisions.push(
      Object.freeze({
        resourceId: stage.resourceId,
        beforeRevision: stage.beforeRevision,
        afterRevision: observed.value,
      }),
    );
  }
  return ok(
    Object.freeze({
      schemaVersion: 1,
      operationId,
      disposition:
        requestedDisposition === 'rolled-back' && !unchanged ? 'committed' : requestedDisposition,
      revisions: Object.freeze(revisions),
    }),
  );
};

const lifecycleErrorCursor = (
  error: Readonly<Record<string, unknown>>,
): RevisionCursorV1 | null => {
  const cursor = error.cursor;
  return cursor !== null &&
    typeof cursor === 'object' &&
    'schemaVersion' in cursor &&
    cursor.schemaVersion === 1 &&
    'snapshotId' in cursor &&
    typeof cursor.snapshotId === 'string' &&
    'revisions' in cursor &&
    Array.isArray(cursor.revisions)
    ? (cursor as unknown as RevisionCursorV1)
    : null;
};

const lifecycleFailedExecution = (
  operation: ExecutableOperation,
  binding: ValidatedExecutionBinding,
): OperationExecutionResult =>
  createOperationExecutionResult({
    operationId: operation.operationId,
    outcome: 'failed',
    actualBefore: binding.actualBefore,
    actualAfter: binding.actualBefore,
    force: binding.unstartedForce,
    error: {
      code: 'repository-lifecycle-failed',
      message: 'acquisition repository lifecycle could not establish a durable terminal state',
      remediation: 'Re-run the command to recover and prepare the current repository revisions.',
    },
  });

export const createAcquisitionRepositoryLifecycleControllerV1 = (input: {
  readonly authority: AcquisitionSnapshotAuthorityV1;
  readonly snapshotId: `snapshot:v1:${string}`;
  readonly expectedRevisions: readonly ExpectedRevisionV1[];
}): AcquisitionRepositoryLifecycleControllerV1 => {
  let cursor = createRevisionCursorV1({
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    expectedRevisions: input.expectedRevisions,
  });
  let blocked = false;
  return Object.freeze({
    bind: (
      operation: ExecutableOperation,
      binding: PreparedExecutionBinding,
      resourceIds: readonly string[],
    ): PreparedExecutionBinding => {
      const uniqueResourceIds = [...new Set(resourceIds)];
      if (uniqueResourceIds.length !== resourceIds.length || uniqueResourceIds.length === 0) {
        throw new Error('acquisition lifecycle resource coverage is invalid');
      }
      return Object.freeze({
        ...binding,
        execute: async (
          validatedBinding: ValidatedExecutionBinding,
          operationObservation?: ObservationBundle,
        ): Promise<OperationExecutionResult> => {
          if (blocked) return lifecycleFailedExecution(operation, validatedBinding);
          const expectedByResource = new Map(
            cursor.revisions.map((revision) => [revision.resourceId, revision]),
          );
          const editDigest = lifecycleEditDigest(operation);
          let physicalResult: OperationExecutionResult | null = null;
          const lifecycle = await executeRepositoryLifecycleV1(cursor, {
            operationId: operation.operationId,
            stage: async () => {
              const stages: LogicalRepositoryStageV1[] = [];
              for (const resourceId of uniqueResourceIds) {
                const expectedRevision = expectedByResource.get(resourceId);
                if (expectedRevision === undefined) {
                  return err({ code: 'unknown-resource', resourceId });
                }
                const staged = await lifecycleRepository(input.authority, expectedRevision).stage({
                  schemaVersion: 1,
                  operationId: operation.operationId,
                  domain: expectedRevision.domain,
                  resourceId,
                  expectedRevision,
                  editDigest,
                });
                if (!staged.ok) return err(staged.error);
                stages.push(staged.value);
              }
              return ok(Object.freeze(stages));
            },
            commit: async (stages) => {
              const execute = binding.execute as (
                validated: ValidatedExecutionBinding,
                observation?: ObservationBundle,
              ) => Promise<OperationExecutionResult>;
              physicalResult = await execute(validatedBinding, operationObservation);
              return physicalResult.outcome === 'succeeded'
                ? observeLifecycleReceipt(
                    input.authority,
                    operation.operationId,
                    stages,
                    'committed',
                  )
                : err({ code: 'physical-operation-not-committed' });
            },
            rollback: (stages) =>
              observeLifecycleReceipt(
                input.authority,
                operation.operationId,
                stages,
                'rolled-back',
              ),
            cleanup: async () => ok(undefined),
          });
          if (lifecycle.ok) {
            cursor = lifecycle.value.cursor;
          } else {
            const resolvedCursor = lifecycleErrorCursor(lifecycle.error);
            if (resolvedCursor !== null) cursor = resolvedCursor;
            const disposition = lifecycle.error.disposition;
            if (disposition !== 'rolled-back') blocked = true;
          }
          return physicalResult ?? lifecycleFailedExecution(operation, validatedBinding);
        },
      });
    },
  });
};

export const executeAcquirePlan = (
  input: AcquireExecutionInput,
  plan: SwapPlan,
): Promise<SwapExecutionResult<SwapOutcome>> => executePlacementPlan(input, plan);

export const executeAcquirePlanObserved = (
  input: AcquireExecutionInput,
  plan: SwapPlan,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  executePlacementPlanObserved(input, plan, observation);

export const executeAcquirePlanWithObservation = (
  input: AcquireExecutionInput,
  plan: SwapPlan,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  observation === undefined
    ? executeAcquirePlan(input, plan)
    : executeAcquirePlanObserved(input, plan, observation);

export const recoverAcquireWithObservation = (
  input: AcquireExecutionInput,
  target: PlacementRecoveryTarget,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<SwapOutcome>> =>
  observation === undefined
    ? recoverPlacement(input, 'resume', target)
    : recoverPlacementObserved(input, 'resume', target, observation);

export const recoverCommittedAcquireJournalsWithObservation = (
  input: AcquireExecutionInput,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<string[]>> =>
  observation === undefined
    ? recoverCommittedAcquirePlacements(input)
    : recoverCommittedAcquirePlacementsObserved(input, observation);

export const executeAcquirePlans = (
  input: AcquireExecutionInput,
  plans: readonly SwapPlan[],
): Promise<SwapExecutionResult<readonly SwapOutcome[]>> => executePlacementPlans(input, plans);

export const executeRecordOnlyAcquirePlan = (
  input: AcquireExecutionInput,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null = null,
): Promise<SwapExecutionResult<void>> =>
  executeRecordOnlyPlacementPlan(input, operation, pair, scopeKey);

export const executeRecordOnlyAcquirePlanWithObservation = (
  input: AcquireExecutionInput,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null = null,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<void>> =>
  executeRecordOnlyPlacementPlanWithObservation(input, operation, pair, scopeKey, observation);
