const DEFAULT_TIMEOUT_MS = 2000;

export const runVersionCommand = async (
  binaryPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | 'unknown'> => {
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
    controller.signal.addEventListener('abort', abortHandler, { once: true });
    const exit = await proc.exited;
    controller.signal.removeEventListener('abort', abortHandler);
    if (exit !== 0) return 'unknown';
    const stdout = await new Response(proc.stdout).text();
    const first = stdout.trim().split('\n')[0]?.trim();
    return first && first.length > 0 ? first : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
};
