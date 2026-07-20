import { dirname, resolve } from 'node:path';
import type { ToolCapabilityScope } from '../agents/adapter-types.ts';
import type { RelevantCapabilityQueryV1 } from '../agents/capabilities.ts';
import type { LifecycleToolRegistry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { hashManifestSemantics } from '../artifacts/hash.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import { type PortableLockV1, hashPortableLock } from '../artifacts/lock.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import type { NormalizedManifestDeclaration, NormalizedManifestV1 } from '../artifacts/types.ts';
import type { ProjectContext } from '../context/types.ts';
import {
  type SnapshotBoundOperationPlanV1,
  type SnapshotPlanningErrorV1,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
  createPlanningDiagnosticId,
  operationImageFromLiveStateV1,
  operationSourceFromLedgerPairV1,
} from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  BoundedConflict,
  CurrentMutatorCommand,
  ExecutableOperation,
  OperationDigest,
  OperationGroupIdentity,
  OperationImage,
  OperationLocation,
  OperationManifestSnapshot,
  OperationPlan,
  OperationPlanInput,
  OperationResourceIdentity,
  OperationSelection,
  OperationSource,
  PlanningDiagnostic,
  PlanningToolContext,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import {
  type ContentObservationIdentityV1,
  type ExpectedRevisionV1,
  type LivePlacementStateV1,
  type ObservedComponentV1,
  type StoreStateV1,
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionPreconditionIdV1,
  createStoreSnapshotIdentityV1,
} from '../state/types.ts';
import type {
  InstallReport,
  InstallResult,
  InstallScope,
  UninstallReport,
  UninstallResult,
} from './types.ts';

export type AcquisitionArtifactSnapshotV1 =
  | Readonly<{
      mode: 'selected';
      pair: ResolvedArtifactPair;
      manifest: ObservedComponentV1<NormalizedManifestV1>;
      lock: ObservedComponentV1<PortableLockV1>;
    }>
  | Readonly<{ mode: 'none' }>;

export interface AcquisitionObservedStateSnapshotV1<CapabilityModel = unknown> {
  readonly schemaVersion: 1;
  readonly snapshotId: `snapshot:v1:${string}`;
  readonly project: ObservedComponentV1<ProjectContext>;
  readonly artifact: AcquisitionArtifactSnapshotV1;
  readonly ledger: ObservedComponentV1<LedgerModel>;
  readonly live: readonly ObservedComponentV1<LivePlacementStateV1>[];
  readonly store: readonly ObservedComponentV1<StoreStateV1>[];
  readonly capabilities: ObservedComponentV1<CapabilityModel>;
}

type AcquisitionPlanningContext = PlanningToolContext<string>;

const createCanonicalAcquisitionPlan = <Command extends CurrentMutatorCommand>(
  input: OperationPlanInput<Command>,
  context: AcquisitionPlanningContext | undefined,
): OperationPlan<Command> =>
  context === undefined
    ? createOperationPlan(input)
    : (createOperationPlan(input, context) as OperationPlan<Command>);

interface AcquisitionPlanRequestCommonV1 {
  readonly schemaVersion: 1;
  readonly selection: OperationSelection;
  readonly batchPolicy: 'fail-fast' | 'continue-on-error';
  readonly diagnostics?: readonly PlanningDiagnostic[];
  readonly compatibilityOperations?: readonly ExecutableOperation[];
  readonly artifactTransition?: AcquisitionArtifactTransitionEnvelopeV1;
}

type ManifestImageV1 = Extract<OperationImage, { readonly kind: 'manifest' }>;
type LockImageV1 = Extract<OperationImage, { readonly kind: 'lock' }>;
type AbsentManifestImageV1 = Readonly<{
  kind: 'absent';
  resource: Extract<OperationResourceIdentity, { readonly kind: 'manifest-bytes' }>;
}>;
type AbsentLockImageV1 = Readonly<{
  kind: 'absent';
  resource: Extract<OperationResourceIdentity, { readonly kind: 'lock' }>;
}>;

export interface AcquisitionArtifactTransitionGroupV1 {
  readonly groupIdentity: OperationGroupIdentity;
  readonly migrationAfter?: ManifestImageV1;
  readonly manifestAfter: ManifestImageV1;
  readonly lockAfter: LockImageV1;
}

export interface AcquisitionArtifactTransitionEnvelopeV1 {
  readonly initial: Readonly<{
    readonly manifest: ManifestImageV1 | AbsentManifestImageV1;
    readonly lock: LockImageV1 | AbsentLockImageV1;
  }>;
  readonly groups: readonly AcquisitionArtifactTransitionGroupV1[];
  readonly unchangedGroups?: readonly OperationGroupIdentity[];
}

export interface AcquisitionInstallPlanRequestV1 extends AcquisitionPlanRequestCommonV1 {
  readonly command: 'install';
  readonly intents: readonly AcquisitionInstallIntentV1[];
}

export interface AcquisitionUninstallPlanRequestV1 extends AcquisitionPlanRequestCommonV1 {
  readonly command: 'uninstall';
  readonly intents: readonly AcquisitionUninstallIntentV1[];
  /** Internal fresh-snapshot recovery intents; never encoded or exposed as placement work. */
  readonly artifactRecoveries?: readonly AcquisitionUninstallArtifactRecoveryIntentV1[];
}

export type AcquisitionPlanRequestV1 =
  | AcquisitionInstallPlanRequestV1
  | AcquisitionUninstallPlanRequestV1;

export interface AcquisitionDiagnosticPlanRequestV1<
  Command extends 'install' | 'uninstall' = 'install' | 'uninstall',
> extends AcquisitionPlanRequestCommonV1 {
  readonly command: Command;
}

export interface AcquisitionInstallIntentV1 {
  readonly kind: 'install';
  readonly execution?: 'selected' | 'desired-only';
  readonly skill: string;
  readonly tool: SupportedTool;
  readonly scope: 'user' | 'project';
  readonly projectRoot: OperationLocation | null;
  readonly liveResourceId: string;
  readonly storeResourceId: string;
  readonly force: boolean;
  readonly sourceContent: ContentObservationIdentityV1;
  readonly sourcePreconditionId: `precondition:v1:${string}`;
  readonly source: OperationSource;
  /** Canonical source-content digest for a portable artifact; placement/store remain legacy. */
  readonly portableContentHash?: OperationDigest;
  /** Exact portable-only fields that are not otherwise carried by the placement intent. */
  readonly declaration?: Readonly<{
    readonly ref: NormalizedManifestDeclaration['ref'];
    readonly path: NormalizedManifestDeclaration['path'];
  }>;
  readonly placement: Readonly<{
    classification: 'pinned';
    representation: 'symlink' | 'copy';
    location: OperationLocation;
  }>;
  readonly store: Readonly<{
    location: OperationLocation;
    contentHash: `sha256:${string}`;
    snapshotIdentity: string;
  }>;
}

export interface AcquisitionUninstallIntentV1 {
  readonly kind: 'remove';
  readonly skill: string;
  readonly tool: SupportedTool;
  readonly scope: 'user' | 'project';
  readonly projectRoot: OperationLocation | null;
  readonly liveResourceId: string;
  readonly storeResourceId: string | null;
  readonly force: boolean;
}

interface AcquisitionUninstallArtifactRecoveryIntentV1 {
  readonly kind: 'artifact-only-lock-repair';
  readonly skill: string;
  readonly scope: 'user' | 'project';
  readonly mode: 'reduced' | 'removed';
}

const relevantCapabilityQuery = (
  tool: string,
  operation: RelevantCapabilityQueryV1['operation'],
  scope: ToolCapabilityScope,
): RelevantCapabilityQueryV1 => Object.freeze({ schemaVersion: 1, tool, operation, scope });

export const createInstallCapabilityQueries = (
  registry: LifecycleToolRegistry<string>,
  intents: readonly AcquisitionInstallIntentV1[],
  opts: Readonly<{ noVerify?: boolean; deep?: boolean }>,
): readonly RelevantCapabilityQueryV1[] =>
  Object.freeze(
    intents.flatMap((intent) => {
      const queries = [relevantCapabilityQuery(intent.tool, 'install', intent.scope)];
      if (opts.noVerify) return queries;
      queries.push(relevantCapabilityQuery(intent.tool, 'verify-static', 'artifact'));
      if (opts.deep && registry.get(intent.tool)?.verification?.gatePolicy.installDeep === true) {
        queries.push(relevantCapabilityQuery(intent.tool, 'verify-deep', 'artifact'));
      }
      return queries;
    }),
  );

export const createUninstallCapabilityQueries = (
  prepared: readonly Readonly<{
    intent: AcquisitionUninstallIntentV1;
    capabilityScope: ToolCapabilityScope;
  }>[],
): readonly RelevantCapabilityQueryV1[] =>
  Object.freeze(
    prepared.map(({ intent, capabilityScope }) =>
      relevantCapabilityQuery(intent.tool, 'uninstall', capabilityScope),
    ),
  );

const planningError = (error: unknown): SnapshotPlanningErrorV1 =>
  Object.freeze({
    code: 'planning-invalid',
    message: error instanceof Error ? error.message : 'acquisition planning failed',
  });

const compareRevisionIdentity = (left: ExpectedRevisionV1, right: ExpectedRevisionV1): number => {
  const leftKey = `${left.domain}\u0000${left.resourceId}\u0000${left.revisionDigest}`;
  const rightKey = `${right.domain}\u0000${right.resourceId}\u0000${right.revisionDigest}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

const acquisitionExpectedRevisions = (
  snapshot: AcquisitionObservedStateSnapshotV1,
): readonly ExpectedRevisionV1[] => {
  const artifact =
    snapshot.artifact.mode === 'selected'
      ? [snapshot.artifact.manifest.revision, snapshot.artifact.lock.revision]
      : [];
  return Object.freeze(
    [
      snapshot.project.revision,
      ...artifact,
      snapshot.ledger.revision,
      ...snapshot.live.map(({ revision }) => revision),
      ...snapshot.store.map(({ revision }) => revision),
      snapshot.capabilities.revision,
    ]
      .map((revision) => Object.freeze(structuredClone(revision)))
      .sort(compareRevisionIdentity),
  );
};

const expectedRevisionIds = (snapshot: AcquisitionObservedStateSnapshotV1): readonly string[] =>
  Object.freeze(
    acquisitionExpectedRevisions(snapshot).map((revision) =>
      createExpectedRevisionPreconditionIdV1(revision),
    ),
  );

const bindAcquisitionPlanToSnapshotV1 = <Command extends CurrentMutatorCommand>(
  snapshot: AcquisitionObservedStateSnapshotV1,
  plan: OperationPlan<Command>,
): SnapshotBoundOperationPlanV1<Command> =>
  Object.freeze({
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    expectedRevisions: acquisitionExpectedRevisions(snapshot),
    plan,
  });

const installGroupIdentityFor = (
  request: AcquisitionInstallPlanRequestV1,
  intent: AcquisitionInstallIntentV1,
): OperationGroupIdentity => ({
  domain: 'skillsmith.operation-group-identity',
  schemaVersion: 1,
  command: request.command,
  skill: intent.skill,
  source: intent.source,
  scope: intent.scope,
  target: null,
});

const uninstallGroupIdentityFor = (
  request: AcquisitionUninstallPlanRequestV1,
  intent: AcquisitionUninstallIntentV1,
): OperationGroupIdentity => ({
  domain: 'skillsmith.operation-group-identity',
  schemaVersion: 1,
  command: request.command,
  skill: intent.skill,
  source: null,
  scope: intent.scope,
  target: intent.skill,
});

const manifestModelFromImage = (value: OperationManifestSnapshot): NormalizedManifestV1 => ({
  version: 1,
  ...(value.defaults === null
    ? {}
    : {
        defaults: {
          ...(value.defaults.tools === null ? {} : { tools: value.defaults.tools }),
          ...(value.defaults.scope === null ? {} : { scope: value.defaults.scope }),
          ...(value.defaults.path === null ? {} : { path: value.defaults.path }),
        },
      }),
  ...(value.registry === null || value.registry.default === null
    ? {}
    : { registry: { default: value.registry.default } }),
  skills: value.skills,
});

const operationManifestSnapshot = (value: NormalizedManifestV1): OperationManifestSnapshot => ({
  version: 1,
  defaults:
    value.defaults === undefined
      ? null
      : {
          tools: value.defaults.tools ?? null,
          scope: value.defaults.scope ?? null,
          path: value.defaults.path ?? null,
        },
  registry: value.registry === undefined ? null : { default: value.registry.default ?? null },
  skills: value.skills,
});

const artifactLocation = (path: string): OperationLocation => ({
  kind: 'machine-bound',
  path,
});

const imageLocation = (
  image: ManifestImageV1 | LockImageV1 | AbsentManifestImageV1 | AbsentLockImageV1,
): OperationLocation => (image.kind === 'absent' ? image.resource.location : image.location);

const requireArtifactLocation = (
  image: ManifestImageV1 | LockImageV1 | AbsentManifestImageV1 | AbsentLockImageV1,
  expected: OperationLocation,
): void => {
  if (canonicalPlanningString(imageLocation(image)) !== canonicalPlanningString(expected)) {
    throw new TypeError(
      'acquisition planning: artifact transition location differs from selected pair',
    );
  }
};

const validateManifestImage = (image: ManifestImageV1): void => {
  if (image.semanticHash !== hashManifestSemantics(manifestModelFromImage(image.value))) {
    throw new TypeError('acquisition planning: manifest transition semantic hash is incoherent');
  }
};

const validateLockImage = (image: LockImageV1): void => {
  const hashed = hashPortableLock(image.value as unknown as PortableLockV1);
  if (!hashed.ok || hashed.value !== image.canonicalHash) {
    throw new TypeError('acquisition planning: lock transition canonical hash is incoherent');
  }
};

const validateInitialArtifactImage = (
  image: ManifestImageV1 | AbsentManifestImageV1,
  observation: ObservedComponentV1<NormalizedManifestV1>,
): void => {
  const location = imageLocation(image);
  const targetIdentity = location.kind === 'machine-bound' ? location.path : null;
  if (image.kind === 'absent') {
    if (
      observation.revision.domain !== 'manifest' ||
      observation.revision.state !== 'absent' ||
      observation.revision.targetIdentity !== targetIdentity ||
      observation.value !== null
    ) {
      throw new TypeError('acquisition planning: manifest transition before image is stale');
    }
    return;
  }
  validateManifestImage(image);
  if (
    observation.revision.domain !== 'manifest' ||
    observation.revision.state !== 'present' ||
    observation.revision.targetIdentity !== targetIdentity ||
    observation.value === null ||
    observation.revision.byteRevision !== image.byteHash ||
    observation.revision.semanticRevision !== image.semanticHash ||
    canonicalPlanningString(operationManifestSnapshot(observation.value)) !==
      canonicalPlanningString(image.value)
  ) {
    throw new TypeError('acquisition planning: manifest transition before image is stale');
  }
};

const validateInitialLockImage = (
  image: LockImageV1 | AbsentLockImageV1,
  observation: ObservedComponentV1<PortableLockV1>,
): void => {
  const location = imageLocation(image);
  const targetIdentity = location.kind === 'machine-bound' ? location.path : null;
  if (image.kind === 'absent') {
    if (
      observation.revision.domain !== 'lock' ||
      observation.revision.state !== 'absent' ||
      observation.revision.targetIdentity !== targetIdentity ||
      observation.value !== null
    ) {
      throw new TypeError('acquisition planning: lock transition before image is stale');
    }
    return;
  }
  validateLockImage(image);
  if (
    observation.revision.domain !== 'lock' ||
    observation.revision.state !== 'present' ||
    observation.revision.targetIdentity !== targetIdentity ||
    observation.value === null ||
    observation.revision.semanticRevision !== image.canonicalHash ||
    canonicalPlanningString(observation.value) !== canonicalPlanningString(image.value)
  ) {
    throw new TypeError('acquisition planning: lock transition before image is stale');
  }
};

const liveObservationFor = (
  snapshot: AcquisitionObservedStateSnapshotV1,
  resourceId: string,
): AcquisitionObservedStateSnapshotV1['live'][number] => {
  const matches = snapshot.live.filter(
    (observation) =>
      observation.revision.domain === 'live' && observation.revision.resourceId === resourceId,
  );
  if (matches.length !== 1) {
    throw new TypeError('acquisition planning: live resource observation is missing or ambiguous');
  }
  const observation = matches[0] as AcquisitionObservedStateSnapshotV1['live'][number];
  const revision = observation.revision;
  const state = observation.value;
  if (revision.domain !== 'live') {
    throw new TypeError('acquisition planning: live resource observation is incoherent');
  }
  if (revision.state === 'absent') {
    if (state !== null) {
      throw new TypeError('acquisition planning: live resource observation is incoherent');
    }
    return observation;
  }
  const targetKind = state?.representation === 'directory' ? 'directory' : state?.representation;
  if (
    revision.state !== 'present' ||
    state === null ||
    revision.targetIdentity !== state.path ||
    revision.targetKind !== targetKind ||
    revision.contentRevision !== state.contentRevision
  ) {
    throw new TypeError('acquisition planning: live resource observation is incoherent');
  }
  return observation;
};

const storeObservationFor = (
  snapshot: AcquisitionObservedStateSnapshotV1,
  resourceId: string,
): AcquisitionObservedStateSnapshotV1['store'][number] => {
  const matches = snapshot.store.filter(
    (observation) =>
      observation.revision.domain === 'store' && observation.revision.resourceId === resourceId,
  );
  if (matches.length !== 1) {
    throw new TypeError('acquisition planning: store resource observation is missing or ambiguous');
  }
  const observation = matches[0] as AcquisitionObservedStateSnapshotV1['store'][number];
  const revision = observation.revision;
  const state = observation.value;
  if (revision.domain !== 'store') {
    throw new TypeError('acquisition planning: store resource observation is incoherent');
  }
  if (revision.state === 'absent') {
    if (state !== null) {
      throw new TypeError('acquisition planning: store resource observation is incoherent');
    }
    return observation;
  }
  if (
    revision.state !== 'present' ||
    state === null ||
    revision.targetIdentity !== state.path ||
    revision.contentRevision !== state.contentRevision ||
    revision.resourceRevision !== state.repositoryRevision ||
    revision.snapshotIdentity !== state.snapshotIdentity
  ) {
    throw new TypeError('acquisition planning: store resource observation is incoherent');
  }
  return observation;
};

const validateLiveSelection = (
  intent: AcquisitionInstallIntentV1 | AcquisitionUninstallIntentV1,
  observation: AcquisitionObservedStateSnapshotV1['live'][number],
  state: LivePlacementStateV1 | null,
): void => {
  const path =
    state === null && observation.revision.state === 'absent'
      ? observation.revision.targetIdentity
      : state?.path;
  if (
    (state !== null &&
      (state.skill !== intent.skill ||
        state.tool !== intent.tool ||
        state.scope !== intent.scope ||
        (intent.projectRoot?.kind === 'machine-bound' &&
          state.projectIdentity !== intent.projectRoot.path))) ||
    ('placement' in intent &&
      intent.placement.location.kind === 'machine-bound' &&
      path !== intent.placement.location.path)
  ) {
    throw new TypeError(`acquisition planning: live resource does not match ${intent.kind} intent`);
  }
};

interface AcquisitionStoreFactsV1 {
  readonly path: string;
  readonly state: StoreStateV1 | null;
}

const validateInstallStoreSelection = (
  intent: AcquisitionInstallIntentV1,
  observation: AcquisitionObservedStateSnapshotV1['store'][number],
): AcquisitionStoreFactsV1 => {
  const state = observation.value;
  const revision = observation.revision;
  const expectedSnapshotIdentity = createStoreSnapshotIdentityV1(
    intent.storeResourceId,
    intent.store.contentHash,
  );
  if (
    intent.store.snapshotIdentity !== expectedSnapshotIdentity ||
    (revision.state === 'present' &&
      (state === null ||
        state.contentRevision !== intent.store.contentHash ||
        state.snapshotIdentity !== expectedSnapshotIdentity)) ||
    (intent.store.location.kind === 'machine-bound' &&
      (revision.state === 'absent' ? revision.targetIdentity : state?.path) !==
        intent.store.location.path)
  ) {
    throw new TypeError('acquisition planning: store resource does not match install intent');
  }
  return {
    path: revision.state === 'absent' ? revision.targetIdentity : (state as StoreStateV1).path,
    state,
  };
};

const ledgerPairFor = (
  snapshot: AcquisitionObservedStateSnapshotV1,
  intent: AcquisitionInstallIntentV1 | AcquisitionUninstallIntentV1,
  observation: AcquisitionObservedStateSnapshotV1['live'][number],
  live: LivePlacementStateV1 | null,
): LedgerPairV1Dto | null => {
  const ledger = snapshot.ledger.value;
  if (
    (snapshot.ledger.revision.state === 'absent' && ledger !== null) ||
    (snapshot.ledger.revision.state === 'present' && ledger === null)
  ) {
    throw new TypeError('acquisition planning: ledger observation is incoherent');
  }
  if (ledger === null) return null;
  const projectIdentity =
    intent.scope === 'user'
      ? null
      : (live?.projectIdentity ??
        (intent.projectRoot?.kind === 'machine-bound' ? intent.projectRoot.path : null));
  const skills =
    projectIdentity === null ? ledger.skills : ledger.projects[projectIdentity]?.skills;
  const pair = skills?.[intent.skill]?.tools[intent.tool] ?? null;
  const livePath =
    live === null && observation.revision.state === 'absent'
      ? observation.revision.targetIdentity
      : live?.path;
  if (pair !== null && livePath !== pair.placementPath) {
    throw new TypeError('acquisition planning: ledger/live placement paths differ');
  }
  return pair;
};

const liveResourceFor = (
  intent: AcquisitionInstallIntentV1 | AcquisitionUninstallIntentV1,
  observation: AcquisitionObservedStateSnapshotV1['live'][number],
) => ({
  kind: 'live' as const,
  skill: intent.skill,
  tool: intent.tool,
  scope: intent.scope,
  projectRoot: intent.projectRoot,
  location: {
    kind: 'machine-bound' as const,
    path:
      observation.value === null && observation.revision.state === 'absent'
        ? observation.revision.targetIdentity
        : (observation.value as LivePlacementStateV1).path,
  },
});

const sameOperationSource = (
  left: OperationSource | null,
  right: OperationSource | null,
): boolean => {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind || left.contentHash !== right.contentHash) return false;
  if (left.kind === 'local-dev' && right.kind === 'local-dev') {
    return left.path === right.path;
  }
  if (left.kind === 'portable' && right.kind === 'portable') {
    return (
      left.identity.host === right.identity.host &&
      left.identity.repository === right.identity.repository &&
      left.identity.path === right.identity.path &&
      left.requestedRef === right.requestedRef &&
      left.resolvedSha === right.resolvedSha &&
      left.sourcePath === right.sourcePath
    );
  }
  return false;
};

const installAlreadyMatches = (
  intent: AcquisitionInstallIntentV1,
  live: LivePlacementStateV1 | null,
  store: AcquisitionStoreFactsV1,
  pair: LedgerPairV1Dto | null,
  beforeSource: OperationSource | null,
  pendingInstall: boolean,
): boolean => {
  if (
    intent.force ||
    pendingInstall ||
    live === null ||
    store.state === null ||
    pair?.mode !== 'pinned' ||
    pair.pinned == null ||
    live.brokenReason !== null ||
    live.dangling ||
    live.contentRevision !== intent.source.contentHash ||
    pair.pinned.contentHash !== intent.source.contentHash ||
    pair.pinned.storePath !== store.path ||
    (pair.pinned.placement !== undefined &&
      pair.pinned.placement !== intent.placement.representation) ||
    !sameOperationSource(beforeSource, intent.source)
  ) {
    return false;
  }
  if (intent.placement.representation === 'copy') {
    return live.representation === 'directory' && live.linkTarget === null;
  }
  return (
    live.representation === 'symlink' &&
    live.linkTarget !== null &&
    resolve(dirname(live.path), live.linkTarget) === resolve(store.path)
  );
};

const installOperationFor = (
  request: AcquisitionInstallPlanRequestV1,
  intent: AcquisitionInstallIntentV1,
  snapshot: AcquisitionObservedStateSnapshotV1,
  planningContext: AcquisitionPlanningContext | undefined,
): ExecutableOperation | null => {
  if (intent.execution === 'desired-only') return null;
  const sourceContent = createContentObservationIdentityV1(intent.sourceContent);
  if (
    intent.sourcePreconditionId !== createContentObservationPreconditionIdV1(sourceContent) ||
    sourceContent.contentRevision !== intent.source.contentHash ||
    intent.store.contentHash !== intent.source.contentHash
  ) {
    throw new TypeError('acquisition planning: source/store content revisions differ');
  }
  const liveObservation = liveObservationFor(snapshot, intent.liveResourceId);
  const liveState = liveObservation.value;
  validateLiveSelection(intent, liveObservation, liveState);
  const storeFacts = validateInstallStoreSelection(
    intent,
    storeObservationFor(snapshot, intent.storeResourceId),
  );
  const ledgerPair = ledgerPairFor(snapshot, intent, liveObservation, liveState);
  const pendingInstall =
    (ledgerPair?.journal?.op === 'install' && ledgerPair.journal.phase !== 'committed') ||
    Object.values(snapshot.ledger.value?.transactions ?? {}).some(
      ({ intent: pending }) =>
        pending.kind === 'install' &&
        pending.skill === intent.skill &&
        pending.tool === intent.tool &&
        pending.scope === intent.scope,
    );
  const beforeSource = operationSourceFromLedgerPairV1(ledgerPair, liveState);
  if (
    installAlreadyMatches(intent, liveState, storeFacts, ledgerPair, beforeSource, pendingInstall)
  ) {
    return null;
  }
  const liveResource = liveResourceFor(intent, liveObservation);
  const conflict: BoundedConflict | null =
    intent.force && liveState !== null
      ? ledgerPair === null
        ? {
            class: 'unmanaged-target',
            normal: 'refuse',
            forced: 'backup-and-replace',
            target: liveResource,
            backup: 'required',
          }
        : beforeSource !== null && !sameOperationSource(beforeSource, intent.source)
          ? {
              class: 'source-changed',
              normal: 'refuse',
              forced: 'replace',
              target: liveResource,
              backup: 'none',
            }
          : null
      : null;
  const desiredRepresentationMatches =
    liveState !== null &&
    liveState.brokenReason === null &&
    liveState.contentRevision === intent.source.contentHash &&
    (intent.placement.representation === 'copy'
      ? liveState.representation === 'directory' && liveState.linkTarget === null
      : liveState.representation === 'symlink' &&
        liveState.linkTarget !== null &&
        resolve(dirname(liveState.path), liveState.linkTarget) === resolve(storeFacts.path));
  const operationKind: ExecutableOperation['kind'] =
    pendingInstall || liveState === null
      ? 'install'
      : liveState.brokenReason !== null || (ledgerPair === null && desiredRepresentationMatches)
        ? 'repair'
        : 'update';
  const groupId = createOperationGroupId(installGroupIdentityFor(request, intent));
  const pairIdentity = {
    domain: 'skillsmith.operation-pair-identity' as const,
    schemaVersion: 1 as const,
    groupId,
    tool: intent.tool,
    resource: liveResource,
  };
  const pairId =
    planningContext === undefined
      ? createOperationPairId(pairIdentity)
      : createOperationPairId(pairIdentity, planningContext);
  const operationIdentity = {
    domain: 'skillsmith.operation-identity' as const,
    schemaVersion: 1 as const,
    groupId,
    pairId,
    kind: operationKind,
    skill: intent.skill,
    source: intent.source,
    tool: intent.tool,
    scope: intent.scope,
  };
  const operationId =
    planningContext === undefined
      ? createOperationId(operationIdentity)
      : createOperationId(operationIdentity, planningContext);
  return {
    operationId,
    groupId,
    pairId,
    kind: operationKind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: intent.skill,
    source: intent.source,
    tool: intent.tool,
    scope: intent.scope,
    before: operationImageFromLiveStateV1({
      resource: liveResource,
      state: liveState,
      managed: ledgerPair !== null,
      source: beforeSource,
    }),
    after: {
      kind: 'placement',
      resource: liveResource,
      classification: intent.placement.classification,
      representation: intent.placement.representation,
      linkTarget:
        intent.placement.representation === 'symlink'
          ? { kind: 'machine-bound', path: storeFacts.path }
          : null,
      dangling: false,
      source: intent.source,
      contentHash: intent.source.contentHash,
    },
    reason: {
      code: `${operationKind}-selected`,
      message: `${operationKind === 'install' ? 'Install' : operationKind === 'update' ? 'Update' : 'Repair'} ${intent.skill} for ${intent.tool}.`,
    },
    selectionSource: request.selection.source,
    preconditionIds: [...expectedRevisionIds(snapshot), intent.sourcePreconditionId],
    requiredCheckIds: [],
    reversibility: { kind: 'conditional', retentionResourceIds: [pairId] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict,
  };
};

const uninstallOperationFor = (
  request: AcquisitionUninstallPlanRequestV1,
  intent: AcquisitionUninstallIntentV1,
  snapshot: AcquisitionObservedStateSnapshotV1,
  planningContext: AcquisitionPlanningContext | undefined,
): ExecutableOperation | null => {
  const liveObservation = liveObservationFor(snapshot, intent.liveResourceId);
  const liveState = liveObservation.value;
  validateLiveSelection(intent, liveObservation, liveState);
  const ledgerPair = ledgerPairFor(snapshot, intent, liveObservation, liveState);
  if (liveState === null && ledgerPair === null) {
    const groupId = createOperationGroupId(uninstallGroupIdentityFor(request, intent));
    const ownsArtifactOnlyRemoval = request.artifactTransition?.groups.some(
      ({ groupIdentity }) => createOperationGroupId(groupIdentity) === groupId,
    );
    if (ownsArtifactOnlyRemoval) return null;
    throw new TypeError('acquisition planning: uninstall intent has no live or ledger state');
  }
  if (ledgerPair?.pinned != null) {
    if (intent.storeResourceId === null) {
      throw new TypeError('acquisition planning: pinned uninstall requires a store resource');
    }
    const storeObservation = storeObservationFor(snapshot, intent.storeResourceId);
    const storePath =
      storeObservation.revision.state === 'absent'
        ? storeObservation.revision.targetIdentity
        : (storeObservation.value as StoreStateV1).path;
    if (
      storePath !== ledgerPair.pinned.storePath ||
      (storeObservation.value !== null &&
        storeObservation.value.contentRevision !== ledgerPair.pinned.contentHash)
    ) {
      throw new TypeError('acquisition planning: store resource does not match uninstall intent');
    }
  } else if (intent.storeResourceId !== null) {
    storeObservationFor(snapshot, intent.storeResourceId);
  }
  const liveResource = liveResourceFor(intent, liveObservation);
  const beforeSource = operationSourceFromLedgerPairV1(ledgerPair, liveState);
  const pinned = ledgerPair?.pinned ?? null;
  const pinnedCopyModified =
    pinned !== null &&
    (pinned.placement ?? 'copy') === 'copy' &&
    liveState?.representation === 'directory' &&
    liveState.contentRevision !== pinned.contentHash;
  const conflict: BoundedConflict | null =
    !intent.force || liveState === null
      ? null
      : ledgerPair === null
        ? {
            class: 'unmanaged-target',
            normal: 'refuse',
            forced: 'backup-and-replace',
            target: liveResource,
            backup: 'required',
          }
        : ledgerPair.mode === 'dev'
          ? {
              class: 'source-changed',
              normal: 'refuse',
              forced: 'replace',
              target: liveResource,
              backup: 'none',
            }
          : pinnedCopyModified
            ? {
                class: 'modified-managed-target',
                normal: 'refuse',
                forced: 'backup-and-replace',
                target: liveResource,
                backup: 'required',
              }
            : null;
  const before =
    liveState === null && ledgerPair !== null
      ? ({
          kind: 'placement',
          resource: liveResource,
          classification: ledgerPair.mode,
          representation:
            ledgerPair.mode === 'dev'
              ? 'symlink'
              : ledgerPair.pinned?.placement === 'symlink'
                ? 'symlink'
                : 'copy',
          linkTarget:
            ledgerPair.mode === 'dev' && ledgerPair.dev !== null
              ? ({ kind: 'machine-bound', path: ledgerPair.dev.resolvedPath } as const)
              : ledgerPair.pinned?.placement === 'symlink' && ledgerPair.pinned !== null
                ? ({ kind: 'machine-bound', path: ledgerPair.pinned.storePath } as const)
                : null,
          dangling: true,
          source: beforeSource,
          contentHash:
            beforeSource === null
              ? null
              : ((ledgerPair.pinned?.contentHash as OperationDigest | undefined) ??
                beforeSource.contentHash),
        } as const)
      : operationImageFromLiveStateV1({
          resource: liveResource,
          state: liveState,
          managed: ledgerPair !== null,
          source: beforeSource,
        });
  const groupId = createOperationGroupId(uninstallGroupIdentityFor(request, intent));
  const pairIdentity = {
    domain: 'skillsmith.operation-pair-identity' as const,
    schemaVersion: 1 as const,
    groupId,
    tool: intent.tool,
    resource: liveResource,
  };
  const pairId =
    planningContext === undefined
      ? createOperationPairId(pairIdentity)
      : createOperationPairId(pairIdentity, planningContext);
  const operationIdentity = {
    domain: 'skillsmith.operation-identity' as const,
    schemaVersion: 1 as const,
    groupId,
    pairId,
    kind: intent.kind,
    skill: intent.skill,
    source: null,
    tool: intent.tool,
    scope: intent.scope,
  };
  const operationId =
    planningContext === undefined
      ? createOperationId(operationIdentity)
      : createOperationId(operationIdentity, planningContext);
  return {
    operationId,
    groupId,
    pairId,
    kind: intent.kind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: intent.skill,
    source: null,
    tool: intent.tool,
    scope: intent.scope,
    before,
    after: { kind: 'absent', resource: liveResource },
    reason: {
      code: 'remove-selected',
      message: `Remove ${intent.skill} for ${intent.tool}.`,
    },
    selectionSource: request.selection.source,
    preconditionIds: expectedRevisionIds(snapshot),
    requiredCheckIds: [],
    reversibility: { kind: 'conditional', retentionResourceIds: [pairId] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict,
  };
};

const artifactOperationFor = (
  request: AcquisitionPlanRequestV1,
  groupId: string,
  kind: 'migrate-project-config' | 'write-manifest' | 'write-lock',
  before: OperationImage,
  after: OperationImage,
  dependencies: readonly string[],
  additionalPreconditionIds: readonly string[],
  snapshot: AcquisitionObservedStateSnapshotV1,
  planningContext: AcquisitionPlanningContext | undefined,
): ExecutableOperation => {
  const identity = {
    domain: 'skillsmith.operation-identity' as const,
    schemaVersion: 1 as const,
    groupId,
    pairId: null,
    kind,
    skill: null,
    source: null,
    tool: null,
    scope: null,
  };
  const operationId =
    planningContext === undefined
      ? createOperationId(identity)
      : createOperationId(identity, planningContext);
  return {
    operationId,
    groupId,
    pairId: null,
    kind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: dependencies,
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before,
    after,
    reason: { code: `${kind}-required`, message: `${kind} is required for desired state.` },
    selectionSource: request.selection.source,
    preconditionIds: [...expectedRevisionIds(snapshot), ...additionalPreconditionIds],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates:
      kind === 'write-lock'
        ? { live: false, manifest: false, lock: true, ledger: false }
        : { live: false, manifest: true, lock: false, ledger: false },
    conflict: null,
  };
};

const withDependencies = (
  operation: ExecutableOperation,
  dependencies: readonly string[],
): ExecutableOperation => ({
  ...operation,
  dependencyMetadata: {
    ...operation.dependencyMetadata,
    operationIds: [...new Set([...operation.dependencyMetadata.operationIds, ...dependencies])],
  },
});

const expectedAcquisitionGroupIds = (request: AcquisitionPlanRequestV1): ReadonlySet<string> =>
  new Set(
    request.command === 'install'
      ? request.intents.map((intent) =>
          createOperationGroupId(installGroupIdentityFor(request, intent)),
        )
      : [
          ...request.intents.map((intent) =>
            createOperationGroupId(uninstallGroupIdentityFor(request, intent)),
          ),
          ...(request.artifactRecoveries ?? []).map((recovery) =>
            createOperationGroupId({
              domain: 'skillsmith.operation-group-identity',
              schemaVersion: 1,
              command: 'uninstall',
              skill: recovery.skill,
              source: null,
              scope: recovery.scope,
              target: recovery.skill,
            }),
          ),
        ],
  );

const portableSourceToken = (
  source: Extract<OperationSource, { readonly kind: 'portable' }>['identity'],
): string => `${source.host}/${source.repository}${source.path === null ? '' : `//${source.path}`}`;

const portablePairIsCurrent = (manifest: ManifestImageV1, lock: LockImageV1): boolean => {
  if (lock.value.manifestHash !== manifest.semanticHash) return false;
  const declarations = new Map(
    manifest.value.skills.map((declaration) => [declaration.name, declaration]),
  );
  const lockedSkills = new Map(lock.value.skills.map((locked) => [locked.name, locked]));
  if (
    declarations.size !== manifest.value.skills.length ||
    lockedSkills.size !== lock.value.skills.length ||
    declarations.size !== lockedSkills.size
  ) {
    return false;
  }
  return [...declarations].every(([name, declaration]) => {
    const locked = lockedSkills.get(name);
    return (
      locked !== undefined &&
      locked.source === portableSourceToken(declaration.source) &&
      (locked.requestedRef === declaration.ref || locked.resolvedSha === declaration.ref) &&
      locked.sourcePath === (declaration.source.path ?? '.')
    );
  });
};

const validateInstallGroupPortableIntent = (
  request: AcquisitionInstallPlanRequestV1,
  groupId: string,
  manifest: ManifestImageV1 | AbsentManifestImageV1,
  lock: LockImageV1 | AbsentLockImageV1,
): void => {
  if (
    manifest.kind !== 'manifest' ||
    lock.kind !== 'lock' ||
    !portablePairIsCurrent(manifest, lock)
  ) {
    throw new TypeError('acquisition planning: install group requires current portable state');
  }
  const intents = request.intents.filter(
    (intent) => createOperationGroupId(installGroupIdentityFor(request, intent)) === groupId,
  );
  const seed = intents[0];
  const portableContentHash =
    seed?.portableContentHash ??
    (seed?.source.kind === 'portable' ? seed.source.contentHash : null);
  if (
    seed === undefined ||
    seed.source.kind !== 'portable' ||
    seed.declaration === undefined ||
    portableContentHash === null ||
    intents.some(
      (intent) =>
        intent.source.kind !== 'portable' ||
        intent.declaration === undefined ||
        (intent.portableContentHash ?? intent.source.contentHash) !== portableContentHash ||
        canonicalPlanningString(intent.declaration) !== canonicalPlanningString(seed.declaration) ||
        intent.placement.representation !== seed.placement.representation,
    )
  ) {
    throw new TypeError('acquisition planning: install group lacks complete portable intent');
  }
  const declarations = manifest.value.skills.filter(({ name }) => name === seed.skill);
  const lockedSkills = lock.value.skills.filter(({ name }) => name === seed.skill);
  const declaration = declarations[0];
  const locked = lockedSkills[0];
  const requestedTools = new Set(intents.map(({ tool }) => tool));
  if (
    declarations.length !== 1 ||
    lockedSkills.length !== 1 ||
    declaration === undefined ||
    locked === undefined ||
    requestedTools.size === 0 ||
    canonicalPlanningString(declaration.source) !== canonicalPlanningString(seed.source.identity) ||
    declaration.ref !== seed.declaration.ref ||
    declaration.scope !== seed.scope ||
    declaration.placement !== seed.placement.representation ||
    declaration.path !== seed.declaration.path ||
    declaration.tools.length !== requestedTools.size ||
    new Set(declaration.tools).size !== declaration.tools.length ||
    declaration.tools.some((tool) => !requestedTools.has(tool)) ||
    locked.source !== portableSourceToken(seed.source.identity) ||
    locked.requestedRef !== seed.source.requestedRef ||
    locked.resolvedSha !== seed.source.resolvedSha ||
    locked.sourcePath !== seed.source.sourcePath ||
    locked.contentHash !== portableContentHash
  ) {
    throw new TypeError(
      'acquisition planning: install group differs from complete portable intent',
    );
  }
};

const validateUninstallGroupPortableIntent = (
  request: AcquisitionUninstallPlanRequestV1,
  groupId: string,
  manifestBefore: ManifestImageV1 | AbsentManifestImageV1,
  lockBefore: LockImageV1 | AbsentLockImageV1,
  manifestAfter: ManifestImageV1,
  lockAfter: LockImageV1,
): void => {
  const intents = request.intents.filter(
    (intent) => createOperationGroupId(uninstallGroupIdentityFor(request, intent)) === groupId,
  );
  const seed = intents[0];
  if (manifestBefore.kind !== 'manifest' || seed === undefined) {
    throw new TypeError('acquisition planning: uninstall group lacks declared portable intent');
  }
  const selectedTools = new Set(intents.map(({ tool }) => tool));
  const declarations = manifestBefore.value.skills.filter(({ name }) => name === seed.skill);
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    declaration === undefined ||
    declaration.scope !== seed.scope ||
    selectedTools.size === 0 ||
    new Set(declaration.tools).size !== declaration.tools.length ||
    [...selectedTools].some((tool) => !declaration.tools.includes(tool))
  ) {
    throw new TypeError('acquisition planning: uninstall group differs from declared intent');
  }

  const remainingTools = declaration.tools.filter((tool) => !selectedTools.has(tool));
  const beforeModel = manifestModelFromImage(manifestBefore.value);
  const declarationIndex = beforeModel.skills.findIndex(({ name }) => name === seed.skill);
  const expectedSkills = [...beforeModel.skills];
  if (remainingTools.length === 0) {
    expectedSkills.splice(declarationIndex, 1);
  } else {
    expectedSkills[declarationIndex] = { ...declaration, tools: remainingTools };
  }
  const expectedManifest: NormalizedManifestV1 = { ...beforeModel, skills: expectedSkills };
  if (
    canonicalPlanningString(manifestModelFromImage(manifestAfter.value)) !==
    canonicalPlanningString(expectedManifest)
  ) {
    throw new TypeError('acquisition planning: uninstall manifest transition is not exact');
  }

  let expectedLock: LockImageV1['value'];
  if (lockBefore.kind === 'lock') {
    if (!portablePairIsCurrent(manifestBefore, lockBefore)) {
      throw new TypeError('acquisition planning: uninstall group requires current portable state');
    }
    expectedLock = {
      ...lockBefore.value,
      manifestHash: manifestAfter.semanticHash,
      skills:
        remainingTools.length === 0
          ? lockBefore.value.skills.filter(({ name }) => name !== seed.skill)
          : lockBefore.value.skills,
    };
  } else {
    if (expectedManifest.skills.length !== 0 || remainingTools.length !== 0) {
      throw new TypeError(
        'acquisition planning: uninstall group cannot create unrelated lock state',
      );
    }
    expectedLock = {
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: manifestAfter.semanticHash,
      skills: [],
    };
  }
  if (canonicalPlanningString(lockAfter.value) !== canonicalPlanningString(expectedLock)) {
    throw new TypeError('acquisition planning: uninstall lock transition is not exact');
  }
};

const artifactRecoveryForGroup = (
  request: AcquisitionUninstallPlanRequestV1,
  groupId: string,
): AcquisitionUninstallArtifactRecoveryIntentV1 | null => {
  const recoveries = (request.artifactRecoveries ?? []).filter(
    (recovery) =>
      createOperationGroupId({
        domain: 'skillsmith.operation-group-identity',
        schemaVersion: 1,
        command: 'uninstall',
        skill: recovery.skill,
        source: null,
        scope: recovery.scope,
        target: recovery.skill,
      }) === groupId,
  );
  if (recoveries.length > 1) {
    throw new TypeError('acquisition planning: artifact recovery group is ambiguous');
  }
  return recoveries[0] ?? null;
};

const validateUninstallArtifactRecovery = (
  request: AcquisitionUninstallPlanRequestV1,
  groupId: string,
  manifestBefore: ManifestImageV1 | AbsentManifestImageV1,
  lockBefore: LockImageV1 | AbsentLockImageV1,
  manifestAfter: ManifestImageV1,
  lockAfter: LockImageV1,
): void => {
  const recovery = artifactRecoveryForGroup(request, groupId);
  const ordinaryIntents = request.intents.filter(
    (intent) => createOperationGroupId(uninstallGroupIdentityFor(request, intent)) === groupId,
  );
  if (
    recovery === null ||
    ordinaryIntents.length !== 0 ||
    manifestBefore.kind !== 'manifest' ||
    manifestBefore.shape !== 'canonical' ||
    lockBefore.kind !== 'lock' ||
    canonicalPlanningString(manifestBefore) !== canonicalPlanningString(manifestAfter) ||
    lockBefore.value.skills.filter(({ name }) => name === recovery.skill).length !== 1
  ) {
    throw new TypeError('acquisition planning: artifact-only uninstall recovery is incoherent');
  }
  const expectedLock: LockImageV1['value'] = {
    ...lockBefore.value,
    manifestHash: manifestAfter.semanticHash,
    skills:
      recovery.mode === 'removed'
        ? lockBefore.value.skills.filter(({ name }) => name !== recovery.skill)
        : lockBefore.value.skills,
  };
  if (
    (recovery.mode === 'removed') !==
      !manifestBefore.value.skills.some(({ name }) => name === recovery.skill) ||
    canonicalPlanningString(lockAfter.value) !== canonicalPlanningString(expectedLock) ||
    !portablePairIsCurrent(manifestAfter, lockAfter)
  ) {
    throw new TypeError('acquisition planning: artifact-only lock repair is not exact');
  }
};

const validateLegacyUninstallMigrationIntent = (
  request: AcquisitionUninstallPlanRequestV1,
  groupId: string,
  manifestAfter: ManifestImageV1,
  lockAfter: LockImageV1,
): void => {
  const intents = request.intents.filter(
    (intent) => createOperationGroupId(uninstallGroupIdentityFor(request, intent)) === groupId,
  );
  if (
    intents.length === 0 ||
    manifestAfter.shape !== 'canonical' ||
    manifestAfter.value.skills.length !== 0 ||
    lockAfter.value.skills.length !== 0 ||
    lockAfter.value.manifestHash !== manifestAfter.semanticHash
  ) {
    throw new TypeError('acquisition planning: legacy uninstall migration is incoherent');
  }
};

const createArtifactTransitionOperations = (
  request: AcquisitionPlanRequestV1,
  snapshot: AcquisitionObservedStateSnapshotV1,
  liveOperations: readonly ExecutableOperation[],
  planningContext: AcquisitionPlanningContext | undefined,
): readonly ExecutableOperation[] => {
  const transition = request.artifactTransition;
  if (transition === undefined) return liveOperations;
  if (snapshot.artifact.mode !== 'selected') {
    throw new TypeError('acquisition planning: artifact transitions require a selected pair');
  }
  const expectedGroups = expectedAcquisitionGroupIds(request);
  const groups = transition.groups.map((group) => ({
    ...group,
    groupId: createOperationGroupId(group.groupIdentity),
  }));
  const suppliedGroups = new Set(groups.map(({ groupId }) => groupId));
  const unchangedGroupIds = (transition.unchangedGroups ?? []).map((identity) =>
    createOperationGroupId(identity),
  );
  const unchangedGroups = new Set(unchangedGroupIds);
  const accountedGroups = new Set([...suppliedGroups, ...unchangedGroups]);
  if (
    suppliedGroups.size !== groups.length ||
    unchangedGroups.size !== unchangedGroupIds.length ||
    [...suppliedGroups].some((groupId) => unchangedGroups.has(groupId)) ||
    accountedGroups.size !== expectedGroups.size ||
    [...accountedGroups].some((groupId) => !expectedGroups.has(groupId))
  ) {
    throw new TypeError('acquisition planning: artifact transition groups differ from intents');
  }
  if (groups.filter(({ migrationAfter }) => migrationAfter !== undefined).length > 1) {
    throw new TypeError('acquisition planning: selected pair has multiple manifest migrations');
  }
  groups.sort((left, right) => {
    const leftRecovery =
      request.command === 'uninstall' && artifactRecoveryForGroup(request, left.groupId) !== null;
    const rightRecovery =
      request.command === 'uninstall' && artifactRecoveryForGroup(request, right.groupId) !== null;
    return (
      Number(rightRecovery) - Number(leftRecovery) ||
      (left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0)
    );
  });
  const groupsById = new Map(groups.map((group) => [group.groupId, group]));
  const collisionLaneGroupIds =
    request.command === 'install'
      ? [...accountedGroups].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      : groups.map(({ groupId }) => groupId);
  const manifestLocation = artifactLocation(snapshot.artifact.pair.file.path);
  const lockLocation = artifactLocation(snapshot.artifact.pair.lockfile.path);
  requireArtifactLocation(transition.initial.manifest, manifestLocation);
  requireArtifactLocation(transition.initial.lock, lockLocation);
  validateInitialArtifactImage(transition.initial.manifest, snapshot.artifact.manifest);
  validateInitialLockImage(transition.initial.lock, snapshot.artifact.lock);
  let currentManifest = transition.initial.manifest;
  let currentLock = transition.initial.lock;
  const artifacts: ExecutableOperation[] = [];
  let updatedLive = [...liveOperations];
  let artifactPrefixId: string | null = null;
  for (const groupId of collisionLaneGroupIds) {
    const group = groupsById.get(groupId);
    if (group === undefined) {
      if (request.command !== 'install' || !unchangedGroups.has(groupId)) {
        throw new TypeError('acquisition planning: artifact collision lane is incoherent');
      }
      validateInstallGroupPortableIntent(request, groupId, currentManifest, currentLock);
      if (artifactPrefixId !== null) {
        updatedLive = updatedLive.map((live) =>
          live.groupId === groupId ? withDependencies(live, [artifactPrefixId as string]) : live,
        );
      }
      continue;
    }
    const prefixDependencies = artifactPrefixId === null ? [] : [artifactPrefixId];
    const groupLive = [
      ...new Map(
        liveOperations
          .filter((operation) => operation.groupId === group.groupId)
          .map((operation) => [operation.operationId, operation]),
      ).values(),
    ];
    const sourcePreconditionIds =
      request.command === 'install'
        ? [
            ...new Set(
              request.intents
                .filter(
                  (intent) =>
                    createOperationGroupId(installGroupIdentityFor(request, intent)) ===
                    group.groupId,
                )
                .map(({ sourcePreconditionId }) => sourcePreconditionId),
            ),
          ]
        : [];
    let migrationId: string | null = null;
    if (group.migrationAfter !== undefined) {
      requireArtifactLocation(group.migrationAfter, manifestLocation);
      validateManifestImage(group.migrationAfter);
      if (
        currentManifest.kind !== 'manifest' ||
        currentManifest.shape !== 'legacy' ||
        group.migrationAfter.shape !== 'canonical' ||
        currentManifest.semanticHash !== group.migrationAfter.semanticHash ||
        canonicalPlanningString(currentManifest.value) !==
          canonicalPlanningString(group.migrationAfter.value)
      ) {
        throw new TypeError('acquisition planning: manifest migration transition is incoherent');
      }
      const migration = artifactOperationFor(
        request,
        group.groupId,
        'migrate-project-config',
        currentManifest,
        group.migrationAfter,
        prefixDependencies,
        sourcePreconditionIds,
        snapshot,
        planningContext,
      );
      artifacts.push(migration);
      migrationId = migration.operationId;
      currentManifest = group.migrationAfter;
    }
    requireArtifactLocation(group.manifestAfter, manifestLocation);
    requireArtifactLocation(group.lockAfter, lockLocation);
    validateManifestImage(group.manifestAfter);
    validateLockImage(group.lockAfter);
    const manifestChanged =
      canonicalPlanningString(currentManifest) !== canonicalPlanningString(group.manifestAfter);
    const manifestSemanticsChanged =
      currentManifest.kind !== 'manifest' ||
      currentManifest.semanticHash !== group.manifestAfter.semanticHash ||
      canonicalPlanningString(currentManifest.value) !==
        canonicalPlanningString(group.manifestAfter.value);
    const legacyUninstallMigration =
      request.command === 'uninstall' &&
      migrationId !== null &&
      !manifestChanged &&
      groupLive.length > 0;
    const artifactOnlyRecovery =
      request.command === 'uninstall' && artifactRecoveryForGroup(request, group.groupId) !== null;
    if (
      !manifestChanged &&
      request.command !== 'install' &&
      !legacyUninstallMigration &&
      !artifactOnlyRecovery
    ) {
      throw new TypeError('acquisition planning: uninstall transition requires a manifest write');
    }
    if (!portablePairIsCurrent(group.manifestAfter, group.lockAfter)) {
      throw new TypeError('acquisition planning: artifact transition pair is incoherent');
    }
    if (request.command === 'uninstall') {
      if (artifactOnlyRecovery) {
        if (migrationId !== null || groupLive.length !== 0) {
          throw new TypeError('acquisition planning: artifact-only recovery cannot own live work');
        }
        validateUninstallArtifactRecovery(
          request,
          group.groupId,
          currentManifest,
          currentLock,
          group.manifestAfter,
          group.lockAfter,
        );
      } else if (legacyUninstallMigration) {
        validateLegacyUninstallMigrationIntent(
          request,
          group.groupId,
          group.manifestAfter,
          group.lockAfter,
        );
      } else {
        validateUninstallGroupPortableIntent(
          request,
          group.groupId,
          currentManifest,
          currentLock,
          group.manifestAfter,
          group.lockAfter,
        );
      }
    }
    if (
      group.manifestAfter.shape !== 'canonical' ||
      (currentManifest.kind === 'manifest' && currentManifest.shape !== 'canonical') ||
      (manifestChanged && !manifestSemanticsChanged)
    ) {
      throw new TypeError('acquisition planning: manifest write transition is invalid');
    }
    if (
      group.lockAfter.value.manifestHash !== group.manifestAfter.semanticHash ||
      canonicalPlanningString(currentLock) === canonicalPlanningString(group.lockAfter)
    ) {
      throw new TypeError('acquisition planning: lock write transition is invalid or a noop');
    }
    const manifestDependencies =
      request.command === 'install'
        ? migrationId === null
          ? prefixDependencies
          : [migrationId, ...prefixDependencies]
        : groupLive.length > 0
          ? [...groupLive.map(({ operationId }) => operationId), ...prefixDependencies]
          : migrationId === null
            ? prefixDependencies
            : [migrationId, ...prefixDependencies];
    const manifest = !manifestChanged
      ? null
      : artifactOperationFor(
          request,
          group.groupId,
          'write-manifest',
          currentManifest,
          group.manifestAfter,
          manifestDependencies,
          sourcePreconditionIds,
          snapshot,
          planningContext,
        );
    const lock = artifactOperationFor(
      request,
      group.groupId,
      'write-lock',
      currentLock,
      group.lockAfter,
      manifest === null
        ? request.command === 'uninstall' && legacyUninstallMigration
          ? [
              migrationId as string,
              ...groupLive.map(({ operationId }) => operationId),
              ...prefixDependencies,
            ]
          : migrationId === null
            ? prefixDependencies
            : [migrationId, ...prefixDependencies]
        : [manifest.operationId, ...prefixDependencies],
      sourcePreconditionIds,
      snapshot,
      planningContext,
    );
    if (manifest !== null) artifacts.push(manifest);
    artifacts.push(lock);
    const dependencies =
      request.command === 'install'
        ? [lock.operationId, ...prefixDependencies]
        : migrationId === null
          ? prefixDependencies
          : [migrationId, ...prefixDependencies];
    updatedLive = updatedLive.map((live) =>
      live.groupId === group.groupId ? withDependencies(live, dependencies) : live,
    );
    currentManifest = group.manifestAfter;
    currentLock = group.lockAfter;
    artifactPrefixId = lock.operationId;
    if (request.command === 'install') {
      validateInstallGroupPortableIntent(request, group.groupId, currentManifest, currentLock);
    }
  }
  return [...artifacts, ...updatedLive];
};

const mergeDuplicateAcquisitionOperations = (
  operations: readonly ExecutableOperation[],
): readonly ExecutableOperation[] => {
  const merged = new Map<string, ExecutableOperation>();
  for (const operation of operations) {
    const existing = merged.get(operation.operationId);
    if (existing === undefined) {
      merged.set(operation.operationId, operation);
      continue;
    }
    if (
      canonicalPlanningString({ ...existing, preconditionIds: [] }) !==
      canonicalPlanningString({ ...operation, preconditionIds: [] })
    ) {
      throw new TypeError('acquisition planning: duplicate operation identity is ambiguous');
    }
    merged.set(operation.operationId, {
      ...existing,
      preconditionIds: [...new Set([...existing.preconditionIds, ...operation.preconditionIds])],
    });
  }
  return [...merged.values()];
};

export const createAcquisitionDiagnosticPlan = <Command extends 'install' | 'uninstall'>(
  request: AcquisitionDiagnosticPlanRequestV1<Command>,
  planningContext?: AcquisitionPlanningContext,
): Result<OperationPlan<Command>, SnapshotPlanningErrorV1> => {
  try {
    if (
      request.schemaVersion !== 1 ||
      (request.command !== 'install' && request.command !== 'uninstall') ||
      request.artifactTransition !== undefined ||
      (request.compatibilityOperations?.length ?? 0) !== 0
    ) {
      throw new TypeError('acquisition diagnostics planning: unsupported request');
    }
    return ok(
      createCanonicalAcquisitionPlan(
        {
          domain: 'skillsmith.operation-plan',
          schemaVersion: 1,
          command: request.command,
          selection: request.selection,
          batchPolicy: request.batchPolicy,
          operations: [],
          checks: [],
          diagnostics: request.diagnostics ?? [],
        },
        planningContext,
      ),
    );
  } catch (error) {
    return err(planningError(error));
  }
};

export function createAcquisitionPlan(
  request: AcquisitionInstallPlanRequestV1,
  snapshot: AcquisitionObservedStateSnapshotV1,
  planningContext?: AcquisitionPlanningContext,
): Result<SnapshotBoundOperationPlanV1<'install'>, SnapshotPlanningErrorV1>;
export function createAcquisitionPlan(
  request: AcquisitionUninstallPlanRequestV1,
  snapshot: AcquisitionObservedStateSnapshotV1,
  planningContext?: AcquisitionPlanningContext,
): Result<SnapshotBoundOperationPlanV1<'uninstall'>, SnapshotPlanningErrorV1>;
export function createAcquisitionPlan(
  request: AcquisitionPlanRequestV1,
  snapshot: AcquisitionObservedStateSnapshotV1,
  planningContext?: AcquisitionPlanningContext,
): Result<SnapshotBoundOperationPlanV1<'install' | 'uninstall'>, SnapshotPlanningErrorV1> {
  try {
    if (
      request.schemaVersion !== 1 ||
      (request.command !== 'install' && request.command !== 'uninstall')
    ) {
      throw new TypeError('acquisition planning: unsupported request');
    }
    if (request.command === 'install') {
      const compatibilityOperations = (request.compatibilityOperations ?? []).map((operation) => ({
        ...operation,
        preconditionIds: [
          ...new Set([...operation.preconditionIds, ...expectedRevisionIds(snapshot)]),
        ],
      }));
      const liveOperations = request.intents
        .map((intent) => installOperationFor(request, intent, snapshot, planningContext))
        .filter((operation): operation is ExecutableOperation => operation !== null);
      const plan = createCanonicalAcquisitionPlan(
        {
          domain: 'skillsmith.operation-plan',
          schemaVersion: 1,
          command: request.command,
          selection: request.selection,
          batchPolicy: request.batchPolicy,
          operations: mergeDuplicateAcquisitionOperations([
            ...compatibilityOperations,
            ...createArtifactTransitionOperations(
              request,
              snapshot,
              liveOperations,
              planningContext,
            ),
          ]),
          checks: [],
          diagnostics: request.diagnostics ?? [],
        },
        planningContext,
      );
      return ok(bindAcquisitionPlanToSnapshotV1(snapshot, plan));
    }
    const compatibilityOperations = (request.compatibilityOperations ?? []).map((operation) => ({
      ...operation,
      preconditionIds: [
        ...new Set([...operation.preconditionIds, ...expectedRevisionIds(snapshot)]),
      ],
    }));
    const liveOperations = request.intents
      .map((intent) => uninstallOperationFor(request, intent, snapshot, planningContext))
      .filter((operation): operation is ExecutableOperation => operation !== null);
    const plan = createCanonicalAcquisitionPlan(
      {
        domain: 'skillsmith.operation-plan',
        schemaVersion: 1,
        command: request.command,
        selection: request.selection,
        batchPolicy: request.batchPolicy,
        operations: mergeDuplicateAcquisitionOperations([
          ...compatibilityOperations,
          ...createArtifactTransitionOperations(request, snapshot, liveOperations, planningContext),
        ]),
        checks: [],
        diagnostics: request.diagnostics ?? [],
      },
      planningContext,
    );
    return ok(bindAcquisitionPlanToSnapshotV1(snapshot, plan));
  } catch (error) {
    return err(planningError(error));
  }
}

const compatibilityLiveResource = (
  skill: string,
  tool: SupportedTool,
  scope: InstallScope,
  path: string,
  projectRoot: string | null = null,
) => ({
  kind: 'live' as const,
  skill,
  tool,
  scope,
  projectRoot:
    scope === 'project' && projectRoot !== null
      ? ({ kind: 'machine-bound' as const, path: projectRoot } as const)
      : null,
  location: { kind: 'machine-bound' as const, path },
});

const compatibilityAbsentImage = (
  skill: string,
  tool: SupportedTool,
  scope: InstallScope,
  path: string,
  projectRoot: string | null = null,
): OperationImage => ({
  kind: 'absent',
  resource: compatibilityLiveResource(skill, tool, scope, path, projectRoot),
});

const compatibilityPlacementImage = (
  skill: string,
  tool: SupportedTool,
  scope: InstallScope,
  path: string,
  mode: 'dev' | 'pinned',
  representation: 'symlink' | 'copy' | 'other',
  linkTarget: string | null = null,
  projectRoot: string | null = null,
): OperationImage => ({
  kind: 'placement',
  resource: compatibilityLiveResource(skill, tool, scope, path, projectRoot),
  classification: mode,
  representation,
  linkTarget: linkTarget === null ? null : { kind: 'machine-bound', path: linkTarget },
  dangling: false,
  source: null,
  contentHash: null,
});

const closedCompatibilityPlanningText = (value: string | null, fallback: string): string =>
  value !== null && value.length > 0 && !containsSensitiveMaterial(value) ? value : fallback;

const compatibilityPlanningDiagnostic = (
  family: 'install' | 'uninstall',
  result: InstallResult | UninstallResult,
  planningContext: AcquisitionPlanningContext | undefined,
): PlanningDiagnostic => {
  const skipped = result.action === 'skipped';
  const noop = result.action === 'noop';
  const refused = result.action === 'refused' || result.action === 'failed';
  const kind = noop ? 'noop' : skipped ? 'skip' : refused ? 'refuse' : 'warning';
  const severity = refused ? 'error' : 'info';
  const refusalClass = refused ? 'state' : null;
  const affected = {
    skill: result.skill,
    source: null,
    tool: result.tool,
    scope: result.scope,
    path:
      result.placementPath === null
        ? null
        : { kind: 'machine-bound' as const, path: result.placementPath },
  };
  const correlation = { groupId: null, pairId: null, operationId: null };
  const reasonCode = result.error?.code ?? (noop ? 'noop' : skipped ? 'skip' : 'refuse');
  const diagnosticIdentity = {
    domain: 'skillsmith.planning-diagnostic-identity',
    schemaVersion: 1,
    kind,
    severity,
    refusalClass,
    affected,
    correlation,
    reasonCode,
    selectionSource: 'explicit-targets',
  } as const;
  const diagnosticId =
    planningContext === undefined
      ? createPlanningDiagnosticId(diagnosticIdentity)
      : createPlanningDiagnosticId(diagnosticIdentity, planningContext);
  return {
    diagnosticId,
    kind,
    severity,
    refusalClass,
    affected,
    correlation,
    reason: {
      code: reasonCode,
      message: closedCompatibilityPlanningText(result.reason, `${family} ${result.action}`),
    },
    selectionSource: 'explicit-targets',
  };
};

export interface InstallCompatibilityPlanning {
  readonly plan: OperationPlan<'install'>;
  readonly operationResults: ReadonlyMap<string, InstallResult>;
}

/** Pure compatibility projection retained while current install orchestration adopts snapshots. */
export const createInstallPlanning = (
  requested: InstallReport['requested'],
  results: readonly InstallResult[],
  continueOnError: boolean,
  projectRoot: string | null = null,
  planningContext?: AcquisitionPlanningContext,
): InstallCompatibilityPlanning => {
  const operations: ExecutableOperation[] = [];
  const operationResults = new Map<string, InstallResult>();
  const diagnostics: PlanningDiagnostic[] = [];
  const diagnosticIds = new Set<string>();
  for (const [index, result] of results.entries()) {
    if (
      result.skill === null ||
      result.tool === null ||
      result.placementPath === null ||
      result.action === 'noop' ||
      result.action === 'skipped' ||
      result.action === 'refused' ||
      result.action === 'failed'
    ) {
      const diagnostic = compatibilityPlanningDiagnostic('install', result, planningContext);
      if (!diagnosticIds.has(diagnostic.diagnosticId)) {
        diagnosticIds.add(diagnostic.diagnosticId);
        diagnostics.push(diagnostic);
      }
      continue;
    }
    const kind: ExecutableOperation['kind'] =
      result.action === 'updated' ? 'update' : result.action === 'repaired' ? 'repair' : 'install';
    const requestIndex = result.requestIndex ?? index;
    const planningSource = closedCompatibilityPlanningText(
      result.source,
      `rejected-source:${requestIndex}`,
    );
    const resource = compatibilityLiveResource(
      result.skill,
      result.tool,
      result.scope,
      result.placementPath,
      projectRoot,
    );
    const groupId = createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'install',
      skill: result.skill,
      source: null,
      scope: result.scope,
      target: planningSource,
    });
    const pairIdentity = {
      domain: 'skillsmith.operation-pair-identity',
      schemaVersion: 1,
      groupId,
      tool: result.tool,
      resource,
    } as const;
    const pairId =
      planningContext === undefined
        ? createOperationPairId(pairIdentity)
        : createOperationPairId(pairIdentity, planningContext);
    const operationIdentity = {
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId,
      pairId,
      kind,
      skill: result.skill,
      source: null,
      tool: result.tool,
      scope: result.scope,
    } as const;
    const operationId =
      planningContext === undefined
        ? createOperationId(operationIdentity)
        : createOperationId(operationIdentity, planningContext);
    if (operationResults.has(operationId)) continue;
    const before =
      result.action === 'installed'
        ? compatibilityAbsentImage(
            result.skill,
            result.tool,
            result.scope,
            result.placementPath,
            projectRoot,
          )
        : compatibilityPlacementImage(
            result.skill,
            result.tool,
            result.scope,
            result.placementPath,
            'pinned',
            result.placement ?? 'other',
            null,
            projectRoot,
          );
    const after = compatibilityPlacementImage(
      result.skill,
      result.tool,
      result.scope,
      result.placementPath,
      'pinned',
      result.placement ?? 'copy',
      null,
      projectRoot,
    );
    operations.push({
      operationId,
      groupId,
      pairId,
      kind,
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
      skill: result.skill,
      source: null,
      tool: result.tool,
      scope: result.scope,
      before,
      after,
      reason: { code: kind, message: `${kind} ${result.skill}` },
      selectionSource: 'explicit-targets',
      preconditionIds: [],
      requiredCheckIds: [],
      reversibility: { kind: 'conditional', retentionResourceIds: [pairId] },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      conflict: null,
    });
    operationResults.set(operationId, result);
  }
  const plan = createCanonicalAcquisitionPlan(
    {
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'install',
      selection: {
        source: 'explicit-targets',
        targets: [
          ...new Set(
            requested.sources.map((source, index) =>
              closedCompatibilityPlanningText(source, `rejected-source:${index}`),
            ),
          ),
        ],
        all: false,
        tools: requested.tools,
        scopes: [requested.scope],
        groupIds: [...new Set(operations.map((operation) => operation.groupId))],
      },
      batchPolicy: continueOnError ? 'continue-on-error' : 'fail-fast',
      operations,
      checks: [],
      diagnostics,
    },
    planningContext,
  );
  return { plan, operationResults };
};

export interface UninstallCompatibilityPlanning {
  readonly plan: OperationPlan<'uninstall'>;
  readonly operationResults: ReadonlyMap<string, UninstallResult>;
}

/** Pure compatibility projection retained while current uninstall orchestration adopts snapshots. */
export const createUninstallPlanning = (
  requested: UninstallReport['requested'],
  results: readonly UninstallResult[],
  projectRoot: string | null,
  planningContext?: AcquisitionPlanningContext,
): UninstallCompatibilityPlanning => {
  const operations: ExecutableOperation[] = [];
  const operationResults = new Map<string, UninstallResult>();
  const diagnostics: PlanningDiagnostic[] = [];
  const diagnosticIds = new Set<string>();
  for (const result of results) {
    if (
      result.tool === null ||
      result.scope === null ||
      result.placementPath === null ||
      result.action === 'noop' ||
      result.action === 'refused'
    ) {
      const diagnostic = compatibilityPlanningDiagnostic('uninstall', result, planningContext);
      if (!diagnosticIds.has(diagnostic.diagnosticId)) {
        diagnosticIds.add(diagnostic.diagnosticId);
        diagnostics.push(diagnostic);
      }
      continue;
    }
    const resource = compatibilityLiveResource(
      result.skill,
      result.tool,
      result.scope,
      result.placementPath,
      projectRoot,
    );
    const groupId = createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'uninstall',
      skill: result.skill,
      source: null,
      scope: result.scope,
      target: result.skill,
    });
    const pairIdentity = {
      domain: 'skillsmith.operation-pair-identity',
      schemaVersion: 1,
      groupId,
      tool: result.tool,
      resource,
    } as const;
    const pairId =
      planningContext === undefined
        ? createOperationPairId(pairIdentity)
        : createOperationPairId(pairIdentity, planningContext);
    const operationIdentity = {
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId,
      pairId,
      kind: 'remove',
      skill: result.skill,
      source: null,
      tool: result.tool,
      scope: result.scope,
    } as const;
    const operationId =
      planningContext === undefined
        ? createOperationId(operationIdentity)
        : createOperationId(operationIdentity, planningContext);
    if (operationResults.has(operationId)) continue;
    const before = compatibilityPlacementImage(
      result.skill,
      result.tool,
      result.scope,
      result.placementPath,
      result.before?.mode ?? 'pinned',
      result.before?.placement ?? (result.before?.mode === 'dev' ? 'symlink' : 'copy'),
      result.before?.symlinkTarget ?? null,
      projectRoot,
    );
    const after = compatibilityAbsentImage(
      result.skill,
      result.tool,
      result.scope,
      result.placementPath,
      projectRoot,
    );
    operations.push({
      operationId,
      groupId,
      pairId,
      kind: 'remove',
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
      skill: result.skill,
      source: null,
      tool: result.tool,
      scope: result.scope,
      before,
      after,
      reason: { code: 'remove', message: `remove ${result.skill}` },
      selectionSource: 'explicit-targets',
      preconditionIds: [],
      requiredCheckIds: [],
      reversibility: { kind: 'conditional', retentionResourceIds: [pairId] },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      conflict: null,
    });
    operationResults.set(operationId, result);
  }
  const selectedScopes = [
    ...new Set(
      results
        .map((result) => result.scope)
        .filter((scope): scope is InstallScope => scope !== null),
    ),
  ];
  if (selectedScopes.length === 0 && requested.scope !== null) selectedScopes.push(requested.scope);
  const plan = createCanonicalAcquisitionPlan(
    {
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'uninstall',
      selection: {
        source: 'explicit-targets',
        targets: requested.targets,
        all: requested.allScopes,
        tools: requested.tools,
        scopes: selectedScopes,
        groupIds: [...new Set(operations.map((operation) => operation.groupId))],
      },
      batchPolicy: 'fail-fast',
      operations,
      checks: [],
      diagnostics,
    },
    planningContext,
  );
  return { plan, operationResults };
};
