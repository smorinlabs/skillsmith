import { describe, expect, test } from 'bun:test';
import * as publicCore from '../../src/index.ts';
import {
  type CurrentMutatorOperationPlan,
  type ExecutableOperation,
  type OperationDigest,
  type OperationImage,
  type OperationSource,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
} from '../../src/planning/index.ts';

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
  preconditions: readonly UnknownRecord[],
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

    expect(first.preconditionId).toMatch(/^precondition:v1:[0-9a-f]{64}$/);
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
});
