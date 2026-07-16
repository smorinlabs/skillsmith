import { describe, expect, test } from 'bun:test';
import { createAcquisitionPlan } from '../../src/acquire/plan.ts';
import { executeOperationPlan } from '../../src/execution/coordinator.ts';
import {
  createContentObservationExecutionPrecondition,
  createExpectedRevisionExecutionPrecondition,
  validateExecutionPreconditionCoverage,
} from '../../src/execution/preconditions.ts';
import * as publicCore from '../../src/index.ts';
import {
  type CurrentMutatorOperationPlan,
  type ExecutableOperation,
  type OperationDigest,
  type OperationImage,
  type OperationSource,
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
} from '../../src/planning/index.ts';
import {
  type ExpectedRevisionV1,
  type ObservedStateSnapshotV1,
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionV1,
  createStoreSnapshotIdentityV1,
} from '../../src/state/types.ts';

type UnknownRecord = Record<string, unknown>;
type CreateExecutionPrecondition = (
  input: Readonly<{
    operationIds: readonly string[];
    resource: Readonly<UnknownRecord>;
    expected: unknown;
    observe: () => Promise<unknown>;
  }>,
) => UnknownRecord;
type ValidateExecutionPreconditions = (
  plan: CurrentMutatorOperationPlan,
  preconditions: readonly unknown[],
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<void>;

const core = publicCore as unknown as UnknownRecord;
const CONTENT_HASH = `sha256:${'a'.repeat(64)}` as OperationDigest;
const SOURCE: OperationSource = {
  kind: 'portable',
  identity: { host: 'example.test', repository: 'fixture/repo', path: 'skills/alpha' },
  requestedRef: null,
  resolvedSha: 'b'.repeat(40),
  sourcePath: 'skills/alpha',
  contentHash: CONTENT_HASH,
};
const RESOURCE = {
  kind: 'live',
  skill: 'alpha',
  tool: 'codex',
  scope: 'user',
  projectRoot: null,
  location: { kind: 'portable', token: 'skills/user/codex/alpha' },
} as const;

const requireFactory = <T>(name: string): T => {
  expect(typeof core[name], `missing G3B-02 public ${name} behavior`).toBe('function');
  return core[name] as T;
};

const operationFor = (preconditionIds: readonly string[]): ExecutableOperation => {
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'install',
    skill: 'alpha',
    source: SOURCE,
    scope: 'user',
    target: null,
  });
  const pairId = createOperationPairId({
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId,
    tool: 'codex',
    resource: RESOURCE,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId,
    kind: 'install',
    skill: 'alpha',
    source: SOURCE,
    tool: 'codex',
    scope: 'user',
  });
  const before: OperationImage = { kind: 'absent', resource: RESOURCE };
  const after: OperationImage = {
    kind: 'placement',
    resource: RESOURCE,
    classification: 'pinned',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source: SOURCE,
    contentHash: CONTENT_HASH,
  };
  return {
    operationId,
    groupId,
    pairId,
    kind: 'install',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: 'alpha',
    source: SOURCE,
    tool: 'codex',
    scope: 'user',
    before,
    after,
    reason: { code: 'install-selected', message: 'Install selected by fixture.' },
    selectionSource: 'explicit-targets',
    preconditionIds,
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const planFor = (operation: ExecutableOperation): CurrentMutatorOperationPlan =>
  createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'install',
    selection: {
      source: 'explicit-targets',
      skills: ['alpha'],
      tools: ['codex'],
      scopes: ['user'],
    },
    batchPolicy: 'fail-fast',
    operations: [operation],
    checks: [],
    diagnostics: [],
  });

const expectedSnapshot = (contentHash: string | null = null): UnknownRecord => ({
  command: 'install',
  operation: 'install',
  skill: 'alpha',
  tool: 'codex',
  scope: 'user',
  projectRoot: null,
  live: {
    pathKind: 'absent',
    classification: null,
    canonicalPath: '/fixture/skills/alpha',
    symlinkTarget: null,
    dangling: false,
    contentHash,
  },
});

const REVISION_HEX = {
  a: 'a'.repeat(64),
  b: 'b'.repeat(64),
  c: 'c'.repeat(64),
  d: 'd'.repeat(64),
} as const;

const expectedRevision = (input: unknown): ExpectedRevisionV1 => {
  const created = createExpectedRevisionV1(input);
  if (!created.ok) throw new Error('invalid expected-revision fixture');
  return created.value;
};

