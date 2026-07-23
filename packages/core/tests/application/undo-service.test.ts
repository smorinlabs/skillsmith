import { describe, expect, test } from 'bun:test';
import type {
  CurrentApplicationContext,
  CurrentCommandRequest,
  InteractionPort,
} from '../../src/application/types.ts';
import {
  type UndoApplicationDependencies,
  createUndoApplicationService,
} from '../../src/application/undo-service.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import { createPlanningDiagnosticId } from '../../src/planning/create.ts';
import type { ExecutableOperation, OperationExecutionResult } from '../../src/planning/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { err, ok } from '../../src/result.ts';
import type { PreparedUndoPlan, UndoObservation, UndoPlanGroup } from '../../src/undo/types.ts';

const observation = Object.freeze({
  context: createOperationContext({
    command: 'skillsmith undo',
    workflow: 'undo',
    clock: { wallNowIso: () => '2026-07-22T00:00:00.000Z', monotonicMilliseconds: () => 0 },
    id: { nextId: () => 'undo-test-operation' },
  }),
  emitter: createObservationEmitter({ observer: noopObserver }),
});

const interaction = (confirm: InteractionPort['confirm']): InteractionPort => ({
  mode: 'interactive',
  choose: async () => ({ status: 'refused', reason: 'not used' }),
  confirm,
});

const context = (
  selectedInteraction: InteractionPort = interaction(async () => ({
    status: 'resolved',
    value: true,
  })),
): CurrentApplicationContext => ({
  observation,
  ports: {} as RuntimePorts,
  artifactCoordinator: {} as CurrentApplicationContext['artifactCoordinator'],
  configuration: resolveRuntimeConfiguration({ SKILLSMITH_HOME: '/fixture/data' }),
  interaction: selectedInteraction,
  invocationCwd: '/fixture/project',
  globalOptions: {},
  projectContext: {
    invocationCwd: '/fixture/project',
    effectiveCwd: '/fixture/project',
    projectRoot: '/fixture/project',
    projectIdentity: '/fixture/project',
    projectKind: 'git',
    discoveredConfigPath: null,
    explicitConfigPath: null,
  },
});

const resource = {
  kind: 'live' as const,
  skill: 'review',
  tool: 'claude-code' as const,
  scope: 'project' as const,
  projectRoot: { kind: 'machine-bound' as const, path: '/fixture/project' },
  location: {
    kind: 'machine-bound' as const,
    path: '/fixture/project/.claude/skills/review',
  },
};
const before = {
  kind: 'placement' as const,
  resource,
  classification: 'pinned' as const,
  representation: 'copy' as const,
  linkTarget: null,
  dangling: false,
  source: null,
  contentHash: `sha256:${'b'.repeat(64)}` as const,
};
const after = {
  kind: 'placement' as const,
  resource,
  classification: 'dev' as const,
  representation: 'symlink' as const,
  linkTarget: { kind: 'machine-bound' as const, path: '/fixture/source/review' },
  dangling: false,
  source: {
    kind: 'local-dev' as const,
    path: '/fixture/source/review',
    contentHash: `sha256:${'a'.repeat(64)}` as const,
  },
  contentHash: `sha256:${'a'.repeat(64)}` as const,
};

const operation = (): ExecutableOperation => ({
  operationId: 'operation:v1:undo-review',
  groupId: 'group:v1:undo-review',
  pairId: 'pair:v1:undo-review',
  kind: 'link-dev',
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: [],
  },
  skill: 'review',
  source: after.source,
  tool: 'claude-code',
  scope: 'project',
  before,
  after,
  reason: { code: 'undo-promote', message: 'Restore the retained development placement.' },
  selectionSource: 'explicit-targets',
  preconditionIds: [],
  requiredCheckIds: [],
  reversibility: { kind: 'conditional', retentionResourceIds: ['store:v1:review'] },
  mutates: { live: true, manifest: false, lock: false, ledger: true },
  conflict: null,
});

