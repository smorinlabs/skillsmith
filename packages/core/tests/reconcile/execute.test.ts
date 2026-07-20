import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type {
  ResourcePreconditionV1,
  SelectionPreconditionV1,
} from '../../src/artifacts/plan-types.ts';
import type { PreparedExecutionBinding } from '../../src/execution/types.ts';
import { emptyLedgerModel, withLedgerPairAt } from '../../src/place/ledger.ts';
import { contentHashOf } from '../../src/place/store.ts';
import type { PairRecord, SwapRequest } from '../../src/place/types.ts';
import {
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
} from '../../src/planning/create.ts';
import type {
  ExecutableOperation,
  OperationDigest,
  OperationImage,
  OperationPlan,
} from '../../src/planning/types.ts';
import {
  type ReconcileExecutionBindingFactoriesV1,
  type ReconcileExecutionGuardsV1,
  type ReconcileRuntimeExecutionAuthoritiesV1,
  createFreshReconcileExecutionPlanV1,
  createReconcileExecutionBindingsV1,
  createReconcileExecutionPreconditionsV1,
  createReconcileMoveScopeExecutionBindingV1,
  executeValidatedReconcilePlanV1,
} from '../../src/reconcile/execute.ts';
import { buildFixtureFleet, destroyFixtureFleet } from '../fixtures/place/fleet.ts';

const digest = (character: string): OperationDigest =>
  `sha256:${character.repeat(64)}` as OperationDigest;

const artifactDigest = (value: OperationDigest): ArtifactDigest => value as ArtifactDigest;

const source = (name: string) =>
  Object.freeze({
    kind: 'portable' as const,
    identity: Object.freeze({
      host: 'fixture.invalid',
      repository: 'acme/skills',
      path: `skills/${name}`,
    }),
    requestedRef: null,
    resolvedSha: 'a'.repeat(40),
    sourcePath: `skills/${name}`,
    contentHash: digest('a'),
  });

const liveResource = (name: string, scope: 'user' | 'project' = 'user') =>
  Object.freeze({
    kind: 'live' as const,
    skill: name,
    tool: 'codex' as const,
    scope,
    projectRoot:
      scope === 'project'
        ? Object.freeze({ kind: 'machine-bound' as const, path: '/fixture/project' })
        : null,
    location: Object.freeze({
      kind: 'machine-bound' as const,
      path: `/fixture/${scope}/skills/${name}`,
    }),
  });

const placementImage = (
  name: string,
  scope: 'user' | 'project' = 'user',
): Extract<OperationImage, { kind: 'placement' }> =>
  Object.freeze({
    kind: 'placement',
    resource: liveResource(name, scope),
    classification: 'pinned',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source: source(name),
    contentHash: digest('a'),
  });

const placementOperation = (
  kind:
    | 'install'
    | 'update'
    | 'remove'
    | 'repair'
    | 'move-scope'
    | 'link-dev'
    | 'promote'
    | 'adapt',
  name: string,
): ExecutableOperation => {
  const selectedScope = kind === 'move-scope' ? 'project' : 'user';
  const operationSource = source(name);
  const resource = liveResource(name, selectedScope);
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'apply',
    skill: name,
    source: operationSource,
    scope: selectedScope,
    target: null,
  });
  const pairId = createOperationPairId({
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId,
    tool: 'codex',
    resource,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId,
    kind,
    skill: name,
    source: operationSource,
    tool: 'codex',
    scope: selectedScope,
  });
  const before =
    kind === 'install'
      ? ({ kind: 'absent', resource } as const)
      : kind === 'move-scope'
        ? placementImage(name, 'user')
        : placementImage(name);
  const after =
    kind === 'remove'
      ? ({ kind: 'absent', resource } as const)
      : placementImage(name, selectedScope);
  return Object.freeze({
    operationId,
    groupId,
    pairId,
    kind,
    dependencyMetadata: Object.freeze({
      domain: 'skillsmith.operation-dependency' as const,
      schemaVersion: 1 as const,
      operationIds: Object.freeze([]),
    }),
    skill: name,
    source: operationSource,
    tool: 'codex' as const,
    scope: selectedScope,
    before,
    after,
    reason: Object.freeze({ code: `fixture-${kind}`, message: `Fixture ${kind}.` }),
    selectionSource: 'bounded-default' as const,
    preconditionIds: Object.freeze([]),
    requiredCheckIds: Object.freeze([]),
    reversibility: Object.freeze({
      kind: 'conditional' as const,
      retentionResourceIds: Object.freeze([pairId] as const),
    }),
    mutates: Object.freeze({ live: true, manifest: false, lock: false, ledger: true }),
    conflict: null,
  });
};

