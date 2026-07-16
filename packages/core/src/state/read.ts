import { hashCanonicalInput, hashManifestSemantics } from '../artifacts/hash.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import { hashPortableLock, serializePortableLock } from '../artifacts/lock.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import { ledgerSemanticRevision } from '../artifacts/registry.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import type { CapabilitySnapshotV1Dto } from '../contracts/v1/capability-snapshot.ts';
import { type Result, err, ok } from '../result.ts';
import {
  containsSensitiveMaterial,
  isSensitivePropertyName,
  redactSensitiveString,
} from '../safety/redaction.ts';
import { ownOrdinaryData } from './ownership.ts';
import type { ObservedStateRepositoriesV1, StateRepositoryError } from './repositories.ts';
import {
  type ExpectedRevisionV1,
  type ObservedComponentV1,
  type ObservedStateSnapshotV1,
  type StateDomainV1,
  isExpectedRevisionV1,
  sameExpectedRevisionV1,
  semanticValueRevisionV1,
} from './types.ts';

export interface ObservedStateReadRequestV1 {
  readonly schemaVersion: 1;
  readonly projectResourceId: string;
  readonly manifestResourceId: string;
  readonly lockResourceId: string;
  readonly ledgerResourceId: string;
  readonly liveResourceIds: readonly string[];
  readonly storeResourceIds: readonly string[];
  readonly capabilitiesResourceId: string;
  readonly statusRevision?: `sha256:${string}`;
}

export interface SnapshotChangedError {
  readonly code: 'snapshot-changed';
}

export interface SnapshotReadRequestError {
  readonly code: 'snapshot-invalid-request';
}

export interface SnapshotObservationError {
  readonly code: 'snapshot-invalid-observation';
  readonly domain: StateDomainV1;
  readonly resourceId: string;
}

export type ObservedStateReadError =
  | SnapshotChangedError
  | SnapshotReadRequestError
  | SnapshotObservationError
  | StateRepositoryError;

interface ResourceDescriptor {
  readonly domain: StateDomainV1;
  readonly resourceId: string;
}

const invalidRequest = (): SnapshotReadRequestError =>
  Object.freeze({ code: 'snapshot-invalid-request' as const });

const invalidObservation = (domain: StateDomainV1, resourceId: string): SnapshotObservationError =>
  Object.freeze({ code: 'snapshot-invalid-observation' as const, domain, resourceId });

const nonemptyUniqueStrings = (values: readonly string[]): boolean =>
  values.every((value) => typeof value === 'string' && value.length > 0) &&
  new Set(values).size === values.length;

const canonicalResources = (
  request: ObservedStateReadRequestV1,
): Result<readonly ResourceDescriptor[], SnapshotReadRequestError> => {
  if (
    request === null ||
    typeof request !== 'object' ||
    request.schemaVersion !== 1 ||
    !nonemptyUniqueStrings([
      request.projectResourceId,
      request.manifestResourceId,
      request.lockResourceId,
      request.ledgerResourceId,
      request.capabilitiesResourceId,
    ]) ||
    !Array.isArray(request.liveResourceIds) ||
    !Array.isArray(request.storeResourceIds) ||
    !nonemptyUniqueStrings(request.liveResourceIds) ||
    !nonemptyUniqueStrings(request.storeResourceIds)
  ) {
    return err(invalidRequest());
  }
  const live = [...request.liveResourceIds].sort();
  const store = [...request.storeResourceIds].sort();
  const descriptors = [
    Object.freeze({ domain: 'project' as const, resourceId: request.projectResourceId }),
    Object.freeze({ domain: 'manifest' as const, resourceId: request.manifestResourceId }),
    Object.freeze({ domain: 'lock' as const, resourceId: request.lockResourceId }),
    Object.freeze({ domain: 'ledger' as const, resourceId: request.ledgerResourceId }),
    ...live.map((resourceId) => Object.freeze({ domain: 'live' as const, resourceId })),
    ...store.map((resourceId) => Object.freeze({ domain: 'store' as const, resourceId })),
    Object.freeze({
      domain: 'capabilities' as const,
      resourceId: request.capabilitiesResourceId,
    }),
  ];
  if (new Set(descriptors.map((descriptor) => descriptor.resourceId)).size !== descriptors.length) {
    return err(invalidRequest());
  }
  return ok(Object.freeze(descriptors));
};

