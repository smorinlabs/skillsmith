import { toPortError } from './errors.ts';
import type { HttpPort } from './types.ts';

type FetchRequest = (url: string, init: RequestInit) => Promise<Response>;

export const createHttpPort = (fetchRequest: FetchRequest = fetch): HttpPort => ({
  request: async ({ url, method, headers, timeoutMs, signal }) => {
    const controller = new AbortController();
    let abortKind: 'cancelled' | 'timeout' | null = null;
    const abort = (kind: 'cancelled' | 'timeout') => {
      if (abortKind !== null) return;
      abortKind = kind;
      controller.abort();
    };
    const onParentAbort = () => abort('cancelled');
    if (signal?.aborted) onParentAbort();
    else signal?.addEventListener('abort', onParentAbort, { once: true });
    const timeout = setTimeout(() => abort('timeout'), timeoutMs);
    try {
      const response = await fetchRequest(url, { method, headers, signal: controller.signal });
      return { status: response.status, ok: response.ok };
    } catch (error) {
      throw toPortError(error, {
        capability: 'http',
        operation: 'request',
        ...(abortKind === null ? {} : { code: abortKind }),
        context: { url, method, timeoutMs },
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onParentAbort);
    }
  },
});
