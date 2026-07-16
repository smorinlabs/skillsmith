import { describe, expect, test } from 'bun:test';
import {
  type AcquisitionInstallPlanRequestV1,
  createAcquisitionDiagnosticPlan,
  createAcquisitionPlan,
  createInstallPlanning,
  createUninstallPlanning,
} from '../../src/acquire/plan.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../../src/artifacts/ledger-types.ts';
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
  readonly live?: ObservedStateSnapshotV1['live'];
  readonly store?: ObservedStateSnapshotV1['store'];
  readonly ledger?: ObservedStateSnapshotV1['ledger'];
}

const snapshot = (
  snapshotHex = HEX.a,
  capabilityHex = HEX.b,
  overrides: SnapshotOverrides = {},
): ObservedStateSnapshotV1 =>
  ({
    schemaVersion: 1,
    snapshotId: `snapshot:v1:${snapshotHex}`,
    project: { revision: revision('project', 'project:/fixture', HEX.a), value: {} },
    manifest: { revision: revision('manifest', 'manifest:/fixture', HEX.a), value: null },
    lock: { revision: revision('lock', 'lock:/fixture', HEX.b), value: null },
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
  }) as unknown as ObservedStateSnapshotV1;

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

const expectDeepFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const child of Object.values(value)) expectDeepFrozen(child, seen);
};

describe('createAcquisitionPlan', () => {
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
      ] as ObservedStateSnapshotV1['live'],
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
    expect(result.value.plan.operations).toHaveLength(1);
    expect(result.value.plan.operations[0]?.preconditionIds).toContain(
      firstIntent.sourcePreconditionId,
    );
    expect(result.value.plan.operations[0]?.preconditionIds).toContain(
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
