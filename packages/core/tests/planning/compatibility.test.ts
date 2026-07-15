import { describe, expect, test } from 'bun:test';
import {
  type CurrentCompatibilityProjection,
  type ExecutableOperation,
  type OperationExecutionResult,
  type PlanningDiagnostic,
  toCurrentCompatibilityAction,
} from '../../src/planning/index.ts';

const operation = (
  operationId: string,
  kind: 'install' | 'remove' | 'link-dev' | 'promote',
  beforeKind: 'absent' | 'dev' | 'unmanaged' = 'absent',
): ExecutableOperation =>
  ({
    operationId,
    kind,
    before:
      beforeKind === 'absent'
        ? { kind: 'absent' }
        : { kind: 'placement', classification: beforeKind },
    after: { kind: 'placement', classification: kind === 'link-dev' ? 'dev' : 'pinned' },
  }) as unknown as ExecutableOperation;

const diagnostic = (kind: 'noop' | 'skip' | 'refuse' | 'conflict' | 'warning') =>
  ({ kind }) as PlanningDiagnostic;

const result = (
  operationId: string,
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'rolled-back',
) => ({ operationId, outcome }) as OperationExecutionResult;

const project = (input: CurrentCompatibilityProjection) => toCurrentCompatibilityAction(input);

describe('current planning compatibility projection', () => {
  test('keeps dispositions and outcomes distinct from executable work', () => {
    expect(
      project({ family: 'install', operation: null, diagnostic: diagnostic('noop'), result: null }),
    ).toBe('noop');
    expect(
      project({ family: 'install', operation: null, diagnostic: diagnostic('skip'), result: null }),
    ).toBe('skipped');
    expect(
      project({
        family: 'flip',
        operation: null,
        diagnostic: diagnostic('conflict'),
        result: null,
      }),
    ).toBe('refused');

    const install = operation('install-id', 'install');
    expect(
      project({
        family: 'install',
        operation: install,
        diagnostic: null,
        result: result('install-id', 'succeeded'),
      }),
    ).toBe('installed');
    expect(
      project({
        family: 'install',
        operation: install,
        diagnostic: null,
        result: result('install-id', 'cancelled'),
      }),
    ).toBe('failed');

    expect(
      project({
        family: 'flip',
        operation: operation('create', 'link-dev'),
        diagnostic: null,
        result: null,
      }),
    ).toBe('created');
    expect(
      project({
        family: 'flip',
        operation: operation('adopt', 'link-dev', 'unmanaged'),
        diagnostic: null,
        result: null,
      }),
    ).toBe('adopted');
    expect(
      project({
        family: 'flip',
        operation: operation('update', 'link-dev', 'dev'),
        diagnostic: null,
        result: null,
      }),
    ).toBe('updated');
  });

  test('rejects impossible compatibility correlations', () => {
    const remove = operation('remove-id', 'remove');
    expect(() =>
      project({
        family: 'uninstall',
        operation: remove,
        diagnostic: null,
        result: result('other-id', 'succeeded'),
      }),
    ).toThrow(/identity mismatch/i);
    expect(() =>
      project({
        family: 'install',
        operation: null,
        diagnostic: diagnostic('warning'),
        result: null,
      }),
    ).toThrow(/warning alone/i);
    expect(() =>
      project({
        family: 'uninstall',
        operation: remove,
        diagnostic: null,
        result: result('remove-id', 'rolled-back'),
      }),
    ).toThrow(/rolled-back/i);
  });
});
