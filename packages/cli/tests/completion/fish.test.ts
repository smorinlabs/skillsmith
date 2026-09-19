import { describe, expect, test } from 'bun:test';
import { generateCompletionScript } from '../../src/completion/adapter.ts';

describe('Fish completion adapter', () => {
  const script = generateCompletionScript('fish');

  test('retains the sourceable Fish function shape', () => {
    expect(script).toMatch(/^# fish completion for skillsmith/m);
    expect(script).toContain('function __skillsmith_perform_completion');
  });

  test('invokes the hidden transport directly with argv elements', () => {
    expect(script).toContain('skillsmith complete -- $args[2..-1] "$lastArg"');
  });

  test('contains no runtime eval', () => {
    expect(script).not.toMatch(/\beval\b/);
  });

  test('registers only Skillsmith', () => {
    expect(script).toContain('complete -c skillsmith');
    expect(script).not.toContain('powershell');
  });
});
