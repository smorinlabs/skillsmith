import { afterEach, describe, expect, test } from 'bun:test';
import type { SkillSmithError } from '@skillsmith/core';
import {
  type ExitCode,
  exitCodeForError,
  selectExitCode,
} from '../../../packages/cli/src/util/exit-codes.ts';
import { installSignalHandler } from '../../../packages/cli/src/util/signals.ts';

describe('EWP-P1-TS06', () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test('the centralized selector covers the complete 0-7/130 taxonomy', () => {
    const codes = [0, 1, 2, 3, 4, 5, 6, 7, 130] as const satisfies readonly ExitCode[];
    expect(selectExitCode([])).toBe(0);
    for (const code of codes) expect(selectExitCode([code])).toBe(code);
  });

  test('actual errors beat drift and cancellation beats every completed outcome', () => {
    expect(selectExitCode([7, 1])).toBe(1);
    expect(selectExitCode([6, 7])).toBe(6);
    expect(selectExitCode([7, 3, 130, 1])).toBe(130);
  });

  test('precedence within actual errors is deterministic numeric maximum for every permutation', () => {
    for (const codes of [
      [1, 2, 3, 4, 5, 6],
      [6, 5, 4, 3, 2, 1],
      [3, 1, 6, 2, 5, 4],
      [2, 6, 1, 5, 3, 4],
    ] as const) {
      expect(selectExitCode(codes)).toBe(6);
    }
  });

  test('current error classes map into the shared semantic selector', () => {
    const errors: readonly SkillSmithError[] = [
      { code: 'generic', message: 'execution' },
      { code: 'flip-refused', message: 'usage' },
      { code: 'ledger-error', message: 'state' },
      { code: 'tool-unavailable', message: 'capability' },
      { code: 'source-unresolvable', message: 'source' },
      { code: 'permission-denied', message: 'filesystem' },
    ];
    expect(errors.map(exitCodeForError)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(selectExitCode([7, ...errors.map(exitCodeForError)])).not.toBe(7);
  });

  test('all handled user cancellation normalizes to exit 130', () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const controller = new AbortController();
      const handle = installSignalHandler(controller);
      try {
        process.emit(signal);
        expect(controller.signal.aborted).toBeTrue();
        expect(handle.exitCode()).toBe(130);
        expect(process.exitCode).toBe(130);
      } finally {
        handle.uninstall();
        process.exitCode = 0;
      }
    }
  });

  test('the first cancellation remains stable when another handled signal follows', () => {
    const controller = new AbortController();
    const handle = installSignalHandler(controller);
    try {
      process.emit('SIGINT');
      expect(handle.exitCode()).toBe(130);
      process.emit('SIGTERM');
      expect(handle.exitCode()).toBe(130);
      expect(process.exitCode).toBe(130);
    } finally {
      handle.uninstall();
    }
  });
});
