import { types as utilTypes } from 'node:util';
import type { FileReadPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import {
  type ArtifactCodec,
  type ArtifactCodecError,
  type ArtifactId,
  type DecodedArtifact,
  hasSensitiveArtifactContent,
  ownArtifactReadBytes,
  sanitizeArtifactErrorPath,
} from './codec.ts';
import { type ArtifactDigest, hashCanonicalInput, hashManifestSemantics } from './hash.ts';
import type { LogicalJournalV1 } from './journal-types.ts';
import type { LedgerMigrationV1ToV2, LedgerModel, LedgerV1Dto } from './ledger-types.ts';
import { migrateLegacyManifestBytes } from './legacy-migration.ts';
import type { PortableLockV1 } from './lock.ts';
import type { SavedPlanV1 } from './plan-types.ts';
import {
  artifactContractRegistry,
  describeLedgerV1Migration,
  ledgerSemanticRevision,
} from './registry.ts';
import type { NormalizedManifestV1 } from './types.ts';

export type ArtifactReadPorts = Pick<FileReadPort, 'pathKind' | 'readBytes'>;

export interface ProjectConfigMigration {
  readonly kind: 'migrate-project-config';
  readonly from: 'legacy';
  readonly toVersion: 1;
  readonly expectedByteRevision: ArtifactDigest;
  readonly expectedSemanticRevision: ArtifactDigest;
  readonly resultByteRevision: ArtifactDigest;
  readonly resultSemanticRevision: ArtifactDigest;
  readonly resultSource: string;
  readonly createsLockfile: false;
}

export interface ArtifactReadEnvelope<Model> {
  readonly state: 'present';
  readonly artifact: ArtifactId;
  readonly sourceVersion: 'legacy' | 1 | 2;
  readonly currentVersion: 1 | 2;
  readonly source: string;
  readonly byteLength: number;
  readonly byteRevision: ArtifactDigest;
  readonly semanticRevision: ArtifactDigest | null;
  readonly model: Model;
  readonly canonical: boolean;
  readonly migration: ProjectConfigMigration | LedgerMigrationV1ToV2 | null;
}

export interface ArtifactAbsent {
  readonly state: 'absent';
  readonly artifact: ArtifactId;
  readonly migration: null;
}

export type ArtifactReadResult<Model> = ArtifactAbsent | ArtifactReadEnvelope<Model>;

export type ArtifactRepositoryErrorReason =
  | 'invalid-request'
  | 'invalid-file-kind'
  | 'permission-denied'
  | 'read-failed'
  | ArtifactCodecError['reason'];

export interface ArtifactRepositoryError {
  readonly code: 'artifact-repository';
  readonly artifactId: ArtifactId;
  readonly requestedVersion: number | null;
  readonly reason: ArtifactRepositoryErrorReason;
  readonly path: readonly (string | number)[];
  readonly exitCode: 2 | 3 | 6;
  readonly message: string;
}

const ERROR_MESSAGES: Readonly<Record<ArtifactRepositoryErrorReason, string>> = Object.freeze({
  'invalid-request': 'artifact read request is invalid',
  'invalid-file-kind': 'artifact path is not a regular file',
  'permission-denied': 'artifact read permission was denied',
  'read-failed': 'artifact could not be read',
  malformed: 'artifact source is malformed',
  'invalid-shape': 'artifact shape is invalid',
  'unsupported-version': 'artifact version is not supported',
  'migration-failed': 'artifact migration failed',
  noncanonical: 'artifact bytes are not canonical',
  'sensitive-content': 'artifact contains sensitive content',
});
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const artifactRepositoryError = (
  artifactId: ArtifactId,
  requestedVersion: number | null,
  reason: ArtifactRepositoryErrorReason,
  path: readonly (string | number)[] = [],
): ArtifactRepositoryError =>
  Object.freeze({
    code: 'artifact-repository' as const,
    artifactId,
    requestedVersion:
      requestedVersion !== null && Number.isSafeInteger(requestedVersion) && requestedVersion > 0
        ? requestedVersion
        : null,
    reason,
    path: sanitizeArtifactErrorPath(artifactId, path),
    exitCode: reason === 'invalid-request' ? 2 : reason === 'permission-denied' ? 6 : 3,
    message: ERROR_MESSAGES[reason],
  });

const mapCodecError = (error: ArtifactCodecError): ArtifactRepositoryError => {
  const requestedVersion =
    error.reason === 'malformed' ||
    (error.reason === 'invalid-shape' && error.path.length === 1 && error.path[0] === 'kind')
      ? null
      : error.requestedVersion;
  return artifactRepositoryError(error.artifactId, requestedVersion, error.reason, error.path);
};

const ownErrorCode = (input: unknown): string | null => {
  if (typeof input !== 'object' || input === null || utilTypes.isProxy(input)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, 'code');
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
};

const portError = (artifactId: ArtifactId, input: unknown): ArtifactRepositoryError => {
  const code = ownErrorCode(input);
  return artifactRepositoryError(
    artifactId,
    null,
    code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'read-failed',
  );
};

const pathIsValid = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length > 0 &&
  !/^[\t\n\v\f\r ]*$/u.test(path) &&
  ![...path].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 0x1f || point === 0x7f || (point >= 0xd800 && point <= 0xdfff);
  }) &&
  !hasSensitiveArtifactContent(path);

