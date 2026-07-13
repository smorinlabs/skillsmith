import { toPortError } from './errors.ts';
import type { HttpPort } from './types.ts';

export const createHttpPort = (): HttpPort => ({
  request: async ({ url, method, headers, timeoutMs, signal }) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(url, { method, headers, signal: combined });
      return { status: response.status, ok: response.ok };
    } catch (error) {
      throw toPortError(error, {
        capability: 'http',
        operation: 'request',
        context: { url, method, timeoutMs },
      });
    }
  },
});
