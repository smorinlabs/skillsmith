import { dirname, resolve } from 'node:path';
import type { RelevantCapabilityQueryV1 } from '../agents/capabilities.ts';
import { toolRegistry } from '../agents/registry.ts';
import type { ArtifactCoordinatorPorts } from '../artifacts/coordinator-types.ts';
import {
  artifactLockImageFromBytesV1,
  artifactManifestImageFromBytesV1,
  withArtifactPairExecutionAuthority,
} from '../artifacts/execution.ts';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import type { SkillSmithError } from '../errors.ts';
import {
  createContentObservationExecutionPrecondition,
  createExpectedRevisionExecutionPrecondition,
} from '../execution/preconditions.ts';
import type { ExecutionPrecondition } from '../execution/types.ts';
import type { ObservationBundle } from '../observation/index.ts';
import {
  type PlacementCoordinatorBinding,
  type PlacementSnapshotAuthority,
  type PlacementStoreResource,
  createPlacementExecutionInput,
  createPlacementSnapshotAuthority,
  executeCommittedPlacementReversalWithObservation,
  executePlacementOperationPlan,
  placementSnapshotResourceId,
} from '../place/execute.ts';
import { prepareLedgerMigration } from '../place/ledger-migration.ts';
import { resolveDataDir, storeRootOf } from '../place/paths.ts';
import type { PairPlan, PlacementRollbackIntentV1 } from '../place/plan.ts';
import { createPlacementPlan } from '../place/plan.ts';
import {
  type CommittedPlacementCleanupPreparation,
  prepareCommittedPlacementCleanup,
  recoverPlacementWithObservation,
} from '../place/recovery.ts';
import { contentHashOf } from '../place/store.ts';
import type { FlipResult, PlacementPorts } from '../place/types.ts';
import { createOperationId, createOperationPlan } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationPlan,
  OperationResourceIdentity,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { ValidatedSelectionRequest } from '../selection/types.ts';
import type { ContentObservationIdentityV1, ExpectedRevisionV1 } from '../state/types.ts';
import {
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionPreconditionIdV1,
} from '../state/types.ts';
import { bindUndoRetainedArtifactV1 } from './artifacts.ts';
import { type ObserveUndoRuntime, observeUndo } from './observe.ts';
import { createUndoPlanGroups, withUndoCleanupDiagnostics } from './plan.ts';
import type {
  PreparedUndoPlan,
  UndoArtifactCandidate,
  UndoCandidate,
  UndoCleanupWarning,
  UndoError,
  UndoObservation,
  UndoRequest,
  UndoTool,
} from './types.ts';

export interface PrepareUndoRuntime extends Omit<ObserveUndoRuntime, 'ports'> {
  readonly ports: PlacementPorts;
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly observation: ObservationBundle;
}

export interface UndoExecutionDependencies {
  readonly observe: typeof observeUndo;
}

export const DEFAULT_UNDO_EXECUTION_DEPENDENCIES: UndoExecutionDependencies = Object.freeze({
  observe: observeUndo,
});

const errorMessage = (error: SkillSmithError): string =>
  'message' in error ? error.message : `unknown tool '${error.tool}'`;

const mapError = (error: SkillSmithError, signal?: AbortSignal): UndoError => ({
  code: `undo-${error.code}`,
  message: errorMessage(error),
  exitClass:
    signal?.aborted || error.code === 'cancelled'
      ? 'cancelled'
      : error.code === 'permission-denied'
        ? 'permission'
        : error.code === 'unknown-tool' || error.code === 'tool-unavailable'
          ? 'capability'
          : error.code === 'ledger-error' || error.code === 'flip-refused'
            ? 'state'
            : 'failure',
});

const skillSmithErrorCodes = new Set<SkillSmithError['code']>([
  'generic',
  'invalid-argument',
  'unknown-tool',
  'config-error',
  'skill-parse-error',
  'placement-not-found',
  'source-unresolvable',
  'ledger-error',
  'permission-denied',
  'flip-refused',
  'flip-failed',
  'tool-unavailable',
  'cancelled',
]);

const isSkillSmithError = (value: unknown): value is SkillSmithError =>
  value !== null &&
  typeof value === 'object' &&
  'code' in value &&
  typeof value.code === 'string' &&
  skillSmithErrorCodes.has(value.code as SkillSmithError['code']);

const pairIdentityKey = (pair: PairPlan): string =>
  JSON.stringify([pair.scope, pair.scopeKey, pair.skill, pair.tool, pair.placement.path]);

const candidatePair = (candidate: UndoCandidate): PairPlan => ({
  skill: candidate.name,
  tool: candidate.tool,
  scope: candidate.scope,
  scopeKey: candidate.scope === 'project' ? candidate.projectIdentity : null,
  placement: candidate.placement,
  notices: [],
});

const sourceJournal = (candidate: UndoCandidate): LogicalJournalV1Dto | null =>
  candidate.authority.format === 'logical' ? candidate.authority.source : null;

