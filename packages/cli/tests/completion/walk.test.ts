import { describe, expect, test } from 'bun:test';
import { Argument, Command, Option } from 'commander';
import { walk } from '../../src/completion/walk.ts';

const buildFixture = (): Command => {
  const program = new Command()
    .name('sk')
    .description('root')
    .addOption(new Option('--color <m>', 'colorize').choices(['auto', 'off']));
  program
    .command('agents')
    .description('list tools')
    .option('-t, --tool <name>', 'repeatable')
    .addOption(new Option('--format <fmt>', 'output').choices(['md', 'json']));
  program
    .command('completion')
    .description('emit completion script')
    .addArgument(new Argument('<shell>', 'target shell').choices(['bash', 'zsh', 'fish']));
  return program;
};

describe('walk', () => {
  test('captures subcommands with descriptions', () => {
    const [root] = walk(buildFixture());
    expect(root?.name).toBe('sk');
    const sub = root?.subcommands.map((s) => s.name).sort();
    expect(sub).toEqual(['agents', 'completion']);
  });

  test('captures enum choices on options', () => {
    const root = walk(buildFixture())[0];
    expect(root).toBeDefined();
    if (!root) return;
    const color = root.options.find((o) => o.long === '--color');
    expect(color?.choices).toEqual(['auto', 'off']);
    const agents = root.subcommands.find((s) => s.name === 'agents');
    expect(agents).toBeDefined();
    const fmt = agents?.options.find((o) => o.long === '--format');
    expect(fmt?.choices).toEqual(['md', 'json']);
  });

  test('captures enum choices on positional arguments', () => {
    const root = walk(buildFixture())[0];
    const completion = root?.subcommands.find((s) => s.name === 'completion');
    expect(completion?.args[0]?.choices).toEqual(['bash', 'zsh', 'fish']);
  });
});
