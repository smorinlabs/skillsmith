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

  test('escapes backslashes before quotes (BUG-09)', () => {
    const p = new Command().name('sk');
    p.command('grep').description("Pattern e.g. '\\d+' matches digits");
    const out2 = renderFish(walk(p));
    // Backslash must be doubled; the single quote must be backslash-escaped.
    // Expected rendering of the description inside single quotes:
    //   'Pattern e.g. \'\\\\d+\' matches digits'
    expect(out2).toContain('\\\\d+');
    // And the raw, unescaped sequence must NOT appear.
    expect(out2).not.toContain("'\\d+'");
  });
});
