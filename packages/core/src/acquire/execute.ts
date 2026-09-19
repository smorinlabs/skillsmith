import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { RegisteredPlacementBundle, SkillRootsCtx } from '../agents/adapter-types.ts';
import type {
  RelevantCapabilityQueryV1,
  RelevantCapabilitySnapshotV1,
} from '../agents/capabilities.ts';
import {
  type Placement,
  classifyPlacement,
  classifyPlacementRoot,
} from '../agents/placement-shared.ts';
import type { LifecycleToolRegistry } from '../agents/registry.ts';
import type {
  ArtifactCoordinatorPorts,
  ArtifactGroupLockLease,
  GeneratedLockAction,
  HumanManifestAction,
} from '../artifacts/coordinator-types.ts';
import {
  type ArtifactGroupLeaseScaffoldReceipt,
  authenticateArtifactGroupLeaseScaffold,
  prepareArtifactGroupLeaseScaffold,
  withArtifactGroupLock,
} from '../artifacts/coordinator.ts';
import {
  type ArtifactDiscoveryError,
  type ArtifactDiscoveryPorts,
  type ArtifactDiscoverySnapshot,
  type ManifestCandidate,
  type ManifestDestination,
  discoverArtifactSnapshot,
  selectManifestDestination,
} from '../artifacts/discovery.ts';
import {
  type ArtifactPairExecutionActionV1,
  artifactLockImageFromBytesV1,
  artifactManifestImageFromBytesV1,
  createArtifactPairOperationControllerV1,
} from '../artifacts/execution.ts';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import { normalizePortablePath } from '../artifacts/identity.ts';
import { createLedgerRepository } from '../artifacts/ledger-repository.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import type { LedgerWriterPorts } from '../artifacts/ledger-writer.ts';
import { readPortableLockSource, serializePortableLock } from '../artifacts/lock.ts';
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
  ExecutionLockDescriptor,
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
import { createLedgerMigrationExecutionBinding } from '../place/ledger-migration.ts';
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
import {
  createOperationExecutionResult,
  operationSourceFromLedgerPairV1,
} from '../planning/create.ts';
import { canonicalPlanningString, comparePlanningText } from '../planning/order.ts';
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
  createExpectedRevisionV1,
  createFilesystemMetadataIdentityV1,
  isExpectedRevisionV1,
  sameExpectedRevisionV1,
  semanticValueRevisionV1,
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
  readonly path?: string;
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
      declaredNames: readonly string[];
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
  recoveryOwner = false,
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
  if (ownsRequestedName || recoveryOwner) {
    if (destination.role === 'selected-project') return 'selected-project-owner';
    if (destination.role === 'project-root') return 'project-root-owner';
    if (destination.role === 'user') return 'user-owner';
  }
  return destination.role === 'user' ? 'new-user' : 'new-project';
};

const siblingLockPathForManifest = (file: string): string => {
  const parts = parse(file);
  return join(parts.dir, `${parts.name}.lock`);
};

const handoffDiscoveryError = (
  code: Extract<
    ArtifactDiscoveryError['code'],
    | 'manifest-candidate-invalid'
    | 'manifest-candidate-unreadable'
    | 'manifest-owner-ambiguous'
    | 'manifest-owner-split'
  >,
  exitClass: ArtifactDiscoveryError['exitClass'],
  message: string,
  paths: readonly string[],
): ArtifactDiscoveryError =>
  Object.freeze({ code, exitClass, message, paths: Object.freeze([...new Set(paths)]) });

const selectRemoveDestinationWithLockHandoffs = async (
  ports: AcquisitionArtifactDestinationPortsV1,
  snapshot: ArtifactDiscoverySnapshot,
  names: readonly string[],
  ordinary: ManifestDestination,
): Promise<
  Result<
    Readonly<{ destination: ManifestDestination; recoveryOwner: boolean }>,
    ArtifactDiscoveryError
  >
