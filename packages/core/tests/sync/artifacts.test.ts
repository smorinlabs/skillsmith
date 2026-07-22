import { describe, expect, test } from 'bun:test';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type { ResolvedArtifactPair } from '../../src/artifacts/pair.ts';
import type { ArtifactReadPorts } from '../../src/artifacts/repository.ts';
import type { PortableExportCandidate } from '../../src/export/types.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import { createOperationGroupId } from '../../src/planning/create.ts';
import type {
  ExecutableOperation,
  OperationImage,
  OperationPlan,
  OperationSource,
} from '../../src/planning/types.ts';
import {
  type SyncArtifactAfterImageGroupV1,
  chainSyncArtifactAfterImagesV1,
  prepareSyncArtifactsV1,
} from '../../src/sync/artifacts.ts';
import type { SyncFleetResourceSelectionV1, SyncFleetSelectedPairV1 } from '../../src/sync/plan.ts';
import type { SyncFleetObservation, SyncMemberObservation } from '../../src/sync/types.ts';

const HASH = (value: string) => `sha256:${value.repeat(64)}` as `sha256:${string}`;
const PORTABLE_HASH = HASH('d') as ArtifactDigest;
const PORTABLE_SHA = 'c'.repeat(40);
const portableCandidate: PortableExportCandidate = Object.freeze({
  name: 'alpha',
  tools: Object.freeze(['codex'] as const),
  scope: 'project',
  source: Object.freeze({
    host: 'github.com',
    repository: 'acme/skills',
    path: 'skills/alpha',
  }),
  sourceText: 'github.com/acme/skills//skills/alpha',
  requestedRef: 'main',
  resolvedSha: PORTABLE_SHA,
  sourcePath: 'skills/alpha',
  contentHash: PORTABLE_HASH,
  placement: 'copy',
  path: null,
  classification: 'portable-managed',
});
const portableSource: Extract<OperationSource, { kind: 'portable' }> = Object.freeze({
  kind: 'portable',
  identity: portableCandidate.source,
  requestedRef: portableCandidate.requestedRef,
  resolvedSha: portableCandidate.resolvedSha,
  sourcePath: portableCandidate.sourcePath,
  contentHash: HASH('d'),
});
const manifest = (hash: `sha256:${string}`): Extract<OperationImage, { kind: 'manifest' }> => ({
  kind: 'manifest',
  location: { kind: 'machine-bound', path: '/fixture/skillsmith.toml' },
  shape: 'canonical',
  version: 1,
  byteHash: hash,
  semanticHash: hash,
  value: { version: 1, defaults: null, registry: null, skills: [] },
});
const lock = (hash: `sha256:${string}`): Extract<OperationImage, { kind: 'lock' }> => ({
  kind: 'lock',
  location: { kind: 'machine-bound', path: '/fixture/skillsmith.lock' },
  version: 1,
  canonicalHash: hash,
  value: {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hash,
    skills: [],
  },
});
const artifactOperation = (
  groupId: string,
  operationId: string,
  kind: 'write-manifest' | 'write-lock',
  before: OperationImage,
  after: OperationImage,
  dependencies: readonly string[] = [],
): ExecutableOperation => ({
  operationId,
  groupId,
  pairId: null,
  kind,
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: dependencies,
  },
  skill: null,
  source: null,
  tool: null,
  scope: null,
  before,
  after,
  reason: { code: `${kind}-selected`, message: `${kind} selected.` },
  selectionSource: 'bounded-default',
  preconditionIds: [],
  requiredCheckIds: [],
  reversibility: { kind: 'none', retentionResourceIds: [] },
  mutates: {
    live: false,
    manifest: kind === 'write-manifest',
    lock: kind === 'write-lock',
    ledger: false,
  },
  conflict: null,
});
const placementOperation = (groupId: string, operationId: string): ExecutableOperation => ({
  ...artifactOperation(groupId, operationId, 'write-lock', lock(HASH('a')), lock(HASH('b'))),
  pairId: 'pair:alpha',
  kind: 'remove',
  skill: 'alpha',
  tool: 'codex',
  scope: 'user',
  before: {
    kind: 'placement',
    resource: {
      kind: 'live',
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectRoot: null,
      location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
    },
    classification: 'pinned',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source: null,
    contentHash: null,
  },
  after: {
    kind: 'absent',
    resource: {
      kind: 'live',
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectRoot: null,
      location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
    },
  },
  mutates: { live: true, manifest: false, lock: false, ledger: true },
});

