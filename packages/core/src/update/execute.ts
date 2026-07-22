import { canonicalPlanningString } from '../planning/order.ts';
import type { OperationExecutionResult } from '../planning/types.ts';
import type {
  ExecuteValidatedReconcilePlanError,
  ReconcileArtifactExecutionActionV1,
  ReconcilePreparedSourceV1,
} from '../reconcile/apply-execution.ts';
import {
  type ExecuteValidatedReconcilePlanRuntime,
  type ValidatedSavedReconcilePlanValue,
  executeValidatedReconcilePlan,
} from '../reconcile/index.ts';
import type { PlanReconcileError } from '../reconcile/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { PreparedUpdateExecutionPlanV1 } from './plan.ts';

export interface ExecutePreparedUpdatePlanRuntimeV1
  extends Omit<
    ExecuteValidatedReconcilePlanRuntime,
    'approvedUpdatePlan' | 'artifactActions' | 'continueOnError' | 'preparedSources'
  > {
  readonly preparedSources: readonly ReconcilePreparedSourceV1[];
}

const authorityError = (message: string): PlanReconcileError =>
  Object.freeze({
    code: 'update-execution-authority',
    message,
    exitClass: 'state' as const,
  });

const sortedUnique = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));

const exactStringVector = (left: readonly string[], right: readonly string[]): boolean =>
  canonicalPlanningString(left) === canonicalPlanningString(right);

const actionMatchesOperation = (
  action: ReconcileArtifactExecutionActionV1,
  kind: 'write-manifest' | 'write-lock',
): boolean =>
  (kind === 'write-manifest' && action.action.role === 'manifest') ||
  (kind === 'write-lock' && action.action.role === 'lock');

/**
 * Validate the update-only authority that is intentionally richer than the shared saved-plan
 * validation product. This boundary prevents callers from attaching update artifact actions or
 * prepared source trees to another reconciliation command.
 */
export const validatePreparedUpdateExecutionAuthorityV1 = (
  validated: ValidatedSavedReconcilePlanValue<'update'>,
  prepared: PreparedUpdateExecutionPlanV1,
  sources: readonly ReconcilePreparedSourceV1[],
): Result<void, PlanReconcileError> => {
  if (validated.plan.command !== 'update' || prepared.plan.command !== 'update') {
    return err(authorityError('prepared update execution requires update command authority'));
  }

  const artifactOperations = prepared.plan.operations.filter(
    (operation): operation is typeof operation & { kind: 'write-manifest' | 'write-lock' } =>
      operation.kind === 'write-manifest' || operation.kind === 'write-lock',
  );
  const expectedActionIds = sortedUnique(artifactOperations.map(({ operationId }) => operationId));
  const actualActionIds = sortedUnique(
    prepared.artifactActions.map(({ operationId }) => operationId),
  );
  if (
    expectedActionIds.length !== prepared.artifactActions.length ||
    !exactStringVector(expectedActionIds, actualActionIds)
  ) {
    return err(
      authorityError('prepared update artifact actions do not exactly cover artifact operations'),
    );
  }
  const operationById = new Map(
    artifactOperations.map((operation) => [operation.operationId, operation] as const),
  );
  for (const action of prepared.artifactActions) {
    const operation = operationById.get(action.operationId);
    if (operation === undefined || !actionMatchesOperation(action, operation.kind)) {
      return err(
        authorityError('prepared update artifact action role does not match its operation'),
      );
    }
  }

  const expectedSources = sortedUnique(
    prepared.plan.checks.flatMap((check) =>
      check.kind === 'source-resolution' ? [canonicalPlanningString(check.source)] : [],
    ),
  );
  const actualSources = sortedUnique(sources.map(({ source }) => canonicalPlanningString(source)));
  if (
    actualSources.length !== sources.length ||
    !exactStringVector(expectedSources, actualSources)
  ) {
    return err(
      authorityError('prepared update sources do not exactly cover approved source checks'),
    );
  }
  return ok(undefined);
};

/** Execute one already-approved update plan without invoking any planner after approval. */
export const executePreparedUpdatePlanV1 = async (
  validated: ValidatedSavedReconcilePlanValue<'update'>,
  prepared: PreparedUpdateExecutionPlanV1,
  runtime: ExecutePreparedUpdatePlanRuntimeV1,
): Promise<Result<readonly OperationExecutionResult[], ExecuteValidatedReconcilePlanError>> => {
  const authority = validatePreparedUpdateExecutionAuthorityV1(
    validated,
    prepared,
    runtime.preparedSources,
  );
  if (!authority.ok) return authority;
  return executeValidatedReconcilePlan(validated, {
    ...runtime,
    continueOnError: prepared.plan.batchPolicy === 'continue-on-error',
    approvedUpdatePlan: prepared.plan,
    artifactActions: prepared.artifactActions,
  });
};