const prepared = (changing: boolean, executed = { value: 0 }): PreparedUndoPlan => {
  const planned = operation();
  const request = {
    targets: changing ? ['review'] : [],
    all: !changing,
    tools: ['claude-code'] as const,
    scopes: ['project'] as const,
    dryRun: false,
    yes: false,
    continueOnError: false,
  };
  const domainObservation = {
    request,
    selection: {
      source: changing ? ('explicit-targets' as const) : ('explicit-all' as const),
      outcome: changing ? ('selected' as const) : ('filter-noop' as const),
      reason: changing ? null : 'active filters matched no reversible placement',
      targets: request.targets,
      tools: request.tools,
      scopes: request.scopes,
    },
    projectContext: context().projectContext,
    candidates: [],
  } as unknown as UndoObservation;
  const plan = {
    domain: 'skillsmith.operation-plan' as const,
    schemaVersion: 1 as const,
    command: 'undo' as const,
    selection: {
      source: domainObservation.selection.source,
      outcome: domainObservation.selection.outcome,
      targets: request.targets,
      all: request.all,
      tools: request.tools,
      scopes: request.scopes,
      groupIds: changing ? [planned.groupId] : [],
    },
    batchPolicy: 'fail-fast' as const,
    operations: changing ? [planned] : [],
    checks: [],
    diagnostics: [],
  };
  const groups: readonly UndoPlanGroup[] = changing
    ? [
        {
          name: 'review',
          scope: 'project',
          groupId: planned.groupId,
          pairs: [
            {
              pairId: 'pair:v1:undo-review',
              tool: 'claude-code',
              path: '/fixture/project/.claude/skills/review',
              action: 'reverse-committed',
              operationFamily: 'promote',
              disposition: 'rollback',
              phase: 'committed',
              executionMode: 'resume-rollback',
              beforeState: 'pinned',
              eligibility: 'eligible',
              retention: { required: true, resourceIds: ['store:v1:review'] },
              sourceTransactionId: 'transaction:v1:source',
              activeTransactionId: 'transaction:v1:undo',
              sourceOperationId: 'operation:v1:source',
              activeOperationId: planned.operationId,
              parentOperationId: 'operation:v1:source',
              operationIds: [planned.operationId],
              operations: [planned],
              outcome: 'planned',
              failure: null,
            },
          ],
          operationIds: [planned.operationId],
          operations: [planned],
          outcome: 'planned',
          failure: null,
        },
      ]
    : [];
  const result: OperationExecutionResult = {
    operationId: planned.operationId,
    outcome: 'succeeded',
    actualBefore: before,
    actualAfter: after,
    force: null,
    error: null,
  };
  return {
    observation: domainObservation,
    plan,
    groups,
    execute: async () => {
      executed.value++;
      return ok({ results: changing ? [result] : [], warnings: [] });
    },
  };
};

const cleanupPrepared = (
  executed = { value: 0 },
  warning = false,
  carrier?: { durable: boolean },
): PreparedUndoPlan => {
  const base = prepared(true);
  const sourceGroup = base.groups[0];
  const sourcePair = sourceGroup?.pairs[0];
  if (sourceGroup === undefined || sourcePair === undefined) {
    throw new Error('cleanup fixture requires one source pair');
  }
  const groupId = `group:v1:${'1'.repeat(64)}`;
  const pairId = `pair:v1:${'2'.repeat(64)}`;
  const pair = {
    ...sourcePair,
    pairId,
    eligibility: 'already-reversed' as const,
    operationIds: [],
    operations: [],
    outcome: 'already-reversed' as const,
  };
  const group = {
    ...sourceGroup,
    groupId,
    pairs: [pair],
    operationIds: [],
    operations: [],
    outcome: 'already-reversed' as const,
  };
  const affected = {
    skill: group.name,
    source: null,
    tool: pair.tool,
    scope: group.scope,
    path: { kind: 'machine-bound' as const, path: pair.path },
  };
  const correlation = { groupId, pairId, operationId: null };
  const diagnostic = {
    diagnosticId: createPlanningDiagnosticId({
      domain: 'skillsmith.planning-diagnostic-identity',
      schemaVersion: 1,
      kind: 'warning',
      severity: 'warning',
      refusalClass: null,
      affected,
      correlation,
      reasonCode: 'undo-cleanup-pending',
      selectionSource: 'explicit-targets',
    }),
    kind: 'warning' as const,
    severity: 'warning' as const,
    refusalClass: null,
    affected,
    correlation,
    reason: {
      code: 'undo-cleanup-pending',
      message: "Committed undo cleanup remains pending for 'review' on claude-code.",
    },
    selectionSource: 'explicit-targets' as const,
  };
  return {
    ...base,
    plan: {
      ...base.plan,
      selection: { ...base.plan.selection, groupIds: [groupId] },
      operations: [],
      diagnostics: [diagnostic],
    },
    groups: [group],
    execute: async () => {
      executed.value++;
      if (carrier !== undefined) carrier.durable = false;
      return ok({
        results: [],
        warnings: warning
          ? [
              {
                code: 'undo-cleanup-retained' as const,
                message: 'Undo cleanup retained a mismatched backup for manual inspection.',
              },
            ]
          : [],
      });
    },
  };
};