const artifactOperation = (
  kind: 'write-lock' | 'migrate-project-config' | 'migrate-ledger' | 'write-manifest',
): ExecutableOperation => {
  const path = kind === 'write-lock' ? '/fixture/skillsmith.lock' : '/fixture/skillsmith.toml';
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'apply',
    skill: null,
    source: null,
    scope: null,
    target: path,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind,
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  const location = Object.freeze({ kind: 'machine-bound' as const, path });
  const manifestValue = Object.freeze({
    version: 1 as const,
    defaults: null,
    registry: null,
    skills: Object.freeze([]),
  });
  const lockValue = Object.freeze({
    version: 1 as const,
    hashSchemaVersion: 1 as const,
    manifestHash: digest('b'),
    skills: Object.freeze([]),
  });
  let before: OperationImage;
  let after: OperationImage;
  if (kind === 'write-lock') {
    before = { kind: 'absent', resource: { kind: 'lock', location } };
    after = { kind: 'lock', location, version: 1, canonicalHash: digest('c'), value: lockValue };
  } else if (kind === 'migrate-ledger') {
    before = {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 1,
      byteHash: digest('d'),
      semanticHash: digest('e'),
    };
    after = {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 2,
      byteHash: digest('f'),
      semanticHash: digest('e'),
    };
  } else {
    before = {
      kind: 'manifest',
      location,
      shape: kind === 'migrate-project-config' ? 'legacy' : 'canonical',
      version: 1,
      byteHash: digest('1'),
      semanticHash: digest('2'),
      value: manifestValue,
    };
    after = {
      kind: 'manifest',
      location,
      shape: 'canonical',
      version: 1,
      byteHash: digest('3'),
      semanticHash: digest('2'),
      value: manifestValue,
    };
  }
  return Object.freeze({
    operationId,
    groupId,
    pairId: null,
    kind,
    dependencyMetadata: Object.freeze({
      domain: 'skillsmith.operation-dependency' as const,
      schemaVersion: 1 as const,
      operationIds: Object.freeze([]),
    }),
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before,
    after,
    reason: Object.freeze({ code: `fixture-${kind}`, message: `Fixture ${kind}.` }),
    selectionSource: 'bounded-default' as const,
    preconditionIds: Object.freeze([]),
    requiredCheckIds: Object.freeze([]),
    reversibility: Object.freeze({
      kind: 'none' as const,
      retentionResourceIds: Object.freeze([] as const),
    }),
    mutates: Object.freeze({
      live: false,
      manifest: kind === 'migrate-project-config' || kind === 'write-manifest',
      lock: kind === 'write-lock',
      ledger: kind === 'migrate-ledger',
    }),
    conflict: null,
  });
};

const rawPlan = (operations: readonly ExecutableOperation[]): OperationPlan<'apply'> =>
  Object.freeze({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'apply',
    selection: Object.freeze({
      source: 'bounded-default' as const,
      skills: Object.freeze(
        operations.flatMap(({ skill }) => (skill === null ? [] : [skill])).sort(),
      ),
      tools: Object.freeze(['codex'] as const),
      scopes: Object.freeze(['user'] as const),
    }),
    batchPolicy: 'fail-fast',
    operations: Object.freeze([...operations]),
    checks: Object.freeze([]),
    diagnostics: Object.freeze([]),
  });

const plan = (operations: readonly ExecutableOperation[]): OperationPlan<'apply'> =>
  createOperationPlan(rawPlan(operations));

const binding = (operation: ExecutableOperation): PreparedExecutionBinding =>
  Object.freeze({
    operationId: operation.operationId,
    groupId: operation.groupId,
    pairId: operation.pairId,
    unstartedForce: null,
    observeActualBefore: async () => operation.before,
    execute: async () => ({
      operationId: operation.operationId,
      outcome: 'succeeded' as const,
      actualBefore: operation.before,
      actualAfter: operation.after,
      force: null,
      error: null,
    }),
  });

const factories = (calls: string[] = []): ReconcileExecutionBindingFactoriesV1 => ({
  placement: (operation) => {
    calls.push(`placement:${operation.kind}`);
    return binding(operation);
  },
  artifact: (operation) => {
    calls.push(`artifact:${operation.kind}`);
    return binding(operation);
  },
  ledgerMigration: (operation) => {
    calls.push(`ledger-migration:${operation.kind}`);
    return binding(operation);
  },
  moveScope: (operation) => {
    calls.push(`move-scope:${operation.kind}`);
    return binding(operation);
  },
});

const guardId = (character: string) => `precondition:v1:${character.repeat(64)}`;

const operationWithGuards = (
  operation: ExecutableOperation,
  preconditionIds: readonly string[],
): ExecutableOperation =>
  Object.freeze({
    ...operation,
    preconditionIds: Object.freeze([...preconditionIds].sort()),
  });

const resourceForBefore = (operation: ExecutableOperation): ResourcePreconditionV1['resource'] => {
  const before = operation.before;
  if (before.kind === 'absent' || before.kind === 'placement') {
    return before.resource as unknown as ResourcePreconditionV1['resource'];
  }
  if (before.kind === 'manifest' || before.kind === 'opaque-manifest') {
    return { kind: 'manifest-bytes', location: before.location };
  }
  if (before.kind === 'lock') return { kind: 'lock', location: before.location };
  return { kind: 'ledger', projectRoot: before.projectRoot };
};

const resourceGuard = (
  operation: ExecutableOperation,
  preconditionId = guardId('1'),
): ResourcePreconditionV1 => {
  const before = operation.before;
  const byteHash = artifactDigest(before.kind === 'ledger' ? before.byteHash : digest('9'));
  return Object.freeze({
    preconditionId,
    resource: resourceForBefore(operation),
    expectedState: before.kind === 'absent' ? ('absent' as const) : ('present' as const),
    expectedHash: Object.freeze({
      domain: 'resource' as const,
      hashSchemaVersion: 1 as const,
      digest: byteHash,
    }),
    expectedRevision:
      before.kind === 'absent'
        ? null
        : Object.freeze({
            kind: before.kind === 'placement' ? ('resource' as const) : ('artifact-bytes' as const),
            digest: byteHash,
          }),
  });
};

const executionGuards = (
  resources: readonly ResourcePreconditionV1[],
  selections: readonly SelectionPreconditionV1[] = [],
): ReconcileExecutionGuardsV1 =>
  Object.freeze({
    resourcePreconditions: Object.freeze([...resources]),
    selectionPreconditions: Object.freeze([...selections]),
    capabilityPreconditions: Object.freeze([]),
  });

