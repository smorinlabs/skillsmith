import { describe, expect, test } from 'bun:test';
import {
  type DurabilityDispositionV1,
  type DurabilityReceiptV1,
  type RepositoryRevisionV1,
  applyDurabilityReceiptV1,
  createRevisionCursorV1,
  executeRepositoryLifecycleV1,
} from '../../src/execution/coordinator.ts';
import * as publicCore from '../../src/index.ts';
import {
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
import { createExpectedRevisionV1 } from '../../src/state/types.ts';

type UnknownRecord = Record<string, unknown>;
type LockRequest = Readonly<{ signal?: AbortSignal }>;
type ExecuteOperationPlan = (
  request: Readonly<{
    plan: UnknownRecord;
    bindings: readonly UnknownRecord[];
    preconditions: readonly UnknownRecord[];
    locks: readonly UnknownRecord[];
    lockPort: Readonly<{
      withFileLock<T>(path: string, operation: () => Promise<T>, options?: LockRequest): Promise<T>;
    }>;
    signal?: AbortSignal;
  }>,
) => Promise<readonly UnknownRecord[]>;
type CreateExecutionPrecondition = (
  input: Readonly<{
    operationIds: readonly string[];
    resource: Readonly<UnknownRecord>;
    expected: unknown;
    observe: () => Promise<unknown>;
  }>,
) => UnknownRecord;

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

const ledgerMigrationFor = (preconditionIds: readonly string[]): ExecutableOperation => {
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'install',
    skill: null,
    source: null,
    scope: null,
    target: 'artifacts/placements.json',
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind: 'migrate-ledger',
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  return {
    operationId,
    groupId,
    pairId: null,
    kind: 'migrate-ledger',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 1,
      byteHash: CONTENT_HASH,
      semanticHash: CONTENT_HASH,
    },
    after: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 2,
      byteHash: `sha256:${'c'.repeat(64)}`,
      semanticHash: `sha256:${'c'.repeat(64)}`,
    },
    reason: { code: 'ledger-migration-required', message: 'Ledger migration required.' },
    selectionSource: 'explicit-targets',
    preconditionIds,
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: false, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const planFor = (operation: ExecutableOperation): UnknownRecord =>
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
  }) as unknown as UnknownRecord;

const artifactPlanFor = (operation: ExecutableOperation): UnknownRecord => ({
  ...planFor(operationFor([])),
  operations: [operation],
});

const snapshot = (pathKind: 'absent' | 'file' = 'absent'): UnknownRecord => ({
  command: 'install',
  operation: 'install',
  groupId: null,
  pairId: null,
  tool: 'codex',
  skill: 'alpha',
  scope: 'user',
  projectRoot: null,
  live: { pathKind, canonicalPath: '/fixture/skills/alpha' },
});

