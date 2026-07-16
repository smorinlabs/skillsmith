import { dirname, resolve } from 'node:path';
import type { FileMetadata, FileMetadataReadPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type LedgerRepository,
  type LogicalRepositoryStageError,
  type LogicalRepositoryStageV1,
  type RepositoryStageRequestV1,
  type StateRepositoryError,
  stageLogicalRepositoryEditV1,
} from '../state/repositories.ts';
import {
  type ExpectedRevisionV1,
  createExpectedRevisionV1,
  createFilesystemMetadataIdentityV1,
} from '../state/types.ts';
import type { LedgerModel, LedgerReadState } from './ledger-types.ts';

export interface LedgerRepositoryOptions {
  readonly resourceId: string;
  readonly reader: Readonly<{
    ledgerPath: string;
    read(): Promise<Result<LedgerReadState, unknown>>;
  }>;
  readonly metadata: FileMetadataReadPort;
}

const repositoryError = (reason: StateRepositoryError['reason']): StateRepositoryError =>
  Object.freeze({ code: 'state-repository', domain: 'ledger', reason });

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

const observeState = async (
  options: LedgerRepositoryOptions,
): Promise<
  Result<
    Readonly<{ revision: ExpectedRevisionV1; value: LedgerModel | null }>,
    StateRepositoryError
  >
> => {
  const ledgerPath = resolve(options.reader.ledgerPath);
  const parentPath = dirname(ledgerPath);
  try {
    const state = await options.reader.read();
    if (!state.ok) return err(mapUnknownError(state.error));
    const target = await options.metadata.readFileMetadata(ledgerPath);
    const parent = await options.metadata.readFileMetadata(parentPath);
    if (
      (state.value.state === 'absent' && target.kind !== 'absent') ||
      (state.value.state === 'present' && target.kind !== 'file') ||
      (parent.kind !== 'dir' && parent.kind !== 'absent')
    ) {
      return err(repositoryError('observation-failed'));
    }
    const revision = revisionForState(
      options.resourceId,
      ledgerPath,
      parentPath,
      state.value,
      target,
      parent,
    );
    return revision.ok
      ? ok(Object.freeze({ revision: revision.value, value: state.value.model }))
      : revision;
  } catch (error) {
    return err(mapUnknownError(error));
  }
};

const revisionForState = (
  resourceId: string,
  ledgerPath: string,
  parentPath: string,
  state: LedgerReadState,
  target: FileMetadata,
  parent: FileMetadata,
): Result<ExpectedRevisionV1, StateRepositoryError> => {
  if (state.state === 'absent') {
    return ownRevision({
      schemaVersion: 1,
      domain: 'ledger',
      resourceId,
      state: 'absent',
      targetIdentity: ledgerPath,
      targetKind: 'absent',
      parentIdentity: parentPath,
      parentKind: parent.kind === 'dir' ? 'directory' : 'absent',
      parentMetadataIdentity: createFilesystemMetadataIdentityV1(parentPath, parent, 'parent'),
    });
  }
  return ownRevision({
    schemaVersion: 1,
    domain: 'ledger',
    resourceId,
    state: 'present',
    targetIdentity: ledgerPath,
    targetKind: 'file',
    targetMetadataIdentity: createFilesystemMetadataIdentityV1(ledgerPath, target, 'target'),
    parentIdentity: parentPath,
    parentKind: 'directory',
    parentMetadataIdentity: createFilesystemMetadataIdentityV1(parentPath, parent, 'parent'),
    byteRevision: state.byteRevision,
    semanticRevision: state.semanticRevision,
  });
};

export const createLedgerRepository = (options: LedgerRepositoryOptions): LedgerRepository => {
  const observeRevision = async (
    resourceId: string,
  ): Promise<Result<ExpectedRevisionV1, StateRepositoryError>> => {
    const observed =
      resourceId === options.resourceId
        ? await observeState(options)
        : err(repositoryError('invalid-request'));
    return observed.ok ? ok(observed.value.revision) : observed;
  };
  return Object.freeze({
    observe: async (resourceId: string) =>
      resourceId === options.resourceId
        ? observeState(options)
        : err(repositoryError('invalid-request')),
    observeRevision,
    stage: async (
      request: RepositoryStageRequestV1,
    ): Promise<Result<LogicalRepositoryStageV1, LogicalRepositoryStageError>> => {
      if (request.domain !== 'ledger' || request.resourceId !== options.resourceId) {
        return err(Object.freeze({ code: 'invalid-logical-stage' as const }));
      }
      const observed = await observeRevision(request.resourceId);
      return observed.ok
        ? stageLogicalRepositoryEditV1({ ...request, observedRevision: observed.value })
        : observed;
    },
  });
};
