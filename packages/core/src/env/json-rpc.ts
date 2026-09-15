import type { ExecOptions, ExecResult } from './types.ts';

const STDOUT_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;

/** A finite request/response exchange; no model/tool methods are supplied by this transport. */
export const execJsonRpcCommand = async (
  command: string,
  args: readonly string[],
  options: ExecOptions,
  env: Record<string, string | undefined>,
): Promise<ExecResult> => {
  const messages = options.jsonRpc ?? [];
  const deadline = options.timeoutMs ?? 20_000;
  if (options.signal?.aborted) {
    return { code: -1, stdout: '', stderr: '', timedOut: false, protocolError: 'cancelled' };
  }
  if (
    options.input !== undefined ||
    messages.length === 0 ||
    messages.at(-1)?.id === undefined ||
    !Number.isFinite(deadline) ||
    deadline <= 0
  ) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      protocolError: 'invalid exchange options',
    };
  }

  let timedOut = false;
  let protocolError: string | undefined;
  let complete = false;
  let next = 0;
  let waitingId: number | undefined;
  let pending = '';
  try {
    const proc = Bun.spawn([command, ...args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const fail = (reason: string): void => {
      protocolError ??= reason;
      proc.kill('SIGKILL');
    };
    const onAbort = (): void => fail('cancelled');
    const timer = setTimeout(() => {
      timedOut = true;
      fail('deadline exceeded');
    }, deadline);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const sendNext = (): void => {
      while (next < messages.length) {
        const message = messages[next++];
        if (!message) return;
        proc.stdin.write(`${JSON.stringify(message)}\n`);
        if (message.id !== undefined) {
          waitingId = message.id;
          return;
        }
      }
      complete = true;
      proc.stdin.end();
    };
    const receive = (text: string): void => {
      if (complete || protocolError) return;
      pending += text;
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) return;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          message = parsed as Record<string, unknown>;
        } catch {
          fail('malformed JSON response');
          return;
        }
        if (!Object.hasOwn(message, 'id') && typeof message.method === 'string') continue;
        if (message.id !== waitingId || typeof message.method === 'string') {
          fail('unexpected response id');
          return;
        }
        if (Object.hasOwn(message, 'error')) {
          const error = message.error;
          const code =
            error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
              ? error.code
              : 'unknown';
          fail(`RPC error ${code}`);
          return;
        }
        if (!Object.hasOwn(message, 'result')) {
          fail('missing result');
          return;
        }
        waitingId = undefined;
        sendNext();
        if (complete) return;
      }
    };
    const read = async (
      stream: ReadableStream<Uint8Array>,
      limit: number,
      onText?: (text: string) => void,
    ): Promise<string> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let result = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return result + decoder.decode();
          const available = Math.max(0, limit - bytes);
          const text = decoder.decode(chunk.value.subarray(0, available), { stream: true });
          bytes += chunk.value.byteLength;
          result += text;
          if (bytes > limit) fail('output limit exceeded');
          else onText?.(text);
        }
      } finally {
        reader.releaseLock();
      }
    };
    try {
      if (options.signal?.aborted) onAbort();
      else sendNext();
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        read(proc.stdout, STDOUT_LIMIT, receive),
        read(proc.stderr, STDERR_LIMIT),
      ]);
      if (!complete) protocolError ??= 'incomplete exchange';
      return { code, stdout, stderr, timedOut, ...(protocolError ? { protocolError } : {}) };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
        await proc.exited;
      }
    }
  } catch {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut,
      protocolError: protocolError ?? 'process exchange failed',
    };
  }
};
