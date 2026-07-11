import { describe, expect, test } from 'bun:test';
import { execCommand, runVersionCommand } from '../../src/env/exec.ts';

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

describe('execCommand', () => {
  test('runs a simple command and captures stdout', async () => {
    const r = await execCommand('/bin/echo', ['hi']);
    expect(r).toEqual({ code: 0, stdout: 'hi\n', stderr: '', timedOut: false });
  });

  test('captures non-zero exit code and stderr', async () => {
    const bunPath = Bun.which('bun') ?? 'bun';
    const r = await execCommand(bunPath, ['-e', 'console.error("boom"); process.exit(3)']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('boom');
    expect(r.timedOut).toBe(false);
  });

  test('merges env over process.env rather than replacing it', async () => {
    const bunPath = Bun.which('bun') ?? 'bun';
    const r = await execCommand(bunPath, ['-e', 'console.log(process.env.SKILLSMITH_X)'], {
      env: { SKILLSMITH_X: 'y' },
    });
    expect(r.stdout).toBe('y\n');
    expect(r.timedOut).toBe(false);
    expect(process.env.PATH).toBeTruthy();
  });

  test('unsetEnv removes inherited variables after applying overrides', async () => {
    const bunPath = Bun.which('bun') ?? 'bun';
    const previous = process.env.SKILLSMITH_INHERITED;
    process.env.SKILLSMITH_INHERITED = 'poisoned';
    try {
      const r = await execCommand(
        bunPath,
        ['-e', 'console.log(process.env.SKILLSMITH_INHERITED ?? "absent")'],
        {
          env: { SKILLSMITH_INHERITED: 'reintroduced' },
          unsetEnv: ['SKILLSMITH_INHERITED'],
        },
      );
      expect(r.stdout).toBe('absent\n');
    } finally {
      if (previous === undefined) process.env.SKILLSMITH_INHERITED = undefined;
      else process.env.SKILLSMITH_INHERITED = previous;
    }
  });

  test('sets timedOut when the process exceeds timeoutMs', async () => {
    const sleep = Bun.which('sleep') ?? '/bin/sleep';
    const r = await execCommand(sleep, ['5'], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  }, 5000);

  test('returns promptly with a non-zero code for an already-aborted signal', async () => {
    const bunPath = Bun.which('bun') ?? 'bun';
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const r = await execCommand(bunPath, ['--version'], { signal: controller.signal });
    const elapsed = Date.now() - started;
    expect(r.timedOut).toBe(false);
    expect(r.code).not.toBe(0);
    expect(elapsed).toBeLessThan(100);
  });

  test('does not throw on spawn failure', async () => {
    const r = await execCommand('/nope/definitely/not/here', []);
    expect(r.code).toBe(-1);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.timedOut).toBe(false);
  });
});
