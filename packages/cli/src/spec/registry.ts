import currentState from '../contracts/commander-current-state-v0.json' with { type: 'json' };
import { optionsForPath } from './options.ts';
import type {
  CommandArgumentSpec,
  CommandExitCodeSpec,
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

const DESCRIPTION: Readonly<Record<string, string>> = {
  skillsmith: 'SkillSmith installs and manages agent skills for AI coding tools.',
  'skillsmith agents': 'List every supported tool SkillSmith detects on this system',
  'skillsmith config': 'Manage SkillSmith configuration',
  'skillsmith config get': 'Print a config value',
  'skillsmith config set': 'Set a config value (default scope: user)',
  'skillsmith config list': 'List effective config (or a single scope)',
  'skillsmith config unset': 'Remove a config value (default scope: user)',
  'skillsmith list': 'List installed skills across tools and scopes',
  'skillsmith commands': 'List installed slash commands across tools and scopes',
  'skillsmith doctor': 'Diagnose SkillSmith and target-tool readiness',
  'skillsmith check': 'Error-severity subset of doctor, suitable for CI',
  'skillsmith verify': 'Verify that a plugin loads under each target tool',
  'skillsmith install': 'Install agent skills from a git host.',
  'skillsmith uninstall':
    'Remove installed skills (placements + ledger records; the store is never deleted).',
  'skillsmith dev': 'Flip a skill from production (pinned copy) back to dev mode (symlink).',
  'skillsmith promote': 'Promote a skill from dev mode (symlink) to production (pinned copy).',
  'skillsmith version': 'Print SkillSmith version',
  'skillsmith completion': 'Emit a shell completion script',
  'skillsmith help': 'Help about a command or cross-cutting topic',
};

const ARGUMENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'skillsmith commands:glob': 'Glob filters for installed command names',
  'skillsmith completion:shell': 'Target shell: bash, zsh, or fish',
  'skillsmith config get:key': 'Configuration key to read',
  'skillsmith config set:key': 'Configuration key to write',
  'skillsmith config set:value': 'Configuration value to save',
  'skillsmith config unset:key': 'Configuration key to remove',
  'skillsmith dev:skill': 'Skill names or placement paths',
  'skillsmith help:topic': 'Command name or cross-cutting help topic',
  'skillsmith install:source':
    'owner/repo[/name], owner/repo//path, host/owner/repo[/name], or a git URL; append @ref when needed',
  'skillsmith list:glob': 'Glob filters for installed skill names',
  'skillsmith promote:skill': 'Skill names or placement paths',
  'skillsmith uninstall:skill':
    'Installed skill names or placement paths; use scope or tool flags to disambiguate',
  'skillsmith verify:path': 'Plugin or bare skill directory',
};

