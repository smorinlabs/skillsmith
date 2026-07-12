import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installSignalHandler } from '../../src/util/signals.ts';

describe('installSignalHandler', () => {
  afterEach(() => {
    // Tests deliberately set process.exitCode via the handler; reset so a
    // non-zero value does not leak into the bun test runner's own exit.
    process.exitCode = 0;
  });
  afterAll(() => {
    process.exitCode = 0;
  });

  test('starts with no interruption', () => {
    const c = new AbortController();
    const h = installSignalHandler(c);
    try {
      expect(h.wasInterrupted()).toBe(false);
      expect(h.exitCode()).toBeUndefined();
      expect(c.signal.aborted).toBe(false);
    } finally {
      h.uninstall();
    }
  });

  test('SIGINT aborts the controller, sets exitCode 130', () => {
    const c = new AbortController();
    const h = installSignalHandler(c);
    try {
      process.emit('SIGINT');
      expect(h.wasInterrupted()).toBe(true);
      expect(h.exitCode()).toBe(130);
      expect(c.signal.aborted).toBe(true);
      expect(process.exitCode).toBe(130);
    } finally {
      h.uninstall();
    }
  });

  test('SIGTERM aborts the controller, normalizes to exitCode 130', () => {
    const c = new AbortController();
    const h = installSignalHandler(c);
    try {
      process.emit('SIGTERM');
      expect(h.wasInterrupted()).toBe(true);
      expect(h.exitCode()).toBe(130);
      expect(c.signal.aborted).toBe(true);
      expect(process.exitCode).toBe(130);
    } finally {
      h.uninstall();
    }
  });

  test('uninstall removes listeners for both signals', () => {
    const c = new AbortController();
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const h = installSignalHandler(c);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
    h.uninstall();
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  test('the first handled signal remains stable when another follows', () => {
    const c = new AbortController();
    const h = installSignalHandler(c);
    try {
      process.emit('SIGTERM');
      expect(h.exitCode()).toBe(130);
      process.emit('SIGINT');
      expect(h.exitCode()).toBe(130);
      expect(process.exitCode).toBe(130);
    } finally {
      h.uninstall();
    }
  });
});
