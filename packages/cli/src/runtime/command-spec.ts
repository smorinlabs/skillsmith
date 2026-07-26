import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import {
  COMMAND_GROUP_HEADINGS,
  compareOptionHelpOrder,
  configureProgressiveHelp,
  optionHelpDescription,
  optionHelpHeading,
  renderCommandHelp,
  renderRootHelp,
} from '../help/render.ts';
import type { CommandArgumentSpec, CommandOptionSpec, CommandSpec } from '../spec/types.ts';

const optionChoices = (spec: CommandOptionSpec): readonly string[] => spec.parserValues ?? [];

const isSingular = (spec: CommandOptionSpec): boolean =>
  ['--config', '--file', '--lockfile', '--ref', '--source', '--dest'].includes(spec.long);

const optionForSpec = (spec: CommandOptionSpec): Option => {
  const choices = optionChoices(spec);
  const defaultValue = spec.parsedDefault;
  let option = new Option(spec.flags, optionHelpDescription(spec)).helpGroup(
    optionHelpHeading(spec),
  );
  if (choices.length > 0) option = option.choices([...choices]);
  if (spec.repeatable) {
    if (typeof defaultValue === 'number') {
      option.argParser((_: string, previous: number = defaultValue) => previous + 1);
    } else {
      option.argParser((value: string, previous: string[] = []) => [...previous, value]);
    }
  } else if (spec.valueShape !== 'boolean' && isSingular(spec)) {
    option.argParser((value: string, previous?: string) => {
      if (previous !== undefined)
        throw new InvalidArgumentError(`${spec.long} may only be specified once`);
      return value;
    });
  }
  if (defaultValue !== undefined && !spec.negated) option.default(defaultValue);
  return option;
};

const argumentForSpec = (spec: CommandArgumentSpec): Argument => {
  const suffix = spec.variadic ? '...' : '';
  const syntax = spec.required ? `<${spec.name}${suffix}>` : `[${spec.name}${suffix}]`;
  const argument = new Argument(syntax, spec.description ?? '');
  if ((spec.choices?.length ?? 0) > 0) argument.choices([...spec.choices]);
  if (spec.defaultValue !== undefined) argument.default(spec.defaultValue);
  return argument;
};

export const leafName = (spec: Pick<CommandSpec, 'name' | 'path'>): string =>
  (spec.path ?? spec.name).split(' ').at(-1) ?? spec.name;

/** Construct a fresh Commander node exclusively from one CommandSpec using public APIs. */
export const createCommandFromSpec = (spec: CommandSpec): Command => {
  const command = new Command(leafName(spec)).allowExcessArguments(false);
  configureProgressiveHelp(command, spec);
  for (const alias of spec.aliases) command.alias(alias);
  for (const argument of spec.arguments) command.addArgument(argumentForSpec(argument));
  for (const option of spec.options.toSorted(compareOptionHelpOrder)) {
    if (option.attributeName === 'help') {
      command.addHelpOption(optionForSpec(option));
    } else {
      command.addOption(optionForSpec(option));
      if (option.negated && option.parsedDefault !== undefined) {
        command.setOptionValueWithSource(option.attributeName, option.parsedDefault, 'default');
      }
    }
  }
  const baseHelpInformation = command.helpInformation.bind(command);
  command.helpInformation = () =>
    spec.path === 'skillsmith'
      ? renderRootHelp(spec, baseHelpInformation())
      : renderCommandHelp(spec, baseHelpInformation());
  return command;
};

export type CommandActionFactory = (
  spec: CommandSpec,
  command: Command,
) => (...values: unknown[]) => void | Promise<void>;

/** Attach every non-root spec to a fresh path and bind exactly one generic action factory. */
export const attachCommandSpecs = (
  root: Command,
  specs: readonly CommandSpec[],
  actionFactory: CommandActionFactory,
): Command => {
  const byPath = new Map<string, Command>([['skillsmith', root]]);
  const ordered = specs
    .filter((spec) => spec.path !== 'skillsmith')
    .toSorted(
      (left, right) =>
        left.path.split(' ').length - right.path.split(' ').length ||
        left.helpOrder - right.helpOrder,
    );
  for (const spec of ordered) {
    const command = createCommandFromSpec(spec);
    command.helpGroup(COMMAND_GROUP_HEADINGS[spec.group]);
    command.action(actionFactory(spec, command));
    const parentPath = spec.path.split(' ').slice(0, -1).join(' ');
    const parent = byPath.get(parentPath);
    if (parent === undefined) throw new Error(`CommandSpec has no parent: ${spec.path}`);
    parent.addCommand(command);
    byPath.set(spec.path, command);
  }
  return root;
};