const digest = (value: string | null | undefined): `sha256:${string}` | null =>
  typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
    ? (value as `sha256:${string}`)
    : null;

const retainedStore = (
  candidate: UndoCandidate,
): Readonly<{ readonly path: string; readonly contentHash: `sha256:${string}` }> | null => {
  const logical = sourceJournal(candidate)?.actual.retained.find(({ role }) => role === 'store');
  if (logical !== undefined) {
    const contentHash = digest(logical.contentHash);
    return contentHash === null ? null : { path: logical.path, contentHash };
  }
  if (candidate.authority.format !== 'legacy-pair') return null;
  const before = candidate.authority.journal.before;
  if (before.mode !== 'pinned') return null;
  const path = before.storePath ?? candidate.authority.pair.pinned?.storePath;
  const contentHash = digest(before.contentHash ?? candidate.authority.pair.pinned?.contentHash);
  return path === null || path === undefined || contentHash === null ? null : { path, contentHash };
};

const sourceContent = async (
  candidate: UndoCandidate,
  runtime: PrepareUndoRuntime,
): Promise<Result<ContentObservationIdentityV1 | undefined, UndoError>> => {
  const logical = sourceJournal(candidate);
  const logicalBefore = logical?.intent.before;
  const retainedLocalSource =
    logicalBefore?.kind === 'placement' && logicalBefore.source?.kind === 'local-dev'
      ? logicalBefore.source
      : candidate.action === 'abort-pending' && logical?.intent.source?.kind === 'local-dev'
        ? logical.intent.source
        : null;
  if (retainedLocalSource !== null) {
    return ok(
      createContentObservationIdentityV1({
        schemaVersion: 1,
        resourceId: placementSnapshotResourceId('source', resolve(retainedLocalSource.path)),
        targetIdentity: resolve(retainedLocalSource.path),
        targetKind: 'directory',
        contentRevision: retainedLocalSource.contentHash,
      }),
    );
  }
  if (
    candidate.authority.format !== 'legacy-pair' ||
    candidate.authority.journal.before.mode !== 'dev'
  ) {
    return ok(undefined);
  }
  const path = resolve(dirname(candidate.path), candidate.authority.journal.before.symlinkTarget);
  const hashed = await contentHashOf(runtime.ports, path);
  if (!hashed.ok) return err(mapError(hashed.error, runtime.signal));
  return ok(
    createContentObservationIdentityV1({
      schemaVersion: 1,
      resourceId: placementSnapshotResourceId('source', path),
      targetIdentity: path,
      targetKind: 'directory',
      contentRevision: hashed.value,
    }),
  );
};

const observeUndoArtifactAfter = async (
  candidate: UndoArtifactCandidate,
  runtime: PrepareUndoRuntime,
): Promise<Result<void, UndoError>> => {
  try {
    const before = await runtime.ports.readFileMetadata(candidate.artifactPath);
    if (
      before.kind !== 'file' ||
      before.identity === null ||
      before.mode !== candidate.envelope.model.after.mode ||
      before.linkCount !== 1
    ) {
      return err({
        code: 'undo-artifact-state',
        message: `current ${candidate.role} artifact does not match its retained update authority`,
        exitClass: 'state',
      });
    }
    const bytes = new Uint8Array(await runtime.ports.readBytes(candidate.artifactPath));
    const image =
      candidate.role === 'manifest'
        ? artifactManifestImageFromBytesV1(candidate.artifactPath, bytes)
        : artifactLockImageFromBytesV1(candidate.artifactPath, bytes);
    const after = await runtime.ports.readFileMetadata(candidate.artifactPath);
    const forward =
      before.mode === candidate.envelope.model.after.mode &&
      canonicalPlanningString(image) === canonicalPlanningString(candidate.journal.intent.after);
    const restored =
      before.mode === candidate.envelope.model.before.mode &&
      canonicalPlanningString(image) === canonicalPlanningString(candidate.journal.intent.before);
    const allowed =
      candidate.action === 'restore'
        ? forward
        : candidate.action === 'already-restored'
          ? restored
          : candidate.rollbackJournal?.phase === 'backed-up'
            ? forward || restored
            : candidate.rollbackJournal?.phase === 'live'
              ? restored
              : forward;
    if (
      after.kind !== 'file' ||
      after.identity !== before.identity ||
      after.mode !== before.mode ||
      after.linkCount !== 1 ||
      !allowed
    ) {
      return err({
        code: 'undo-artifact-state',
        message: `current ${candidate.role} artifact was changed after the selected update`,
        exitClass: 'state',
      });
    }
    return ok(undefined);
  } catch {
    return err({
      code: 'undo-artifact-observation',
      message: `current ${candidate.role} artifact could not be observed safely`,
      exitClass: runtime.signal?.aborted ? 'cancelled' : 'failure',
    });
  }
};

