import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import { placementSnapshotResourceId } from '../../src/place/execute.ts';
import type { ExecutableOperation, OperationSource } from '../../src/planning/types.ts';
import {
  createSyncPlacementExecutionPlanV1,
  prepareSyncStoreResourcesV1,
  toSyncReportOperationV1,
} from '../../src/sync/execute.ts';
import type { SyncFleetResourceSelectionV1, SyncFleetSelectedPairV1 } from '../../src/sync/plan.ts';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const OLD_HASH = `sha256:${'b'.repeat(64)}` as const;
const localSource: OperationSource = {
  kind: 'local-dev',
  path: '/fixture/source/alpha',
  contentHash: HASH,
};
const portableSource: OperationSource = {
  kind: 'portable',
  identity: { host: 'fixture.invalid', repository: 'acme/skills', path: 'skills/alpha' },
  requestedRef: 'main',
  resolvedSha: 'c'.repeat(40),
  sourcePath: 'skills/alpha',
  contentHash: HASH,
};
const resource = {
  kind: 'live' as const,
  skill: 'alpha',
  tool: 'codex' as const,
  scope: 'user' as const,
  projectRoot: null,
  location: { kind: 'machine-bound' as const, path: '/fixture/live/alpha' },
};
const operation = (source: OperationSource = localSource): ExecutableOperation => ({
  operationId: 'operation:sync-alpha',
  groupId: 'group:sync-alpha',
  pairId: 'pair:sync-alpha-codex',
  kind: 'update',
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: [],
  },
  skill: 'alpha',
  source,
  tool: 'codex',
  scope: 'user',
  before: {
    kind: 'placement',
    resource,
    classification: 'unmanaged',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source: null,
    contentHash: OLD_HASH,
  },
  after: {
    kind: 'placement',
    resource,
    classification: 'pinned',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source,
    contentHash: HASH,
  },
  reason: { code: 'sync-update-selected', message: 'Update alpha.' },
  selectionSource: 'bounded-default',
  preconditionIds: [],
  requiredCheckIds: [],
  reversibility: { kind: 'conditional', retentionResourceIds: ['pair:sync-alpha-codex'] },
  mutates: { live: true, manifest: false, lock: false, ledger: true },
  conflict: null,
});
const pinned = {
  storePath: '/fixture/store/alpha',
  rev: 'local-alpha',
  gitSha: null,
  dirty: false,
  contentHash: HASH,
  snapshotAt: '2026-07-21T00:00:00.000Z',
  verify: 'passed' as const,
  placement: 'copy' as const,
};

const contentIdentity = (resourceId: string, targetIdentity: string) => ({
  schemaVersion: 1 as const,
  resourceId,
  targetIdentity,
  targetKind: 'directory' as const,
  contentRevision: HASH,
});

const selectedPair = (
  bindingKey: string,
  skill: string,
  sourcePath: string,
  source: OperationSource,
): SyncFleetSelectedPairV1 => ({
  bindingKey,
  action: 'converge',
  pair: {
    skill,
    tool: 'codex',
    scope: 'user',
    scopeKey: null,
    placement: {
      skill,
      root: '/fixture/live',
      path: join('/fixture/live', skill),
      class: 'absent',
      symlinkTarget: null,
      dangling: false,
    },
    notices: [],
  },
  source: null,
  destination: null,
  operationSource: source,
  store: { bindingKey, skill, tool: 'codex', sourcePath, contentHash: HASH },
  representation: 'copy',
  groupIdentityTarget: `fixture:${skill}`,
});

const storeSelection = (): SyncFleetResourceSelectionV1 => {
  const local = selectedPair('binding:local', 'alpha', '/fixture/source/alpha', localSource);
  const portable = selectedPair('binding:portable', 'beta', '/fixture/materialized/beta', {
    ...portableSource,
    identity: {
      ...portableSource.identity,
      repository: 'acme/platform/tools',
      path: 'skills/beta',
    },
    sourcePath: 'skills/beta',
  });
  return {
    schemaVersion: 1,
    options: {
      targets: [],
      delete: false,
      continueOnError: false,
      save: true,
      force: false,
    },
    destinationEndpointIdentity: 'sync-endpoint:v1:fixture',
    tools: ['codex'],
    scope: 'user',
    projectRoot: null,
    pairs: [local, portable],
    stores: [local.store, portable.store].filter(
      (store): store is NonNullable<SyncFleetSelectedPairV1['store']> => store !== null,
    ),
    sourceMembership: contentIdentity('membership:source', '/fixture/source'),
    destinationMembership: contentIdentity('membership:destination', '/fixture/live'),
    sourceMembershipHash: HASH as ArtifactDigest,
    destinationMembershipHash: HASH as ArtifactDigest,
  };
};

