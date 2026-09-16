import { describe, expect, test } from 'bun:test';
import { renderListHuman } from '../../src/output/list-human.ts';

describe('list empty result truthfulness (#41)', () => {
  test('duplicate filter reports no matches, not no installed skills', () => {
    expect(renderListHuman([], { long: false, duplicates: true })).toBe(
      'No duplicate skills matched the selected inventory.\n',
    );
  });
  test('other filters report no matching skills', () => {
    expect(renderListHuman([], { long: false, filtered: true })).toBe(
      'No skills matched the active filters.\n',
    );
  });
  test('unfiltered empty inventory preserves its actual empty message', () => {
    expect(renderListHuman([], { long: false })).toBe('No skills installed.\n');
  });
});