const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  skillsmith: ['skillsmith --help', 'skillsmith list --long'],
  'skillsmith agents': ['skillsmith agents --detected-only', 'skillsmith agents --format json'],
  'skillsmith config': ['skillsmith config list', 'skillsmith config get tool'],
  'skillsmith config get': ['skillsmith config get tool', 'skillsmith config get scope --json'],
  'skillsmith config set': [
    'skillsmith config set tool codex',
    'skillsmith config set scope project',
  ],
  'skillsmith config list': [
    'skillsmith config list',
    'skillsmith config list --scope project --json',
  ],
  'skillsmith config unset': [
    'skillsmith config unset tool',
    'skillsmith config unset scope --scope project',
  ],
  'skillsmith list': ['skillsmith list', 'skillsmith list "review-*" --tool codex --long'],
  'skillsmith commands': ['skillsmith commands', 'skillsmith commands "git-*" --project --long'],
  'skillsmith doctor': ['skillsmith doctor', 'skillsmith doctor --all-tools --strict'],
  'skillsmith check': ['skillsmith check', 'skillsmith check --all-tools --json'],
  'skillsmith verify': [
    'skillsmith verify ./skills/review',
    'skillsmith verify ./plugin --deep --strict',
  ],
  'skillsmith install': [
    'skillsmith install smorinlabs/smorinlabs-harness/factor-scan --user',
    'skillsmith install acme/agent-tools/review@v1.2.0 --project --pin',
    'skillsmith install gitlab.com/acme/platform/tools//skills/review --tool claude-code',
    'skillsmith install smorinlabs/smorinlabs-harness/factor-scan --force --ref v2.0.0',
  ],
  'skillsmith uninstall': [
    'skillsmith uninstall factor-scan',
    'skillsmith uninstall review --project',
    'skillsmith rm review --all-scopes --tool codex',
    'skillsmith uninstall factor-scan --dry-run',
  ],
  'skillsmith dev': [
    'skillsmith dev factor-scan',
    'skillsmith dev gh-fix-ci --tool codex --source ~/c/gh-fix-ci/skills/gh-fix-ci',
    'skillsmith dev --all',
    'skillsmith dev --rollback factor-scan',
  ],
  'skillsmith promote': [
    'skillsmith promote factor-scan',
    'skillsmith promote --all --dry-run',
    'skillsmith promote factor-scan --tool claude-code --strict',
    'skillsmith promote --rollback factor-scan',
  ],
  'skillsmith version': ['skillsmith version', 'skillsmith --version'],
  'skillsmith completion': ['skillsmith completion bash', 'skillsmith completion zsh'],
  'skillsmith help': ['skillsmith help install', 'skillsmith help exit-codes'],
};

const exitCodes = (
  ...rows: readonly (readonly [number, string])[]
): readonly CommandExitCodeSpec[] => rows.map(([code, meaning]) => ({ code, meaning }));

const STANDARD_READ_EXIT_CODES = exitCodes(
  [0, 'request completed successfully'],
  [1, 'command failed'],
  [2, 'invalid command usage'],
  [3, 'configuration is unreadable'],
  [130, 'cancelled by SIGINT'],
);

