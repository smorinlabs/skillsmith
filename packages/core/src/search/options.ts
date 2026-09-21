import { type Result, err, ok } from '../result.ts';
import type { SearchFailure, SearchRequest } from './types.ts';

export const DEFAULT_SEARCH_TIMEOUT_MS = 120_000;
export const DEFAULT_SEARCH_MAX_RESPONSE_BYTES = 10_000_000;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_BOUND = 2_147_483_647;
export const SEARCH_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

const invalid = (message: string): Result<never, SearchFailure> =>
  err({ code: 'invalid-argument', message });

const scaled = (
  input: unknown,
  units: Readonly<Record<string, number>>,
  label: string,
): Result<number, SearchFailure> => {
  const match = typeof input === 'string' ? /^(\d+)([A-Za-z]+)$/.exec(input) : null;
  const unit = match?.[2] ?? '';
  const factor = Object.hasOwn(units, unit) ? units[unit] : undefined;
  const value = Number(match?.[1]) * (factor ?? Number.NaN);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_SEARCH_BOUND
    ? ok(value)
    : invalid(
        `${label} must be a positive integer with a supported unit (maximum ${MAX_SEARCH_BOUND})`,
      );
};

export const parseSearchTimeout = (value: unknown): Result<number, SearchFailure> =>
  scaled(value, { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }, '--timeout');

export const parseSearchResponseSize = (value: unknown): Result<number, SearchFailure> =>
  scaled(
    value,
    { B: 1, KB: 1_000, MB: 1_000_000, KiB: 1_024, MiB: 1_048_576 },
    '--max-response-size',
  );

export const validateSearchRequest = (
  request: SearchRequest,
): Result<SearchRequest, SearchFailure> => {
  if (
    typeof request.query !== 'string' ||
    request.query !== request.query.trim() ||
    [...request.query].length < 2
  )
    return invalid('search query must contain at least two characters');
  if (
    request.owner !== null &&
    (typeof request.owner !== 'string' || !SEARCH_OWNER.test(request.owner))
  )
    return invalid('--owner must be a GitHub owner (1–39 letters, digits, or hyphens)');
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > DEFAULT_SEARCH_LIMIT)
    return invalid('--limit must be an integer from 1 through 20');
  for (const [label, value] of [
    ['--timeout', request.timeoutMs],
    ['--max-response-size', request.maxResponseBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SEARCH_BOUND)
      return invalid(`${label} is outside its supported range`);
  }
  return ok(request);
};

export interface SearchInvocation {
  readonly request: Omit<SearchRequest, 'query'> & { readonly query: string | null };
  readonly interactive: boolean;
}

/** Query presence is retained: an explicit empty operand never opens the picker. */
export const normalizeSearchInvocation = (
  words: readonly unknown[],
  options: Readonly<Record<string, unknown>>,
  interactiveAvailable: boolean,
): Result<SearchInvocation, SearchFailure> => {
  if (words.some((word) => typeof word !== 'string')) return invalid('search query must be text');
  const query = words.length === 0 ? null : words.join(' ').trim();
  const timeout = parseSearchTimeout(options.timeout ?? '2m');
  if (!timeout.ok) return timeout;
  const size = parseSearchResponseSize(options.maxResponseSize ?? '10MB');
  if (!size.ok) return size;
  const rawLimit = options.limit ?? '20';
  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit))
    return invalid('--limit must be an integer from 1 through 20');
  const request = {
    query: query ?? 'query',
    owner: options.owner === undefined ? null : (options.owner as string),
    limit: Number(rawLimit),
    timeoutMs: timeout.value,
    maxResponseBytes: size.value,
  };
  const valid = validateSearchRequest(request);
  if (!valid.ok) return valid;
  const interactive = options.interactive === true || query === null;
  if (
    interactive &&
    (!interactiveAvailable ||
      options.json === true ||
      options.prompt === false ||
      options.quiet === true)
  )
    return invalid(
      'interactive search requires terminal input/output without --json, --quiet, or --no-prompt; supply a query',
    );
  return ok({ request: { ...request, query }, interactive });
};
