import type { CurrentApplicationContext } from '../application/types.ts';
import {
  createArtifactPairOperationControllerV1,
  withArtifactPairExecutionAuthority,
} from '../artifacts/execution.ts';
import { readLockArtifact, readManifestArtifact } from '../artifacts/repository.ts';
import { executeOperationPlanObserved } from '../execution/coordinator.ts';
import type { ExecutionPrecondition } from '../execution/types.ts';
import type { PreparedLedgerMigration } from '../place/ledger-migration.ts';
import { createLedgerMigrationExecutionBinding } from '../place/ledger-migration.ts';
import type { OperationExecutionResult, OperationPlan } from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { classifyExport } from './classify.ts';
import type { PreparedExportArtifacts } from './merge.ts';
import { mergePortableCandidates, prepareExportArtifacts } from './merge.ts';
import type { ExportObservation } from './observe.ts';
import { observeExport } from './observe.ts';
import {
  createExportArtifactPrecondition,
  exportArtifactPreconditionFacts,
  prepareExportOperationPlan,
} from './plan.ts';
import type { ExportEffect, ExportFailure } from './types.ts';

const effectsFor = (
  plan: OperationPlan<'export'>,
  prepared: PreparedExportArtifacts,
  outcome: ExportEffect['outcome'],
): readonly ExportEffect[] => {
  const effects: ExportEffect[] = plan.operations.map((operation) =>
    Object.freeze({
      role:
        operation.kind === 'migrate-ledger'
          ? ('ledger' as const)
          : operation.kind === 'write-lock'
            ? ('lock' as const)
            : ('manifest' as const),
      action:
        operation.kind === 'migrate-ledger' || operation.kind === 'migrate-project-config'
          ? ('migrate' as const)
          : operation.kind === 'write-lock'
            ? prepared.lockAction
            : prepared.manifestAction === 'create'
              ? ('create' as const)
              : ('update' as const),
      operationId: operation.operationId,
      outcome,
    }),
  );
  if (!plan.operations.some(({ kind }) => kind === 'migrate-ledger')) {
    effects.unshift(
      Object.freeze({
        role: 'ledger',
        action: 'not-written',
        operationId: null,
        outcome: 'not-run',
      }),
    );
  }
  if (
    !plan.operations.some(
      ({ kind }) => kind === 'migrate-project-config' || kind === 'write-manifest',
    )
  ) {
    effects.push(
      Object.freeze({
        role: 'manifest',
        action: prepared.manifestAction,
        operationId: null,
        outcome: 'not-run',
      }),
    );
  }
  if (!plan.operations.some(({ kind }) => kind === 'write-lock')) {
    effects.push(
      Object.freeze({
        role: 'lock',
        action: prepared.lockAction,
        operationId: null,
        outcome: 'not-run',
      }),
    );
  }
  return Object.freeze(effects);
};

const executionEffects = (
  plan: OperationPlan<'export'>,
  prepared: PreparedExportArtifacts,
  outcome: ExportEffect['outcome'],
  migrationEffects: readonly ExportEffect[],
): readonly ExportEffect[] =>
  migrationEffects.length === 0
    ? effectsFor(plan, prepared, outcome)
    : Object.freeze([
        ...migrationEffects,
        ...effectsFor(plan, prepared, outcome).filter((effect) => effect.role !== 'ledger'),
      ]);

const resultEffects = (
  plan: OperationPlan<'export'>,
  prepared: PreparedExportArtifacts,
  results: readonly OperationExecutionResult[],
  migrationEffects: readonly ExportEffect[],
): readonly ExportEffect[] => {
  const outcomes = new Map(
    results.map((result) => [
      result.operationId,
      result.outcome === 'succeeded' ||
      result.outcome === 'failed' ||
      result.outcome === 'cancelled'
        ? result.outcome
        : ('not-run' as const),
    ]),
  );
  const projected = effectsFor(plan, prepared, 'not-run')
    .filter((effect) => effect.role !== 'ledger')
    .map((effect) => {
      if (effect.operationId === null) return effect;
      return Object.freeze({
        ...effect,
        outcome: outcomes.get(effect.operationId) ?? ('not-run' as const),
      });
    });
  return Object.freeze([
    ...(migrationEffects.length === 0
      ? effectsFor(plan, prepared, 'not-run').filter((effect) => effect.role === 'ledger')
      : migrationEffects),
    ...projected,
  ]);
};

