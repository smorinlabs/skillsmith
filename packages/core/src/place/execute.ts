import { join, parse } from 'node:path';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import { createLedgerRepository } from '../artifacts/ledger-repository.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
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
  type RevisionCursorV1,
  createRevisionCursorV1,
  executeRepositoryLifecycleV1,
} from '../execution/coordinator.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { ExecutableOperation, OperationExecutionResult } from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { readObservedStateSnapshotV1 } from '../state/read.ts';
import {
  type LogicalRepositoryStageV1,
  type ObservedStateRepositoriesV1,
  createCapabilityStateReaderV1,
  createProjectStateReaderV1,
} from '../state/repositories.ts';
import { type ObservedStateSnapshotV1, sameExpectedRevisionV1 } from '../state/types.ts';
import { createLedgerPersistenceGateway } from './ledger-persistence.ts';
import { readLedgerState } from './ledger.ts';
import { createLivePlacementRepository } from './live-repository.ts';
import type { LivePlacementResourceV1 } from './live-repository.ts';
import type { PairPlan } from './plan.ts';
import { createStoreRepository } from './store-repository.ts';
import type { StoreResourceV1 } from './store-repository.ts';
import { commitRecordOnlyLogicalTransaction, runSwap } from './swap.ts';
import type {
  FlipDeps,
  FlipOptions,
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
  readonly snapshot: ObservedStateSnapshotV1;
  readonly repositories: ObservedStateRepositoriesV1;
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
  const capabilitiesResourceId = placementSnapshotResourceId('capabilities', 'registry-v1');
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
  const repositories: ObservedStateRepositoriesV1 = Object.freeze({
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
    capabilities: createCapabilityStateReaderV1(capabilitiesResourceId),
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
      if (!committed) throw new Error('placement lifecycle resolved without a commit result');
      return value as OperationExecutionResult;
    },
  });
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

export const executeRecordOnlyPlacementPlan = (
  input: PlacementExecutionInput,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null = null,
): Promise<SwapExecutionResult<void>> =>
  commitRecordOnlyLogicalTransaction(createPlacementSwapRequest(input), operation, pair, scopeKey);

export const mapPlacementExecutionError = (
  result: SwapExecutionResult<unknown>,
): SkillSmithError | null => (result.ok ? null : result.error);
