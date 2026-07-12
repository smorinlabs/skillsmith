import { describe, expect, test } from 'bun:test';
import type { SkillSmithError } from '@skillsmith/core';
import { exitCodeForError, selectExitCode } from '../../src/util/exit-codes.ts';

describe('selectExitCode', () => {
  test('empty and success-only outcomes select 0', () => {
    expect(selectExitCode([])).toBe(0);
    expect(selectExitCode([0, 0])).toBe(0);
  });

  test('cancellation wins over every completed outcome', () => {
    expect(selectExitCode([7, 6, 130, 1])).toBe(130);
  });

  test('errors beat drift and use deterministic numeric precedence', () => {
    expect(selectExitCode([7, 1])).toBe(1);
    expect(selectExitCode([2, 6, 3, 7])).toBe(6);
    expect(selectExitCode([7, 0])).toBe(7);
  });
});

describe('exitCodeForError', () => {
  test("'generic' → 1", () => {
    const e: SkillSmithError = { code: 'generic', message: 'boom' };
    expect(exitCodeForError(e)).toBe(1);
  });
  test("'unknown-tool' → 2", () => {
    const e: SkillSmithError = { code: 'unknown-tool', tool: 'x' };
    expect(exitCodeForError(e)).toBe(2);
  });
  test("'config-error' → 3", () => {
    const e: SkillSmithError = { code: 'config-error', message: 'boom' };
    expect(exitCodeForError(e)).toBe(3);
  });
  test("'skill-parse-error' → 1", () => {
    const e: SkillSmithError = { code: 'skill-parse-error', message: 'x', file: 'y' };
    expect(exitCodeForError(e)).toBe(1);
  });
  test("'flip-failed' → 1", () => {
    const e: SkillSmithError = { code: 'flip-failed', message: 'x' };
    expect(exitCodeForError(e)).toBe(1);
  });
  test("'flip-refused' → 2", () => {
    const e: SkillSmithError = { code: 'flip-refused', message: 'x' };
    expect(exitCodeForError(e)).toBe(2);
  });
  test("'ledger-error' → 3", () => {
    const e: SkillSmithError = { code: 'ledger-error', message: 'x' };
    expect(exitCodeForError(e)).toBe(3);
  });
  test("'placement-not-found' → 4", () => {
    const e: SkillSmithError = { code: 'placement-not-found', message: 'x' };
    expect(exitCodeForError(e)).toBe(4);
  });
  test("'source-unresolvable' → 5", () => {
    const e: SkillSmithError = { code: 'source-unresolvable', message: 'x' };
    expect(exitCodeForError(e)).toBe(5);
  });
  test("'permission-denied' → 6", () => {
    const e: SkillSmithError = { code: 'permission-denied', message: 'x' };
    expect(exitCodeForError(e)).toBe(6);
  });
});
