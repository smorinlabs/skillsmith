import { describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import type { LedgerModel } from '../../src/artifacts/ledger-types.ts';
import type { PlacementSnapshotAuthority } from '../../src/place/execute.ts';
import { createPlacementPlan } from '../../src/place/plan.ts';
import {
  type ExpectedRevisionV1,
  type LivePlacementStateV1,
  type ObservedStateSnapshotV1,
  type StoreStateV1,
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionV1,
  createStoreSnapshotIdentityV1,
} from '../../src/state/types.ts';
import {
  createSyncPlan,
  projectSyncFleetPlanV1,
  selectSyncFleetResourcesV1,
  syncFleetStorePairKeyV1,
} from '../../src/sync/plan.ts';
import type { SyncFleetObservation, SyncMemberObservation } from '../../src/sync/types.ts';

const HEX = {
  a: 'a'.repeat(64),
  b: 'b'.repeat(64),
  c: 'c'.repeat(64),
  d: 'd'.repeat(64),
} as const;
const HASH = `sha256:${HEX.a}` as const;
const OLD_HASH = `sha256:${HEX.b}` as const;

const revision = (input: unknown): ExpectedRevisionV1 => {
  const result = createExpectedRevisionV1(input);
  if (!result.ok) throw new Error('invalid revision fixture');
  return result.value;
};

const absent = (
  domain: 'manifest' | 'lock' | 'ledger' | 'live' | 'store',
  resourceId: string,
  targetIdentity: string,
) =>
  revision({
    schemaVersion: 1,
    domain,
    resourceId,
    state: 'absent',
    targetIdentity,
    targetKind: 'absent',
    parentIdentity: dirname(targetIdentity),
    parentKind: 'directory',
    parentMetadataIdentity: `metadata:v1:${HEX.a}`,
  });

const semantic = (domain: 'project' | 'capabilities', resourceId: string) =>
  revision({
    schemaVersion: 1,
    domain,
    resourceId,
    state: 'present',
    targetKind: 'semantic',
    semanticRevision: `sha256:${HEX.c}`,
  });

const storeValue: StoreStateV1 = {
  path: '/fixture/store/alpha',
  repositoryRevision: `sha256:${HEX.d}`,
  contentRevision: HASH,
  snapshotIdentity: createStoreSnapshotIdentityV1('store:alpha', HASH),
};
const storeRevision = revision({
  schemaVersion: 1,
  domain: 'store',
  resourceId: 'store:alpha',
  state: 'present',
  targetIdentity: storeValue.path,
  targetKind: 'directory',
  targetMetadataIdentity: `metadata:v1:${HEX.a}`,
  parentIdentity: dirname(storeValue.path),
  parentKind: 'directory',
  parentMetadataIdentity: `metadata:v1:${HEX.b}`,
  resourceRevision: storeValue.repositoryRevision,
  contentRevision: storeValue.contentRevision,
  snapshotIdentity: storeValue.snapshotIdentity,
});

const liveRevision = (value: LivePlacementStateV1) =>
  revision({
    schemaVersion: 1,
    domain: 'live',
    resourceId: 'live:alpha',
    state: 'present',
    targetIdentity: value.path,
    targetKind: value.representation,
    targetMetadataIdentity: `metadata:v1:${HEX.a}`,
    parentIdentity: dirname(value.path),
    parentKind: 'directory',
    parentMetadataIdentity: `metadata:v1:${HEX.b}`,
    resourceRevision: `sha256:${HEX.c}`,
    contentRevision: value.contentRevision,
  });

const ledgerRevision = revision({
  schemaVersion: 1,
  domain: 'ledger',
  resourceId: 'ledger:user',
  state: 'present',
  targetIdentity: '/fixture/ledger.json',
  targetKind: 'file',
  targetMetadataIdentity: `metadata:v1:${HEX.a}`,
  parentIdentity: '/fixture',
  parentKind: 'directory',
  parentMetadataIdentity: `metadata:v1:${HEX.b}`,
  byteRevision: `sha256:${HEX.c}`,
  semanticRevision: `sha256:${HEX.d}`,
});

const emptyLedger = (): LedgerModel => ({
  updatedAt: '2026-07-21T00:00:00.000Z',
  skills: {},
  projects: {},
  projectRegistrations: {},
  transactions: {},
  history: [],
});

const snapshot = (
  live: LivePlacementStateV1 | null = null,
  ledger: LedgerModel | null = null,
): ObservedStateSnapshotV1 =>
  ({
    schemaVersion: 1,
    snapshotId: `snapshot:v1:${HEX.a}`,
    project: { revision: semantic('project', 'project:fixture'), value: {} },
    manifest: {
      revision: absent('manifest', 'manifest:fixture', '/fixture/skillsmith.toml'),
      value: null,
    },
    lock: {
      revision: absent('lock', 'lock:fixture', '/fixture/skillsmith.lock'),
      value: null,
    },
    ledger: {
      revision:
        ledger === null ? absent('ledger', 'ledger:user', '/fixture/ledger.json') : ledgerRevision,
      value: ledger,
    },
    live: [
      {
        revision:
          live === null ? absent('live', 'live:alpha', '/fixture/live/alpha') : liveRevision(live),
        value: live,
      },
    ],
    store: [{ revision: storeRevision, value: storeValue }],
    capabilities: { revision: semantic('capabilities', 'capabilities:fixture'), value: {} },
  }) as unknown as ObservedStateSnapshotV1;

const source = { kind: 'local-dev' as const, path: '/fixture/source/alpha', contentHash: HASH };
const sourceContent = createContentObservationIdentityV1({
  schemaVersion: 1,
  resourceId: 'source:alpha',
  targetIdentity: source.path,
  targetKind: 'directory',
  contentRevision: HASH,
});
const sourceMembership = createContentObservationIdentityV1({
  schemaVersion: 1,
  resourceId: 'sync-membership:source:fixture',
  targetIdentity: '/fixture/source',
  targetKind: 'directory',
  contentRevision: HASH,
});
const destinationMembership = createContentObservationIdentityV1({
  schemaVersion: 1,
  resourceId: 'sync-membership:destination:fixture',
  targetIdentity: '/fixture/destination',
  targetKind: 'directory',
  contentRevision: OLD_HASH,
});
const request = () => ({
  schemaVersion: 1 as const,
  selection: {
    source: 'bounded-default' as const,
    outcome: 'selected' as const,
    skills: ['alpha'],
    tools: ['codex'] as const,
    scopes: ['user'] as const,
  },
  batchPolicy: 'fail-fast' as const,
  force: false,
  intents: [
    {
      kind: 'sync' as const,
      action: 'converge' as const,
      skill: 'alpha',
      tool: 'codex' as const,
      scope: 'user' as const,
      projectRoot: null,
      liveResourceId: 'live:alpha',
      storeResourceId: 'store:alpha',
      source,
      sourceContent,
      representation: 'copy' as const,
      desiredContentHash: HASH,
      endpointIdentity: 'user:destination',
      groupSource: null,
      groupIdentityTarget: 'user:destination:alpha:source-membership',
      membershipContent: [sourceMembership, destinationMembership] as const,
    },
  ],
});

describe('sync placement planning projection', () => {
  test('is operation-identical to the shared planner and emits a truthful local install', () => {
    const observed = snapshot();
    const sync = createSyncPlan(request(), observed);
    const shared = createPlacementPlan({ ...request(), command: 'sync' }, observed);
    if (!sync.ok || !shared.ok) throw new Error('expected equivalent sync plans');
    expect(JSON.stringify(sync.value.plan)).toBe(JSON.stringify(shared.value.plan));
    expect(sync.value.plan).toMatchObject({
      command: 'sync',
      selection: { source: 'bounded-default', groupIds: [expect.any(String)] },
      operations: [
        {
          kind: 'install',
          source: { kind: 'local-dev', contentHash: HASH },
          before: { kind: 'absent' },
          after: {
            kind: 'placement',
            classification: 'pinned',
            representation: 'copy',
            linkTarget: null,
            contentHash: HASH,
          },
        },
      ],
    });
  });

  test('bounds conflict and force metadata to the selected differing destination', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'directory',
      path: '/fixture/live/alpha',
      realpath: '/fixture/live/alpha',
      linkTarget: null,
      dangling: false,
      placementClass: 'pinned',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: OLD_HASH,
    };
    const result = createSyncPlan(request(), snapshot(live));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations[0]).toMatchObject({
      kind: 'update',
      before: { kind: 'placement', classification: 'unmanaged', contentHash: OLD_HASH },
      conflict: {
        class: 'unmanaged-target',
        normal: 'refuse',
        forced: 'backup-and-replace',
        backup: 'required',
        target: { kind: 'live', skill: 'alpha', tool: 'codex' },
      },
    });
    expect(result.value.plan.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'refuse',
        severity: 'error',
        refusalClass: 'usage',
        reason: expect.objectContaining({ code: 'sync-force-required' }),
      }),
    );

    const forced = createSyncPlan({ ...request(), force: true }, snapshot(live));
    if (!forced.ok) throw new Error(forced.error.message);
    expect(forced.value.plan.operations[0]?.conflict).not.toBeNull();
    expect(
      forced.value.plan.diagnostics.some(({ reason }) => reason.code === 'sync-force-required'),
    ).toBeFalse();

    const unused = createSyncPlan({ ...request(), force: true }, snapshot());
    if (!unused.ok) throw new Error(unused.error.message);
    expect(unused.value.plan.operations[0]?.conflict).toBeNull();
    expect(
      unused.value.plan.diagnostics.some(({ reason }) => reason.code === 'sync-force-required'),
    ).toBeFalse();
  });

  test('projects exact local pinned state to a noop without an executable operation', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'directory',
      path: '/fixture/live/alpha',
      realpath: '/fixture/live/alpha',
      linkTarget: null,
      dangling: false,
      placementClass: 'pinned',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: HASH,
    };
    const ledger: LedgerModel = {
      ...emptyLedger(),
      skills: {
        alpha: {
          tools: {
            codex: {
              placementPath: live.path,
              mode: 'pinned',
              dev: null,
              pinned: {
                storePath: storeValue.path,
                rev: 'local-alpha',
                gitSha: null,
                dirty: false,
                contentHash: HASH,
                snapshotAt: '2026-07-21T00:00:00.000Z',
                verify: 'passed',
                placement: 'copy',
              },
              journal: null,
            },
          },
        },
      },
    };
    const result = createSyncPlan(request(), snapshot(live, ledger));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toEqual([]);
    expect(result.value.plan.diagnostics).toMatchObject([
      { kind: 'noop', reason: { code: 'sync-destination-current' } },
    ]);
    expect(result.value.plan.selection.groupIds).toHaveLength(1);
  });

  test('requires an explicit remove intent without widening the selected destination', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'directory',
      path: '/fixture/live/alpha',
      realpath: '/fixture/live/alpha',
      linkTarget: null,
      dangling: false,
      placementClass: 'pinned',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: OLD_HASH,
    };
    const base = request();
    const convergeIntent = base.intents[0];
    if (convergeIntent === undefined) throw new Error('missing convergence intent');
    const { sourceContent: _sourceContent, ...removeIntent } = convergeIntent;
    const result = createSyncPlan(
      {
        ...base,
        intents: [
          {
            ...removeIntent,
            action: 'remove',
            source: null,
            storeResourceId: null,
            desiredContentHash: null,
          },
        ],
      },
      snapshot(live),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations[0]).toMatchObject({
      kind: 'remove',
      dependencyMetadata: { operationIds: [] },
      after: { kind: 'absent' },
      conflict: { class: 'unmanaged-target' },
    });
  });
});

