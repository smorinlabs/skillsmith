import { describe, expect, test } from 'bun:test';
import { createHttpReadPort } from '../../src/ports/http.ts';
import { createSkillsShProvider } from '../../src/search/skills-sh.ts';
import { searchPorts, searchRequest, settleSearch } from '../fixtures/search.ts';

describe('one deadline per search', () => {
  test('covers stalled headers and body without real sleeps', async () => {
    for (const stage of ['headers', 'body']) {
      const ports = searchPorts(
        createHttpReadPort(async () =>
          stage === 'headers' ? new Promise(() => {}) : new Response(new ReadableStream()),
        ),
      );
      const pending = createSkillsShProvider(ports).search(searchRequest);
      await settleSearch();
      ports.advance(120_000);
      expect(await pending).toMatchObject({ ok: false, error: { code: 'search-timeout' } });
      expect(ports.pending()).toBe(0);
    }
  });
  test('first accepted abort cause wins and pre-aborted requests perform no network I/O', async () => {
    for (const cancelFirst of [true, false]) {
      const parent = new AbortController();
      const ports = searchPorts(createHttpReadPort(async () => new Promise(() => {})));
      const pending = createSkillsShProvider(ports).search(searchRequest, parent.signal);
      if (cancelFirst) parent.abort();
      ports.advance(120_000);
      parent.abort();
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: cancelFirst ? 'cancelled' : 'search-timeout' },
      });
      expect(ports.pending()).toBe(0);
    }
    const parent = new AbortController();
    parent.abort();
    const ports = searchPorts({
      get: async () => {
        throw new Error('must not fetch');
      },
    });
    expect(await createSkillsShProvider(ports).search(searchRequest, parent.signal)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    expect(ports.pending()).toBe(0);
  });
  test('the second attempt receives only the remaining budget', async () => {
    let calls = 0;
    const http = createHttpReadPort(async () => {
      calls++;
      if (calls === 1) return new Response('', { status: 503 });
      return new Promise(() => {});
    });
    const ports = searchPorts(http);
    const pending = createSkillsShProvider(ports).search({ ...searchRequest, timeoutMs: 1_000 });
    await settleSearch();
    ports.advance(250);
    await settleSearch();
    expect(calls).toBe(2);
    ports.advance(750);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'search-timeout' } });
    expect(ports.pending()).toBe(0);
  });
  test('a trickling response cannot extend the absolute deadline', async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const ports = searchPorts(
      createHttpReadPort(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                stream = controller;
              },
            }),
          ),
      ),
    );
    const pending = createSkillsShProvider(ports).search({ ...searchRequest, timeoutMs: 1_000 });
    await settleSearch();
    for (let index = 0; index < 3; index++) {
      ports.advance(300);
      stream?.enqueue(new Uint8Array([32]));
      await settleSearch();
    }
    ports.advance(100);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'search-timeout' } });
    expect(ports.pending()).toBe(0);
  });
  test('parent cancellation during retry removes the wait and never issues another request', async () => {
    let calls = 0;
    const parent = new AbortController();
    const ports = searchPorts({
      get: async () => {
        calls++;
        return { status: 503, retryAfter: '1', body: new Uint8Array() };
      },
    });
    const provider = createSkillsShProvider(ports);
    const pending = provider.search(searchRequest, parent.signal);
    await settleSearch();
    expect(ports.pending()).toBe(2);
    parent.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(ports.pending()).toBe(0);
    ports.advance(1_000);
    expect(calls).toBe(1);
  });
});