const repositoryFor = <CapabilityModel>(
  repositories: ObservedStateRepositoriesV1<CapabilityModel>,
  domain: StateDomainV1,
) => repositories[domain];

const acceptsSnapshotString = (_path: string, value: string): boolean =>
  !containsSensitiveMaterial(value) || redactSensitiveString(value) === value;

const acceptsSnapshotProperty = (_path: string, key: string): boolean =>
  !isSensitivePropertyName(key);

const exactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const ordinaryRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const coherentProjectValue = (revision: ExpectedRevisionV1, value: unknown): boolean => {
  if (revision.domain !== 'project' || revision.state !== 'present') return false;
  const project = ordinaryRecord(value);
  return (
    project !== null &&
    exactKeys(project, [
      'invocationCwd',
      'effectiveCwd',
      'projectRoot',
      'projectIdentity',
      'projectKind',
      'discoveredConfigPath',
      'explicitConfigPath',
    ]) &&
    typeof project.invocationCwd === 'string' &&
    typeof project.effectiveCwd === 'string' &&
    (project.projectRoot === null || typeof project.projectRoot === 'string') &&
    (project.projectIdentity === null || typeof project.projectIdentity === 'string') &&
    project.projectRoot === project.projectIdentity &&
    (project.projectKind === 'git' || project.projectKind === 'non-git') &&
    (project.discoveredConfigPath === null || typeof project.discoveredConfigPath === 'string') &&
    (project.explicitConfigPath === null || typeof project.explicitConfigPath === 'string') &&
    revision.semanticRevision === semanticValueRevisionV1('project', project)
  );
};

const coherentArtifactValue = (revision: ExpectedRevisionV1, value: unknown): boolean => {
  if (
    revision.state !== 'present' ||
    (revision.domain !== 'manifest' && revision.domain !== 'lock' && revision.domain !== 'ledger')
  ) {
    return false;
  }
  if (revision.domain === 'manifest') {
    try {
      return revision.semanticRevision === hashManifestSemantics(value as NormalizedManifestV1);
    } catch {
      return false;
    }
  }
  if (revision.domain === 'lock') {
    const serialized = serializePortableLock(value as PortableLockV1);
    const semantic = hashPortableLock(value as PortableLockV1);
    if (!serialized.ok || !semantic.ok) return false;
    const bytes = hashCanonicalInput('resource', 1, serialized.value);
    return (
      bytes.ok &&
      revision.byteRevision === bytes.value &&
      revision.semanticRevision === semantic.value
    );
  }
  const semantic = ledgerSemanticRevision(value as LedgerModel);
  return semantic.ok && revision.semanticRevision === semantic.value;
};

const coherentLiveValue = (revision: ExpectedRevisionV1, value: unknown): boolean => {
  if (revision.domain !== 'live' || revision.state !== 'present') return false;
  const live = ordinaryRecord(value);
  return (
    live !== null &&
    exactKeys(live, [
      'skill',
      'tool',
      'scope',
      'projectIdentity',
      'representation',
      'path',
      'realpath',
      'linkTarget',
      'dangling',
      'placementClass',
      'skillFile',
      'brokenReason',
      'contentRevision',
    ]) &&
    revision.targetIdentity === live.path &&
    revision.targetKind === live.representation &&
    revision.contentRevision === live.contentRevision
  );
};

