import { describe, expect, test } from 'bun:test';
import { createHttpReadPort } from '../../src/ports/http.ts';

const request = (signal = new AbortController().signal, maxResponseBytes = 4) => ({
  url: 'https://fixture.invalid/search',
  signal,
  maxResponseBytes,
});

describe('bounded HTTP GET capability', () => {
  test('counts decoded bytes, accepting the exact boundary regardless of headers', async () => {
    const bytes = new TextEncoder().encode('éé');
    const port = createHttpReadPort(async (_url, init) => {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('manual');
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 1));
            controller.enqueue(bytes.slice(1));
            controller.close();
          },
        }),
        { headers: { 'Content-Length': '1' } },
      );
    });
    expect((await port.get(request())).body).toEqual(bytes);
  });
  test('cancels immediately when a chunk exceeds the body ceiling', async () => {
    let cancelled = 0;
    const port = createHttpReadPort(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(5));
            },
            cancel() {
              cancelled++;
            },
          }),
        ),
    );
    await expect(port.get(request())).rejects.toMatchObject({
      code: 'invalid',
      context: { reason: 'response-too-large' },
    });
    expect(cancelled).toBe(1);
  });
  test('settles cancellation when headers or body stall and disposes late bodies', async () => {
    for (const stage of ['headers', 'body']) {
      const controller = new AbortController();
      let cancelled = 0;
      let complete: (value: Response) => void = () => {};
      const response = () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
        );
      const port = createHttpReadPort(async () =>
        stage === 'headers'
          ? new Promise((resolve) => {
              complete = resolve;
            })
          : response(),
      );
      const pending = port.get(request(controller.signal));
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      if (stage === 'headers') {
        complete(response());
        await Promise.resolve();
        await Promise.resolve();
      }
      expect(cancelled).toBe(1);
    }
  });
  test('pre-aborted and invalid requests never fetch; ordinary and transient failures stay separate', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const port = createHttpReadPort(async () => {
      calls++;
      throw new TypeError('untrusted private content');
    });
    await expect(port.get(request(controller.signal))).rejects.toMatchObject({ code: 'cancelled' });
    await expect(port.get(request(undefined, 0))).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toBe(0);
    await expect(port.get(request())).rejects.toMatchObject({
      context: { retryable: false },
      message: 'HTTP response could not be read',
    });
    const retry = createHttpReadPort(async () => {
      throw Object.assign(new Error('private'), { code: 'ECONNRESET' });
    });
    await expect(retry.get(request())).rejects.toMatchObject({ context: { retryable: true } });
  });
  test('discards unused error bodies without parsing them', async () => {
    let cancelled = false;
    const port = createHttpReadPort(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 429, headers: { 'retry-after': '2' } },
        ),
    );
    expect(await port.get(request())).toEqual({
      status: 429,
      retryAfter: '2',
      body: new Uint8Array(),
    });
    expect(cancelled).toBe(true);
  });
  test('production Bun fetch enforces the limit after gzip decompression on loopback', async () => {
    const decoded = 'x'.repeat(1_000);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const compressed = Bun.gzipSync(decoded);
        return new Response(
          new URL(request.url).pathname === '/truncated' ? compressed.slice(0, -8) : compressed,
          { headers: { 'Content-Encoding': 'gzip' } },
        );
      },
    });
    try {
      const port = createHttpReadPort();
      const input = {
        ...request(),
        url: `http://127.0.0.1:${server.port}/`,
        maxResponseBytes: 1_000,
      };
      expect((await port.get(input)).body.byteLength).toBe(1_000);
      await expect(port.get({ ...input, maxResponseBytes: 999 })).rejects.toMatchObject({
        context: { reason: 'response-too-large' },
      });
      await expect(port.get({ ...input, url: `${input.url}truncated` })).rejects.toMatchObject({
        code: 'io',
        context: { retryable: false },
        message: 'HTTP response could not be read',
      });
    } finally {
      server.stop(true);
    }
  });
});
