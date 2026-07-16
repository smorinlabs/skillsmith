import { describe, expect, test } from 'bun:test';
import { scheduleOperationPlanObserved } from '../../src/execution/scheduler.ts';
import * as publicCore from '../../src/index.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
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
const OTHER_HASH = `sha256:${'b'.repeat(64)}` as OperationDigest;
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

const artifactOperationFor = (input: {
  readonly kind: 'migrate-ledger' | 'migrate-project-config' | 'write-lock';
  readonly groupId?: string;
}): ExecutableOperation => {
  const groupId =
    input.groupId ??
    createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'install',
      skill: null,
      source: null,
      scope: null,
      target: `artifacts/${input.kind}`,
    });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind: input.kind,
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  const location = { kind: 'portable' as const, token: 'artifacts/skills-lock.json' };
  const manifest = {
    version: 1 as const,
    defaults: null,
    registry: null,
    skills: [],
  };
  const manifestLocation = { kind: 'portable' as const, token: 'artifacts/skills.json' };
  const before: OperationImage =
    input.kind === 'migrate-ledger'
      ? {
          kind: 'ledger',
          projectRoot: null,
          schemaVersion: 1,
          byteHash: CONTENT_HASH,
          semanticHash: CONTENT_HASH,
        }
      : input.kind === 'migrate-project-config'
        ? {
            kind: 'manifest',
            location: manifestLocation,
            shape: 'legacy',
            version: 1,
            byteHash: CONTENT_HASH,
            semanticHash: CONTENT_HASH,
            value: manifest,
          }
        : { kind: 'absent', resource: { kind: 'lock', location } };
  const after: OperationImage =
    input.kind === 'migrate-ledger'
      ? {
          kind: 'ledger',
          projectRoot: null,
          schemaVersion: 2,
          byteHash: OTHER_HASH,
          semanticHash: OTHER_HASH,
        }
      : input.kind === 'migrate-project-config'
        ? {
            kind: 'manifest',
            location: manifestLocation,
            shape: 'canonical',
            version: 1,
            byteHash: OTHER_HASH,
            semanticHash: CONTENT_HASH,
            value: manifest,
          }
        : {
            kind: 'lock',
            location,
            version: 1,
            canonicalHash: OTHER_HASH,
            value: {
              version: 1,
              hashSchemaVersion: 1,
              manifestHash: CONTENT_HASH,
              skills: [],
            },
          };
  return {
    operationId,
    groupId,
    pairId: null,
    kind: input.kind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before,
    after,
    reason: { code: `${input.kind}-required`, message: `${input.kind} required by fixture.` },
    selectionSource: 'explicit-targets',
    preconditionIds: ['precondition:v1:fixture'],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates:
      input.kind === 'migrate-ledger'
        ? { live: false, manifest: false, lock: false, ledger: true }
        : input.kind === 'migrate-project-config'
          ? { live: false, manifest: true, lock: false, ledger: false }
          : { live: false, manifest: false, lock: true, ledger: false },
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

const structuralPlanFor = (
  operations: readonly ExecutableOperation[],
  batchPolicy: CurrentMutatorOperationPlan['batchPolicy'],
): CurrentMutatorOperationPlan => {
  const live = operations.find((operation) => operation.pairId !== null);
  if (live === undefined) throw new Error('scheduler fixture requires one pair-bound operation');
  return Object.freeze({
    ...planFor([live]),
    batchPolicy,
    operations: Object.freeze([...operations]),
  });
};

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

const observationBundle = () =>
  Object.freeze({
    context: createOperationContext({
      command: 'skillsmith install',
      workflow: 'scheduler-test',
      clock: {
        wallNowIso: () => '2026-07-16T00:00:00.000Z',
        monotonicMilliseconds: () => 0,
      },
      id: { nextId: () => 'command:v1:scheduler-test' },
      operationId: 'command:v1:scheduler-test',
    }),
    emitter: createObservationEmitter({ observer: noopObserver }),
  });

const hostileThrownValues = (): readonly unknown[] => {
  const revoked = Proxy.revocable(Object.create(null) as object, {});
  revoked.revoke();
  const trapping = new Proxy(Object.create(null) as object, {
    getOwnPropertyDescriptor: () => {
      throw new Error('thrown proxy descriptor trap must not run');
    },
  });
  return Object.freeze([revoked.proxy, trapping]);
};

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

  test('rethrows revoked and trapping Proxy binding errors unchanged with and without observation', async () => {
    const operation = operationFor({ skill: 'hostile-thrown-value' });
    const plan = planFor([operation]);
    for (const thrown of hostileThrownValues()) {
      const binding = {
        ...bindingFor(operation, []),
        execute: async () => {
          throw thrown;
        },
      };

      let unobserved: unknown;
      try {
        await requireScheduler()(plan, [binding]);
      } catch (error) {
        unobserved = error;
      }
      expect(unobserved).toBe(thrown);

      let observed: unknown;
      try {
        await scheduleOperationPlanObserved(plan, [binding] as never, {}, observationBundle());
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(thrown);
    }
  });

  test('admits only exact null-pair artifact prerequisite shapes', async () => {
    const live = operationFor({ skill: 'alpha' });
    const prerequisite = artifactOperationFor({ kind: 'migrate-ledger' });
    const plan = structuralPlanFor([prerequisite, live], 'fail-fast');
    const scheduleOperationPlan = requireScheduler();
    const calls: string[] = [];

    const results = await scheduleOperationPlan(
      plan,
      plan.operations.map((operation) => bindingFor(operation, calls)),
    );
    expect(calls).toEqual([prerequisite.operationId, live.operationId]);
    expect(results.map(({ outcome }) => outcome)).toEqual(['succeeded', 'succeeded']);

    const malformed = {
      ...prerequisite,
      mutates: { live: true, manifest: false, lock: false, ledger: true },
    } as ExecutableOperation;
    const malformedPlan = structuralPlanFor([malformed, live], 'fail-fast');
    const malformedCalls: string[] = [];
    await expect(
      scheduleOperationPlan(
        malformedPlan,
        malformedPlan.operations.map((operation) => bindingFor(operation, malformedCalls)),
      ),
    ).rejects.toThrow(/artifact.*mutation|null-pair.*shape/i);
    expect(malformedCalls).toEqual([]);
  });

  test('gates global ledger migration and same-group artifact failures', async () => {
    const scheduleOperationPlan = requireScheduler();
    const alpha = operationFor({ skill: 'alpha' });
    const beta = operationFor({ skill: 'beta' });
    const migration = artifactOperationFor({ kind: 'migrate-ledger' });
    const globalPlan = structuralPlanFor([migration, alpha, beta], 'continue-on-error');
    const globalCalls: string[] = [];
    const globalResults = await scheduleOperationPlan(
      globalPlan,
      globalPlan.operations.map((operation, index) => ({
        ...bindingFor(operation, []),
        execute: async () => {
          globalCalls.push(operation.operationId);
          return createOperationExecutionResult({
            operationId: operation.operationId,
            outcome: index === 0 ? 'failed' : 'succeeded',
            actualBefore: operation.before,
            actualAfter: index === 0 ? operation.before : operation.after,
            force: null,
            error:
              index === 0
                ? { code: 'fixture-failed', message: 'Fixture failed.', remediation: 'Retry.' }
                : null,
          });
        },
      })),
    );
    expect(globalCalls).toEqual([migration.operationId]);
    expect(globalResults.map(({ outcome }) => outcome)).toEqual([
      'failed',
      'skipped-after-failure',
      'skipped-after-failure',
    ]);

    const sameGroupAlpha = operationFor({ skill: 'alpha' });
    const lock = artifactOperationFor({ kind: 'write-lock', groupId: sameGroupAlpha.groupId });
    const independent = operationFor({ skill: 'beta' });
    const groupPlan = structuralPlanFor([lock, sameGroupAlpha, independent], 'continue-on-error');
    const groupCalls: string[] = [];
    const groupResults = await scheduleOperationPlan(
      groupPlan,
      groupPlan.operations.map((operation, index) => ({
        ...bindingFor(operation, []),
        execute: async () => {
          groupCalls.push(operation.operationId);
          return createOperationExecutionResult({
            operationId: operation.operationId,
            outcome: index === 0 ? 'failed' : 'succeeded',
            actualBefore: operation.before,
            actualAfter: index === 0 ? operation.before : operation.after,
            force: null,
            error:
              index === 0
                ? { code: 'fixture-failed', message: 'Fixture failed.', remediation: 'Retry.' }
                : null,
          });
        },
      })),
    );
    expect(groupCalls).toEqual([lock.operationId, independent.operationId]);
    expect(groupResults.map(({ outcome }) => outcome)).toEqual([
      'failed',
      'skipped-after-failure',
      'succeeded',
    ]);
  });

  test('continues independent doctor artifact repairs after ledger migration failure', async () => {
    const scheduleOperationPlan = requireScheduler();
    const migration = artifactOperationFor({ kind: 'migrate-ledger' });
    const manifest = artifactOperationFor({ kind: 'migrate-project-config' });
    const doctorPlan = {
      ...planFor([operationFor({ skill: 'doctor-shape' })]),
      command: 'doctor',
      batchPolicy: 'continue-on-error',
      operations: [migration, manifest],
    } as CurrentMutatorOperationPlan;
    const calls: string[] = [];

    const results = await scheduleOperationPlan(
      doctorPlan,
      doctorPlan.operations.map((operation, index) => ({
        ...bindingFor(operation, []),
        execute: async () => {
          calls.push(operation.operationId);
          return createOperationExecutionResult({
            operationId: operation.operationId,
            outcome: index === 0 ? 'failed' : 'succeeded',
            actualBefore: operation.before,
            actualAfter: index === 0 ? operation.before : operation.after,
            force: null,
            error:
              index === 0
                ? { code: 'fixture-failed', message: 'Fixture failed.', remediation: 'Retry.' }
                : null,
          });
        },
      })),
    );

    expect(calls).toEqual([migration.operationId, manifest.operationId]);
    expect(results.map(({ outcome }) => outcome)).toEqual(['failed', 'succeeded']);
  });
});
