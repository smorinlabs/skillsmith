import { describe, expect, test } from 'bun:test';
import {
  normalizeSearchInvocation,
  parseSearchResponseSize,
  parseSearchTimeout,
  validateSearchRequest,
} from '../../src/search/options.ts';

describe('search request contract', () => {
  test('uses two minutes and ten decimal MB and joins query words', () => {
    expect(normalizeSearchInvocation(['  react', 'native  '], {}, false)).toEqual({
      ok: true,
      value: {
        interactive: false,
        request: {
          query: 'react native',
          owner: null,
          limit: 20,
          timeoutMs: 120_000,
          maxResponseBytes: 10_000_000,
        },
      },
    });
  });
  test('accepts overrides in both directions and distinguishes MB from MiB', () => {
    for (const [input, expected] of [
      ['1ms', 1],
      ['90s', 90_000],
      ['4m', 240_000],
      ['1h', 3_600_000],
      ['2147483647ms', 2_147_483_647],
    ] as const)
      expect(parseSearchTimeout(input)).toEqual({ ok: true, value: expected });
    for (const [input, expected] of [
      ['1B', 1],
      ['500KB', 500_000],
      ['20MB', 20_000_000],
      ['16MiB', 16_777_216],
      ['1KiB', 1_024],
    ] as const)
      expect(parseSearchResponseSize(input)).toEqual({ ok: true, value: expected });
  });
  test('rejects unbounded, malformed, fractional and overflowing values', () => {
    for (const input of [
      '',
      '0m',
      '-1m',
      '+1m',
      '1.5m',
      '2M',
      '2 m',
      '2',
      'NaNm',
      'Infinitys',
      '2147483648ms',
      '2min',
      '2m trailing',
    ])
      expect(parseSearchTimeout(input).ok).toBe(false);
    for (const input of [
      '0B',
      '-1MB',
      '1.5MB',
      '10mb',
      '10',
      '3GiB',
      '2147483648B',
      'NaNB',
      '1MB\n',
    ])
      expect(parseSearchResponseSize(input).ok).toBe(false);
  });
  test('keeps absent query distinct from explicit empty input and counts Unicode code points', () => {
    expect(normalizeSearchInvocation([], {}, true).ok).toBe(true);
    for (const words of [[], [''], [' '], ['r'], ['😀']])
      expect(normalizeSearchInvocation(words, {}, false).ok).toBe(false);
    expect(normalizeSearchInvocation([' '], {}, true).ok).toBe(false);
    expect(normalizeSearchInvocation(['😀🌲'], {}, false).ok).toBe(true);
  });
  test('validates owner, limit and interaction policy without effects', () => {
    for (const options of [
      { owner: '../owner' },
      { owner: 2 },
      { limit: '0' },
      { limit: '21' },
      { limit: '1.5' },
    ])
      expect(normalizeSearchInvocation(['react'], options, true).ok).toBe(false);
    for (const options of [{ json: true }, { prompt: false }, { quiet: true }])
      expect(normalizeSearchInvocation([], options, true).ok).toBe(false);
    expect(normalizeSearchInvocation(['react'], { interactive: true }, false).ok).toBe(false);
    expect(
      normalizeSearchInvocation(['react'], { owner: 'vercel-labs', limit: '1', json: true }, false)
        .ok,
    ).toBe(true);
  });
  test('validates direct core callers as well as CLI strings', () => {
    const request = {
      query: 'react',
      owner: null,
      limit: 20,
      timeoutMs: 120_000,
      maxResponseBytes: 10_000_000,
    };
    for (const change of [
      { timeoutMs: 0 },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { maxResponseBytes: -1 },
      { maxResponseBytes: Number.MAX_SAFE_INTEGER },
      { query: ' r ' },
    ])
      expect(validateSearchRequest({ ...request, ...change }).ok).toBe(false);
  });
});
