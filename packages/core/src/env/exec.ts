import { execJsonRpcCommand } from './json-rpc.ts';
import type { ExecOptions, ExecResult } from './types.ts';

const DEFAULT_TIMEOUT_MS = 2000;

export const runVersionCommand = async (
  binaryPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | 'unknown'> => {
  if (signal?.aborted) return 'unknown';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const proc = Bun.spawn([binaryPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const abortHandler = () => proc.kill();
    if (controller.signal.aborted) proc.kill();
    else controller.signal.addEventListener('abort', abortHandler, { once: true });
    const [exit, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ''),
    ]);
    controller.signal.removeEventListener('abort', abortHandler);
    if (exit !== 0) return 'unknown';
    const first = stdout.trim().split('\n')[0]?.trim();
    return first && first.length > 0 ? first : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
};

export const execCommand = async (
  cmd: string,
  args: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecResult> => {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const childEnv: Record<string, string | undefined> = { ...process.env, ...opts.env };
  for (const name of opts.unsetEnv ?? []) delete childEnv[name];

  if (opts.jsonRpc) return execJsonRpcCommand(cmd, args, opts, childEnv);

  try {
    const proc = Bun.spawn([cmd, ...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: childEnv,
      stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs);
    }
    onAbort = () => proc.kill();
    if (opts.signal?.aborted) proc.kill();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ''),
      new Response(proc.stderr).text().catch(() => ''),
    ]);
    return { code, stdout, stderr, timedOut };
  } catch (e) {
    return { code: -1, stdout: '', stderr: String(e), timedOut: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) opts.signal?.removeEventListener('abort', onAbort);
  }
};
