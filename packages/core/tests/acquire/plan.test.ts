import { describe, expect, test } from 'bun:test';
import {
  type AcquisitionInstallPlanRequestV1,
  type AcquisitionObservedStateSnapshotV1,
  type AcquisitionUninstallPlanRequestV1,
  createAcquisitionDiagnosticPlan,
  createAcquisitionPlan,
  createInstallPlanning,
  createUninstallPlanning,
} from '../../src/acquire/plan.ts';
import { createToolRegistry, toolRegistry } from '../../src/agents/registry.ts';
import { hashManifestSemantics } from '../../src/artifacts/hash.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../../src/artifacts/ledger-types.ts';
import { type PortableLockV1, hashPortableLock } from '../../src/artifacts/lock.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import {
  type ExpectedRevisionV1,
  type LivePlacementStateV1,
  type StoreStateV1,
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionPreconditionIdV1,
  createExpectedRevisionV1,
  createStoreSnapshotIdentityV1,
} from '../../src/state/types.ts';

const HEX = {
  a: 'a'.repeat(64),
  b: 'b'.repeat(64),
  c: 'c'.repeat(64),
  d: 'd'.repeat(64),
} as const;

const canonicalRevision = (input: unknown): ExpectedRevisionV1 => {
  const result = createExpectedRevisionV1(input);
  if (!result.ok) throw new Error('invalid planner revision fixture');
  return result.value;
};

const revision = (
  domain: 'manifest' | 'lock' | 'ledger' | 'live' | 'store' | 'project' | 'capabilities',
  resourceId: string,
  hex: string,
  targetIdentity = `/fixture/${domain}`,
) =>
  domain === 'project' || domain === 'capabilities'
    ? canonicalRevision({
        schemaVersion: 1,
        domain,
        resourceId,
        state: 'present',
        targetKind: 'semantic',
        semanticRevision: `sha256:${hex}`,
      })
    : canonicalRevision({
        schemaVersion: 1,
        domain,
        resourceId,
        state: 'absent',
        targetIdentity,
        targetKind: 'absent',
        parentIdentity: '/fixture',
        parentKind: 'directory',
        parentMetadataIdentity: `metadata:v1:${hex}`,
      });

const presentStoreRevision = (
  resourceId: string,
  path: string,
  contentRevision: string,
  snapshotIdentity: string,
  hex: string,
) =>
  canonicalRevision({
    schemaVersion: 1 as const,
    domain: 'store' as const,
    resourceId,
    state: 'present' as const,
    targetIdentity: path,
    targetKind: 'directory' as const,
    targetMetadataIdentity: `metadata:v1:${hex}`,
    parentIdentity: '/fixture/store',
    parentKind: 'directory' as const,
    parentMetadataIdentity: `metadata:v1:${hex}`,
    resourceRevision: `sha256:${HEX.d}`,
    contentRevision,
    snapshotIdentity,
  });

const presentLiveRevision = (resourceId: string, value: LivePlacementStateV1, hex: string) =>
  canonicalRevision({
    schemaVersion: 1 as const,
    domain: 'live' as const,
    resourceId,
    state: 'present' as const,
    targetIdentity: value.path,
    targetKind:
      value.representation === 'directory' ? ('directory' as const) : value.representation,
    targetMetadataIdentity: `metadata:v1:${hex}`,
    parentIdentity: '/fixture/live',
    parentKind: 'directory' as const,
    parentMetadataIdentity: `metadata:v1:${hex}`,
    resourceRevision: `sha256:${HEX.c}`,
    contentRevision: value.contentRevision,
  });

const presentLedgerRevision = (hex: string) =>
  canonicalRevision({
    schemaVersion: 1 as const,
    domain: 'ledger' as const,
    resourceId: 'ledger:user',
    state: 'present' as const,
    targetIdentity: '/fixture/ledger.json',
    targetKind: 'file' as const,
    targetMetadataIdentity: `metadata:v1:${hex}`,
    parentIdentity: '/fixture',
    parentKind: 'directory' as const,
    parentMetadataIdentity: `metadata:v1:${hex}`,
    byteRevision: `sha256:${hex}`,
    semanticRevision: `sha256:${hex}`,
  });

const presentArtifactRevision = (
  domain: 'manifest' | 'lock',
  resourceId: string,
  path: string,
  byteRevision: string,
  semanticRevision: string,
) =>
  canonicalRevision({
    schemaVersion: 1 as const,
    domain,
    resourceId,
    state: 'present' as const,
    targetIdentity: path,
    targetKind: 'file' as const,
    targetMetadataIdentity: `metadata:v1:${HEX.a}`,
    parentIdentity: '/fixture',
    parentKind: 'directory' as const,
    parentMetadataIdentity: `metadata:v1:${HEX.b}`,
    byteRevision,
    semanticRevision,
  });

const ledgerWithAlphaPair = (pair: LedgerPairV1Dto): LedgerModel => ({
  updatedAt: '2026-07-16T00:00:00.000Z',
  skills: { alpha: { tools: { codex: pair } } },
  projects: {},
  projectRegistrations: {},
  transactions: {},
  history: [],
});

const storeState = (resourceId: string, name: string, contentRevision = `sha256:${HEX.a}`) => {
  const snapshotIdentity = createStoreSnapshotIdentityV1(resourceId, contentRevision);
  const value: StoreStateV1 = {
    path: `/fixture/store/${name}`,
    repositoryRevision: `sha256:${HEX.d}`,
    contentRevision,
    snapshotIdentity,
  };
  return {
    revision: presentStoreRevision(
      resourceId,
      value.path,
      contentRevision,
      snapshotIdentity,
      HEX.a,
    ),
    value,
  };
};

interface SnapshotOverrides {
  readonly artifact?: AcquisitionObservedStateSnapshotV1['artifact'];
  readonly live?: AcquisitionObservedStateSnapshotV1['live'];
  readonly store?: AcquisitionObservedStateSnapshotV1['store'];
  readonly ledger?: AcquisitionObservedStateSnapshotV1['ledger'];
}

const snapshot = (
  snapshotHex = HEX.a,
  capabilityHex = HEX.b,
  overrides: SnapshotOverrides = {},
): AcquisitionObservedStateSnapshotV1 =>
  ({
    schemaVersion: 1,
    snapshotId: `snapshot:v1:${snapshotHex}`,
    project: { revision: revision('project', 'project:/fixture', HEX.a), value: {} },
    artifact: overrides.artifact ?? {
      mode: 'selected',
      pair: {
        file: {
          token: null,
          path: '/fixture/manifest',
          portability: 'machine-bound',
          portableToken: null,
        },
        lockfile: {
          token: null,
          path: '/fixture/lock',
          portability: 'machine-bound',
          portableToken: null,
        },
        lockfileSource: 'explicit',
      },
      manifest: { revision: revision('manifest', 'manifest:/fixture', HEX.a), value: null },
      lock: { revision: revision('lock', 'lock:/fixture', HEX.b), value: null },
    },
    ledger: overrides.ledger ?? {
      revision: revision('ledger', 'ledger:user', HEX.c),
      value: null,
    },
    live: overrides.live ?? [
      {
        revision: revision('live', 'live-resource-alpha', HEX.d),
        value: null,
      },
    ],
    store: overrides.store ?? [storeState('store-resource-alpha', 'alpha')],
    capabilities: {
      revision: revision('capabilities', 'capabilities:fixture', capabilityHex),
      value: {},
    },
  }) as unknown as AcquisitionObservedStateSnapshotV1;

const request = () => {
  const sourceContent = createContentObservationIdentityV1({
    schemaVersion: 1,
    resourceId: 'materialized-source-alpha',
    targetIdentity: '/fixture/fetch/alpha',
    targetKind: 'directory',
    contentRevision: `sha256:${HEX.a}`,
  });
  return {
    schemaVersion: 1 as const,
    command: 'install' as const,
    selection: {
      source: 'explicit-targets' as const,
      skills: ['alpha'],
      tools: ['codex'] as const,
      scopes: ['user'] as const,
    },
    batchPolicy: 'fail-fast' as const,
    intents: [
      {
        kind: 'install' as const,
        skill: 'alpha',
        tool: 'codex' as const,
        scope: 'user' as const,
        projectRoot: null,
        liveResourceId: 'live-resource-alpha',
        storeResourceId: 'store-resource-alpha',
        force: false,
        sourceContent,
        sourcePreconditionId: createContentObservationPreconditionIdV1(sourceContent),
        source: {
          kind: 'portable' as const,
          identity: {
            host: 'example.test',
            repository: 'fixture/repo',
            path: 'skills/alpha',
          },
          requestedRef: null,
          resolvedSha: 'c'.repeat(40),
          sourcePath: 'skills/alpha',
          contentHash: `sha256:${HEX.a}` as const,
        },
        declaration: { ref: null, path: null },
        placement: {
          classification: 'pinned' as const,
          representation: 'copy' as const,
          location: { kind: 'portable' as const, token: 'skills/user/codex/alpha' },
        },
        store: {
          location: { kind: 'portable' as const, token: 'store/fixture/alpha' },
          contentHash: `sha256:${HEX.a}` as const,
          snapshotIdentity: createStoreSnapshotIdentityV1(
            'store-resource-alpha',
            `sha256:${HEX.a}`,
          ),
        },
      },
    ],
  };
};