const executionAuthorities = (
  options: Readonly<{
    observeResource?: ReconcileRuntimeExecutionAuthoritiesV1['guards']['observeResource'];
    observeLegacyLedgerBytes?: ReconcileRuntimeExecutionAuthoritiesV1['guards']['observeLegacyLedgerBytes'];
    placementBinding?: (operation: ExecutableOperation) => PreparedExecutionBinding;
    ledgerBinding?: (operation: ExecutableOperation) => PreparedExecutionBinding;
    cleanupSources?: () => Promise<void>;
  }> = {},
): ReconcileRuntimeExecutionAuthoritiesV1 => ({
  placement: {
    bind: (operation) => options.placementBinding?.(operation) ?? binding(operation),
  },
  artifact: { bind: (operation) => binding(operation) },
  ledgerMigration: {
    bind: (operation) => options.ledgerBinding?.(operation) ?? binding(operation),
  },
  moveScope: {
    bind: (operation) => binding(operation),
  },
  guards: {
    observeResource: options.observeResource ?? (async (_guard, expected) => expected),
    observeSelection: async (_guard, expected) => expected,
    observeCapability: async (_guard, expected) => expected,
    observeLegacyLedgerBytes:
      options.observeLegacyLedgerBytes ?? (async (_operation, _guard, expected) => expected),
  },
  locks: Object.freeze([]),
  lockPort: {
    withFileLock: async (_path, operation) => operation(),
  },
  ...(options.cleanupSources === undefined ? {} : { cleanupSources: options.cleanupSources }),
});

