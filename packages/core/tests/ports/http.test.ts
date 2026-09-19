import { describe, expect, test } from 'bun:test';
import { createHttpPort } from '../../src/ports/http.ts';

const rejectsWhenAborted = (errorName: 'AbortError' | 'TimeoutError') =>
  createHttpPort(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('request stopped', errorName));
        if (init.signal?.aborted) rejectAbort();
        else init.signal?.addEventListener('abort', rejectAbort, { once: true });
      }),
  );

describe('HttpPort', () => {
  test('sanitizes an invalid request before it can leak a fetch exception', async () => {
    const http = createHttpPort();
    let failure: unknown;
    try {
      await http.request({
        url: 'not a valid URL',
        method: 'HEAD',
        headers: {},
        timeoutMs: 100,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ capability: 'http', operation: 'request' });
    expect(failure).not.toHaveProperty('cause');
  });

  test('maps parent AbortError cancellation to cancelled', async () => {
    const controller = new AbortController();
    const pending = rejectsWhenAborted('AbortError').request({
      url: 'https://example.invalid',
      method: 'HEAD',
      headers: {},
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      capability: 'http',
      operation: 'request',
      code: 'cancelled',
    });
  });

  test('maps adapter TimeoutError expiry to timeout', async () => {
    await expect(
      rejectsWhenAborted('TimeoutError').request({
        url: 'https://example.invalid',
        method: 'HEAD',
        headers: {},
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({
      capability: 'http',
      operation: 'request',
      code: 'timeout',
    });
  });
});
