import { basename, join, resolve } from 'node:path';
import type { SyncReportV1Dto } from '../contracts/v1/sync.ts';
import { type PlacementStoreResource, placementSnapshotResourceId } from '../place/execute.ts';
import { clampStoreNs } from '../place/store.ts';
import type { Provenance } from '../place/types.ts';
import type { ExecutableOperation } from '../planning/types.ts';
import type {
  SyncFleetResourceSelectionV1,
  SyncFleetSelectedPairV1,
  SyncFleetStoreBindingsV1,
} from './plan.ts';

export interface PreparedSyncStoreV1 {
  readonly bindingKey: string;
  readonly sourcePath: string;
  readonly skill: string;
  readonly provenance: Provenance;
  readonly storePath: string;
  readonly rev: string;
  readonly contentHash: `sha256:${string}`;
}

export interface PreparedSyncStoreResourcesV1 {
  readonly stores: ReadonlyMap<string, PreparedSyncStoreV1>;
  readonly resources: readonly PlacementStoreResource[];
  readonly bindings: SyncFleetStoreBindingsV1;
}

const syncStoreProvenanceV1 = (pair: SyncFleetSelectedPairV1): Provenance => {
  const source = pair.operationSource;
  if (source?.kind === 'portable') {
    const clamped = clampStoreNs(source.identity.repository);
    return Object.freeze({
      kind: 'git-clean',
      repoRoot: null,
      sourceRelPath: source.sourcePath,
      remote: source.identity.repository,
      gitSha: source.resolvedSha,
      ns: clamped.ns,
      name: clamped.name,
      dirtySummary: null,
    });
  }
  return Object.freeze({
    kind: 'non-git',
    repoRoot: null,
    sourceRelPath: null,
    remote: null,
    gitSha: null,
    ns: 'local',
    name: basename(pair.store?.sourcePath ?? pair.pair.skill),
    dirtySummary: null,
  });
};

/** Internal projection of selected sync stores to exact durable identities. */
export const prepareSyncStoreResourcesV1 = (
  selection: SyncFleetResourceSelectionV1,
  storeRoot: string,
): Readonly<PreparedSyncStoreResourcesV1> => {
  const stores = new Map<string, PreparedSyncStoreV1>();
  const resources = new Map<string, PlacementStoreResource>();
  const storeResourceIdsByPair: Record<string, string> = {};
  for (const descriptor of selection.stores) {
    const pair = selection.pairs.find(({ bindingKey }) => bindingKey === descriptor.bindingKey);
    if (pair === undefined) throw new Error('selected sync store has no exact pair');
    const provenance = syncStoreProvenanceV1(pair);
    const hash12 = descriptor.contentHash.slice('sha256:'.length, 'sha256:'.length + 12);
    const rev =
      provenance.kind === 'git-clean'
        ? (provenance.gitSha?.slice(0, 12) ?? '')
        : provenance.kind === 'git-dirty'
          ? `dirty-${hash12}`
          : `content-${hash12}`;
    if (rev.length === 0) throw new Error('selected sync store revision is unavailable');
    const storePath = join(storeRoot, provenance.ns, `${provenance.name}@${rev}`, descriptor.skill);
    const resourceId = placementSnapshotResourceId('store', resolve(storePath));
    const prepared = Object.freeze({
      bindingKey: descriptor.bindingKey,
      sourcePath: descriptor.sourcePath,
      skill: descriptor.skill,
      provenance,
      storePath,
      rev,
      contentHash: descriptor.contentHash,
    });
    stores.set(descriptor.bindingKey, prepared);
    storeResourceIdsByPair[descriptor.bindingKey] = resourceId;
    const existing = resources.get(resourceId);
    if (existing !== undefined && existing.contentHash !== descriptor.contentHash) {
      throw new Error('selected sync stores collide with different content');
    }
    resources.set(
      resourceId,
      Object.freeze({ resourceId, storePath, contentHash: descriptor.contentHash }),
    );
  }
  return Object.freeze({
    stores,
    resources: Object.freeze([...resources.values()]),
    bindings: Object.freeze({ storeResourceIdsByPair: Object.freeze(storeResourceIdsByPair) }),
  });
};

/** Internal detached wire projection for an executable sync operation. */
export const toSyncReportOperationV1 = (
  operation: ExecutableOperation,
): SyncReportV1Dto['operations'][number] => {
  const { dependencyMetadata, ...value } = operation;
  return Object.freeze({
    ...value,
    dependsOn: Object.freeze([...dependencyMetadata.operationIds]),
    preconditionIds: Object.freeze([...value.preconditionIds]),
    requiredCheckIds: Object.freeze([...value.requiredCheckIds]),
    reversibility: Object.freeze({
      ...value.reversibility,
      retentionResourceIds: Object.freeze([...value.reversibility.retentionResourceIds]),
    }),
  }) as SyncReportV1Dto['operations'][number];
};
