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
  test('--color=always never contaminates a non-TTY destination', () => {
    expect(resolveColorMode({ color: 'always', noColor: false, isTTY: false, env: {} })).toBe(
      'off',
    );
  });
  test('FORCE_COLOR never contaminates a non-TTY destination', () => {
    expect(
      resolveColorMode({ color: 'auto', noColor: false, isTTY: false, env: { FORCE_COLOR: '1' } }),
    ).toBe('off');
  });
  test('CLICOLOR_FORCE never contaminates a non-TTY destination', () => {
    expect(
      resolveColorMode({
        color: 'auto',
        noColor: false,
        isTTY: false,
        env: { CLICOLOR_FORCE: '1' },
      }),
    ).toBe('off');
  });
  test('explicit force controls enable color on an eligible TTY', () => {
    for (const input of [
      { color: 'always' as const, env: {} },
      { color: 'auto' as const, env: { FORCE_COLOR: '1' } },
      { color: 'auto' as const, env: { CLICOLOR_FORCE: '1' } },
    ]) {
      expect(resolveColorMode({ ...input, noColor: false, isTTY: true })).toBe('on');
    }
  });
  test('auto with TTY → on', () => {
    expect(resolveColorMode({ color: 'auto', noColor: false, isTTY: true, env: {} })).toBe('on');
  });
  test('auto without TTY → off', () => {
    expect(resolveColorMode({ color: 'auto', noColor: false, isTTY: false, env: {} })).toBe('off');
  });
});