const isArtifactId = (input: unknown): input is ArtifactId =>
  input === 'manifest' ||
  input === 'lock' ||
  input === 'plan' ||
  input === 'ledger' ||
  input === 'journal';

const isAsciiWhitespaceOnly = (bytes: Uint8Array): boolean =>
  bytes.length === 0 ||
  bytes.every(
    (value) =>
      value === 0x09 ||
      value === 0x0a ||
      value === 0x0b ||
      value === 0x0c ||
      value === 0x0d ||
      value === 0x20,
  );

const decodeOwnedSource = (
  artifactId: ArtifactId,
  bytes: Uint8Array,
): Result<string, ArtifactRepositoryError> => {
  if (
    isAsciiWhitespaceOnly(bytes) ||
    (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    return err(artifactRepositoryError(artifactId, null, 'malformed'));
  }
  try {
    return ok(decoder.decode(bytes));
  } catch {
    return err(artifactRepositoryError(artifactId, null, 'malformed'));
  }
};

const decodeFromRegistry = (
  artifactId: ArtifactId,
  bytes: Uint8Array,
): Result<
  Readonly<{ codec: ArtifactCodec; decoded: DecodedArtifact<unknown> }>,
  ArtifactRepositoryError
> => {
  const initial = artifactContractRegistry.get(artifactId, 1);
  if (initial === undefined) {
    return err(artifactRepositoryError(artifactId, 1, 'unsupported-version'));
  }
  let codec = initial;
  let decoded = codec.decode(bytes);
  if (
    artifactId === 'ledger' &&
    !decoded.ok &&
    decoded.error.reason === 'unsupported-version' &&
    decoded.error.requestedVersion !== null
  ) {
    const selected = artifactContractRegistry.get(artifactId, decoded.error.requestedVersion);
    if (selected !== undefined) {
      codec = selected;
      decoded = codec.decode(bytes);
    }
  }
  if (!decoded.ok) {
    return err(mapCodecError(decoded.error));
  }
  return ok(Object.freeze({ codec, decoded: decoded.value }));
};

const resourceRevision = (bytes: Uint8Array): ArtifactDigest => {
  const result = hashCanonicalInput('resource', 1, bytes);
  if (!result.ok) throw new Error('artifact resource revision invariant failed');
  return result.value;
};

const semanticRevision = (
  artifactId: ArtifactId,
  model: unknown,
  bytes: Uint8Array,
): Result<ArtifactDigest | null, ArtifactRepositoryError> => {
  if (artifactId === 'manifest') {
    return ok(hashManifestSemantics(model as NormalizedManifestV1));
  }
  if (artifactId === 'lock') {
    const hashed = hashCanonicalInput('lock-canonical', 1, bytes);
    return hashed.ok
      ? ok(hashed.value)
      : err(artifactRepositoryError(artifactId, 1, 'invalid-shape'));
  }
  if (artifactId === 'ledger') {
    const hashed = ledgerSemanticRevision(model as LedgerModel);
    return hashed.ok ? hashed : err(mapCodecError(hashed.error));
  }
  return ok(null);
};

const migrationFor = (
  artifactId: ArtifactId,
  sourceVersion: 'legacy' | 1 | 2,
  source: string,
  bytes: Uint8Array,
  codec: ArtifactCodec,
  model: unknown,
): Result<ProjectConfigMigration | LedgerMigrationV1ToV2 | null, ArtifactRepositoryError> => {
  if (artifactId === 'manifest' && sourceVersion === 'legacy') {
    return planProjectConfigMigration(source);
  }
  if (artifactId === 'ledger' && sourceVersion === 1) {
    const dto = codec.toDto(model);
    if (!dto.ok) return err(mapCodecError(dto.error));
    const described = describeLedgerV1Migration(bytes, dto.value as LedgerV1Dto);
    return described.ok ? described : err(mapCodecError(described.error));
  }
  return ok(null);
};

const readArtifact = async <Model>(
  ports: ArtifactReadPorts,
  path: string,
  artifactId: ArtifactId,
): Promise<Result<ArtifactReadResult<Model>, ArtifactRepositoryError>> => {
  if (!isArtifactId(artifactId) || !pathIsValid(path)) {
    return err(artifactRepositoryError(artifactId, null, 'invalid-request'));
  }
  let kind: unknown;
  try {
    kind = await ports.pathKind(path);
  } catch (error) {
    return err(portError(artifactId, error));
  }
  if (kind === 'absent') {
    return ok(Object.freeze({ state: 'absent' as const, artifact: artifactId, migration: null }));
  }
  if (kind !== 'file') {
    return err(artifactRepositoryError(artifactId, null, 'invalid-file-kind'));
  }
  let input: unknown;
  try {
    input = await ports.readBytes(path);
  } catch (error) {
    return err(portError(artifactId, error));
  }
  const owned = ownArtifactReadBytes(artifactId, input);
  if (!owned.ok) return err(artifactRepositoryError(artifactId, null, 'read-failed'));
  const source = decodeOwnedSource(artifactId, owned.value);
  if (!source.ok) return source;
  const decoded = decodeFromRegistry(artifactId, owned.value);
  if (!decoded.ok) return decoded;
  const sourceVersion =
    decoded.value.decoded.source.kind === 'shape'
      ? ('legacy' as const)
      : (decoded.value.decoded.source.version as 1 | 2);
  const latest = artifactContractRegistry.latest(artifactId);
  if (
    latest === undefined ||
    (latest.descriptor.version !== 1 && latest.descriptor.version !== 2)
  ) {
    return err(artifactRepositoryError(artifactId, null, 'unsupported-version'));
  }
  const currentVersion = latest.descriptor.version as 1 | 2;
  const semantic = semanticRevision(artifactId, decoded.value.decoded.model, owned.value);
  if (!semantic.ok) return semantic;
  const migration = migrationFor(
    artifactId,
    sourceVersion,
    source.value,
    owned.value,
    decoded.value.codec,
    decoded.value.decoded.model,
  );
  if (!migration.ok) return migration;
  return ok(
    Object.freeze({
      state: 'present' as const,
      artifact: artifactId,
      sourceVersion,
      currentVersion,
      source: source.value,
      byteLength: owned.value.byteLength,
      byteRevision: resourceRevision(owned.value),
      semanticRevision: semantic.value,
      model: decoded.value.decoded.model as Model,
      canonical: decoded.value.decoded.canonical,
      migration: migration.value,
    }),
  );
};

export const readManifestArtifact = (
  ports: ArtifactReadPorts,
  path: string,
): Promise<Result<ArtifactReadResult<NormalizedManifestV1>, ArtifactRepositoryError>> =>
  readArtifact(ports, path, 'manifest');

export const readLockArtifact = (
  ports: ArtifactReadPorts,
  path: string,
): Promise<Result<ArtifactReadResult<PortableLockV1>, ArtifactRepositoryError>> =>
  readArtifact(ports, path, 'lock');

export const readSavedPlanArtifact = (
  ports: ArtifactReadPorts,
  path: string,
): Promise<Result<ArtifactReadResult<SavedPlanV1>, ArtifactRepositoryError>> =>
  readArtifact(ports, path, 'plan');

export const readLedgerArtifact = (
  ports: ArtifactReadPorts,
  path: string,
): Promise<Result<ArtifactReadResult<LedgerModel>, ArtifactRepositoryError>> =>
  readArtifact(ports, path, 'ledger');

export const readJournalArtifact = (
  ports: ArtifactReadPorts,
  path: string,
): Promise<Result<ArtifactReadResult<LogicalJournalV1>, ArtifactRepositoryError>> =>
  readArtifact(ports, path, 'journal');

export const planProjectConfigMigration = (
  source: string,
): Result<ProjectConfigMigration, ArtifactRepositoryError> => {
  if (
    typeof source !== 'string' ||
    source.length === 0 ||
    hasSensitiveArtifactContent(source) ||
    containsSensitiveMaterial(source)
  ) {
    return err(
      artifactRepositoryError(
        'manifest',
        null,
        typeof source === 'string' && hasSensitiveArtifactContent(source)
          ? 'sensitive-content'
          : 'invalid-request',
      ),
    );
  }
  const beforeBytes = encoder.encode(source);
  const migrated = migrateLegacyManifestBytes(beforeBytes);
  if (!migrated.ok) {
    return err(
      artifactRepositoryError(
        'manifest',
        null,
        migrated.error.reason === 'unsafe-content' ? 'sensitive-content' : 'migration-failed',
      ),
    );
  }
  if (migrated.value.beforeSemanticHash !== migrated.value.afterSemanticHash) {
    return err(artifactRepositoryError('manifest', null, 'migration-failed'));
  }
  const resultSource = `${migrated.value.source}`;
  if (hasSensitiveArtifactContent(resultSource)) {
    return err(artifactRepositoryError('manifest', null, 'sensitive-content'));
  }
  return ok(
    Object.freeze({
      kind: 'migrate-project-config' as const,
      from: 'legacy' as const,
      toVersion: 1 as const,
      expectedByteRevision: resourceRevision(beforeBytes),
      expectedSemanticRevision: migrated.value.beforeSemanticHash,
      resultByteRevision: resourceRevision(encoder.encode(resultSource)),
      resultSemanticRevision: migrated.value.afterSemanticHash,
      resultSource,
      createsLockfile: false as const,
    }),
  );
};
