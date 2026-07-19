import { describe, expect, test } from 'bun:test';
import type { PlanImageV1, PlanOperationKindV1 } from '../../src/artifacts/plan-types.ts';
import type { SnapshotBoundOperationPlanV1 } from '../../src/planning/create.ts';
import {
  type CurrentMutatorCommand,
  EXECUTABLE_OPERATION_KINDS,
  type ExecutableOperationKind,
  OPERATION_EXECUTION_OUTCOMES,
  OPERATION_SELECTION_SOURCES,
  type OperationImage,
  type OperationManifestSnapshot,
  type OperationPlan,
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

  test('keeps snapshot binding generic over the immutable operation plan command', () => {
    const commandParity: Equal<
      SnapshotBoundOperationPlanV1<'install'>['plan']['command'],
      'install'
    > = true;
    const revisionArrayParity: Equal<
      SnapshotBoundOperationPlanV1['expectedRevisions'],
      SnapshotBoundOperationPlanV1['expectedRevisions']
    > = true;

    expect(commandParity).toBeTrue();
    expect(revisionArrayParity).toBeTrue();
  });

  test('keeps init and its runtime-only opaque image closed outside saved-plan v1', () => {
    const commandParity: Equal<
      CurrentMutatorCommand,
      'install' | 'uninstall' | 'dev' | 'promote' | 'doctor' | 'export' | 'init' | 'plan'
    > = true;
    type OpaqueManifest = Extract<OperationImage, { readonly kind: 'opaque-manifest' }>;
    const shapeParity: Equal<
      OpaqueManifest['shape'],
      'canonical' | 'mixed' | 'empty' | 'malformed' | 'unknown'
    > = true;
    const machineBoundParity: Equal<
      OpaqueManifest['location'],
      Readonly<{ kind: 'machine-bound'; path: string }>
    > = true;
    const persistenceExclusion: Equal<
      Extract<PlanImageV1, { readonly kind: 'opaque-manifest' }>,
      never
    > = true;

    expect(commandParity).toBeTrue();
    expect(shapeParity).toBeTrue();
    expect(machineBoundParity).toBeTrue();
    expect(persistenceExclusion).toBeTrue();
  });

  test('defaults public plans to built-ins while allowing private tool-id generics', () => {
    const privateToolParity: Equal<
      OperationPlan<'install', 'fixture-write'>['selection']['tools'][number],
      'fixture-write'
    > = true;
    const publicArtifactParity: Equal<
      OperationManifestSnapshot['skills'][number]['tools'][number],
      'claude-code' | 'codex' | 'kilo-code' | 'opencode'
    > = true;

    expect(privateToolParity).toBeTrue();
    expect(publicArtifactParity).toBeTrue();
  });
});
