import { describe, expect, test } from 'bun:test';
import {
  createChildOperationContext,
  createOperationContext,
  nextOperationAttempt,
  withOperationTarget,
} from '../../src/observation/index.ts';

const fixture = () => {
  let wall = '2026-07-13T00:00:00.000Z';
  let monotonic = 10;
  const purposes: string[] = [];
  return {
    clock: {
      wallNowIso: () => wall,
      monotonicMilliseconds: () => monotonic,
    },
    id: {
      nextId: (purpose: string) => {
        purposes.push(purpose);
        return `operation-${purposes.length}`;
      },
    },
    purposes,
    advance: (nextWall: string, nextMonotonic: number) => {
      wall = nextWall;
      monotonic = nextMonotonic;
    },
  };
};

describe('OperationContext', () => {
  test('constructs and derives immutable correlated contexts with focused clocks and IDs', () => {
    const built = fixture();
    const root = createOperationContext({
      command: 'skillsmith fixture',
      workflow: 'fixture',
      clock: built.clock,
      id: built.id,
    });
    expect(root).toMatchObject({
      operationId: 'operation-1',
      parentOperationId: null,
      attempt: 1,
      startedAt: '2026-07-13T00:00:00.000Z',
      startedMonotonicMilliseconds: 10,
    });
    expect(Object.isFrozen(root)).toBeTrue();
    expect(Object.isFrozen(root.clock)).toBeTrue();

    built.advance('2026-07-13T00:00:01.000Z', 20);
    const child = createChildOperationContext(root, {
      command: 'skillsmith child',
      workflow: 'child',
      id: built.id,
    });
    const targeted = withOperationTarget(child, { groupId: 'group-1', pairId: 'pair-1' });
    built.advance('2026-07-13T00:00:02.000Z', 35);
    const retried = nextOperationAttempt(targeted);
    expect(retried).toMatchObject({
      operationId: 'operation-2',
      parentOperationId: 'operation-1',
      groupId: 'group-1',
      pairId: 'pair-1',
      attempt: 2,
      startedMonotonicMilliseconds: 35,
    });
    expect(built.purposes).toEqual(['operation', 'operation']);
  });

  test('rejects malformed values before consuming an operation ID', () => {
    const built = fixture();
    expect(() =>
      createOperationContext({
        command: 'fixture',
        workflow: 'fixture',
        clock: built.clock,
        id: built.id,
        pairId: 'pair-1',
      }),
    ).toThrow(TypeError);
    expect(() =>
      createOperationContext({
        command: ' fixture',
        workflow: 'fixture',
        clock: built.clock,
        id: built.id,
      }),
    ).toThrow(TypeError);
    expect(built.purposes).toEqual([]);

    const root = createOperationContext({
      operationId: 'root-operation',
      command: 'fixture',
      workflow: 'fixture',
      clock: built.clock,
      id: built.id,
    });
    let getterReads = 0;
    const childInput = {
      workflow: 'child',
      id: built.id,
    } as { command: string; workflow: string; id: typeof built.id };
    Object.defineProperty(childInput, 'command', {
      enumerable: true,
      get: () => {
        getterReads++;
        return 'child';
      },
    });
    expect(() => createChildOperationContext(root, childInput)).toThrow(TypeError);
    expect(getterReads).toBe(0);
    expect(() =>
      createChildOperationContext(
        root,
        new Proxy(
          { command: 'child', workflow: 'child', id: built.id },
          { ownKeys: () => ['command', 'workflow', 'id'] },
        ),
      ),
    ).toThrow(TypeError);
  });

  test('explicit IDs consume no generator call and attempts reject overflow', () => {
    const built = fixture();
    const context = createOperationContext({
      operationId: 'explicit-operation',
      command: 'fixture',
      workflow: 'fixture',
      clock: built.clock,
      id: built.id,
      attempt: Number.MAX_SAFE_INTEGER,
    });
    expect(built.purposes).toEqual([]);
    expect(() => nextOperationAttempt(context)).toThrow(TypeError);
  });
});
