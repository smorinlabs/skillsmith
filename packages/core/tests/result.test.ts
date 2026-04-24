import { describe, expect, test } from 'bun:test';
import { err, isErr, isOk, map, mapErr, ok } from '../src/result.ts';

describe('Result', () => {
  test('ok() wraps a value', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
  });
  test('err() wraps an error', () => {
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });
  test('isOk / isErr narrow', () => {
    const r = ok(2);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
  });
  test('map transforms ok, leaves err', () => {
    expect(map(ok(2), (n) => n + 1)).toEqual(ok(3));
    expect(map(err('x'), (n: number) => n + 1)).toEqual(err('x'));
  });
  test('mapErr transforms err, leaves ok', () => {
    expect(mapErr(err('x'), (e) => `${e}!`)).toEqual(err('x!'));
    expect(mapErr(ok(2), (e: string) => `${e}!`)).toEqual(ok(2));
  });
});
