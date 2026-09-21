import { isNormalizedPortError } from '../ports/errors.ts';
import { type Result, err, ok } from '../result.ts';
import { createSearchDeadline, waitForSearchRetry } from './deadline.ts';
import { validateSearchRequest } from './options.ts';
import type {
  SearchFailure,
  SearchHit,
  SearchPorts,
  SearchProvider,
  SearchReport,
  SearchRequest,
} from './types.ts';

const invalidResponse = (): Result<never, SearchFailure> =>
  err({
    code: 'search-invalid-response',
    message: 'skills.sh returned an invalid search response; try again later',
  });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const nullableString = (value: unknown): value is string | null | undefined =>
  value == null || typeof value === 'string';

/** Tolerant external boundary; owned records are constructed field by field. */
export const parseSkillsShResponse = (
  body: Uint8Array,
  request: SearchRequest,
): Result<SearchReport, SearchFailure> => {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return invalidResponse();
  }
  if (!record(raw) || !Array.isArray(raw.skills) || raw.skills.length > request.limit)
    return invalidResponse();
  const seen = new Set<string>();
  const results: SearchHit[] = [];
  for (const hit of raw.skills) {
    if (
      !record(hit) ||
      !nonempty(hit.id) ||
      !nonempty(hit.name) ||
      !nullableString(hit.source) ||
      !nullableString(hit.skillId) ||
      (hit.installs != null &&
        (typeof hit.installs !== 'number' ||
          !Number.isSafeInteger(hit.installs) ||
          hit.installs < 0))
    )
      return invalidResponse();
    if (
      !hit.id.isWellFormed() ||
      /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(hit.id) ||
      hit.id.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      seen.has(hit.id)
    )
      return invalidResponse();
    seen.add(hit.id);
    results.push({
      kind: 'skill',
      catalogId: hit.id,
      providerSkillId: hit.skillId ?? null,
      name: hit.name,
      source: hit.source ?? null,
      installs: (hit.installs as number | null | undefined) ?? null,
      url: `https://skills.sh/${hit.id.split('/').map(encodeURIComponent).join('/')}`,
      verification: 'not-checked',
    });
  }
  return ok({
    provider: 'skills.sh',
    query: request.query,
    owner: request.owner,
    limit: request.limit,
    returned: results.length,
    searchType:
      raw.searchType === 'fuzzy' || raw.searchType === 'semantic' ? raw.searchType : 'unknown',
    results,
  });
};

const retryDelay = (header: string | null, epochMs: number): number => {
  if (header !== null && /^\d+$/.test(header.trim())) {
    const seconds = Number(header.trim());
    return Number.isFinite(seconds) ? seconds * 1_000 : Number.POSITIVE_INFINITY;
  }
  // HTTP-date permits IMF-fixdate and the two obsolete HTTP date formats.
  // Do not let Date.parse reinterpret arbitrary strings such as ISO dates.
  const httpDate =
    /^(?:[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]{2} [A-Z][a-z]{2} (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/;
  const date = header !== null && httpDate.test(header.trim()) ? Date.parse(header) : Number.NaN;
  return Number.isFinite(date) ? Math.max(0, date - epochMs) : 250;
};

export const createSkillsShProvider = (ports: SearchPorts): SearchProvider => ({
  search: async (request, signal) => {
    const valid = validateSearchRequest(request);
    if (!valid.ok) return valid;
    const deadline = createSearchDeadline(request.timeoutMs, ports, signal);
    const url = new URL('https://skills.sh/api/search');
    url.searchParams.set('q', request.query);
    url.searchParams.set('limit', String(request.limit));
    if (request.owner !== null) url.searchParams.set('owner', request.owner);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = deadline.failure();
        if (before) return err(before);
        let retryAfter: string | null = null;
        let retryable = false;
        let failure: SearchFailure = {
          code: 'search-unavailable',
          message: 'skills.sh search is unavailable; try again later',
        };
        try {
          const response = await ports.http.get({
            url: url.href,
            maxResponseBytes: request.maxResponseBytes,
            signal: deadline.signal,
          });
          const expired = deadline.failure();
          if (expired) return err(expired);
          if (response.status >= 200 && response.status < 300) {
            const parsed = parseSkillsShResponse(response.body, request);
            const afterParse = deadline.failure();
            return afterParse ? err(afterParse) : parsed;
          }
          retryAfter = response.retryAfter;
          retryable = [429, 502, 503, 504].includes(response.status);
          if (response.status === 429)
            failure = {
              code: 'search-rate-limited',
              message: 'skills.sh rate limited the search; try again later',
            };
        } catch (error) {
          const expired = deadline.failure();
          if (expired) return err(expired);
          if (!isNormalizedPortError(error)) throw error;
          if (error.context.reason === 'response-too-large')
            return err({
              code: 'search-response-too-large',
              message: `decoded search response exceeds ${request.maxResponseBytes} bytes; adjust --max-response-size to retry`,
            });
          retryable = error.code === 'io' && error.context.retryable === true;
        }
        const delay = retryDelay(retryAfter, ports.clock.epochMilliseconds());
        if (attempt === 1 || !retryable || delay >= deadline.remaining()) return err(failure);
        await waitForSearchRetry(delay, ports.timer, deadline.signal);
      }
      return err({ code: 'search-unavailable', message: 'skills.sh search is unavailable' });
    } finally {
      deadline.dispose();
    }
  },
});
