import { describe, expect, test } from 'bun:test';
import { scheduleOperationPlanObserved } from '../../src/execution/scheduler.ts';
import * as publicCore from '../../src/index.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import type { ObserverEvent } from '../../src/observation/index.ts';
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
  readonly kind: 'migrate-ledger' | 'migrate-project-config' | 'write-manifest' | 'write-lock';
  readonly groupId?: string;
  readonly dependencies?: readonly string[];
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
        : input.kind === 'write-manifest'
          ? { kind: 'absent', resource: { kind: 'manifest-bytes', location: manifestLocation } }
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
        : input.kind === 'write-manifest'
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
      operationIds: input.dependencies ?? [],
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
        : input.kind === 'migrate-project-config' || input.kind === 'write-manifest'
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
  const dependencyFreeLive = {
    ...live,
    dependencyMetadata: { ...live.dependencyMetadata, operationIds: [] },
  };
  return Object.freeze({
    ...planFor([dependencyFreeLive]),
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

const observationBundle = (events?: ObserverEvent[]) =>
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
    emitter: createObservationEmitter({
      observer:
        events === undefined
          ? noopObserver
          : {
              observe: (event) => {
                events.push(event);
              },
            },
    }),
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

  test('refuses multi-operation pairs before work', async () => {
    const first = operationFor({ skill: 'alpha', kind: 'install' });
    const samePair = operationFor({
      skill: 'alpha',
      kind: 'repair',
      groupId: first.groupId,
      pairId: first.pairId as string,
    });
    const multiPairPlan = planFor([first, samePair]);
    const scheduleOperationPlan = requireScheduler();

    const multiPairCalls: string[] = [];
    await expect(
      scheduleOperationPlan(
        multiPairPlan,
        multiPairPlan.operations.map((operation) => bindingFor(operation, multiPairCalls)),
      ),
    ).rejects.toThrow(/pair.*exactly one|multi-operation pair|singleton/i);
    expect(multiPairCalls).toEqual([]);
  });

  test('runs only exact-succeeded dependents and continues independent work in the group', async () => {
    for (const rootOutcome of ['failed', 'rolled-back'] as const) {
      const root = operationFor({ skill: `alpha-${rootOutcome}` });
      const dependent = operationFor({
        skill: `alpha-dependent-${rootOutcome}`,
        groupId: root.groupId,
        dependencies: [root.operationId],
      });
      const independent = operationFor({
        skill: `alpha-independent-${rootOutcome}`,
        groupId: root.groupId,
      });
      const plan = structuralPlanFor([root, dependent, independent], 'continue-on-error');
      const calls: string[] = [];
      const events: ObserverEvent[] = [];
      const results = await scheduleOperationPlanObserved(
        plan,
        plan.operations.map((operation) => ({
          ...bindingFor(operation, []),
          execute: async () => {
            calls.push(operation.operationId);
            const isRoot = operation.operationId === root.operationId;
            const outcome = isRoot ? rootOutcome : 'succeeded';
            return createOperationExecutionResult({
              operationId: operation.operationId,
              outcome,
              actualBefore: operation.before,
              actualAfter: isRoot ? operation.before : operation.after,
              force: null,
              error:
                outcome === 'failed'
                  ? { code: 'fixture-failed', message: 'Fixture failed.', remediation: 'Retry.' }
                  : null,
            });
          },
        })) as never,
        {},
        observationBundle(events),
      );
      expect(calls).toEqual([root.operationId, independent.operationId]);
      expect(results.map(({ outcome }) => outcome)).toEqual([
        rootOutcome,
        'skipped-after-failure',
        'succeeded',
      ]);
      expect(events.some(({ operationId }) => operationId === dependent.operationId)).toBeFalse();
      expect(
        events
          .filter(({ kind }) => kind === 'operation.started')
          .map(({ operationId }) => operationId),
      ).toEqual([root.operationId, independent.operationId]);
    }
  });

  test('executes manifest, lock, and placement dependencies in order', async () => {
    const placementSeed = operationFor({ skill: 'alpha' });
    const manifest = artifactOperationFor({
      kind: 'write-manifest',
      groupId: placementSeed.groupId,
    });
    const lock = artifactOperationFor({
      kind: 'write-lock',
      groupId: placementSeed.groupId,
      dependencies: [manifest.operationId],
    });
    const placement = {
      ...placementSeed,
      dependencyMetadata: {
        ...placementSeed.dependencyMetadata,
        operationIds: [lock.operationId],
      },
    };
    const plan = structuralPlanFor([manifest, lock, placement], 'fail-fast');
    const calls: string[] = [];
    const results = await requireScheduler()(
      plan,
      plan.operations.map((operation) => bindingFor(operation, calls)),
    );
    expect(calls).toEqual(plan.operations.map(({ operationId }) => operationId));
    expect(results.every(({ outcome }) => outcome === 'succeeded')).toBeTrue();
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

  test('marks every remaining operation cancelled without starting or observing it', async () => {
    const plan = planFor([operationFor({ skill: 'beta' }), operationFor({ skill: 'alpha' })]);
    const controller = new AbortController();
    const calls: string[] = [];
    const events: ObserverEvent[] = [];
    const results = await scheduleOperationPlanObserved(
      plan,
      plan.operations.map((operation, index) => ({
        ...bindingFor(operation, []),
        execute: async () => {
          calls.push(operation.operationId);
          if (index === 0) controller.abort();
          return createOperationExecutionResult({
            operationId: operation.operationId,
            outcome: index === 0 ? 'cancelled' : 'succeeded',
            actualBefore: operation.before,
            actualAfter: index === 0 ? operation.before : operation.after,
            force: null,
            error: null,
          });
        },
      })) as never,
      { signal: controller.signal },
      observationBundle(events),
    );
    const firstOperation = plan.operations[0];
    if (firstOperation === undefined) throw new Error('missing first operation');
    expect(calls).toEqual([firstOperation.operationId]);
    expect(results.map(({ outcome }) => outcome)).toEqual(['cancelled', 'cancelled']);
    expect(events.some(({ operationId }) => operationId === plan.operations[1]?.operationId)).toBe(
      false,
    );
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

    const manifestWrite = artifactOperationFor({
      kind: 'write-manifest',
      groupId: live.groupId,
    });
    const legacyWrite = {
      ...manifestWrite,
      after:
        manifestWrite.after.kind === 'manifest'
          ? { ...manifestWrite.after, shape: 'legacy' as const }
          : manifestWrite.after,
    };
    const legacyPlan = structuralPlanFor([legacyWrite, live], 'fail-fast');
    const legacyCalls: string[] = [];
    await expect(
      scheduleOperationPlan(
        legacyPlan,
        legacyPlan.operations.map((operation) => bindingFor(operation, legacyCalls)),
      ),
    ).rejects.toThrow(/artifact.*mutation|null-pair.*shape/i);
    expect(legacyCalls).toEqual([]);
  });

  test('admits one conditional retained artifact only for update and undo manifest/lock writes', async () => {
    const live = operationFor({ skill: 'retained-artifact' });
    const manifest = artifactOperationFor({
      kind: 'write-manifest',
      groupId: live.groupId,
    });
    const retainedManifest: ExecutableOperation = {
      ...manifest,
      reversibility: {
        kind: 'conditional',
        retentionResourceIds: ['update-artifact-retention:v1:fixture'],
      },
    };
    const dependent: ExecutableOperation = {
      ...live,
      dependencyMetadata: {
        ...live.dependencyMetadata,
        operationIds: [manifest.operationId],
      },
    };
    const base = structuralPlanFor([retainedManifest, dependent], 'fail-fast');
    for (const command of ['update', 'undo'] as const) {
      const selected = {
        ...base,
        command,
        operations:
          command === 'undo'
            ? [
                {
                  ...retainedManifest,
                  mutates: { ...retainedManifest.mutates, ledger: true },
                },
                dependent,
              ]
            : base.operations,
      } as CurrentMutatorOperationPlan;
      const calls: string[] = [];
      const results = await requireScheduler()(
        selected,
        selected.operations.map((operation) => bindingFor(operation, calls)) as never,
      );
      expect(calls, command).toEqual(selected.operations.map(({ operationId }) => operationId));
      expect(
        results.every(({ outcome }) => outcome === 'succeeded'),
        command,
      ).toBeTrue();
    }

    const invalid = [
      { ...base, command: 'install' },
      {
        ...base,
        command: 'update',
        operations: [
          {
            ...retainedManifest,
            reversibility: {
              kind: 'conditional',
              retentionResourceIds: ['retention:one', 'retention:two'],
            },
          },
          dependent,
        ],
      },
      {
        ...base,
        command: 'update',
        operations: [
          {
            ...artifactOperationFor({ kind: 'migrate-ledger' }),
            reversibility: {
              kind: 'conditional',
              retentionResourceIds: ['retention:ledger'],
            },
          },
          live,
        ],
      },
    ] as CurrentMutatorOperationPlan[];
    for (const selected of invalid) {
      await expect(
        requireScheduler()(
          selected,
          selected.operations.map((operation) => bindingFor(operation, [])) as never,
        ),
      ).rejects.toThrow(/artifact.*reversibility/i);
    }
  });

  test('admits the exact init opaque replacement conflict and no other command', async () => {
    const seed = artifactOperationFor({ kind: 'write-manifest' });
    const machineLocation = { kind: 'machine-bound' as const, path: '/work/skillsmith.toml' };
    const operation: ExecutableOperation = {
      ...seed,
      before: {
        kind: 'opaque-manifest',
        location: machineLocation,
        shape: 'malformed',
        byteHash: CONTENT_HASH,
      },
      after:
        seed.after.kind === 'manifest' ? { ...seed.after, location: machineLocation } : seed.after,
      conflict: {
        class: 'destination-exists',
        normal: 'refuse',
        forced: 'backup-and-replace',
        target: { kind: 'manifest-bytes', location: machineLocation },
        backup: 'required',
      },
    };
    const initPlan = createOperationPlan({
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'init',
      selection: {
        source: 'bounded-default',
        skills: [],
        tools: [],
        scopes: [],
      },
      batchPolicy: 'fail-fast',
      operations: [operation],
      checks: [],
      diagnostics: [],
    });
    const calls: string[] = [];
    const results = await requireScheduler()(initPlan, [bindingFor(operation, calls)]);
    expect(results[0]?.outcome).toBe('succeeded');
    expect(calls).toEqual([operation.operationId]);

    const exportPlan = { ...initPlan, command: 'export' as const };
    await expect(requireScheduler()(exportPlan, [bindingFor(operation, [])])).rejects.toThrow(
      /invalid conflict/i,
    );
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

    const sameGroupAlphaSeed = operationFor({ skill: 'alpha' });
    const lock = artifactOperationFor({ kind: 'write-lock', groupId: sameGroupAlphaSeed.groupId });
    const sameGroupAlpha = {
      ...sameGroupAlphaSeed,
      dependencyMetadata: {
        ...sameGroupAlphaSeed.dependencyMetadata,
        operationIds: [lock.operationId],
      },
    };
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

    const prefixAlphaSeed = operationFor({ skill: 'alpha' });
    const prefixLock = artifactOperationFor({
      kind: 'write-lock',
      groupId: prefixAlphaSeed.groupId,
    });
    const prefixAlpha = {
      ...prefixAlphaSeed,
      dependencyMetadata: {
        ...prefixAlphaSeed.dependencyMetadata,
        operationIds: [prefixLock.operationId],
      },
    };
    const prefixedBetaSeed = operationFor({ skill: 'beta' });
    const prefixedBeta = {
      ...prefixedBetaSeed,
      dependencyMetadata: {
        ...prefixedBetaSeed.dependencyMetadata,
        operationIds: [prefixLock.operationId],
      },
    };
    const collisionPlan = structuralPlanFor(
      [prefixLock, prefixAlpha, prefixedBeta],
      'continue-on-error',
    );
    const collisionCalls: string[] = [];
    const collisionResults = await scheduleOperationPlan(
      collisionPlan,
      collisionPlan.operations.map((operation) => ({
        ...bindingFor(operation, []),
        execute: async () => {
          collisionCalls.push(operation.operationId);
          const failed = operation.operationId === prefixLock.operationId;
          return createOperationExecutionResult({
            operationId: operation.operationId,
            outcome: failed ? 'failed' : 'succeeded',
            actualBefore: operation.before,
            actualAfter: failed ? operation.before : operation.after,
            force: null,
            error: failed
              ? { code: 'fixture-failed', message: 'Fixture failed.', remediation: 'Retry.' }
              : null,
          });
        },
      })),
    );
    expect(collisionCalls).toEqual([prefixLock.operationId]);
    expect(collisionResults.map(({ outcome }) => outcome)).toEqual([
      'failed',
      'skipped-after-failure',
      'skipped-after-failure',
    ]);

    const laterGroup = operationFor({ skill: 'beta-forward-edge' }).groupId;
    const laterLock = artifactOperationFor({ kind: 'write-lock', groupId: laterGroup });
    const earlierLiveSeed = operationFor({ skill: 'alpha-forward-edge' });
    const earlierLive = {
      ...earlierLiveSeed,
      dependencyMetadata: {
        ...earlierLiveSeed.dependencyMetadata,
        operationIds: [laterLock.operationId],
      },
    };
    const laterEdgePlan = structuralPlanFor([earlierLive, laterLock], 'continue-on-error');
    const laterEdgeCalls: string[] = [];
    await expect(
      scheduleOperationPlan(
        laterEdgePlan,
        laterEdgePlan.operations.map((operation) => bindingFor(operation, laterEdgeCalls)),
      ),
    ).rejects.toThrow(/later artifact prefix/i);
    expect(laterEdgeCalls).toEqual([]);

    const firstGroup = operationFor({ skill: 'stale-prefix-a' }).groupId;
    const secondGroup = operationFor({ skill: 'stale-prefix-b' }).groupId;
    const thirdGroup = operationFor({ skill: 'stale-prefix-c' }).groupId;
    const firstLock = artifactOperationFor({ kind: 'write-lock', groupId: firstGroup });
    const secondLock = artifactOperationFor({
      kind: 'write-lock',
      groupId: secondGroup,
      dependencies: [firstLock.operationId],
    });
    const staleLive = operationFor({
      skill: 'stale-prefix',
      groupId: thirdGroup,
      dependencies: [firstLock.operationId],
    });
    const stalePrefixPlan = structuralPlanFor(
      [firstLock, secondLock, staleLive],
      'continue-on-error',
    );
    const stalePrefixCalls: string[] = [];
    await expect(
      scheduleOperationPlan(
        stalePrefixPlan,
        stalePrefixPlan.operations.map((operation) => bindingFor(operation, stalePrefixCalls)),
      ),
    ).rejects.toThrow(/latest|stale|prefix/i);
    expect(stalePrefixCalls).toEqual([]);
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