const projectContext = {
  invocationCwd: '/fixture',
  effectiveCwd: '/fixture',
  projectRoot: '/fixture',
  projectIdentity: '/fixture',
  projectKind: 'non-git' as const,
  discoveredConfigPath: null,
  explicitConfigPath: null,
};

const fleetMember = (
  tool: 'claude-code' | 'codex',
  overrides: Partial<SyncMemberObservation> = {},
): SyncMemberObservation => ({
  entry: {
    name: 'alpha',
    path: `/source/${tool}/alpha`,
    realpath: `/source/${tool}/alpha`,
    tool,
    scope: 'project',
    root: `/source/${tool}`,
    frontmatter: null,
    origin: { kind: 'standalone' },
    enabled: 'on',
    mode: 'pinned',
    placement: 'copy',
    source: null,
    revision: null,
    store: null,
    verification: 'passed',
    description: null,
    visibility: { state: 'unique', winner: null, members: [] },
  },
  ledgerPair: null,
  liveContentHash: HASH as never,
  pendingJournal: false,
  pendingTransactionIds: [],
  defaultLocation: true,
  portable: { outcome: 'not-requested' },
  ...overrides,
});

const fleetFor = (
  sourceEntries: readonly SyncMemberObservation[],
  portableProof: 'none' | 'exact' = 'none',
  destinationEntries: readonly SyncMemberObservation[] = [],
): SyncFleetObservation =>
  ({
    endpoints: {
      tools: ['claude-code', 'codex'],
      from: {
        role: 'source',
        selectedInput: 'project',
        kind: 'project',
        scope: 'project',
        canonicalBase: '/source',
        project: projectContext,
        roots: [
          {
            tool: 'claude-code',
            scope: 'project',
            path: '/source/claude-code',
            canonicalPath: '/source/claude-code',
            state: 'directory',
          },
          {
            tool: 'codex',
            scope: 'project',
            path: '/source/codex',
            canonicalPath: '/source/codex',
            state: 'directory',
          },
        ],
        identity: `sync-endpoint:v1:${HEX.a}`,
      },
      to: {
        role: 'destination',
        selectedInput: '/destination',
        kind: 'path',
        scope: 'project',
        canonicalBase: '/destination',
        project: { ...projectContext, effectiveCwd: '/destination', projectRoot: '/destination' },
        roots: [
          {
            tool: 'claude-code',
            scope: 'project',
            path: '/destination/claude-code',
            canonicalPath: '/destination/claude-code',
            state: 'directory',
          },
          {
            tool: 'codex',
            scope: 'project',
            path: '/destination/codex',
            canonicalPath: '/destination/codex',
            state: 'directory',
          },
        ],
        identity: `sync-endpoint:v1:${HEX.b}`,
      },
    },
    portableProof,
    source: {
      endpoint: {} as never,
      inventory: { selection: {}, entries: [], collisionGroups: [] },
      entries: sourceEntries,
      membershipHash: HASH as never,
      ledger: { state: 'absent', artifact: 'ledger', migration: null },
      ledgerPath: '/fixture/ledger.json',
    },
    destination: {
      endpoint: {} as never,
      inventory: { selection: {}, entries: [], collisionGroups: [] },
      entries: destinationEntries,
      membershipHash: OLD_HASH as never,
      ledger: { state: 'absent', artifact: 'ledger', migration: null },
      ledgerPath: '/fixture/ledger.json',
    },
  }) as unknown as SyncFleetObservation;