export const previewExportEffects = (
  observation: ExportObservation,
  prepared: PreparedExportArtifacts,
  migration: PreparedLedgerMigration | null = null,
): readonly ExportEffect[] =>
  effectsFor(prepareExportOperationPlan(observation, prepared, migration), prepared, 'planned');

const migrationFailure = (
  code: string,
  message: string,
  prepared: PreparedExportArtifacts,
  migration: PreparedLedgerMigration,
  plan: OperationPlan<'export'>,
  exitClass: ExportFailure['exitClass'],
  outcome: 'failed' | 'cancelled',
): Result<readonly ExportEffect[], ExportFailure> =>
  err(
    Object.freeze({
      code,
      message,
      exitClass,
      effects: Object.freeze([
        Object.freeze({
          role: 'ledger' as const,
          action: 'migrate' as const,
          operationId: migration.operation.operationId,
          outcome,
        }),
        ...effectsFor(plan, prepared, 'not-run').filter((effect) => effect.role !== 'ledger'),
      ]),
    }),
  );

const executeLedgerMigration = async (
  context: CurrentApplicationContext,
  observation: ExportObservation,
  prepared: PreparedExportArtifacts,
  migration: PreparedLedgerMigration,
  plan: OperationPlan<'export'>,
  lockAlreadyHeld = false,
): Promise<Result<readonly ExportEffect[], ExportFailure>> => {
  const migrationPlan = {
    ...plan,
    operations: plan.operations.filter(({ kind }) => kind === 'migrate-ledger'),
  } as OperationPlan<'export'>;
  try {
    const results = await executeOperationPlanObserved(
      {
        plan: migrationPlan,
        bindings: [
          createLedgerMigrationExecutionBinding({
            env: context.ports,
            ledgerPath: observation.ledgerPath,
            operation: migration.operation,
            expectedState: migration.expectedState,
            startedAt: context.ports.wallNowIso(),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
            onMigrated: () => undefined,
          }),
        ],
        preconditions: [migration.precondition],
        locks: lockAlreadyHeld
          ? []
          : [
              {
                rank: 'ledger',
                key: 'placements-ledger',
                path: observation.ledgerPath,
              },
            ],
        lockPort: context.ports,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      context.observation,
    );
    const result = results[0];
    if (result?.outcome !== 'succeeded') {
      const errorCode = result?.error?.code ?? '';
      const permission = errorCode.includes('permission-denied');
      const stale = errorCode.includes('stale') || errorCode.includes('precondition');
      return migrationFailure(
        result?.outcome === 'cancelled'
          ? 'export-cancelled'
          : permission
            ? 'export-permission-denied'
            : stale
              ? 'export-precondition-changed'
              : 'export-ledger-migration',
        'placement ledger migration did not complete',
        prepared,
        migration,
        plan,
        result?.outcome === 'cancelled'
          ? 'cancelled'
          : permission
            ? 'permission'
            : stale
              ? 'state'
              : 'failure',
        result?.outcome === 'cancelled' ? 'cancelled' : 'failed',
      );
    }
    return ok(
      Object.freeze([
        Object.freeze({
          role: 'ledger' as const,
          action: 'migrate' as const,
          operationId: migration.operation.operationId,
          outcome: 'succeeded' as const,
        }),
      ]),
    );
  } catch (error) {
    const errorCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : '';
    const permission =
      errorCode === 'EACCES' || errorCode === 'EPERM' || errorCode === 'permission-denied';
    return migrationFailure(
      context.signal?.aborted
        ? 'export-cancelled'
        : permission
          ? 'export-permission-denied'
          : 'export-ledger-migration',
      context.signal?.aborted
        ? 'placement ledger migration was cancelled'
        : permission
          ? 'placement ledger migration permission was denied'
          : 'placement ledger migration failed',
      prepared,
      migration,
      plan,
      context.signal?.aborted ? 'cancelled' : permission ? 'permission' : 'failure',
      context.signal?.aborted ? 'cancelled' : 'failed',
    );
  }
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => right[index] === value);

const revalidateExport = async (
  context: CurrentApplicationContext,
  observation: ExportObservation,
  prepared: PreparedExportArtifacts,
): Promise<Result<void, ExportFailure>> => {
  const changed = (): Result<void, ExportFailure> =>
    err(
      Object.freeze({
        code: 'export-precondition-changed',
        message: 'selected export state changed after planning',
        exitClass: 'state' as const,
      }),
    );
  const current = await observeExport(
    context,
    observation.project,
    observation.request,
    observation.pair,
  );
  if (!current.ok) {
    return current.error.exitClass === 'permission' || current.error.exitClass === 'cancelled'
      ? current
      : changed();
  }
  const classified = classifyExport(current.value);
  if (!classified.ok) return changed();
  const merged = mergePortableCandidates(classified.value.portable, observation.request.force);
  if (!merged.ok) return changed();
  const currentPrepared = prepareExportArtifacts(current.value, merged.value);
  if (!currentPrepared.ok) return changed();
  if (
    !equalBytes(currentPrepared.value.manifestBytes, prepared.manifestBytes) ||
    !equalBytes(currentPrepared.value.lockBytes, prepared.lockBytes) ||
    currentPrepared.value.manifestChanged !== prepared.manifestChanged ||
    currentPrepared.value.lockChanged !== prepared.lockChanged
  ) {
    return changed();
  }
  return ok(undefined);
};

const artifactPreconditions = (
  context: CurrentApplicationContext,
  observation: ExportObservation,
  plan: OperationPlan<'export'>,
): readonly ExecutionPrecondition[] => {
  if (observation.pair === null) return Object.freeze([]);
  const forRole = (role: 'manifest' | 'lock'): ExecutionPrecondition | null => {
    const operationIds = plan.operations
      .filter((operation) =>
        role === 'lock'
          ? operation.kind === 'write-lock'
          : operation.kind === 'migrate-project-config' || operation.kind === 'write-manifest',
      )
      .map(({ operationId }) => operationId);
    if (operationIds.length === 0) return null;
    return createExportArtifactPrecondition(observation, role, operationIds, async () => {
      if (role === 'manifest') {
        const current = await readManifestArtifact(
          context.ports,
          observation.pair?.file.path ?? '',
        );
        if (!current.ok) throw new Error('export manifest precondition observation failed');
        return exportArtifactPreconditionFacts(
          { ...observation, manifest: current.value },
          'manifest',
        );
      }
      const current = await readLockArtifact(context.ports, observation.pair?.lockfile.path ?? '');
      if (!current.ok) throw new Error('export lock precondition observation failed');
      return exportArtifactPreconditionFacts({ ...observation, lock: current.value }, 'lock');
    });
  };
  return Object.freeze(
    (['manifest', 'lock'] as const)
      .map((role) => forRole(role))
      .filter((value): value is ExecutionPrecondition => value !== null),
  );
};

class ExportExecutionFailure extends Error {
  readonly failure: ExportFailure;

  constructor(failure: ExportFailure) {
    super(failure.code);
    this.failure = failure;
  }
}

const artifactReason = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('reason' in error)) return null;
  return typeof error.reason === 'string' ? error.reason : null;
};