const absentExpectedRevision = (
  domain: 'manifest' | 'lock' | 'ledger' | 'live',
  resourceId: string,
  targetIdentity: string,
): ExpectedRevisionV1 =>
  expectedRevision({
    schemaVersion: 1,
    domain,
    resourceId,
    state: 'absent',
    targetIdentity,
    targetKind: 'absent',
    parentIdentity: '/fixture',
    parentKind: 'directory',
    parentMetadataIdentity: `metadata:v1:${REVISION_HEX.a}`,
  });

const semanticExpectedRevision = (
  domain: 'project' | 'capabilities',
  resourceId: string,
): ExpectedRevisionV1 =>
  expectedRevision({
    schemaVersion: 1,
    domain,
    resourceId,
    state: 'present',
    targetKind: 'semantic',
    semanticRevision: `sha256:${REVISION_HEX.b}`,
  });

const observedSnapshot = (): ObservedStateSnapshotV1 => {
  const contentRevision = `sha256:${REVISION_HEX.a}` as const;
  const resourceId = 'store:alpha';
  const path = '/fixture/store/alpha';
  const snapshotIdentity = createStoreSnapshotIdentityV1(resourceId, contentRevision);
  return {
    schemaVersion: 1,
    snapshotId: `snapshot:v1:${REVISION_HEX.d}`,
    project: {
      revision: semanticExpectedRevision('project', 'project:fixture'),
      value: {} as never,
    },
    manifest: {
      revision: absentExpectedRevision('manifest', 'manifest:fixture', '/fixture/skillsmith.toml'),
      value: null,
    },
    lock: {
      revision: absentExpectedRevision('lock', 'lock:fixture', '/fixture/skillsmith.lock'),
      value: null,
    },
    ledger: {
      revision: absentExpectedRevision('ledger', 'ledger:fixture', '/fixture/placements.json'),
      value: null,
    },
    live: [
      {
        revision: absentExpectedRevision('live', 'live:alpha', '/fixture/skills/alpha'),
        value: null,
      },
    ],
    store: [
      {
        revision: expectedRevision({
          schemaVersion: 1,
          domain: 'store',
          resourceId,
          state: 'present',
          targetIdentity: path,
          targetKind: 'directory',
          targetMetadataIdentity: `metadata:v1:${REVISION_HEX.b}`,
          parentIdentity: '/fixture/store',
          parentKind: 'directory',
          parentMetadataIdentity: `metadata:v1:${REVISION_HEX.c}`,
          resourceRevision: `sha256:${REVISION_HEX.d}`,
          contentRevision,
          snapshotIdentity,
        }),
        value: {
          path,
          repositoryRevision: `sha256:${REVISION_HEX.d}`,
          contentRevision,
          snapshotIdentity,
        },
      },
    ],
    capabilities: {
      revision: semanticExpectedRevision('capabilities', 'capabilities:fixture'),
      value: {} as never,
    },
  };
};