const createUndoArtifactOperations = (
  observation: UndoObservation,
  placementPlan: OperationPlan<'undo'>,
): Result<
  Readonly<{
    operations: readonly ExecutableOperation[];
    candidateByOperationId: ReadonlyMap<string, UndoArtifactCandidate>;
    crossGroupPrefixByGroupId: ReadonlyMap<string, string>;
  }>,
  UndoError
> => {
  const artifacts = observation.artifacts ?? [];
  if (artifacts.length === 0) {
    return ok(
      Object.freeze({
        operations: Object.freeze([]),
        candidateByOperationId: new Map<string, UndoArtifactCandidate>(),
        crossGroupPrefixByGroupId: new Map<string, string>(),
      }),
    );
  }
  const groupBySource = new Map<string, string>();
  for (const candidate of observation.candidates) {
    if (candidate.outcome === 'already-reversed') continue;
    const operation = placementPlan.operations.find(
      (item) =>
        item.kind !== 'migrate-ledger' &&
        item.skill === candidate.name &&
        item.tool === candidate.tool &&
        item.scope === candidate.scope,
    );
    if (operation === undefined) continue;
    const previous = groupBySource.get(candidate.sourceGroupId);
    if (previous !== undefined && previous !== operation.groupId) {
      return err({
        code: 'undo-artifact-group',
        message: 'selected update placement inverses do not share one fresh occurrence group',
        exitClass: 'state',
      });
    }
    groupBySource.set(candidate.sourceGroupId, operation.groupId);
  }
  const operations: ExecutableOperation[] = [];
  const candidateByOperationId = new Map<string, UndoArtifactCandidate>();
  const crossGroupPrefixByGroupId = new Map<string, string>();
  const previousGroupLockPrefixByPath = new Map<string, string>();
  const artifactsBySourceGroup = new Map<string, UndoArtifactCandidate[]>();
  for (const artifact of artifacts) {
    const grouped = artifactsBySourceGroup.get(artifact.sourceGroupId) ?? [];
    grouped.push(artifact);
    artifactsBySourceGroup.set(artifact.sourceGroupId, grouped);
  }
  for (const [sourceGroupId, groupArtifacts] of artifactsBySourceGroup) {
    const groupId = groupBySource.get(sourceGroupId);
    if (groupId === undefined) {
      return err({
        code: 'undo-artifact-group',
        message: 'retained update artifact has no selected placement occurrence',
        exitClass: 'state',
      });
    }
    const covered = placementPlan.operations.filter(
      (operation) => operation.groupId === groupId && operation.kind !== 'migrate-ledger',
    );
    const inheritedDependencies = covered.flatMap(
      ({ dependencyMetadata }) => dependencyMetadata.operationIds,
    );
    const priorGroupDependencies = [
      ...new Set(
        groupArtifacts
          .map(({ artifactPath }) => previousGroupLockPrefixByPath.get(artifactPath))
          .filter((operationId): operationId is string => operationId !== undefined),
      ),
    ];
    if (priorGroupDependencies.length > 1) {
      return err({
        code: 'undo-artifact-topology',
        message: 'selected update suffix has incompatible artifact lock topology',
        exitClass: 'state',
      });
    }
    const crossGroupPrefix = priorGroupDependencies[0];
    if (crossGroupPrefix !== undefined) {
      crossGroupPrefixByGroupId.set(groupId, crossGroupPrefix);
    }
    let previousArtifactOperationId: string | undefined;
    for (const artifact of groupArtifacts) {
      if (artifact.action === 'already-restored') continue;
      const kind =
        artifact.role === 'manifest' ? ('write-manifest' as const) : ('write-lock' as const);
      const operationId = createOperationId({
        domain: 'skillsmith.operation-identity',
        schemaVersion: 1,
        groupId,
        pairId: null,
        kind,
        skill: null,
        source: null,
        tool: null,
        scope: null,
      });
      const operation: ExecutableOperation = {
        operationId,
        groupId,
        pairId: null,
        kind,
        dependencyMetadata: {
          domain: 'skillsmith.operation-dependency',
          schemaVersion: 1,
          operationIds: [
            ...new Set([
              ...inheritedDependencies,
              ...priorGroupDependencies,
              ...(previousArtifactOperationId === undefined ? [] : [previousArtifactOperationId]),
            ]),
          ],
        },
        skill: null,
        source: null,
        tool: null,
        scope: null,
        before: artifact.journal.intent.after as ExecutableOperation['before'],
        after: artifact.journal.intent.before as ExecutableOperation['after'],
        reason: {
          code: 'rollback-artifact-inverse',
          message: `Restore the exact retained ${artifact.role} preimage.`,
        },
        selectionSource: observation.selection.source,
        preconditionIds: [...new Set(covered.flatMap(({ preconditionIds }) => preconditionIds))],
        requiredCheckIds: [],
        reversibility: artifact.journal.intent.reversibility,
        mutates: {
          live: false,
          manifest: artifact.role === 'manifest',
          lock: artifact.role === 'lock',
          ledger: true,
        },
        conflict: null,
      };
      operations.push(operation);
      candidateByOperationId.set(operationId, artifact);
      previousArtifactOperationId = operationId;
    }
    const ownLockPrefix = [...operations]
      .reverse()
      .find(
        (operation) =>
          operation.groupId === groupId &&
          operation.kind === 'write-lock' &&
          operation.pairId === null,
      )?.operationId;
    if (ownLockPrefix !== undefined) {
      for (const { artifactPath } of groupArtifacts) {
        previousGroupLockPrefixByPath.set(artifactPath, ownLockPrefix);
      }
    }
  }
  return ok(
    Object.freeze({
      operations: Object.freeze(operations),
      candidateByOperationId,
      crossGroupPrefixByGroupId,
    }),
  );
};