const coherentStoreValue = (revision: ExpectedRevisionV1, value: unknown): boolean => {
  if (revision.domain !== 'store' || revision.state !== 'present') return false;
  const store = ordinaryRecord(value);
  return (
    store !== null &&
    exactKeys(store, ['path', 'repositoryRevision', 'contentRevision', 'snapshotIdentity']) &&
    revision.targetIdentity === store.path &&
    revision.resourceRevision === store.repositoryRevision &&
    revision.contentRevision === store.contentRevision &&
    revision.snapshotIdentity === store.snapshotIdentity
  );
};

const coherentObservationValue = (revision: ExpectedRevisionV1, value: unknown): boolean => {
  if (revision.state === 'absent') return value === null;
  if (value === null) return false;
  if (revision.domain === 'project') return coherentProjectValue(revision, value);
  if (
    revision.domain === 'manifest' ||
    revision.domain === 'lock' ||
    revision.domain === 'ledger'
  ) {
    return coherentArtifactValue(revision, value);
  }
  if (revision.domain === 'live') return coherentLiveValue(revision, value);
  if (revision.domain === 'store') return coherentStoreValue(revision, value);
  return (
    revision.domain === 'capabilities' &&
    ordinaryRecord(value) !== null &&
    revision.semanticRevision === semanticValueRevisionV1('capabilities', value)
  );
};

const ownObservation = <Model>(
  input: ObservedComponentV1<Model>,
  descriptor: ResourceDescriptor,
): Result<ObservedComponentV1<Model>, SnapshotObservationError> => {
  const owned = ownOrdinaryData(input, acceptsSnapshotString, {
    rootPath: `$observation.${descriptor.domain}.${descriptor.resourceId}`,
    objectPrototype: 'null',
    acceptProperty: acceptsSnapshotProperty,
  });
  if (!owned.ok || typeof owned.value !== 'object' || owned.value === null) {
    return err(invalidObservation(descriptor.domain, descriptor.resourceId));
  }
  const candidate = owned.value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(candidate).length !== 2 ||
    !Object.hasOwn(candidate, 'revision') ||
    !Object.hasOwn(candidate, 'value') ||
    !isExpectedRevisionV1(candidate.revision) ||
    candidate.revision.domain !== descriptor.domain ||
    candidate.revision.resourceId !== descriptor.resourceId ||
    !coherentObservationValue(candidate.revision, candidate.value)
  ) {
    return err(invalidObservation(descriptor.domain, descriptor.resourceId));
  }
  return ok(
    Object.freeze({
      revision: candidate.revision,
      value: candidate.value as Model | null,
    }),
  );
};

interface SnapshotObserver<Model> {
  observe(resourceId: string): Promise<Result<ObservedComponentV1<Model>, StateRepositoryError>>;
}

const observeOwned = async <Model>(
  repository: SnapshotObserver<Model>,
  descriptor: ResourceDescriptor,
): Promise<Result<ObservedComponentV1<Model>, SnapshotObservationError | StateRepositoryError>> => {
  const observed = await repository.observe(descriptor.resourceId);
  return observed.ok ? ownObservation(observed.value, descriptor) : observed;
};

const snapshotId = (
  descriptors: readonly ResourceDescriptor[],
  revisions: readonly ExpectedRevisionV1[],
  statusRevision: `sha256:${string}` | undefined,
): `snapshot:v1:${string}` => {
  const vector = descriptors.map((descriptor, index) => {
    const revision = revisions[index];
    if (revision === undefined) throw new Error('snapshot revision vector invariant failed');
    return [descriptor.domain, descriptor.resourceId, revision.state, revision.revisionDigest];
  });
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-observed-state-snapshot',
      1,
      vector,
      statusRevision === undefined ? null : ['status', statusRevision],
    ]),
  );
  if (!hashed.ok) throw new Error('snapshot identity hash invariant failed');
  return `snapshot:v1:${hashed.value.slice('sha256:'.length)}`;
};

