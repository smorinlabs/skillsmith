import { describe, expect, test } from 'bun:test';
import * as publicCore from '../../src/index.ts';
import {
  type CurrentMutatorOperationPlan,
  type ExecutableOperation,
  type ExecutableOperationKind,
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
type ScheduleOperationPlan = (
  plan: CurrentMutatorOperationPlan,
  bindings: readonly UnknownRecord[],
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<readonly UnknownRecord[]>;

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

const requireScheduler = (): ScheduleOperationPlan => {
  expect(
    typeof core.scheduleOperationPlan,
    'missing G3B-02 public scheduleOperationPlan behavior',
  ).toBe('function');
  return core.scheduleOperationPlan as ScheduleOperationPlan;
};

const operationFor = (input: {
  readonly skill: string;
  readonly tool?: 'codex' | 'claude-code';
  readonly kind?: 'install' | 'repair';
  readonly groupId?: string;
  readonly pairId?: string;
  readonly dependencies?: readonly string[];
}): ExecutableOperation => {
  const tool = input.tool ?? 'codex';
  const kind = input.kind ?? 'install';
  const groupId =
    input.groupId ??
    createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'install',
      skill: input.skill,
      source: SOURCE,
      scope: 'user',
      target: null,
    });
  const resource = {
    kind: 'live',
    skill: input.skill,
    tool,
    scope: 'user',
    projectRoot: null,
    location: { kind: 'portable', token: `skills/user/${tool}/${input.skill}` },
  } as const;
  const pairId =
    input.pairId ??
    createOperationPairId({
      domain: 'skillsmith.operation-pair-identity',
      schemaVersion: 1,
      groupId,
      tool,
      resource,
    });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId,
    kind: kind as ExecutableOperationKind,
    skill: input.skill,
    source: SOURCE,
    tool,
    scope: 'user',
  });
  const absent: OperationImage = { kind: 'absent', resource };
  const pinned: OperationImage = {
    kind: 'placement',
    resource,
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
    kind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: input.dependencies ?? [],
    },
    skill: input.skill,
    source: SOURCE,
    tool,
    scope: 'user',
    before: kind === 'install' ? absent : pinned,
    after: pinned,
    reason: { code: `${kind}-selected`, message: `${kind} selected by fixture.` },
    selectionSource: 'explicit-targets',
    preconditionIds: ['precondition:v1:fixture'],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const planFor = (operations: readonly ExecutableOperation[]): CurrentMutatorOperationPlan =>
  createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'install',
    selection: {
      source: 'explicit-targets',
      skills: [...new Set(operations.flatMap((operation) => operation.skill ?? []))],
      tools: [...new Set(operations.flatMap((operation) => operation.tool ?? []))],
      scopes: ['user'],
    },
    batchPolicy: 'fail-fast',
    operations,
    checks: [],
    diagnostics: [],
  });

const bindingFor = (operation: ExecutableOperation, calls: string[]): UnknownRecord => ({
  operationId: operation.operationId,
  groupId: operation.groupId,
  pairId: operation.pairId,
  actualBefore: operation.before,
  unstartedForce: null,
  execute: async () => {
    calls.push(operation.operationId);
    return createOperationExecutionResult({
      operationId: operation.operationId,
      outcome: 'succeeded',
      actualBefore: operation.before,
      actualAfter: operation.after,
      force: null,
      error: null,
    });
  },
});

