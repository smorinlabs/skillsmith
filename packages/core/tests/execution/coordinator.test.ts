import { describe, expect, test } from 'bun:test';
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
      actualBefore: operation.before,
      unstartedForce: null,
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
    };

    const results = await executeOperationPlan({
      plan,
      bindings: [binding],
      preconditions: [precondition],
      locks: [{ rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' }],
      lockPort,
    });

    expect(events).toEqual(['acquire', 'observe', 'execute', 'release']);
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
      actualBefore: operation.before,
      unstartedForce: null,
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
            actualBefore: operation.before,
            unstartedForce: null,
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
});
