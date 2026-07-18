import type { CurrentApplicationContext } from '../application/types.ts';
import { commitArtifactPair } from '../artifacts/coordinator.ts';
import { executeOperationPlanObserved } from '../execution/coordinator.ts';
import type { PreparedLedgerMigration } from '../place/ledger-migration.ts';
import { createLedgerMigrationExecutionBinding } from '../place/ledger-migration.ts';
import { createOperationPlan } from '../planning/create.ts';
import { type Result, err, ok } from '../result.ts';
import type { PreparedExportArtifacts } from './merge.ts';
import type { ExportObservation } from './observe.ts';
import type { ExportEffect, ExportFailure } from './types.ts';

const effectsFor = (
  prepared: PreparedExportArtifacts,
  outcome: ExportEffect['outcome'],
  migration: PreparedLedgerMigration | null = null,
): readonly ExportEffect[] =>
  Object.freeze([
    ...(migration === null
      ? []
      : [
          Object.freeze({
            role: 'ledger' as const,
            action: 'migrate' as const,
            operationId: migration.operation.operationId,
            outcome,
          }),
        ]),
    Object.freeze({
      role: 'manifest' as const,
      action: prepared.manifestAction,
      operationId: prepared.manifestChanged ? 'export:manifest' : null,
      outcome: prepared.manifestChanged ? outcome : ('not-run' as const),
    }),
    Object.freeze({
      role: 'lock' as const,
      action: prepared.lockAction,
      operationId: prepared.lockChanged ? 'export:lock' : null,
      outcome: prepared.lockChanged ? outcome : ('not-run' as const),
    }),
  ]);

export const previewExportEffects = (
  prepared: PreparedExportArtifacts,
  migration: PreparedLedgerMigration | null = null,
): readonly ExportEffect[] => effectsFor(prepared, 'planned', migration);

const migrationFailure = (
  code: string,
  message: string,
  prepared: PreparedExportArtifacts,
  migration: PreparedLedgerMigration,
): Result<readonly ExportEffect[], ExportFailure> =>
  err(
    Object.freeze({
      code,
      message,
      exitClass: 'failure' as const,
      effects: Object.freeze([
        Object.freeze({
          role: 'ledger' as const,
          action: 'migrate' as const,
          operationId: migration.operation.operationId,
          outcome: 'failed' as const,
        }),
        ...effectsFor(prepared, 'not-run').filter((effect) => effect.role !== 'ledger'),
      ]),
    }),
  );

const executeLedgerMigration = async (
  context: CurrentApplicationContext,
  observation: ExportObservation,
  prepared: PreparedExportArtifacts,
  migration: PreparedLedgerMigration,
): Promise<Result<readonly ExportEffect[], ExportFailure>> => {
  const plan = createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'export',
    selection: {
      source: 'bounded-default',
      tools: observation.request.tools,
      scopes:
        observation.request.scope === 'user' || observation.request.scope === 'project'
          ? [observation.request.scope]
          : [],
    },
    batchPolicy: 'fail-fast',
    operations: [migration.operation],
    checks: [],
    diagnostics: [],
  });
  try {
    const results = await executeOperationPlanObserved(
      {
        plan,
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
        locks: [
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
      return migrationFailure(
        result?.outcome === 'cancelled' ? 'export-cancelled' : 'export-ledger-migration',
        'placement ledger migration did not complete',
        prepared,
        migration,
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
  } catch {
    return migrationFailure(
      context.signal?.aborted ? 'export-cancelled' : 'export-ledger-migration',
      context.signal?.aborted
        ? 'placement ledger migration was cancelled'
        : 'placement ledger migration failed',
      prepared,
      migration,
    );
  }
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
    return ok(effectsFor(prepared, 'not-run', migration));
  }
  const migrationEffects =
    migration === null
      ? ok<readonly ExportEffect[]>(Object.freeze([]))
      : await executeLedgerMigration(context, observation, prepared, migration);
  if (!migrationEffects.ok) return migrationEffects;
  const committed = await commitArtifactPair(context.artifactCoordinator, {
    pair: observation.pair,
    manifest: prepared.manifestChanged
      ? { kind: 'replace', bytes: prepared.manifestBytes }
      : { kind: 'keep' },
    lock: prepared.lockChanged ? { kind: 'replace', lock: prepared.lock } : { kind: 'keep' },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (!committed.ok) {
    const exitClass: ExportFailure['exitClass'] =
      committed.error.reason === 'permission-denied'
        ? 'permission'
        : committed.error.reason === 'cancelled'
          ? 'cancelled'
          : committed.error.reason === 'external-writer-conflict'
            ? 'state'
            : 'failure';
    return err(
      Object.freeze({
        code: `export-${committed.error.reason}`,
        message: committed.error.message,
        exitClass,
        effects: Object.freeze([
          ...migrationEffects.value,
          ...effectsFor(prepared, 'failed').filter((effect) => effect.role !== 'ledger'),
        ]),
      }),
    );
  }
  return ok(
    Object.freeze([
      ...migrationEffects.value,
      ...effectsFor(prepared, 'succeeded').filter((effect) => effect.role !== 'ledger'),
    ]),
  );
};
