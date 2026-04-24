import { describe, expect, test } from 'bun:test';
import { Argument, Command, Option } from 'commander';
import { walk } from '../../src/completion/walk.ts';
import { renderZsh } from '../../src/completion/zsh.ts';

const fixture = () => {
  const p = new Command().name('sk').description('root');
  p.command('agents')
    .description('list')
    .addOption(new Option('--format <f>', 'out format').choices(['md', 'json']));
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

  test('emits value-bearing _arguments spec for options with choices (BUG-05)', () => {
    // Correct form: '--format=[desc]:value:(md json)'
    // Incorrect (old): '--format=(md json)'  — zsh would treat as a flag with no value
    expect(out).toMatch(/'--format=\[[^\]]*\]:value:\(md json\)'/);
    expect(out).not.toMatch(/'--format=\(md json\)'/);
  });

  test('escapes colons in descriptions so _describe / _arguments do not truncate (BUG-08)', () => {
    const p = new Command().name('sk');
    p.command('apply').description('Apply skills: download and link');
    const out2 = renderZsh(walk(p));
    // A literal unescaped ':' between 'skills' and ' download' would truncate
    // the description at _describe parse time.
    expect(out2).toContain('skills\\: download and link');
  });
});