describe('G3B-02 execution coordinator', () => {
  test('locks, validates the prepared plan, executes it once, and releases in order', async () => {
    const createExecutionPrecondition = requireFactory<CreateExecutionPrecondition>(
      'createExecutionPrecondition',
    );
    const executeOperationPlan = requireFactory<ExecuteOperationPlan>('executeOperationPlan');
    const seed = operationFor([]);
    const events: string[] = [];
    const precondition = createExecutionPrecondition({
      operationIds: [seed.operationId],
      resource: RESOURCE,
      expected: snapshot(),
      observe: async () => {
        events.push('observe');
        return snapshot();
      },
    });
    const operation = operationFor([String(precondition.preconditionId)]);
    const plan = planFor(operation);
    const lockPort = {
      withFileLock: async <T>(_path: string, callback: () => Promise<T>): Promise<T> => {
        events.push('acquire');
        try {
          return await callback();
        } finally {
          events.push('release');
        }
      },
    };
    const binding = {
      operationId: operation.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      unstartedForce: null,
      observeActualBefore: async () => {
        events.push('observe-actual-before');
        return operation.before;
      },
      execute: async (validated: UnknownRecord) => {
        expect(validated.actualBefore).toEqual(operation.before);
        events.push('execute');
        return createOperationExecutionResult({
          operationId: operation.operationId,
          outcome: 'succeeded',
          actualBefore: operation.before,
          actualAfter: operation.after,
          force: null,
          error: null,
        });
      },
    };

    const results = await executeOperationPlan({
      plan,
      bindings: [binding],
      preconditions: [precondition],
      locks: [{ rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' }],
      lockPort,
    });

    expect(events).toEqual(['acquire', 'observe', 'observe-actual-before', 'execute', 'release']);
    expect(results.map((result) => result.operationId)).toEqual([operation.operationId]);
    expect(results.map((result) => result.outcome)).toEqual(['succeeded']);
  });

  test('changed under-lock state refuses with zero binding calls and no replan', async () => {
    const createExecutionPrecondition = requireFactory<CreateExecutionPrecondition>(
      'createExecutionPrecondition',
    );
    const executeOperationPlan = requireFactory<ExecuteOperationPlan>('executeOperationPlan');
    const seed = operationFor([]);
    const precondition = createExecutionPrecondition({
      operationIds: [seed.operationId],
      resource: RESOURCE,
      expected: snapshot(),
      observe: async () => snapshot('file'),
    });
    const operation = operationFor([String(precondition.preconditionId)]);
    const plan = planFor(operation);
    let bindingCalls = 0;
    let lockReleases = 0;
    const binding = {
      operationId: operation.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      unstartedForce: null,
      observeActualBefore: async () => operation.before,
      execute: async () => {
        bindingCalls += 1;
        throw new Error('binding must not run after a precondition mismatch');
      },
    };

    await expect(
      executeOperationPlan({
        plan,
        bindings: [binding],
        preconditions: [precondition],
        locks: [{ rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' }],
        lockPort: {
          withFileLock: async <T>(_path: string, callback: () => Promise<T>): Promise<T> => {
            try {
              return await callback();
            } finally {
              lockReleases += 1;
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/state|precondition/i) });

    expect(bindingCalls).toBe(0);
    expect(lockReleases).toBe(1);
    expect(plan).toBe(plan);
    expect((plan.operations as readonly UnknownRecord[])[0]?.operationId).toBe(
      operation.operationId,
    );
  });

  test('refuses a mutating operation without bound preconditions before lock or work', async () => {
    const executeOperationPlan = requireFactory<ExecuteOperationPlan>('executeOperationPlan');
    const operation = operationFor([]);
    let acquisitions = 0;
    let bindingCalls = 0;

    await expect(
      executeOperationPlan({
        plan: planFor(operation),
        bindings: [
          {
            operationId: operation.operationId,
            groupId: operation.groupId,
            pairId: operation.pairId,
            unstartedForce: null,
            observeActualBefore: async () => operation.before,
            execute: async () => {
              bindingCalls += 1;
            },
          },
        ],
        preconditions: [],
        locks: [{ rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' }],
        lockPort: {
          withFileLock: async <T>(_path: string, callback: () => Promise<T>): Promise<T> => {
            acquisitions += 1;
            return callback();
          },
        },
      }),
    ).rejects.toThrow(/mutating.*precondition|precondition.*required/i);
    expect(acquisitions).toBe(0);
    expect(bindingCalls).toBe(0);
  });

  test('refuses an under-lock actual-before observation that differs from the accepted plan', async () => {
    const createExecutionPrecondition = requireFactory<CreateExecutionPrecondition>(
      'createExecutionPrecondition',
    );
    const executeOperationPlan = requireFactory<ExecuteOperationPlan>('executeOperationPlan');
    const seed = operationFor([]);
    const events: string[] = [];
    const precondition = createExecutionPrecondition({
      operationIds: [seed.operationId],
      resource: RESOURCE,
      expected: snapshot(),
      observe: async () => {
        events.push('observe-precondition');
        return snapshot();
      },
    });
    const operation = operationFor([String(precondition.preconditionId)]);
    let bindingCalls = 0;

    await expect(
      executeOperationPlan({
        plan: planFor(operation),
        bindings: [
          {
            operationId: operation.operationId,
            groupId: operation.groupId,
            pairId: operation.pairId,
            unstartedForce: null,
            observeActualBefore: async () => {
              events.push('observe-actual-before');
              return operation.after;
            },
            execute: async () => {
              bindingCalls += 1;
              throw new Error('changed actual-before observation invoked execution');
            },
          },
        ],
        preconditions: [precondition],
        locks: [{ rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' }],
        lockPort: {
          withFileLock: async <T>(_path: string, callback: () => Promise<T>): Promise<T> => {
            events.push('acquire');
            try {
              return await callback();
            } finally {
              events.push('release');
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'precondition-state-changed' });

    expect(events).toEqual(['acquire', 'observe-precondition', 'observe-actual-before', 'release']);
    expect(bindingCalls).toBe(0);
  });

  test('binds and executes an exact null-pair ledger prerequisite under lock', async () => {
    const createExecutionPrecondition = requireFactory<CreateExecutionPrecondition>(
      'createExecutionPrecondition',
    );
    const executeOperationPlan = requireFactory<ExecuteOperationPlan>('executeOperationPlan');
    const seed = ledgerMigrationFor([]);
    const expected = { schemaVersion: 1, byteHash: CONTENT_HASH };
    const precondition = createExecutionPrecondition({
      operationIds: [seed.operationId],
      resource: { kind: 'ledger', projectRoot: null },
      expected,
      observe: async () => expected,
    });
    const operation = ledgerMigrationFor([String(precondition.preconditionId)]);
    const events: string[] = [];

    const results = await executeOperationPlan({
      plan: artifactPlanFor(operation),
      bindings: [
        {
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: null,
          unstartedForce: null,
          observeActualBefore: async () => operation.before,
          execute: async () => {
            events.push('execute');
            return createOperationExecutionResult({
              operationId: operation.operationId,
              outcome: 'succeeded',
              actualBefore: operation.before,
              actualAfter: operation.after,
              force: null,
              error: null,
            });
          },
        },
      ],
      preconditions: [precondition],
      locks: [{ rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' }],
      lockPort: {
        withFileLock: async <T>(_path: string, callback: () => Promise<T>): Promise<T> =>
          callback(),
      },
    });

    expect(events).toEqual(['execute']);
    expect(results.map((result) => result.outcome)).toEqual(['succeeded']);
  });
});

describe('G3B-04 repository lifecycle revision cursor', () => {
  const revision = (
    resourceId: string,
    digest: string,
    domain: 'ledger' | 'live' = resourceId.startsWith('live:') ? 'live' : 'ledger',
  ): RepositoryRevisionV1 => {
    const created = createExpectedRevisionV1({
      schemaVersion: 1,
      domain,
      resourceId,
      state: 'absent',
      targetIdentity: `/fixture/${resourceId}`,
      targetKind: 'absent',
      parentIdentity: '/fixture',
      parentKind: 'directory',
      parentMetadataIdentity: `metadata:v1:${digest.repeat(64)}`,
    });
    if (!created.ok) throw new Error('invalid repository revision fixture');
    return created.value;
  };

  const receipt = (
    operationId: string,
    disposition: DurabilityDispositionV1,
    beforeRevision: RepositoryRevisionV1,
    afterRevision: RepositoryRevisionV1,
  ): DurabilityReceiptV1 =>
    Object.freeze({
      schemaVersion: 1,
      operationId,
      disposition,
      revisions: Object.freeze([
        Object.freeze({
          resourceId: beforeRevision.resourceId,
          beforeRevision,
          afterRevision,
        }),
      ]),
    });

  test('advances only a committed resource and preserves the caller-owned cursor', () => {
    const beforeA = revision('ledger:a', 'a');
    const afterA = revision('ledger:a', 'b');
    const beforeB = revision('live:b', 'c');
    const cursor = createRevisionCursorV1({
      schemaVersion: 1,
      snapshotId: `snapshot:v1:${'d'.repeat(64)}`,
      expectedRevisions: [beforeA, beforeB],
    });
    const snapshot = structuredClone(cursor);

    const advanced = applyDurabilityReceiptV1(
      cursor,
      receipt(`operation:v1:${'e'.repeat(64)}`, 'committed', beforeA, afterA),
    );

    expect(advanced.ok).toBeTrue();
    if (!advanced.ok) return;
    expect(cursor).toEqual(snapshot);
    expect(advanced.value).not.toBe(cursor);
    expect(advanced.value.revisions).toEqual([afterA, beforeB]);
    expect(Object.isFrozen(advanced.value.revisions)).toBeTrue();
  });

  test('rejects a committed receipt that changes a resource domain', () => {
    const before = revision('shared:a', 'a');
    const changedDomain = createExpectedRevisionV1({
      schemaVersion: 1,
      domain: 'live',
      resourceId: before.resourceId,
      state: 'absent',
      targetIdentity: '/fixture/shared:a',
      targetKind: 'absent',
      parentIdentity: '/fixture',
      parentKind: 'directory',
      parentMetadataIdentity: `metadata:v1:${'b'.repeat(64)}`,
    });
    expect(changedDomain.ok).toBeTrue();
    if (!changedDomain.ok) return;
    const cursor = createRevisionCursorV1({
      schemaVersion: 1,
      snapshotId: `snapshot:v1:${'d'.repeat(64)}`,
      expectedRevisions: [before],
    });

    const advanced = applyDurabilityReceiptV1(
      cursor,
      receipt(`operation:v1:${'e'.repeat(64)}`, 'committed', before, changedDomain.value),
    );

    expect(advanced).toEqual({
      ok: false,
      error: {
        code: 'invalid-receipt',
        operationId: `operation:v1:${'e'.repeat(64)}`,
        resourceId: 'shared:a',
      },
    });
  });

  test('fails closed when rollback cannot establish a truthful disposition', async () => {
    const before = revision('ledger:a', 'a');
    const cursor = createRevisionCursorV1({
      schemaVersion: 1,
      snapshotId: `snapshot:v1:${'d'.repeat(64)}`,
      expectedRevisions: [before],
    });
    const calls: string[] = [];
    const operationId = `operation:v1:${'e'.repeat(64)}`;

    const result = await executeRepositoryLifecycleV1(cursor, {
      operationId,
      stage: async () => {
        calls.push('stage');
        return {
          ok: true,
          value: Object.freeze([
            {
              operationId,
              domain: before.domain,
              resourceId: before.resourceId,
              beforeRevision: before,
            },
          ]),
        };
      },
      commit: async () => {
        calls.push('commit');
        return { ok: false, error: { code: 'commit-failed-after-boundary' } };
      },
      rollback: async () => {
        calls.push('rollback');
        return { ok: false, error: { code: 'rollback-failed' } };
      },
      cleanup: async () => {
        calls.push('cleanup');
        return { ok: true, value: undefined };
      },
    });

    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(calls).toEqual(['stage', 'commit', 'rollback']);
    expect(result.error).toMatchObject({ disposition: 'indeterminate', cursor: null });
  });

  test('drops the stale cursor for explicit commit and rollback indeterminate receipts', async () => {
    const before = revision('ledger:a', 'a');
    const operationId = `operation:v1:${'e'.repeat(64)}`;
    const cursor = createRevisionCursorV1({
      schemaVersion: 1,
      snapshotId: `snapshot:v1:${'d'.repeat(64)}`,
      expectedRevisions: [before],
    });
    const stage = Object.freeze({
      operationId,
      domain: before.domain,
      resourceId: before.resourceId,
      beforeRevision: before,
    });
    const indeterminate = Object.freeze({
      schemaVersion: 1 as const,
      operationId,
      disposition: 'indeterminate' as const,
      revisions: Object.freeze([]),
    });

    for (const failCommit of [false, true]) {
      const result = await executeRepositoryLifecycleV1(cursor, {
        operationId,
        stage: async () => ({ ok: true, value: Object.freeze([stage]) }),
        commit: async () =>
          failCommit
            ? { ok: false, error: { code: 'commit-failed' } }
            : { ok: true, value: indeterminate },
        rollback: async () => ({ ok: true, value: indeterminate }),
        cleanup: async () => ({ ok: true, value: undefined }),
      });

      expect(result.ok).toBeFalse();
      if (result.ok) continue;
      expect(result.error).toMatchObject({ disposition: 'indeterminate', cursor: null });
    }
  });

  test('rejects a durable receipt that does not exactly cover the staged resource', async () => {
    const before = revision('ledger:a', 'a');
    const operationId = `operation:v1:${'e'.repeat(64)}`;
    const cursor = createRevisionCursorV1({
      schemaVersion: 1,
      snapshotId: `snapshot:v1:${'d'.repeat(64)}`,
      expectedRevisions: [before],
    });
    let cleanupCalls = 0;

    const result = await executeRepositoryLifecycleV1(cursor, {
      operationId,
      stage: async () => ({
        ok: true,
        value: Object.freeze([
          {
            operationId,
            domain: before.domain,
            resourceId: before.resourceId,
            beforeRevision: before,
          },
        ]),
      }),
      commit: async () => ({
        ok: true,
        value: Object.freeze({
          schemaVersion: 1 as const,
          operationId,
          disposition: 'committed' as const,
          revisions: Object.freeze([]),
        }),
      }),
      rollback: async () => ({ ok: false, error: { code: 'unexpected-rollback' } }),
      cleanup: async () => {
        cleanupCalls += 1;
        return { ok: true, value: undefined };
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid-receipt', disposition: 'indeterminate', cursor: null },
    });
    expect(cleanupCalls).toBe(0);
  });
});