const group = (
  groupId: string,
  beforeManifest: Extract<OperationImage, { kind: 'manifest' }>,
  afterManifest: Extract<OperationImage, { kind: 'manifest' }>,
  beforeLock: Extract<OperationImage, { kind: 'lock' }>,
  afterLock: Extract<OperationImage, { kind: 'lock' }>,
): SyncArtifactAfterImageGroupV1 => {
  const manifestOperationId = `${groupId}:manifest`;
  const lockOperationId = `${groupId}:lock`;
  return {
    groupId,
    manifestOperation: artifactOperation(
      groupId,
      manifestOperationId,
      'write-manifest',
      beforeManifest,
      afterManifest,
    ) as SyncArtifactAfterImageGroupV1['manifestOperation'],
    lockOperation: artifactOperation(
      groupId,
      lockOperationId,
      'write-lock',
      beforeLock,
      afterLock,
      [manifestOperationId],
    ) as SyncArtifactAfterImageGroupV1['lockOperation'],
    placementOperations: [placementOperation(groupId, `${groupId}:live`)],
  };
};

const contentIdentity = (resourceId: string, targetIdentity: string) =>
  Object.freeze({
    schemaVersion: 1 as const,
    resourceId,
    targetIdentity,
    targetKind: 'directory' as const,
    contentRevision: HASH('d'),
  });

