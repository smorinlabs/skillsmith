import type { ObservationBundle } from '../observation/index.ts';
import type { Result } from '../result.ts';
import { normalizeSearchInvocation } from '../search/options.ts';
import type { SearchFailure, SearchProvider, SearchReport } from '../search/types.ts';
import {
  type ApplicationService,
  type CommandOutcome,
  type CurrentCommandRequest,
  type InteractionResolution,
  NO_MUTATION,
} from './types.ts';

export interface SearchSelection {
  readonly report: SearchReport;
  readonly catalogId: string;
}

/** Terminal mechanics belong to the CLI; core exposes only a typed search session. */
export interface SearchInteractionPort {
  readonly available: boolean;
  run(request: {
    readonly initialQuery: string;
    readonly search: (
      query: string,
      signal: AbortSignal,
    ) => Promise<Result<SearchReport, SearchFailure>>;
    readonly signal?: AbortSignal;
  }): Promise<InteractionResolution<SearchSelection>>;
}

export interface SearchApplicationContext {
  readonly observation: ObservationBundle;
  readonly provider: SearchProvider;
  readonly interaction: SearchInteractionPort;
  readonly signal?: AbortSignal;
}

export interface SearchApplicationReport {
  readonly value: SearchReport | null;
  readonly selectedCatalogId: string | null;
}

const failureOutcome = (failure: SearchFailure): CommandOutcome<SearchApplicationReport> => ({
  report: { value: null, selectedCatalogId: null },
  diagnostics: [{ ...failure, severity: 'error' }],
  exitClass:
    failure.code === 'invalid-argument'
      ? 'usage'
      : failure.code === 'cancelled'
        ? 'cancelled'
        : 'source',
  mutation: NO_MUTATION,
  deprecations: [],
});

export const runSearchApplication: ApplicationService<
  CurrentCommandRequest,
  SearchApplicationReport,
  SearchApplicationContext
> = async (request, context) => {
  const words = Array.isArray(request.arguments[0]) ? request.arguments[0] : request.arguments;
  const normalized = normalizeSearchInvocation(
    words,
    request.options,
    context.interaction.available,
  );
  if (!normalized.ok) return failureOutcome(normalized.error);
  if (context.signal?.aborted)
    return failureOutcome({ code: 'cancelled', message: 'search cancelled' });
  const { interactive, request: search } = normalized.value;
  let value: SearchReport;
  let selectedCatalogId: string | null = null;
  if (interactive) {
    const selection = await context.interaction.run({
      initialQuery: search.query ?? '',
      search: (query, signal) =>
        context.provider.search({ ...search, query: query.trim() }, signal),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (selection.status === 'cancelled' || context.signal?.aborted)
      return failureOutcome({ code: 'cancelled', message: 'search cancelled' });
    if (selection.status === 'refused')
      return failureOutcome({ code: 'invalid-argument', message: selection.reason });
    value = selection.value.report;
    selectedCatalogId = selection.value.catalogId;
  } else {
    const result = await context.provider.search(
      { ...search, query: search.query ?? '' },
      context.signal,
    );
    if (!result.ok) return failureOutcome(result.error);
    value = result.value;
  }
  return {
    report: { value, selectedCatalogId },
    diagnostics: [],
    exitClass: 'success',
    mutation: NO_MUTATION,
    deprecations: [],
  };
};
