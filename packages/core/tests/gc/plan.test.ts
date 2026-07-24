import { describe, expect, test } from 'bun:test';
import type { LedgerModel } from '../../src/artifacts/ledger-types.ts';
import { deriveLedgerProjectRegistrations } from '../../src/artifacts/registry.ts';
import {
  normalizeGcForgetRoots,
  parseGcDuration,
  withoutLedgerProjectAt,
} from '../../src/gc/plan.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';

describe('GC pure request and ledger planning', () => {
  test('accepts only the closed positive duration grammar with safe millisecond products', () => {
    expect(parseGcDuration('1s')).toEqual({
      ok: true,
      value: { input: '1s', milliseconds: 1_000 },
    });
    expect(parseGcDuration('2m')).toEqual({
      ok: true,
      value: { input: '2m', milliseconds: 120_000 },
    });
    expect(parseGcDuration('3h')).toEqual({
      ok: true,
      value: { input: '3h', milliseconds: 10_800_000 },
    });
    for (const value of ['0s', '-1s', '+1s', '1.5h', ' 1h', '1', '1H', '999999999999999999w']) {
      expect(parseGcDuration(value), value).toMatchObject({
        ok: false,
        error: { code: 'invalid-duration' },
      });
    }
  });

  test('normalizes missing roots lexically, preserves first order, and deduplicates exact keys', () => {
    expect(
      normalizeGcForgetRoots('/workspace/current', ['../retired', '../retired', './gone']),
    ).toEqual({
      ok: true,
      value: ['/workspace/retired', '/workspace/current/gone'],
    });
    expect(normalizeGcForgetRoots('/workspace', [''])).toMatchObject({
      ok: false,
      error: { code: 'invalid-forget' },
    });
  });

  test('removes exact project subtrees and re-derives registrations without other mutation', () => {
    const base = emptyLedgerModel('2026-07-23T00:00:00.000Z');
    const pair = {
      placementPath: '/retired/.agents/skills/review',
      mode: 'dev' as const,
      dev: {
        sourcePath: '/source/review',
        resolvedPath: '/source/review',
        repoRoot: null,
        sourceRelPath: null,
        remote: null,
        recordedAt: '2026-07-23T00:00:00.000Z',
      },
    };
    const projects = {
      '/retired': { skills: { review: { tools: { codex: pair } } } },
      '/other': { skills: {} },
    };
    const model: LedgerModel = Object.freeze({
      ...base,
      projects,
      projectRegistrations: deriveLedgerProjectRegistrations(projects),
      transactions: Object.freeze({ transaction: {} as never }),
      history: Object.freeze([{} as never]),
    });
    const result = withoutLedgerProjectAt(model, ['/retired']);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.projects).toEqual({ '/other': { skills: {} } });
    expect(result.value.projectRegistrations).toEqual({ '/other': { consumers: [] } });
    expect(result.value.transactions).toBe(model.transactions);
    expect(result.value.history).toBe(model.history);
    expect(model.projects).toHaveProperty('/retired');
    expect(withoutLedgerProjectAt(model, ['/missing'])).toMatchObject({
      ok: false,
      error: { code: 'invalid-forget' },
    });
  });
});
