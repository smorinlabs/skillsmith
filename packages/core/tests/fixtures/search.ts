import type { SearchPorts, SearchRequest } from '../../src/search/types.ts';

export const searchRequest: SearchRequest = { query: 'react', owner: null, limit: 20, timeoutMs: 120_000, maxResponseBytes: 10_000_000 };
export const searchPayload = { skills: [
  { id: 'acme/skills/different-name', skillId: 'different-name', name: 'different-name', source: 'acme/skills', installs: 4 },
  { id: 'other/repo/popular', name: 'popular', source: 'other/repo', installs: 9 },
], searchType: 'fuzzy', searchVersion: 'legacy', ignored: { data: true } };
export const encodedSearch = (value: unknown = searchPayload) => new TextEncoder().encode(JSON.stringify(value));

export const searchClock = () => {
  let time = 0;
  const pending = new Map<object, { at: number; callback: () => void }>();
  return {
    clock: { monotonicMilliseconds: () => time, epochMilliseconds: () => 1_800_000_000_000 + time },
    timer: { schedule: (delay: number, callback: () => void) => {
      const key = {};
      pending.set(key, { at: time + delay, callback });
      return () => { pending.delete(key); };
    } },
    advance: (ms: number) => {
      time += ms;
      for (const [key, value] of pending) {
        if (value.at <= time) { pending.delete(key); value.callback(); }
      }
    },
    pending: () => pending.size,
  };
};
export const searchPorts = (http: SearchPorts['http']) => ({ ...searchClock(), http });
export const settleSearch = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
