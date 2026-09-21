import type { TimerPort } from '../ports/types.ts';
import type { SearchFailure, SearchPorts } from './types.ts';

export const createSearchDeadline = (
  timeoutMs: number,
  ports: Pick<SearchPorts, 'clock' | 'timer'>,
  parent?: AbortSignal,
) => {
  const controller = new AbortController();
  const end = ports.clock.monotonicMilliseconds() + timeoutMs;
  let reason: SearchFailure | null = null;
  const abort = (code: 'cancelled' | 'search-timeout') => {
    if (reason !== null) return;
    reason = {
      code,
      message:
        code === 'cancelled'
          ? 'search cancelled'
          : `search exceeded its ${timeoutMs}ms deadline; adjust --timeout to retry`,
    };
    controller.abort();
  };
  const onParentAbort = () => abort('cancelled');
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const stop =
    reason === null ? ports.timer.schedule(timeoutMs, () => abort('search-timeout')) : () => {};
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, end - ports.clock.monotonicMilliseconds()),
    failure: (): SearchFailure | null => {
      if (reason === null && ports.clock.monotonicMilliseconds() >= end) abort('search-timeout');
      return reason;
    },
    dispose: () => {
      stop();
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
};

export const waitForSearchRetry = (
  delayMs: number,
  timer: TimerPort,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    let stop = () => {};
    const finish = () => {
      stop();
      signal.removeEventListener('abort', finish);
      resolve();
    };
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', finish, { once: true });
    stop = timer.schedule(delayMs, finish);
  });