const artifactTransitionForInstall = (
  input: AcquisitionInstallPlanRequestV1,
  tools: readonly ('claude-code' | 'codex')[],
) => {
  const intent = input.intents[0];
  if (intent === undefined || intent.source.kind !== 'portable') throw new Error('missing intent');
  const manifest: NormalizedManifestV1 = {
    version: 1,
    skills: [
      {
        name: intent.skill,
        source: intent.source.identity,
        ref: intent.declaration?.ref ?? intent.source.requestedRef,
        tools,
        scope: intent.scope,
        placement: intent.placement.representation,
        path: null,
      },
    ],
  };
  const manifestValue = {
    version: 1 as const,
    defaults: null,
    registry: null,
    skills: manifest.skills,
  };
  const semanticHash = hashManifestSemantics(manifest);
  const lockValue = {
    version: 1 as const,
    hashSchemaVersion: 1 as const,
    manifestHash: semanticHash,
    skills: [
      {
        name: intent.skill,
        source: 'example.test/fixture/repo//skills/alpha',
        requestedRef: intent.source.requestedRef,
        resolvedSha: intent.source.resolvedSha,
        sourcePath: intent.source.sourcePath,
        contentHash: intent.source.contentHash,
      },
    ],
  };
  const lockHash = hashPortableLock(lockValue as unknown as PortableLockV1);
  if (!lockHash.ok) throw new Error(lockHash.error.message);
  return {
    initial: {
      manifest: {
        kind: 'absent' as const,
        resource: {
          kind: 'manifest-bytes' as const,
          location: { kind: 'machine-bound' as const, path: '/fixture/manifest' },
        },
      },
      lock: {
        kind: 'absent' as const,
        resource: {
          kind: 'lock' as const,
          location: { kind: 'machine-bound' as const, path: '/fixture/lock' },
        },
      },
    },
    groups: [
      {
        groupIdentity: {
          domain: 'skillsmith.operation-group-identity' as const,
          schemaVersion: 1 as const,
          command: 'install' as const,
          skill: intent.skill,
          source: intent.source,
          scope: intent.scope,
          target: null,
        },
        manifestAfter: {
          kind: 'manifest' as const,
          location: { kind: 'machine-bound' as const, path: '/fixture/manifest' },
          shape: 'canonical' as const,
          version: 1 as const,
          byteHash: `sha256:${HEX.c}` as const,
          semanticHash,
          value: manifestValue,
        },
        lockAfter: {
          kind: 'lock' as const,
          location: { kind: 'machine-bound' as const, path: '/fixture/lock' },
          version: 1 as const,
          canonicalHash: lockHash.value,
          value: lockValue,
        },
      },
    ],
  } as unknown as NonNullable<AcquisitionInstallPlanRequestV1['artifactTransition']>;
};

const expectDeepFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const child of Object.values(value)) expectDeepFrozen(child, seen);
};

