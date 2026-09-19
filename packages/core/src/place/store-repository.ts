import { dirname, resolve } from 'node:path';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import {
  projectSourceContent,
  serializeSourceContentProjection,
} from '../artifacts/source-content.ts';
import type { FileMetadataReadPort, FileReadPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type LogicalRepositoryStageError,
  type LogicalRepositoryStageV1,
  type RepositoryStageRequestV1,
  type StateRepositoryError,
  type StoreRepository,
  stageLogicalRepositoryEditV1,
} from '../state/repositories.ts';
import {
  type ExpectedRevisionV1,
  type StoreStateV1,
  createExpectedRevisionV1,
  createFilesystemMetadataIdentityV1,
  createStoreSnapshotIdentityV1,
} from '../state/types.ts';
import { contentHashOf } from './store.ts';

type StoreReadPorts = Pick<
  FileReadPort,
  'isExecutable' | 'listDir' | 'pathKind' | 'readBytes' | 'readLink'
> &
  FileMetadataReadPort;

export interface StoreResourceV1 {
  readonly resourceId: string;
  readonly storePath: string;
}

export interface StoreRepositoryOptions {
  readonly resources: readonly StoreResourceV1[];
  readonly ports: StoreReadPorts;
}

interface NormalizedStoreResourceV1 extends StoreResourceV1 {
  readonly storePath: string;
}

const repositoryError = (reason: StateRepositoryError['reason']): StateRepositoryError =>
  Object.freeze({ code: 'state-repository', domain: 'store', reason });

const mapUnknownError = (error: unknown): StateRepositoryError => {
  const code =
    error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  return repositoryError(
    code === 'EACCES' || code === 'EPERM' || code === 'permission-denied'
      ? 'permission-denied'
      : 'observation-failed',
  );
};

const ownRevision = (input: unknown): Result<ExpectedRevisionV1, StateRepositoryError> => {
  const revision = createExpectedRevisionV1(input);
  return revision.ok ? revision : err(repositoryError('observation-failed'));
};

const normalizeResources = (
  resources: readonly StoreResourceV1[],
): readonly NormalizedStoreResourceV1[] | null => {
  if (!Array.isArray(resources)) return null;
  const normalized: NormalizedStoreResourceV1[] = [];
  const resourceIds = new Set<string>();
  const paths = new Set<string>();
  for (const resource of resources) {
    if (
      resource === null ||
      typeof resource !== 'object' ||
      typeof resource.resourceId !== 'string' ||
      resource.resourceId.length === 0 ||
      typeof resource.storePath !== 'string' ||
      resource.storePath.length === 0
    ) {
      return null;
    }
    const storePath = resolve(resource.storePath);
    if (resourceIds.has(resource.resourceId) || paths.has(storePath)) return null;
    resourceIds.add(resource.resourceId);
    paths.add(storePath);
    normalized.push(Object.freeze({ resourceId: resource.resourceId, storePath }));
  }
  return Object.freeze(normalized);
};

const observeStore = async (
  resource: NormalizedStoreResourceV1,
  ports: StoreReadPorts,
): Promise<
  Result<
    Readonly<{ revision: ExpectedRevisionV1; value: StoreStateV1 | null }>,
    StateRepositoryError
  >
> => {
  const storePath = resource.storePath;
  const parentPath = dirname(storePath);
  try {
    const kind = await ports.pathKind(storePath);
    const target = await ports.readFileMetadata(storePath);
    const parent = await ports.readFileMetadata(parentPath);
    if (
      (kind === 'absent' && target.kind !== 'absent') ||
      (kind !== 'absent' && target.kind !== kind) ||
      (parent.kind !== 'dir' && parent.kind !== 'absent')
    ) {
      return err(repositoryError('observation-failed'));
    }
    if (kind === 'absent') {
      const revision = ownRevision({
        schemaVersion: 1,
        domain: 'store',
        resourceId: resource.resourceId,
        state: 'absent',
        targetIdentity: storePath,
        targetKind: 'absent',
        parentIdentity: parentPath,
        parentKind: parent.kind === 'dir' ? 'directory' : 'absent',
        parentMetadataIdentity: createFilesystemMetadataIdentityV1(parentPath, parent, 'parent'),
      });
      return revision.ok ? ok(Object.freeze({ revision: revision.value, value: null })) : revision;
    }
    if (kind !== 'dir' || parent.kind !== 'dir') {
      return err(repositoryError('observation-failed'));
    }
    const content = await contentHashOf(ports, storePath);
    if (!content.ok) return err(mapUnknownError(content.error));
    const projection = await projectSourceContent(ports, storePath);
    if (!projection.ok) return err(repositoryError('observation-failed'));
    const serialized = serializeSourceContentProjection(projection.value);
    if (!serialized.ok) return err(repositoryError('observation-failed'));
    const repositoryRevisionResult = hashCanonicalInput('resource', 1, serialized.value);
    if (!repositoryRevisionResult.ok) return err(repositoryError('observation-failed'));
    const targetMetadataIdentity = createFilesystemMetadataIdentityV1(storePath, target, 'target');
    const repositoryRevision = repositoryRevisionResult.value;
    const snapshotIdentity = createStoreSnapshotIdentityV1(resource.resourceId, content.value);
    const revision = ownRevision({
      schemaVersion: 1,
      domain: 'store',
      resourceId: resource.resourceId,
      state: 'present',
      targetIdentity: storePath,
      targetKind: 'directory',
      targetMetadataIdentity,
      parentIdentity: parentPath,
      parentKind: 'directory',
      parentMetadataIdentity: createFilesystemMetadataIdentityV1(parentPath, parent, 'parent'),
      resourceRevision: repositoryRevision,
      contentRevision: content.value,
      snapshotIdentity,
    });
    return revision.ok
      ? ok(
          Object.freeze({
            revision: revision.value,
            value: Object.freeze({
              path: storePath,
              repositoryRevision,
              contentRevision: content.value,
              snapshotIdentity,
            }),
          }),
        )
      : revision;
  } catch (error) {
    return err(mapUnknownError(error));
  }
};

export const createStoreRepository = (options: StoreRepositoryOptions): StoreRepository => {
  const resources = normalizeResources(options.resources);
  const resourceFor = (resourceId: string) =>
    resources?.find((resource) => resource.resourceId === resourceId);
  const observeRevision = async (
    resourceId: string,
  ): Promise<Result<ExpectedRevisionV1, StateRepositoryError>> => {
    const resource = resourceFor(resourceId);
    const observed =
      resource === undefined
        ? err(repositoryError('invalid-request'))
        : await observeStore(resource, options.ports);
    return observed.ok ? ok(observed.value.revision) : observed;
  };
  return Object.freeze({
    observe: async (resourceId: string) => {
      const resource = resourceFor(resourceId);
      return resource === undefined
        ? err(repositoryError('invalid-request'))
        : observeStore(resource, options.ports);
    },
    observeRevision,
    stage: async (
      request: RepositoryStageRequestV1,
    ): Promise<Result<LogicalRepositoryStageV1, LogicalRepositoryStageError>> => {
      if (request.domain !== 'store' || resourceFor(request.resourceId) === undefined) {
        return err(Object.freeze({ code: 'invalid-logical-stage' as const }));
      }
      const observed = await observeRevision(request.resourceId);
      return observed.ok
        ? stageLogicalRepositoryEditV1({ ...request, observedRevision: observed.value })
        : observed;
    },
  });
};