export const executeExportArtifacts = async (
  context: CurrentApplicationContext,
  observation: ExportObservation,
  prepared: PreparedExportArtifacts,
  migration: PreparedLedgerMigration | null = null,
): Promise<Result<readonly ExportEffect[], ExportFailure>> => {
  if (observation.pair === null) {
    return err(
      Object.freeze({
        code: 'export-pair-unavailable',
        message: 'no writable artifact pair was selected',
        exitClass: 'state' as const,
      }),
    );
  }
  if (!prepared.manifestChanged && !prepared.lockChanged) {
    const plan = prepareExportOperationPlan(observation, prepared, migration);
    return ok(effectsFor(plan, prepared, 'not-run'));
  }
  const plan = prepareExportOperationPlan(observation, prepared, migration);
  let migrationEffects: readonly ExportEffect[] = Object.freeze([]);
  let artifactResults: readonly OperationExecutionResult[] = Object.freeze([]);
  try {
    await withArtifactPairExecutionAuthority(
      {
        artifactCoordinator: context.artifactCoordinator,
        lockPort: context.ports,
        pair: observation.pair,
        ledgerPath: observation.ledgerPath,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      async (lease) => {
        if (migration !== null) {
          const migrated = await executeLedgerMigration(
            context,
            observation,
            prepared,
            migration,
            plan,
            true,
          );
          if (!migrated.ok) throw new ExportExecutionFailure(migrated.error);
          migrationEffects = migrated.value;
        }
        const current = await revalidateExport(context, observation, prepared);
        if (!current.ok) {
          throw new ExportExecutionFailure(
            Object.freeze({
              ...current.error,
              effects: executionEffects(plan, prepared, 'not-run', migrationEffects),
            }),
          );
        }
        const pair = observation.pair as NonNullable<ExportObservation['pair']>;
        const artifactPlan = Object.freeze({
          ...plan,
          operations: Object.freeze(
            plan.operations.filter(({ kind }) => kind !== 'migrate-ledger'),
          ),
        }) as OperationPlan<'export'>;
        const controller = createArtifactPairOperationControllerV1({
          lease,
          artifactCoordinator: context.artifactCoordinator,
          pair,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        const bindings = artifactPlan.operations.map((operation) =>
          controller.bind(
            operation,
            operation.kind === 'write-lock'
              ? { role: 'lock', action: { kind: 'replace', lock: prepared.lock } }
              : operation.kind === 'migrate-project-config'
                ? {
                    role: 'manifest',
                    action: {
                      kind: 'edit',
                      request: { edits: [{ kind: 'migrate-legacy' }] },
                    },
                  }
                : operation.before.kind === 'absent'
                  ? {
                      role: 'manifest',
                      action: { kind: 'replace', bytes: prepared.manifestBytes },
                    }
                  : {
                      role: 'manifest',
                      action: { kind: 'edit', request: { edits: prepared.manifestEdits } },
                    },
          ),
        );
        artifactResults = await executeOperationPlanObserved(
          {
            plan: artifactPlan,
            bindings,
            preconditions: artifactPreconditions(context, observation, artifactPlan),
            locks: [],
            lockPort: context.ports,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          },
          context.observation,
        );
        return artifactResults;
      },
    );
  } catch (error) {
    if (error instanceof ExportExecutionFailure) return err(error.failure);
    const reason = artifactReason(error);
    const exitClass: ExportFailure['exitClass'] =
      reason === 'permission-denied'
        ? 'permission'
        : reason === 'cancelled' || context.signal?.aborted
          ? 'cancelled'
          : reason === 'external-writer-conflict' || reason === 'lock-contention'
            ? 'state'
            : 'failure';
    return err(
      Object.freeze({
        code: `export-${reason ?? 'artifact-execution'}`,
        message: 'portable artifact execution failed',
        exitClass,
        effects: executionEffects(
          plan,
          prepared,
          exitClass === 'cancelled' ? 'cancelled' : 'failed',
          migrationEffects,
        ),
      }),
    );
  }
  if (artifactResults.some(({ outcome }) => outcome !== 'succeeded')) {
    const cancelled = artifactResults.some(({ outcome }) => outcome === 'cancelled');
    const codes = artifactResults.flatMap(({ error }) => (error === null ? [] : [error.code]));
    const permission = codes.some((code) => code.includes('permission-denied'));
    const stale = codes.some(
      (code) =>
        code.includes('precondition') ||
        code.includes('external-writer-conflict') ||
        code.includes('lock-contention'),
    );
    return err(
      Object.freeze({
        code: cancelled
          ? 'export-cancelled'
          : permission
            ? 'export-permission-denied'
            : stale
              ? 'export-precondition-changed'
              : 'export-artifact-execution',
        message: cancelled
          ? 'portable artifact execution was cancelled'
          : permission
            ? 'portable artifact execution permission was denied'
            : stale
              ? 'selected export state changed after planning'
              : 'portable artifact execution failed',
        exitClass: cancelled
          ? 'cancelled'
          : permission
            ? 'permission'
            : stale
              ? 'state'
              : 'failure',
        effects: resultEffects(plan, prepared, artifactResults, migrationEffects),
      }),
    );
  }
  return ok(resultEffects(plan, prepared, artifactResults, migrationEffects));
};
