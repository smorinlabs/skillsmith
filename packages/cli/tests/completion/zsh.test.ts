import { describe, expect, test } from 'bun:test';
import { generateCompletionScript } from '../../src/completion/adapter.ts';

describe('zsh completion adapter', () => {
  const script = generateCompletionScript('zsh');

  test('retains the sourceable zsh registration shape', () => {
    expect(script).toMatch(/^#compdef skillsmith/m);
    expect(script).toContain('compdef _skillsmith skillsmith');
  });

  test('invokes the hidden transport with argv-preserving expansion', () => {
    expect(script).toContain('skillsmith complete -- "${(@)args_to_complete}"');
  });

  test('contains no runtime eval or joined request string', () => {
    expect(script).not.toMatch(/\beval\b/);
    expect(script).not.toContain('requestComp=');
  });

  test('assembles _describe flags as an argv array', () => {
    expect(script).toContain('local -a describeArgs');
    expect(script).toContain('_describe "${describeArgs[@]}"');
  });

  test('preserves attached-value prefixes as one quoted value', () => {
    expect(script).toContain('describeArgs+=(-P "$flagPrefix")');
  });
});
