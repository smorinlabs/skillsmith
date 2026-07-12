import type { Argument, Command, Option } from 'commander';

export interface CanonicalArgument {
  name: string;
  required: boolean;
  variadic: boolean;
  choices: readonly string[];
  defaultValue: unknown;
}

export interface CanonicalOption {
  flags: string;
  short: string | null;
  long: string | null;
  attributeName: string;
  requiredValue: boolean;
  optionalValue: boolean;
  variadic: boolean;
  negated: boolean;
  choices: readonly string[];
  defaultValue: unknown;
  defaultSource: 'literal' | 'none';
  repeatable: boolean;
  hidden: boolean;
}

export interface CanonicalCommand {
  path: string;
  aliases: readonly string[];
  arguments: readonly CanonicalArgument[];
  options: readonly CanonicalOption[];
  helpOptions: readonly string[];
}

const jsonValue = (value: unknown): unknown => {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
};

const argumentShape = (argument: Argument): CanonicalArgument => ({
  name: argument.name(),
  required: argument.required,
  variadic: argument.variadic,
  choices: [...(argument.argChoices ?? [])].sort(),
  defaultValue: jsonValue(argument.defaultValue),
});

const optionShape = (option: Option): CanonicalOption => ({
  flags: option.flags,
  short: option.short ?? null,
  long: option.long ?? null,
  attributeName: option.attributeName(),
  requiredValue: option.required,
  optionalValue: option.optional,
  variadic: option.variadic,
  negated: option.negate,
  choices: [...(option.argChoices ?? [])].sort(),
  defaultValue: jsonValue(option.defaultValue),
  defaultSource: option.defaultValue === undefined ? 'none' : 'literal',
  repeatable:
    option.variadic ||
    (option.parseArg !== undefined &&
      (Array.isArray(option.defaultValue) || option.attributeName() === 'verbose')),
  hidden: option.hidden,
});

/** Pure, deterministic serialization of the parser declarations; actions and help prose are omitted. */
export const canonicalizeCommanderTree = (root: Command): readonly CanonicalCommand[] => {
  const result: CanonicalCommand[] = [];
  const visit = (command: Command, parentPath: string): void => {
    const path = parentPath ? `${parentPath} ${command.name()}` : command.name();
    const declaredOptions = [...command.options];
    const helpOption = (
      command as Command & { _getHelpOption(): Option | undefined }
    )._getHelpOption();
    if (helpOption?.flags && !declaredOptions.some((option) => option.flags === helpOption.flags)) {
      declaredOptions.push(helpOption);
    }
    result.push({
      path,
      aliases: [...command.aliases()].sort(),
      arguments: command.registeredArguments.map(argumentShape),
      options: declaredOptions.map(optionShape).sort((a, b) => a.flags.localeCompare(b.flags)),
      helpOptions: declaredOptions
        .filter(
          (option) => option.attributeName() === 'help' || option.attributeName() === 'version',
        )
        .map((option) => option.flags)
        .sort(),
    });
    for (const child of [...command.commands].sort((a, b) => a.name().localeCompare(b.name()))) {
      visit(child, path);
    }
  };
  visit(root, '');
  return result;
};

export const surfaceKeys = (surface: readonly CanonicalCommand[]): readonly string[] =>
  surface.flatMap((command) => [
    `command:${command.path}`,
    ...command.aliases.map((alias) => `alias:${command.path}:${alias}`),
    ...command.arguments.map((argument) => `argument:${command.path}:${argument.name}`),
    ...command.options.map((option) => `option:${command.path}:${option.flags}`),
  ]);