describe('G3B-02 operation scheduler', () => {
  test('executes one validated binding per operation and preserves canonical result order', async () => {
    const plan = planFor([operationFor({ skill: 'beta' }), operationFor({ skill: 'alpha' })]);
    const scheduleOperationPlan = requireScheduler();
    const calls: string[] = [];
    const bindings = plan.operations.map((operation) => bindingFor(operation, calls));

    const results = await scheduleOperationPlan(plan, bindings);

    expect(calls).toEqual(plan.operations.map(({ operationId }) => operationId));
    expect(results.map((result) => result.operationId)).toEqual(
      plan.operations.map(({ operationId }) => operationId),
    );
    expect(results.map((result) => result.outcome)).toEqual(['succeeded', 'succeeded']);
    expect(results.every((result) => Object.isFrozen(result))).toBeTrue();
  });

  test('refuses missing, reordered, or mismatched bindings before invoking any callback', async () => {
    const plan = planFor([operationFor({ skill: 'beta' }), operationFor({ skill: 'alpha' })]);
    const scheduleOperationPlan = requireScheduler();

    for (const invalid of ['missing', 'reordered', 'mismatched'] as const) {
      const calls: string[] = [];
      const bindings = plan.operations.map((operation) => bindingFor(operation, calls));
      const candidate =
        invalid === 'missing'
          ? bindings.slice(0, -1)
          : invalid === 'reordered'
            ? bindings.toReversed()
            : bindings.map((binding, index) =>
                index === 0 ? { ...binding, groupId: plan.operations[1]?.groupId } : binding,
              );

      await expect(scheduleOperationPlan(plan, candidate)).rejects.toThrow(
        /binding.*(coverage|missing|order|mismatch)|operation.*binding/i,
      );
      expect(calls, `${invalid} callback count`).toEqual([]);
    }
  });

  test('refuses multi-operation pairs and dependency-bearing plans before work', async () => {
    const first = operationFor({ skill: 'alpha', kind: 'install' });
    const samePair = operationFor({
      skill: 'alpha',
      kind: 'repair',
      groupId: first.groupId,
      pairId: first.pairId as string,
    });
    const multiPairPlan = planFor([first, samePair]);
    const independentPlan = planFor([
      operationFor({ skill: 'gamma', kind: 'install' }),
      operationFor({ skill: 'beta', kind: 'install' }),
    ]);
    const dependencyRoot = independentPlan.operations[0] as ExecutableOperation;
    const dependent = structuredClone(
      independentPlan.operations[1] as ExecutableOperation,
    ) as ExecutableOperation;
    (dependent.dependencyMetadata as unknown as { operationIds: string[] }).operationIds = [
      dependencyRoot.operationId,
    ];
    const dependencyPlan = planFor([dependent, dependencyRoot]);
    const scheduleOperationPlan = requireScheduler();

    const multiPairCalls: string[] = [];
    await expect(
      scheduleOperationPlan(
        multiPairPlan,
        multiPairPlan.operations.map((operation) => bindingFor(operation, multiPairCalls)),
      ),
    ).rejects.toThrow(/pair.*exactly one|multi-operation pair|singleton/i);
    expect(multiPairCalls).toEqual([]);

    const dependencyCalls: string[] = [];
    await expect(
      scheduleOperationPlan(
        dependencyPlan,
        dependencyPlan.operations.map((operation) => bindingFor(operation, dependencyCalls)),
      ),
    ).rejects.toThrow(/dependency.*empty|dependency-bearing|unsupported dependenc/i);
    expect(dependencyCalls).toEqual([]);
  });

  test('does not treat a truthful rolled-back result as a fail-fast group failure', async () => {
    const plan = planFor([operationFor({ skill: 'beta' }), operationFor({ skill: 'alpha' })]);
    const scheduleOperationPlan = requireScheduler();
    const calls: string[] = [];
    const bindings = plan.operations.map((operation, index) => ({
      ...bindingFor(operation, []),
      execute: async () => {
        calls.push(operation.operationId);
        return createOperationExecutionResult({
          operationId: operation.operationId,
          outcome: index === 0 ? 'rolled-back' : 'succeeded',
          actualBefore: operation.before,
          actualAfter: index === 0 ? operation.before : operation.after,
          force: null,
          error: null,
        });
      },
    }));

    const results = await scheduleOperationPlan(plan, bindings);

    expect(calls).toEqual(plan.operations.map(({ operationId }) => operationId));
    expect(results.map(({ outcome }) => outcome)).toEqual(['rolled-back', 'succeeded']);
  });
});