interface PreparedUndoAuthority {
  readonly authority: PlacementSnapshotAuthority;
  readonly placementPlan: OperationPlan<'undo'>;
  readonly artifactPair: ResolvedArtifactPair | null;
  readonly artifactByOperationId: ReadonlyMap<string, UndoArtifactCandidate>;
  readonly preconditions: readonly ExecutionPrecondition[];
  readonly bindings: ReadonlyMap<string, PlacementCoordinatorBinding>;
  readonly candidateByOperationId: ReadonlyMap<string, UndoCandidate>;
}

const revisionResource = (
  revision: ExpectedRevisionV1,
  authority: PlacementSnapshotAuthority,
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
      ({ resourceId }) => resourceId === revision.resourceId,
    );
    if (store === undefined) throw new TypeError('undo store revision has no resource');
    return { kind: 'store', contentHash: store.contentHash };
  }
  if (revision.domain === 'live') {
    const live = authority.liveResources.find(
      ({ resourceId }) => resourceId === revision.resourceId,
    );
    if (live === undefined) throw new TypeError('undo live revision has no resource');
    return {
      kind: 'live',
      skill: live.skill,
      tool: live.tool as UndoTool,
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

const observeSourceContent = async (
  runtime: PrepareUndoRuntime,
  expected: ContentObservationIdentityV1,
): Promise<ContentObservationIdentityV1> => {
  if ((await runtime.ports.pathKind(expected.targetIdentity)) !== 'dir') {
    throw new Error('prepared undo source is no longer a directory');
  }
  const hashed = await contentHashOf(runtime.ports, expected.targetIdentity);
  if (!hashed.ok) throw hashed.error;
  return createContentObservationIdentityV1({
    ...expected,
    contentRevision: hashed.value,
  });
};

const prepareAuthority = async (
  observation: UndoObservation,
  runtime: PrepareUndoRuntime,
): Promise<
  Result<Readonly<{ plan: OperationPlan<'undo'>; execution: PreparedUndoAuthority }>, UndoError>
> => {
  const actionable = observation.candidates.filter(({ outcome }) => outcome !== 'already-reversed');
  const pairs = actionable.map(candidatePair);
  const storesByPath = new Map<string, PlacementStoreResource>();
  const intents: PlacementRollbackIntentV1[] = [];
  const contentByResource = new Map<string, ContentObservationIdentityV1>();
  const occurrenceTargetBySourceGroup = new Map<string, string>();
  for (const candidate of actionable) {
    if (occurrenceTargetBySourceGroup.has(candidate.sourceGroupId)) continue;
    occurrenceTargetBySourceGroup.set(
      candidate.sourceGroupId,
      canonicalPlanningString({
        domain: 'skillsmith.undo-occurrence',
        schemaVersion: 1,
        sourceGroupId: candidate.sourceGroupId,
        sourceTransactionIds: actionable
          .filter((item) => item.sourceGroupId === candidate.sourceGroupId)
          .map(({ sourceTransactionId }) => sourceTransactionId)
          .sort(),
      }),
    );
  }
  for (const candidate of actionable) {
    const store = retainedStore(candidate);
    let storeResourceId: string | null = null;
    if (store !== null) {
      storeResourceId = placementSnapshotResourceId('store', resolve(store.path));
      storesByPath.set(resolve(store.path), {
        resourceId: storeResourceId,
        storePath: store.path,
        contentHash: store.contentHash,
      });
    }
    const content = await sourceContent(candidate, runtime);
    if (!content.ok) return content;
    if (content.value !== undefined) contentByResource.set(content.value.resourceId, content.value);
    const pair = candidatePair(candidate);
    intents.push({
      kind: 'rollback',
      skill: candidate.name,
      tool: candidate.tool,
      scope: candidate.scope,
      projectRoot:
        candidate.scope === 'project' && candidate.projectIdentity !== null
          ? { kind: 'machine-bound', path: candidate.projectIdentity }
          : null,
      liveResourceId: placementSnapshotResourceId('live', pairIdentityKey(pair)),
      storeResourceId,
      ...(candidate.action === 'reverse-committed'
        ? {
            occurrenceTarget:
              occurrenceTargetBySourceGroup.get(candidate.sourceGroupId) ??
              candidate.sourceTransactionId,
          }
        : {}),
      ...(content.value === undefined ? {} : { sourceContent: content.value }),
    });
  }
  const capabilities: RelevantCapabilityQueryV1[] = actionable.map((candidate) => ({
    schemaVersion: 1,
    tool: candidate.tool,
    operation: 'undo',
    scope: candidate.scope,
  }));
  const defaultManifestPath = resolve(authorityProjectRoot(observation), 'skillsmith.toml');
  const defaultLockPath = resolve(authorityProjectRoot(observation), 'skillsmith.lock');
  const retainedArtifacts = observation.artifacts ?? [];
  const manifestPaths = [
    ...new Set(
      retainedArtifacts
        .filter(({ role }) => role === 'manifest')
        .map(({ artifactPath }) => artifactPath),
    ),
  ];
  const lockPaths = [
    ...new Set(
      retainedArtifacts
        .filter(({ role }) => role === 'lock')
        .map(({ artifactPath }) => artifactPath),
    ),
  ];
  if (
    manifestPaths.length > 1 ||
    lockPaths.length > 1 ||
    (manifestPaths.length === 0 &&
      lockPaths[0] !== undefined &&
      lockPaths[0] !== defaultLockPath) ||
    (lockPaths.length === 0 &&
      manifestPaths[0] !== undefined &&
      manifestPaths[0] !== defaultManifestPath)
  ) {
    return err({
      code: 'undo-artifact-pair',
      message: 'retained update history does not identify one complete artifact pair',
      exitClass: 'state',
    });
  }
  const manifestPath = manifestPaths[0] ?? defaultManifestPath;
  const lockPath = lockPaths[0] ?? defaultLockPath;
  const authority = await createPlacementSnapshotAuthority(
    toolRegistry,
    capabilities,
    runtime.ports,
    observation.projectContext,
    observation.ledgerPath,
    storeRootOf(resolveDataDir(runtime.ports, runtime.configuration)),
    pairs,
    [...storesByPath.values()],
    {
      manifestPath,
      lockPath,
      observe: false,
    },
  );
  if (!authority.ok) return err(mapError(authority.error, runtime.signal));
  const migration = prepareLedgerMigration(
    runtime.ports,
    'dev',
    observation.selection.source,
    observation.ledgerPath,
    observation.ledgerState,
  );
  const planned = createPlacementPlan(
    {
      schemaVersion: 1,
      command: 'undo',
      mode: 'rollback',
      selection: {
        source: observation.selection.source,
        outcome: observation.selection.outcome,
        targets: observation.selection.targets,
        all: observation.request.all,
        tools: observation.selection.tools,
        scopes: observation.selection.scopes,
      },
      batchPolicy: observation.request.continueOnError ? 'continue-on-error' : 'fail-fast',
      intents,
      ...(migration === null ? {} : { compatibilityOperations: [migration.operation] }),
    },
    authority.value.snapshot,
    { registry: toolRegistry, toolOrder: toolRegistry.ids },
  );
  if (!planned.ok) {
    return err({
      code: `undo-${planned.error.code}`,
      message:
        planned.error.code === 'planning-invalid'
          ? `selected undo state is stale or unrestorable: ${planned.error.message}`
          : planned.error.message,
      exitClass: 'state',
    });
  }
  // The overload is conservative over its request union; this request is frozen to command undo.
  const placementPlan = planned.value.plan as OperationPlan<'undo'>;
  for (const artifact of observation.artifacts ?? []) {
    if (!artifact.physicalHead) continue;
    const observed = await observeUndoArtifactAfter(artifact, runtime);
    if (!observed.ok) return observed;
  }
  const artifactOperations = createUndoArtifactOperations(observation, placementPlan);
  if (!artifactOperations.ok) return artifactOperations;
  const plan = createOperationPlan({
    ...placementPlan,
    selection: {
      ...placementPlan.selection,
      groupIds: [
        ...new Set([
          ...(placementPlan.selection.groupIds ?? []),
          ...artifactOperations.value.operations.map(({ groupId }) => groupId),
        ]),
      ],
    },
    operations: [
      ...artifactOperations.value.operations,
      ...placementPlan.operations.map((operation) => {
        if (operation.kind === 'migrate-ledger') return operation;
        const terminalArtifact = [...artifactOperations.value.operations]
          .reverse()
          .find(({ groupId }) => groupId === operation.groupId);
        const crossGroupPrefix = artifactOperations.value.crossGroupPrefixByGroupId.get(
          operation.groupId,
        );
        if (terminalArtifact === undefined && crossGroupPrefix === undefined) return operation;
        return {
          ...operation,
          dependencyMetadata: {
            ...operation.dependencyMetadata,
            operationIds: [
              ...new Set([
                ...operation.dependencyMetadata.operationIds,
                ...(terminalArtifact === undefined ? [] : [terminalArtifact.operationId]),
                ...(crossGroupPrefix === undefined ? [] : [crossGroupPrefix]),
              ]),
            ],
          },
        };
      }),
    ],
  }) as OperationPlan<'undo'>;
  const preconditions: ExecutionPrecondition[] = migration === null ? [] : [migration.precondition];
  for (const revision of planned.value.expectedRevisions) {
    const preconditionId = createExpectedRevisionPreconditionIdV1(revision);
    const operationIds = plan.operations
      .filter((operation) => operation.preconditionIds.includes(preconditionId))
      .map(({ operationId }) => operationId);
    if (operationIds.length === 0) continue;
    preconditions.push(
      createExpectedRevisionExecutionPrecondition({
        operationIds,
        resource: revisionResource(revision, authority.value),
        expectedRevision: revision,
        observeRevision: async () => {
          const observed = await authority.value.repositories[revision.domain].observeRevision(
            revision.resourceId,
          );
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
        },
      }),
    );
  }
  for (const content of contentByResource.values()) {
    const preconditionId = createContentObservationPreconditionIdV1(content);
    const covered = plan.operations.filter((operation) =>
      operation.preconditionIds.includes(preconditionId),
    );
    if (covered.length === 0) continue;
    preconditions.push(
      createContentObservationExecutionPrecondition({
        operationIds: covered.map(({ operationId }) => operationId),
        resource:
          covered[0]?.before.kind === 'placement' || covered[0]?.before.kind === 'absent'
            ? covered[0].before.resource
            : {
                kind: 'project-context',
                root: { kind: 'machine-bound', path: authority.value.projectRoot },
              },
        expectedContent: content,
        observeContent: () => observeSourceContent(runtime, content),
      }),
    );
  }
  const bindings = new Map<string, PlacementCoordinatorBinding>();
  const candidateByOperationId = new Map<string, UndoCandidate>();
  if (migration !== null) {
    bindings.set(migration.operation.operationId, {
      kind: 'migrate-ledger',
      expectedState: migration.expectedState,
    });
  }
  for (const operation of placementPlan.operations) {
    if (operation.kind === 'migrate-ledger') continue;
    const candidate = actionable.find(
      (item) =>
        item.name === operation.skill &&
        item.tool === operation.tool &&
        item.scope === operation.scope,
    );
    if (candidate === undefined) {
      return err({
        code: 'undo-binding',
        message: 'planned undo operation has no candidate',
        exitClass: 'failure',
      });
    }
    candidateByOperationId.set(operation.operationId, candidate);
    const pair = candidatePair(candidate);
    const intent = intents.find(
      (item) =>
        item.skill === candidate.name &&
        item.tool === candidate.tool &&
        item.scope === candidate.scope,
    );
    const ownResourceIds = new Set([
      placementSnapshotResourceId('live', pairIdentityKey(pair)),
      ...(intent?.storeResourceId === null || intent?.storeResourceId === undefined
        ? []
        : [intent.storeResourceId]),
    ]);
    const mutable = [...authority.value.snapshot.live, ...authority.value.snapshot.store]
      .map(({ revision }) => revision)
      .filter(
        (revision): revision is ExpectedRevisionV1 & Readonly<{ parentIdentity: string }> =>
          'parentIdentity' in revision,
      );
    const parents = new Set(
      mutable
        .filter(({ resourceId }) => ownResourceIds.has(resourceId))
        .map(({ parentIdentity }) => parentIdentity),
    );
    bindings.set(operation.operationId, {
      kind: 'pair',
      stageResourceIds: mutable
        .filter(
          ({ resourceId, parentIdentity }) =>
            ownResourceIds.has(resourceId) || parents.has(parentIdentity),
        )
        .map(({ resourceId }) => resourceId),
    });
  }
  return ok({
    plan,
    execution: {
      authority: authority.value,
      placementPlan,
      artifactPair:
        artifactOperations.value.operations.length === 0
          ? null
          : Object.freeze({
              file: Object.freeze({
                token: null,
                path: manifestPath,
                portability: 'machine-bound' as const,
                portableToken: null,
              }),
              lockfile: Object.freeze({
                token: null,
                path: lockPath,
                portability: 'machine-bound' as const,
                portableToken: null,
              }),
              lockfileSource:
                manifestPath === defaultManifestPath && lockPath === defaultLockPath
                  ? ('sibling' as const)
                  : ('explicit' as const),
            }),
      artifactByOperationId: artifactOperations.value.candidateByOperationId,
      preconditions,
      bindings,
      candidateByOperationId,
    },
  });
};

const authorityProjectRoot = (observation: UndoObservation): string =>
  observation.projectContext.projectRoot ?? observation.projectContext.effectiveCwd;

const physicalResult = (
  candidate: UndoCandidate,
  result:
    | Readonly<{ readonly ok: true }>
    | Readonly<{ readonly ok: false; readonly error: SkillSmithError }>,
): FlipResult =>
  result.ok
    ? {
        skill: candidate.name,
        tool: candidate.tool,
        placementPath: candidate.path,
        action: 'rolled-back',
        reason: null,
        before: null,
        after: null,
        store: null,
        verify: null,
      }
    : {
        skill: candidate.name,
        tool: candidate.tool,
        placementPath: candidate.path,
        action: 'failed',
        reason: errorMessage(result.error),
        before: null,
        after: null,
        store: null,
        verify: null,
        error: result.error,
      };

type UndoRecoveryTarget = Readonly<{
  readonly skill: string;
  readonly tool: UndoTool;
  readonly scopeKey: string | null;
  readonly rollbackContext: Readonly<{
    readonly command: 'skillsmith-undo';
    readonly workflow: 'undo';
  }>;
}>;

const executeCommittedCandidate = async (
  input: ReturnType<typeof createPlacementExecutionInput>,
  candidate: UndoCandidate,
  _target: UndoRecoveryTarget,
  observation?: ObservationBundle,
): Promise<FlipResult> =>
  physicalResult(
    candidate,
    await executeCommittedPlacementReversalWithObservation(
      input,
      candidate.sourceTransactionId,
      observation,
    ),
  );

/** Prepare one snapshot-bound plan and exact execution bindings for the selected undo set. */
export const prepareUndoFromObservation = async (
  observation: UndoObservation,
  runtime: PrepareUndoRuntime,
): Promise<Result<PreparedUndoPlan, UndoError>> => {
  const prepared = await prepareAuthority(observation, runtime);
  if (!prepared.ok) return prepared;
  const { plan: preparedPlan, execution } = prepared.value;
  const groups = createUndoPlanGroups(observation, preparedPlan);
  const plan = withUndoCleanupDiagnostics(observation, preparedPlan, groups);
  const cleanupCandidates = groups.flatMap((group) =>
    group.pairs.flatMap((pair) => {
      const candidate = observation.candidates.find(
        (item) =>
          item.recoveryState === 'cleanup-pending' &&
          item.name === group.name &&
          item.scope === group.scope &&
          item.tool === pair.tool &&
          item.path === pair.path &&
          item.activeTransactionId === pair.activeTransactionId,
      );
      return candidate === undefined ? [] : [candidate];
    }),
  );
  if (
    cleanupCandidates.length > 0 &&
    plan.operations.some(({ kind }) => kind === 'migrate-ledger')
  ) {
    return err({
      code: 'undo-cleanup-migration-conflict',
      message: 'cleanup-pending undo cannot be combined with ledger migration',
      exitClass: 'state',
    });
  }
  let cleanupWarnings: readonly UndoCleanupWarning[] = [];
  let consumed = false;
  return ok(
    Object.freeze({
      observation,
      plan,
      groups,
      execute: async () => {
        if (consumed) {
          return err({
            code: 'undo-prepared-consumed',
            message: 'prepared undo plan has already been executed',
            exitClass: 'state' as const,
          });
        }
        consumed = true;
        try {
          const executePlan = (
            artifactLease?: Parameters<typeof bindUndoRetainedArtifactV1>[0]['lease'],
          ) => {
            return executePlacementOperationPlan({
              env: runtime.ports,
              ledgerPath: observation.ledgerPath,
              plan,
              preconditions: execution.preconditions,
              authority: execution.authority,
              reportOp: 'rollback',
              modelNow: () => runtime.ports.wallNowIso(),
              journalNow: () => runtime.ports.wallNowIso(),
              bindingForOperation: (operation) => {
                const artifact = execution.artifactByOperationId.get(operation.operationId);
                if (artifact !== undefined) {
                  if (artifactLease === undefined || execution.artifactPair === null) {
                    throw new Error('approved undo artifact authority is missing');
                  }
                  return {
                    kind: 'external' as const,
                    binding: bindUndoRetainedArtifactV1({
                      operation,
                      candidate: artifact,
                      lease: artifactLease,
                      artifactCoordinator: runtime.artifactCoordinator,
                      ports: runtime.ports,
                      pair: execution.artifactPair,
                      ledgerPath: observation.ledgerPath,
                      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
                    }),
                  };
                }
                const binding = execution.bindings.get(operation.operationId);
                if (binding === undefined) throw new Error('approved undo binding is missing');
                return binding;
              },
              executePair: async (operation, ledger, nestedObservation, firstPersistenceGuard) => {
                const candidate = execution.candidateByOperationId.get(operation.operationId);
                if (candidate === undefined) throw new Error('approved undo candidate is missing');
                const input = createPlacementExecutionInput(
                  runtime.ports,
                  observation.ledgerPath,
                  ledger,
                  { newTxId: () => `transaction:${operation.operationId}` },
                  {
                    ...(runtime.configuration.journalPause === undefined
                      ? {}
                      : { testPauseAt: runtime.configuration.journalPause }),
                    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
                  },
                  operation,
                  firstPersistenceGuard,
                );
                const target: UndoRecoveryTarget = {
                  skill: candidate.name,
                  tool: candidate.tool,
                  scopeKey: candidate.scope === 'project' ? candidate.projectIdentity : null,
                  rollbackContext: { command: 'skillsmith-undo', workflow: 'undo' },
                } as const;
                if (candidate.action !== 'abort-pending') {
                  return executeCommittedCandidate(input, candidate, target, nestedObservation);
                }
                const outcome = await recoverPlacementWithObservation(
                  input,
                  'rollback',
                  target,
                  nestedObservation,
                );
                return physicalResult(candidate, outcome);
              },
              onStarted: () => {},
              ...(cleanupCandidates.length === 0
                ? {}
                : {
                    beforeSchedule: async (capturedLedger) => {
                      let aggregate = capturedLedger;
                      let publicationGuards: CommittedPlacementCleanupPreparation['publicationGuards'] =
                        Object.freeze([]);
                      const warnings: {
                        code: 'undo-cleanup-retained';
                        message: string;
                      }[] = [];
                      for (const candidate of cleanupCandidates) {
                        if (runtime.signal?.aborted) {
                          throw {
                            code: 'cancelled',
                            message: 'undo cleanup was cancelled before scheduling',
                          } satisfies SkillSmithError;
                        }
                        const input = createPlacementExecutionInput(
                          runtime.ports,
                          observation.ledgerPath,
                          aggregate,
                          { newTxId: () => `transaction:cleanup:${candidate.activeTransactionId}` },
                          {
                            ...(runtime.configuration.journalPause === undefined
                              ? {}
                              : { testPauseAt: runtime.configuration.journalPause }),
                            ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
                          },
                        );
                        const target: UndoRecoveryTarget = {
                          skill: candidate.name,
                          tool: candidate.tool,
                          scopeKey:
                            candidate.scope === 'project' ? candidate.projectIdentity : null,
                          rollbackContext: { command: 'skillsmith-undo', workflow: 'undo' },
                        };
                        const cleanup = await prepareCommittedPlacementCleanup(input, target);
                        if (!cleanup.ok) throw cleanup.error;
                        if (
                          cleanup.value === null ||
                          cleanup.value.transactionId !== candidate.activeTransactionId
                        ) {
                          throw {
                            code: 'flip-failed',
                            message: `approved cleanup carrier for '${candidate.name}' on ${candidate.tool} no longer matches`,
                          } satisfies SkillSmithError;
                        }
                        aggregate = cleanup.value.ledger;
                        publicationGuards = Object.freeze([
                          ...publicationGuards,
                          ...cleanup.value.publicationGuards,
                        ]);
                        if (cleanup.value.outcome.warning !== null) {
                          warnings.push({
                            code: 'undo-cleanup-retained',
                            message: `Undo cleanup retained a mismatched backup for '${candidate.name}' on ${candidate.tool}.`,
                          });
                        }
                      }
                      cleanupWarnings = Object.freeze(warnings);
                      return Object.freeze({ ledger: aggregate, publicationGuards });
                    },
                  }),
              ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
              observation: runtime.observation,
              ...(artifactLease === undefined ? {} : { locks: [] }),
            });
          };
          const results =
            execution.artifactPair === null
              ? await executePlan()
              : await withArtifactPairExecutionAuthority(
                  {
                    artifactCoordinator: runtime.artifactCoordinator,
                    lockPort: runtime.ports,
                    pair: execution.artifactPair,
                    ledgerPath: observation.ledgerPath,
                    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
                  },
                  executePlan,
                );
          return ok(Object.freeze({ results: Object.freeze(results), warnings: cleanupWarnings }));
        } catch (cause) {
          if (isSkillSmithError(cause)) return err(mapError(cause, runtime.signal));
          if (
            cause !== null &&
            typeof cause === 'object' &&
            'code' in cause &&
            cause.code === 'artifact-mutation' &&
            'reason' in cause &&
            typeof cause.reason === 'string' &&
            'message' in cause &&
            typeof cause.message === 'string'
          ) {
            return err({
              code: `undo-artifact-${cause.reason}`,
              message: cause.message,
              exitClass:
                cause.reason === 'cancelled'
                  ? ('cancelled' as const)
                  : cause.reason === 'permission-denied'
                    ? ('permission' as const)
                    : ('state' as const),
            });
          }
          const message =
            cause instanceof Error
              ? cause.message
              : cause !== null &&
                  typeof cause === 'object' &&
                  'message' in cause &&
                  typeof cause.message === 'string'
                ? cause.message
                : 'undo execution failed';
          return err({
            code: 'undo-execution',
            message,
            exitClass: runtime.signal?.aborted ? ('cancelled' as const) : ('failure' as const),
          });
        }
      },
    }),
  );
};

export const prepareUndo = async (
  request: UndoRequest,
  selection: ValidatedSelectionRequest<UndoTool>,
  runtime: PrepareUndoRuntime,
  dependencies: UndoExecutionDependencies = DEFAULT_UNDO_EXECUTION_DEPENDENCIES,
): Promise<Result<PreparedUndoPlan, UndoError>> => {
  const observed = await dependencies.observe(request, selection, runtime);
  return observed.ok ? prepareUndoFromObservation(observed.value, runtime) : observed;
};
