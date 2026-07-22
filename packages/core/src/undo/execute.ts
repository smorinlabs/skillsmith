import { dirname, resolve } from 'node:path';
import type { RelevantCapabilityQueryV1 } from '../agents/capabilities.ts';
import { toolRegistry } from '../agents/registry.ts';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
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
import { recoverPlacementWithObservation } from '../place/recovery.ts';
import { contentHashOf } from '../place/store.ts';
import type { FlipResult, PlacementPorts } from '../place/types.ts';
import type { OperationPlan, OperationResourceIdentity } from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { ValidatedSelectionRequest } from '../selection/types.ts';
import type { ContentObservationIdentityV1, ExpectedRevisionV1 } from '../state/types.ts';
import {
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionPreconditionIdV1,
} from '../state/types.ts';
import { type ObserveUndoRuntime, observeUndo } from './observe.ts';
import { createUndoPlanGroups } from './plan.ts';
import type {
  PreparedUndoPlan,
  UndoCandidate,
  UndoError,
  UndoObservation,
  UndoRequest,
  UndoTool,
} from './types.ts';

export interface PrepareUndoRuntime extends Omit<ObserveUndoRuntime, 'ports'> {
  readonly ports: PlacementPorts;
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

interface PreparedUndoAuthority {
  readonly authority: PlacementSnapshotAuthority;
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
      ...(content.value === undefined ? {} : { sourceContent: content.value }),
    });
  }
  const capabilities: RelevantCapabilityQueryV1[] = actionable.map((candidate) => ({
    schemaVersion: 1,
    tool: candidate.tool,
    operation: 'undo',
    scope: candidate.scope,
  }));
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
      manifestPath: resolve(authorityProjectRoot(observation), 'skillsmith.toml'),
      lockPath: resolve(authorityProjectRoot(observation), 'skillsmith.lock'),
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
  const plan = planned.value.plan as OperationPlan<'undo'>;
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
  for (const operation of plan.operations) {
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
  const { plan, execution } = prepared.value;
  const groups = createUndoPlanGroups(observation, plan);
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
          const results = await executePlacementOperationPlan({
            env: runtime.ports,
            ledgerPath: observation.ledgerPath,
            plan,
            preconditions: execution.preconditions,
            authority: execution.authority,
            reportOp: 'rollback',
            modelNow: () => runtime.ports.wallNowIso(),
            journalNow: () => runtime.ports.wallNowIso(),
            bindingForOperation: (operation) => {
              const binding = execution.bindings.get(operation.operationId);
              if (binding === undefined) throw new Error('approved undo binding is missing');
              return binding;
            },
            executePair: async (operation, ledger, nestedObservation) => {
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
            ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
            observation: runtime.observation,
          });
          return ok(Object.freeze(results));
        } catch (cause) {
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
