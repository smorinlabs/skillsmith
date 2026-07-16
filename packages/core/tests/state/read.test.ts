import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { toolRegistry } from '../../src/agents/registry.ts';
import { ledgerSemanticRevision } from '../../src/artifacts/ledger-codec.ts';
import { toCapabilitySnapshotV1Dto } from '../../src/contracts/v1/capability-snapshot.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { Result } from '../../src/result.ts';
import { readObservedStateSnapshotV1 } from '../../src/state/read.ts';
import {
  type LogicalRepositoryEditRequestV1,
  type ObservedStateRepositoriesV1,
  type StateRepositoryError,
  createCapabilityStateReaderV1,
  createProjectStateReaderV1,
  stageLogicalRepositoryEditV1,
} from '../../src/state/repositories.ts';
import {
  type ExpectedRevisionV1,
  type ObservedComponentV1,
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionV1,
  createFilesystemMetadataIdentityV1,
  createStoreSnapshotIdentityV1,
  isExpectedRevisionV1,
  sameExpectedRevisionV1,
  semanticValueRevisionV1,
} from '../../src/state/types.ts';

const HEX = {
  a: 'a'.repeat(64),
  b: 'b'.repeat(64),
  c: 'c'.repeat(64),
  d: 'd'.repeat(64),
} as const;

const unwrap = <T, E>(result: Result<T, E>): T => {
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error('expected a successful result');
  return result.value;
};

test('filesystem metadata identity preserves target hard-link and parent topology semantics', () => {
  const path = '/fixture/state/entry';
  const metadata = {
    kind: 'dir' as const,
    mode: 0o755,
    identity: 'filesystem:1',
    linkCount: 2,
  };
  const target = createFilesystemMetadataIdentityV1(path, metadata, 'target');
  const parent = createFilesystemMetadataIdentityV1(path, metadata, 'parent');
  const linkCountChanged = { ...metadata, linkCount: 3 };

  expect(target).toMatch(/^metadata:v1:[0-9a-f]{64}$/u);
  expect(createFilesystemMetadataIdentityV1(path, linkCountChanged, 'target')).not.toBe(target);
  expect(createFilesystemMetadataIdentityV1(path, linkCountChanged, 'parent')).toBe(parent);
  expect(createFilesystemMetadataIdentityV1(path, { ...metadata, mode: 0o750 }, 'parent')).not.toBe(
    parent,
  );
  expect(
    createFilesystemMetadataIdentityV1(path, { ...metadata, identity: 'filesystem:2' }, 'parent'),
  ).not.toBe(parent);
});

const absent = (
  domain: 'manifest' | 'lock' | 'ledger' | 'live' | 'store',
  resourceId: string,
  targetIdentity: string,
  parentIdentity: string,
  metadataHex = HEX.a,
): ExpectedRevisionV1 =>
  unwrap(
    createExpectedRevisionV1({
      schemaVersion: 1,
      domain,
      resourceId,
      state: 'absent',
      targetIdentity,
      targetKind: 'absent',
      parentIdentity,
      parentKind: 'directory',
      parentMetadataIdentity: `metadata:v1:${metadataHex}`,
    }),
  );

const semantic = (
  domain: 'project' | 'capabilities',
  resourceId: string,
  value: unknown,
): ExpectedRevisionV1 =>
  unwrap(
    createExpectedRevisionV1({
      schemaVersion: 1,
      domain,
      resourceId,
      state: 'present',
      targetKind: 'semantic',
      semanticRevision: semanticValueRevisionV1(domain, value),
    }),
  );

const component = <T>(revision: ExpectedRevisionV1, value: T | null): ObservedComponentV1<T> =>
  Object.freeze({ revision, value });

const semanticComponent = <T>(
  domain: 'project' | 'capabilities',
  resourceId: string,
  value: T,
): ObservedComponentV1<T> => component(semantic(domain, resourceId, value), value);

