import { describe, expect, test } from 'bun:test';
import { ownOrdinaryData } from '../../src/state/ownership.ts';

describe('ownOrdinaryData', () => {
  test('returns a detached deeply frozen ordinary-data graph', () => {
    const input = { branch: { values: [1, { label: 'alpha' }] } };
    const result = ownOrdinaryData(input, () => true);

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    const owned = result.value as typeof input;
    expect(owned).toEqual(input);
    expect(owned).not.toBe(input);
    expect(owned.branch).not.toBe(input.branch);
    expect(owned.branch.values).not.toBe(input.branch.values);
    expect(Object.getPrototypeOf(owned)).toBe(Object.prototype);
    expect(Object.isFrozen(owned)).toBeTrue();
    expect(Object.isFrozen(owned.branch)).toBeTrue();
    expect(Object.isFrozen(owned.branch.values)).toBeTrue();

    input.branch.values[1] = { label: 'caller-mutation' };
    expect(owned.branch.values[1]).toEqual({ label: 'alpha' });
  });

  test('rejects hostile structures and caller-rejected strings with closed reasons', () => {
    const accessor = {};
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'trap' });
    const sparse = Array(2);
    sparse[1] = 'value';
    const extendedArray: unknown[] = [];
    Object.defineProperty(extendedArray, 'extra', { value: true, enumerable: true });
    const exoticArray: unknown[] = [];
    Object.setPrototypeOf(exoticArray, null);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const cases = [
      [new Proxy({}, {}), 'proxy'],
      [accessor, 'accessor'],
      [{ [Symbol('trap')]: true }, 'symbol-key'],
      [extendedArray, 'non-index-array-property'],
      [exoticArray, 'exotic-array'],
      [sparse, 'sparse'],
      [cyclic, 'cycle'],
      [Number.POSITIVE_INFINITY, 'non-finite'],
    ] as const;

    for (const [input, reason] of cases) {
      const result = ownOrdinaryData(input, () => true);
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.error.reason).toBe(reason);
    }

    const rejected = ownOrdinaryData(
      { value: 'reject-me' },
      (_path, value) => value !== 'reject-me',
    );
    expect(rejected).toEqual({
      ok: false,
      error: { code: 'ordinary-data', reason: 'rejected-string', path: '$.value' },
    });
  });

  test('supports owned root paths, null prototypes, and closed property policies', () => {
    const accepted = ownOrdinaryData({ kind: 'portable', token: 'fixture-token' }, () => true, {
      rootPath: '$precondition.resource',
      objectPrototype: 'null',
      acceptProperty: (propertyPath, key, parent, keys) => {
        expect(propertyPath).toBe(`$precondition.resource.${key}`);
        expect(keys).toEqual(['kind', 'token']);
        const kind = Object.getOwnPropertyDescriptor(parent, 'kind');
        return (
          key !== 'token' || (kind !== undefined && 'value' in kind && kind.value === 'portable')
        );
      },
    });
    expect(accepted.ok).toBeTrue();
    if (accepted.ok) {
      expect(Object.getPrototypeOf(accepted.value)).toBeNull();
      expect(Object.isFrozen(accepted.value)).toBeTrue();
    }

    const rejected = ownOrdinaryData({ authorization: 'opaque' }, () => true, {
      rootPath: '$precondition.expected',
      acceptProperty: () => false,
    });
    expect(rejected).toEqual({
      ok: false,
      error: {
        code: 'ordinary-data',
        reason: 'rejected-property',
        path: '$precondition.expected.authorization',
      },
    });

    const thrown = ownOrdinaryData({ token: 'opaque' }, () => true, {
      acceptProperty: () => {
        throw new Error('policy trap');
      },
    });
    expect(thrown).toEqual({
      ok: false,
      error: { code: 'ordinary-data', reason: 'rejected-property', path: '$.token' },
    });
  });
});
