import { toolRegistry } from '../agents/registry.ts';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import type { ResolveProjectContextOptions } from '../context/types.ts';
import {
  type CapabilitySnapshotV1Dto,
  toCapabilitySnapshotV1Dto,
} from '../contracts/v1/capability-snapshot.ts';
import { safeErrorCode } from '../errors.ts';
import type { GitReadPorts } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { ownOrdinaryData } from './ownership.ts';
import {
  type ExpectedRevisionV1,
  type LivePlacementStateV1,
  type ObservedComponentV1,
  type StateDomainV1,
  type StoreStateV1,
  createExpectedRevisionV1,
  isExpectedRevisionV1,
  sameExpectedRevisionV1,
  semanticValueRevisionV1,
} from './types.ts';

export interface StateRepositoryError {
  readonly code: 'state-repository';
  readonly domain: StateDomainV1;
  readonly reason: 'invalid-request' | 'observation-failed' | 'permission-denied';
}

export interface LogicalRepositoryEditRequestV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly domain: StateDomainV1;
  readonly resourceId: string;
  readonly expectedRevision: ExpectedRevisionV1;
  readonly observedRevision: ExpectedRevisionV1;
  readonly editDigest: string;
}

export type RepositoryStageRequestV1 = Omit<LogicalRepositoryEditRequestV1, 'observedRevision'>;

export interface LogicalRepositoryStageV1 {
  readonly schemaVersion: 1;
  readonly stageId: `stage:v1:${string}`;
  readonly operationId: string;
  readonly domain: StateDomainV1;
  readonly resourceId: string;
  readonly expectedRevision: ExpectedRevisionV1;
  readonly beforeRevision: ExpectedRevisionV1;
  readonly editDigest: string;
}

export interface StaleRevisionError {
  readonly code: 'stale-revision';
  readonly domain: StateDomainV1;
  readonly resourceId: string;
}

export interface InvalidLogicalStageError {
  readonly code: 'invalid-logical-stage';
}

export type LogicalRepositoryStageError =
  | StaleRevisionError
  | InvalidLogicalStageError
  | StateRepositoryError;

interface StateObserverV1<Model> {
  observe(resourceId: string): Promise<Result<ObservedComponentV1<Model>, StateRepositoryError>>;
  observeRevision(resourceId: string): Promise<Result<ExpectedRevisionV1, StateRepositoryError>>;
}

interface DomainStageV1 {
  stage(
    request: RepositoryStageRequestV1,
  ): Promise<Result<LogicalRepositoryStageV1, LogicalRepositoryStageError>>;
}

export interface ManifestRepository extends StateObserverV1<NormalizedManifestV1>, DomainStageV1 {}

export interface LockRepository extends StateObserverV1<PortableLockV1>, DomainStageV1 {}

export interface LedgerRepository extends StateObserverV1<LedgerModel>, DomainStageV1 {}

export interface LivePlacementRepository
  extends StateObserverV1<LivePlacementStateV1>,
    DomainStageV1 {}

export interface StoreRepository extends StateObserverV1<StoreStateV1>, DomainStageV1 {}

export interface ProjectStateReaderV1 extends StateObserverV1<ProjectContext> {}

export interface CapabilityStateReaderV1 extends StateObserverV1<CapabilitySnapshotV1Dto> {}

export interface ObservedStateRepositoriesV1 {
  readonly project: ProjectStateReaderV1;
  readonly manifest: ManifestRepository;
  readonly lock: LockRepository;
  readonly ledger: LedgerRepository;
  readonly live: LivePlacementRepository;
  readonly store: StoreRepository;
  readonly capabilities: CapabilityStateReaderV1;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

const stageDigest = (request: LogicalRepositoryEditRequestV1): `stage:v1:${string}` => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-logical-stage',
      1,
      request.operationId,
      request.domain,
      request.resourceId,
      request.expectedRevision.revisionDigest,
      request.editDigest,
    ]),
  );
  if (!hashed.ok) throw new Error('logical repository stage hash invariant failed');
  return `stage:v1:${hashed.value.slice('sha256:'.length)}`;
};

const invalidStage = (): InvalidLogicalStageError =>
  Object.freeze({ code: 'invalid-logical-stage' as const });

