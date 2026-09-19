import { describe, expect, test } from 'bun:test';
import { createOperationPlan } from '../../src/planning/create.ts';
import type { OperationDigest, OperationPlan } from '../../src/planning/types.ts';
import { executeValidatedReconcilePlan } from '../../src/reconcile/apply-execution.ts';
import type { ValidatedSavedReconcilePlanValue } from '../../src/reconcile/apply.ts';
import {
  type ExecutePreparedUpdatePlanRuntimeV1,
  executePreparedUpdatePlanV1,
  validatePreparedUpdateExecutionAuthorityV1,
} from '../../src/update/execute.ts';
import type { PreparedUpdateExecutionPlanV1 } from '../../src/update/plan.ts';

const digest = (character: string): OperationDigest =>
  `sha256:${character.repeat(64)}` as OperationDigest;

const source = Object.freeze({
  kind: 'portable' as const,
  identity: Object.freeze({
    host: 'fixture.invalid',
    repository: 'acme/skills',
    path: 'skills/review',
  }),
  requestedRef: 'main',
  resolvedSha: 'a'.repeat(40),
  sourcePath: 'skills/review',
  contentHash: digest('a'),
});

const emptyPlan = (command: 'apply' | 'update'): OperationPlan<'apply' | 'update'> =>
  createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command,
    selection: {
      source: 'explicit-targets',
      outcome: 'filter-noop',
      targets: [],
      all: false,
      skills: [],
      tools: [],
      scopes: [],
      groupIds: [],
    },
    batchPolicy: 'fail-fast',
    operations: [],
    checks: [],
    diagnostics: [],
  });

const validated = (
  plan: OperationPlan<'apply' | 'update'>,
): ValidatedSavedReconcilePlanValue<'update'> =>
  ({ plan }) as unknown as ValidatedSavedReconcilePlanValue<'update'>;

const prepared = (
  plan: OperationPlan<'apply' | 'update'>,
  artifactActions: PreparedUpdateExecutionPlanV1['artifactActions'] = [],
): PreparedUpdateExecutionPlanV1 =>
  ({ plan, artifactActions }) as unknown as PreparedUpdateExecutionPlanV1;

describe('update execution authority', () => {
  test('executes one already-approved empty update plan without replanning', async () => {
    const plan = emptyPlan('update') as OperationPlan<'update'>;
    const result = await executePreparedUpdatePlanV1(validated(plan), prepared(plan), {
      preparedSources: [],
    } as unknown as ExecutePreparedUpdatePlanRuntimeV1);
    expect(result).toEqual({ ok: true, value: [] });
  });

  test('rejects missing, duplicate, or mismatched artifact action authority', () => {
    const plan = {
      ...emptyPlan('update'),
      operations: [{ operationId: 'operation:lock', kind: 'write-lock' }],
    } as unknown as OperationPlan<'update'>;
    expect(validatePreparedUpdateExecutionAuthorityV1(validated(plan), prepared(plan), [])).toEqual(
      {
        ok: false,
        error: expect.objectContaining({ code: 'update-execution-authority' }),
      },
    );
    const wrongRole = {
      operationId: 'operation:lock',
      action: { role: 'manifest', action: { kind: 'create', manifest: {} } },
    } as unknown as PreparedUpdateExecutionPlanV1['artifactActions'][number];
    expect(
      validatePreparedUpdateExecutionAuthorityV1(validated(plan), prepared(plan, [wrongRole]), []),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'update-execution-authority' }),
    });
    const lockAction = {
      operationId: 'operation:lock',
      action: { role: 'lock', action: { kind: 'replace', lock: {} } },
    } as unknown as PreparedUpdateExecutionPlanV1['artifactActions'][number];
    expect(
      validatePreparedUpdateExecutionAuthorityV1(
        validated(plan),
        prepared(plan, [lockAction, lockAction]),
        [],
      ),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'update-execution-authority' }),
    });
  });

  test('requires exact one-to-one prepared source coverage', () => {
    const plan = {
      ...emptyPlan('update'),
      checks: [{ kind: 'source-resolution', source }],
    } as unknown as OperationPlan<'update'>;
    const exact = Object.freeze({
      source,
      skillName: 'review',
      materializedDir: '/fixture/source/review',
      cleanupDirectory: '/fixture/source',
    });
    expect(
      validatePreparedUpdateExecutionAuthorityV1(validated(plan), prepared(plan), [exact]),
    ).toEqual({ ok: true, value: undefined });
    expect(validatePreparedUpdateExecutionAuthorityV1(validated(plan), prepared(plan), [])).toEqual(
      {
        ok: false,
        error: expect.objectContaining({ code: 'update-execution-authority' }),
      },
    );
    expect(
      validatePreparedUpdateExecutionAuthorityV1(validated(plan), prepared(plan), [exact, exact]),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'update-execution-authority' }),
    });
  });

  test('shared executor refuses update authority attached to another command', async () => {
    const apply = emptyPlan('apply') as OperationPlan<'apply'>;
    const update = emptyPlan('update') as OperationPlan<'update'>;
    const result = await executeValidatedReconcilePlan(
      { plan: apply } as unknown as ValidatedSavedReconcilePlanValue<'apply'>,
      {
        approvedUpdatePlan: update,
        continueOnError: false,
      } as unknown as Parameters<typeof executeValidatedReconcilePlan<'apply'>>[1],
    );
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'apply-execution-plan', exitClass: 'state' }),
    });
  });
});
