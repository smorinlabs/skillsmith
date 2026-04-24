import { describe, expect, test } from 'bun:test';
import { Argument, Command, Option } from 'commander';
import { walk } from '../../src/completion/walk.ts';
import { renderZsh } from '../../src/completion/zsh.ts';

const fixture = () => {
  const p = new Command().name('sk').description('root');
  p.command('agents')
    .description('list')
    .addOption(new Option('--format <f>', '').choices(['md', 'json']));
  p.command('completion')
    .description('scripts')
    .addArgument(new Argument('<shell>').choices(['bash', 'zsh']));
  return walk(p);
};

describe('renderZsh', () => {
  const out = renderZsh(fixture());

  test('starts with #compdef header', () => {
    expect(out).toMatch(/^#compdef sk\b/m);
  });

  test('uses _describe for subcommand completion', () => {
    expect(out).toContain('_describe');
    expect(out).toContain('agents');
    expect(out).toContain('completion');
  });

  test('contains enum option and positional choices', () => {
    expect(out).toContain('md');
    expect(out).toContain('json');
    expect(out).toContain('bash');
  });
});
