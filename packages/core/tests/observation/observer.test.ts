import { describe, expect, test } from 'bun:test';
import {
  createObservationEmitter,
  createObserverEvent,
  createOperationContext,
} from '../../src/observation/index.ts';
import type { ObserverEvent } from '../../src/observation/index.ts';

const contextFixture = () => {
  let wall = '2026-07-13T00:00:00.000Z';
  let monotonic = 10;
  const clock = {
    wallNowIso: () => wall,
    monotonicMilliseconds: () => monotonic,
  };
  return {
    context: createOperationContext({
      operationId: 'operation-1',
      command: 'skillsmith fixture',
      workflow: 'fixture',
      clock,
      id: { nextId: () => 'unused' },
    }),
    advance: (nextWall: string, nextMonotonic: number) => {
      wall = nextWall;
      monotonic = nextMonotonic;
    },
  };
};

describe('observer authority', () => {
  test('strict low-level construction clones payloads and rejects malformed events', () => {
    const built = contextFixture();
    const modes = ['static', 'deep'] as ('static' | 'deep')[];
    const event = createObserverEvent(built.context, {
      kind: 'tool.verification.started',
      toolId: 'fixture-tool',
      modes,
    });
    modes.splice(0, modes.length, 'deep');
    if (event.kind !== 'tool.verification.started') throw new Error('unexpected event kind');
    expect(event.modes).toEqual(['static', 'deep']);
    expect(Object.isFrozen(event)).toBeTrue();
    expect(Object.isFrozen(event.modes)).toBeTrue();
    expect(() =>
      createObserverEvent(built.context, {
        kind: 'command.completed',
        outcome: 'failure',
        exitClass: 'failure',
        errorCode: null,
        durationMilliseconds: 1,
      }),
    ).toThrow(TypeError);
  });

  test('emits paired, independently timed spans and enforces tool registry identity', () => {
    const built = contextFixture();
    const events: ObserverEvent[] = [];
    const emitter = createObservationEmitter({
      observer: {
        observe: (event) => {
          events.push(event);
        },
      },
      toolIds: ['fixture-tool'],
    });
    const span = emitter.begin(built.context, {
      kind: 'tool.detection.started',
      toolId: 'fixture-tool',
    });
    built.advance('2026-07-13T00:00:00.025Z', 35);
    emitter.complete(span, { outcome: 'success', errorCode: null, resultCount: 2 });
    expect(events.map((event) => event.kind)).toEqual([
      'tool.detection.started',
      'tool.detection.completed',
    ]);
    expect(events[1]).toMatchObject({ durationMilliseconds: 25, resultCount: 2 });
    expect(
      emitter.begin(built.context, { kind: 'tool.detection.started', toolId: 'unknown-tool' }),
    ).toBeNull();
    expect(events).toHaveLength(2);
  });

  test('drops foreign spans and isolates synchronous and rejected observer failures', async () => {
    const built = contextFixture();
    const attempts: string[] = [];
    const first = createObservationEmitter({
      observer: {
        observe: (event) => {
          attempts.push(event.kind);
          return Promise.reject(new Error('observer failed'));
        },
      },
    });
    const second = createObservationEmitter({
      observer: {
        observe: () => {
          attempts.push('foreign');
        },
      },
    });
    const span = first.begin(built.context, { kind: 'command.started' });
    expect(() =>
      second.complete(span, { outcome: 'success', exitClass: 'success', errorCode: null }),
    ).not.toThrow();
    expect(() =>
      first.complete(span, { outcome: 'success', exitClass: 'success', errorCode: null }),
    ).not.toThrow();
    await Promise.resolve();
    expect(attempts).toEqual(['command.started', 'command.completed']);
  });
});