> => {
  const candidates = snapshot.candidates.filter(
    (candidate) => candidate.role !== 'explicit' && candidate.shape === 'canonical',
  );
  const recoveryOwnersByName = new Map<string, ManifestCandidate[]>();
  for (const candidate of candidates) {
    const absentNames = names.filter((name) => !candidate.declaredNames.includes(name));
    if (absentNames.length === 0) continue;
    const lockPath = siblingLockPathForManifest(candidate.path);
    let kind: Awaited<ReturnType<typeof ports.pathKind>>;
    try {
      kind = await ports.pathKind(lockPath);
    } catch {
      return err(
        handoffDiscoveryError(
          'manifest-candidate-unreadable',
          'state',
          'cannot inspect sibling lock handoff candidate',
          [lockPath],
        ),
      );
    }
    if (kind === 'absent') continue;
    if (kind !== 'file') {
      return err(
        handoffDiscoveryError(
          'manifest-candidate-invalid',
          'state',
          'sibling lock handoff candidate is not a canonical file',
          [lockPath],
        ),
      );
    }
    let source: string;
    try {
      source = await ports.readText(lockPath);
    } catch {
      return err(
        handoffDiscoveryError(
          'manifest-candidate-unreadable',
          'state',
          'cannot read sibling lock handoff candidate',
          [lockPath],
        ),
      );
    }
    const decoded = readPortableLockSource(new TextEncoder().encode(source));
    if (!decoded.ok) {
      return err(
        handoffDiscoveryError(
          'manifest-candidate-invalid',
          'state',
          'sibling lock handoff candidate is not canonical',
          [lockPath],
        ),
      );
    }
    for (const name of absentNames) {
      if (!decoded.value.skills.some((skill) => skill.name === name)) continue;
      const owners = recoveryOwnersByName.get(name) ?? [];
      owners.push(candidate);
      recoveryOwnersByName.set(name, owners);
    }
  }

  const ownerByName = new Map<string, ManifestCandidate>();
  for (const name of names) {
    const normalOwners = snapshot.candidates.filter(
      (candidate) => candidate.role !== 'explicit' && candidate.declaredNames.includes(name),
    );
    const owners = [...normalOwners, ...(recoveryOwnersByName.get(name) ?? [])];
    const ownerPaths = [...new Set(owners.map(({ path }) => path))];
    if (ownerPaths.length > 1) {
      return err(
        handoffDiscoveryError(
          'manifest-owner-ambiguous',
          'usage',
          `declaration '${name}' has multiple manifest or lock-handoff owners: ${ownerPaths.join(', ')}`,
          ownerPaths,
        ),
      );
    }
    const owner = owners.find(({ path }) => path === ownerPaths[0]);
    if (owner !== undefined) ownerByName.set(name, owner);
  }
  const ownerPaths = [...new Set([...ownerByName.values()].map(({ path }) => path))];
  if (ownerPaths.length > 1) {
    return err(
      handoffDiscoveryError(
        'manifest-owner-split',
        'usage',
        `one request cannot mutate declarations owned by different manifest/lock pairs: ${ownerPaths.join(', ')}`,
        ownerPaths,
      ),
    );
  }
  const owner = [...ownerByName.values()].find(({ path }) => path === ownerPaths[0]);
  if (owner === undefined)
    return ok(Object.freeze({ destination: ordinary, recoveryOwner: false }));
  return ok(
    Object.freeze({
      destination: Object.freeze({
        kind: 'existing' as const,
        role: owner.role,
        path: owner.path,
        names: Object.freeze([...new Set(names)]),
      }),
      recoveryOwner:
        recoveryOwnersByName
          .get(names.find((name) => ownerByName.get(name)?.path === owner.path) ?? '')
          ?.some(({ path }) => path === owner.path) === true,
    }),
  );
};

