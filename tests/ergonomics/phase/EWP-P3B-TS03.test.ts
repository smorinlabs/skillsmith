import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitCodeForClass } from '../../../packages/cli/src/runtime/adapter.ts';
import { selectApplicationExitClass } from '../../../packages/core/src/application/exit-policy.ts';
import type { SkillSmithError } from '../../../packages/core/src/errors.ts';
import * as publicCore from '../../../packages/core/src/index.ts';
import {
  type CurrentMutatorOperationPlan,
  type ExecutableOperation,
  type OperationDigest,
  type OperationExecutionResult,
  type OperationImage,
  type OperationSource,
  createBoundedForceEffect,
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
} from '../../../packages/core/src/index.ts';
import { getPair, readLedger } from '../../../packages/core/src/place/ledger.ts';
import { ledgerPathOf } from '../../../packages/core/src/place/paths.ts';
import { runPromote } from '../../../packages/core/src/place/run.ts';
import type {
  FlipDeps,
  FlipOptions,
  JournalPhase,
} from '../../../packages/core/src/place/types.ts';
import {
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../packages/core/tests/fixtures/place/fleet.ts';
import { SimulatedCrash, crashingEnv } from '../../../packages/core/tests/place/crash-env.ts';

type UnknownRecord = Record<string, unknown>;

interface FixtureCases {
  readonly schemaVersion: number;
  readonly fixtureCanary: string;
  readonly timeoutMs: number;
  readonly journalPhases: readonly string[];
  readonly protocol: Readonly<{
    accepts: readonly string[];
    emits: readonly string[];
  }>;
  readonly schedulerCases: readonly Readonly<{
    id: string;
    command: 'install';
    policy: 'fail-fast' | 'continue-on-error';
    operations: readonly Readonly<{
      skill: string;
      tool: 'claude-code' | 'codex';
      scope: 'user' | 'project';
    }>[];
    failureIndex: number | null;
    abortAfterIndex: number | null;
    expected: readonly ('succeeded' | 'failed' | 'skipped-after-failure' | 'cancelled')[];
  }>[];
}

const FIXTURES = join(import.meta.dir, '../fixtures/p3b-ts03');
const WORKER = join(FIXTURES, 'worker.ts');
const TIMEOUT_MS = 30_000;
const roots: string[] = [];
const core = publicCore as unknown as UnknownRecord;
const CONTENT_HASH = `sha256:${'a'.repeat(64)}` as OperationDigest;
const SOURCE: OperationSource = Object.freeze({
  kind: 'portable',
  identity: Object.freeze({
    host: 'example.test',
    repository: 'fixture/repo',
    path: 'skills/alpha',
  }),
  requestedRef: null,
  resolvedSha: 'b'.repeat(40),
  sourcePath: 'skills/alpha',
  contentHash: CONTENT_HASH,
});
const errorMessage = (error: SkillSmithError): string =>
  'message' in error ? error.message : error.code;
const crashDeps = (): FlipDeps => ({
  now: () => '2026-07-15T00:00:00.000Z',
  newTxId: () => 'aabbccdd',
  verify: async () => {
    throw new Error('P3B-TS03 no-verify fixture invoked verification');
  },
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = (): FixtureCases =>
  JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as FixtureCases;

const schedulerCase = (id: string): FixtureCases['schedulerCases'][number] => {
  const found = fixture().schedulerCases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing P3B-TS03 scheduler case ${id}`);
  return found;
};

const deadline = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const record = (value: unknown, label: string): Readonly<UnknownRecord> => {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), label).toBeTrue();
  return value as Readonly<UnknownRecord>;
};

const spawnWorker = (root: string, transcript: string[]) => {
  const queue: Readonly<UnknownRecord>[] = [];
  let notify: (() => void) | null = null;
  const child = Bun.spawn([process.execPath, WORKER], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
    ipc(message) {
      const item = record(message, 'worker messages are plain records');
      const kind = String(item.kind);
      const role = typeof item.role === 'string' ? item.role : 'worker';
      transcript.push(`${role}:${kind}`);
      queue.push(item);
      notify?.();
      notify = null;
    },
  });

  const receiveAny = async (kinds: readonly string[]): Promise<Readonly<UnknownRecord>> => {
    for (;;) {
      const failure = queue.find((item) => item.kind === 'fixture-error');
      if (failure !== undefined) throw new Error(`worker fixture error: ${String(failure.reason)}`);
      const index = queue.findIndex(
        (item) => typeof item.kind === 'string' && kinds.includes(item.kind),
      );
      if (index >= 0) return queue.splice(index, 1)[0] as Readonly<UnknownRecord>;
      await deadline(
        new Promise<void>((resolve) => {
          notify = resolve;
        }),
        `worker ${kinds.join('|')}`,
      );
    }
  };

  const receive = (kind: string): Promise<Readonly<UnknownRecord>> => receiveAny([kind]);
  return { child, receive, receiveAny };
};

const stopWorker = async (worker: ReturnType<typeof spawnWorker> | undefined): Promise<void> => {
  if (worker === undefined) return;
  worker.child.kill();
  await deadline(worker.child.exited, 'worker cleanup');
};

const requireFunction = (name: string): ((input: unknown) => unknown) => {
  const candidate = core[name];
  expect(typeof candidate, `missing G3B-02 public ${name} behavior`).toBe('function');
  return candidate as (input: unknown) => unknown;
};

type ScheduleOperationPlan = (
  plan: CurrentMutatorOperationPlan,
  bindings: readonly UnknownRecord[],
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<readonly OperationExecutionResult[]>;

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

type ExecuteOperationPlan = (
  request: Readonly<{
    plan: CurrentMutatorOperationPlan;
    bindings: readonly UnknownRecord[];
    preconditions: readonly UnknownRecord[];
    locks: readonly UnknownRecord[];
    lockPort: Readonly<{
      withFileLock<T>(
        path: string,
        operation: () => Promise<T>,
        options?: Readonly<{ signal?: AbortSignal }>,
      ): Promise<T>;
    }>;
    signal?: AbortSignal;
  }>,
) => Promise<readonly OperationExecutionResult[]>;

const scheduleAuthority = (): ScheduleOperationPlan =>
  requireFunction('scheduleOperationPlan') as unknown as ScheduleOperationPlan;

const operationFor = (
  input: Readonly<{
    skill: string;
    tool: 'claude-code' | 'codex';
    scope?: 'user' | 'project';
    kind?: 'install' | 'repair';
    groupId?: string;
    pairId?: string;
    dependencies?: readonly string[];
    preconditionIds?: readonly string[];
  }>,
): ExecutableOperation => {
  const scope = input.scope ?? 'user';
  const kind = input.kind ?? 'install';
  const projectRoot =
    scope === 'project' ? ({ kind: 'machine-bound', path: '/fixture/project' } as const) : null;
  const groupId =
    input.groupId ??
    createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'install',
      skill: input.skill,
      source: SOURCE,
      scope,
      target: scope === 'project' ? '/fixture/project' : null,
    });
  const resource = {
    kind: 'live',
    skill: input.skill,
    tool: input.tool,
    scope,
    projectRoot,
    location: {
      kind: 'portable',
      token: `skills/${scope}/${input.tool}/${input.skill}`,
    },
  } as const;
  const pairId =
    input.pairId ??
    createOperationPairId({
      domain: 'skillsmith.operation-pair-identity',
      schemaVersion: 1,
      groupId,
      tool: input.tool,
      resource,
    });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId,
    kind,
    skill: input.skill,
    source: SOURCE,
    tool: input.tool,
    scope,
  });
  const before: OperationImage = { kind: 'absent', resource };
  const after: OperationImage = {
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
    tool: input.tool,
    scope,
    before,
    after,
    reason: { code: `${kind}-selected`, message: `${kind} selected by P3B-TS03 fixture.` },
    selectionSource: 'explicit-targets',
    preconditionIds: input.preconditionIds ?? ['precondition:v1:fixture'],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const planFor = (
  operations: readonly ExecutableOperation[],
  batchPolicy: 'fail-fast' | 'continue-on-error' = 'fail-fast',
): CurrentMutatorOperationPlan =>
  createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'install',
    selection: {
      source: 'explicit-targets',
      skills: [...new Set(operations.flatMap((operation) => operation.skill ?? []))],
      tools: [...new Set(operations.flatMap((operation) => operation.tool ?? []))],
      scopes: [...new Set(operations.flatMap((operation) => operation.scope ?? []))],
    },
    batchPolicy,
    operations,
    checks: [],
    diagnostics: [],
  });

const bindingFor = (
  operation: ExecutableOperation,
  calls: string[],
  outcome: 'succeeded' | 'failed' = 'succeeded',
  afterExecute?: () => void,
  unstartedForce: unknown = null,
): UnknownRecord => ({
  operationId: operation.operationId,
  groupId: operation.groupId,
  pairId: operation.pairId,
  actualBefore: operation.before,
  unstartedForce,
  execute: async () => {
    calls.push(operation.operationId);
    afterExecute?.();
    return createOperationExecutionResult({
      operationId: operation.operationId,
      outcome,
      actualBefore: operation.before,
      actualAfter: outcome === 'failed' ? operation.before : operation.after,
      force: null,
      error:
        outcome === 'failed'
          ? {
              code: 'fixture-pair-failure',
              message: 'P3B-TS03 fixture pair failed.',
              remediation: 'Rerun the same command after correcting the fixture condition.',
            }
          : null,
    });
  },
});

describe('EWP-P3B-TS03', () => {
  test('guards the closed bounded process and scheduler fixture', () => {
    const cases = fixture();
    expect(cases).toMatchObject({
      schemaVersion: 1,
      fixtureCanary: 'p3b-ts03-fixture-canary',
      timeoutMs: 30_000,
    });
    expect(cases.journalPhases).toEqual(['prepared', 'staged', 'backed-up', 'live', 'committed']);
    expect(new Set(cases.schedulerCases.map((item) => item.id)).size).toBe(4);
    expect(cases.schedulerCases.every((item) => item.command === 'install')).toBeTrue();
    expect(cases.schedulerCases.flatMap((item) => item.operations).length).toBe(11);
    expect(cases.schedulerCases.flatMap((item) => item.expected)).toContain(
      'skipped-after-failure',
    );
    expect(cases.protocol).toEqual({
      accepts: ['start', 'release', 'cancel'],
      emits: [
        'fixture-ready',
        'attempting',
        'acquired',
        'callback-complete',
        'cancel-ack',
        'cancelled',
        'completed',
        'fixture-error',
      ],
    });

    const selfCheck = Bun.spawnSync([process.execPath, WORKER, '--self-check'], {
      cwd: join(import.meta.dir, '../../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(selfCheck.exitCode, selfCheck.stderr.toString()).toBe(0);
    expect(JSON.parse(selfCheck.stdout.toString())).toMatchObject({
      kind: 'p3b-ts03-worker-self-check',
      protocolVersion: 1,
      target: 'placements.json',
      timeoutMs: 30_000,
    });
  });

  test('serializes two real processes on the historical placements target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts03-'));
    roots.push(root);
    const target = join(root, 'placements.json');
    await writeFile(target, '{"fixture":"p3b-ts03"}\n');
    const transcript: string[] = [];
    const holder = spawnWorker(root, transcript);
    let contender: ReturnType<typeof spawnWorker> | undefined;
    try {
      await holder.receive('fixture-ready');
      holder.child.send({ kind: 'start', role: 'holder' });
      await holder.receive('attempting');
      await holder.receive('acquired');

      contender = spawnWorker(root, transcript);
      await contender.receive('fixture-ready');
      contender.child.send({ kind: 'start', role: 'contender' });
      await contender.receive('attempting');
      holder.child.send({ kind: 'release', role: 'holder' });
      await holder.receive('callback-complete');
      await contender.receive('acquired');
      await contender.receive('callback-complete');
      await Promise.all([holder.receive('completed'), contender.receive('completed')]);

      const [holderExit, contenderExit] = await deadline(
        Promise.all([holder.child.exited, contender.child.exited]),
        'worker exits',
      );
      expect(holderExit).toBe(0);
      expect(contenderExit).toBe(0);
      expect(transcript.indexOf('contender:acquired')).toBeGreaterThan(
        transcript.indexOf('holder:callback-complete'),
      );
      expect(await readFile(target, 'utf8')).toBe('{"fixture":"p3b-ts03"}\n');
      expect(existsSync(`${target}.lock`)).toBeFalse();
    } finally {
      await Promise.all([stopWorker(holder), stopWorker(contender)]);
    }
  });

  test('preserves waiting-process cancellation without entering its callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts03-'));
    roots.push(root);
    await writeFile(join(root, 'placements.json'), '{"fixture":"p3b-ts03"}\n');
    const transcript: string[] = [];
    const holder = spawnWorker(root, transcript);
    let contender: ReturnType<typeof spawnWorker> | undefined;
    try {
      await holder.receive('fixture-ready');
      holder.child.send({ kind: 'start', role: 'holder' });
      await holder.receive('attempting');
      await holder.receive('acquired');

      contender = spawnWorker(root, transcript);
      await contender.receive('fixture-ready');
      contender.child.send({ kind: 'start', role: 'cancellable-contender' });
      await contender.receive('attempting');
      contender.child.send({ kind: 'cancel', role: 'cancellable-contender' });
      await contender.receive('cancel-ack');
      holder.child.send({ kind: 'release', role: 'holder' });
      await holder.receive('completed');
      const disposition = await contender.receiveAny(['cancelled', 'acquired']);
      expect(disposition).toMatchObject({
        kind: 'cancelled',
        role: 'cancellable-contender',
        code: 'cancelled',
      });
      expect(transcript).not.toContain('cancellable-contender:callback-complete');
      await contender.receive('completed');
    } finally {
      await Promise.all([stopWorker(holder), stopWorker(contender)]);
    }
  });

  test('cancels an already-aborted lock request without invoking its callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts03-'));
    roots.push(root);
    const target = join(root, 'placements.json');
    await writeFile(target, '{"fixture":"p3b-ts03"}\n');
    const ports = await publicCore.defaultRuntimePorts();
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    let failure: unknown;
    const withSignal = ports.withFileLock as unknown as (
      path: string,
      operation: () => Promise<void>,
      options: Readonly<{ signal: AbortSignal }>,
    ) => Promise<void>;
    try {
      await withSignal(
        target,
        async () => {
          invoked = true;
        },
        Object.freeze({ signal: controller.signal }),
      );
    } catch (error) {
      failure = error;
    }
    expect(invoked, 'an aborted lock request invoked the mutation callback').toBeFalse();
    expect(failure).toMatchObject({ capability: 'lock', operation: 'withFileLock' });
  });

  test('exposes the neutral scheduler, lock, precondition, and coordinator surface', () => {
    for (const name of [
      'scheduleOperationPlan',
      'createExecutionPrecondition',
      'validateExecutionPreconditions',
      'withExecutionLockHierarchy',
      'executeOperationPlan',
    ]) {
      requireFunction(name);
    }
  });

  test('refuses dependency-bearing and multi-operation pair scheduling in this slice', async () => {
    const scheduleOperationPlan = scheduleAuthority();
    const first = operationFor({ skill: 'alpha', tool: 'claude-code' });
    const second = operationFor({
      skill: 'alpha',
      tool: 'claude-code',
      kind: 'repair',
      groupId: first.groupId,
      pairId: first.pairId ?? undefined,
      dependencies: [first.operationId],
    });
    const plan = planFor([first, second]);
    const calls: string[] = [];
    await expect(
      scheduleOperationPlan(
        plan,
        plan.operations.map((operation) => bindingFor(operation, calls)),
      ),
    ).rejects.toThrow(/dependency|one operation per pair|multi-operation/i);
    expect(calls).toEqual([]);
  });

  test('attempts every pair in a started group before applying later-group policy', async () => {
    const scheduleOperationPlan = scheduleAuthority();
    const execute = async (caseId: string) => {
      const scenario = schedulerCase(caseId);
      const plan = planFor(
        scenario.operations.map((operation) => operationFor(operation)),
        scenario.policy,
      );
      expect(plan.command).toBe(scenario.command);
      const calls: string[] = [];
      const unstartedForce = createBoundedForceEffect({
        supported: true,
        requested: true,
        conflict: null,
      });
      const results = await scheduleOperationPlan(
        plan,
        plan.operations.map((operation, index) =>
          bindingFor(
            operation,
            calls,
            index === scenario.failureIndex ? 'failed' : 'succeeded',
            undefined,
            index === 2 ? unstartedForce : null,
          ),
        ),
      );
      return { scenario, plan, calls, results, unstartedForce };
    };

    const stopped = await execute('fail-fast-later-group');
    expect(stopped.calls).toEqual(
      stopped.plan.operations.slice(0, 2).map((operation) => operation.operationId),
    );
    expect(stopped.results.map((result) => result.outcome)).toEqual(stopped.scenario.expected);
    expect(stopped.results[2]?.actualAfter).toEqual(stopped.results[2]?.actualBefore);
    expect(stopped.results[2]?.force).toEqual(stopped.unstartedForce);
    expect(stopped.results[2]?.force?.applied).toBeFalse();
    expect(Object.isFrozen(stopped.results[2]?.force)).toBeTrue();

    const continued = await execute('continue-later-group');
    expect(continued.calls).toEqual(
      continued.plan.operations.map((operation) => operation.operationId),
    );
    expect(continued.results.map((result) => result.outcome)).toEqual(continued.scenario.expected);
  });

  test('preserves canonical scheduling order across equivalent input permutations', async () => {
    const scheduleOperationPlan = scheduleAuthority();
    const operations = [
      operationFor({ skill: 'beta', tool: 'codex' }),
      operationFor({ skill: 'alpha', tool: 'claude-code' }),
      operationFor({ skill: 'alpha', tool: 'codex' }),
    ];
    const plans = [planFor(operations), planFor(operations.toReversed())];
    expect(plans[1]?.operations.map(({ operationId }) => operationId)).toEqual(
      plans[0]?.operations.map(({ operationId }) => operationId),
    );

    const executions = await Promise.all(
      plans.map(async (plan) => {
        const calls: string[] = [];
        const results = await scheduleOperationPlan(
          plan,
          plan.operations.map((operation) => bindingFor(operation, calls)),
        );
        return { calls, ids: results.map(({ operationId }) => operationId) };
      }),
    );
    expect(executions[1]).toEqual(executions[0]);
  });

  test('cancellation between pairs stops all remaining work and retains exit 130', async () => {
    const scheduleOperationPlan = scheduleAuthority();
    const scenario = schedulerCase('cancel-between-pairs');
    const controller = new AbortController();
    const plan = planFor(
      scenario.operations.map((operation) => operationFor(operation)),
      scenario.policy,
    );
    expect(plan.command).toBe(scenario.command);
    const calls: string[] = [];
    const results = await scheduleOperationPlan(
      plan,
      plan.operations.map((operation, index) =>
        bindingFor(
          operation,
          calls,
          'succeeded',
          index === scenario.abortAfterIndex ? () => controller.abort() : undefined,
        ),
      ),
      { signal: controller.signal },
    );

    expect(calls).toEqual([plan.operations[0]?.operationId]);
    expect(results.map((result) => result.outcome)).toEqual(scenario.expected);
    expect(selectApplicationExitClass(['failure', 'cancelled'])).toBe('cancelled');
    expect(exitCodeForClass('cancelled')).toBe(130);
  });

  test('executes identical names at distinct scopes once under distinct identities', async () => {
    const scheduleOperationPlan = scheduleAuthority();
    const scenario = schedulerCase('same-name-distinct-scope');
    const plan = planFor(
      scenario.operations.map((operation) => operationFor(operation)),
      scenario.policy,
    );
    expect(plan.command).toBe(scenario.command);
    const calls: string[] = [];
    const results = await scheduleOperationPlan(
      plan,
      plan.operations.map((operation) => bindingFor(operation, calls)),
    );

    expect(new Set(plan.operations.map((operation) => operation.groupId)).size).toBe(2);
    expect(new Set(plan.operations.map((operation) => operation.operationId)).size).toBe(2);
    expect(calls).toEqual(plan.operations.map((operation) => operation.operationId));
    expect(results.map((result) => result.operationId)).toEqual(calls);
    expect(results.map((result) => result.outcome)).toEqual(scenario.expected);
  });

  test('refuses duplicate, extra, dangling, and operation-mismatched precondition coverage', async () => {
    const createExecutionPrecondition = requireFunction(
      'createExecutionPrecondition',
    ) as unknown as CreateExecutionPrecondition;
    const validateExecutionPreconditions = requireFunction(
      'validateExecutionPreconditions',
    ) as unknown as ValidateExecutionPreconditions;
    const seed = operationFor({ skill: 'alpha', tool: 'codex', preconditionIds: [] });
    let observations = 0;
    const create = (operationIds: readonly string[], marker: string) =>
      createExecutionPrecondition({
        operationIds,
        resource: seed.before.resource,
        expected: { marker },
        observe: async () => {
          observations += 1;
          return { marker };
        },
      });
    const primary = create([seed.operationId], 'primary');
    const extra = create([seed.operationId], 'extra');
    const other = operationFor({ skill: 'beta', tool: 'codex', preconditionIds: [] });
    const mismatched = create([other.operationId], 'mismatched');
    const primaryId = String(primary.preconditionId);
    const cases = [
      {
        label: 'duplicate',
        plan: planFor([
          operationFor({ skill: 'alpha', tool: 'codex', preconditionIds: [primaryId] }),
        ]),
        registry: [primary, primary],
      },
      {
        label: 'extra',
        plan: planFor([
          operationFor({ skill: 'alpha', tool: 'codex', preconditionIds: [primaryId] }),
        ]),
        registry: [primary, extra],
      },
      {
        label: 'dangling',
        plan: planFor([
          operationFor({
            skill: 'alpha',
            tool: 'codex',
            preconditionIds: [primaryId, `precondition:v1:${'f'.repeat(64)}`],
          }),
        ]),
        registry: [primary],
      },
      {
        label: 'operation mismatch',
        plan: planFor([
          operationFor({
            skill: 'alpha',
            tool: 'codex',
            preconditionIds: [String(mismatched.preconditionId)],
          }),
        ]),
        registry: [mismatched],
      },
    ];

    for (const candidate of cases) {
      await expect(
        validateExecutionPreconditions(candidate.plan, candidate.registry),
      ).rejects.toThrow(/precondition|coverage|duplicate|operation/i);
      expect(observations, `${candidate.label} observer count`).toBe(0);
    }
  });

  test('rereads and validates under lock before executing the exact prepared binding', async () => {
    const createExecutionPrecondition = requireFunction(
      'createExecutionPrecondition',
    ) as unknown as CreateExecutionPrecondition;
    const executeOperationPlan = requireFunction(
      'executeOperationPlan',
    ) as unknown as ExecuteOperationPlan;
    const seed = operationFor({ skill: 'alpha', tool: 'codex', preconditionIds: [] });
    const expected = Object.freeze({
      command: 'install',
      operationId: seed.operationId,
      groupId: seed.groupId,
      pairId: seed.pairId,
      tool: seed.tool,
      skill: seed.skill,
      scope: seed.scope,
      projectRoot: null,
      live: Object.freeze({ pathKind: 'absent', canonicalPath: '/fixture/live/alpha' }),
      ledger: Object.freeze({ pair: null, journal: null }),
    });
    const events: string[] = [];
    const precondition = createExecutionPrecondition({
      operationIds: [seed.operationId],
      resource: seed.before.resource,
      expected,
      observe: async () => {
        events.push('reread');
        return structuredClone(expected);
      },
    });
    const operation = operationFor({
      skill: 'alpha',
      tool: 'codex',
      preconditionIds: [String(precondition.preconditionId)],
    });
    const plan = planFor([operation]);
    const calls: string[] = [];
    const results = await executeOperationPlan({
      plan,
      bindings: [
        {
          ...bindingFor(operation, calls),
          execute: async () => {
            events.push('execute');
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
        },
      ],
      preconditions: [precondition],
      locks: [{ rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' }],
      lockPort: {
        withFileLock: async (_path, callback) => {
          events.push('acquire');
          try {
            return await callback();
          } finally {
            events.push('release');
          }
        },
      },
    });

    expect(events).toEqual(['acquire', 'reread', 'execute', 'release']);
    expect(calls).toEqual([operation.operationId]);
    expect(results[0]?.operationId).toBe(operation.operationId);
  });

  test('changed approved facts refuse with zero writes, zero binding calls, and no replan', async () => {
    const createExecutionPrecondition = requireFunction(
      'createExecutionPrecondition',
    ) as unknown as CreateExecutionPrecondition;
    const executeOperationPlan = requireFunction(
      'executeOperationPlan',
    ) as unknown as ExecuteOperationPlan;
    const seed = operationFor({ skill: 'alpha', tool: 'codex', preconditionIds: [] });
    const expected = { live: { pathKind: 'absent', canonicalPath: '/fixture/live/alpha' } };
    let observations = 0;
    let bindingCalls = 0;
    const precondition = createExecutionPrecondition({
      operationIds: [seed.operationId],
      resource: seed.before.resource,
      expected,
      observe: async () => {
        observations += 1;
        return { live: { pathKind: 'file', canonicalPath: '/fixture/live/alpha' } };
      },
    });
    const operation = operationFor({
      skill: 'alpha',
      tool: 'codex',
      preconditionIds: [String(precondition.preconditionId)],
    });
    const plan = planFor([operation]);

    await expect(
      executeOperationPlan({
        plan,
        bindings: [
          {
            ...bindingFor(operation, []),
            execute: async () => {
              bindingCalls += 1;
              throw new Error('changed precondition invoked its binding');
            },
          },
        ],
        preconditions: [precondition],
        locks: [{ rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' }],
        lockPort: { withFileLock: async (_path, callback) => callback() },
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/state|precondition/i) });
    expect(observations).toBe(1);
    expect(bindingCalls).toBe(0);
    expect(plan.operations).toEqual([operation]);
  });

  test('same-command rerun converges every existing journal crash phase under ledger v1', async () => {
    const run = async (
      crashAt: number,
    ): Promise<Readonly<{ calls: number; phase: JournalPhase | 'none' }>> => {
      const fleet = await buildFixtureFleet();
      try {
        const options: FlipOptions = {
          targets: ['alpha'],
          cwd: fleet.home,
          configuration: fleet.configuration,
          noVerify: true,
        };
        const crash = crashingEnv(fleet.env, crashAt);
        try {
          await runPromote(crash.env, options, crashDeps());
        } catch (error) {
          if (!(error instanceof SimulatedCrash)) throw error;
        }

        const ledgerPath = ledgerPathOf(fleet.data);
        let phase: JournalPhase | 'none' = 'none';
        if ((await fleet.env.pathKind(ledgerPath)) !== 'absent') {
          const crashedLedger = await readLedger(fleet.env, ledgerPath);
          if (!crashedLedger.ok) throw new Error(errorMessage(crashedLedger.error));
          phase = getPair(crashedLedger.value, 'alpha', 'claude-code')?.journal?.phase ?? 'none';
        }

        if (crashAt > 0) {
          const converged = await runPromote(fleet.env, options, crashDeps());
          if (!converged.ok) throw new Error(errorMessage(converged.error));
          expect(converged.value.results.some((result) => result.action === 'failed')).toBeFalse();
          expect(await fleet.env.pathKind(join(fleet.home, '.claude', 'skills', 'alpha'))).toBe(
            'dir',
          );
          const settled = await readLedger(fleet.env, ledgerPath);
          if (!settled.ok) throw new Error(errorMessage(settled.error));
          expect(getPair(settled.value, 'alpha', 'claude-code')?.journal).toMatchObject({
            phase: 'committed',
            completedAt: expect.any(String),
          });
        }
        return { calls: crash.calls(), phase };
      } finally {
        await destroyFixtureFleet(fleet);
      }
    };

    const clean = await run(0);
    expect(clean.calls).toBeGreaterThan(0);
    const observed = new Set<JournalPhase | 'none'>();
    for (let crashAt = 1; crashAt <= clean.calls; crashAt++) {
      observed.add((await run(crashAt)).phase);
    }
    for (const phase of fixture().journalPhases) {
      expect(observed.has(phase), `unvisited crash phase ${phase}`).toBeTrue();
    }
  }, 30_000);
});