export const stageLogicalRepositoryEditV1 = (
  request: LogicalRepositoryEditRequestV1,
): Result<LogicalRepositoryStageV1, LogicalRepositoryStageError> => {
  if (
    request === null ||
    typeof request !== 'object' ||
    request.schemaVersion !== 1 ||
    typeof request.operationId !== 'string' ||
    request.operationId.length === 0 ||
    typeof request.resourceId !== 'string' ||
    request.resourceId.length === 0 ||
    !SHA256.test(request.editDigest) ||
    !isExpectedRevisionV1(request.expectedRevision) ||
    !isExpectedRevisionV1(request.observedRevision) ||
    request.expectedRevision.domain !== request.domain ||
    request.observedRevision.domain !== request.domain ||
    request.expectedRevision.resourceId !== request.resourceId ||
    request.observedRevision.resourceId !== request.resourceId
  ) {
    return err(invalidStage());
  }
  if (!sameExpectedRevisionV1(request.expectedRevision, request.observedRevision)) {
    return err(
      Object.freeze({
        code: 'stale-revision' as const,
        domain: request.domain,
        resourceId: request.resourceId,
      }),
    );
  }
  return ok(
    Object.freeze({
      schemaVersion: 1 as const,
      stageId: stageDigest(request),
      operationId: request.operationId,
      domain: request.domain,
      resourceId: request.resourceId,
      expectedRevision: request.expectedRevision,
      beforeRevision: request.observedRevision,
      editDigest: request.editDigest,
    }),
  );
};

const observationError = (
  domain: 'project' | 'capabilities',
  reason: StateRepositoryError['reason'],
): StateRepositoryError => Object.freeze({ code: 'state-repository', domain, reason });

const semanticObservation = <Model>(
  domain: 'project' | 'capabilities',
  resourceId: string,
  value: Model,
): Result<ObservedComponentV1<Model>, StateRepositoryError> => {
  let semanticRevision: string;
  try {
    semanticRevision = semanticValueRevisionV1(domain, value);
  } catch {
    return err(observationError(domain, 'observation-failed'));
  }
  const revision = createExpectedRevisionV1({
    schemaVersion: 1,
    domain,
    resourceId,
    state: 'present',
    targetKind: 'semantic',
    semanticRevision,
  });
  return revision.ok
    ? ok(Object.freeze({ revision: revision.value, value }))
    : err(observationError(domain, 'observation-failed'));
};

const isPermissionError = (error: unknown, seen = new Set<object>()): boolean => {
  const code = safeErrorCode(error);
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'permission' ||
    code === 'permission-denied'
  ) {
    return true;
  }
  if (error === null || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    return descriptor !== undefined && 'value' in descriptor
      ? isPermissionError(descriptor.value, seen)
      : false;
  } catch {
    return false;
  }
};

export const createProjectStateReaderV1 = (options: {
  readonly resourceId: string;
  readonly ports: GitReadPorts;
  readonly context: ResolveProjectContextOptions;
}): ProjectStateReaderV1 => {
  const context = Object.freeze({ ...options.context });
  const observe = async (
    resourceId: string,
  ): Promise<Result<ObservedComponentV1<ProjectContext>, StateRepositoryError>> => {
    if (resourceId !== options.resourceId) {
      return err(observationError('project', 'invalid-request'));
    }
    try {
      const resolved = await resolveProjectContext(options.ports, context);
      if (!resolved.ok) {
        return err(
          observationError(
            'project',
            isPermissionError(resolved.error) ? 'permission-denied' : 'observation-failed',
          ),
        );
      }
      return semanticObservation('project', options.resourceId, resolved.value);
    } catch (error) {
      return err(
        observationError(
          'project',
          isPermissionError(error) ? 'permission-denied' : 'observation-failed',
        ),
      );
    }
  };
  return Object.freeze({
    observe,
    observeRevision: async (resourceId: string) => {
      const observed = await observe(resourceId);
      return observed.ok ? ok(observed.value.revision) : observed;
    },
  });
};

export const createCapabilityStateReaderV1 = (resourceId: string): CapabilityStateReaderV1 => {
  const observe = async (
    requestedResourceId: string,
  ): Promise<Result<ObservedComponentV1<CapabilitySnapshotV1Dto>, StateRepositoryError>> => {
    if (requestedResourceId !== resourceId) {
      return err(observationError('capabilities', 'invalid-request'));
    }
    const owned = ownOrdinaryData(
      toCapabilitySnapshotV1Dto({ adapters: toolRegistry.adapters }),
      () => true,
    );
    if (!owned.ok) return err(observationError('capabilities', 'observation-failed'));
    return semanticObservation('capabilities', resourceId, owned.value as CapabilitySnapshotV1Dto);
  };
  return Object.freeze({
    observe,
    observeRevision: async (requestedResourceId: string) => {
      const observed = await observe(requestedResourceId);
      return observed.ok ? ok(observed.value.revision) : observed;
    },
  });
};
