import { join, parse } from 'node:path';
import type {
  RelevantCapabilityQueryV1,
  RelevantCapabilitySnapshotV1,
} from '../agents/capabilities.ts';
import type { LifecycleToolRegistry } from '../agents/registry.ts';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import { createLedgerRepository } from '../artifacts/ledger-repository.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import type { LedgerWriterPorts } from '../artifacts/ledger-writer.ts';
import { createLockRepository, createManifestRepository } from '../artifacts/repository.ts';
import type { ProjectContext } from '../context/types.ts';
import {
  type SkillSmithError,
  flipFailedError,
  flipRefusedError,
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
  type ExecutionPrecondition,
  type PreparedExecutionBinding,
  type ValidatedExecutionBinding,
  executeOperationPlan,
} from '../execution/index.ts';
import type { ObservationBundle } from '../observation/index.ts';
import { createOperationExecutionResult } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { readObservedStateSnapshotV1 } from '../state/read.ts';
import {
  type LogicalRepositoryStageV1,
  type ObservedStateRepositoriesV1,
  createProjectStateReaderV1,
  createRelevantCapabilityStateReaderV1,
} from '../state/repositories.ts';
import { type ObservedStateSnapshotV1, sameExpectedRevisionV1 } from '../state/types.ts';
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
  commitRecordOnlyLogicalTransaction,
  commitRecordOnlyLogicalTransactionObserved,
  runSwap,
  runSwapObserved,
} from './swap.ts';
import type {
  FlipDeps,
  FlipOp,
  FlipOptions,
  FlipResult,
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

export interface PlacementLifecycleExecutor {
  readonly execute: (
    operation: ExecutableOperation,
    stageResourceIds: readonly string[],
    commit: () => Promise<OperationExecutionResult>,
  ) => Promise<OperationExecutionResult>;
}

export const createPlacementSnapshotAuthority = async (
  registry: LifecycleToolRegistry,
  capabilityQueries: readonly RelevantCapabilityQueryV1[],
  env: PlacementPorts,
  projectContext: ProjectContext,
  ledgerPath: string,
  storeRoot: string,
  pairs: readonly PairPlan[],
  stores: readonly PlacementStoreResource[],
): Promise<Result<PlacementSnapshotAuthority, SkillSmithError>> => {
  const contextOptions = {
    invocationCwd: projectContext.invocationCwd,
    ...(projectContext.explicitConfigPath === null
      ? {}
      : { explicitConfigPath: projectContext.explicitConfigPath }),
  };
  const projectRoot = projectContext.projectRoot ?? projectContext.effectiveCwd;
  const manifestPath =
    projectContext.explicitConfigPath ??
    projectContext.discoveredConfigPath ??
    join(projectRoot, 'skillsmith.toml');
  const lockPath = siblingLockPath(manifestPath);
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
    project: createProjectStateReaderV1({
      resourceId: projectResourceId,
      ports: env,
      context: contextOptions,
    }),
    manifest: createManifestRepository({
      resourceId: manifestResourceId,
      path: manifestPath,
      ports: env,
    }),
    lock: createLockRepository({ resourceId: lockResourceId, path: lockPath, ports: env }),
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
  const observed = await readObservedStateSnapshotV1(
    {
      schemaVersion: 1,
      projectResourceId,
      manifestResourceId,
      lockResourceId,
      ledgerResourceId,
      liveResourceIds: liveResources.map((resource) => resource.resourceId),
      storeResourceIds: stores.map((resource) => resource.resourceId),
      capabilitiesResourceId,
    },
    repositories,
  );
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
      canonicalPlanningString(projectContext)
  ) {
    return err(flipRefusedError('project context changed while preparing the operation; retry'));
  }
  return ok({
    snapshot: observed.value,
    repositories,
    projectRoot,
    manifestPath,
    lockPath,
    ledgerResourceId,
    liveResources,
    storeResources: stores,
  });
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
  readonly plan: OperationPlan<'dev' | 'promote'>;
  readonly preconditions: readonly ExecutionPrecondition[];
  readonly authority: PlacementSnapshotAuthority;
  readonly reportOp: FlipOp;
  readonly modelNow: () => string;
  readonly journalNow: () => string;
  readonly bindingForOperation: (operation: ExecutableOperation) => PlacementCoordinatorBinding;
  readonly executePair: (
    operation: ExecutableOperation,
    ledger: LedgerModel,
    observation?: ObservationBundle,
  ) => Promise<FlipResult>;
  readonly onStarted: (operation: ExecutableOperation, result: FlipResult) => void;
  readonly signal?: AbortSignal;
  readonly observation?: ObservationBundle;
}

const operationResultForFlip = (
  operation: ExecutableOperation,
  binding: ValidatedExecutionBinding,
  result: FlipResult,
  reportOp: FlipOp,
): OperationExecutionResult => {
  const cancelled = result.reason === 'interrupted' || result.error?.code === 'cancelled';
  const failed = result.action === 'failed' || result.action === 'refused';
  const unchanged = failed || cancelled || result.action === 'noop' || result.action === 'skipped';
  const common = {
    operationId: operation.operationId,
    actualBefore: binding.actualBefore,
    actualAfter: unchanged ? binding.actualBefore : operation.after,
    force: null,
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
  const lifecycle = createPlacementLifecycleExecutor(input.authority);
  const coordinatorBindings: ObservedPreparedExecutionBinding[] = input.plan.operations.map(
    (operation) => {
      const binding = input.bindingForOperation(operation);
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
        unstartedForce: null,
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
            await input.executePair(operation, ledger, observation),
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
    locks: [
      {
        rank: 'ledger' as const,
        key: `placements-ledger:${input.ledgerPath}`,
        path: input.ledgerPath,
      },
    ],
    lockPort: compatibilityLockPort,
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
}

export const createPlacementExecutionInput = (
  env: PlacementPorts,
  ledgerPath: string,
  ledger: LedgerModel,
  deps: Pick<FlipDeps, 'now' | 'newTxId'>,
  opts: Pick<FlipOptions, 'testPauseAt' | 'signal'>,
  logicalOperation?: ExecutableOperation,
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
        const written = await persistence.persist(candidate);
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