const request = (options: CurrentCommandRequest['options']): CurrentCommandRequest => ({
  arguments: [['review']],
  options,
});

describe('undo application service', () => {
  test('validates target/all/mode grammar before context or domain access', async () => {
    let prepares = 0;
    const service = createUndoApplicationService({
      prepare: (async () => {
        prepares++;
        return ok(prepared(false));
      }) as UndoApplicationDependencies['prepare'],
    });
    const poisoned = new Proxy({} as CurrentApplicationContext, {
      get: (_target, property) => {
        throw new Error(`unexpected context read: ${String(property)}`);
      },
    });

    const missing = await service({ arguments: [], options: {} }, poisoned);
    const conflict = await service(request({ all: true }), poisoned);
    const mode = await service(request({ dryRun: true, yes: true }), poisoned);

    expect([missing.exitClass, conflict.exitClass, mode.exitClass]).toEqual([
      'usage',
      'usage',
      'usage',
    ]);
    expect(prepares).toBe(0);
  });

  test('dry-run maps an immutable filter-zero product without approval or execution', async () => {
    const executed = { value: 0 };
    const service = createUndoApplicationService({
      prepare: (async () =>
        ok(prepared(false, executed))) as UndoApplicationDependencies['prepare'],
    });
    const noPrompt = interaction(async () => {
      throw new Error('dry-run must not prompt');
    });

    const outcome = await service(
      { arguments: [], options: { all: true, tool: ['claude-code'], project: true, dryRun: true } },
      context(noPrompt),
    );

    expect(outcome.exitClass).toBe('success');
    expect(outcome.report.result).toMatchObject({
      kind: 'skillsmith.undo',
      mode: 'dry-run',
      selection: { source: 'explicit-all', outcome: 'filter-zero' },
      summary: { selected: 0, actionable: 0 },
    });
    expect(outcome.mutation.kind).toBe('preview');
    expect(executed.value).toBe(0);
  });

  test('JSON execution requires yes before approval and keeps the prepared plan unconsumed', async () => {
    const executed = { value: 0 };
    const service = createUndoApplicationService({
      prepare: (async () => ok(prepared(true, executed))) as UndoApplicationDependencies['prepare'],
    });

    const outcome = await service(
      request({ tool: ['claude-code'], project: true, json: true }),
      context(),
    );

    expect(outcome.exitClass).toBe('usage');
    expect(outcome.diagnostics[0]?.code).toBe('undo-approval-required');
    expect(outcome.report.result).toBeNull();
    expect(executed.value).toBe(0);
  });

  test('interactive refusal sees exact group/operation identities and performs no execution', async () => {
    const executed = { value: 0 };
    let preview: unknown;
    const service = createUndoApplicationService({
      prepare: (async () => ok(prepared(true, executed))) as UndoApplicationDependencies['prepare'],
    });
    const selectedInteraction = interaction(async (request) => {
      preview = request.preview;
      return { status: 'resolved', value: false };
    });

    const outcome = await service(
      request({ tool: ['claude-code'], project: true }),
      context(selectedInteraction),
    );

    expect(preview).toEqual({
      kind: 'exact-undo-preview',
      command: 'undo',
      groupIds: ['group:v1:undo-review'],
      operationIds: ['operation:v1:undo-review'],
    });
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.report.result).toMatchObject({
      mode: 'execute',
      state: 'refused',
      approval: { required: true, outcome: 'refused' },
      results: [],
    });
    expect(executed.value).toBe(0);
  });

  test('cleanup-only dry-run remains read-only and does not require approval', async () => {
    const executed = { value: 0 };
    const carrier = { durable: true };
    const service = createUndoApplicationService({
      prepare: (async () =>
        ok(cleanupPrepared(executed, false, carrier))) as UndoApplicationDependencies['prepare'],
    });

    const result = await service(
      request({ tool: ['claude-code'], project: true, dryRun: true }),
      context(
        interaction(async () => {
          throw new Error('cleanup dry-run must not prompt');
        }),
      ),
    );

    expect(result.exitClass).toBe('success');
    expect(result.report.result).toMatchObject({
      mode: 'dry-run',
      state: 'ready',
      approval: { required: false, outcome: 'not-required' },
      operations: [],
      results: [],
      effects: [],
      diagnostics: [{ reason: { code: 'undo-cleanup-pending' } }],
    });
    expect(executed.value).toBe(0);
    expect(carrier.durable).toBeTrue();
  });

  test('cleanup-only approval preview carries exact cleanup authority and refusal writes nothing', async () => {
    const executed = { value: 0 };
    const carrier = { durable: true };
    let preview: unknown;
    const service = createUndoApplicationService({
      prepare: (async () =>
        ok(cleanupPrepared(executed, false, carrier))) as UndoApplicationDependencies['prepare'],
    });

    const result = await service(
      request({ tool: ['claude-code'], project: true }),
      context(
        interaction(async (confirmation) => {
          preview = confirmation.preview;
          return { status: 'resolved', value: false };
        }),
      ),
    );

    expect(preview).toEqual({
      kind: 'exact-undo-preview',
      command: 'undo',
      groupIds: [`group:v1:${'1'.repeat(64)}`],
      operationIds: [],
      cleanupPending: [
        {
          groupId: `group:v1:${'1'.repeat(64)}`,
          pairId: `pair:v1:${'2'.repeat(64)}`,
          activeTransactionId: 'transaction:v1:undo',
        },
      ],
    });
    expect(result.report.result).toMatchObject({
      mode: 'execute',
      state: 'refused',
      approval: { required: true, outcome: 'refused' },
      operations: [],
      results: [],
      effects: [],
    });
    expect(executed.value).toBe(0);
    expect(carrier.durable).toBeTrue();
  });

  test('approved cleanup hook failure returns no report, result, or effect authority', async () => {
    const executed = { value: 0 };
    const carrier = { durable: true };
    const prepared = cleanupPrepared(executed, false, carrier);
    const service = createUndoApplicationService({
      prepare: (async () =>
        ok({
          ...prepared,
          execute: async () => {
            executed.value++;
            return err({
              code: 'undo-flip-failed',
              message: 'committed fresh-uninstall cleanup requires live to remain absent',
              exitClass: 'failure' as const,
            });
          },
        })) as UndoApplicationDependencies['prepare'],
    });

    const result = await service(
      request({ tool: ['claude-code'], project: true, yes: true }),
      context(),
    );

    expect(result.exitClass).toBe('failure');
    expect(result.report.result).toBeNull();
    expect(result.diagnostics).toEqual([
      {
        code: 'undo-flip-failed',
        severity: 'error',
        message: 'committed fresh-uninstall cleanup requires live to remain absent',
      },
    ]);
    expect(result.mutation).toEqual({
      kind: 'none',
      planned: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(executed.value).toBe(1);
    expect(carrier.durable).toBeTrue();
  });

  test('approved cleanup-only execution completes with no effects and surfaces retained backup warning', async () => {
    const executed = { value: 0 };
    const service = createUndoApplicationService({
      prepare: (async () =>
        ok(cleanupPrepared(executed, true))) as UndoApplicationDependencies['prepare'],
    });

    const result = await service(
      request({ tool: ['claude-code'], project: true, yes: true }),
      context(),
    );

    expect(result.exitClass).toBe('success');
    expect(result.report.result).toMatchObject({
      mode: 'execute',
      state: 'completed',
      approval: { required: true, outcome: 'approved' },
      operations: [],
      results: [],
      effects: [],
      summary: { alreadyReversed: 1, effects: 0 },
    });
    expect(result.diagnostics).toEqual([
      {
        code: 'undo-cleanup-retained',
        severity: 'warning',
        message: 'Undo cleanup retained a mismatched backup for manual inspection.',
      },
    ]);
    expect(result.mutation).toMatchObject({ changed: 0, unchanged: 1, failed: 0 });
    expect(executed.value).toBe(1);
  });
});