describe('sync fleet-to-intent projection', () => {
  test('uses exact pair-to-store bindings and one aggregate group identity across tool members', () => {
    const claude = fleetMember('claude-code');
    const codex = fleetMember('codex');
    const fleet = fleetFor([claude, codex]);
    const authority = {
      snapshot: snapshot(),
      liveResources: [
        {
          resourceId: 'live:claude-alpha',
          skill: 'alpha',
          tool: 'claude-code',
          scope: 'project',
          projectIdentity: '/destination',
          placementPath: '/destination/claude-code/alpha',
          storeRoot: '/store',
        },
        {
          resourceId: 'live:codex-alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'project',
          projectIdentity: '/destination',
          placementPath: '/destination/codex/alpha',
          storeRoot: '/store',
        },
      ],
      storeResources: [
        { resourceId: 'store:claude-alpha', storePath: '/store/claude-alpha', contentHash: HASH },
        { resourceId: 'store:codex-alpha', storePath: '/store/codex-alpha', contentHash: HASH },
      ],
    } as unknown as PlacementSnapshotAuthority;
    const selected = selectSyncFleetResourcesV1(fleet, {
      targets: [],
      delete: false,
      continueOnError: false,
      save: false,
      force: false,
    });
    if (!selected.ok) throw new Error(selected.error.message);
    expect(selected.value.pairs.map(({ pair }) => pair.placement.path)).toEqual([
      '/destination/claude-code/alpha',
      '/destination/codex/alpha',
    ]);
    expect(selected.value.stores.map(({ bindingKey }) => bindingKey)).toEqual([
      syncFleetStorePairKeyV1(claude),
      syncFleetStorePairKeyV1(codex),
    ]);
    expect(Object.isFrozen(selected.value)).toBeTrue();
    const projected = projectSyncFleetPlanV1(selected.value, authority, {
      storeResourceIdsByPair: {
        [syncFleetStorePairKeyV1(claude)]: 'store:claude-alpha',
        [syncFleetStorePairKeyV1(codex)]: 'store:codex-alpha',
      },
    });
    if (!projected.ok) throw new Error(projected.error.message);
    expect(projected.value.pairs.map(({ storeResourceId }) => storeResourceId)).toEqual([
      'store:claude-alpha',
      'store:codex-alpha',
    ]);
    expect(
      new Set(projected.value.request.intents.map(({ groupIdentityTarget }) => groupIdentityTarget))
        .size,
    ).toBe(1);
    expect(
      projected.value.request.intents.every(({ groupSource }) => groupSource === null),
    ).toBeTrue();
    expect(projected.value.sourceMembershipHash).toBe(fleet.source.membershipHash);
    expect(projected.value.destinationMembershipHash).toBe(fleet.destination.membershipHash);
    const planningSnapshot = {
      ...snapshot(),
      live: [
        {
          revision: absent('live', 'live:claude-alpha', '/destination/claude-code/alpha'),
          value: null,
        },
        {
          revision: absent('live', 'live:codex-alpha', '/destination/codex/alpha'),
          value: null,
        },
      ],
      store: [
        {
          revision: absent('store', 'store:claude-alpha', '/store/claude-alpha'),
          value: null,
        },
        {
          revision: absent('store', 'store:codex-alpha', '/store/codex-alpha'),
          value: null,
        },
      ],
    } as ObservedStateSnapshotV1;
    const plan = createSyncPlan(projected.value.request, planningSnapshot);
    if (!plan.ok) throw new Error(plan.error.message);
    expect(new Set(plan.value.plan.operations.map(({ groupId }) => groupId)).size).toBe(1);
    const membershipPreconditionIds = projected.value.request.intents[0]?.membershipContent.map(
      (identity) => createContentObservationPreconditionIdV1(identity),
    );
    expect(membershipPreconditionIds).toHaveLength(2);
    expect(
      plan.value.plan.operations.every(({ preconditionIds }) =>
        membershipPreconditionIds?.every((preconditionId) =>
          preconditionIds.includes(preconditionId),
        ),
      ),
    ).toBeTrue();
  });

  test('selects targetless deletion once with the exact destination path and scope key', () => {
    const destination = fleetMember('codex', {
      entry: {
        ...fleetMember('codex').entry,
        path: '/destination/codex/extra',
        realpath: '/destination/codex/extra',
        root: '/destination/codex',
        name: 'extra',
      },
    });
    const selected = selectSyncFleetResourcesV1(fleetFor([], 'none', [destination]), {
      targets: [],
      delete: true,
      continueOnError: false,
      save: false,
      force: false,
    });
    if (!selected.ok) throw new Error(selected.error.message);
    expect(selected.value.pairs).toMatchObject([
      {
        action: 'remove',
        pair: {
          skill: 'extra',
          tool: 'codex',
          scope: 'project',
          scopeKey: '/destination',
          placement: {
            root: '/destination/codex',
            path: '/destination/codex/extra',
          },
        },
        store: null,
      },
    ]);
    expect(selected.value.stores).toEqual([]);
  });

  test('rejects pending/ambiguous source state and mixed portable group declarations', () => {
    const pending = fleetMember('claude-code', { pendingJournal: true });
    expect(
      selectSyncFleetResourcesV1(fleetFor([pending]), {
        targets: [],
        delete: false,
        continueOnError: false,
        save: false,
        force: false,
      }),
    ).toMatchObject({ ok: false, error: { code: 'sync-source-pending-journal' } });

    const ambiguous = fleetMember('claude-code', {
      entry: {
        ...fleetMember('claude-code').entry,
        visibility: { state: 'winner', winner: '/source/claude-code/alpha', members: [] },
      },
    });
    expect(
      selectSyncFleetResourcesV1(fleetFor([ambiguous]), {
        targets: [],
        delete: false,
        continueOnError: false,
        save: false,
        force: false,
      }),
    ).toMatchObject({ ok: false, error: { code: 'sync-source-ambiguous' } });

    const portable = (tool: 'claude-code' | 'codex', sha: string) =>
      fleetMember(tool, {
        portable: {
          outcome: 'portable',
          candidate: {
            name: 'alpha',
            tools: [tool],
            scope: 'project',
            source: { host: 'fixture.invalid', repository: 'acme/skills', path: 'skills/alpha' },
            sourceText: 'fixture.invalid/acme/skills//skills/alpha',
            requestedRef: 'main',
            resolvedSha: sha,
            sourcePath: 'skills/alpha',
            contentHash: HASH as never,
            placement: 'copy',
            path: null,
            classification: 'portable-managed',
          },
        },
      });
    expect(
      selectSyncFleetResourcesV1(
        fleetFor(
          [portable('claude-code', 'a'.repeat(40)), portable('codex', 'b'.repeat(40))],
          'exact',
        ),
        {
          targets: [],
          delete: false,
          continueOnError: false,
          save: true,
          force: false,
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'sync-source-portable-group-conflict' } });
  });
});
