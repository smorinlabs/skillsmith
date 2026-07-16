import { isAbsolute, normalize, resolve } from 'node:path';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import type { Scope } from '../config/types.ts';
import type { ProjectContext } from '../context/types.ts';
import type { CapabilitySnapshotV1Dto } from '../contracts/v1/index.ts';
import type { FileMetadata } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { ownOrdinaryData } from './ownership.ts';

export type StateDomainV1 =
  | 'manifest'
  | 'lock'
  | 'ledger'
  | 'live'
  | 'store'
  | 'project'
  | 'capabilities';

type FilesystemStateDomainV1 = Exclude<StateDomainV1, 'project' | 'capabilities'>;
type ArtifactStateDomainV1 = Extract<StateDomainV1, 'manifest' | 'lock' | 'ledger'>;
type SemanticStateDomainV1 = Extract<StateDomainV1, 'project' | 'capabilities'>;

interface RevisionCommonV1 {
  readonly schemaVersion: 1;
  readonly domain: StateDomainV1;
  readonly resourceId: string;
  readonly revisionDigest: string;
}

export interface AbsentExpectedRevisionV1 extends RevisionCommonV1 {
  readonly domain: FilesystemStateDomainV1;
  readonly state: 'absent';
  readonly targetIdentity: string;
  readonly targetKind: 'absent';
  readonly parentIdentity: string;
  readonly parentKind: 'directory' | 'absent';
  readonly parentMetadataIdentity: string;
  readonly absenceDigest: string;
}

export interface ArtifactPresentRevisionV1 extends RevisionCommonV1 {
  readonly domain: ArtifactStateDomainV1;
  readonly state: 'present';
  readonly targetIdentity: string;
  readonly targetKind: 'file';
  readonly targetMetadataIdentity: string;
  readonly parentIdentity: string;
  readonly parentKind: 'directory';
  readonly parentMetadataIdentity: string;
  readonly byteRevision: string;
  readonly semanticRevision: string;
}

export interface LivePresentRevisionV1 extends RevisionCommonV1 {
  readonly domain: 'live';
  readonly state: 'present';
  readonly targetIdentity: string;
  readonly targetKind: 'file' | 'directory' | 'symlink';
  readonly targetMetadataIdentity: string;
  readonly parentIdentity: string;
  readonly parentKind: 'directory';
  readonly parentMetadataIdentity: string;
  readonly resourceRevision: string;
  readonly contentRevision: string | null;
}

export interface StorePresentRevisionV1 extends RevisionCommonV1 {
  readonly domain: 'store';
  readonly state: 'present';
  readonly targetIdentity: string;
  readonly targetKind: 'directory';
  readonly targetMetadataIdentity: string;
  readonly parentIdentity: string;
  readonly parentKind: 'directory';
  readonly parentMetadataIdentity: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly snapshotIdentity: string;
}

export interface SemanticPresentRevisionV1 extends RevisionCommonV1 {
  readonly domain: SemanticStateDomainV1;
  readonly state: 'present';
  readonly targetKind: 'semantic';
  readonly semanticRevision: string;
}

export type ExpectedRevisionV1 =
  | AbsentExpectedRevisionV1
  | ArtifactPresentRevisionV1
  | LivePresentRevisionV1
  | StorePresentRevisionV1
  | SemanticPresentRevisionV1;

export interface StateTypeError {
  readonly code: 'state-type';
  readonly reason: 'invalid-revision';
}

export interface ObservedComponentV1<Model> {
  readonly revision: ExpectedRevisionV1;
  readonly value: Model | null;
}

export interface ContentObservationIdentityV1 {
  readonly schemaVersion: 1;
  readonly resourceId: string;
  readonly targetIdentity: string;
  readonly targetKind: 'file' | 'directory';
  readonly contentRevision: `sha256:${string}`;
}

