import { describe, expect, test } from 'bun:test';
import type { SkillSmithError } from '@skillsmith/core';
import { exitCodeForError } from '../../src/util/exit-codes.ts';

describe('exitCodeForError', () => {
  test("'generic' → 1", () => {
    const e: SkillSmithError = { code: 'generic', message: 'boom' };
    expect(exitCodeForError(e)).toBe(1);
  });
  test("'unknown-tool' → 2", () => {
    const e: SkillSmithError = { code: 'unknown-tool', tool: 'x' };
    expect(exitCodeForError(e)).toBe(2);
  });
});
