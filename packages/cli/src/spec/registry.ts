import currentState from '../contracts/commander-current-state-v0.json' with { type: 'json' };
import { optionsForPath } from './options.ts';
import type {
  CommandArgumentSpec,
  CommandGroup,
  CommandSpec,
  OptionRelationSpec,
} from './types.ts';

const PROFILE: Readonly<
  Record<
    string,
    {
      readonly group: CommandGroup;
      readonly question: string;
      readonly capability: string;
      readonly application: string;
    }
  >
> = {
  skillsmith: {
    group: 'maintain',
    question: 'Which SkillSmith task do you want to run?',
    capability: 'dispatch',
    application: 'rootHelp',
  },
  'skillsmith agents': {
    group: 'discover',
    question: 'Which supported tools are available?',
    capability: 'read',
    application: 'agents',
  },
  'skillsmith config': {
    group: 'maintain',
    question: 'Which configuration operation do you need?',
    capability: 'config',
    application: 'configHelp',
  },
  'skillsmith config get': {
    group: 'maintain',
    question: 'What effective configuration value is selected?',
    capability: 'read',
    application: 'configGet',
  },
  'skillsmith config set': {
    group: 'maintain',
    question: 'Which configuration value should be saved?',
    capability: 'write',
    application: 'configSet',
  },
  'skillsmith config list': {
    group: 'maintain',
    question: 'What is the effective configuration?',
    capability: 'read',
    application: 'configList',
  },
  'skillsmith config unset': {
    group: 'maintain',
    question: 'Which configuration value should be removed?',
    capability: 'write',
    application: 'configUnset',
  },
  'skillsmith list': {
    group: 'discover',
    question: 'Which skills are installed?',
    capability: 'read',
    application: 'list',
  },
  'skillsmith commands': {
    group: 'discover',
    question: 'Which slash commands are installed?',
    capability: 'read',
    application: 'commands',
  },
  'skillsmith doctor': {
    group: 'maintain',
    question: 'Is the local SkillSmith environment healthy?',
    capability: 'read',
    application: 'doctor',
  },
  'skillsmith check': {
    group: 'maintain',
    question: 'Are blocking machine and project checks passing?',
    capability: 'read',
    application: 'check',
  },
  'skillsmith verify': {
    group: 'develop',
    question: 'Is this skill or plugin valid?',
    capability: 'verify',
    application: 'verify',
  },
  'skillsmith install': {
    group: 'manage',
    question: 'Which skill source should be installed?',
    capability: 'install',
    application: 'install',
  },
  'skillsmith uninstall': {
    group: 'manage',
    question: 'Which installed skill should be removed?',
    capability: 'uninstall',
    application: 'uninstall',
  },
  'skillsmith dev': {
    group: 'develop',
    question: 'Which skill should use its live development source?',
    capability: 'dev',
    application: 'dev',
  },
  'skillsmith promote': {
    group: 'develop',
    question: 'Which development skill should be pinned?',
    capability: 'promote',
    application: 'promote',
  },
  'skillsmith version': {
    group: 'maintain',
    question: 'Which SkillSmith version is running?',
    capability: 'read',
    application: 'version',
  },
  'skillsmith completion': {
    group: 'maintain',
    question: 'Which shell completion script should be emitted?',
    capability: 'read',
    application: 'completion',
  },
  'skillsmith help': {
    group: 'maintain',
    question: 'Which command or topic needs explanation?',
    capability: 'read',
    application: 'help',
  },
};

type StateArgument = {
  readonly required: boolean;
  readonly variadic: boolean;
  readonly choices: readonly string[];
  readonly defaultValue: string;
};

const commandPaths = currentState
  .filter((row) => row.key.startsWith('command:'))
  .map((row) => row.key.slice('command:'.length));

const aliasesForPath = (path: string): readonly string[] =>
  currentState
    .filter((row) => row.key.startsWith(`alias:${path}:`))
    .map((row) => row.key.slice(`alias:${path}:`.length))
    .sort();

const argumentsForPath = (path: string): readonly CommandArgumentSpec[] =>
  currentState
    .filter(
      (row): row is (typeof currentState)[number] & { argument: StateArgument } =>
        row.key.startsWith(`argument:${path}:`) && 'argument' in row && row.argument !== undefined,
    )
    .map((row) => ({
      name: row.key.slice(`argument:${path}:`.length),
      required: row.argument.required,
      variadic: row.argument.variadic,
      choices: row.argument.choices,
      defaultValue: row.argument.defaultValue === 'null' ? undefined : row.argument.defaultValue,
    }));