describe('sync placement execution projection', () => {
  test('projects exact local and portable store identities through one shared authority', () => {
    const storeRoot = '/fixture/store';
    const prepared = prepareSyncStoreResourcesV1(storeSelection(), storeRoot);
    const localPath = join(storeRoot, 'local', 'alpha@content-aaaaaaaaaaaa', 'alpha');
    const portablePath = join(storeRoot, 'acme', `platform-tools@${'c'.repeat(12)}`, 'beta');
    const localId = placementSnapshotResourceId('store', resolve(localPath));
    const portableId = placementSnapshotResourceId('store', resolve(portablePath));

    expect([...prepared.stores.entries()]).toEqual([
      [
        'binding:local',
        {
          bindingKey: 'binding:local',
          sourcePath: '/fixture/source/alpha',
          skill: 'alpha',
          provenance: {
            kind: 'non-git',
            repoRoot: null,
            sourceRelPath: null,
            remote: null,
            gitSha: null,
            ns: 'local',
            name: 'alpha',
            dirtySummary: null,
          },
          storePath: localPath,
          rev: 'content-aaaaaaaaaaaa',
          contentHash: HASH,
        },
      ],
      [
        'binding:portable',
        {
          bindingKey: 'binding:portable',
          sourcePath: '/fixture/materialized/beta',
          skill: 'beta',
          provenance: {
            kind: 'git-clean',
            repoRoot: null,
            sourceRelPath: 'skills/beta',
            remote: 'acme/platform/tools',
            gitSha: 'c'.repeat(40),
            ns: 'acme',
            name: 'platform-tools',
            dirtySummary: null,
          },
          storePath: portablePath,
          rev: 'c'.repeat(12),
          contentHash: HASH,
        },
      ],
    ]);
    expect(prepared.resources).toEqual([
      { resourceId: localId, storePath: localPath, contentHash: HASH },
      { resourceId: portableId, storePath: portablePath, contentHash: HASH },
    ]);
    expect(prepared.bindings.storeResourceIdsByPair).toEqual({
      'binding:local': localId,
      'binding:portable': portableId,
    });
    expect(Object.isFrozen(prepared.resources)).toBeTrue();
    expect(Object.isFrozen(prepared.bindings.storeResourceIdsByPair)).toBeTrue();
  });

  test('projects a detached frozen report operation without planner-only dependencies', () => {
    const planned: ExecutableOperation = {
      ...operation(),
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: ['operation:before'],
      },
      preconditionIds: ['precondition:one'],
      requiredCheckIds: ['check:one'],
    };
    const report = toSyncReportOperationV1(planned);
    const { dependencyMetadata, ...wireFields } = planned;

    expect(report).toEqual({
      ...wireFields,
      dependsOn: [...dependencyMetadata.operationIds],
    } as unknown as typeof report);
    expect('dependencyMetadata' in report).toBeFalse();
    expect(report.dependsOn).not.toBe(planned.dependencyMetadata.operationIds);
    expect(report.preconditionIds).not.toBe(planned.preconditionIds);
    expect(report.requiredCheckIds).not.toBe(planned.requiredCheckIds);
    expect(report.reversibility).not.toBe(planned.reversibility);
    expect(Object.isFrozen(report)).toBeTrue();
    expect(Object.isFrozen(report.dependsOn)).toBeTrue();
    expect(Object.isFrozen(report.preconditionIds)).toBeTrue();
    expect(Object.isFrozen(report.requiredCheckIds)).toBeTrue();
    expect(Object.isFrozen(report.reversibility.retentionResourceIds)).toBeTrue();
  });

  test('binds local update to the existing install swap without synthetic origin', () => {
    const result = createSyncPlacementExecutionPlanV1(operation(), {
      operationId: 'operation:sync-alpha',
      placementPath: '/fixture/live/alpha',
      scopeKey: null,
      storePath: '/fixture/store/alpha',
      pinned,
      origin: null,
    });
    expect(result).toMatchObject({
      kind: 'swap',
      plan: {
        op: 'install',
        install: { build: 'copy', origin: null, contentHash: HASH },
      },
    });
  });

  test('requires exact portable provenance and preserves it', () => {
    const origin = {
      source: 'fixture.invalid/acme/skills//skills/alpha',
      host: 'fixture.invalid',
      repo: 'acme/skills',
      skillPath: 'skills/alpha',
      refRequested: 'main',
      refResolved: 'c'.repeat(40),
      pin: true,
      installedAt: '2026-07-21T00:00:00.000Z',
    };
    const result = createSyncPlacementExecutionPlanV1(operation(portableSource), {
      operationId: 'operation:sync-alpha',
      placementPath: '/fixture/live/alpha',
      scopeKey: null,
      storePath: '/fixture/store/alpha',
      pinned: { ...pinned, gitSha: 'c'.repeat(40) },
      origin,
    });
    expect(result).toMatchObject({ kind: 'swap', plan: { install: { origin } } });
  });

  test('refuses provenance fabrication and mismatched pair-to-store bindings', () => {
    const fakeOrigin = {
      source: 'fixture.invalid/fake/repo',
      host: 'fixture.invalid',
      repo: 'fake/repo',
      skillPath: 'skills/alpha',
      refRequested: null,
      refResolved: 'd'.repeat(40),
      pin: true,
      installedAt: '2026-07-21T00:00:00.000Z',
    };
    expect(() =>
      createSyncPlacementExecutionPlanV1(operation(), {
        operationId: 'operation:sync-alpha',
        placementPath: '/fixture/live/alpha',
        scopeKey: null,
        storePath: '/fixture/store/alpha',
        pinned,
        origin: fakeOrigin,
      }),
    ).toThrow('machine-bound sync cannot carry portable provenance');
    expect(() =>
      createSyncPlacementExecutionPlanV1(operation(), {
        operationId: 'operation:sync-alpha',
        placementPath: '/fixture/live/alpha',
        scopeKey: null,
        storePath: '/fixture/store/beta',
        pinned,
        origin: null,
      }),
    ).toThrow('execution binding is incoherent');
  });
});