const EXIT_CODES: Readonly<Record<string, readonly CommandExitCodeSpec[]>> = {
  skillsmith: STANDARD_READ_EXIT_CODES,
  'skillsmith agents': exitCodes(
    [0, 'tool detection completed successfully'],
    [1, 'tool detection failed'],
    [2, 'invalid tool or output selection'],
    [130, 'cancelled by SIGINT'],
  ),
  'skillsmith config': STANDARD_READ_EXIT_CODES,
  'skillsmith config get': exitCodes(
    [0, 'configuration value printed'],
    [1, 'key is unset'],
    [2, 'unknown key, value, or scope'],
    [3, 'configuration is unreadable'],
  ),
  'skillsmith config set': exitCodes(
    [0, 'configuration value saved'],
    [2, 'unknown key, invalid value, or unsupported scope'],
    [3, 'configuration is unreadable'],
    [6, 'configuration is not writable'],
  ),
  'skillsmith config list': STANDARD_READ_EXIT_CODES,
  'skillsmith config unset': exitCodes(
    [0, 'configuration value removed'],
    [2, 'unknown key or unsupported scope'],
    [3, 'configuration is unreadable'],
    [6, 'configuration is not writable'],
  ),
  'skillsmith list': STANDARD_READ_EXIT_CODES,
  'skillsmith commands': STANDARD_READ_EXIT_CODES,
  'skillsmith doctor': exitCodes(
    [0, 'diagnostics completed without blocking findings'],
    [1, 'error findings exist, or strict mode found warnings'],
    [2, 'invalid tool, scope, or artifact selection'],
    [3, 'configuration is unreadable'],
    [130, 'cancelled by SIGINT'],
  ),
  'skillsmith check': exitCodes(
    [0, 'blocking checks passed, or --report-only was used'],
    [1, 'one or more error findings exist'],
    [2, 'invalid tool, scope, artifact, or exit-policy selection'],
    [3, 'configuration is unreadable'],
    [130, 'cancelled by SIGINT'],
  ),
  'skillsmith verify': exitCodes(
    [0, 'verification passed'],
    [1, 'verification failed or strict mode found warnings'],
    [2, 'path or option usage is invalid'],
    [4, 'requested target tool or verification mode is unavailable'],
    [130, 'cancelled by SIGINT'],
  ),
  'skillsmith install': exitCodes(
    [0, 'installed, or already at the resolved revision'],
    [1, 'verify gate, snapshot, or swap failed; state is recoverable'],
    [2, 'usage error or refusal, including non-interactive ambiguity'],
    [3, 'placements ledger is unreadable'],
    [4, 'requested target tool is unavailable'],
    [5, 'source, repository, revision, or skill is unresolvable'],
    [6, 'skills directory, store, or ledger is not writable'],
    [130, 'cancelled by SIGINT; state is recoverable'],
  ),
  'skillsmith uninstall': exitCodes(
    [0, 'removed, or already absent'],
    [1, 'removal failed mid-flight; state is recoverable'],
    [2, 'usage error or refusal, including ambiguous or unmanaged placement'],
    [3, 'placements ledger is unreadable'],
    [6, 'skills directory or ledger is not writable'],
    [130, 'cancelled by SIGINT; state is recoverable'],
  ),
  'skillsmith dev': exitCodes(
    [0, 'demoted, or already in dev mode'],
    [1, 'placement flip failed; state is recoverable'],
    [2, 'usage error or refusal, including a missing recorded source'],
    [3, 'placements ledger is unreadable'],
    [4, 'requested skill or tool has no placement'],
    [5, 'recorded development source no longer exists'],
    [6, 'skills directory or ledger is not writable'],
    [130, 'cancelled by SIGINT; state is recoverable'],
  ),
  'skillsmith promote': exitCodes(
    [0, 'promoted, or already pinned'],
    [1, 'verify gate, snapshot, or swap failed; state is recoverable'],
    [2, 'usage error or refusal, including a disallowed dirty tree'],
    [3, 'placements ledger is unreadable'],
    [4, 'requested skill or tool has no placement'],
    [5, 'development source is unresolvable'],
    [6, 'skills directory, store, or ledger is not writable'],
    [130, 'cancelled by SIGINT; state is recoverable'],
  ),
  'skillsmith version': STANDARD_READ_EXIT_CODES,
  'skillsmith completion': exitCodes([0, 'completion script emitted'], [2, 'unsupported shell']),
  'skillsmith help': exitCodes(
    [0, 'help page emitted'],
    [1, 'known topic content is unavailable'],
    [2, 'unknown command or topic'],
  ),
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
    .map((row) => {
      const name = row.key.slice(`argument:${path}:`.length);
      const description = ARGUMENT_DESCRIPTIONS[`${path}:${name}`];
      if (description === undefined)
        throw new Error(`missing current argument description for ${path} ${name}`);
      return {
        name,
        required: row.argument.required,
        variadic: row.argument.variadic,
        choices: row.argument.choices,
        defaultValue: row.argument.defaultValue === 'null' ? undefined : row.argument.defaultValue,
        description,
      };
    });

export const CURRENT_COMMAND_SPECS: readonly CommandSpec[] = commandPaths.map((path) => {
  const profile = PROFILE[path];
  if (profile === undefined) throw new Error(`missing current CommandSpec profile for ${path}`);
  const description = DESCRIPTION[path];
  const examples = EXAMPLES[path];
  const commandExitCodes = EXIT_CODES[path];
  if (description === undefined) throw new Error(`missing current command description for ${path}`);
  if (examples === undefined) throw new Error(`missing current command examples for ${path}`);
  if (commandExitCodes === undefined)
    throw new Error(`missing current command exit-code help for ${path}`);
  return Object.freeze({
    // The current registry is intentionally flat. A fully-qualified name keeps
    // generic spec walkers from inventing root-level paths for nested commands.
    name: path,
    path,
    aliases: aliasesForPath(path),
    group: profile.group,
    primaryQuestion: profile.question,
    description,
    arguments: argumentsForPath(path),
    options: optionsForPath(path),
    examples,
    exitCodes: commandExitCodes,
    capability: profile.capability,
    application: profile.application,
  });
});

const conflicts = (command: string, left: string, right: string): OptionRelationSpec => ({
  id: `${command}.${left}.${right}`.replaceAll(' ', '.').replaceAll('--', ''),
  command,
  kind: 'conflicts',
  options: [left, right],
  description: `${left} cannot be combined with ${right}`,
});

const exclusive = (command: string, options: readonly string[]): OptionRelationSpec => ({
  id: `${command}.exclusive.${options.join('.')}`.replaceAll(' ', '.').replaceAll('--', ''),
  command,
  kind: 'exclusive-group',
  options,
  description: `options are mutually exclusive: ${options.join(', ')}`,
});

const scopeRelations = (
  command: string,
  values: readonly string[],
): readonly OptionRelationSpec[] => [
  {
    id: `${command}.scope-consistency`.replaceAll(' ', '.'),
    command,
    kind: 'scope-consistency',
    scopeOption: '--scope',
    sugars: values.map((value) => ({ option: `--${value}`, value })),
    description: '--scope must agree with the selected scope shorthand',
  },
];

const RELATION_COMMANDS = [
  'skillsmith',
  'skillsmith list',
  'skillsmith commands',
  'skillsmith doctor',
  'skillsmith check',
  'skillsmith verify',
  'skillsmith install',
  'skillsmith uninstall',
  'skillsmith dev',
  'skillsmith promote',
] as const;

export const CURRENT_OPTION_RELATIONS: readonly OptionRelationSpec[] = [
  conflicts('skillsmith', '--quiet', '--verbose'),
  conflicts('skillsmith', '--quiet', '--debug'),
  conflicts('skillsmith', '--color', '--no-color'),
  exclusive('skillsmith list', ['--enabled', '--disabled', '--unconfigured']),
  ...scopeRelations('skillsmith list', ['user', 'project', 'system', 'managed']),
  exclusive('skillsmith commands', ['--enabled', '--disabled', '--unconfigured']),
  ...scopeRelations('skillsmith commands', ['user', 'project']),
  conflicts('skillsmith doctor', '--all-tools', '--tool'),
  ...scopeRelations('skillsmith doctor', ['user', 'project', 'system']),
  {
    id: 'skillsmith.doctor.lockfile.requires.file',
    command: 'skillsmith doctor',
    kind: 'requires',
    option: '--lockfile',
    requiredOption: '--file',
    description: '--lockfile requires --file',
  },
  conflicts('skillsmith check', '--all-tools', '--tool'),
  conflicts('skillsmith check', '--report-only', '--exit-code'),
  ...scopeRelations('skillsmith check', ['user', 'project', 'system']),
  {
    id: 'skillsmith.check.lockfile.requires.file',
    command: 'skillsmith check',
    kind: 'requires',
    option: '--lockfile',
    requiredOption: '--file',
    description: '--lockfile requires --file',
  },
  conflicts('skillsmith verify', '--static', '--deep'),
  conflicts('skillsmith install', '--deep', '--no-verify'),
  conflicts('skillsmith install', '--yes', '--dry-run'),
  ...scopeRelations('skillsmith install', ['user', 'project']),
  {
    id: 'skillsmith.install.ref.exactly-one-source',
    command: 'skillsmith install',
    kind: 'cardinality',
    subject: 'positionals',
    whenOption: '--ref',
    exact: 1,
    label: '--ref requires exactly one source target',
    description: '--ref requires exactly one source target',
  },
  ...scopeRelations('skillsmith uninstall', ['user', 'project']),
  conflicts('skillsmith uninstall', '--all-scopes', '--scope'),
  conflicts('skillsmith uninstall', '--all-scopes', '--user'),
  conflicts('skillsmith uninstall', '--all-scopes', '--project'),
  conflicts('skillsmith uninstall', '--yes', '--dry-run'),
  conflicts('skillsmith dev', '--all', '--source'),
  conflicts('skillsmith dev', '--yes', '--dry-run'),
  conflicts('skillsmith dev', '--rollback', '--source'),
  conflicts('skillsmith dev', '--rollback', '--dest'),
  conflicts('skillsmith dev', '--rollback', '--strict'),
  conflicts('skillsmith dev', '--rollback', '--no-verify'),
  {
    id: 'skillsmith.dev.all.no-targets',
    command: 'skillsmith dev',
    kind: 'cardinality',
    subject: 'positionals',
    whenOption: '--all',
    maximum: 0,
    label: '--all cannot be combined with positional targets',
    description: '--all cannot be combined with positional targets',
  },
  {
    id: 'skillsmith.dev.source.one-target',
    command: 'skillsmith dev',
    kind: 'cardinality',
    subject: 'positionals',
    whenOption: '--source',
    exact: 1,
    label: '--source requires exactly one target',
    description: '--source requires exactly one target',
  },
  {
    id: 'skillsmith.dev.dest.one-tool',
    command: 'skillsmith dev',
    kind: 'cardinality',
    subject: 'option-occurrences',
    whenOption: '--dest',
    option: '--tool',
    exact: 1,
    label: '--dest requires exactly one --tool',
    description: '--dest requires exactly one --tool',
  },
  conflicts('skillsmith promote', '--yes', '--dry-run'),
  conflicts('skillsmith promote', '--rollback', '--strict'),
  conflicts('skillsmith promote', '--rollback', '--no-verify'),
  conflicts('skillsmith promote', '--rollback', '--allow-dirty'),
  {
    id: 'skillsmith.promote.all.no-targets',
    command: 'skillsmith promote',
    kind: 'cardinality',
    subject: 'positionals',
    whenOption: '--all',
    maximum: 0,
    label: '--all cannot be combined with positional targets',
    description: '--all cannot be combined with positional targets',
  },
];

export const validateCurrentCommandSpecs = (): readonly string[] => {
  const errors: string[] = [];
  if (new Set(commandPaths).size !== commandPaths.length)
    errors.push('current command paths duplicate');
  if (CURRENT_COMMAND_SPECS.length !== commandPaths.length)
    errors.push('current command registry does not close the current command paths');
  for (const spec of CURRENT_COMMAND_SPECS) {
    if (spec.primaryQuestion.length === 0) errors.push(`${spec.path} has no primary question`);
    if (spec.application.length === 0) errors.push(`${spec.path} has no application reference`);
    if (spec.description.length === 0) errors.push(`${spec.path} has no description`);
    if (spec.examples.length === 0) errors.push(`${spec.path} has no examples`);
    if (spec.exitCodes === undefined || spec.exitCodes.length === 0)
      errors.push(`${spec.path} has no exit-code help`);
    for (const argument of spec.arguments) {
      if (argument.description === undefined || argument.description.length === 0)
        errors.push(`${spec.path} argument ${argument.name} has no description`);
    }
    for (const option of spec.options) {
      if (option.description === undefined || option.description.length === 0)
        errors.push(`${spec.path} option ${option.long} has no description`);
    }
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
  for (const command of RELATION_COMMANDS) {
    if (!CURRENT_OPTION_RELATIONS.some((relation) => relation.command === command))
      errors.push(`missing current option relations for ${command}`);
  }

  for (const spec of CURRENT_COMMAND_SPECS) {
    const scope = spec.options.find((option) => option.long === '--scope');
    if (scope === undefined) continue;
    const sugars = spec.options.filter(
      (option) =>
        option.valueShape === 'boolean' && scope.allowedValues.includes(option.long.slice(2)),
    );
    if (
      sugars.length > 0 &&
      !CURRENT_OPTION_RELATIONS.some(
        (relation) => relation.command === spec.path && relation.kind === 'scope-consistency',
      )
    )
      errors.push(`${spec.path} has scope shorthands without a scope-consistency relation`);
  }

  const rootOptions =
    CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith')?.options ?? [];
  for (const relation of CURRENT_OPTION_RELATIONS) {
    const spec = CURRENT_COMMAND_SPECS.find((candidate) => candidate.path === relation.command);
    if (spec === undefined) {
      errors.push(`${relation.id} references unknown command ${relation.command}`);
      continue;
    }
    const options = new Map(
      (relation.command === 'skillsmith' ? rootOptions : [...rootOptions, ...spec.options]).map(
        (option) => [option.long, option],
      ),
    );
    const validateOperand = (operand: string, role: string): void => {
      if (!options.has(operand)) errors.push(`${relation.id} has unknown ${role} ${operand}`);
    };

    if (relation.kind === 'conflicts') {
      if (relation.options.length !== 2 || new Set(relation.options).size !== 2)
        errors.push(`${relation.id} must name exactly two distinct options`);
      for (const operand of relation.options) validateOperand(operand, 'option');
      continue;
    }
    if (relation.kind === 'exclusive-group') {
      if (relation.options.length < 2 || new Set(relation.options).size !== relation.options.length)
        errors.push(`${relation.id} must name at least two distinct options`);
      for (const operand of relation.options) validateOperand(operand, 'option');
      continue;
    }
    if (relation.kind === 'requires') {
      validateOperand(relation.option, 'option');
      validateOperand(relation.requiredOption, 'required option');
      if (relation.option === relation.requiredOption)
        errors.push(`${relation.id} cannot require an option to require itself`);
      continue;
    }
    if (relation.kind === 'scope-consistency') {
      validateOperand(relation.scopeOption, 'scope option');
      const scope = options.get(relation.scopeOption);
      if (scope?.valueShape === 'boolean')
        errors.push(`${relation.id} scope option must accept a value`);
      if (relation.sugars.length === 0)
        errors.push(`${relation.id} must name at least one scope shorthand`);
      if (
        new Set(relation.sugars.map(({ option }) => option)).size !== relation.sugars.length ||
        new Set(relation.sugars.map(({ value }) => value)).size !== relation.sugars.length
      )
        errors.push(`${relation.id} scope shorthand options and values must be unique`);
      for (const sugar of relation.sugars) {
        validateOperand(sugar.option, 'scope shorthand');
        if (options.get(sugar.option)?.valueShape !== 'boolean')
          errors.push(`${relation.id} scope shorthand ${sugar.option} must be boolean`);
        if (!scope?.allowedValues.includes(sugar.value))
          errors.push(`${relation.id} has unsupported scope shorthand value ${sugar.value}`);
      }
      const expectedSugars = spec.options
        .filter(
          (option) =>
            option.valueShape === 'boolean' &&
            (scope?.allowedValues ?? []).includes(option.long.slice(2)),
        )
        .map((option) => option.long)
        .sort();
      const declaredSugars = relation.sugars.map(({ option }) => option).sort();
      if (JSON.stringify(declaredSugars) !== JSON.stringify(expectedSugars))
        errors.push(`${relation.id} does not close the command's scope shorthands`);
      continue;
    }

    validateOperand(relation.whenOption, 'trigger option');
    const bounds = [relation.exact, relation.maximum].filter(
      (bound): bound is number => bound !== undefined,
    );
    if (bounds.length !== 1 || bounds.some((bound) => !Number.isInteger(bound) || bound < 0))
      errors.push(`${relation.id} must have one non-negative integer cardinality bound`);
    if (relation.subject === 'positionals') {
      if (relation.option !== undefined)
        errors.push(`${relation.id} positional cardinality cannot name an option`);
      if (spec.arguments.length === 0)
        errors.push(`${relation.id} applies positional cardinality to a command without arguments`);
    } else if (relation.option === undefined) {
      errors.push(`${relation.id} option-occurrences cardinality must name an option`);
    } else {
      validateOperand(relation.option, 'counted option');
    }
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
      description: spec.description,
      arguments: spec.arguments ?? [],
      options: spec.options ?? [],
      examples: spec.examples ?? [],
      exitCodes: spec.exitCodes ?? [],
    };
  });