describe('reconciliation execution binding dispatch', () => {
  test('binds each currently supported operation through its closed factory', () => {
    const supported = [
      ['install', placementOperation('install', 'install')],
      ['update', placementOperation('update', 'update')],
      ['remove', placementOperation('remove', 'remove')],
      ['repair', placementOperation('repair', 'repair')],
      ['write-lock', artifactOperation('write-lock')],
      ['migrate-project-config', artifactOperation('migrate-project-config')],
      ['migrate-ledger', artifactOperation('migrate-ledger')],
    ] as const;

    for (const [kind, operation] of supported) {
      const calls: string[] = [];
      const result = createReconcileExecutionBindingsV1(plan([operation]), factories(calls));
      expect(result.ok, kind).toBeTrue();
      if (!result.ok) continue;
      expect(
        result.value.map(({ operationId }) => operationId),
        kind,
      ).toEqual([operation.operationId]);
      expect(calls, kind).toEqual([
        `${kind === 'migrate-ledger' ? 'ledger-migration' : kind.startsWith('write-') || kind === 'migrate-project-config' ? 'artifact' : 'placement'}:${kind}`,
      ]);
      expect(Object.isFrozen(result.value), kind).toBeTrue();
    }
  });

  test('preserves exact approved operation order and one-to-one binding coverage', () => {
    const operations = [
      placementOperation('install', 'alpha'),
      placementOperation('update', 'beta'),
      placementOperation('repair', 'gamma'),
      placementOperation('remove', 'delta'),
    ];
    const calls: string[] = [];
    const approved = plan(operations);
    const result = createReconcileExecutionBindingsV1(approved, factories(calls));

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value.map(({ operationId }) => operationId)).toEqual(
      approved.operations.map(({ operationId }) => operationId),
    );
    expect(calls).toEqual(approved.operations.map(({ kind }) => `placement:${kind}`));
  });

  test('rejects a non-topological approved operation order before binding', () => {
    const prerequisite = placementOperation('install', 'alpha');
    const dependentSeed = placementOperation('update', 'beta');
    const dependent: ExecutableOperation = Object.freeze({
      ...dependentSeed,
      dependencyMetadata: Object.freeze({
        ...dependentSeed.dependencyMetadata,
        operationIds: Object.freeze([prerequisite.operationId]),
      }),
    });
    const calls: string[] = [];
    const result = createReconcileExecutionBindingsV1(
      rawPlan([dependent, prerequisite]),
      factories(calls),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'reconcile-execution-plan-invalid',
        message: 'reconciliation execution plan failed the exact apply-plan contract',
        operationId: null,
        operationKind: null,
      },
    });
    expect(calls).toEqual([]);
  });

  test('binds move-scope through the distinct cross-root transaction factory', () => {
    const operation = placementOperation('move-scope', 'alpha');
    const calls: string[] = [];
    const result = createReconcileExecutionBindingsV1(plan([operation]), factories(calls));

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value.map(({ operationId }) => operationId)).toEqual([operation.operationId]);
    expect(calls).toEqual(['move-scope:move-scope']);
  });

  test('fails closed for operation kinds outside reconciliation executor v1', () => {
    const unsupported = [
      placementOperation('link-dev', 'dev'),
      placementOperation('promote', 'promote'),
      placementOperation('adapt', 'adapt'),
      artifactOperation('write-manifest'),
    ];
    for (const operation of unsupported) {
      const calls: string[] = [];
      const result = createReconcileExecutionBindingsV1(plan([operation]), factories(calls));
      expect(result.ok, operation.kind).toBeFalse();
      if (result.ok) continue;
      expect(result.error.code, operation.kind).toBe('reconcile-execution-operation-unsupported');
      expect(result.error.operationKind, operation.kind).toBe(operation.kind);
      expect(calls, operation.kind).toEqual([]);
    }
  });

  test('rejects missing, malformed, duplicate, and mismatched bindings', () => {
    const first = placementOperation('install', 'alpha');
    const second = placementOperation('update', 'beta');
    const cases = [
      {
        code: 'reconcile-execution-binding-missing',
        factories: { ...factories(), placement: () => null },
      },
      {
        code: 'reconcile-execution-binding-shape',
        factories: {
          ...factories(),
          placement: () => ({ ...binding(first), unexpected: true }) as PreparedExecutionBinding,
        },
      },
      {
        code: 'reconcile-execution-binding-identity',
        factories: {
          ...factories(),
          placement: (operation: ExecutableOperation) => ({
            ...binding(operation),
            groupId: 'group:v1:mismatch',
          }),
        },
      },
    ] as const;
    for (const selected of cases) {
      const result = createReconcileExecutionBindingsV1(plan([first]), selected.factories);
      expect(result.ok, selected.code).toBeFalse();
      if (!result.ok) expect(result.error.code).toBe(selected.code);
    }

    let invoked = 0;
    const duplicate = createReconcileExecutionBindingsV1(plan([first, second]), {
      ...factories(),
      placement: () => {
        invoked += 1;
        return binding(first);
      },
    });
    expect(duplicate.ok).toBeFalse();
    if (!duplicate.ok) expect(duplicate.error.code).toBe('reconcile-execution-binding-duplicate');
    expect(invoked).toBe(2);
  });

  test('sanitizes factory throws and rejects duplicate approved operation IDs', () => {
    const operation = placementOperation('install', 'alpha');
    const thrown = createReconcileExecutionBindingsV1(plan([operation]), {
      ...factories(),
      placement: () => {
        throw new Error('private nested failure');
      },
    });
    expect(thrown).toEqual({
      ok: false,
      error: {
        code: 'reconcile-execution-binding-factory',
        message: `operation ${operation.operationId} binding factory failed`,
        operationId: operation.operationId,
        operationKind: 'install',
      },
    });
    expect(JSON.stringify(thrown)).not.toContain('private nested failure');

    const duplicated = createReconcileExecutionBindingsV1(
      rawPlan([operation, operation]),
      factories(),
    );
    expect(duplicated.ok).toBeFalse();
    if (!duplicated.ok) {
      expect(duplicated.error.code).toBe('reconcile-execution-operation-duplicate');
    }
  });

  test('owns and validates the complete apply plan before reading physical authorities', () => {
    const malformed = {
      domain: 'not-an-operation-plan',
      schemaVersion: 999,
      command: 'dev',
      selection: null,
      batchPolicy: 'fail-fast',
      operations: [
        {
          operationId: 'x',
          groupId: 'g',
          pairId: 'p',
          kind: 'install',
          dependencyMetadata: { operationIds: [] },
        },
      ],
      checks: 'private-check-material',
      diagnostics: 'private-diagnostic-material',
    } as unknown as OperationPlan<'apply'>;
    const calls: string[] = [];
    const rejected = createReconcileExecutionBindingsV1(malformed, factories(calls));
    expect(rejected).toEqual({
      ok: false,
      error: {
        code: 'reconcile-execution-plan-invalid',
        message: 'reconciliation execution plan failed the exact apply-plan contract',
        operationId: null,
        operationKind: null,
      },
    });
    expect(JSON.stringify(rejected)).not.toMatch(/private|\bx\b|\bg\b|\bp\b/u);
    expect(calls).toEqual([]);

    let getterRead = false;
    const accessorPlan = Object.defineProperty({}, 'operations', {
      enumerable: true,
      get: () => {
        getterRead = true;
        throw new Error('private operation getter material');
      },
    }) as OperationPlan<'apply'>;
    const accessorResult = createReconcileExecutionBindingsV1(accessorPlan, factories(calls));
    expect(accessorResult).toMatchObject({
      ok: false,
      error: { code: 'reconcile-execution-plan-invalid' },
    });
    expect(getterRead).toBeFalse();
    expect(JSON.stringify(accessorResult)).not.toContain('private operation getter material');
  });

  test('snapshots and freezes binding identity, callbacks, and force data', async () => {
    const operation = placementOperation('install', 'alpha');
    const force = {
      requested: false,
      applied: false,
      conflictType: null,
      target: null,
      normalBehavior: null,
      forcedBehavior: null,
      backup: null,
    } as const;
    const originalResult = {
      operationId: operation.operationId,
      outcome: 'succeeded' as const,
      actualBefore: operation.before,
      actualAfter: operation.after,
      force,
      error: null,
    };
    const candidate = {
      operationId: operation.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      unstartedForce: force,
      observeActualBefore: async () => operation.before,
      execute: async () => originalResult,
    };
    const result = createReconcileExecutionBindingsV1(plan([operation]), {
      ...factories(),
      placement: () => candidate,
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    const owned = result.value[0];
    if (owned === undefined) throw new Error('owned binding is absent');
    candidate.operationId = 'retargeted-operation';
    candidate.execute = async () => ({ ...originalResult, operationId: 'retargeted-operation' });
    (force as { requested: boolean }).requested = true;

    expect(owned.operationId).toBe(operation.operationId);
    expect(owned.unstartedForce).toMatchObject({ requested: false, applied: false });
    expect(Object.isFrozen(owned)).toBeTrue();
    expect(Object.isFrozen(owned.unstartedForce)).toBeTrue();
    expect(
      await owned.execute({
        operationId: operation.operationId,
        groupId: operation.groupId,
        pairId: operation.pairId,
        actualBefore: operation.before,
        unstartedForce: owned.unstartedForce,
        execute: async () => originalResult,
      }),
    ).toBe(originalResult);
  });

  test('rejects proxy/accessor bindings and preclassifies unsupported mixes without factories', () => {
    const operation = placementOperation('install', 'alpha');
    const proxy = new Proxy(binding(operation), {});
    const proxied = createReconcileExecutionBindingsV1(plan([operation]), {
      ...factories(),
      placement: () => proxy,
    });
    expect(proxied).toMatchObject({
      ok: false,
      error: { code: 'reconcile-execution-binding-shape' },
    });

    const accessor = { ...binding(operation) } as Record<string, unknown>;
    Object.defineProperty(accessor, 'operationId', {
      enumerable: true,
      get: () => operation.operationId,
    });
    const accessorResult = createReconcileExecutionBindingsV1(plan([operation]), {
      ...factories(),
      placement: () => accessor as unknown as PreparedExecutionBinding,
    });
    expect(accessorResult).toMatchObject({
      ok: false,
      error: { code: 'reconcile-execution-binding-shape' },
    });

    const calls: string[] = [];
    const mixed = createReconcileExecutionBindingsV1(
      plan([placementOperation('install', 'supported'), placementOperation('adapt', 'blocked')]),
      factories(calls),
    );
    expect(mixed).toMatchObject({
      ok: false,
      error: { code: 'reconcile-execution-operation-unsupported' },
    });
    expect(calls).toEqual([]);
  });

  test('rejects symbol-bearing, subclassed, and non-enumerable plan arrays', () => {
    const variants: unknown[][] = [];
    const symbolBearing: unknown[] = [];
    Object.defineProperty(symbolBearing, Symbol('hidden-authority'), {
      enumerable: true,
      value: 'private',
    });
    variants.push(symbolBearing);

    class ExoticOperations extends Array<unknown> {}
    variants.push(new ExoticOperations());

    const hiddenIndex: unknown[] = ['hidden'];
    Object.defineProperty(hiddenIndex, '0', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: 'hidden',
    });
    variants.push(hiddenIndex);

    for (const operations of variants) {
      const candidate = {
        ...rawPlan([]),
        operations,
      } as unknown as OperationPlan<'apply'>;
      expect(createReconcileExecutionBindingsV1(candidate, factories())).toMatchObject({
        ok: false,
        error: { code: 'reconcile-execution-plan-invalid' },
      });
    }
  });
});

