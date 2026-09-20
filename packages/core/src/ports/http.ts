import { isNormalizedPortError, toPortError } from './errors.ts';
import type { HttpPort, HttpReadPort } from './types.ts';

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

const cancelledRead = () =>
  toPortError(null, {
    capability: 'http',
    operation: 'get',
    code: 'cancelled',
    message: 'HTTP read cancelled',
  });

/** Also settles when an injected fetch/stream does not cooperate with cancellation. */
const abortable = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(cancelledRead());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });

const transientConnectionError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  return (
    typeof code === 'string' &&
    ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code)
  );
};

/** fetch supplies decompressed bytes. The ceiling is enforced before retaining each chunk. */
export const createHttpReadPort = (fetchRequest: FetchRequest = fetch): HttpReadPort => ({
  get: async ({ url, maxResponseBytes, signal }) => {
    if (
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 2_147_483_647
    )
      throw toPortError(null, {
        capability: 'http',
        operation: 'get',
        code: 'invalid',
        message: 'invalid response byte limit',
      });
    if (signal.aborted) throw cancelledRead();
    let reader:
      | Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'>
      | undefined;
    try {
      const pending = fetchRequest(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal,
      });
      // If cancellation wins before headers, dispose a late response too.
      void pending.then(
        (response) => {
          if (signal.aborted) void response.body?.cancel().catch(() => {});
        },
        () => {},
      );
      const response = await abortable(pending, signal);
      const facts = { status: response.status, retryAfter: response.headers.get('retry-after') };
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { ...facts, body: new Uint8Array() };
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxResponseBytes)
            throw toPortError(null, {
              capability: 'http',
              operation: 'get',
              code: 'invalid',
              message: 'decoded HTTP response exceeds the byte limit',
              context: { reason: 'response-too-large', maxResponseBytes },
            });
          chunks.push(chunk.value);
        }
      }
      if (signal.aborted) throw cancelledRead();
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { ...facts, body };
    } catch (error) {
      if (signal.aborted) throw cancelledRead();
      if (isNormalizedPortError(error)) throw error;
      throw toPortError(null, {
        capability: 'http',
        operation: 'get',
        code: 'io',
        message: 'HTTP response could not be read',
        context: { retryable: transientConnectionError(error) },
      });
    } finally {
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  },
});
