import { describe, expect, test } from 'bun:test';
import { Argument, Command, Option } from 'commander';
import { renderBash } from '../../src/completion/bash.ts';
import { walk } from '../../src/completion/walk.ts';

const fixture = () => {
  const p = new Command().name('sk').description('root');
  p.command('agents')
    .description('list')
    .addOption(new Option('--format <f>', 'out').choices(['md', 'json']));
  p.command('completion')
    .description('scripts')
    .addArgument(new Argument('<shell>').choices(['bash', 'zsh']));
  return walk(p);
};

describe('renderBash', () => {
  const out = renderBash(fixture());

  test('starts with a shebang-ish comment and install hint', () => {
    expect(out.split('\n')[0]).toMatch(/^#/);
    expect(out).toMatch(/To install:/);
  });

  test('defines a _sk completion function and registers it', () => {
    expect(out).toMatch(/_sk\s*\(\s*\)/);
    expect(out).toMatch(/complete\s+-F\s+_sk\s+sk\b/);
  });

  test('includes subcommand names', () => {
    expect(out).toContain('agents');
    expect(out).toContain('completion');
  });

  test('includes enum values for options', () => {
    expect(out).toContain('md');
    expect(out).toContain('json');
  });

  test('includes enum values for positional args', () => {
    expect(out).toContain('bash');
    expect(out).toContain('zsh');
  });
});
