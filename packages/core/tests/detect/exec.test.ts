import { describe, expect, test } from 'bun:test';
import { runVersionCommand } from '../../src/detect/exec.ts';

describe('runVersionCommand', () => {
  test("returns 'unknown' for a non-existent binary", async () => {
    const v = await runVersionCommand('/nope/definitely/not/here', ['--version']);
    expect(v).toBe('unknown');
  });

  test('returns stdout (trimmed first line) for a real tool', async () => {
    const bunPath = Bun.which('bun') ?? 'bun';
    const v = await runVersionCommand(bunPath, ['--version']);
    expect(v).not.toBe('unknown');
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("returns 'unknown' when the process exceeds the timeout", async () => {
    const sleep = Bun.which('sleep');
    if (!sleep) return;
    const v = await runVersionCommand(sleep, ['5']);
    expect(v).toBe('unknown');
  }, 5000);

  test("returns 'unknown' immediately when the parent signal is already aborted", async () => {
    const bunPath = Bun.which('bun') ?? 'bun';
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const v = await runVersionCommand(bunPath, ['--version'], controller.signal);
    const elapsed = Date.now() - started;
    expect(v).toBe('unknown');
    expect(elapsed).toBeLessThan(100);
  });
});