export const readObservedStateSnapshotV1 = async <CapabilityModel = CapabilitySnapshotV1Dto>(
  request: ObservedStateReadRequestV1,
  repositories: ObservedStateRepositoriesV1<CapabilityModel>,
): Promise<Result<ObservedStateSnapshotV1<CapabilityModel>, ObservedStateReadError>> => {
  const resources = canonicalResources(request);
  if (!resources.ok) return resources;
  if (
    request.statusRevision !== undefined &&
    !/^sha256:[0-9a-f]{64}$/u.test(request.statusRevision)
  ) {
    return err(invalidRequest());
  }

  const projectDescriptor = resources.value[0];
  const manifestDescriptor = resources.value[1];
  const lockDescriptor = resources.value[2];
  const ledgerDescriptor = resources.value[3];
  const liveStart = 4;
  const storeStart = liveStart + request.liveResourceIds.length;
  const storeEnd = storeStart + request.storeResourceIds.length;
  const capabilitiesDescriptor = resources.value[storeEnd];
  if (
    projectDescriptor === undefined ||
    manifestDescriptor === undefined ||
    lockDescriptor === undefined ||
    ledgerDescriptor === undefined ||
    capabilitiesDescriptor === undefined
  ) {
    return err(invalidRequest());
  }

  const project = await observeOwned(repositories.project, projectDescriptor);
  if (!project.ok) return project;
  const manifest = await observeOwned(repositories.manifest, manifestDescriptor);
  if (!manifest.ok) return manifest;
  const lock = await observeOwned(repositories.lock, lockDescriptor);
  if (!lock.ok) return lock;
  const ledger = await observeOwned(repositories.ledger, ledgerDescriptor);
  if (!ledger.ok) return ledger;
  const live: ObservedStateSnapshotV1<CapabilityModel>['live'][number][] = [];
  for (const descriptor of resources.value.slice(liveStart, storeStart)) {
    const observed = await observeOwned(repositories.live, descriptor);
    if (!observed.ok) return observed;
    live.push(observed.value);
  }
  const store: ObservedStateSnapshotV1<CapabilityModel>['store'][number][] = [];
  for (const descriptor of resources.value.slice(storeStart, storeEnd)) {
    const observed = await observeOwned(repositories.store, descriptor);
    if (!observed.ok) return observed;
    store.push(observed.value);
  }
  const capabilities = await observeOwned(repositories.capabilities, capabilitiesDescriptor);
  if (!capabilities.ok) return capabilities;
  const observations: readonly ObservedComponentV1<unknown>[] = Object.freeze([
    project.value,
    manifest.value,
    lock.value,
    ledger.value,
    ...live,
    ...store,
    capabilities.value,
  ]);

  const revisionVector: ExpectedRevisionV1[] = [];
  for (const descriptor of resources.value) {
    const observed = await repositoryFor(repositories, descriptor.domain).observeRevision(
      descriptor.resourceId,
    );
    if (!observed.ok) return observed;
    if (
      !isExpectedRevisionV1(observed.value) ||
      observed.value.domain !== descriptor.domain ||
      observed.value.resourceId !== descriptor.resourceId
    ) {
      return err(invalidObservation(descriptor.domain, descriptor.resourceId));
    }
    revisionVector.push(observed.value);
  }

  if (
    observations.some(
      (observation, index) => !sameExpectedRevisionV1(observation.revision, revisionVector[index]),
    )
  ) {
    return err(Object.freeze({ code: 'snapshot-changed' as const }));
  }

  const snapshot: ObservedStateSnapshotV1<CapabilityModel> = Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: snapshotId(
      resources.value,
      observations.map((observation) => observation.revision),
      request.statusRevision,
    ),
    ...(request.statusRevision === undefined ? {} : { statusRevision: request.statusRevision }),
    project: project.value,
    manifest: manifest.value,
    lock: lock.value,
    ledger: ledger.value,
    live: Object.freeze(live),
    store: Object.freeze(store),
    capabilities: capabilities.value,
  });
  return ok(snapshot);
};
