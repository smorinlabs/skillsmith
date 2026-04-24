import { describe, expect, test } from 'bun:test';
import { resolveColorMode } from '../../src/util/color.ts';

describe('resolveColorMode', () => {
  test('--no-color disables', () => {
    expect(resolveColorMode({ color: 'auto', noColor: true, isTTY: true, env: {} })).toBe('off');
  });
  test('--color=never disables', () => {
    expect(resolveColorMode({ color: 'never', noColor: false, isTTY: true, env: {} })).toBe('off');
  });
  test('NO_COLOR disables regardless', () => {
    expect(
      resolveColorMode({ color: 'auto', noColor: false, isTTY: true, env: { NO_COLOR: '1' } }),
    ).toBe('off');
  });
  test('CLICOLOR=0 disables', () => {
    expect(
      resolveColorMode({ color: 'auto', noColor: false, isTTY: true, env: { CLICOLOR: '0' } }),
    ).toBe('off');
  });
  test('TERM=dumb disables', () => {
    expect(
      resolveColorMode({ color: 'auto', noColor: false, isTTY: true, env: { TERM: 'dumb' } }),
    ).toBe('off');
  });
  test('--color=always forces on even without TTY', () => {
    expect(resolveColorMode({ color: 'always', noColor: false, isTTY: false, env: {} })).toBe('on');
  });
  test('FORCE_COLOR forces on', () => {
    expect(
      resolveColorMode({ color: 'auto', noColor: false, isTTY: false, env: { FORCE_COLOR: '1' } }),
    ).toBe('on');
  });
  test('CLICOLOR_FORCE forces on', () => {
    expect(
      resolveColorMode({
        color: 'auto',
        noColor: false,
        isTTY: false,
        env: { CLICOLOR_FORCE: '1' },
      }),
    ).toBe('on');
  });
  test('auto with TTY → on', () => {
    expect(resolveColorMode({ color: 'auto', noColor: false, isTTY: true, env: {} })).toBe('on');
  });
  test('auto without TTY → off', () => {
    expect(resolveColorMode({ color: 'auto', noColor: false, isTTY: false, env: {} })).toBe('off');
  });
});