/** Resolve one acquisition destination without introducing a second discovery or pair authority. */
export const resolveAcquisitionArtifactDestinationV1 = async (
  input: ResolveAcquisitionArtifactDestinationInputV1,
): Promise<AcquisitionArtifactDestinationResolutionV1> => {
  if (input.noSave === true) return liveOnlyArtifactDestination();

  if (
    input.path !== undefined &&
    !normalizePortablePath(input.path, input.scope, 'install.path').ok
  ) {
    return pairRefusal({
      code: 'artifact-selector-nonportable',
      exitClass: 'usage',
      message: `install path must be a portable ${input.scope === 'project' ? './project-relative' : '~/home-relative'} path; use --no-save for a machine-bound destination`,
      paths: Object.freeze([input.path]),
    });
  }

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
  const handoffDestination =
    input.mode === 'remove' && input.file === undefined
      ? await selectRemoveDestinationWithLockHandoffs(
          input.ports,
          discovered.value,
          input.names,
          destination.value,
        )
      : ok(Object.freeze({ destination: destination.value, recoveryOwner: false }));
  if (!handoffDestination.ok) return discoveryRefusal(handoffDestination.error);

  const legacyProjectRemoval =
    input.mode === 'remove' &&
    input.scope === 'project' &&
    input.file === undefined &&
    handoffDestination.value.destination.kind === 'absent' &&
    discovered.value.projectRootManifest !== null
      ? discovered.value.candidates.find(
          (candidate) =>
            candidate.path === discovered.value.projectRootManifest && candidate.shape === 'legacy',
        )
      : undefined;
  const resolvedDestination: ManifestDestination =
    legacyProjectRemoval === undefined
      ? handoffDestination.value.destination
      : Object.freeze({
          kind: 'existing' as const,
          role: legacyProjectRemoval.role,
          path: legacyProjectRemoval.path,
          names: handoffDestination.value.destination.names,
        });

  const explicitAbsentRemove =
    input.mode === 'remove' && resolvedDestination.kind === 'absent' && input.file !== undefined;
  if (resolvedDestination.kind === 'absent' && !explicitAbsentRemove) {
    return desiredStateWithoutArtifact('no-owner');
  }

  const pair = await resolveArtifactPair(
    input.ports,
    input.projectContext,
    input.file === undefined
      ? {
          discoveredFile: resolvedDestination.path,
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
    declaredNames: Object.freeze(
      resolvedDestination.path === null
        ? []
        : [
            ...(discovered.value.candidates.find(
              (candidate) => candidate.path === resolvedDestination.path,
            )?.declaredNames ?? []),
          ],
    ),
    selection: Object.freeze({
      outcome: 'selected' as const,
      selectedBy: selectedByForDestination(
        discovered.value,
        resolvedDestination,
        handoffDestination.value.recoveryOwner,
      ),
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
  const rootClass = await classifyPlacementRoot(env, root);
  const [pathKind, placement] = await Promise.all([
    rootClass === 'container' ? env.pathKind(path) : Promise.resolve('absent' as const),
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
  includePortableProvenance = false,
): OperationImage => {
  if (facts.placement.class === 'absent') return { kind: 'absent', resource };
  const representation =
    facts.pathKind === 'symlink' ? 'symlink' : facts.pathKind === 'dir' ? 'copy' : 'other';
  const source = includePortableProvenance ? operationSourceFromLedgerPairV1(pair, null) : null;
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
    source,
    contentHash:
      source === null ? null : ((facts.contentHash ?? source.contentHash) as OperationDigest),
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
): Promise<SwapExecutionResult<readonly SwapOutcome[]>> => {
  const install = plan.install;
  if (install === undefined) {
    return {
      ok: false,
      error: genericError('install plan missing install payload'),
      state: { ledger: input.ledger },
    };
  }
  if (intermediatePinned === null) {
    const executed = await executePlacementPlan(input, plan);
    return executed.ok
      ? { ok: true, value: [executed.value], state: executed.state }
      : { ok: false, error: executed.error, state: executed.state };
  }
  // SC-I60-MO2: the two kind changes carry the durable replacement intent so a
  // crash between the swaps leaves a self-describing marker. Stage 1 stages
  // the intermediate symlink, stage 2 converges to the requested build.
  const replacementBuild = install.build;
  const staged: readonly SwapPlan[] = [
    {
      ...plan,
      install: {
        ...install,
        build: 'symlink',
        pinned: intermediatePinned,
        adoptedDev: null,
        replacement: { build: replacementBuild, stage: 1 },
      },
    },
    {
      ...plan,
      install: { ...install, replacement: { build: replacementBuild, stage: 2 } },
    },
  ];
  const executed = await executePlacementPlans(input, staged);
  return executed.ok
    ? { ok: true, value: executed.value, state: executed.state }
    : { ok: false, error: executed.error, state: executed.state };
};

export const executeAcquireReplacementObserved = async (
  input: AcquireExecutionInput,
  plan: SwapPlan,
  intermediatePinned: PinnedRecord | null,
  observation: ObservationBundle,
): Promise<SwapExecutionResult<readonly SwapOutcome[]>> => {
  const install = plan.install;
  if (install === undefined) {
    return {
      ok: false,
      error: genericError('install plan missing install payload'),
      state: { ledger: input.ledger },
    };
  }
  if (intermediatePinned === null) {
    const executed = await executePlacementPlanObserved(input, plan, observation);
    return executed.ok
      ? { ok: true, value: [executed.value], state: executed.state }
      : { ok: false, error: executed.error, state: executed.state };
  }
  // SC-I60-MO2: same staged intent as the unobserved variant above.
  const replacementBuild = install.build;
  const staged: readonly SwapPlan[] = [
    {
      ...plan,
      install: {
        ...install,
        build: 'symlink',
        pinned: intermediatePinned,
        adoptedDev: null,
        replacement: { build: replacementBuild, stage: 1 },
      },
    },
    {
      ...plan,
      install: { ...install, replacement: { build: replacementBuild, stage: 2 } },
    },
  ];
  const executed = await executePlacementPlansObserved(input, staged, observation);
  return executed.ok
    ? { ok: true, value: executed.value, state: executed.state }
    : { ok: false, error: executed.error, state: executed.state };
};

export const executeAcquireReplacementWithObservation = (
  input: AcquireExecutionInput,
  plan: SwapPlan,
  intermediatePinned: PinnedRecord | null,
  observation?: ObservationBundle,
): Promise<SwapExecutionResult<readonly SwapOutcome[]>> =>
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
  readonly fixedProjectContext?: boolean;
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
  const project = input.fixedProjectContext
    ? (() => {
        const semanticRevision = semanticValueRevisionV1('project', initialProject);
        const revision = createExpectedRevisionV1({
          schemaVersion: 1,
          domain: 'project',
          resourceId: projectResourceId,
          state: 'present',
          targetKind: 'semantic',
          semanticRevision,
        });
        if (!revision.ok) throw new Error('fixed acquisition project revision is invalid');
        const observation = Object.freeze({ revision: revision.value, value: initialProject });
        const observe = async (resourceId: string) =>
          resourceId === projectResourceId
            ? ok(observation)
            : err({
                code: 'state-repository' as const,
                domain: 'project' as const,
                reason: 'invalid-request' as const,
              });
        return Object.freeze({
          observe,
          observeRevision: async (resourceId: string) => {
            const observed = await observe(resourceId);
            return observed.ok ? ok(observed.value.revision) : observed;
          },
        });
      })()
    : createProjectStateReaderV1({
        resourceId: projectResourceId,
        ports: input.env,
        context: projectOptions,
      });
  const commonRepositories = {
    project,
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
  rebase(resourceIds: readonly string[]): Promise<void>;
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
      return safe.code === 'cancelled' || safe.code === 'permission-denied'
        ? safe
        : flipFailedError(`another skillsmith operation is running: ${message(safe)}`);
    },
  });

type AcquisitionArtifactRoleV1 = 'manifest' | 'lock';
export type AcquisitionArtifactExecutionActionV1 =
  | Readonly<{ readonly role: 'manifest'; readonly action: HumanManifestAction }>
  | Readonly<{ readonly role: 'lock'; readonly action: GeneratedLockAction }>;

export interface AcquisitionArtifactExecutionControllerV1 {
  readonly locks: readonly ExecutionLockDescriptor[];
  readonly lockPort: LockPort;
  bindPreconditions(
    preconditions: readonly ExecutionPrecondition[],
  ): readonly ExecutionPrecondition[];
  bind(
    operation: ExecutableOperation,
    action: AcquisitionArtifactExecutionActionV1,
  ): PreparedExecutionBinding;
}

const acquisitionArtifactExecutionFail = (message: string): never => {
  throw new TypeError(`acquisition artifact execution: ${message}`);
};

const acquisitionArtifactLocation = (path: string) =>
  Object.freeze({ kind: 'machine-bound' as const, path });

const acquisitionArtifactResource = (role: AcquisitionArtifactRoleV1, path: string) =>
  role === 'manifest'
    ? Object.freeze({
        kind: 'manifest-bytes' as const,
        location: acquisitionArtifactLocation(path),
      })
    : Object.freeze({ kind: 'lock' as const, location: acquisitionArtifactLocation(path) });

const ownAcquisitionArtifactAction = (
  action: AcquisitionArtifactExecutionActionV1,
): AcquisitionArtifactExecutionActionV1 => {
  let owned: AcquisitionArtifactExecutionActionV1;
  try {
    owned = structuredClone(action);
  } catch {
    return acquisitionArtifactExecutionFail('artifact action is not ownable data');
  }
  const freeze = (value: unknown, seen = new Set<object>()): void => {
    if (
      value === null ||
      typeof value !== 'object' ||
      ArrayBuffer.isView(value) ||
      seen.has(value)
    ) {
      return;
    }
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  };
  freeze(owned);
  return owned;
};

/** @deprecated Compatibility alias; artifact image ownership is pair-controller neutral. */
export const acquisitionManifestImageFromBytesV1 = artifactManifestImageFromBytesV1;

/** @deprecated Compatibility alias; artifact image ownership is pair-controller neutral. */
export const acquisitionLockImageFromBytesV1 = artifactLockImageFromBytesV1;

const sameAcquisitionArtifactImage = (left: OperationImage, right: OperationImage): boolean =>
  canonicalPlanningString(left) === canonicalPlanningString(right);

const isExactAcquisitionScaffoldDelta = (
  expected: unknown,
  observed: unknown,
  role: AcquisitionArtifactRoleV1,
  resourceId: string,
  targetPath: string,
): expected is ExpectedRevisionV1 => {
  if (
    !isExpectedRevisionV1(expected) ||
    !isExpectedRevisionV1(observed) ||
    expected.domain !== role ||
    observed.domain !== role ||
    expected.resourceId !== resourceId ||
    observed.resourceId !== resourceId ||
    expected.state !== 'absent' ||
    observed.state !== 'absent' ||
    expected.targetIdentity !== targetPath ||
    observed.targetIdentity !== targetPath ||
    expected.targetKind !== 'absent' ||
    observed.targetKind !== 'absent' ||
    expected.parentIdentity !== dirname(targetPath) ||
    observed.parentIdentity !== dirname(targetPath) ||
    expected.parentKind !== 'absent' ||
    observed.parentKind !== 'directory'
  ) {
    return false;
  }
  return true;
};

const acquisitionArtifactImagePath = (image: OperationImage): string | null => {
  const location =
    image.kind === 'manifest' || image.kind === 'lock'
      ? image.location
      : image.kind === 'absent' &&
          (image.resource.kind === 'manifest-bytes' || image.resource.kind === 'lock')
        ? image.resource.location
        : null;
  return location?.kind === 'machine-bound' ? location.path : null;
};

const validateAcquisitionArtifactOperation = (
  operation: ExecutableOperation,
  action: AcquisitionArtifactExecutionActionV1,
  pair: ResolvedArtifactPair,
): AcquisitionArtifactRoleV1 => {
  if (
    operation.pairId !== null ||
    operation.skill !== null ||
    operation.source !== null ||
    operation.tool !== null ||
    operation.scope !== null
  ) {
    acquisitionArtifactExecutionFail('artifact binding identity is invalid');
  }
  const role: AcquisitionArtifactRoleV1 =
    operation.kind === 'migrate-project-config' || operation.kind === 'write-manifest'
      ? 'manifest'
      : operation.kind === 'write-lock'
        ? 'lock'
        : acquisitionArtifactExecutionFail('operation kind is not an acquisition artifact write');
  if (action.role !== role) acquisitionArtifactExecutionFail('artifact action role is invalid');
  const path = role === 'manifest' ? pair.file.path : pair.lockfile.path;
  if (
    acquisitionArtifactImagePath(operation.before) !== path ||
    acquisitionArtifactImagePath(operation.after) !== path
  ) {
    acquisitionArtifactExecutionFail('artifact operation path differs from selected authority');
  }

  if (role === 'manifest') {
    const manifestAction =
      action.role === 'manifest'
        ? action.action
        : acquisitionArtifactExecutionFail('artifact action role is invalid');
    if (operation.after.kind !== 'manifest' || operation.after.shape !== 'canonical') {
      acquisitionArtifactExecutionFail('manifest operation after image is invalid');
    }
    if (manifestAction.kind === 'keep') {
      acquisitionArtifactExecutionFail('manifest operation action cannot be keep');
    }
    if (operation.kind === 'migrate-project-config') {
      if (
        operation.before.kind !== 'manifest' ||
        operation.before.shape !== 'legacy' ||
        manifestAction.kind !== 'edit' ||
        manifestAction.request.edits.length !== 1 ||
        manifestAction.request.edits[0]?.kind !== 'migrate-legacy'
      ) {
        acquisitionArtifactExecutionFail('manifest migration action is invalid');
      }
    } else {
      const beforeIsAbsent =
        operation.before.kind === 'absent' && operation.before.resource.kind === 'manifest-bytes';
      const beforeIsCanonical =
        operation.before.kind === 'manifest' && operation.before.shape === 'canonical';
      if (
        (!beforeIsAbsent && !beforeIsCanonical) ||
        (beforeIsAbsent && manifestAction.kind !== 'replace') ||
        (beforeIsCanonical && manifestAction.kind !== 'edit') ||
        (manifestAction.kind === 'edit' &&
          manifestAction.request.edits.some(({ kind }) => kind === 'migrate-legacy'))
      ) {
        acquisitionArtifactExecutionFail('manifest write action is invalid');
      }
    }
    if (
      manifestAction.kind === 'replace' &&
      !sameAcquisitionArtifactImage(
        acquisitionManifestImageFromBytesV1(path, manifestAction.bytes),
        operation.after,
      )
    ) {
      acquisitionArtifactExecutionFail('manifest replacement differs from planned after image');
    }
    return role;
  }

  const lockAction =
    action.role === 'lock'
      ? action.action
      : acquisitionArtifactExecutionFail('artifact action role is invalid');
  if (
    operation.after.kind !== 'lock' ||
    !(
      (operation.before.kind === 'absent' && operation.before.resource.kind === 'lock') ||
      operation.before.kind === 'lock'
    )
  ) {
    acquisitionArtifactExecutionFail('lock write action is invalid');
  }
  if (lockAction.kind === 'keep' || lockAction.kind === 'remove') {
    return acquisitionArtifactExecutionFail('lock write action is invalid');
  }
  if (lockAction.kind === 'replace-invalid') {
    return acquisitionArtifactExecutionFail('doctor-only lock action is not allowed');
  }
  if (lockAction.kind !== 'replace') {
    return acquisitionArtifactExecutionFail('acquisition lock action must use normal replace');
  }
  const serialized = serializePortableLock(lockAction.lock);
  if (
    !serialized.ok ||
    !sameAcquisitionArtifactImage(
      acquisitionLockImageFromBytesV1(path, new TextEncoder().encode(serialized.value)),
      operation.after,
    )
  ) {
    acquisitionArtifactExecutionFail('lock action differs from planned after image');
  }
  return role;
};

const ownAcquisitionArtifactPair = (pair: ResolvedArtifactPair): ResolvedArtifactPair =>
  Object.freeze({
    file: Object.freeze({ ...pair.file }),
    lockfile: Object.freeze({ ...pair.lockfile }),
    lockfileSource: pair.lockfileSource,
  });

const isStrictAcquisitionArtifactAncestor = (ancestor: string, target: string): boolean => {
  const displacement = relative(ancestor, target);
  return (
    displacement !== '' &&
    displacement !== '..' &&
    !displacement.startsWith(`..${sep}`) &&
    !isAbsolute(displacement)
  );
};

const createAcquisitionArtifactExecutionCompatibilityControllerV1 = (input: {
  readonly authority: AcquisitionSnapshotAuthorityV1;
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly ledgerLockPort: LockPort;
  readonly ledgerPath: string;
  readonly signal?: AbortSignal;
}): AcquisitionArtifactExecutionControllerV1 => {
  const artifact = input.authority.snapshot.artifact;
  const repositories = input.authority.repositories.artifact;
  if (artifact.mode !== 'selected' || repositories.mode !== 'selected') {
    return acquisitionArtifactExecutionFail('selected artifact authority is required');
  }
  const pair = ownAcquisitionArtifactPair(artifact.pair);
  if (
    artifact.manifest.revision.domain !== 'manifest' ||
    artifact.manifest.revision.targetIdentity !== pair.file.path ||
    artifact.lock.revision.domain !== 'lock' ||
    artifact.lock.revision.targetIdentity !== pair.lockfile.path
  ) {
    acquisitionArtifactExecutionFail('selected artifact snapshot does not match its pair');
  }
  const resourceIds = Object.freeze({
    manifest: artifact.manifest.revision.resourceId,
    lock: artifact.lock.revision.resourceId,
  });
  const groupPath = join(input.artifactCoordinator.coordinationRoot, 'global');
  const memberPaths = Object.freeze([pair.file.path, pair.lockfile.path].sort(comparePlanningText));
  const descriptorPaths = [groupPath, ...memberPaths, input.ledgerPath];
  if (
    memberPaths[0] === memberPaths[1] ||
    new Set(descriptorPaths).size !== descriptorPaths.length ||
    descriptorPaths.some((target, index) =>
      descriptorPaths.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          (isStrictAcquisitionArtifactAncestor(target, other) ||
            `${target}.lock` === other ||
            isStrictAcquisitionArtifactAncestor(`${target}.lock`, other)),
      ),
    )
  ) {
    acquisitionArtifactExecutionFail('artifact execution descriptor topology is unsafe');
  }
  const locks = Object.freeze([
    Object.freeze({ rank: 'artifact-group' as const, key: 'artifact-group', path: groupPath }),
    ...memberPaths.map((path, index) =>
      Object.freeze({
        rank: 'artifact-member' as const,
        key: `artifact-member:${index}`,
        path,
      }),
    ),
    Object.freeze({ rank: 'ledger' as const, key: 'placements-ledger', path: input.ledgerPath }),
  ] satisfies readonly ExecutionLockDescriptor[]);

  type ActiveLease = {
    readonly lease: ArtifactGroupLockLease;
    readonly seenMembers: Set<string>;
    membersAcquired: boolean;
    scaffoldReceipt: ArtifactGroupLeaseScaffoldReceipt | null;
  };
  let active: ActiveLease | null = null;
  const requireSignal = (options: Readonly<{ signal?: AbortSignal }> | undefined): void => {
    if (options?.signal !== input.signal) {
      acquisitionArtifactExecutionFail('execution lock signal differs from selected authority');
    }
  };
  const lockPort: LockPort = Object.freeze({
    withFileLock: async <T>(
      path: string,
      operation: () => Promise<T>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<T> => {
      requireSignal(options);
      if (path === groupPath) {
        if (active !== null) acquisitionArtifactExecutionFail('artifact group lock is reentrant');
        let operationFailed = false;
        let operationError: unknown;
        const value = await withArtifactGroupLock<T | undefined>(
          input.artifactCoordinator,
          pair,
          input.signal,
          async (lease) => {
            const held: ActiveLease = {
              lease,
              seenMembers: new Set<string>(),
              membersAcquired: false,
              scaffoldReceipt: null,
            };
            active = held;
            try {
              try {
                return await operation();
              } catch (error) {
                operationFailed = true;
                operationError = error;
                return undefined;
              }
            } finally {
              if (active === held) active = null;
            }
          },
        );
        if (operationFailed) throw operationError;
        return value as T;
      }
      if (memberPaths.includes(path)) {
        const held = active;
        if (
          held === null ||
          held.seenMembers.has(path) ||
          path !== memberPaths[held.seenMembers.size]
        ) {
          return acquisitionArtifactExecutionFail(
            'artifact member lock is outside its group lease',
          );
        }
        if (!held.membersAcquired) {
          const scaffold = await prepareArtifactGroupLeaseScaffold(held.lease, memberPaths);
          if (!scaffold.ok) throw scaffold.error;
          held.scaffoldReceipt = scaffold.value;
          await held.lease.acquireCompatibilityTargets(memberPaths);
          held.membersAcquired = true;
        }
        held.seenMembers.add(path);
        return operation();
      }
      if (path === input.ledgerPath) {
        const held = active;
        if (
          held === null ||
          !held.membersAcquired ||
          held.seenMembers.size !== memberPaths.length
        ) {
          acquisitionArtifactExecutionFail('ledger lock was requested before artifact members');
        }
        return input.ledgerLockPort.withFileLock(path, operation, options);
      }
      return acquisitionArtifactExecutionFail('unexpected selected artifact execution lock path');
    },
  });

  const lastBoundByRole = new Map<AcquisitionArtifactRoleV1, ExecutableOperation>();
  let lastBoundArtifact: ExecutableOperation | null = null;
  let currentBoundGroup: string | null = null;
  let currentGroupGate: ExecutableOperation | null = null;
  const closedArtifactGroups = new Set<string>();
  const boundOperationIds = new Set<string>();
  const successfulOperations = new Set<string>();
  const sharedDescriptors: Array<
    Readonly<{
      operation: ExecutableOperation;
      action: ArtifactPairExecutionActionV1;
    }>
  > = [];
  let sharedLease: ArtifactGroupLockLease | null = null;
  let sharedBindings = new Map<string, PreparedExecutionBinding>();

  return Object.freeze({
    locks,
    lockPort,
    bindPreconditions: (
      preconditions: readonly ExecutionPrecondition[],
    ): readonly ExecutionPrecondition[] =>
      Object.freeze(
        preconditions.map((precondition) => {
          const role =
            precondition.resource.kind === 'manifest-bytes'
              ? ('manifest' as const)
              : precondition.resource.kind === 'lock'
                ? ('lock' as const)
                : null;
          if (role === null) return precondition;
          const targetPath = role === 'manifest' ? pair.file.path : pair.lockfile.path;
          const expectedRevision =
            role === 'manifest' ? artifact.manifest.revision : artifact.lock.revision;
          if (
            canonicalPlanningString(precondition.resource) !==
              canonicalPlanningString(acquisitionArtifactResource(role, targetPath)) ||
            !isExpectedRevisionV1(precondition.expected) ||
            !sameExpectedRevisionV1(precondition.expected, expectedRevision)
          ) {
            return precondition;
          }
          return Object.freeze({
            ...precondition,
            observe: async (): Promise<unknown> => {
              const observed = await precondition.observe();
              if (
                isExpectedRevisionV1(observed) &&
                isExpectedRevisionV1(precondition.expected) &&
                sameExpectedRevisionV1(observed, precondition.expected)
              ) {
                return observed;
              }
              if (
                !isExactAcquisitionScaffoldDelta(
                  precondition.expected,
                  observed,
                  role,
                  resourceIds[role],
                  targetPath,
                )
              ) {
                return observed;
              }
              const held = active;
              if (
                held === null ||
                !held.membersAcquired ||
                held.seenMembers.size !== memberPaths.length ||
                held.scaffoldReceipt === null
              ) {
                return observed;
              }
              const authenticated = await authenticateArtifactGroupLeaseScaffold(
                held.lease,
                held.scaffoldReceipt,
                targetPath,
              );
              if (!authenticated.ok) throw authenticated.error;
              const proof = authenticated.value;
              if (
                proof === null ||
                proof.targetPath !== targetPath ||
                proof.parentPath !== dirname(targetPath) ||
                !isExpectedRevisionV1(observed) ||
                observed.state !== 'absent'
              ) {
                return observed;
              }
              const authenticatedParentMetadataIdentity = createFilesystemMetadataIdentityV1(
                proof.parentPath,
                {
                  kind: 'dir',
                  mode: proof.parentMode,
                  identity: proof.parentIdentity,
                  linkCount: null,
                },
                'parent',
              );
              return observed.parentMetadataIdentity === authenticatedParentMetadataIdentity
                ? precondition.expected
                : observed;
            },
          });
        }),
      ),
    bind: (
      operation: ExecutableOperation,
      action: AcquisitionArtifactExecutionActionV1,
    ): PreparedExecutionBinding => {
      if (boundOperationIds.has(operation.operationId)) {
        acquisitionArtifactExecutionFail('artifact operation was bound more than once');
      }
      const ownedAction = ownAcquisitionArtifactAction(action);
      const role = validateAcquisitionArtifactOperation(operation, ownedAction, pair);
      const rolePredecessor = lastBoundByRole.get(role) ?? null;
      if (
        rolePredecessor !== null &&
        !sameAcquisitionArtifactImage(rolePredecessor.after, operation.before)
      ) {
        acquisitionArtifactExecutionFail('artifact operation chain has a state gap');
      }
      if (
        lastBoundArtifact !== null &&
        lastBoundArtifact.groupId === operation.groupId &&
        !operation.dependencyMetadata.operationIds.includes(lastBoundArtifact.operationId)
      ) {
        acquisitionArtifactExecutionFail('same-group artifact chain lacks a direct dependency');
      }
      const groupChanged = currentBoundGroup !== operation.groupId;
      if (groupChanged && closedArtifactGroups.has(operation.groupId)) {
        acquisitionArtifactExecutionFail('artifact operation group is not contiguous');
      }
      const priorGroupTerminal = groupChanged ? lastBoundArtifact : currentGroupGate;
      if (groupChanged) {
        if (
          priorGroupTerminal !== null &&
          (priorGroupTerminal.kind !== 'write-lock' ||
            !operation.dependencyMetadata.operationIds.includes(priorGroupTerminal.operationId))
        ) {
          acquisitionArtifactExecutionFail(
            'new artifact group lacks its explicit prior lock-prefix dependency',
          );
        }
        if (currentBoundGroup !== null) closedArtifactGroups.add(currentBoundGroup);
        currentBoundGroup = operation.groupId;
        currentGroupGate = priorGroupTerminal;
      }
      boundOperationIds.add(operation.operationId);
      lastBoundByRole.set(role, operation);
      lastBoundArtifact = operation;
      sharedDescriptors.push(Object.freeze({ operation, action: ownedAction }));
      return Object.freeze({
        operationId: operation.operationId,
        groupId: operation.groupId,
        pairId: operation.pairId,
        unstartedForce: null,
        observeActualBefore: async () => operation.before,
        execute: async (binding: ValidatedExecutionBinding): Promise<OperationExecutionResult> => {
          if (
            binding.operationId !== operation.operationId ||
            binding.groupId !== operation.groupId ||
            binding.pairId !== null ||
            binding.unstartedForce !== null ||
            !sameAcquisitionArtifactImage(binding.actualBefore, operation.before)
          ) {
            acquisitionArtifactExecutionFail('validated artifact binding is mismatched');
          }
          const held = active;
          if (
            held === null ||
            !held.membersAcquired ||
            held.seenMembers.size !== memberPaths.length
          ) {
            return acquisitionArtifactExecutionFail(
              'artifact binding executed without its active lease',
            );
          }
          if (
            priorGroupTerminal !== null &&
            !successfulOperations.has(priorGroupTerminal.operationId)
          ) {
            acquisitionArtifactExecutionFail('prior artifact group did not complete successfully');
          }
          if (rolePredecessor !== null && !successfulOperations.has(rolePredecessor.operationId)) {
            acquisitionArtifactExecutionFail('artifact predecessor did not complete successfully');
          }
          if (sharedLease !== held.lease) {
            const shared = createArtifactPairOperationControllerV1({
              lease: held.lease,
              artifactCoordinator: input.artifactCoordinator,
              pair,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
            sharedBindings = new Map(
              sharedDescriptors.map(({ operation: selected, action: selectedAction }) => {
                const prepared = shared.bind(selected, selectedAction);
                return [prepared.operationId, prepared] as const;
              }),
            );
            sharedLease = held.lease;
          }
          const sharedBinding = sharedBindings.get(operation.operationId);
          if (sharedBinding === undefined) {
            return acquisitionArtifactExecutionFail('shared artifact binding is missing');
          }
          const result = await sharedBinding.execute(binding);
          if (result.outcome === 'succeeded') successfulOperations.add(operation.operationId);
          return result;
        },
      });
    },
  });
};

/** @deprecated Compatibility alias; physical pair execution is artifact-domain neutral. */
export const createAcquisitionArtifactExecutionControllerV1 =
  createAcquisitionArtifactExecutionCompatibilityControllerV1;

/** @deprecated Compatibility alias; ledger migration binding authority is command-neutral. */
export const createAcquisitionLedgerMigrationBinding = createLedgerMigrationExecutionBinding;

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
    rebase: async (resourceIds: readonly string[]): Promise<void> => {
      const selected = new Set(resourceIds);
      if (blocked || selected.size !== resourceIds.length || selected.size === 0) {
        throw new Error('acquisition lifecycle rebase authority is invalid');
      }
      const revisions = [];
      for (const revision of cursor.revisions) {
        if (!selected.has(revision.resourceId)) {
          revisions.push(revision);
          continue;
        }
        const observed = await lifecycleRepository(input.authority, revision).observeRevision(
          revision.resourceId,
        );
        if (!observed.ok) throw observed.error;
        revisions.push(observed.value);
        selected.delete(revision.resourceId);
      }
      if (selected.size !== 0) {
        throw new Error('acquisition lifecycle rebase resource is unknown');
      }
      cursor = createRevisionCursorV1({
        schemaVersion: 1,
        snapshotId: cursor.snapshotId,
        expectedRevisions: revisions,
      });
    },
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
