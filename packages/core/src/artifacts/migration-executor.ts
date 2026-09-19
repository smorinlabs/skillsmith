import { type Result, err, ok } from '../result.ts';
import { deepOwnFreeze, hasSensitiveArtifactContent } from './codec.ts';
import type {
  ArtifactCoordinatorPorts,
  ArtifactFileRevision,
  ArtifactMutationError,
  CoordinatedHumanFileResult,
} from './coordinator-types.ts';
import { updateCoordinatedHumanFile } from './coordinator.ts';
import { artifactMutationError } from './file-state.ts';
import { parseArtifactDigest } from './hash.ts';
import { type ProjectConfigMigration, planProjectConfigMigration } from './repository.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const exactKeys = (input: unknown, expected: readonly string[]): boolean => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const actual = Object.keys(input);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
};

const ownOperation = (input: unknown): ProjectConfigMigration | null => {
  const owned = deepOwnFreeze<ProjectConfigMigration>('manifest', input);
  if (
    !owned.ok ||
    !exactKeys(owned.value, [
      'kind',
      'from',
      'toVersion',
      'expectedByteRevision',
      'expectedSemanticRevision',
      'resultByteRevision',
      'resultSemanticRevision',
      'resultSource',
      'createsLockfile',
    ])
  ) {
    return null;
  }
  const value = owned.value;
  if (
    value.kind !== 'migrate-project-config' ||
    value.from !== 'legacy' ||
    value.toVersion !== 1 ||
    value.createsLockfile !== false ||
    typeof value.resultSource !== 'string' ||
    hasSensitiveArtifactContent(value.resultSource) ||
    !parseArtifactDigest(value.expectedByteRevision).ok ||
    !parseArtifactDigest(value.expectedSemanticRevision).ok ||
    !parseArtifactDigest(value.resultByteRevision).ok ||
    !parseArtifactDigest(value.resultSemanticRevision).ok ||
    value.expectedSemanticRevision !== value.resultSemanticRevision
  ) {
    return null;
  }
  return value;
};

const sameOperation = (left: ProjectConfigMigration, right: ProjectConfigMigration): boolean =>
  left.kind === right.kind &&
  left.from === right.from &&
  left.toVersion === right.toVersion &&
  left.expectedByteRevision === right.expectedByteRevision &&
  left.expectedSemanticRevision === right.expectedSemanticRevision &&
  left.resultByteRevision === right.resultByteRevision &&
  left.resultSemanticRevision === right.resultSemanticRevision &&
  left.resultSource === right.resultSource &&
  left.createsLockfile === right.createsLockfile;

const conflict = (): Result<never, ArtifactMutationError> =>
  err(artifactMutationError('external-writer-conflict'));

const editFor = (
  current: ArtifactFileRevision,
  operation: ProjectConfigMigration,
): Result<Readonly<{ bytes: Uint8Array; changed: true; mode: number }>, ArtifactMutationError> => {
  if (current.state !== 'file' || current.digest !== operation.expectedByteRevision) {
    return conflict();
  }
  let source: string;
  try {
    source = decoder.decode(new Uint8Array(current.bytes));
  } catch {
    return conflict();
  }
  const replanned = planProjectConfigMigration(source);
  if (!replanned.ok || !sameOperation(replanned.value, operation)) return conflict();
  return ok(
    Object.freeze({
      bytes: encoder.encode(operation.resultSource),
      changed: true as const,
      mode: current.mode,
    }),
  );
};

export const executeProjectConfigMigration = async (
  ports: ArtifactCoordinatorPorts,
  path: string,
  input: ProjectConfigMigration,
  signal?: AbortSignal,
): Promise<Result<CoordinatedHumanFileResult, ArtifactMutationError>> => {
  const operation = ownOperation(input);
  if (operation === null) return err(artifactMutationError('invalid-request'));
  return updateCoordinatedHumanFile(ports, {
    path,
    ...(signal === undefined ? {} : { signal }),
    edit: (current) => editFor(current, operation),
  });
};
