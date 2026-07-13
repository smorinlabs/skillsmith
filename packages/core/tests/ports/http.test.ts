import { describe, expect, test } from 'bun:test';
import { createHttpPort } from '../../src/ports/http.ts';

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
});