const portableSaveFixture = (): Readonly<{
  fleet: SyncFleetObservation;
  selection: SyncFleetResourceSelectionV1;
  livePlan: OperationPlan<'sync'>;
  pair: ResolvedArtifactPair;
  ports: ArtifactReadPorts;
}> => {
  const project = Object.freeze({
    invocationCwd: '/fixture/project',
    effectiveCwd: '/fixture/project',
    projectRoot: '/fixture/project',
    projectIdentity: '/fixture/project',
    projectKind: 'git' as const,
    discoveredConfigPath: null,
    explicitConfigPath: null,
  });
  const sourceEntry = Object.freeze({
    name: 'alpha',
    path: '/fixture/source/alpha',
    realpath: '/fixture/source/alpha',
    tool: 'codex' as const,
    scope: 'project' as const,
    root: '/fixture/source',
    frontmatter: null,
    origin: { kind: 'standalone' as const },
    enabled: 'on' as const,
    mode: 'pinned' as const,
    placement: 'copy' as const,
    source: portableCandidate.sourceText,
    revision: PORTABLE_SHA,
    store: '/fixture/store/acme/skills',
    verification: 'passed' as const,
    description: null,
    visibility: Object.freeze({
      state: 'unique' as const,
      winner: null,
      members: Object.freeze([
        Object.freeze({ scope: 'project' as const, path: '/fixture/source/alpha' }),
      ]),
    }),
  });
  const sourceMember: SyncMemberObservation = Object.freeze({
    entry: sourceEntry,
    ledgerPair: null,
    liveContentHash: PORTABLE_HASH,
    pendingJournal: false,
    pendingTransactionIds: Object.freeze([]),
    defaultLocation: true,
    portable: Object.freeze({ outcome: 'portable' as const, candidate: portableCandidate }),
  });
  const bindingKey = 'binding:alpha:codex';
  const store = Object.freeze({
    bindingKey,
    skill: 'alpha',
    tool: 'codex' as const,
    sourcePath: sourceEntry.realpath,
    contentHash: HASH('d'),
  });
  const selected: SyncFleetSelectedPairV1 = Object.freeze({
    bindingKey,
    action: 'converge' as const,
    pair: Object.freeze({
      skill: 'alpha',
      tool: 'codex' as const,
      scope: 'project' as const,
      scopeKey: '/fixture/project',
      placement: Object.freeze({
        skill: 'alpha',
        root: '/fixture/project/.agents/skills',
        path: '/fixture/project/.agents/skills/alpha',
        class: 'absent' as const,
        symlinkTarget: null,
        dangling: false,
      }),
      notices: [],
    }),
    source: sourceMember,
    destination: null,
    operationSource: portableSource,
    store,
    representation: 'copy' as const,
    groupIdentityTarget: 'fixture:alpha',
  });
  const selection: SyncFleetResourceSelectionV1 = Object.freeze({
    schemaVersion: 1 as const,
    options: Object.freeze({
      targets: Object.freeze([]),
      delete: false,
      continueOnError: false,
      save: true,
      force: false,
    }),
    destinationEndpointIdentity: 'sync-endpoint:v1:destination',
    tools: Object.freeze(['codex'] as const),
    scope: 'project' as const,
    projectRoot: Object.freeze({ kind: 'machine-bound' as const, path: '/fixture/project' }),
    pairs: Object.freeze([selected]),
    stores: Object.freeze([store]),
    sourceMembership: contentIdentity('membership:source', '/fixture/source'),
    destinationMembership: contentIdentity('membership:destination', '/fixture/project'),
    sourceMembershipHash: PORTABLE_HASH,
    destinationMembershipHash: PORTABLE_HASH,
  });
  const endpoint = (
    role: 'source' | 'destination',
    selectedInput: string,
    identity: `sync-endpoint:v1:${string}`,
  ) =>
    Object.freeze({
      role,
      selectedInput,
      kind: 'project' as const,
      scope: 'project' as const,
      canonicalBase: role === 'source' ? '/fixture/source' : '/fixture/project',
      project,
      roots: Object.freeze([]),
      identity,
    });
  const inventorySelection = Object.freeze({
    source: 'bounded-default' as const,
    tools: Object.freeze(['codex'] as const),
    scopes: Object.freeze(['project' as const]),
    filters: Object.freeze({}),
    outcome: 'selected' as const,
  });
  const absentLedger = Object.freeze({
    state: 'absent' as const,
    artifact: 'ledger' as const,
    migration: null,
  });
  const from = endpoint('source', '/fixture/source', 'sync-endpoint:v1:source');
  const to = endpoint('destination', '/fixture/project', 'sync-endpoint:v1:destination');
  const fleet: SyncFleetObservation = Object.freeze({
    endpoints: Object.freeze({ tools: Object.freeze(['codex'] as const), from, to }),
    portableProof: 'exact' as const,
    source: Object.freeze({
      endpoint: from,
      inventory: Object.freeze({
        selection: inventorySelection,
        entries: Object.freeze([sourceEntry]),
        collisionGroups: Object.freeze([]),
      }),
      entries: Object.freeze([sourceMember]),
      membershipHash: PORTABLE_HASH,
      ledger: absentLedger,
      ledgerPath: '/fixture/source/placements.json',
    }),
    destination: Object.freeze({
      endpoint: to,
      inventory: Object.freeze({
        selection: inventorySelection,
        entries: Object.freeze([]),
        collisionGroups: Object.freeze([]),
      }),
      entries: Object.freeze([]),
      membershipHash: PORTABLE_HASH,
      ledger: Object.freeze({
        state: 'present' as const,
        artifact: 'ledger' as const,
        sourceVersion: 2 as const,
        currentVersion: 2 as const,
        source: '{}',
        byteLength: 2,
        byteRevision: PORTABLE_HASH,
        semanticRevision: PORTABLE_HASH,
        model: emptyLedgerModel('2026-07-21T00:00:00.000Z'),
        canonical: true,
        migration: null,
      }),
      ledgerPath: '/fixture/project/placements.json',
    }),
  });
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'sync',
    skill: 'alpha',
    source: portableSource,
    scope: 'project',
    target: 'fixture:alpha',
  });
  const operationId = 'operation:alpha';
  const liveResource = Object.freeze({
    kind: 'live' as const,
    skill: 'alpha',
    tool: 'codex' as const,
    scope: 'project' as const,
    projectRoot: Object.freeze({ kind: 'machine-bound' as const, path: '/fixture/project' }),
    location: Object.freeze({
      kind: 'machine-bound' as const,
      path: '/fixture/project/.agents/skills/alpha',
    }),
  });
  const liveOperation: ExecutableOperation = Object.freeze({
    operationId,
    groupId,
    pairId: 'pair:alpha:codex',
    kind: 'install' as const,
    dependencyMetadata: Object.freeze({
      domain: 'skillsmith.operation-dependency' as const,
      schemaVersion: 1 as const,
      operationIds: Object.freeze([]),
    }),
    skill: 'alpha',
    source: portableSource,
    tool: 'codex' as const,
    scope: 'project' as const,
    before: Object.freeze({ kind: 'absent' as const, resource: liveResource }),
    after: Object.freeze({
      kind: 'placement' as const,
      resource: liveResource,
      classification: 'pinned' as const,
      representation: 'copy' as const,
      linkTarget: null,
      dangling: false,
      source: portableSource,
      contentHash: HASH('d'),
    }),
    reason: Object.freeze({ code: 'sync-install-selected', message: 'Install alpha.' }),
    selectionSource: 'bounded-default' as const,
    preconditionIds: Object.freeze([]),
    requiredCheckIds: Object.freeze([]),
    reversibility: Object.freeze({ kind: 'none' as const, retentionResourceIds: [] as const }),
    mutates: Object.freeze({ live: true, manifest: false, lock: false, ledger: true }),
    conflict: null,
  });
  const livePlan: OperationPlan<'sync'> = Object.freeze({
    domain: 'skillsmith.operation-plan' as const,
    schemaVersion: 1 as const,
    command: 'sync' as const,
    selection: Object.freeze({
      source: 'bounded-default' as const,
      outcome: 'selected' as const,
      targets: Object.freeze([]),
      skills: Object.freeze(['alpha'] as const),
      tools: Object.freeze(['codex'] as const),
      scopes: Object.freeze(['project' as const]),
      groupIds: Object.freeze([groupId]),
    }),
    batchPolicy: 'fail-fast' as const,
    operations: Object.freeze([liveOperation]),
    checks: Object.freeze([]),
    diagnostics: Object.freeze([]),
  });
  const pair: ResolvedArtifactPair = Object.freeze({
    file: Object.freeze({
      token: './skillsmith.toml',
      path: '/fixture/project/skillsmith.toml',
      portability: 'portable' as const,
      portableToken: './skillsmith.toml',
    }),
    lockfile: Object.freeze({
      token: null,
      path: '/fixture/project/skillsmith.lock',
      portability: 'portable' as const,
      portableToken: './skillsmith.lock',
    }),
    lockfileSource: 'sibling' as const,
  });
  const ports: ArtifactReadPorts = Object.freeze({
    pathKind: async () => 'absent' as const,
    readBytes: async () => {
      throw new Error('absent artifact bytes must not be read');
    },
  });
  return Object.freeze({ fleet, selection, livePlan, pair, ports });
};