export interface LivePlacementStateV1 {
  readonly skill: string;
  readonly tool: string;
  readonly scope: Scope;
  readonly projectIdentity: string | null;
  readonly representation: 'file' | 'directory' | 'symlink';
  readonly path: string;
  readonly realpath: string | null;
  readonly linkTarget: string | null;
  readonly dangling: boolean;
  readonly placementClass: 'absent' | 'dev' | 'pinned' | 'store-linked';
  readonly skillFile: 'valid' | 'missing' | 'invalid';
  readonly brokenReason:
    | 'dangling-link'
    | 'wrong-node-kind'
    | 'skill-file-missing'
    | 'skill-file-invalid'
    | null;
  readonly contentRevision: string | null;
}

export interface StoreStateV1 {
  readonly path: string;
  readonly repositoryRevision: string;
  readonly contentRevision: string;
  readonly snapshotIdentity: string;
}

const canonicalSemanticValue = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSemanticValue(item)).join(',')}]`;
  }
  if (typeof value !== 'object') throw new TypeError('semantic state value is invalid');
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSemanticValue(record[key])}`)
    .join(',')}}`;
};

/** Canonical semantic revision authority for project and capability observation values. */
export const semanticValueRevisionV1 = (
  domain: SemanticStateDomainV1,
  input: unknown,
): `sha256:${string}` => {
  if (domain !== 'project' && domain !== 'capabilities') {
    throw new TypeError('semantic state domain is invalid');
  }
  const owned = ownOrdinaryData(input, () => true, { objectPrototype: 'null' });
  if (!owned.ok) throw new TypeError('semantic state value is invalid');
  const hashed = hashCanonicalInput(
    'resource',
    1,
    canonicalSemanticValue({
      domain: 'skillsmith.semantic-state-value',
      schemaVersion: 1,
      stateDomain: domain,
      value: owned.value,
    }),
  );
  if (!hashed.ok) throw new Error('semantic state value hash invariant failed');
  return hashed.value as `sha256:${string}`;
};

/** Private canonical identity for filesystem metadata observed by state repositories. */
export const createFilesystemMetadataIdentityV1 = (
  path: string,
  metadata: FileMetadata,
  role: 'target' | 'parent',
): `metadata:v1:${string}` => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-filesystem-metadata',
      1,
      resolve(path),
      metadata.kind,
      metadata.mode,
      metadata.identity,
      // Sibling directory entries can change a parent's link count without changing the target
      // or parent identity. Targets retain hard-link sensitivity; parent observations do not.
      role === 'target' ? (metadata.linkCount ?? null) : null,
    ]),
  );
  if (!hashed.ok) throw new Error('filesystem metadata identity hash invariant failed');
  return `metadata:v1:${hashed.value.slice('sha256:'.length)}`;
};

export const createStoreSnapshotIdentityV1 = (
  resourceId: string,
  contentRevision: string,
): `store:v1:${string}` => {
  if (!isString(resourceId) || !SHA256.test(contentRevision)) {
    throw new TypeError('store snapshot identity input is invalid');
  }
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-store-snapshot', 1, resourceId, contentRevision]),
  );
  if (!hashed.ok) throw new Error('store snapshot identity hash invariant failed');
  return `store:v1:${hashed.value.slice('sha256:'.length)}`;
};

export interface ObservedStateSnapshotV1<CapabilityModel = CapabilitySnapshotV1Dto> {
  readonly schemaVersion: 1;
  readonly snapshotId: `snapshot:v1:${string}`;
  /** Closed status-only adjunct revision; mutator snapshots omit this field. */
  readonly statusRevision?: `sha256:${string}`;
  readonly project: ObservedComponentV1<ProjectContext>;
  readonly manifest: ObservedComponentV1<NormalizedManifestV1>;
  readonly lock: ObservedComponentV1<PortableLockV1>;
  readonly ledger: ObservedComponentV1<LedgerModel>;
  readonly live: readonly ObservedComponentV1<LivePlacementStateV1>[];
  readonly store: readonly ObservedComponentV1<StoreStateV1>[];
  readonly capabilities: ObservedComponentV1<CapabilityModel>;
}

const DOMAINS = new Set<StateDomainV1>([
  'manifest',
  'lock',
  'ledger',
  'live',
  'store',
  'project',
  'capabilities',
]);
const FILESYSTEM_DOMAINS = new Set<StateDomainV1>(['manifest', 'lock', 'ledger', 'live', 'store']);
const ARTIFACT_DOMAINS = new Set<StateDomainV1>(['manifest', 'lock', 'ledger']);
const SEMANTIC_DOMAINS = new Set<StateDomainV1>(['project', 'capabilities']);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const METADATA = /^metadata:v1:[0-9a-f]{64}$/u;
const REVISION = /^revision:v1:[0-9a-f]{64}$/u;
const ABSENCE = /^absence:v1:[0-9a-f]{64}$/u;

const stateTypeError = (): StateTypeError =>
  Object.freeze({ code: 'state-type' as const, reason: 'invalid-revision' as const });

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const record = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
};

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const digest = (label: 'absence' | 'revision', tuple: readonly unknown[]): string => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-state', label, 1, ...tuple]),
  );
  if (!hashed.ok) throw new Error('state revision hash invariant failed');
  return `${label}:v1:${hashed.value.slice('sha256:'.length)}`;
};

const baseTuple = (value: Readonly<Record<string, unknown>>): readonly unknown[] =>
  Object.freeze([value.schemaVersion, value.domain, value.resourceId, value.state]);

const tupleWithoutDigests = (value: Readonly<Record<string, unknown>>): readonly unknown[] => {
  const common = baseTuple(value);
  if (value.state === 'absent') {
    return Object.freeze([
      ...common,
      value.targetIdentity,
      value.targetKind,
      value.parentIdentity,
      value.parentKind,
      value.parentMetadataIdentity,
    ]);
  }
  if (value.domain === 'project' || value.domain === 'capabilities') {
    return Object.freeze([...common, value.targetKind, value.semanticRevision]);
  }
  if (value.domain === 'manifest' || value.domain === 'lock' || value.domain === 'ledger') {
    return Object.freeze([
      ...common,
      value.targetIdentity,
      value.targetKind,
      value.targetMetadataIdentity,
      value.parentIdentity,
      value.parentKind,
      value.parentMetadataIdentity,
      value.byteRevision,
      value.semanticRevision,
    ]);
  }
  if (value.domain === 'live') {
    return Object.freeze([
      ...common,
      value.targetIdentity,
      value.targetKind,
      value.targetMetadataIdentity,
      value.parentIdentity,
      value.parentKind,
      value.parentMetadataIdentity,
      value.resourceRevision,
      value.contentRevision,
    ]);
  }
  return Object.freeze([
    ...common,
    value.targetIdentity,
    value.targetKind,
    value.targetMetadataIdentity,
    value.parentIdentity,
    value.parentKind,
    value.parentMetadataIdentity,
    value.resourceRevision,
    value.contentRevision,
    value.snapshotIdentity,
  ]);
};

const validCommon = (value: Readonly<Record<string, unknown>>): boolean =>
  value.schemaVersion === 1 &&
  typeof value.domain === 'string' &&
  DOMAINS.has(value.domain as StateDomainV1) &&
  isString(value.resourceId);

const validAbsent = (value: Readonly<Record<string, unknown>>, withDigests: boolean): boolean =>
  FILESYSTEM_DOMAINS.has(value.domain as StateDomainV1) &&
  value.state === 'absent' &&
  value.targetKind === 'absent' &&
  isString(value.targetIdentity) &&
  isString(value.parentIdentity) &&
  (value.parentKind === 'directory' || value.parentKind === 'absent') &&
  isString(value.parentMetadataIdentity) &&
  (value.parentKind === 'absent' || METADATA.test(value.parentMetadataIdentity)) &&
  (!withDigests ||
    (typeof value.absenceDigest === 'string' &&
      ABSENCE.test(value.absenceDigest) &&
      typeof value.revisionDigest === 'string' &&
      REVISION.test(value.revisionDigest)));

const validPresent = (value: Readonly<Record<string, unknown>>, withDigest: boolean): boolean => {
  if (value.state !== 'present') return false;
  if (
    withDigest &&
    (typeof value.revisionDigest !== 'string' || !REVISION.test(value.revisionDigest))
  ) {
    return false;
  }
  if (SEMANTIC_DOMAINS.has(value.domain as StateDomainV1)) {
    return value.targetKind === 'semantic' && SHA256.test(String(value.semanticRevision));
  }
  const common =
    isString(value.targetIdentity) &&
    typeof value.targetMetadataIdentity === 'string' &&
    METADATA.test(value.targetMetadataIdentity) &&
    isString(value.parentIdentity) &&
    value.parentKind === 'directory' &&
    METADATA.test(String(value.parentMetadataIdentity));
  if (!common) return false;
  if (ARTIFACT_DOMAINS.has(value.domain as StateDomainV1)) {
    return (
      value.targetKind === 'file' &&
      SHA256.test(String(value.byteRevision)) &&
      SHA256.test(String(value.semanticRevision))
    );
  }
  if (value.domain === 'live') {
    return (
      (value.targetKind === 'file' ||
        value.targetKind === 'directory' ||
        value.targetKind === 'symlink') &&
      SHA256.test(String(value.resourceRevision)) &&
      (value.contentRevision === null || SHA256.test(String(value.contentRevision)))
    );
  }
  return (
    value.domain === 'store' &&
    value.targetKind === 'directory' &&
    SHA256.test(String(value.resourceRevision)) &&
    SHA256.test(String(value.contentRevision)) &&
    typeof value.snapshotIdentity === 'string' &&
    /^store:v1:[0-9a-f]{64}$/u.test(value.snapshotIdentity) &&
    value.snapshotIdentity ===
      createStoreSnapshotIdentityV1(value.resourceId as string, value.contentRevision as string)
  );
};

const inputKeys = (value: Readonly<Record<string, unknown>>): readonly string[] => {
  if (value.state === 'absent') {
    return [
      'schemaVersion',
      'domain',
      'resourceId',
      'state',
      'targetIdentity',
      'targetKind',
      'parentIdentity',
      'parentKind',
      'parentMetadataIdentity',
    ];
  }
  if (value.domain === 'project' || value.domain === 'capabilities') {
    return ['schemaVersion', 'domain', 'resourceId', 'state', 'targetKind', 'semanticRevision'];
  }
  const common = [
    'schemaVersion',
    'domain',
    'resourceId',
    'state',
    'targetIdentity',
    'targetKind',
    'targetMetadataIdentity',
    'parentIdentity',
    'parentKind',
    'parentMetadataIdentity',
  ];
  if (value.domain === 'manifest' || value.domain === 'lock' || value.domain === 'ledger') {
    return [...common, 'byteRevision', 'semanticRevision'];
  }
  if (value.domain === 'live') return [...common, 'resourceRevision', 'contentRevision'];
  return [...common, 'resourceRevision', 'contentRevision', 'snapshotIdentity'];
};

const revisionKeys = (value: Readonly<Record<string, unknown>>): readonly string[] => [
  ...inputKeys(value),
  ...(value.state === 'absent' ? ['absenceDigest'] : []),
  'revisionDigest',
];

export const isExpectedRevisionV1 = (input: unknown): input is ExpectedRevisionV1 => {
  const value = record(input);
  if (
    value === null ||
    !validCommon(value) ||
    !hasExactKeys(value, revisionKeys(value)) ||
    !(value.state === 'absent' ? validAbsent(value, true) : validPresent(value, true))
  ) {
    return false;
  }
  const tuple = tupleWithoutDigests(value);
  if (value.state === 'absent') {
    const absenceDigest = digest('absence', tuple);
    return (
      value.absenceDigest === absenceDigest &&
      value.revisionDigest === digest('revision', [...tuple, absenceDigest])
    );
  }
  return value.revisionDigest === digest('revision', tuple);
};

export const createExpectedRevisionV1 = (
  input: unknown,
): Result<ExpectedRevisionV1, StateTypeError> => {
  const owned = ownOrdinaryData(input, (_path, value) => value.length > 0);
  if (!owned.ok) return err(stateTypeError());
  const value = record(owned.value);
  if (
    value === null ||
    !validCommon(value) ||
    !hasExactKeys(value, inputKeys(value)) ||
    !(value.state === 'absent' ? validAbsent(value, false) : validPresent(value, false))
  ) {
    return err(stateTypeError());
  }
  const tuple = tupleWithoutDigests(value);
  const output =
    value.state === 'absent'
      ? Object.freeze({
          ...value,
          absenceDigest: digest('absence', tuple),
          revisionDigest: digest('revision', [...tuple, digest('absence', tuple)]),
        })
      : Object.freeze({
          ...value,
          revisionDigest: digest('revision', tuple),
        });
  return ok(output as ExpectedRevisionV1);
};

const CONTENT_OBSERVATION_KEYS = Object.freeze([
  'schemaVersion',
  'resourceId',
  'targetIdentity',
  'targetKind',
  'contentRevision',
]);

export const isContentObservationIdentityV1 = (
  input: unknown,
): input is ContentObservationIdentityV1 => {
  const value = record(input);
  if (
    value === null ||
    !hasExactKeys(value, CONTENT_OBSERVATION_KEYS) ||
    value.schemaVersion !== 1 ||
    !isString(value.resourceId) ||
    !isString(value.targetIdentity) ||
    (value.targetKind !== 'file' && value.targetKind !== 'directory') ||
    typeof value.contentRevision !== 'string' ||
    !SHA256.test(value.contentRevision)
  ) {
    return false;
  }
  try {
    return (
      isAbsolute(value.targetIdentity) && normalize(value.targetIdentity) === value.targetIdentity
    );
  } catch {
    return false;
  }
};

export const createContentObservationIdentityV1 = (
  input: unknown,
): ContentObservationIdentityV1 => {
  const owned = ownOrdinaryData(input, (_path, value) => value.length > 0);
  const value = owned.ok ? record(owned.value) : null;
  if (
    value === null ||
    !hasExactKeys(value, CONTENT_OBSERVATION_KEYS) ||
    value.schemaVersion !== 1 ||
    !isString(value.resourceId) ||
    !isString(value.targetIdentity) ||
    (value.targetKind !== 'file' &&
      value.targetKind !== 'dir' &&
      value.targetKind !== 'directory') ||
    typeof value.contentRevision !== 'string' ||
    !SHA256.test(value.contentRevision)
  ) {
    throw new TypeError('content observation identity input is invalid');
  }
  let targetIdentity: string;
  try {
    if (!isAbsolute(value.targetIdentity)) {
      throw new TypeError('content observation identity input is invalid');
    }
    targetIdentity = normalize(value.targetIdentity);
  } catch {
    throw new TypeError('content observation identity input is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    resourceId: value.resourceId,
    targetIdentity,
    targetKind: value.targetKind === 'dir' ? 'directory' : value.targetKind,
    contentRevision: value.contentRevision as `sha256:${string}`,
  });
};

export const createContentObservationPreconditionIdV1 = (
  identity: ContentObservationIdentityV1,
): `precondition:v1:${string}` => {
  if (!isContentObservationIdentityV1(identity)) {
    throw new TypeError('content observation precondition input is invalid');
  }
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-content-observation-precondition',
      1,
      identity.resourceId,
      identity.targetKind,
      identity.contentRevision,
    ]),
  );
  if (!hashed.ok) throw new Error('content observation precondition hash invariant failed');
  return `precondition:v1:${hashed.value.slice('sha256:'.length)}`;
};

/** Canonical private identity shared by snapshot planners and revision-backed execution observers. */
export const createExpectedRevisionPreconditionIdV1 = (
  revision: ExpectedRevisionV1,
): `precondition:v1:${string}` => {
  if (!isExpectedRevisionV1(revision)) {
    throw new TypeError('expected revision precondition input is invalid');
  }
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-expected-revision-precondition',
      1,
      revision.domain,
      revision.resourceId,
      revision.revisionDigest,
    ]),
  );
  if (!hashed.ok) throw new Error('expected revision precondition hash invariant failed');
  return `precondition:v1:${hashed.value.slice('sha256:'.length)}`;
};

export const sameExpectedRevisionV1 = (left: unknown, right: unknown): boolean => {
  if (!isExpectedRevisionV1(left) || !isExpectedRevisionV1(right)) return false;
  const canonical = (value: ExpectedRevisionV1): readonly unknown[] =>
    Object.freeze([
      ...tupleWithoutDigests(value as unknown as Readonly<Record<string, unknown>>),
      ...(value.state === 'absent' ? [value.absenceDigest] : []),
      value.revisionDigest,
    ]);
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
};
