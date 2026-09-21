import { describe, expect, test } from 'bun:test';
import { CURRENT_APPLICATION_SERVICES } from '../../src/application/current-services.ts';
import {
  type SearchApplicationContext,
  runSearchApplication,
} from '../../src/application/search-service.ts';
import { type CurrentApplicationContext, NO_MUTATION } from '../../src/application/types.ts';
import type { ObservationBundle } from '../../src/observation/index.ts';
import { ok } from '../../src/result.ts';
import { parseSkillsShResponse } from '../../src/search/skills-sh.ts';
import { encodedSearch, searchRequest } from '../fixtures/search.ts';

const parsed = parseSkillsShResponse(encodedSearch(), searchRequest);
if (!parsed.ok) throw new Error('invalid fixture');
const report = parsed.value;
type Assert<T extends true> = T;
type RegistrySearchContext = Parameters<typeof CURRENT_APPLICATION_SERVICES.search>[1];
type _AcceptsFocusedContext = Assert<
  SearchApplicationContext extends RegistrySearchContext ? true : false
>;
type _RefusesAggregateContext = Assert<
  CurrentApplicationContext extends RegistrySearchContext ? false : true
>;
const context = (calls: unknown[]): SearchApplicationContext => ({
  observation: {} as ObservationBundle,
  provider: {
    search: async (request) => {
      calls.push(request);
      return ok(report);
    },
  },
  interaction: {
    available: false,
    run: async () => {
      throw new Error('unexpected prompt');
    },
  },
});

describe('search application', () => {
  test('requires only focused search capabilities and always reports no mutation', async () => {
    expect(CURRENT_APPLICATION_SERVICES.search).toBe(runSearchApplication);
    const calls: unknown[] = [];
    const focused = context(calls);
    const guarded = new Proxy(focused, {
      get(target, property, receiver) {
        if (!['observation', 'provider', 'interaction', 'signal'].includes(String(property)))
          throw new Error('unexpected local capability');
        return Reflect.get(target, property, receiver);
      },
    });
    const outcome = await runSearchApplication(
      { arguments: [['react', 'native']], options: { timeout: '4m', maxResponseSize: '20MB' } },
      guarded,
    );
    expect(outcome.mutation).toBe(NO_MUTATION);
    expect(outcome.exitClass).toBe('success');
    expect(calls).toEqual([
      { ...searchRequest, query: 'react native', timeoutMs: 240_000, maxResponseBytes: 20_000_000 },
    ]);
  });
  test('invalid input and pre-aborted requests do not invoke the provider', async () => {
    const calls: unknown[] = [];
    const ctx = context(calls);
    for (const input of [
      { arguments: [[]], options: {} },
      { arguments: [['']], options: {} },
      { arguments: [['react']], options: { timeout: '0m' } },
    ])
      expect((await runSearchApplication(input, ctx)).exitClass).toBe('usage');
    const abort = new AbortController();
    abort.abort();
    expect(
      (
        await runSearchApplication(
          { arguments: [['react']], options: {} },
          { ...ctx, signal: abort.signal },
        )
      ).exitClass,
    ).toBe('cancelled');
    expect(calls).toEqual([]);
  });
  test('interactive selection returns details without an installation capability', async () => {
    const calls: unknown[] = [];
    const ctx: SearchApplicationContext = {
      ...context(calls),
      interaction: {
        available: true,
        run: async (input) => {
          expect(input.initialQuery).toBe('');
          const result = await input.search(' react ', new AbortController().signal);
          if (!result.ok) throw new Error('fixture search failed');
          return {
            status: 'resolved',
            value: { report: result.value, catalogId: report.results[0]?.catalogId ?? '' },
          };
        },
      },
    };
    const outcome = await runSearchApplication({ arguments: [[]], options: {} }, ctx);
    expect(outcome.report.value).toEqual(report);
    expect(outcome.report.selectedCatalogId).toBe(report.results[0]?.catalogId ?? null);
    expect(outcome.mutation).toBe(NO_MUTATION);
  });
  test('provider failure is a source error with no success report', async () => {
    const outcome = await runSearchApplication(
      { arguments: [['react']], options: {} },
      {
        ...context([]),
        provider: {
          search: async () => ({
            ok: false,
            error: { code: 'search-timeout', message: 'deadline expired' },
          }),
        },
      },
    );
    expect(outcome.exitClass).toBe('source');
    expect(outcome.report.value).toBeNull();
    expect(outcome.diagnostics).toEqual([
      { code: 'search-timeout', message: 'deadline expired', severity: 'error' },
    ]);
  });
});