export const CURRENT_COMMAND_SPECS: readonly CommandSpec[] = commandPaths.map((path) => {
  const profile = PROFILE[path];
  if (profile === undefined) throw new Error(`missing current CommandSpec profile for ${path}`);
  return Object.freeze({
    // The current registry is intentionally flat. A fully-qualified name keeps
    // generic spec walkers from inventing root-level paths for nested commands.
    name: path,
    path,
    aliases: aliasesForPath(path),
    group: profile.group,
    primaryQuestion: profile.question,
    description: profile.question,
    arguments: argumentsForPath(path),
    options: optionsForPath(path),
    examples: path === 'skillsmith' ? ['skillsmith --help'] : [path],
    capability: profile.capability,
    application: profile.application,
  });
});

const relationCommands = [
  'skillsmith',
  'skillsmith list',
  'skillsmith commands',
  'skillsmith config get',
  'skillsmith config list',
  'skillsmith config set',
  'skillsmith config unset',
  'skillsmith doctor',
  'skillsmith check',
  'skillsmith verify',
  'skillsmith install',
  'skillsmith uninstall',
  'skillsmith dev',
  'skillsmith promote',
] as const;

export const CURRENT_OPTION_RELATIONS: readonly OptionRelationSpec[] = relationCommands.map(
  (command) => ({
    id: `${command.replaceAll(' ', '.')}.option-contract`,
    command,
    kind:
      command === 'skillsmith doctor'
        ? 'requires'
        : command === 'skillsmith dev'
          ? 'cardinality'
          : command.includes('config') ||
              command === 'skillsmith list' ||
              command === 'skillsmith commands'
            ? 'exclusive-group'
            : 'conflicts',
    description: `Current option relations for ${command}`,
  }),
);

export const validateCurrentCommandSpecs = (): readonly string[] => {
  const errors: string[] = [];
  if (new Set(commandPaths).size !== commandPaths.length)
    errors.push('current command paths duplicate');
  if (CURRENT_COMMAND_SPECS.length !== commandPaths.length)
    errors.push('current command registry does not close the current command paths');
  for (const spec of CURRENT_COMMAND_SPECS) {
    if (spec.primaryQuestion.length === 0) errors.push(`${spec.path} has no primary question`);
    if (spec.application.length === 0) errors.push(`${spec.path} has no application reference`);
    if (new Set(spec.options.map((option) => option.long)).size !== spec.options.length)
      errors.push(`${spec.path} has duplicate long options`);
  }
  return errors;
};

export const validateGlobalOptionPermutation = (): readonly string[] => {
  const errors: string[] = [];
  const root = CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith');
  for (const long of [
    '--help',
    '--version',
    '--cd',
    '--config',
    '--color',
    '--no-color',
    '--quiet',
    '--verbose',
    '--no-prompt',
    '--debug',
  ]) {
    if (!root?.options.some((option) => option.long === long))
      errors.push(`missing global ${long}`);
  }
  for (const spec of CURRENT_COMMAND_SPECS.filter((candidate) => candidate.path !== 'skillsmith')) {
    if (spec.options.some((option) => option.long === '--no-prompt'))
      errors.push(`${spec.path} redeclares inherited --no-prompt`);
  }
  return errors;
};

export const validateCurrentOptionRelations = (): readonly string[] => {
  const errors: string[] = [];
  const ids = CURRENT_OPTION_RELATIONS.map((relation) => relation.id);
  if (new Set(ids).size !== ids.length) errors.push('current option relation IDs duplicate');
  for (const command of relationCommands) {
    if (!CURRENT_OPTION_RELATIONS.some((relation) => relation.command === command))
      errors.push(`missing current option relations for ${command}`);
  }
  return errors;
};

export const commandSpecInventory = (specs: readonly unknown[]): unknown =>
  specs.map((value) => {
    if (typeof value !== 'object' || value === null) return value;
    const spec = value as Partial<CommandSpec>;
    return {
      name: spec.name,
      aliases: spec.aliases ?? [],
      group: spec.group,
      primaryQuestion: spec.primaryQuestion,
      examples: spec.examples ?? [],
    };
  });