describe('createAcquisitionPlan', () => {
  test('uses the supplied registry ordering during canonical planning', () => {
    const reorderedRegistry = createToolRegistry(
      toolRegistry.adapters.map((adapter) => ({
        ...adapter,
        descriptor: {
          ...adapter.descriptor,
          order:
            adapter.descriptor.id === 'codex'
              ? 1
              : adapter.descriptor.id === 'claude-code'
                ? 2
                : adapter.descriptor.order + 10,
        },
      })),
    );
    const input = {
      schemaVersion: 1 as const,
      command: 'uninstall' as const,
      selection: {
        source: 'explicit-targets' as const,
        skills: [] as const,
        tools: ['claude-code', 'codex'] as const,
        scopes: ['user'] as const,
      },
      batchPolicy: 'fail-fast' as const,
      intents: [],
    };

    const result = createAcquisitionPlan(input, snapshot(), {
      registry: reorderedRegistry,
      toolOrder: reorderedRegistry.ids,
    });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.selection.tools).toEqual(['codex', 'claude-code']);
  });

  test('owns deterministic snapshot-bound plans without mutating inputs', () => {
    const input = request();
    const observed = snapshot();
    const inputBefore = structuredClone(input);
    const observedBefore = structuredClone(observed);

    const first = createAcquisitionPlan(input, observed);
    const second = createAcquisitionPlan(input, observed);
    expect(first).toEqual(second);
    expect(input).toEqual(inputBefore);
    expect(observed).toEqual(observedBefore);
    expect(first.ok).toBeTrue();
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.snapshotId).toBe(observed.snapshotId);
    expect(first.value.expectedRevisions).toHaveLength(7);
    expect(new Set(first.value.plan.operations[0]?.preconditionIds).size).toBe(8);
    expect(first.value.plan.operations[0]?.operationId).toMatch(/^operation:v1:[0-9a-f]{64}$/u);
    expectDeepFrozen(first.value);
  });

  test('omits all portable artifact authority from a nonempty owner-free plan', () => {
    const selected = snapshot();
    const observed: AcquisitionObservedStateSnapshotV1 = {
      ...selected,
      artifact: { mode: 'none' },
    };
    const planned = createAcquisitionPlan(request(), observed);
    expect(planned.ok).toBeTrue();
    if (!planned.ok) throw new Error(planned.error.message);
    expect(planned.value.plan.operations.length).toBeGreaterThan(0);
    expect(planned.value.expectedRevisions.map(({ domain }) => domain)).not.toContain('manifest');
    expect(planned.value.expectedRevisions.map(({ domain }) => domain)).not.toContain('lock');
    const operation = planned.value.plan.operations[0];
    expect(operation?.mutates.manifest).toBeFalse();
    expect(operation?.mutates.lock).toBeFalse();
    const artifactRevisionIds = new Set<string>(
      [
        ...(selected.artifact.mode === 'selected'
          ? [selected.artifact.manifest.revision, selected.artifact.lock.revision]
          : []),
      ].map(createExpectedRevisionPreconditionIdV1),
    );
    expect(operation?.preconditionIds.some((id) => artifactRevisionIds.has(id))).toBeFalse();
    const withTransition = createAcquisitionPlan(
      {
        ...request(),
        artifactTransition: artifactTransitionForInstall(request(), ['codex']),
      },
      observed,
    );
    expect(withTransition.ok).toBeFalse();
  });

  test('plans exact selected manifest and lock transitions before every install placement', () => {
    const base = request();
    const codex = base.intents[0];
    if (codex === undefined) throw new Error('missing codex intent');
    const claude = {
      ...structuredClone(codex),
      tool: 'claude-code' as const,
      liveResourceId: 'live-resource-alpha-claude',
      placement: {
        ...codex.placement,
        location: { kind: 'portable' as const, token: 'skills/user/claude-code/alpha' },
      },
    };
    const input = {
      ...base,
      selection: { ...base.selection, tools: ['codex', 'claude-code'] as const },
      intents: [codex, claude],
      artifactTransition: artifactTransitionForInstall(base, ['claude-code', 'codex'] as const),
    };
    const observed = snapshot(HEX.a, HEX.b, {
      live: [
        { revision: revision('live', 'live-resource-alpha', HEX.d), value: null },
        { revision: revision('live', 'live-resource-alpha-claude', HEX.c), value: null },
      ],
    });
    const inputBefore = structuredClone(input);
    const observedBefore = structuredClone(observed);
    const first = createAcquisitionPlan(input, observed);
    const second = createAcquisitionPlan(
      { ...input, intents: [...input.intents].reverse() },
      observed,
    );
    expect(first.ok).toBeTrue();
    expect(second.ok).toBeTrue();
    if (!first.ok || !second.ok) throw new Error('expected selected artifact plan');
    expect(first.value.plan).toEqual(second.value.plan);
    expect(input).toEqual(inputBefore);
    expect(observed).toEqual(observedBefore);
    expect(first.value.plan.operations.map(({ kind, tool }) => [kind, tool])).toEqual([
      ['write-manifest', null],
      ['write-lock', null],
      ['install', 'claude-code'],
      ['install', 'codex'],
    ]);
    const [manifest, lock, ...placements] = first.value.plan.operations;
    expect(manifest).toMatchObject({
      pairId: null,
      skill: null,
      source: null,
      tool: null,
      scope: null,
      before: {
        kind: 'absent',
        resource: {
          kind: 'manifest-bytes',
          location: { kind: 'machine-bound', path: '/fixture/manifest' },
        },
      },
      after: {
        kind: 'manifest',
        location: { kind: 'machine-bound', path: '/fixture/manifest' },
      },
      mutates: { live: false, manifest: true, lock: false, ledger: false },
      reversibility: { kind: 'none', retentionResourceIds: [] },
      conflict: null,
    });
    if (manifest === undefined || lock === undefined)
      throw new Error('missing artifact operations');
    expect(lock.dependencyMetadata.operationIds).toEqual([manifest.operationId]);
    expect(manifest.preconditionIds).toContain(codex.sourcePreconditionId);
    expect(lock.preconditionIds).toContain(codex.sourcePreconditionId);
    expect(
      placements.every(({ dependencyMetadata }) =>
        dependencyMetadata.operationIds.includes(lock?.operationId ?? ''),
      ),
    ).toBeTrue();
    expectDeepFrozen(first.value);
  });

  test('keeps the requested ref in the lock when a pinned declaration stores the resolved SHA', () => {
    const base = request();
    const intent = base.intents[0];
    if (intent === undefined || intent.source.kind !== 'portable') {
      throw new Error('missing pinned intent fixture');
    }
    const pinnedIntent = {
      ...intent,
      source: { ...intent.source, requestedRef: 'main' },
      declaration: { ref: intent.source.resolvedSha, path: null },
    };
    const input: AcquisitionInstallPlanRequestV1 = { ...base, intents: [pinnedIntent] };
    const transition = artifactTransitionForInstall(input, ['codex']);
    const result = createAcquisitionPlan({ ...input, artifactTransition: transition }, snapshot());
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    const group = transition.groups[0];
    expect(group?.manifestAfter.value.skills[0]?.ref).toBe(intent.source.resolvedSha);
    expect(group?.lockAfter.value.skills[0]?.requestedRef).toBe('main');
  });

  test('allows a saving transition for only the changed declaration group', () => {
    const base = request();
    const alpha = base.intents[0];
    if (alpha === undefined) throw new Error('missing alpha intent');
    const betaContent = createContentObservationIdentityV1({
      ...alpha.sourceContent,
      resourceId: 'materialized-source-beta',
      targetIdentity: '/fixture/fetch/beta',
    });
    const beta = {
      ...structuredClone(alpha),
      skill: 'beta',
      liveResourceId: 'live-resource-beta',
      storeResourceId: 'store-resource-beta',
      sourceContent: betaContent,
      sourcePreconditionId: createContentObservationPreconditionIdV1(betaContent),
      source: {
        ...alpha.source,
        identity: { ...alpha.source.identity, path: 'skills/beta' },
        sourcePath: 'skills/beta',
      },
      placement: {
        ...alpha.placement,
        location: { kind: 'portable' as const, token: 'skills/user/codex/beta' },
      },
      store: {
        ...alpha.store,
        location: { kind: 'portable' as const, token: 'store/fixture/beta' },
        snapshotIdentity: createStoreSnapshotIdentityV1('store-resource-beta', `sha256:${HEX.a}`),
      },
    };
    const transition = artifactTransitionForInstall(base, ['codex']);
    const changed = transition.groups[0];
    if (changed === undefined) throw new Error('missing changed transition');
    const manifestValue = {
      ...changed.manifestAfter.value,
      skills: [
        ...changed.manifestAfter.value.skills,
        {
          name: beta.skill,
          source: beta.source.identity,
          ref: beta.source.requestedRef,
          tools: [beta.tool],
          scope: beta.scope,
          placement: beta.placement.representation,
          path: null,
        },
      ],
    };
    const manifestHash = hashManifestSemantics({
      version: 1,
      skills: manifestValue.skills,
    });
    const lockValue = {
      ...changed.lockAfter.value,
      manifestHash: manifestHash as `sha256:${string}`,
      skills: [
        ...changed.lockAfter.value.skills,
        {
          name: beta.skill,
          source: 'example.test/fixture/repo//skills/beta',
          requestedRef: beta.source.requestedRef,
          resolvedSha: beta.source.resolvedSha,
          sourcePath: beta.source.sourcePath,
          contentHash: beta.source.contentHash,
        },
      ],
    };
    const lockHash = hashPortableLock(lockValue as unknown as PortableLockV1);
    if (!lockHash.ok) throw new Error(lockHash.error.message);
    const betaGroupIdentity = {
      domain: 'skillsmith.operation-group-identity' as const,
      schemaVersion: 1 as const,
      command: 'install' as const,
      skill: beta.skill,
      source: beta.source,
      scope: beta.scope,
      target: null,
    };
    const artifactTransition = {
      ...transition,
      unchangedGroups: [betaGroupIdentity],
      groups: [
        {
          ...changed,
          manifestAfter: {
            ...changed.manifestAfter,
            semanticHash: manifestHash as `sha256:${string}`,
            value: manifestValue,
          },
          lockAfter: {
            ...changed.lockAfter,
            canonicalHash: lockHash.value,
            value: lockValue,
          },
        },
      ],
    } as unknown as NonNullable<AcquisitionInstallPlanRequestV1['artifactTransition']>;
    const observed = snapshot(HEX.a, HEX.b, {
      live: [
        { revision: revision('live', 'live-resource-alpha', HEX.d), value: null },
        { revision: revision('live', 'live-resource-beta', HEX.c), value: null },
      ],
      store: [
        storeState('store-resource-alpha', 'alpha'),
        storeState('store-resource-beta', 'beta'),
      ],
    });
    const commonInput = {
      ...base,
      selection: { ...base.selection, skills: ['alpha', 'beta'] },
      intents: [alpha, beta],
    };
    const omitted = createAcquisitionPlan(
      { ...commonInput, artifactTransition: { ...artifactTransition, unchangedGroups: [] } },
      observed,
    );
    expect(omitted.ok).toBeFalse();
    const result = createAcquisitionPlan(
      {
        ...commonInput,
        artifactTransition,
      },
      observed,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    const lock = result.value.plan.operations.find(({ kind }) => kind === 'write-lock');
    const alphaPlacement = result.value.plan.operations.find(
      ({ skill, pairId }) => skill === 'alpha' && pairId !== null,
    );
    const betaPlacement = result.value.plan.operations.find(
      ({ skill, pairId }) => skill === 'beta' && pairId !== null,
    );
    if (lock === undefined || alphaPlacement === undefined || betaPlacement === undefined) {
      throw new Error('missing mixed transition operations');
    }
    expect(alphaPlacement.dependencyMetadata.operationIds).toEqual([lock.operationId]);
    expect(betaPlacement.dependencyMetadata.operationIds).toEqual([]);

    const extraToolManifest = {
      ...manifestValue,
      skills: manifestValue.skills.map((skill) =>
        skill.name === beta.skill
          ? { ...skill, tools: ['claude-code' as const, 'codex' as const] }
          : skill,
      ),
    };
    const extraToolManifestHash = hashManifestSemantics({
      version: 1,
      skills: extraToolManifest.skills,
    });
    const extraToolLock = {
      ...lockValue,
      manifestHash: extraToolManifestHash as `sha256:${string}`,
    };
    const extraToolLockHash = hashPortableLock(extraToolLock as unknown as PortableLockV1);
    if (!extraToolLockHash.ok) throw new Error(extraToolLockHash.error.message);
    const changedTransition = artifactTransition.groups[0];
    if (changedTransition === undefined) throw new Error('missing changed transition');
    const extraTool = createAcquisitionPlan(
      {
        ...commonInput,
        artifactTransition: {
          ...artifactTransition,
          groups: [
            {
              ...changedTransition,
              manifestAfter: {
                ...changedTransition.manifestAfter,
                semanticHash: extraToolManifestHash as `sha256:${string}`,
                value: extraToolManifest,
              },
              lockAfter: {
                ...changedTransition.lockAfter,
                canonicalHash: extraToolLockHash.value as `sha256:${string}`,
                value: extraToolLock,
              },
            },
          ],
        },
      },
      observed,
    );
    expect(extraTool.ok).toBeFalse();
  });

  test('accepts an explicitly unchanged saving group only against current portable state', () => {
    const input = request();
    const transition = artifactTransitionForInstall(input, ['codex']);
    const group = transition.groups[0];
    if (group === undefined) throw new Error('missing unchanged transition fixture');
    const observed = snapshot(HEX.a, HEX.b, {
      artifact: {
        mode: 'selected',
        pair: {
          file: {
            token: null,
            path: '/fixture/manifest',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfile: {
            token: null,
            path: '/fixture/lock',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfileSource: 'explicit',
        },
        manifest: {
          revision: presentArtifactRevision(
            'manifest',
            'manifest:/fixture',
            '/fixture/manifest',
            group.manifestAfter.byteHash,
            group.manifestAfter.semanticHash,
          ),
          value: { version: 1, skills: group.manifestAfter.value.skills },
        },
        lock: {
          revision: presentArtifactRevision(
            'lock',
            'lock:/fixture',
            '/fixture/lock',
            group.lockAfter.canonicalHash,
            group.lockAfter.canonicalHash,
          ),
          value: group.lockAfter.value as PortableLockV1,
        },
      },
    });
    const unchanged = createAcquisitionPlan(
      {
        ...input,
        artifactTransition: {
          initial: { manifest: group.manifestAfter, lock: group.lockAfter },
          groups: [],
          unchangedGroups: [group.groupIdentity],
        },
      },
      observed,
    );
    expect(unchanged.ok).toBeTrue();
    if (!unchanged.ok) throw new Error(unchanged.error.message);
    expect(unchanged.value.plan.operations.map(({ kind }) => kind)).toEqual(['install']);

    const absent = createAcquisitionPlan(
      {
        ...input,
        artifactTransition: {
          initial: transition.initial,
          groups: [],
          unchangedGroups: [group.groupIdentity],
        },
      },
      snapshot(),
    );
    expect(absent.ok).toBeFalse();
  });

  test('plans a lock-only repair without rewriting an exact canonical manifest', () => {
    const input = request();
    const transition = artifactTransitionForInstall(input, ['codex']);
    const group = transition.groups[0];
    if (group === undefined) throw new Error('missing lock-only transition fixture');
    const observed = snapshot(HEX.a, HEX.b, {
      artifact: {
        mode: 'selected',
        pair: {
          file: {
            token: null,
            path: '/fixture/manifest',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfile: {
            token: null,
            path: '/fixture/lock',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfileSource: 'explicit',
        },
        manifest: {
          revision: presentArtifactRevision(
            'manifest',
            'manifest:/fixture',
            '/fixture/manifest',
            group.manifestAfter.byteHash,
            group.manifestAfter.semanticHash,
          ),
          value: { version: 1, skills: group.manifestAfter.value.skills },
        },
        lock: { revision: revision('lock', 'lock:/fixture', HEX.b), value: null },
      },
    });
    const result = createAcquisitionPlan(
      {
        ...input,
        artifactTransition: {
          initial: { manifest: group.manifestAfter, lock: transition.initial.lock },
          groups: [group],
        },
      },
      observed,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock', 'install']);
    const [lock, placement] = result.value.plan.operations;
    if (lock === undefined || placement === undefined) {
      throw new Error('missing lock-only operation chain');
    }
    expect(lock.dependencyMetadata.operationIds).toEqual([]);
    expect(placement.dependencyMetadata.operationIds).toEqual([lock.operationId]);
    expect(lock.before.kind).toBe('absent');
    expect(lock.after).toEqual(group.lockAfter);

    const formattingOnlyRewrite = createAcquisitionPlan(
      {
        ...input,
        artifactTransition: {
          initial: { manifest: group.manifestAfter, lock: transition.initial.lock },
          groups: [
            {
              ...group,
              manifestAfter: { ...group.manifestAfter, byteHash: `sha256:${HEX.d}` },
            },
          ],
        },
      },
      observed,
    );
    expect(formattingOnlyRewrite.ok).toBeFalse();
  });

  test('validates changed install groups against complete declaration and resolution intent', () => {
    const input = request();
    const transition = artifactTransitionForInstall(input, ['codex']);
    const group = transition.groups[0];
    if (group === undefined) throw new Error('missing changed transition fixture');
    const mismatchedManifestValue = {
      ...group.manifestAfter.value,
      skills: group.manifestAfter.value.skills.map((declaration) => ({
        ...declaration,
        placement: 'symlink' as const,
      })),
    };
    const mismatchedManifestHash = hashManifestSemantics({
      version: 1,
      skills: mismatchedManifestValue.skills,
    });
    const manifestMismatchLock = {
      ...group.lockAfter.value,
      manifestHash: mismatchedManifestHash as `sha256:${string}`,
    };
    const manifestMismatchLockHash = hashPortableLock(
      manifestMismatchLock as unknown as PortableLockV1,
    );
    if (!manifestMismatchLockHash.ok) throw new Error(manifestMismatchLockHash.error.message);
    const manifestMismatch = createAcquisitionPlan(
      {
        ...input,
        artifactTransition: {
          ...transition,
          groups: [
            {
              ...group,
              manifestAfter: {
                ...group.manifestAfter,
                semanticHash: mismatchedManifestHash as `sha256:${string}`,
                value: mismatchedManifestValue,
              },
              lockAfter: {
                ...group.lockAfter,
                canonicalHash: manifestMismatchLockHash.value as `sha256:${string}`,
                value: manifestMismatchLock,
              },
            },
          ],
        },
      },
      snapshot(),
    );
    expect(manifestMismatch.ok).toBeFalse();

    const resolutionMismatchLock = {
      ...group.lockAfter.value,
      skills: group.lockAfter.value.skills.map((locked) => ({
        ...locked,
        contentHash: `sha256:${HEX.d}` as const,
      })),
    };
    const resolutionMismatchHash = hashPortableLock(
      resolutionMismatchLock as unknown as PortableLockV1,
    );
    if (!resolutionMismatchHash.ok) throw new Error(resolutionMismatchHash.error.message);
    const resolutionMismatch = createAcquisitionPlan(
      {
        ...input,
        artifactTransition: {
          ...transition,
          groups: [
            {
              ...group,
              lockAfter: {
                ...group.lockAfter,
                canonicalHash: resolutionMismatchHash.value as `sha256:${string}`,
                value: resolutionMismatchLock,
              },
            },
          ],
        },
      },
      snapshot(),
    );
    expect(resolutionMismatch.ok).toBeFalse();
  });

  test('requires exact complete intent for unchanged groups but not non-saving plans', () => {
    const input = request();
    const intent = input.intents[0];
    if (intent === undefined) throw new Error('missing complete intent fixture');
    const { declaration: _declaration, ...withoutDeclaration } = intent;
    const nonSaving = createAcquisitionPlan(
      { ...input, intents: [withoutDeclaration] },
      snapshot(),
    );
    expect(nonSaving.ok).toBeTrue();

    const transition = artifactTransitionForInstall(input, ['codex']);
    const group = transition.groups[0];
    if (group === undefined) throw new Error('missing unchanged transition fixture');
    const alternateManifestValue = {
      ...group.manifestAfter.value,
      skills: group.manifestAfter.value.skills.map((entry) => ({
        ...entry,
        ref: intent.source.kind === 'portable' ? intent.source.resolvedSha : null,
      })),
    };
    const alternateManifestHash = hashManifestSemantics({
      version: 1,
      skills: alternateManifestValue.skills,
    });
    const alternateLock = {
      ...group.lockAfter.value,
      manifestHash: alternateManifestHash as `sha256:${string}`,
      skills: group.lockAfter.value.skills.map((entry) => ({
        ...entry,
        requestedRef: intent.source.kind === 'portable' ? intent.source.resolvedSha : null,
      })),
    };
    const alternateLockHash = hashPortableLock(alternateLock as unknown as PortableLockV1);
    if (!alternateLockHash.ok) throw new Error(alternateLockHash.error.message);
    const manifestImage = {
      ...group.manifestAfter,
      semanticHash: alternateManifestHash as `sha256:${string}`,
      value: alternateManifestValue,
    };
    const lockImage = {
      ...group.lockAfter,
      canonicalHash: alternateLockHash.value as `sha256:${string}`,
      value: alternateLock,
    };
    const observed = snapshot(HEX.a, HEX.b, {
      artifact: {
        mode: 'selected',
        pair: {
          file: {
            token: null,
            path: '/fixture/manifest',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfile: {
            token: null,
            path: '/fixture/lock',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfileSource: 'explicit',
        },
        manifest: {
          revision: presentArtifactRevision(
            'manifest',
            'manifest:/fixture',
            '/fixture/manifest',
            manifestImage.byteHash,
            manifestImage.semanticHash,
          ),
          value: { version: 1, skills: manifestImage.value.skills },
        },
        lock: {
          revision: presentArtifactRevision(
            'lock',
            'lock:/fixture',
            '/fixture/lock',
            lockImage.canonicalHash,
            lockImage.canonicalHash,
          ),
          value: alternateLock as unknown as PortableLockV1,
        },
      },
    });
    const exactPairButWrongIntent = createAcquisitionPlan(
      {
        ...input,
        artifactTransition: {
          initial: { manifest: manifestImage, lock: lockImage },
          groups: [],
          unchangedGroups: [group.groupIdentity],
        },
      },
      observed,
    );
    expect(exactPairButWrongIntent.ok).toBeFalse();
    const missingProjection = createAcquisitionPlan(
      {
        ...input,
        intents: [withoutDeclaration],
        artifactTransition: {
          initial: { manifest: group.manifestAfter, lock: group.lockAfter },
          groups: [],
          unchangedGroups: [group.groupIdentity],
        },
      },
      snapshot(HEX.a, HEX.b, {
        artifact: {
          mode: 'selected',
          pair: {
            file: {
              token: null,
              path: '/fixture/manifest',
              portability: 'machine-bound',
              portableToken: null,
            },
            lockfile: {
              token: null,
              path: '/fixture/lock',
              portability: 'machine-bound',
              portableToken: null,
            },
            lockfileSource: 'explicit',
          },
          manifest: {
            revision: presentArtifactRevision(
              'manifest',
              'manifest:/fixture',
              '/fixture/manifest',
              group.manifestAfter.byteHash,
              group.manifestAfter.semanticHash,
            ),
            value: { version: 1, skills: group.manifestAfter.value.skills },
          },
          lock: {
            revision: presentArtifactRevision(
              'lock',
              'lock:/fixture',
              '/fixture/lock',
              group.lockAfter.canonicalHash,
              group.lockAfter.canonicalHash,
            ),
            value: group.lockAfter.value as PortableLockV1,
          },
        },
      }),
    );
    expect(missingProjection.ok).toBeFalse();
  });

  test('chains an exact legacy migration before manifest, lock, and install', () => {
    const input = request();
    const transition = artifactTransitionForInstall(input, ['codex']);
    const group = transition.groups[0];
    if (group === undefined) throw new Error('missing artifact transition group');
    const emptyManifest: NormalizedManifestV1 = { version: 1, skills: [] };
    const emptyValue = { version: 1 as const, defaults: null, registry: null, skills: [] };
    const semanticHash = hashManifestSemantics(emptyManifest);
    const legacy = {
      kind: 'manifest' as const,
      location: { kind: 'machine-bound' as const, path: '/fixture/manifest' },
      shape: 'legacy' as const,
      version: 1 as const,
      byteHash: `sha256:${HEX.a}` as const,
      semanticHash: semanticHash as `sha256:${string}`,
      value: emptyValue,
    };
    const canonical = {
      ...legacy,
      shape: 'canonical' as const,
      byteHash: `sha256:${HEX.b}` as const,
    };
    const requestWithTransition: AcquisitionInstallPlanRequestV1 = {
      ...input,
      artifactTransition: {
        initial: { manifest: legacy, lock: transition.initial.lock },
        groups: [{ ...group, migrationAfter: canonical }],
      },
    };
    const observed = snapshot(HEX.a, HEX.b, {
      artifact: {
        mode: 'selected',
        pair: {
          file: {
            token: null,
            path: '/fixture/manifest',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfile: {
            token: null,
            path: '/fixture/lock',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfileSource: 'explicit',
        },
        manifest: {
          revision: presentArtifactRevision(
            'manifest',
            'manifest:/fixture',
            '/fixture/manifest',
            legacy.byteHash,
            legacy.semanticHash,
          ),
          value: emptyManifest,
        },
        lock: { revision: revision('lock', 'lock:/fixture', HEX.b), value: null },
      },
    });
    const result = createAcquisitionPlan(requestWithTransition, observed);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations.map(({ kind }) => kind)).toEqual([
      'migrate-project-config',
      'write-manifest',
      'write-lock',
      'install',
    ]);
    const [migration, manifest, lock, placement] = result.value.plan.operations;
    if (
      migration === undefined ||
      manifest === undefined ||
      lock === undefined ||
      placement === undefined
    ) {
      throw new Error('missing migration chain');
    }
    expect(manifest.dependencyMetadata.operationIds).toEqual([migration.operationId]);
    expect(lock.dependencyMetadata.operationIds).toEqual([manifest.operationId]);
    expect(placement.dependencyMetadata.operationIds).toEqual([lock.operationId]);
  });

  test('rejects an incoherent after pair while allowing stale initial lock state', () => {
    const input = request();
    const transition = artifactTransitionForInstall(input, ['codex']);
    const group = transition.groups[0];
    if (group === undefined) throw new Error('missing transition group');
    const incoherentLock = {
      ...group.lockAfter.value,
      skills: [],
    };
    const incoherentHash = hashPortableLock(incoherentLock as unknown as PortableLockV1);
    if (!incoherentHash.ok) throw new Error(incoherentHash.error.message);
    const incoherent = createAcquisitionPlan(
      {
        ...input,
        artifactTransition: {
          ...transition,
          groups: [
            {
              ...group,
              lockAfter: {
                ...group.lockAfter,
                canonicalHash: incoherentHash.value as `sha256:${string}`,
                value: incoherentLock,
              },
            },
          ],
        },
      },
      snapshot(),
    );
    expect(incoherent.ok).toBeFalse();

    const emptyManifestHash = hashManifestSemantics({ version: 1, skills: [] });
    const staleLock = {
      version: 1 as const,
      hashSchemaVersion: 1 as const,
      manifestHash: emptyManifestHash as `sha256:${string}`,
      skills: [
        ...group.lockAfter.value.skills,
        {
          name: 'stale',
          source: 'example.test/fixture/repo//skills/stale',
          requestedRef: null,
          resolvedSha: 'd'.repeat(40),
          sourcePath: 'skills/stale',
          contentHash: `sha256:${HEX.d}` as const,
        },
      ],
    };
    const staleHash = hashPortableLock(staleLock as unknown as PortableLockV1);
    if (!staleHash.ok) throw new Error(staleHash.error.message);
    const selected = snapshot();
    if (selected.artifact.mode !== 'selected') throw new Error('missing selected artifact');
    const staleInitial = createAcquisitionPlan(
      {
        ...input,
        artifactTransition: {
          ...transition,
          initial: {
            ...transition.initial,
            lock: {
              kind: 'lock',
              location: { kind: 'machine-bound', path: '/fixture/lock' },
              version: 1,
              canonicalHash: staleHash.value as `sha256:${string}`,
              value: staleLock,
            },
          },
        },
      },
      {
        ...selected,
        artifact: {
          ...selected.artifact,
          lock: {
            revision: presentArtifactRevision(
              'lock',
              'lock:/fixture',
              '/fixture/lock',
              staleHash.value,
              staleHash.value,
            ),
            value: staleLock as unknown as PortableLockV1,
          },
        },
      },
    );
    expect(staleInitial.ok).toBeTrue();
  });

  test('keeps semantic operation identity independent of snapshot identity and unrelated revisions', () => {
    const first = createAcquisitionPlan(request(), snapshot(HEX.a, HEX.b));
    const second = createAcquisitionPlan(request(), snapshot(HEX.c, HEX.d));
    expect(first.ok).toBeTrue();
    expect(second.ok).toBeTrue();
    if (!first.ok || !second.ok) throw new Error('expected acquisition plans');
    expect(first.value.plan.operations.map((operation) => operation.operationId)).toEqual(
      second.value.plan.operations.map((operation) => operation.operationId),
    );
    expect(first.value.snapshotId).not.toBe(second.value.snapshotId);
    expect(first.value.expectedRevisions).not.toEqual(second.value.expectedRevisions);
  });

  test('selects multiple live and store observations only by their explicit resource IDs', () => {
    const alpha = request().intents[0];
    if (alpha === undefined) throw new Error('missing alpha intent');
    const beta = {
      ...structuredClone(alpha),
      skill: 'beta',
      liveResourceId: 'live-resource-beta-nonconventional',
      storeResourceId: 'store-resource-beta-nonconventional',
      source: {
        ...alpha.source,
        identity: { ...alpha.source.identity, path: 'skills/beta' },
        sourcePath: 'skills/beta',
      },
      placement: {
        ...alpha.placement,
        representation: 'symlink' as const,
        location: { kind: 'portable' as const, token: 'skills/user/codex/beta' },
      },
      store: {
        ...alpha.store,
        location: { kind: 'portable' as const, token: 'store/fixture/beta' },
        snapshotIdentity: createStoreSnapshotIdentityV1(
          'store-resource-beta-nonconventional',
          `sha256:${HEX.a}`,
        ),
      },
    };
    const input = {
      ...request(),
      selection: { ...request().selection, skills: ['alpha', 'beta'] },
      intents: [alpha, beta],
    };
    const observed = snapshot(HEX.a, HEX.b, {
      live: [
        {
          revision: revision('live', 'live-resource-beta-nonconventional', HEX.c),
          value: null,
        },
        { revision: revision('live', 'live-resource-alpha', HEX.d), value: null },
      ] as AcquisitionObservedStateSnapshotV1['live'],
      store: [
        storeState('store-resource-beta-nonconventional', 'beta'),
        storeState('store-resource-alpha', 'alpha'),
      ],
    });
    const result = createAcquisitionPlan(input, observed);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    const bySkill = new Map(
      result.value.plan.operations.map((operation) => [operation.skill, operation]),
    );
    expect(bySkill.get('alpha')?.after).toMatchObject({
      kind: 'placement',
      representation: 'copy',
      linkTarget: null,
    });
    expect(bySkill.get('beta')?.after).toMatchObject({
      kind: 'placement',
      representation: 'symlink',
      linkTarget: { kind: 'machine-bound', path: '/fixture/store/beta' },
    });
  });

  test('derives an exact present-live before image from live facts and the canonical ledger', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'symlink',
      path: '/fixture/live/alpha',
      realpath: '/fixture/store/old-alpha',
      linkTarget: '../store/old-alpha',
      dangling: true,
      placementClass: 'store-linked',
      skillFile: 'invalid',
      brokenReason: 'dangling-link',
      contentRevision: null,
    };
    const ledger: LedgerModel = {
      updatedAt: '2026-07-16T00:00:00.000Z',
      skills: {
        alpha: {
          tools: {
            codex: {
              placementPath: live.path,
              mode: 'pinned',
              dev: null,
              pinned: {
                storePath: '/fixture/store/old-alpha',
                rev: 'c'.repeat(40),
                gitSha: 'c'.repeat(40),
                dirty: false,
                contentHash: `sha256:${HEX.c}`,
                snapshotAt: '2026-07-16T00:00:00.000Z',
                verify: 'passed',
                placement: 'symlink',
              },
              origin: {
                source: 'example.test/fixture/repo//skills/alpha',
                host: 'example.test',
                repo: 'fixture/repo',
                skillPath: 'skills/alpha',
                refRequested: null,
                refResolved: 'c'.repeat(40),
                pin: true,
                installedAt: '2026-07-16T00:00:00.000Z',
              },
              journal: null,
            },
          },
        },
      },
      projects: {},
      projectRegistrations: {},
      transactions: {},
      history: [],
    };
    const observed = snapshot(HEX.a, HEX.b, {
      live: [
        {
          revision: presentLiveRevision('live-resource-alpha', live, HEX.d),
          value: live,
        },
      ],
      ledger: {
        revision: presentLedgerRevision(HEX.c),
        value: ledger,
      },
    });
    const result = createAcquisitionPlan(request(), observed);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations[0]?.before).toEqual({
      kind: 'placement',
      resource: {
        kind: 'live',
        skill: 'alpha',
        tool: 'codex',
        scope: 'user',
        projectRoot: null,
        location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
      },
      classification: 'store-linked',
      representation: 'symlink',
      linkTarget: { kind: 'machine-bound', path: '/fixture/store/old-alpha' },
      dangling: true,
      source: {
        kind: 'portable',
        identity: {
          host: 'example.test',
          repository: 'fixture/repo',
          path: 'skills/alpha',
        },
        requestedRef: null,
        resolvedSha: 'c'.repeat(40),
        sourcePath: 'skills/alpha',
        contentHash: `sha256:${HEX.c}`,
      },
      contentHash: `sha256:${HEX.c}`,
    });
  });

  test('classifies only exercised forced install conflicts from exact managed and unmanaged facts', () => {
    const base = request();
    const intent = base.intents[0];
    if (intent === undefined) throw new Error('missing install intent');
    const forced: AcquisitionInstallPlanRequestV1 = {
      ...base,
      intents: [{ ...intent, force: true }],
    };
    const live = (contentRevision: `sha256:${string}`): LivePlacementStateV1 => ({
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
      contentRevision,
    });
    const unmanagedLive = live(`sha256:${HEX.a}`);
    const unmanaged = createAcquisitionPlan(
      forced,
      snapshot(HEX.a, HEX.b, {
        live: [
          {
            revision: presentLiveRevision('live-resource-alpha', unmanagedLive, HEX.d),
            value: unmanagedLive,
          },
        ],
      }),
    );
    expect(unmanaged.ok).toBeTrue();
    if (!unmanaged.ok) throw new Error(unmanaged.error.message);
    expect(unmanaged.value.plan.operations[0]?.conflict).toEqual({
      class: 'unmanaged-target',
      normal: 'refuse',
      forced: 'backup-and-replace',
      target: expect.objectContaining({
        kind: 'live',
        skill: 'alpha',
        tool: 'codex',
      }),
      backup: 'required',
    });

    const managedLive = live(`sha256:${HEX.c}`);
    const priorPair: LedgerPairV1Dto = {
      placementPath: managedLive.path,
      mode: 'pinned',
      dev: null,
      pinned: {
        storePath: '/fixture/store/old-alpha',
        rev: 'd'.repeat(40),
        gitSha: 'd'.repeat(40),
        dirty: false,
        contentHash: `sha256:${HEX.c}`,
        snapshotAt: '2026-07-16T00:00:00.000Z',
        verify: 'passed',
        placement: 'copy',
      },
      origin: {
        source: 'example.test/fixture/repo//skills/alpha@old',
        host: 'example.test',
        repo: 'fixture/repo',
        skillPath: 'skills/alpha',
        refRequested: 'old',
        refResolved: 'd'.repeat(40),
        pin: true,
        installedAt: '2026-07-16T00:00:00.000Z',
      },
      journal: null,
    };
    const sourceChanged = createAcquisitionPlan(
      forced,
      snapshot(HEX.a, HEX.b, {
        live: [
          {
            revision: presentLiveRevision('live-resource-alpha', managedLive, HEX.d),
            value: managedLive,
          },
        ],
        ledger: {
          revision: presentLedgerRevision(HEX.c),
          value: ledgerWithAlphaPair(priorPair),
        },
      }),
    );
    expect(sourceChanged.ok).toBeTrue();
    if (!sourceChanged.ok) throw new Error(sourceChanged.error.message);
    expect(sourceChanged.value.plan.operations[0]?.conflict).toEqual({
      class: 'source-changed',
      normal: 'refuse',
      forced: 'replace',
      target: expect.objectContaining({
        kind: 'live',
        skill: 'alpha',
        tool: 'codex',
      }),
      backup: 'none',
    });
  });

  test('fails closed when an explicit resource is missing or its store snapshot is mismatched', () => {
    const missing = request();
    const missingIntent = missing.intents[0];
    if (missingIntent === undefined) throw new Error('missing install intent');
    missing.intents[0] = {
      ...missingIntent,
      liveResourceId: 'live-resource-missing',
    };
    expect(createAcquisitionPlan(missing, snapshot())).toMatchObject({
      ok: false,
      error: {
        message: 'acquisition planning: live resource observation is missing or ambiguous',
      },
    });

    const mismatched = request();
    const mismatchedIntent = mismatched.intents[0];
    if (mismatchedIntent === undefined) throw new Error('missing install intent');
    mismatched.intents[0] = {
      ...mismatchedIntent,
      store: { ...mismatchedIntent.store, snapshotIdentity: `store:v1:${HEX.d}` },
    };
    expect(createAcquisitionPlan(mismatched, snapshot())).toMatchObject({
      ok: false,
      error: { message: 'acquisition planning: store resource does not match install intent' },
    });
  });

  test('refuses inconsistent source and store content facts without throwing', () => {
    const input = request();
    const inconsistent = {
      ...input,
      intents: input.intents.map((intent) => ({
        ...intent,
        store: { ...intent.store, contentHash: `sha256:${HEX.d}` as const },
      })),
    };
    const result = createAcquisitionPlan(inconsistent, snapshot());
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'planning-invalid',
        message: 'acquisition planning: source/store content revisions differ',
      },
    });
  });

  test('plans install against an exact absent-store expectation without performing effects', () => {
    const base = request();
    const intent = base.intents[0];
    if (intent === undefined) throw new Error('missing install intent');
    const input: AcquisitionInstallPlanRequestV1 = {
      ...base,
      intents: [
        {
          ...intent,
          placement: {
            ...intent.placement,
            representation: 'symlink',
            location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
          },
          store: {
            ...intent.store,
            location: { kind: 'machine-bound', path: '/fixture/store/alpha' },
          },
        },
      ],
    };
    const observed = snapshot(HEX.a, HEX.b, {
      live: [
        {
          revision: revision('live', 'live-resource-alpha', HEX.d, '/fixture/live/alpha'),
          value: null,
        },
      ],
      store: [
        {
          revision: revision('store', 'store-resource-alpha', HEX.a, '/fixture/store/alpha'),
          value: null,
        },
      ],
    });
    const inputBefore = structuredClone(input);
    const observedBefore = structuredClone(observed);

    const result = createAcquisitionPlan(input, observed);

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(input).toEqual(inputBefore);
    expect(observed).toEqual(observedBefore);
    expect(result.value.plan.operations[0]).toMatchObject({
      kind: 'install',
      before: {
        kind: 'absent',
        resource: {
          location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
        },
      },
      after: {
        kind: 'placement',
        classification: 'pinned',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: '/fixture/store/alpha' },
        dangling: false,
        contentHash: `sha256:${HEX.a}`,
      },
      reason: { code: 'install-selected' },
    });
    expect(result.value.plan.checks).toEqual([]);
    expect(result.value.plan.operations[0]?.preconditionIds).toHaveLength(
      result.value.expectedRevisions.length + 1,
    );
  });

  test('plans deterministic uninstall from exact live and ledger facts', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'symlink',
      path: '/fixture/live/alpha',
      realpath: '/fixture/source/alpha',
      linkTarget: '/fixture/source/alpha',
      dangling: false,
      placementClass: 'dev',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: `sha256:${HEX.a}`,
    };
    const pair: LedgerPairV1Dto = {
      placementPath: live.path,
      mode: 'dev',
      dev: {
        sourcePath: '/fixture/source/alpha',
        resolvedPath: '/fixture/source/alpha',
        repoRoot: '/fixture',
        sourceRelPath: 'source/alpha',
        remote: null,
        recordedAt: '2026-07-16T00:00:00.000Z',
      },
      pinned: null,
      journal: null,
    };
    const observed = snapshot(HEX.a, HEX.b, {
      live: [
        {
          revision: presentLiveRevision('live-resource-alpha', live, HEX.d),
          value: live,
        },
      ],
      ledger: {
        revision: presentLedgerRevision(HEX.c),
        value: ledgerWithAlphaPair(pair),
      },
    });
    const input = {
      schemaVersion: 1 as const,
      command: 'uninstall' as const,
      selection: {
        source: 'explicit-targets' as const,
        skills: ['alpha'],
        tools: ['codex'] as const,
        scopes: ['user'] as const,
      },
      batchPolicy: 'fail-fast' as const,
      intents: [
        {
          kind: 'remove' as const,
          skill: 'alpha',
          tool: 'codex' as const,
          scope: 'user' as const,
          projectRoot: null,
          liveResourceId: 'live-resource-alpha',
          storeResourceId: null,
        },
      ],
    };
    const inputBefore = structuredClone(input);
    const observedBefore = structuredClone(observed);

    const first = createAcquisitionPlan(input, observed);
    const second = createAcquisitionPlan(input, observed);

    expect(first).toEqual(second);
    expect(first.ok).toBeTrue();
    if (!first.ok) throw new Error(first.error.message);
    expect(input).toEqual(inputBefore);
    expect(observed).toEqual(observedBefore);
    expect(first.value.plan.operations[0]).toMatchObject({
      kind: 'remove',
      source: null,
      before: {
        kind: 'placement',
        classification: 'dev',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: '/fixture/source/alpha' },
        dangling: false,
        source: {
          kind: 'local-dev',
          path: '/fixture/source/alpha',
          contentHash: `sha256:${HEX.a}`,
        },
        contentHash: `sha256:${HEX.a}`,
      },
      after: {
        kind: 'absent',
        resource: {
          location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
        },
      },
      reason: { code: 'remove-selected' },
    });
    expect(first.value.plan.operations[0]?.preconditionIds).toHaveLength(
      first.value.expectedRevisions.length,
    );

    const beforeManifest: NormalizedManifestV1 = {
      version: 1,
      skills: [
        {
          name: 'alpha',
          source: { host: 'example.test', repository: 'fixture/repo', path: 'skills/alpha' },
          ref: null,
          tools: ['codex'],
          scope: 'user',
          placement: 'symlink',
          path: null,
        },
      ],
    };
    const afterManifest: NormalizedManifestV1 = { version: 1, skills: [] };
    const beforeManifestHash = hashManifestSemantics(beforeManifest);
    const afterManifestHash = hashManifestSemantics(afterManifest);
    const beforeLock = {
      version: 1 as const,
      hashSchemaVersion: 1 as const,
      manifestHash: beforeManifestHash,
      skills: [
        {
          name: 'alpha',
          source: 'example.test/fixture/repo//skills/alpha',
          requestedRef: null,
          resolvedSha: 'c'.repeat(40),
          sourcePath: 'skills/alpha',
          contentHash: beforeManifestHash,
        },
      ],
    };
    const afterLock = {
      version: 1 as const,
      hashSchemaVersion: 1 as const,
      manifestHash: afterManifestHash,
      skills: [],
    };
    const beforeLockHash = hashPortableLock(beforeLock as unknown as PortableLockV1);
    const afterLockHash = hashPortableLock(afterLock as unknown as PortableLockV1);
    if (!beforeLockHash.ok || !afterLockHash.ok) throw new Error('invalid lock fixtures');
    const selectedObserved: AcquisitionObservedStateSnapshotV1 = {
      ...observed,
      artifact: {
        mode: 'selected',
        pair: {
          file: {
            token: null,
            path: '/fixture/manifest',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfile: {
            token: null,
            path: '/fixture/lock',
            portability: 'machine-bound',
            portableToken: null,
          },
          lockfileSource: 'explicit',
        },
        manifest: {
          revision: presentArtifactRevision(
            'manifest',
            'manifest:/fixture',
            '/fixture/manifest',
            `sha256:${HEX.a}`,
            beforeManifestHash,
          ),
          value: beforeManifest,
        },
        lock: {
          revision: presentArtifactRevision(
            'lock',
            'lock:/fixture',
            '/fixture/lock',
            beforeLockHash.value,
            beforeLockHash.value,
          ),
          value: beforeLock as unknown as PortableLockV1,
        },
      },
    };
    const savingInput: AcquisitionUninstallPlanRequestV1 = {
      ...input,
      artifactTransition: {
        initial: {
          manifest: {
            kind: 'manifest' as const,
            location: { kind: 'machine-bound' as const, path: '/fixture/manifest' },
            shape: 'canonical' as const,
            version: 1 as const,
            byteHash: `sha256:${HEX.a}` as const,
            semanticHash: beforeManifestHash as `sha256:${string}`,
            value: {
              version: 1 as const,
              defaults: null,
              registry: null,
              skills: beforeManifest.skills,
            },
          },
          lock: {
            kind: 'lock' as const,
            location: { kind: 'machine-bound' as const, path: '/fixture/lock' },
            version: 1 as const,
            canonicalHash: beforeLockHash.value as `sha256:${string}`,
            value: beforeLock,
          },
        },
        groups: [
          {
            groupIdentity: {
              domain: 'skillsmith.operation-group-identity' as const,
              schemaVersion: 1 as const,
              command: 'uninstall' as const,
              skill: 'alpha',
              source: null,
              scope: 'user' as const,
              target: 'alpha',
            },
            manifestAfter: {
              kind: 'manifest' as const,
              location: { kind: 'machine-bound' as const, path: '/fixture/manifest' },
              shape: 'canonical' as const,
              version: 1 as const,
              byteHash: `sha256:${HEX.b}` as const,
              semanticHash: afterManifestHash as `sha256:${string}`,
              value: { version: 1 as const, defaults: null, registry: null, skills: [] },
            },
            lockAfter: {
              kind: 'lock' as const,
              location: { kind: 'machine-bound' as const, path: '/fixture/lock' },
              version: 1 as const,
              canonicalHash: afterLockHash.value as `sha256:${string}`,
              value: afterLock,
            },
          },
        ],
      } as unknown as NonNullable<AcquisitionUninstallPlanRequestV1['artifactTransition']>,
    };
    const saving = createAcquisitionPlan(savingInput, selectedObserved);
    expect(saving.ok).toBeTrue();
    if (!saving.ok) throw new Error(saving.error.message);
    expect(saving.value.plan.operations.map(({ kind }) => kind)).toEqual([
      'remove',
      'write-manifest',
      'write-lock',
    ]);
    const [removal, manifest, lock] = saving.value.plan.operations;
    if (removal === undefined || manifest === undefined || lock === undefined) {
      throw new Error('missing uninstall artifact chain');
    }
    expect(manifest.dependencyMetadata.operationIds).toEqual([removal.operationId]);
    expect(lock.dependencyMetadata.operationIds).toEqual([manifest.operationId]);

    const artifactOnly = createAcquisitionPlan(savingInput, {
      ...selectedObserved,
      ledger: { revision: revision('ledger', 'ledger:user', HEX.c), value: null },
      live: [
        {
          revision: revision('live', 'live-resource-alpha', HEX.d, '/fixture/live/alpha'),
          value: null,
        },
      ],
    });
    expect(artifactOnly.ok).toBeTrue();
    if (!artifactOnly.ok) throw new Error(artifactOnly.error.message);
    expect(artifactOnly.value.plan.operations.map(({ kind }) => kind)).toEqual([
      'write-manifest',
      'write-lock',
    ]);
  });

  test('fails closed for incoherent live, store, and ledger components supplied directly', () => {
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
      contentRevision: `sha256:${HEX.a}`,
    };
    expect(
      createAcquisitionPlan(
        request(),
        snapshot(HEX.a, HEX.b, {
          live: [
            {
              revision: revision('live', 'live-resource-alpha', HEX.d, '/fixture/live/alpha'),
              value: live,
            },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { message: 'acquisition planning: live resource observation is incoherent' },
    });

    expect(
      createAcquisitionPlan(
        request(),
        snapshot(HEX.a, HEX.b, {
          store: [
            {
              revision: storeState('store-resource-alpha', 'alpha').revision,
              value: null,
            },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { message: 'acquisition planning: store resource observation is incoherent' },
    });

    expect(
      createAcquisitionPlan(
        request(),
        snapshot(HEX.a, HEX.b, {
          ledger: {
            revision: presentLedgerRevision(HEX.c),
            value: null,
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { message: 'acquisition planning: ledger observation is incoherent' },
    });
  });

  test('omits an install operation when live, store, ledger, source, and representation match', () => {
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
      contentRevision: `sha256:${HEX.a}`,
    };
    const pair: LedgerPairV1Dto = {
      placementPath: live.path,
      mode: 'pinned',
      dev: null,
      pinned: {
        storePath: '/fixture/store/alpha',
        rev: 'c'.repeat(40),
        gitSha: 'c'.repeat(40),
        dirty: false,
        contentHash: `sha256:${HEX.a}`,
        snapshotAt: '2026-07-16T00:00:00.000Z',
        verify: 'passed',
        placement: 'copy',
      },
      origin: {
        source: 'example.test/fixture/repo//skills/alpha',
        host: 'example.test',
        repo: 'fixture/repo',
        skillPath: 'skills/alpha',
        refRequested: null,
        refResolved: 'c'.repeat(40),
        pin: true,
        installedAt: '2026-07-16T00:00:00.000Z',
      },
      journal: null,
    };
    const observed = snapshot(HEX.a, HEX.b, {
      live: [
        {
          revision: presentLiveRevision('live-resource-alpha', live, HEX.d),
          value: live,
        },
      ],
      ledger: {
        revision: presentLedgerRevision(HEX.c),
        value: ledgerWithAlphaPair(pair),
      },
    });

    const result = createAcquisitionPlan(request(), observed);

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toEqual([]);
    expect(result.value.plan.diagnostics).toEqual([]);
    expect(result.value.expectedRevisions).toHaveLength(7);
  });

  test('coalesces duplicate operations while retaining distinct occurrence content preconditions', () => {
    const first = request();
    const firstIntent = first.intents[0];
    if (firstIntent === undefined) throw new Error('missing fixture intent');
    const secondContent = createContentObservationIdentityV1({
      ...firstIntent.sourceContent,
      resourceId: 'materialized-source-alpha-occurrence-1',
      targetIdentity: '/fixture/fetch/occurrence-1/alpha',
    });
    const result = createAcquisitionPlan(
      {
        ...first,
        artifactTransition: artifactTransitionForInstall(first, ['codex']),
        intents: [
          firstIntent,
          {
            ...firstIntent,
            sourceContent: secondContent,
            sourcePreconditionId: createContentObservationPreconditionIdV1(secondContent),
          },
        ],
      },
      snapshot(),
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value.plan.operations).toHaveLength(3);
    const placement = result.value.plan.operations.find(({ pairId }) => pairId !== null);
    expect(placement?.preconditionIds).toContain(firstIntent.sourcePreconditionId);
    expect(placement?.preconditionIds).toContain(
      createContentObservationPreconditionIdV1(secondContent),
    );
    expect(firstIntent.sourcePreconditionId).not.toBe(
      createContentObservationPreconditionIdV1(secondContent),
    );
  });

  test('builds zero-I/O diagnostic-only edge plans without executable authority', () => {
    const planned = createAcquisitionDiagnosticPlan({
      schemaVersion: 1,
      command: 'install',
      selection: {
        source: 'explicit-targets',
        skills: [],
        tools: [],
        scopes: ['user'],
      },
      batchPolicy: 'fail-fast',
      diagnostics: [],
    });
    expect(planned.ok).toBeTrue();
    if (!planned.ok) return;
    expect(planned.value.operations).toEqual([]);
    expect(planned.value.checks).toEqual([]);
    expect(planned.value.diagnostics).toEqual([]);
    const withExecutionAuthority = createAcquisitionDiagnosticPlan({
      schemaVersion: 1,
      command: 'install',
      selection: { source: 'explicit-targets', skills: [], tools: [], scopes: ['user'] },
      batchPolicy: 'fail-fast',
      diagnostics: [],
      artifactTransition: {} as never,
    });
    expect(withExecutionAuthority.ok).toBeFalse();
  });
});

describe('acquisition compatibility planning extraction', () => {
  test('preserves deterministic install operation and diagnostic assembly without mutating inputs', () => {
    const requested: Parameters<typeof createInstallPlanning>[0] = {
      sources: ['example.test/fixture/repo', 'missing-source'],
      tools: ['codex'],
      explicitTools: true,
      scope: 'user' as const,
      explicitScope: true,
      ref: null,
      pin: true,
      direct: false,
      force: false,
      verify: 'static' as const,
      deep: false,
    };
    const results = [
      {
        source: 'example.test/fixture/repo',
        skill: 'alpha',
        tool: 'codex' as const,
        scope: 'user' as const,
        placementPath: '/fixture/live/alpha',
        action: 'installed' as const,
        reason: null,
        placement: 'copy' as const,
        store: null,
        origin: null,
        verify: null,
        candidates: null,
      },
      {
        source: 'missing-source',
        skill: null,
        tool: null,
        scope: 'user' as const,
        placementPath: null,
        action: 'refused' as const,
        reason: 'source was refused',
        placement: null,
        store: null,
        origin: null,
        verify: null,
        candidates: null,
      },
    ];
    const requestedBefore = structuredClone(requested);
    const resultsBefore = structuredClone(results);
    const first = createInstallPlanning(requested, results, false);
    const second = createInstallPlanning(requested, results, false);
    expect(first.plan).toEqual(second.plan);
    expect(requested).toEqual(requestedBefore);
    expect(results).toEqual(resultsBefore);
    expect(first.plan.operations).toHaveLength(1);
    expect(first.plan.diagnostics).toHaveLength(1);
    expect(first.operationResults.get(first.plan.operations[0]?.operationId ?? '')).toBe(
      results[0],
    );
    expect(first.plan.operations[0]?.operationId).toMatch(/^operation:v1:[0-9a-f]{64}$/u);
    expect(first.plan.diagnostics[0]?.diagnosticId).toMatch(/^diagnostic:v1:[0-9a-f]{64}$/u);
  });

  test('preserves deterministic uninstall before images, IDs, and diagnostic assembly', () => {
    const requested: Parameters<typeof createUninstallPlanning>[0] = {
      targets: ['alpha', 'missing'],
      tools: ['codex'],
      explicitTools: true,
      scope: 'project' as const,
      allScopes: false,
      force: false,
    };
    const results = [
      {
        skill: 'alpha',
        tool: 'codex' as const,
        scope: 'project' as const,
        placementPath: '/fixture/project/.agents/skills/alpha',
        action: 'removed' as const,
        reason: null,
        before: {
          mode: 'dev' as const,
          placement: 'symlink' as const,
          storePath: null,
          symlinkTarget: '/fixture/source/alpha',
        },
        storeRetained: null,
        backupKept: null,
      },
      {
        skill: 'missing',
        tool: null,
        scope: null,
        placementPath: null,
        action: 'noop' as const,
        reason: 'not installed',
        before: null,
        storeRetained: null,
        backupKept: null,
      },
    ];
    const first = createUninstallPlanning(requested, results, '/fixture/project');
    const second = createUninstallPlanning(requested, results, '/fixture/project');
    expect(first.plan).toEqual(second.plan);
    expect(first.plan.operations).toHaveLength(1);
    expect(first.plan.diagnostics).toHaveLength(1);
    expect(first.plan.operations[0]).toMatchObject({
      kind: 'remove',
      before: {
        kind: 'placement',
        classification: 'dev',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: '/fixture/source/alpha' },
        resource: {
          projectRoot: { kind: 'machine-bound', path: '/fixture/project' },
        },
      },
      after: { kind: 'absent' },
    });
    expect(first.operationResults.get(first.plan.operations[0]?.operationId ?? '')).toBe(
      results[0],
    );
    expect(first.plan.operations[0]?.operationId).toMatch(/^operation:v1:[0-9a-f]{64}$/u);
  });
});