describe('state revisions and snapshot reads', () => {
  test('constructs stable revisions and protects absence with target and parent identity', () => {
    const input = {
      schemaVersion: 1,
      domain: 'manifest',
      resourceId: 'manifest:/fixture/skillsmith.toml',
      state: 'present',
      targetIdentity: '/fixture/skillsmith.toml',
      targetKind: 'file',
      targetMetadataIdentity: `metadata:v1:${HEX.a}`,
      parentIdentity: '/fixture',
      parentKind: 'directory',
      parentMetadataIdentity: `metadata:v1:${HEX.b}`,
      byteRevision: `sha256:${HEX.c}`,
      semanticRevision: `sha256:${HEX.d}`,
    } as const;
    const first = unwrap(createExpectedRevisionV1(input));
    const second = unwrap(createExpectedRevisionV1(input));
    expect(first).toEqual(second);
    expect(sameExpectedRevisionV1(first, second)).toBeTrue();
    expect(Object.isFrozen(first)).toBeTrue();

    const before = absent('live', 'live:user:codex:alpha', '/fixture/live/alpha', '/fixture/live');
    const changedTarget = absent(
      'live',
      'live:user:codex:alpha',
      '/fixture/live/beta',
      '/fixture/live',
    );
    const changedParent = absent(
      'live',
      'live:user:codex:alpha',
      '/fixture/live/alpha',
      '/fixture/live',
      HEX.b,
    );
    expect(sameExpectedRevisionV1(before, changedTarget)).toBeFalse();
    expect(sameExpectedRevisionV1(before, changedParent)).toBeFalse();

    const forgedTarget = { ...first, targetIdentity: '/fixture/forged.toml' };
    const forgedDigest = { ...first, revisionDigest: `revision:v1:${HEX.a}` };
    expect(isExpectedRevisionV1(forgedTarget)).toBeFalse();
    expect(isExpectedRevisionV1(forgedDigest)).toBeFalse();
    expect(sameExpectedRevisionV1(forgedTarget, { ...forgedTarget })).toBeFalse();

    expect(
      createExpectedRevisionV1({
        ...input,
        targetMetadataIdentity: 'not-metadata',
      }),
    ).toEqual({ ok: false, error: { code: 'state-type', reason: 'invalid-revision' } });

    const storeResourceId = 'store:alpha';
    const contentRevision = `sha256:${HEX.c}`;
    const storeInput = {
      schemaVersion: 1,
      domain: 'store',
      resourceId: storeResourceId,
      state: 'present',
      targetIdentity: '/fixture/store/alpha',
      targetKind: 'directory',
      targetMetadataIdentity: `metadata:v1:${HEX.a}`,
      parentIdentity: '/fixture/store',
      parentKind: 'directory',
      parentMetadataIdentity: `metadata:v1:${HEX.b}`,
      resourceRevision: `sha256:${HEX.d}`,
      contentRevision,
      snapshotIdentity: createStoreSnapshotIdentityV1(storeResourceId, contentRevision),
    } as const;
    expect(createExpectedRevisionV1(storeInput).ok).toBeTrue();
    expect(
      createExpectedRevisionV1({
        ...storeInput,
        snapshotIdentity: `store:v1:${HEX.d}`,
      }),
    ).toEqual({ ok: false, error: { code: 'state-type', reason: 'invalid-revision' } });
  });

  test('creates deterministic logical stages and refuses stale observation', () => {
    const expected = absent(
      'ledger',
      'ledger:user',
      '/fixture/data/placements.json',
      '/fixture/data',
    );
    const request: LogicalRepositoryEditRequestV1 = {
      schemaVersion: 1,
      operationId: `operation:v1:${HEX.a}`,
      domain: 'ledger',
      resourceId: 'ledger:user',
      expectedRevision: expected,
      observedRevision: expected,
      editDigest: `sha256:${HEX.b}`,
    };
    const first = unwrap(stageLogicalRepositoryEditV1(request));
    const second = unwrap(stageLogicalRepositoryEditV1(request));
    expect(first).toEqual(second);
    expect(first.stageId).toMatch(/^stage:v1:[0-9a-f]{64}$/u);
    expect(first.beforeRevision).toEqual(expected);
    expect(first.editDigest).toBe(`sha256:${HEX.b}`);
    expect('afterRevision' in first).toBeFalse();
    expect('changed' in first).toBeFalse();
    expect(Object.isFrozen(first)).toBeTrue();

    const stale = stageLogicalRepositoryEditV1({
      ...request,
      observedRevision: absent(
        'ledger',
        'ledger:user',
        '/fixture/data/placements.json',
        '/fixture/data',
        HEX.b,
      ),
    });
    expect(stale).toEqual({
      ok: false,
      error: { code: 'stale-revision', domain: 'ledger', resourceId: 'ledger:user' },
    });
  });

  test('normalizes closed content identities and derives operation-independent IDs', () => {
    const first = createContentObservationIdentityV1({
      schemaVersion: 1,
      resourceId: 'source:alpha',
      targetIdentity: '/fixture/source/../source/alpha',
      targetKind: 'dir',
      contentRevision: `sha256:${HEX.a}`,
    });
    const equivalent = createContentObservationIdentityV1({
      schemaVersion: 1,
      resourceId: 'source:alpha',
      targetIdentity: '/fixture/source/alpha',
      targetKind: 'directory',
      contentRevision: `sha256:${HEX.a}`,
    });
    expect(first).toEqual(equivalent);
    expect(first.targetIdentity).toBe(normalize('/fixture/source/alpha'));
    expect(first.targetKind).toBe('directory');
    expect(Object.isFrozen(first)).toBeTrue();
    expect(createContentObservationPreconditionIdV1(first)).toBe(
      createContentObservationPreconditionIdV1(equivalent),
    );
    expect(createContentObservationPreconditionIdV1(first)).toMatch(
      /^precondition:v1:[0-9a-f]{64}$/u,
    );
    expect(
      createContentObservationPreconditionIdV1(
        createContentObservationIdentityV1({
          ...first,
          targetIdentity: '/another/materialization/alpha',
        }),
      ),
    ).toBe(createContentObservationPreconditionIdV1(first));
    expect(
      createContentObservationPreconditionIdV1(
        createContentObservationIdentityV1({
          ...first,
          contentRevision: `sha256:${HEX.b}`,
        }),
      ),
    ).not.toBe(createContentObservationPreconditionIdV1(first));

    expect(() =>
      createContentObservationIdentityV1({
        ...first,
        contentRevision: 'not-a-content-revision',
      }),
    ).toThrow(/content observation identity/i);
    expect(() =>
      createContentObservationIdentityV1({
        ...first,
        extra: true,
      }),
    ).toThrow(/content observation identity/i);
    expect(() =>
      createContentObservationIdentityV1({
        ...first,
        targetIdentity: 'relative/source/alpha',
      }),
    ).toThrow(/content observation identity/i);
    expect(() =>
      createContentObservationPreconditionIdV1({
        ...first,
        targetIdentity: '/fixture/source/../source/alpha',
      }),
    ).toThrow(/content observation precondition/i);
  });

  test('re-resolves project context and rehashes current registry facts on every observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-semantic-state-readers-'));
    try {
      const ports = await defaultRuntimePorts();
      const projectResourceId = `project:${root}`;
      const project = createProjectStateReaderV1({
        resourceId: projectResourceId,
        ports,
        context: { invocationCwd: root },
      });
      const capabilitiesResourceId = 'capabilities:built-in-tools';
      const capabilities = createCapabilityStateReaderV1(capabilitiesResourceId);

      const projectBefore = unwrap(await project.observe(projectResourceId));
      expect(projectBefore.value).toMatchObject({
        effectiveCwd: root,
        projectRoot: null,
        projectIdentity: null,
        projectKind: 'non-git',
        discoveredConfigPath: null,
      });
      await writeFile(join(root, 'skillsmith.toml'), 'version = 1\n');
      const projectAfter = unwrap(await project.observe(projectResourceId));
      expect(projectAfter.value).toMatchObject({
        projectRoot: root,
        projectIdentity: root,
        projectKind: 'non-git',
        discoveredConfigPath: join(root, 'skillsmith.toml'),
      });
      expect(projectAfter.revision.revisionDigest).not.toBe(projectBefore.revision.revisionDigest);

      const capabilityBefore = unwrap(await capabilities.observe(capabilitiesResourceId));
      const capabilityAfter = unwrap(await capabilities.observe(capabilitiesResourceId));
      expect(capabilityBefore.value).toEqual(
        toCapabilitySnapshotV1Dto({ adapters: toolRegistry.adapters }),
      );
      expect(capabilityAfter.value).toEqual(capabilityBefore.value);
      expect(capabilityAfter.value).not.toBe(capabilityBefore.value);
      expect(capabilityAfter.revision).toEqual(capabilityBefore.revision);
      expect(Object.isFrozen(capabilityBefore.value)).toBeTrue();
      expect(Object.isFrozen(capabilityBefore.value?.tools)).toBeTrue();
      expect(
        capabilityBefore.value?.tools.every(
          (tool) => Object.isFrozen(tool) && Object.isFrozen(tool.operations),
        ),
      ).toBeTrue();

      expect(await project.observe('project:wrong-resource')).toEqual({
        ok: false,
        error: {
          code: 'state-repository',
          domain: 'project',
          reason: 'invalid-request',
        },
      });
      expect(await capabilities.observe('capabilities:wrong-resource')).toEqual({
        ok: false,
        error: {
          code: 'state-repository',
          domain: 'capabilities',
          reason: 'invalid-request',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reads in canonical two-pass order and refuses a changed second-pass revision without retry', async () => {
    const projectValue = Object.freeze({
      invocationCwd: '/fixture',
      effectiveCwd: '/fixture',
      projectRoot: '/fixture',
      projectIdentity: '/fixture',
      projectKind: 'git' as const,
      discoveredConfigPath: null,
      explicitConfigPath: null,
    });
    const capabilitiesValue = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'skillsmith.capabilities' as const,
      tools: Object.freeze([]),
    });
    const observations = {
      project: semanticComponent('project', 'project:/fixture', projectValue),
      manifest: component(
        absent(
          'manifest',
          'manifest:/fixture/skillsmith.toml',
          '/fixture/skillsmith.toml',
          '/fixture',
        ),
        null,
      ),
      lock: component(
        absent(
          'lock',
          'lock:/fixture/skillsmith.lock',
          '/fixture/skillsmith.lock',
          '/fixture',
          HEX.b,
        ),
        null,
      ),
      ledger: component(
        absent('ledger', 'ledger:user', '/fixture/data/placements.json', '/fixture/data', HEX.c),
        null,
      ),
      live: component(
        absent('live', 'live:user:codex:alpha', '/fixture/live/alpha', '/fixture/live', HEX.d),
        null,
      ),
      store: component(
        absent('store', 'store:alpha', '/fixture/store/alpha', '/fixture/store', HEX.a),
        null,
      ),
      capabilities: semanticComponent('capabilities', 'capabilities:fixture', capabilitiesValue),
    };
    const request = Object.freeze({
      schemaVersion: 1 as const,
      projectResourceId: observations.project.revision.resourceId,
      manifestResourceId: observations.manifest.revision.resourceId,
      lockResourceId: observations.lock.revision.resourceId,
      ledgerResourceId: observations.ledger.revision.resourceId,
      liveResourceIds: Object.freeze([observations.live.revision.resourceId]),
      storeResourceIds: Object.freeze([observations.store.revision.resourceId]),
      capabilitiesResourceId: observations.capabilities.revision.resourceId,
    });
    const expectedOrder = [
      'project:project:/fixture',
      'manifest:manifest:/fixture/skillsmith.toml',
      'lock:lock:/fixture/skillsmith.lock',
      'ledger:ledger:user',
      'live:live:user:codex:alpha',
      'store:store:alpha',
      'capabilities:capabilities:fixture',
    ];
    const okResult = <T>(value: T): Result<T, StateRepositoryError> => ({ ok: true, value });
    const repositories = (calls: string[], changedLedger: boolean): ObservedStateRepositoriesV1 => {
      const repository = (
        domain: keyof typeof observations,
        observation: ObservedComponentV1<unknown>,
      ) => ({
        observe: async (resourceId: string) => {
          calls.push(`observe:${domain}:${resourceId}`);
          return okResult(observation);
        },
        observeRevision: async (resourceId: string) => {
          calls.push(`revision:${domain}:${resourceId}`);
          if (domain === 'ledger' && changedLedger) {
            return okResult(
              absent(
                'ledger',
                'ledger:user',
                '/fixture/data/placements.json',
                '/fixture/data',
                HEX.d,
              ),
            );
          }
          return okResult(observation.revision);
        },
        stage: stageLogicalRepositoryEditV1,
      });
      return {
        project: repository('project', observations.project),
        manifest: repository('manifest', observations.manifest),
        lock: repository('lock', observations.lock),
        ledger: repository('ledger', observations.ledger),
        live: repository('live', observations.live),
        store: repository('store', observations.store),
        capabilities: repository('capabilities', observations.capabilities),
      } as unknown as ObservedStateRepositoriesV1;
    };

    const stableCalls: string[] = [];
    const stable = await readObservedStateSnapshotV1(request, repositories(stableCalls, false));
    expect(stable.ok).toBeTrue();
    if (stable.ok) {
      expect(stable.value.snapshotId).toMatch(/^snapshot:v1:[0-9a-f]{64}$/u);
      expect(Object.isFrozen(stable.value)).toBeTrue();
      expect(Object.isFrozen(stable.value.live)).toBeTrue();
    }
    expect(stableCalls).toEqual([
      ...expectedOrder.map((entry) => `observe:${entry}`),
      ...expectedOrder.map((entry) => `revision:${entry}`),
    ]);

    const changedCalls: string[] = [];
    const changed = await readObservedStateSnapshotV1(request, repositories(changedCalls, true));
    expect(changed).toEqual({ ok: false, error: { code: 'snapshot-changed' } });
    expect(changedCalls).toEqual([
      ...expectedOrder.map((entry) => `observe:${entry}`),
      ...expectedOrder.map((entry) => `revision:${entry}`),
    ]);
  });

  test('canonically orders and preserves multiple live and store resources', async () => {
    const project = semanticComponent(
      'project',
      'project:/fixture',
      Object.freeze({
        invocationCwd: '/fixture',
        effectiveCwd: '/fixture',
        projectRoot: '/fixture',
        projectIdentity: '/fixture',
        projectKind: 'git' as const,
        discoveredConfigPath: null,
        explicitConfigPath: null,
      }),
    );
    const manifest = component(
      absent(
        'manifest',
        'manifest:/fixture/skillsmith.toml',
        '/fixture/skillsmith.toml',
        '/fixture',
      ),
      null,
    );
    const lock = component(
      absent(
        'lock',
        'lock:/fixture/skillsmith.lock',
        '/fixture/skillsmith.lock',
        '/fixture',
        HEX.b,
      ),
      null,
    );
    const ledger = component(
      absent('ledger', 'ledger:user', '/fixture/data/placements.json', '/fixture/data', HEX.c),
      null,
    );
    const capabilities = semanticComponent(
      'capabilities',
      'capabilities:fixture',
      Object.freeze({
        schemaVersion: 1 as const,
        kind: 'skillsmith.capabilities' as const,
        tools: Object.freeze([]),
      }),
    );
    const live = new Map<string, ObservedComponentV1<unknown>>([
      [
        'live:user:codex:alpha',
        component(
          absent('live', 'live:user:codex:alpha', '/fixture/live/alpha', '/fixture/live', HEX.a),
          null,
        ),
      ],
      [
        'live:user:codex:beta',
        component(
          absent('live', 'live:user:codex:beta', '/fixture/live/beta', '/fixture/live', HEX.b),
          null,
        ),
      ],
    ]);
    const store = new Map<string, ObservedComponentV1<unknown>>([
      [
        'store:alpha',
        component(
          absent('store', 'store:alpha', '/fixture/store/alpha', '/fixture/store', HEX.c),
          null,
        ),
      ],
      [
        'store:beta',
        component(
          absent('store', 'store:beta', '/fixture/store/beta', '/fixture/store', HEX.d),
          null,
        ),
      ],
    ]);
    const calls: string[] = [];
    const okResult = <T>(value: T): Result<T, StateRepositoryError> => ({ ok: true, value });
    const single = (
      domain: 'project' | 'manifest' | 'lock' | 'ledger' | 'capabilities',
      value: typeof project | typeof manifest | typeof lock | typeof ledger | typeof capabilities,
    ) => ({
      observe: async (resourceId: string) => {
        calls.push(`observe:${domain}:${resourceId}`);
        return okResult(value);
      },
      observeRevision: async (resourceId: string) => {
        calls.push(`revision:${domain}:${resourceId}`);
        return okResult(value.revision);
      },
      stage: stageLogicalRepositoryEditV1,
    });
    const multiple = (
      domain: 'live' | 'store',
      values: ReadonlyMap<string, ObservedComponentV1<unknown>>,
    ) => ({
      observe: async (resourceId: string) => {
        calls.push(`observe:${domain}:${resourceId}`);
        const value = values.get(resourceId);
        if (value === undefined) throw new Error(`missing ${domain} fixture`);
        return okResult(value);
      },
      observeRevision: async (resourceId: string) => {
        calls.push(`revision:${domain}:${resourceId}`);
        const value = values.get(resourceId);
        if (value === undefined) throw new Error(`missing ${domain} fixture`);
        return okResult(value.revision);
      },
      stage: stageLogicalRepositoryEditV1,
    });
    const repositories = {
      project: single('project', project),
      manifest: single('manifest', manifest),
      lock: single('lock', lock),
      ledger: single('ledger', ledger),
      live: multiple('live', live),
      store: multiple('store', store),
      capabilities: single('capabilities', capabilities),
    } as unknown as ObservedStateRepositoriesV1;
    const request = Object.freeze({
      schemaVersion: 1 as const,
      projectResourceId: project.revision.resourceId,
      manifestResourceId: manifest.revision.resourceId,
      lockResourceId: lock.revision.resourceId,
      ledgerResourceId: ledger.revision.resourceId,
      liveResourceIds: Object.freeze(['live:user:codex:beta', 'live:user:codex:alpha']),
      storeResourceIds: Object.freeze(['store:beta', 'store:alpha']),
      capabilitiesResourceId: capabilities.revision.resourceId,
    });

    const first = await readObservedStateSnapshotV1(request, repositories);
    expect(first.ok).toBeTrue();
    if (!first.ok) return;
    expect(first.value.live.map((value) => value.revision.resourceId)).toEqual([
      'live:user:codex:alpha',
      'live:user:codex:beta',
    ]);
    expect(first.value.store.map((value) => value.revision.resourceId)).toEqual([
      'store:alpha',
      'store:beta',
    ]);
    expect(calls).toEqual([
      'observe:project:project:/fixture',
      'observe:manifest:manifest:/fixture/skillsmith.toml',
      'observe:lock:lock:/fixture/skillsmith.lock',
      'observe:ledger:ledger:user',
      'observe:live:live:user:codex:alpha',
      'observe:live:live:user:codex:beta',
      'observe:store:store:alpha',
      'observe:store:store:beta',
      'observe:capabilities:capabilities:fixture',
      'revision:project:project:/fixture',
      'revision:manifest:manifest:/fixture/skillsmith.toml',
      'revision:lock:lock:/fixture/skillsmith.lock',
      'revision:ledger:ledger:user',
      'revision:live:live:user:codex:alpha',
      'revision:live:live:user:codex:beta',
      'revision:store:store:alpha',
      'revision:store:store:beta',
      'revision:capabilities:capabilities:fixture',
    ]);

    calls.length = 0;
    const repeated = await readObservedStateSnapshotV1(
      {
        ...request,
        liveResourceIds: [...request.liveResourceIds].reverse(),
        storeResourceIds: [...request.storeResourceIds].reverse(),
      },
      repositories,
    );
    expect(repeated.ok).toBeTrue();
    if (repeated.ok) expect(repeated.value.snapshotId).toBe(first.value.snapshotId);

    calls.length = 0;
    live.set(
      'live:user:codex:alpha',
      component(
        absent(
          'live',
          'live:user:codex:alpha',
          '/fixture/live/alpha-renamed',
          '/fixture/live',
          HEX.a,
        ),
        null,
      ),
    );
    const changedIdentity = await readObservedStateSnapshotV1(request, repositories);
    expect(changedIdentity.ok).toBeTrue();
    if (changedIdentity.ok)
      expect(changedIdentity.value.snapshotId).not.toBe(first.value.snapshotId);

    const guardedLivePath = '/fixture/live/alpha';
    const guardedLiveRevision = unwrap(
      createExpectedRevisionV1({
        schemaVersion: 1,
        domain: 'live',
        resourceId: 'live:user:codex:alpha',
        state: 'present',
        targetIdentity: guardedLivePath,
        targetKind: 'directory',
        targetMetadataIdentity: `metadata:v1:${HEX.a}`,
        parentIdentity: '/fixture/live',
        parentKind: 'directory',
        parentMetadataIdentity: `metadata:v1:${HEX.b}`,
        resourceRevision: `sha256:${HEX.c}`,
        contentRevision: `sha256:${HEX.d}`,
      }),
    );
    live.set(
      'live:user:codex:alpha',
      component(guardedLiveRevision, {
        skill: 'alpha',
        tool: 'codex',
        scope: 'user',
        projectIdentity: null,
        representation: 'directory',
        path: '/fixture/mutated-live/alpha',
        realpath: '/fixture/mutated-live/alpha',
        linkTarget: null,
        dangling: false,
        placementClass: 'pinned',
        skillFile: 'valid',
        brokenReason: null,
        contentRevision: `sha256:${HEX.d}`,
      }),
    );
    expect(await readObservedStateSnapshotV1(request, repositories)).toEqual({
      ok: false,
      error: {
        code: 'snapshot-invalid-observation',
        domain: 'live',
        resourceId: 'live:user:codex:alpha',
      },
    });

    live.set(
      'live:user:codex:alpha',
      component(
        absent('live', 'live:user:codex:alpha', guardedLivePath, '/fixture/live', HEX.a),
        null,
      ),
    );
    const storeResourceId = 'store:alpha';
    const storeContentRevision = `sha256:${HEX.c}`;
    const guardedStoreRevision = unwrap(
      createExpectedRevisionV1({
        schemaVersion: 1,
        domain: 'store',
        resourceId: storeResourceId,
        state: 'present',
        targetIdentity: '/fixture/store/alpha',
        targetKind: 'directory',
        targetMetadataIdentity: `metadata:v1:${HEX.a}`,
        parentIdentity: '/fixture/store',
        parentKind: 'directory',
        parentMetadataIdentity: `metadata:v1:${HEX.b}`,
        resourceRevision: `sha256:${HEX.d}`,
        contentRevision: storeContentRevision,
        snapshotIdentity: createStoreSnapshotIdentityV1(storeResourceId, storeContentRevision),
      }),
    );
    store.set(
      storeResourceId,
      component(guardedStoreRevision, {
        path: '/fixture/mutated-store/alpha',
        repositoryRevision: `sha256:${HEX.d}`,
        contentRevision: storeContentRevision,
        snapshotIdentity: createStoreSnapshotIdentityV1(storeResourceId, storeContentRevision),
      }),
    );
    expect(await readObservedStateSnapshotV1(request, repositories)).toEqual({
      ok: false,
      error: {
        code: 'snapshot-invalid-observation',
        domain: 'store',
        resourceId: storeResourceId,
      },
    });

    store.set(
      storeResourceId,
      component(
        absent('store', storeResourceId, '/fixture/store/alpha', '/fixture/store', HEX.c),
        null,
      ),
    );
    const sensitiveCapabilitiesValue = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'skillsmith.capabilities' as const,
      tools: Object.freeze([]),
      authorizationToken: 'Bearer synthetic-sensitive-marker',
    });
    const sensitiveCapabilities = semanticComponent(
      'capabilities',
      'capabilities:fixture',
      sensitiveCapabilitiesValue,
    );
    const sensitiveRepositories = {
      ...repositories,
      capabilities: {
        observe: async () => okResult(sensitiveCapabilities),
        observeRevision: async () => okResult(sensitiveCapabilities.revision),
        stage: stageLogicalRepositoryEditV1,
      },
    } as unknown as ObservedStateRepositoriesV1;
    expect(await readObservedStateSnapshotV1(request, sensitiveRepositories)).toEqual({
      ok: false,
      error: {
        code: 'snapshot-invalid-observation',
        domain: 'capabilities',
        resourceId: 'capabilities:fixture',
      },
    });

    const mismatchedProject = component(project.revision, {
      ...project.value,
      effectiveCwd: '/fixture/project-value-b',
    });
    const projectMismatchRepositories = {
      ...repositories,
      project: {
        observe: async () => okResult(mismatchedProject),
        observeRevision: async () => okResult(mismatchedProject.revision),
        stage: stageLogicalRepositoryEditV1,
      },
    } as unknown as ObservedStateRepositoriesV1;
    expect(await readObservedStateSnapshotV1(request, projectMismatchRepositories)).toEqual({
      ok: false,
      error: {
        code: 'snapshot-invalid-observation',
        domain: 'project',
        resourceId: 'project:/fixture',
      },
    });

    const guardedLedgerModel = emptyLedgerModel('2026-07-16T00:00:00.000Z');
    const mutatedLedgerModel = emptyLedgerModel('2026-07-16T00:00:01.000Z');
    const guardedLedgerSemantic = unwrap(ledgerSemanticRevision(guardedLedgerModel));
    const guardedLedgerRevision = unwrap(
      createExpectedRevisionV1({
        schemaVersion: 1,
        domain: 'ledger',
        resourceId: 'ledger:user',
        state: 'present',
        targetIdentity: '/fixture/data/placements.json',
        targetKind: 'file',
        targetMetadataIdentity: `metadata:v1:${HEX.a}`,
        parentIdentity: '/fixture/data',
        parentKind: 'directory',
        parentMetadataIdentity: `metadata:v1:${HEX.b}`,
        byteRevision: `sha256:${HEX.c}`,
        semanticRevision: guardedLedgerSemantic,
      }),
    );
    const mismatchedLedger = component(guardedLedgerRevision, mutatedLedgerModel);
    const ledgerMismatchRepositories = {
      ...repositories,
      ledger: {
        observe: async () => okResult(mismatchedLedger),
        observeRevision: async () => okResult(mismatchedLedger.revision),
        stage: stageLogicalRepositoryEditV1,
      },
    } as unknown as ObservedStateRepositoriesV1;
    expect(await readObservedStateSnapshotV1(request, ledgerMismatchRepositories)).toEqual({
      ok: false,
      error: {
        code: 'snapshot-invalid-observation',
        domain: 'ledger',
        resourceId: 'ledger:user',
      },
    });
  });

  test('rejects resource IDs duplicated across domains before repository access', async () => {
    let accesses = 0;
    const repositories = new Proxy({} as ObservedStateRepositoriesV1, {
      get() {
        accesses += 1;
        throw new Error('repositories must not be accessed for an invalid resource vector');
      },
    });
    const result = await readObservedStateSnapshotV1(
      {
        schemaVersion: 1,
        projectResourceId: 'project:/fixture',
        manifestResourceId: 'manifest:/fixture',
        lockResourceId: 'lock:/fixture',
        ledgerResourceId: 'ledger:user',
        liveResourceIds: ['shared-resource'],
        storeResourceIds: ['shared-resource'],
        capabilitiesResourceId: 'capabilities:fixture',
      },
      repositories,
    );

    expect(result).toEqual({ ok: false, error: { code: 'snapshot-invalid-request' } });
    expect(accesses).toBe(0);
  });
});