describe('sync artifact after-image chain', () => {
  test('prepares the real save artifact bodies and exact manifest-lock-placement chain', async () => {
    const fixture = portableSaveFixture();
    expect(fixture.selection.options.save).toBeTrue();
    const prepared = await prepareSyncArtifactsV1({
      ports: fixture.ports,
      homeDir: '/fixture/home',
      fleet: fixture.fleet,
      selection: fixture.selection,
      livePlan: fixture.livePlan,
      pair: fixture.pair,
    });
    expect(prepared.ok).toBeTrue();
    if (!prepared.ok) throw new Error(`sync artifact preparation failed: ${prepared.error.code}`);

    const manifestWrite = prepared.value.operations[0];
    const lockWrite = prepared.value.operations[1];
    if (manifestWrite === undefined || lockWrite === undefined) {
      throw new Error('sync artifact preparation did not produce the exact artifact pair');
    }
    expect(prepared.value.operations.map(({ operation }) => operation.kind)).toEqual([
      'write-manifest',
      'write-lock',
    ]);
    const groupId = fixture.livePlan.selection.groupIds?.[0];
    if (groupId === undefined) throw new Error('sync save fixture has no selected group');
    expect(manifestWrite.operation).toMatchObject({
      groupId,
      pairId: null,
      kind: 'write-manifest',
      before: { kind: 'absent' },
      after: {
        kind: 'manifest',
        location: { kind: 'machine-bound', path: fixture.pair.file.path },
        value: {
          skills: [
            {
              name: 'alpha',
              source: portableCandidate.source,
              ref: 'main',
              tools: ['codex'],
              scope: 'project',
              placement: 'copy',
              path: null,
            },
          ],
        },
      },
    });
    expect(lockWrite.operation).toMatchObject({
      groupId,
      pairId: null,
      kind: 'write-lock',
      before: { kind: 'absent' },
      after: {
        kind: 'lock',
        location: { kind: 'machine-bound', path: fixture.pair.lockfile.path },
        value: {
          skills: [
            {
              name: 'alpha',
              source: portableCandidate.sourceText,
              requestedRef: 'main',
              resolvedSha: PORTABLE_SHA,
              sourcePath: 'skills/alpha',
              contentHash: PORTABLE_HASH,
            },
          ],
        },
      },
    });
    expect(manifestWrite.operation.dependencyMetadata.operationIds).toEqual([]);
    expect(lockWrite.operation.dependencyMetadata.operationIds).toEqual([
      manifestWrite.operation.operationId,
    ]);
    expect(prepared.value.prefixOperationIdsByPair['binding:alpha:codex']).toEqual([
      lockWrite.operation.operationId,
    ]);
    expect(prepared.value.preconditions).toHaveLength(2);
    const manifestPrecondition = prepared.value.preconditions[0];
    const lockPrecondition = prepared.value.preconditions[1];
    if (manifestPrecondition === undefined || lockPrecondition === undefined) {
      throw new Error('sync artifact preparation omitted exact artifact preconditions');
    }
    expect(manifestPrecondition.operationIds).toEqual([manifestWrite.operation.operationId]);
    expect(lockPrecondition.operationIds).toEqual([lockWrite.operation.operationId]);
    expect(manifestWrite.operation.preconditionIds).toEqual([manifestPrecondition.preconditionId]);
    expect(lockWrite.operation.preconditionIds).toEqual([lockPrecondition.preconditionId]);
  });

  test('binds each later colliding group to the latest exact write-lock prefix', () => {
    const first = group(
      'group:first',
      manifest(HASH('a')),
      manifest(HASH('b')),
      lock(HASH('a')),
      lock(HASH('b')),
    );
    const second = group(
      'group:second',
      first.manifestOperation.after,
      manifest(HASH('c')),
      first.lockOperation.after,
      lock(HASH('c')),
    );
    const input = structuredClone([first, second]);
    const result = chainSyncArtifactAfterImagesV1(input);

    expect(input).toEqual([first, second]);
    expect(result[1]?.manifestOperation.dependencyMetadata.operationIds).toContain(
      first.lockOperation.operationId,
    );
    expect(result[1]?.lockOperation.dependencyMetadata.operationIds).toContain(
      first.lockOperation.operationId,
    );
    expect(result[1]?.placementOperations[0]?.dependencyMetadata.operationIds).toContain(
      first.lockOperation.operationId,
    );
    expect(Object.isFrozen(result)).toBeTrue();
  });

  test('refuses branch-dependent or stale artifact before-images', () => {
    const first = group(
      'group:first',
      manifest(HASH('a')),
      manifest(HASH('b')),
      lock(HASH('a')),
      lock(HASH('b')),
    );
    const stale = group(
      'group:stale',
      manifest(HASH('a')),
      manifest(HASH('c')),
      lock(HASH('a')),
      lock(HASH('c')),
    );
    expect(() => chainSyncArtifactAfterImagesV1([first, stale])).toThrow(
      'does not consume the latest exact after-image',
    );
  });
});
