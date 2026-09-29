import { describe, expect, test } from 'bun:test';
import { isAtLeastVersion } from './tool-versions';

describe('isAtLeastVersion', () => {
  test('accepts the minimum itself and any newer release', () => {
    expect(isAtLeastVersion('1.3.14', '1.3.14')).toBe(true);
    expect(isAtLeastVersion('1.3.15', '1.3.14')).toBe(true);
    expect(isAtLeastVersion('1.4.2', '1.3.14')).toBe(true);
    expect(isAtLeastVersion('2.0.0', '1.3.14')).toBe(true);
    expect(isAtLeastVersion('2.18.2', '2.17.1')).toBe(true);
    expect(isAtLeastVersion('12.0.2', '12.0.1')).toBe(true);
  });

  test('rejects older releases', () => {
    expect(isAtLeastVersion('1.3.13', '1.3.14')).toBe(false);
    expect(isAtLeastVersion('2.17.0', '2.17.1')).toBe(false);
    expect(isAtLeastVersion('11.19.1', '12.0.1')).toBe(false);
  });

  test('compares numerically, not lexically', () => {
    expect(isAtLeastVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isAtLeastVersion('1.3.2', '1.3.14')).toBe(false);
  });

  test('fails closed on versions that are not dotted numbers', () => {
    for (const malformed of ['', 'v1.3.14', '1.4.0-canary.1', '1.x', ' 1.3.14']) {
      expect(isAtLeastVersion(malformed, '1.3.14'), malformed).toBe(false);
    }
  });
});
