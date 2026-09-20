import type { ClockPort, HttpReadPort, TimerPort } from '../ports/types.ts';
import type { Result } from '../result.ts';

/** A catalog record, independent of installed skills and installation selectors. */
export interface SearchHit {
  readonly kind: 'skill';
  readonly catalogId: string;
  readonly providerSkillId: string | null;
  readonly name: string;
  readonly source: string | null;
  readonly installs: number | null;
  readonly url: string;
  readonly verification: 'not-checked';
}

export interface SearchReport {
  readonly provider: 'skills.sh';
  readonly query: string;
  readonly owner: string | null;
  readonly limit: number;
  readonly returned: number;
  readonly searchType: 'fuzzy' | 'semantic' | 'unknown';
  readonly results: readonly SearchHit[];
}

export interface SearchRequest {
  readonly query: string;
  readonly owner: string | null;
  readonly limit: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface SearchFailure {
  readonly code:
    | 'invalid-argument'
    | 'cancelled'
    | 'search-timeout'
    | 'search-rate-limited'
    | 'search-unavailable'
    | 'search-invalid-response'
    | 'search-response-too-large';
  readonly message: string;
}

export interface SearchProvider {
  search(
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<Result<SearchReport, SearchFailure>>;
}

/** Search cannot read local inventory, write files, or launch processes. */
export interface SearchPorts {
  readonly http: HttpReadPort;
  readonly clock: Pick<ClockPort, 'monotonicMilliseconds' | 'epochMilliseconds'>;
  readonly timer: TimerPort;
}
