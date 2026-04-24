import type { Argument, Command, Option } from 'commander';
import type { CompletionArg, CompletionNode, CompletionOption } from './types.ts';

const describeOption = (o: Option): CompletionOption => ({
  long: o.long ?? null,
  short: o.short ?? null,
  description: o.description ?? '',
  takesValue: o.required || o.optional,
  choices: o.argChoices && o.argChoices.length > 0 ? [...o.argChoices] : null,
});

const describeArg = (a: Argument): CompletionArg => ({
  name: a.name(),
  required: a.required,
  variadic: a.variadic,
  choices: a.argChoices && a.argChoices.length > 0 ? [...a.argChoices] : null,
});

const describeCommand = (cmd: Command): CompletionNode => {
  const registered = (cmd as unknown as { registeredArguments?: Argument[] }).registeredArguments;
  return {
    name: cmd.name(),
    description: cmd.description(),
    options: cmd.options.map(describeOption),
    args: (registered ?? []).map(describeArg),
    subcommands: cmd.commands.map(describeCommand),
  };
};

export const walk = (program: Command): CompletionNode[] => [describeCommand(program)];
