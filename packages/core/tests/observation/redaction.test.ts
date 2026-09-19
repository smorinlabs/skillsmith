import { describe, expect, test } from 'bun:test';
import { redactObservationValue } from '../../src/observation/index.ts';

describe('observation redaction', () => {
  test('recursively redacts keys and credential substrings without mutating input', () => {
    const input = {
      authorization: 'Bearer key-canary',
      nested: [{ value: 'ghp_abcdefgh and sk-abcdefgh', nearMiss: 'ghp_abcdefg' }],
      negativeZero: -0,
    };
    const redacted = redactObservationValue(input) as Record<string, unknown>;
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toContain('abcdefgh');
    expect((redacted.nested as readonly Record<string, unknown>[])[0]?.nearMiss).toBe(
      'ghp_abcdefg',
    );
    expect(Object.is(redacted.negativeZero, -0)).toBeTrue();
    expect(input.authorization).toBe('Bearer key-canary');
    expect(Object.getPrototypeOf(redacted)).toBeNull();
    expect(Object.isFrozen(redacted.nested)).toBeTrue();
  });

  test('does not invoke accessors or proxy traps and marks cycles and symbols', () => {
    let getterReads = 0;
    let proxyReads = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'secretToken', {
      enumerable: true,
      get: () => {
        getterReads++;
        return 'canary';
      },
    });
    const proxy = new Proxy(
      { canary: true },
      {
        ownKeys: () => {
          proxyReads++;
          return ['canary'];
        },
      },
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const redacted = redactObservationValue({ accessor, proxy, cycle }) as Record<string, unknown>;
    expect((redacted.accessor as Record<string, unknown>).secretToken).toBe('[REDACTED]');
    const ordinaryAccessor: Record<string, unknown> = {};
    Object.defineProperty(ordinaryAccessor, 'value', {
      enumerable: true,
      get: () => {
        getterReads++;
        return 'canary';
      },
    });
    expect(redactObservationValue(ordinaryAccessor)).toEqual({ value: '[ACCESSOR]' });
    expect(JSON.stringify(redacted)).toContain('[PROXY]');
    expect(JSON.stringify(redacted)).toContain('[CIRCULAR]');
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);
    expect(redactObservationValue({ [Symbol('secret')]: 'canary' })).toBe('[SYMBOL]');
  });

  test('bounds depth and total traversed nodes', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 34; index++) deep = { child: deep };
    expect(JSON.stringify(redactObservationValue(deep))).toContain('[MAX_DEPTH]');
    expect(
      JSON.stringify(redactObservationValue(Array.from({ length: 4_097 }, (_, i) => i))),
    ).toContain('[MAX_NODES]');
  });
});
