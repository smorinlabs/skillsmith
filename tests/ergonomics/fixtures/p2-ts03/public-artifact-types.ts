import {
  HASH_DOMAINS,
  HASH_SCHEMA_VERSION,
  LOCK_VERSION,
  SOURCE_CONTENT_EXCLUSIONS_V1,
  SOURCE_CONTENT_EXCLUSIONS_VERSION,
  correlatePortableLock,
  hashCanonicalInput,
  hashManifestBytes,
  hashManifestSemantics,
  hashPortableLock,
  hashSourceContentV1,
  parseArtifactDigest,
  projectSourceContent,
  readPortableLockSource,
  serializePortableLock,
  serializeSourceContentProjection,
} from '@skillsmith/core';
import type {
  ArtifactDigest,
  ArtifactHashError,
  HashDomain,
  HashSchemaVersion,
  PortableLockFact,
  PortableLockRelationship,
  PortableLockSkillV1,
  PortableLockStateError,
  PortableLockV1,
  SourceContentEntryV1,
  SourceContentError,
  SourceContentProjectionV1,
  SourceContentReadPort,
} from '@skillsmith/core/public-types';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

type HashResult =
  | { readonly ok: true; readonly value: ArtifactDigest }
  | { readonly ok: false; readonly error: ArtifactHashError };
type LockResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PortableLockStateError };
type SourceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SourceContentError };

type _HashVersion = Assert<Equal<HashSchemaVersion, 1>>;
type _HashDomains = Assert<Equal<HashDomain, (typeof HASH_DOMAINS)[number]>>;
type _LockVersion = Assert<Equal<PortableLockV1['version'], 1>>;
type _NoStorePath = Assert<
  Equal<'storePath' extends keyof PortableLockSkillV1 ? true : false, false>
>;
type _NoPlacement = Assert<
  Equal<'placement' extends keyof PortableLockSkillV1 ? true : false, false>
>;
type _FactReasons = Assert<
  Equal<
    PortableLockFact['reason'],
    | 'missing-entry'
    | 'extra-entry'
    | 'manifest-hash-mismatch'
    | 'source-mismatch'
    | 'requested-ref-mismatch'
    | 'source-path-mismatch'
  >
>;
type _RelationshipStates = Assert<
  Equal<PortableLockRelationship['state'], 'missing-lock' | 'incomplete' | 'stale' | 'current'>
>;
type _SourceEntryKinds = Assert<
  Equal<SourceContentEntryV1['type'], 'directory' | 'file' | 'symlink'>
>;

const _hashCanonical: (domain: string, version: number, input: string | Uint8Array) => HashResult =
  hashCanonicalInput;
const _parseDigest: (value: unknown) => HashResult = parseArtifactDigest;
const _manifestSemantic: typeof hashManifestSemantics = hashManifestSemantics;
const _manifestBytes: typeof hashManifestBytes = hashManifestBytes;
const _readLock: (source: Uint8Array) => LockResult<PortableLockV1> = readPortableLockSource;
const _serializeLock: (lock: Readonly<PortableLockV1>) => LockResult<string> =
  serializePortableLock;
const _hashLock: (lock: Readonly<PortableLockV1>) => LockResult<ArtifactDigest> = hashPortableLock;
const _correlate: typeof correlatePortableLock = correlatePortableLock;
const _project: (
  ports: SourceContentReadPort,
  root: string,
) => Promise<SourceResult<SourceContentProjectionV1>> = projectSourceContent;
const _serializeSource: (projection: Readonly<SourceContentProjectionV1>) => SourceResult<string> =
  serializeSourceContentProjection;
const _hashSource: (
  projection: Readonly<SourceContentProjectionV1>,
) => SourceResult<ArtifactDigest> = hashSourceContentV1;

void [
  HASH_DOMAINS,
  HASH_SCHEMA_VERSION,
  LOCK_VERSION,
  SOURCE_CONTENT_EXCLUSIONS_VERSION,
  SOURCE_CONTENT_EXCLUSIONS_V1,
  _hashCanonical,
  _parseDigest,
  _manifestSemantic,
  _manifestBytes,
  _readLock,
  _serializeLock,
  _hashLock,
  _correlate,
  _project,
  _serializeSource,
  _hashSource,
];