describe('validated reconciliation coordinator execution', () => {
  test('derives fresh continue-on-error by changing only the approved scheduler policy', () => {
    const approved = plan([
      placementOperation('install', 'alpha'),
      placementOperation('update', 'beta'),
    ]);
    const before = JSON.stringify(approved);
    const derived = createFreshReconcileExecutionPlanV1(approved, true);
    expect(derived.ok).toBeTrue();
    if (!derived.ok) return;
    expect(derived.value.batchPolicy).toBe('continue-on-error');
    expect(derived.value.operations).toEqual(approved.operations);
    expect({ ...derived.value, batchPolicy: approved.batchPolicy }).toEqual(approved);
    expect(JSON.stringify(approved)).toBe(before);

    const failFast = createFreshReconcileExecutionPlanV1(derived.value, false);
    expect(failFast.ok).toBeTrue();
    if (!failFast.ok) return;
    expect(failFast.value.batchPolicy).toBe('fail-fast');
    expect(failFast.value.operations.map(({ operationId }) => operationId)).toEqual(
      approved.operations.map(({ operationId }) => operationId),
    );
  });

  test('executes one exact plan through guard validation and the shared coordinator', async () => {
    const seed = placementOperation('install', 'alpha');
    const guard = resourceGuard(seed);
    const operation = operationWithGuards(seed, [guard.preconditionId]);
    let observedBefore = 0;
    let executed = 0;
    let cleaned = 0;
    const result = await executeValidatedReconcilePlanV1({
      plan: plan([operation]),
      guards: executionGuards([guard]),
      authorities: executionAuthorities({
        placementBinding: (selected) => ({
          ...binding(selected),
          observeActualBefore: async () => {
            observedBefore += 1;
            return selected.before;
          },
          execute: async () => {
            executed += 1;
            return {
              operationId: selected.operationId,
              outcome: 'succeeded',
              actualBefore: selected.before,
              actualAfter: selected.after,
              force: null,
              error: null,
            };
          },
        }),
        cleanupSources: async () => {
          cleaned += 1;
        },
      }),
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value).toMatchObject([
      { operationId: operation.operationId, outcome: 'succeeded' },
    ]);
    expect({ observedBefore, executed, cleaned }).toEqual({
      observedBefore: 1,
      executed: 1,
      cleaned: 1,
    });
  });

  test('rejects stale guards before actual-before binding or physical execution', async () => {
    const seed = placementOperation('update', 'alpha');
    const guard = resourceGuard(seed);
    const operation = operationWithGuards(seed, [guard.preconditionId]);
    let observedBefore = 0;
    let executed = 0;
    let cleaned = 0;
    let bound = 0;
    const result = await executeValidatedReconcilePlanV1({
      plan: plan([operation]),
      guards: executionGuards([guard]),
      authorities: executionAuthorities({
        observeResource: async (_selected, expected) => ({
          ...(expected as Record<string, unknown>),
          expectedState: 'absent',
        }),
        placementBinding: (selected) => {
          bound += 1;
          return {
            ...binding(selected),
            observeActualBefore: async () => {
              observedBefore += 1;
              return selected.before;
            },
            execute: async () => {
              executed += 1;
              return (await binding(selected).execute({
                operationId: selected.operationId,
                groupId: selected.groupId,
                pairId: selected.pairId,
                actualBefore: selected.before,
                unstartedForce: null,
                execute: async () => {
                  throw new Error('unused');
                },
              })) as never;
            },
          };
        },
        cleanupSources: async () => {
          cleaned += 1;
        },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'reconcile-execution-stale' },
    });
    expect({ bound, observedBefore, executed, cleaned }).toEqual({
      bound: 0,
      observedBefore: 0,
      executed: 0,
      cleaned: 1,
    });
  });

  test('routes only an exact legacy migration schema guard to a real ledger-byte observer', async () => {
    const seed = artifactOperation('migrate-ledger');
    if (seed.before.kind !== 'ledger') throw new Error('migration fixture is invalid');
    const schemaGuard: ResourcePreconditionV1 = Object.freeze({
      preconditionId: guardId('2'),
      resource: Object.freeze({ kind: 'ledger-schema' as const, projectRoot: null }),
      expectedState: 'present',
      expectedHash: Object.freeze({
        domain: 'resource' as const,
        hashSchemaVersion: 1 as const,
        digest: artifactDigest(seed.before.byteHash),
      }),
      expectedRevision: Object.freeze({
        kind: 'artifact-bytes' as const,
        digest: artifactDigest(seed.before.byteHash),
      }),
    });
    const operation = operationWithGuards(seed, [schemaGuard.preconditionId]);
    const originalPlan = plan([operation]);
    const originalPlanBytes = JSON.stringify(originalPlan);
    const originalGuardBytes = JSON.stringify(schemaGuard);
    let normalResourceReads = 0;
    let legacyByteReads = 0;
    const result = await executeValidatedReconcilePlanV1({
      plan: originalPlan,
      guards: executionGuards([schemaGuard]),
      authorities: executionAuthorities({
        observeResource: async (_guard, expected) => {
          normalResourceReads += 1;
          return expected;
        },
        observeLegacyLedgerBytes: async (selected, selectedGuard, expected) => {
          legacyByteReads += 1;
          expect(selected.operationId).toBe(operation.operationId);
          expect(selectedGuard.preconditionId).toBe(schemaGuard.preconditionId);
          return expected;
        },
      }),
    });

    expect(result.ok).toBeTrue();
    expect({ normalResourceReads, legacyByteReads }).toEqual({
      normalResourceReads: 0,
      legacyByteReads: 2,
    });
    expect(JSON.stringify(originalPlan)).toBe(originalPlanBytes);
    expect(JSON.stringify(schemaGuard)).toBe(originalGuardBytes);
  });

  test('prefers the additive physical ledger guard over the legacy alias', async () => {
    const seed = artifactOperation('migrate-ledger');
    if (seed.before.kind !== 'ledger') throw new Error('migration fixture is invalid');
    const schemaGuard: ResourcePreconditionV1 = Object.freeze({
      ...resourceGuard(seed, guardId('3')),
      resource: Object.freeze({ kind: 'ledger-schema' as const, projectRoot: null }),
    });
    const ledgerGuard = resourceGuard(seed, guardId('4'));
    const operation = operationWithGuards(seed, [
      schemaGuard.preconditionId,
      ledgerGuard.preconditionId,
    ]);
    let normalResourceReads = 0;
    let legacyByteReads = 0;
    const result = await executeValidatedReconcilePlanV1({
      plan: plan([operation]),
      guards: executionGuards([schemaGuard, ledgerGuard]),
      authorities: executionAuthorities({
        observeResource: async (_guard, expected) => {
          normalResourceReads += 1;
          return expected;
        },
        observeLegacyLedgerBytes: async (_operation, _guard, expected) => {
          legacyByteReads += 1;
          return expected;
        },
      }),
    });

    expect(result.ok).toBeTrue();
    expect({ normalResourceReads, legacyByteReads }).toEqual({
      normalResourceReads: 4,
      legacyByteReads: 0,
    });
  });

  test('does not let a selection guard substitute for same-resource coverage', () => {
    const seed = placementOperation('install', 'alpha');
    const selection: SelectionPreconditionV1 = Object.freeze({
      preconditionId: guardId('5'),
      domain: 'selection-set',
      hashSchemaVersion: 1,
      expectedHash: artifactDigest(digest('5')),
      selectionSource: 'bounded-default',
      skills: Object.freeze(['alpha']) as unknown as string[],
      tools: Object.freeze(['codex']) as unknown as SelectionPreconditionV1['tools'],
      scopes: Object.freeze(['user']) as unknown as SelectionPreconditionV1['scopes'],
      members: Object.freeze([]) as unknown as SelectionPreconditionV1['members'],
    });
    const operation = operationWithGuards(seed, [selection.preconditionId]);
    const result = createReconcileExecutionPreconditionsV1(
      plan([operation]),
      executionGuards([], [selection]),
      executionAuthorities().guards,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'reconcile-execution-guards-invalid' },
    });
  });

  test('owns the direct precondition-helper plan before reading accessors', () => {
    let getterRead = false;
    const hostile = Object.defineProperty({}, 'operations', {
      enumerable: true,
      get: () => {
        getterRead = true;
        throw new Error('private guard-plan getter');
      },
    }) as OperationPlan<'apply'>;
    const result = createReconcileExecutionPreconditionsV1(
      hostile,
      executionGuards([]),
      executionAuthorities().guards,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'reconcile-execution-guards-invalid' },
    });
    expect(getterRead).toBeFalse();
    expect(JSON.stringify(result)).not.toContain('private guard-plan getter');
  });

  test('exact-decodes the guard container and every nested artifact-guard shape', () => {
    const seed = placementOperation('install', 'alpha');
    const guard = resourceGuard(seed);
    const operation = operationWithGuards(seed, [guard.preconditionId]);
    const valid = executionGuards([guard]);
    const nestedResource = {
      ...guard,
      resource: { ...guard.resource, extra: 'private' },
    };
    const candidates = [
      { ...valid, hiddenPreconditions: [] },
      executionGuards([nestedResource as unknown as ResourcePreconditionV1]),
      {
        ...valid,
        selectionPreconditions: [
          {
            preconditionId: guardId('5'),
            domain: 'selection-set',
            hashSchemaVersion: 1,
            expectedHash: artifactDigest(digest('5')),
            selectionSource: 'bounded-default',
            skills: ['alpha'],
            tools: ['not-a-tool'],
            scopes: ['user'],
            members: [],
          },
        ],
      },
    ];
    let observations = 0;
    for (const candidate of candidates) {
      const result = createReconcileExecutionPreconditionsV1(
        plan([operation]),
        candidate as unknown as ReconcileExecutionGuardsV1,
        executionAuthorities({
          observeResource: async (_selected, expected) => {
            observations += 1;
            return expected;
          },
        }).guards,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'reconcile-execution-guards-invalid' },
      });
    }
    expect(observations).toBe(0);
  });

  test('sanitizes move authority failure and preserves cancellation', async () => {
    const operation = placementOperation('move-scope', 'alpha') as ExecutableOperation & {
      readonly kind: 'move-scope';
    };
    const validated = {
      operationId: operation.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      actualBefore: operation.before,
      unstartedForce: null,
      execute: async () => {
        throw new Error('unused');
      },
    };
    const hostileProxy = new Proxy(
      {},
      {
        has: () => {
          throw new Error('private proxy has trap');
        },
        getOwnPropertyDescriptor: () => {
          throw new Error('private proxy descriptor trap');
        },
      },
    );
    for (const [thrown, expected, errorCode] of [
      [new Error('private move failure material'), 'failed', 'reconcile-move-scope-failed'],
      [
        Object.freeze({ code: 'cancelled', detail: 'private cancellation material' }),
        'cancelled',
        null,
      ],
      [
        Object.freeze({ code: 'EACCES', detail: 'private permission material' }),
        'failed',
        'permission-denied',
      ],
      [hostileProxy, 'failed', 'reconcile-move-scope-failed'],
    ] as const) {
      const prepared = createReconcileMoveScopeExecutionBindingV1(operation, {
        observeActualBefore: async () => operation.before,
        createRequest: async () => {
          throw thrown;
        },
      });
      const result = await prepared.execute(validated);
      expect(result.outcome).toBe(expected);
      if (result.outcome === 'failed') {
        if (errorCode === null)
          throw new Error('failed fixture is missing its expected error code');
        expect(result.error.code).toBe(errorCode);
      }
      expect(JSON.stringify(result)).not.toContain('private');
      expect(result.actualAfter).toEqual(operation.before);
    }
  });

  test('reports a post-commit move-scope cleanup fault with the durable after image', async () => {
    const fixture = await buildFixtureFleet();
    try {
      const sourcePath = join(fixture.home, '.codex', 'skills', 'alpha');
      const destinationPath = join(fixture.projectReal, '.codex', 'skills', 'alpha');
      const storePath = join(fixture.data, 'move-scope-store', 'alpha');
      await mkdir(dirname(sourcePath), { recursive: true });
      await mkdir(dirname(destinationPath), { recursive: true });
      await mkdir(dirname(storePath), { recursive: true });
      await fixture.env.copyTree(fixture.alphaSrc, storePath);
      await fixture.env.copyTree(storePath, sourcePath);
      const hashed = await contentHashOf(fixture.env, storePath);
      if (!hashed.ok) throw new Error(JSON.stringify(hashed.error));
      const contentHash = hashed.value as OperationDigest;
      const operationSource = Object.freeze({
        kind: 'portable' as const,
        identity: Object.freeze({
          host: 'fixture.invalid',
          repository: 'acme/skills',
          path: 'skills/alpha',
        }),
        requestedRef: null,
        resolvedSha: 'a'.repeat(40),
        sourcePath: 'skills/alpha',
        contentHash,
      });
      const before = Object.freeze({
        kind: 'placement' as const,
        resource: Object.freeze({
          kind: 'live' as const,
          skill: 'alpha',
          tool: 'codex' as const,
          scope: 'user' as const,
          projectRoot: null,
          location: Object.freeze({ kind: 'machine-bound' as const, path: sourcePath }),
        }),
        classification: 'pinned' as const,
        representation: 'copy' as const,
        linkTarget: null,
        dangling: false,
        source: operationSource,
        contentHash,
      });
      const after = Object.freeze({
        ...before,
        resource: Object.freeze({
          ...before.resource,
          scope: 'project' as const,
          projectRoot: Object.freeze({
            kind: 'machine-bound' as const,
            path: fixture.projectReal,
          }),
          location: Object.freeze({ kind: 'machine-bound' as const, path: destinationPath }),
        }),
      });
      const groupId = createOperationGroupId({
        domain: 'skillsmith.operation-group-identity',
        schemaVersion: 1,
        command: 'apply',
        skill: 'alpha',
        source: operationSource,
        scope: 'project',
        target: null,
      });
      const pairId = createOperationPairId({
        domain: 'skillsmith.operation-pair-identity',
        schemaVersion: 1,
        groupId,
        tool: 'codex',
        resource: after.resource,
      });
      const operationId = createOperationId({
        domain: 'skillsmith.operation-identity',
        schemaVersion: 1,
        groupId,
        pairId,
        kind: 'move-scope',
        skill: 'alpha',
        source: operationSource,
        tool: 'codex',
        scope: 'project',
      });
      const operation: ExecutableOperation & Readonly<{ readonly kind: 'move-scope' }> =
        Object.freeze({
          operationId,
          groupId,
          pairId,
          kind: 'move-scope' as const,
          dependencyMetadata: Object.freeze({
            domain: 'skillsmith.operation-dependency' as const,
            schemaVersion: 1 as const,
            operationIds: Object.freeze([]),
          }),
          skill: 'alpha',
          source: operationSource,
          tool: 'codex' as const,
          scope: 'project' as const,
          before,
          after,
          reason: Object.freeze({ code: 'fixture-move-scope', message: 'Move fixture scope.' }),
          selectionSource: 'bounded-default' as const,
          preconditionIds: Object.freeze([]),
          requiredCheckIds: Object.freeze([]),
          reversibility: Object.freeze({
            kind: 'conditional' as const,
            retentionResourceIds: Object.freeze([pairId] as [string, ...string[]]),
          }),
          mutates: Object.freeze({ live: true, manifest: false, lock: false, ledger: true }),
          conflict: null,
        });
      const pair: PairRecord = {
        placementPath: sourcePath,
        mode: 'pinned',
        dev: null,
        pinned: {
          storePath,
          rev: 'fixture',
          gitSha: null,
          dirty: false,
          contentHash,
          snapshotAt: '2026-07-19T00:00:00.000Z',
          verify: 'passed',
          placement: 'copy',
        },
        journal: null,
      };
      const placed = withLedgerPairAt(
        emptyLedgerModel('2026-07-19T00:00:00.000Z'),
        null,
        'alpha',
        'codex',
        pair,
      );
      if (!placed.ok) throw new Error(JSON.stringify(placed.error));
      const transactionId = 'movef001';
      const backupPath = join(dirname(sourcePath), `.skillsmith-backup-alpha-${transactionId}`);
      const baseRemoveTree = fixture.env.removeTree;
      const request: SwapRequest = {
        context: {
          env: {
            ...fixture.env,
            removeTree: async (path) => {
              if (path === backupPath) {
                throw Object.assign(new Error('private post-commit cleanup failure'), {
                  code: 'EPERM',
                });
              }
              await baseRemoveTree(path);
            },
          },
        },
        state: { ledger: placed.value },
        effects: {
          persistLedger: async (candidate) => ({ ok: true, ledger: candidate }),
          journalNow: () => '2026-07-19T00:00:00.000Z',
          newTransactionId: () => transactionId,
        },
      };
      const prepared = createReconcileMoveScopeExecutionBindingV1(operation, {
        observeActualBefore: async () => operation.before,
        createRequest: async () => request,
      });
      const result = await prepared.execute({
        operationId,
        groupId,
        pairId,
        actualBefore: operation.before,
        unstartedForce: null,
        execute: async () => {
          throw new Error('unused');
        },
      });

      expect(result).toMatchObject({
        operationId,
        outcome: 'failed',
        actualBefore: operation.before,
        actualAfter: operation.after,
        error: { code: 'permission-denied' },
      });
      expect(JSON.stringify(result)).not.toContain('private post-commit cleanup failure');
      expect(await fixture.env.pathKind(destinationPath)).toBe('dir');
      expect(await fixture.env.pathKind(backupPath)).toBe('dir');
    } finally {
      await destroyFixtureFleet(fixture);
    }
  });

  test('retains success, failure, and cancellation results across source cleanup failure', async () => {
    const seed = placementOperation('install', 'alpha');
    const guard = resourceGuard(seed);
    const operation = operationWithGuards(seed, [guard.preconditionId]);
    const cleanupFailure = async () => {
      throw new Error('private cleanup failure');
    };
    for (const selected of [
      {
        outcome: 'succeeded' as const,
        actualAfter: operation.after,
        error: null,
      },
      {
        outcome: 'failed' as const,
        actualAfter: operation.before,
        error: {
          code: 'fixture-operation-failed',
          message: 'fixture operation failed',
          remediation: 'retry fixture',
        },
      },
      {
        outcome: 'cancelled' as const,
        actualAfter: operation.before,
        error: null,
      },
    ]) {
      const result = await executeValidatedReconcilePlanV1({
        plan: plan([operation]),
        guards: executionGuards([guard]),
        authorities: executionAuthorities({
          placementBinding: (boundOperation) => ({
            ...binding(boundOperation),
            execute: async () => ({
              operationId: boundOperation.operationId,
              actualBefore: boundOperation.before,
              force: null,
              ...selected,
            }),
          }),
          cleanupSources: cleanupFailure,
        }),
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'reconcile-execution-cleanup-failed',
          results: [{ operationId: operation.operationId, outcome: selected.outcome }],
        },
      });
      if (!result.ok) {
        expect(Object.isFrozen(result.error.results)).toBeTrue();
        expect(result.error.results?.[0]?.actualAfter).toEqual(selected.actualAfter);
      }
      expect(JSON.stringify(result)).not.toContain('private cleanup failure');
    }

    const stale = await executeValidatedReconcilePlanV1({
      plan: plan([operation]),
      guards: executionGuards([guard]),
      authorities: executionAuthorities({
        observeResource: async () => ({ changed: true }),
        cleanupSources: cleanupFailure,
      }),
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'reconcile-execution-stale' },
    });
    if (!stale.ok) expect(stale.error.results).toBeUndefined();
    expect(JSON.stringify(stale)).not.toContain('private');
  });

  test('rejects cleanup accessors without invoking or leaking them', async () => {
    const seed = placementOperation('install', 'alpha');
    const guard = resourceGuard(seed);
    const operation = operationWithGuards(seed, [guard.preconditionId]);
    let getterRead = false;
    const authorities = executionAuthorities() as unknown as Record<string, unknown>;
    Object.defineProperty(authorities, 'cleanupSources', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterRead = true;
        throw new Error('private cleanup getter');
      },
    });
    const result = await executeValidatedReconcilePlanV1({
      plan: plan([operation]),
      guards: executionGuards([guard]),
      authorities: authorities as unknown as ReconcileRuntimeExecutionAuthoritiesV1,
    });
    expect(result.ok).toBeFalse();
    expect(getterRead).toBeFalse();
    expect(JSON.stringify(result)).not.toContain('private cleanup getter');
  });

  test('rejects hybrid guards and same-resource guards with wrong before facts', () => {
    const seed = placementOperation('update', 'alpha');
    const valid = resourceGuard(seed);
    const operation = operationWithGuards(seed, [valid.preconditionId]);
    const hybrid = Object.freeze({
      ...valid,
      domain: 'selection-set' as const,
    }) as unknown as ResourcePreconditionV1;
    const wrongBefore = Object.freeze({
      ...valid,
      expectedState: 'absent' as const,
      expectedRevision: null,
    });
    for (const selected of [hybrid, wrongBefore]) {
      expect(
        createReconcileExecutionPreconditionsV1(
          plan([operation]),
          executionGuards([selected]),
          executionAuthorities().guards,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'reconcile-execution-guards-invalid' },
      });
    }
  });

  test('snapshots cleanup authority before asynchronous validation can retarget it', async () => {
    const seed = placementOperation('install', 'alpha');
    const guard = resourceGuard(seed);
    const operation = operationWithGuards(seed, [guard.preconditionId]);
    let originalCleanup = 0;
    let retargetedCleanup = 0;
    const authorities = executionAuthorities({
      cleanupSources: async () => {
        originalCleanup += 1;
      },
    });
    const mutable = authorities as unknown as {
      cleanupSources: () => Promise<void>;
      guards: ReconcileRuntimeExecutionAuthoritiesV1['guards'];
    };
    mutable.guards = {
      ...mutable.guards,
      observeResource: async (_selected, expected) => {
        mutable.cleanupSources = async () => {
          retargetedCleanup += 1;
        };
        return expected;
      },
    };
    const result = await executeValidatedReconcilePlanV1({
      plan: plan([operation]),
      guards: executionGuards([guard]),
      authorities,
    });
    expect(result.ok).toBeTrue();
    expect({ originalCleanup, retargetedCleanup }).toEqual({
      originalCleanup: 1,
      retargetedCleanup: 0,
    });
  });
});