describe('G3B-02 execution preconditions', () => {
  test('creates deterministic caller-detached frozen preconditions', () => {
    const createExecutionPrecondition = requireFactory<CreateExecutionPrecondition>(
      'createExecutionPrecondition',
    );
    const operation = operationFor([]);
    const expected = expectedSnapshot();
    const first = createExecutionPrecondition({
      operationIds: [operation.operationId],
      resource: RESOURCE,
      expected,
      observe: async () => expectedSnapshot(),
    });
    const second = createExecutionPrecondition({
      operationIds: [operation.operationId],
      resource: structuredClone(RESOURCE),
      expected: expectedSnapshot(),
      observe: async () => expectedSnapshot(),
    });

    expect(first.preconditionId).toBe(
      'precondition:v1:0c995c9a62c57d1964b5481c03e0a43b72e0bc82f0e365c19585da2ff577474e',
    );
    expect(second.preconditionId).toBe(first.preconditionId);
    expect(first.operationIds).toEqual([operation.operationId]);
    expect(Object.isFrozen(first)).toBeTrue();
    expect(Object.isFrozen(first.expected)).toBeTrue();
    (expected.live as UnknownRecord).pathKind = 'file';
    expect((first.expected as UnknownRecord).live).toMatchObject({ pathKind: 'absent' });
  });

  test('preserves own __proto__ data safely and rejects unredacted sensitive snapshots', () => {
    const createExecutionPrecondition = requireFactory<CreateExecutionPrecondition>(
      'createExecutionPrecondition',
    );
    const operation = operationFor([]);
    const expected: UnknownRecord = { marker: 'ordinary' };
    Object.defineProperty(expected, '__proto__', {
      value: { fixtureOwnData: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const precondition = createExecutionPrecondition({
      operationIds: [operation.operationId],
      resource: RESOURCE,
      expected,
      observe: async () => expected,
    });
    const copied = precondition.expected as UnknownRecord;
    expect(Object.getPrototypeOf(copied)).toBeNull();
    expect(Object.hasOwn(copied, '__proto__')).toBeTrue();
    expect(copied.__proto__).toEqual({ fixtureOwnData: true });
    expect(Reflect.get(Object.prototype, 'fixtureOwnData')).toBeUndefined();

    expect(() =>
      createExecutionPrecondition({
        operationIds: [operation.operationId],
        resource: RESOURCE,
        expected: { message: 'authorization: Bearer fixture-secret-value' },
        observe: async () => ({}),
      }),
    ).toThrow(/sensitive material/i);
    expect(() =>
      createExecutionPrecondition({
        operationIds: [operation.operationId],
        resource: RESOURCE,
        expected: { authorization: 'opaque-secret-value' },
        observe: async () => ({}),
      }),
    ).toThrow(/sensitive material/i);
    expect(() =>
      createExecutionPrecondition({
        operationIds: [operation.operationId],
        resource: RESOURCE,
        expected: { message: '[REDACTED]' },
        observe: async () => ({ message: '[REDACTED]' }),
      }),
    ).not.toThrow();
    expect(() =>
      createExecutionPrecondition({
        operationIds: [operation.operationId],
        resource: {
          ...RESOURCE,
          location: { kind: 'portable', token: 'fixture-token', extra: true },
        },
        expected: {},
        observe: async () => ({}),
      }),
    ).toThrow(/sensitive material/i);
    expect(() =>
      createExecutionPrecondition({
        operationIds: [operation.operationId],
        resource: RESOURCE,
        expected: { kind: 'opaque', token: 'fixture-token' },
        observe: async () => ({}),
      }),
    ).toThrow(/sensitive material/i);
  });

  test('validates exact registry coverage in canonical ID order', async () => {
    const createExecutionPrecondition = requireFactory<CreateExecutionPrecondition>(
      'createExecutionPrecondition',
    );
    const validateExecutionPreconditions = requireFactory<ValidateExecutionPreconditions>(
      'validateExecutionPreconditions',
    );
    const seedOperation = operationFor([]);
    const observations: string[] = [];
    const make = (kind: string): UnknownRecord => {
      const expected = { ...expectedSnapshot(), kind };
      return createExecutionPrecondition({
        operationIds: [seedOperation.operationId],
        resource: { ...RESOURCE, location: { kind: 'portable', token: `fixture/${kind}` } },
        expected,
        observe: async () => {
          observations.push(kind);
          return { ...expectedSnapshot(), kind };
        },
      });
    };
    const preconditions = [make('live'), make('ledger')];
    const sorted = preconditions.toSorted((left, right) =>
      String(left.preconditionId) < String(right.preconditionId) ? -1 : 1,
    );
    const operation = operationFor(sorted.map(({ preconditionId }) => String(preconditionId)));
    const plan = planFor(operation);

    await expect(validateExecutionPreconditions(plan, preconditions.toReversed())).resolves.toBe(
      undefined,
    );
    expect(observations).toEqual(
      sorted.map((precondition) => (precondition === preconditions[0] ? 'live' : 'ledger')),
    );
  });

  test('refuses missing coverage or changed state without executing unrelated observers', async () => {
    const createExecutionPrecondition = requireFactory<CreateExecutionPrecondition>(
      'createExecutionPrecondition',
    );
    const validateExecutionPreconditions = requireFactory<ValidateExecutionPreconditions>(
      'validateExecutionPreconditions',
    );
    const seedOperation = operationFor([]);
    let observations = 0;
    const precondition = createExecutionPrecondition({
      operationIds: [seedOperation.operationId],
      resource: RESOURCE,
      expected: expectedSnapshot(),
      observe: async () => {
        observations += 1;
        return expectedSnapshot(CONTENT_HASH);
      },
    });
    const operation = operationFor([String(precondition.preconditionId)]);
    const plan = planFor(operation);

    await expect(validateExecutionPreconditions(plan, [])).rejects.toThrow(
      /precondition.*(coverage|missing)|missing.*precondition/i,
    );
    expect(observations).toBe(0);

    await expect(validateExecutionPreconditions(plan, [precondition])).rejects.toMatchObject({
      code: expect.stringMatching(/state|precondition/i),
    });
    expect(observations).toBe(1);
    expect(plan.operations[0]?.preconditionIds).toEqual([String(precondition.preconditionId)]);
  });

  test('maps hostile observations to the closed failure and stops before later observers', async () => {
    const createExecutionPrecondition = requireFactory<CreateExecutionPrecondition>(
      'createExecutionPrecondition',
    );
    const validateExecutionPreconditions = requireFactory<ValidateExecutionPreconditions>(
      'validateExecutionPreconditions',
    );
    const seedOperation = operationFor([]);
    let hostileLabel = '';
    let laterObservations = 0;
    const make = (label: string): UnknownRecord => {
      const expected = { label };
      return createExecutionPrecondition({
        operationIds: [seedOperation.operationId],
        resource: { ...RESOURCE, location: { kind: 'portable', token: `fixture/${label}` } },
        expected,
        observe: async () => {
          if (label === hostileLabel) return new Proxy({}, {});
          laterObservations += 1;
          return expected;
        },
      });
    };
    const preconditions = [make('alpha'), make('beta')];
    const ordered = preconditions.toSorted((left, right) =>
      String(left.preconditionId) < String(right.preconditionId) ? -1 : 1,
    );
    hostileLabel = ordered[0] === preconditions[0] ? 'alpha' : 'beta';
    const operation = operationFor(ordered.map(({ preconditionId }) => String(preconditionId)));

    await expect(validateExecutionPreconditions(planFor(operation), preconditions)).rejects.toEqual(
      {
        code: 'precondition-observation-failed',
        message: `execution precondition observation failed for ${ordered[0]?.preconditionId}`,
      },
    );
    expect(laterObservations).toBe(0);
  });

  test('binds canonical content identities after planning and validates exact observed facts', async () => {
    const validateExecutionPreconditions = requireFactory<ValidateExecutionPreconditions>(
      'validateExecutionPreconditions',
    );
    const seedOperation = operationFor([]);
    const expectedContent = createContentObservationIdentityV1({
      schemaVersion: 1,
      resourceId: 'source:alpha',
      targetIdentity: '/fixture/source/alpha',
      targetKind: 'directory',
      contentRevision: `sha256:${REVISION_HEX.a}`,
    });
    let actual: unknown = expectedContent;
    const precondition = createContentObservationExecutionPrecondition({
      operationIds: [seedOperation.operationId],
      resource: RESOURCE,
      expectedContent,
      observeContent: async () => actual as never,
    });
    const unrelatedOperationId = `operation:v1:${REVISION_HEX.b}` as const;
    const rebound = createContentObservationExecutionPrecondition({
      operationIds: [unrelatedOperationId],
      resource: RESOURCE,
      expectedContent,
      observeContent: async () => expectedContent,
    });
    expect(rebound.preconditionId).toBe(precondition.preconditionId);
    expect(rebound.operationIds).toEqual([unrelatedOperationId]);

    const operation = operationFor([precondition.preconditionId]);
    const plan = planFor(operation);
    await expect(validateExecutionPreconditions(plan, [precondition])).resolves.toBeUndefined();

    const rematerialized = createContentObservationIdentityV1({
      ...expectedContent,
      targetIdentity: '/fixture/rematerialized/alpha',
    });
    actual = rematerialized;
    expect(createContentObservationPreconditionIdV1(rematerialized)).toBe(
      createContentObservationPreconditionIdV1(expectedContent),
    );
    await expect(validateExecutionPreconditions(plan, [precondition])).rejects.toMatchObject({
      code: 'precondition-state-changed',
    });

    actual = createContentObservationIdentityV1({
      ...expectedContent,
      contentRevision: `sha256:${REVISION_HEX.b}`,
    });
    await expect(validateExecutionPreconditions(plan, [precondition])).rejects.toMatchObject({
      code: 'precondition-state-changed',
    });

    actual = { ...expectedContent, extra: true };
    await expect(validateExecutionPreconditions(plan, [precondition])).rejects.toMatchObject({
      code: 'precondition-observation-failed',
    });

    expect(() =>
      createContentObservationExecutionPrecondition({
        operationIds: [seedOperation.operationId],
        resource: RESOURCE,
        expectedContent: {
          ...expectedContent,
          targetIdentity: '/fixture/source/../source/alpha',
        },
        observeContent: async () => expectedContent,
      }),
    ).toThrow(/expectedContent/i);
  });

  test('executes an unchanged snapshot plan with canonical revision observers', async () => {
    const observed = observedSnapshot();
    const contentHash = `sha256:${REVISION_HEX.a}` as const;
    const sourceContent = createContentObservationIdentityV1({
      schemaVersion: 1,
      resourceId: 'source:alpha',
      targetIdentity: '/fixture/source/alpha',
      targetKind: 'directory',
      contentRevision: contentHash,
    });
    const planned = createAcquisitionPlan(
      {
        schemaVersion: 1,
        command: 'install',
        selection: {
          source: 'explicit-targets',
          skills: ['alpha'],
          tools: ['codex'],
          scopes: ['user'],
        },
        batchPolicy: 'fail-fast',
        intents: [
          {
            kind: 'install',
            skill: 'alpha',
            tool: 'codex',
            scope: 'user',
            projectRoot: null,
            liveResourceId: 'live:alpha',
            storeResourceId: 'store:alpha',
            force: false,
            sourceContent,
            sourcePreconditionId: createContentObservationPreconditionIdV1(sourceContent),
            source: {
              kind: 'portable',
              identity: { host: 'example.test', repository: 'fixture/repo', path: 'skills/alpha' },
              requestedRef: null,
              resolvedSha: 'c'.repeat(40),
              sourcePath: 'skills/alpha',
              contentHash,
            },
            placement: {
              classification: 'pinned',
              representation: 'copy',
              location: { kind: 'machine-bound', path: '/fixture/skills/alpha' },
            },
            store: {
              location: { kind: 'machine-bound', path: '/fixture/store/alpha' },
              contentHash,
              snapshotIdentity: createStoreSnapshotIdentityV1('store:alpha', contentHash),
            },
          },
        ],
      },
      observed,
    );
    expect(planned.ok).toBeTrue();
    if (!planned.ok) return;
    const operation = planned.value.plan.operations[0];
    if (operation === undefined) throw new Error('missing planned acquisition operation');
    if (operation.before.kind !== 'absent' && operation.before.kind !== 'placement') {
      throw new Error('expected live acquisition before image');
    }
    const liveResource = operation.before.resource;
    const planBefore = structuredClone(planned.value.plan);
    const operationIds = planned.value.plan.operations.map((candidate) => candidate.operationId);
    const preconditions = [
      ...planned.value.expectedRevisions.map((revision) =>
        createExpectedRevisionExecutionPrecondition({
          operationIds,
          resource: liveResource,
          expectedRevision: revision,
          observeRevision: async () => structuredClone(revision),
        }),
      ),
      createContentObservationExecutionPrecondition({
        operationIds,
        resource: liveResource,
        expectedContent: sourceContent,
        observeContent: async () => structuredClone(sourceContent),
      }),
    ].toSorted((left, right) =>
      left.preconditionId < right.preconditionId
        ? -1
        : left.preconditionId > right.preconditionId
          ? 1
          : 0,
    );

    expect(preconditions.map(({ preconditionId }) => preconditionId)).toEqual([
      ...operation.preconditionIds,
    ]);
    expect(
      validateExecutionPreconditionCoverage(planned.value.plan, preconditions).map(
        ({ preconditionId }) => preconditionId,
      ),
    ).toEqual([...operation.preconditionIds]);

    const results = await executeOperationPlan({
      plan: planned.value.plan,
      bindings: [
        {
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: operation.pairId,
          unstartedForce: null,
          observeActualBefore: async () => operation.before,
          execute: async () =>
            createOperationExecutionResult({
              operationId: operation.operationId,
              outcome: 'succeeded',
              actualBefore: operation.before,
              actualAfter: operation.after,
              force: null,
              error: null,
            }),
        },
      ],
      preconditions,
      locks: [{ rank: 'ledger', key: 'ledger:fixture', path: '/fixture/placements.json' }],
      lockPort: {
        withFileLock: async <T>(_path: string, execute: () => Promise<T>): Promise<T> => execute(),
      },
    });

    expect(results.map(({ outcome }) => outcome)).toEqual(['succeeded']);
    expect(planned.value.plan).toEqual(planBefore);
  });
});
