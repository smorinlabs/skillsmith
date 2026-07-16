import { dirname, resolve } from 'node:path';
import type { ToolCapabilityScope } from '../agents/adapter-types.ts';
import type { RelevantCapabilityQueryV1 } from '../agents/capabilities.ts';
import type { LifecycleToolRegistry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import type { LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import {
  type SnapshotBoundOperationPlanV1,
  type SnapshotPlanningErrorV1,
  bindOperationPlanToSnapshotV1,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
  createPlanningDiagnosticId,
  expectedRevisionPreconditionIdsForSnapshotV1,
  operationImageFromLiveStateV1,
  operationSourceFromLedgerPairV1,
} from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  CurrentMutatorCommand,
  ExecutableOperation,
  OperationDigest,
  OperationImage,
  OperationLocation,
  OperationPlan,
  OperationPlanInput,
  OperationSelection,
  OperationSource,
  PlanningDiagnostic,
  PlanningToolContext,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import {
  type ContentObservationIdentityV1,
  type LivePlacementStateV1,
  type ObservedStateSnapshotV1,
  type StoreStateV1,
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createStoreSnapshotIdentityV1,
} from '../state/types.ts';
import type {
  InstallReport,
  InstallResult,
  InstallScope,
  UninstallReport,
  UninstallResult,
} from './types.ts';

type AcquisitionObservedStateSnapshotV1 = ObservedStateSnapshotV1<unknown>;
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
}

export interface AcquisitionInstallPlanRequestV1 extends AcquisitionPlanRequestCommonV1 {
  readonly command: 'install';
  readonly intents: readonly AcquisitionInstallIntentV1[];
}

export interface AcquisitionUninstallPlanRequestV1 extends AcquisitionPlanRequestCommonV1 {
  readonly command: 'uninstall';
  readonly intents: readonly AcquisitionUninstallIntentV1[];
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

const expectedRevisionIds = (snapshot: AcquisitionObservedStateSnapshotV1): readonly string[] =>
  expectedRevisionPreconditionIdsForSnapshotV1(snapshot);

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
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: request.command,
    skill: intent.skill,
    source: intent.source,
    scope: intent.scope,
    target: null,
  });
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
    conflict: null,
  };
};

const uninstallOperationFor = (
  request: AcquisitionUninstallPlanRequestV1,
  intent: AcquisitionUninstallIntentV1,
  snapshot: AcquisitionObservedStateSnapshotV1,
  planningContext: AcquisitionPlanningContext | undefined,
): ExecutableOperation => {
  const liveObservation = liveObservationFor(snapshot, intent.liveResourceId);
  const liveState = liveObservation.value;
  validateLiveSelection(intent, liveObservation, liveState);
  const ledgerPair = ledgerPairFor(snapshot, intent, liveObservation, liveState);
  if (liveState === null && ledgerPair === null) {
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
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: request.command,
    skill: intent.skill,
    source: null,
    scope: intent.scope,
    target: intent.skill,
  });
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
    conflict: null,
  };
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
      const plan = createCanonicalAcquisitionPlan(
        {
          domain: 'skillsmith.operation-plan',
          schemaVersion: 1,
          command: request.command,
          selection: request.selection,
          batchPolicy: request.batchPolicy,
          operations: mergeDuplicateAcquisitionOperations([
            ...compatibilityOperations,
            ...request.intents
              .map((intent) => installOperationFor(request, intent, snapshot, planningContext))
              .filter((operation): operation is ExecutableOperation => operation !== null),
          ]),
          checks: [],
          diagnostics: request.diagnostics ?? [],
        },
        planningContext,
      );
      return ok(bindOperationPlanToSnapshotV1(snapshot, plan));
    }
    const compatibilityOperations = (request.compatibilityOperations ?? []).map((operation) => ({
      ...operation,
      preconditionIds: [
        ...new Set([...operation.preconditionIds, ...expectedRevisionIds(snapshot)]),
      ],
    }));
    const plan = createCanonicalAcquisitionPlan(
      {
        domain: 'skillsmith.operation-plan',
        schemaVersion: 1,
        command: request.command,
        selection: request.selection,
        batchPolicy: request.batchPolicy,
        operations: mergeDuplicateAcquisitionOperations([
          ...compatibilityOperations,
          ...request.intents.map((intent) =>
            uninstallOperationFor(request, intent, snapshot, planningContext),
          ),
        ]),
        checks: [],
        diagnostics: request.diagnostics ?? [],
      },
      planningContext,
    );
    return ok(bindOperationPlanToSnapshotV1(snapshot, plan));
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
