import { Argument, type Command, Option } from 'commander';
import type { CommandArgumentSpec, CommandOptionSpec, CommandSpec } from '../spec/types.ts';

type MutableCommandInternals = Command & {
  _aliases: string[];
  _helpOption?: Option;
  removeAllListeners(event: string): Command;
};

const optionChoices = (
  spec: CommandOptionSpec & { readonly choices?: readonly string[] },
): readonly string[] => spec.parserValues ?? spec.choices ?? [];

const optionDefault = (spec: CommandOptionSpec & { readonly defaultValue?: unknown }): unknown =>
  spec.parsedDefault ?? spec.defaultValue;

const optionForSpec = (legacy: Option | undefined, spec: CommandOptionSpec): Option => {
  const choices = optionChoices(spec);
  const defaultValue = optionDefault(spec);
  let option = new Option(spec.flags, legacy?.description ?? '');
  if (choices.length > 0) option = option.choices([...choices]);
  if (spec.repeatable) {
    if (typeof defaultValue === 'number') {
      option.argParser((_: string, previous: number = defaultValue) => previous + 1);
    } else {
      option.argParser((value: string, previous: string[] = []) => [...previous, value]);
    }
  } else if (legacy?.parseArg !== undefined) {
    option.argParser(legacy.parseArg);
  }
  if (defaultValue !== undefined && !spec.negated) option.default(defaultValue);
  return option;
};

const argumentForSpec = (legacy: Argument | undefined, spec: CommandArgumentSpec): Argument => {
  const suffix = spec.variadic ? '...' : '';
  const syntax = spec.required ? `<${spec.name}${suffix}>` : `[${spec.name}${suffix}]`;
  const argument = new Argument(syntax, legacy?.description ?? '');
  if ((spec.choices?.length ?? 0) > 0) argument.choices([...spec.choices]);
  if (spec.defaultValue !== undefined) argument.default(spec.defaultValue);
  return argument;
};

export const leafName = (spec: Pick<CommandSpec, 'name' | 'path'>): string =>
  (spec.path ?? spec.name).split(' ').at(-1) ?? spec.name;

/**
 * Rebuild parser declarations from one CommandSpec while retaining only the template's
 * action, error-boundary hooks, prose descriptions, and specialized value parsers.
 */
export const configureCommandFromSpec = (template: Command, spec: CommandSpec): Command => {
  const internals = template as MutableCommandInternals;
  const optionSpecs = [...spec.options];
  const argumentSpecs = [...spec.arguments];
  const help = optionSpecs.find((option) => option.attributeName === 'help');
  const legacyOptions = [...template.options];
  const legacyArguments = [...template.registeredArguments];
  const legacyHelp = (
    template as Command & { _getHelpOption(): Option | undefined }
  )._getHelpOption();
  for (const option of legacyOptions) internals.removeAllListeners(`option:${option.name()}`);

  template.name(leafName(spec));
  template.description(spec.description);
  internals._aliases = [];
  for (const alias of spec.aliases) template.alias(alias);

  (template.options as Option[]).splice(0, template.options.length);
  (template.registeredArguments as Argument[]).splice(0, template.registeredArguments.length);
  Reflect.deleteProperty(internals, '_helpOption');

  for (const argument of argumentSpecs) {
    const legacy = legacyArguments.find(
      (candidate) => candidate.name() === argument.name.replace(/[<>[\].]/g, ''),
    );
    template.addArgument(argumentForSpec(legacy, argument));
  }
  for (const option of optionSpecs) {
    if (option.attributeName === 'help') continue;
    const legacy = legacyOptions.find(
      (candidate) => candidate.flags === option.flags || candidate.long === option.long,
    );
    template.addOption(optionForSpec(legacy, option));
  }
  if (help !== undefined) template.helpOption(help.flags, legacyHelp?.description ?? '');
  return template;
};

const commandPath = (command: Command, parentPath: string): string =>
  parentPath.length === 0 ? command.name() : `${parentPath} ${command.name()}`;

const collectTemplates = (
  command: Command,
  parentPath: string,
  templates: Map<string, Command>,
): void => {
  const path = commandPath(command, parentPath);
  templates.set(path, command);
  for (const child of command.commands) collectTemplates(child, path, templates);
};

/** Attach the current command tree in spec path order; templates supply action adapters only. */
export const attachCommandSpecs = (
  root: Command,
  specs: readonly CommandSpec[],
  templates: readonly Command[],
): Command => {
  const byPath = new Map<string, Command>();
  collectTemplates(root, '', byPath);
  for (const template of templates) collectTemplates(template, 'skillsmith', byPath);

  const rootSpec = specs.find((spec) => spec.path === 'skillsmith');
  if (rootSpec === undefined) throw new Error('CommandSpec registry is missing skillsmith');
  configureCommandFromSpec(root, rootSpec);

  for (const command of byPath.values()) {
    (command.commands as Command[]).splice(0, command.commands.length);
  }

  const ordered = specs
    .filter((spec) => spec.path !== 'skillsmith')
    .toSorted((left, right) => left.path.split(' ').length - right.path.split(' ').length);
  for (const spec of ordered) {
    const template = byPath.get(spec.path);
    if (template === undefined) throw new Error(`CommandSpec has no action adapter: ${spec.path}`);
    configureCommandFromSpec(template, spec);
    const parentPath = spec.path.split(' ').slice(0, -1).join(' ');
    const parent = byPath.get(parentPath);
    if (parent === undefined) throw new Error(`CommandSpec has no parent adapter: ${spec.path}`);
    parent.addCommand(template);
  }
  return root;
};
