import { describe, expect, test } from 'bun:test';
import type { PlanOperationKindV1 } from '../../src/artifacts/plan-types.ts';
import {
  EXECUTABLE_OPERATION_KINDS,
  type ExecutableOperationKind,
  OPERATION_EXECUTION_OUTCOMES,
  OPERATION_SELECTION_SOURCES,
  type OperationPlanPersistenceMapper,
  PLANNING_DIAGNOSTIC_KINDS,
} from '../../src/planning/index.ts';

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false;

describe('planning domain types', () => {
  test('owns closed frozen semantic vocabularies', () => {
    expect(EXECUTABLE_OPERATION_KINDS).toEqual([
      'install',
      'update',
      'remove',
      'link-dev',
      'promote',
      'move-scope',
      'adapt',
      'repair',
      'write-manifest',
      'write-lock',
      'migrate-project-config',
      'migrate-ledger',
    ]);
    expect(PLANNING_DIAGNOSTIC_KINDS).toEqual(['noop', 'skip', 'refuse', 'conflict', 'warning']);
    expect(OPERATION_EXECUTION_OUTCOMES as readonly string[]).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'rolled-back',
      'skipped-after-failure',
    ]);
    expect(OPERATION_SELECTION_SOURCES).toEqual([
      'explicit-targets',
      'explicit-all',
      'bounded-default',
    ]);
    for (const vocabulary of [
      EXECUTABLE_OPERATION_KINDS,
      PLANNING_DIAGNOSTIC_KINDS,
      OPERATION_EXECUTION_OUTCOMES,
      OPERATION_SELECTION_SOURCES,
    ]) {
      expect(Object.isFrozen(vocabulary)).toBeTrue();
    }
  });

  test('keeps saved-plan operation kinds type-identical without importing persistence into runtime', () => {
    const parity: Equal<PlanOperationKindV1, ExecutableOperationKind> = true;
    const persistenceMapper: OperationPlanPersistenceMapper<{ readonly schemaVersion: 1 }> = {
      toPersistence: () => ({ schemaVersion: 1 }),
    };

    expect(parity).toBeTrue();
    expect(persistenceMapper.toPersistence).toBeFunction();
  });
});
