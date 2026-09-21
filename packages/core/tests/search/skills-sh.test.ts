import { describe, expect, test } from 'bun:test';
import { toPortError } from '../../src/ports/errors.ts';
import { createSkillsShProvider, parseSkillsShResponse } from '../../src/search/skills-sh.ts';
import {
  encodedSearch,
  searchPayload,
  searchPorts,
  searchRequest,
  settleSearch,
} from '../fixtures/search.ts';

describe('skills.sh provider', () => {
  test('uses the anonymous endpoint, encodes query/owner, and preserves provider order', async () => {
    const ports = searchPorts({
      get: async (input) => {
        expect(input.url).toBe(
          'https://skills.sh/api/search?q=react+%26+native&limit=20&owner=expo',
        );
        expect(input.maxResponseBytes).toBe(10_000_000);
        return { status: 200, body: encodedSearch(), retryAfter: null };
      },
    });
    const result = await createSkillsShProvider(ports).search({
      ...searchRequest,
      query: 'react & native',
      owner: 'expo',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results.map((hit) => hit.installs)).toEqual([4, 9]);
      expect(result.value.results[0]?.verification).toBe('not-checked');
      expect(result.value).not.toHaveProperty('searchVersion');
      expect(result.value.results[0]).not.toHaveProperty('installHint');
      expect(result.value.returned).toBe(2);
    }
    expect(ports.pending()).toBe(0);
  });
  test('accepts empty success and incomplete source metadata without inventing installation identities', () => {
    const empty = parseSkillsShResponse(encodedSearch({ skills: [] }), searchRequest);
    expect(empty.ok && empty.value.returned).toBe(0);
    const result = parseSkillsShResponse(
      encodedSearch({ skills: [{ id: 'a/b/c', name: 'actual name' }] }),
      searchRequest,
    );
    expect(result.ok && result.value.results[0]).toEqual({
      kind: 'skill',
      catalogId: 'a/b/c',
      providerSkillId: null,
      name: 'actual name',
      source: null,
      installs: null,
      url: 'https://skills.sh/a/b/c',
      verification: 'not-checked',
    });
  });
  test('rejects malformed consumed fields, duplicate IDs and invalid UTF-8 without dropping rows', () => {
    const hit = searchPayload.skills[0];
    for (const payload of [
      null,
      {},
      { skills: 'wrong' },
      { skills: [hit, hit] },
      ...[
        { id: '../bad' },
        { id: 'a//b' },
        { id: 'a/\u001b/b' },
        { id: 'a/b/\uD800' },
        { id: 'a/b/\uDC00' },
        { name: '' },
        { installs: -1 },
        { installs: 1.1 },
        { source: {} },
        { skillId: 9 },
      ].map((change) => ({ skills: [{ ...hit, ...change }] })),
    ])
      expect(parseSkillsShResponse(encodedSearch(payload), searchRequest).ok).toBe(false);
    expect(parseSkillsShResponse(new Uint8Array([255]), searchRequest).ok).toBe(false);
    expect(parseSkillsShResponse(encodedSearch(), { ...searchRequest, limit: 1 }).ok).toBe(false);
  });
  test('performs at most one retry within the same deadline and respects Retry-After', async () => {
    let calls = 0;
    const ports = searchPorts({
      get: async () => ({
        status: ++calls === 1 ? 429 : 200,
        body: encodedSearch(),
        retryAfter: '1',
      }),
    });
    const pending = createSkillsShProvider(ports).search(searchRequest);
    await settleSearch();
    expect(calls).toBe(1);
    ports.advance(999);
    await settleSearch();
    expect(calls).toBe(1);
    ports.advance(1);
    await settleSearch();
    expect((await pending).ok).toBe(true);
    expect(calls).toBe(2);
    expect(ports.pending()).toBe(0);
  });
  test('cannot fit retry delay, does not retry other statuses or malformed success', async () => {
    for (const status of [429, 500, 401, 302, 200]) {
      let calls = 0;
      const ports = searchPorts({
        get: async () => {
          calls++;
          return { status, retryAfter: '120', body: encodedSearch({ invalid: true }) };
        },
      });
      expect((await createSkillsShProvider(ports).search(searchRequest)).ok).toBe(false);
      expect(calls).toBe(1);
      expect(ports.pending()).toBe(0);
    }
  });
  test('accepts HTTP-date Retry-After and uses the fallback for malformed date syntax', async () => {
    for (const [header, delay] of [
      [new Date(1_800_000_001_000).toUTCString(), 1_000],
      ['2099-01-01T00:00:00Z', 250],
    ] as const) {
      let calls = 0;
      const ports = searchPorts({
        get: async () => ({
          status: ++calls === 1 ? 503 : 200,
          body: encodedSearch(),
          retryAfter: header,
        }),
      });
      const pending = createSkillsShProvider(ports).search(searchRequest);
      await settleSearch();
      ports.advance(delay - 1);
      await settleSearch();
      expect(calls).toBe(1);
      ports.advance(1);
      await settleSearch();
      expect(calls).toBe(2);
      expect((await pending).ok).toBe(true);
      expect(ports.pending()).toBe(0);
    }
  });
  test('retries only a trusted transient HTTP error, never oversized or unknown exceptions', async () => {
    let calls = 0;
    const ports = searchPorts({
      get: async () => {
        calls++;
        throw toPortError(null, {
          capability: 'http',
          operation: 'get',
          code: 'io',
          context: { retryable: true },
        });
      },
    });
    const pending = createSkillsShProvider(ports).search(searchRequest);
    await settleSearch();
    ports.advance(250);
    await settleSearch();
    expect((await pending).ok).toBe(false);
    expect(calls).toBe(2);
    expect(ports.pending()).toBe(0);
    const oversized = createSkillsShProvider(
      searchPorts({
        get: async () => {
          throw toPortError(null, {
            capability: 'http',
            operation: 'get',
            code: 'invalid',
            context: { reason: 'response-too-large' },
          });
        },
      }),
    );
    expect(await oversized.search(searchRequest)).toMatchObject({
      ok: false,
      error: { code: 'search-response-too-large' },
    });
    const broken = createSkillsShProvider(
      searchPorts({
        get: async () => {
          throw new Error('programming error');
        },
      }),
    );
    await expect(broken.search(searchRequest)).rejects.toThrow('programming error');
  });
});
