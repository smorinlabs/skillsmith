import { describe, expect, test } from 'bun:test';
import { Argument, Command, Option } from 'commander';
import { renderFish } from '../../src/completion/fish.ts';
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

describe('renderFish', () => {
  const out = renderFish(fixture());

  test('emits per-command complete lines', () => {
    expect(out).toMatch(/complete -c sk -f -n '__fish_use_subcommand' -a agents/);
    expect(out).toMatch(/complete -c sk -f -n '__fish_use_subcommand' -a completion/);
  });

  test('emits enum values for options', () => {
    expect(out).toContain('md');
    expect(out).toContain('json');
  });

  test('emits positional choices for subcommands', () => {
    expect(out).toContain('bash');
    expect(out).toContain('zsh');
  });
});
