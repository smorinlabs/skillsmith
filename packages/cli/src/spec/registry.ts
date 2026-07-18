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
  'skillsmith status': {
    group: 'discover',
    question: 'How do desired, locked, ledger, and live states relate?',
    capability: 'read',
    application: 'status',
  },
  'skillsmith doctor': {
    group: 'maintain',
    question: 'Is the local SkillSmith environment healthy?',
    capability: 'read',
    application: 'doctor',
  },
  'skillsmith export': {
    group: 'declarative',
    question: 'How do I capture the current fleet as portable desired state?',
    capability: 'export',
    application: 'export',
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
  'skillsmith status': 'Correlate desired, locked, ledger, and live skill state',
  'skillsmith doctor': 'Diagnose SkillSmith and target-tool readiness',
  'skillsmith export': 'Capture portable live skill state in a manifest and lockfile',
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
  'skillsmith status:skill': 'Skill names or exact placement paths',
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
  'skillsmith status': ['skillsmith status', 'skillsmith status review --tool codex --check'],
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
  'skillsmith export': [
    'skillsmith export',
    'skillsmith export --project --file ./skillsmith.toml',
    'skillsmith export --tool claude-code --strict --dry-run',
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
  skillsmith: exitCodes([0, 'top-level help page emitted']),
  'skillsmith agents': exitCodes(
    [0, 'tool detection completed successfully'],
    [1, 'tool detection failed'],
    [2, 'invalid tool or output selection'],
    [130, 'cancelled by SIGINT'],
  ),
  'skillsmith export': exitCodes(
    [0, 'portable export completed or no portable rows remained'],
    [1, 'strict portability or execution failure'],
    [2, 'invalid selection or unresolved declaration conflict'],
    [3, 'artifact or ledger state is invalid or stale'],
    [4, 'required readable tool capability is unavailable'],
    [6, 'artifact or ledger permission denied'],
    [130, 'cancelled by SIGINT'],
  ),
  'skillsmith config': exitCodes([0, 'configuration help page emitted']),
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
    [1, 'unhandled findings or repair failures remain'],
    [2, 'invalid selection, option policy, or repair approval'],
    [3, 'artifact state is invalid, corrupt, newer, or stale'],
    [5, 'source resolution required for repair failed'],
    [6, 'a selected repair path is not writable'],
    [130, 'cancelled by SIGINT'],
  ),
  'skillsmith check': exitCodes(
    [0, 'blocking checks passed, or --report-only was used'],
    [1, 'one or more error findings exist'],
    [2, 'invalid tool, scope, artifact, or exit-policy selection'],
    [3, 'configuration is unreadable'],
    [130, 'cancelled by SIGINT'],
  ),
  'skillsmith status': exitCodes(
    [0, 'selected status completed successfully'],
    [1, 'status observation failed'],
    [2, 'invalid usage or unmatched target'],
    [3, 'manifest, lock, or ledger state is invalid'],
    [4, 'a required read capability is unavailable'],
    [5, 'a signed source dependency failed'],
    [6, 'a selected path could not be read due to permissions'],
    [7, 'the selected status product contains drift'],
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
  'skillsmith version': exitCodes([0, 'version emitted']),
  'skillsmith completion': exitCodes(
    [0, 'completion script emitted'],
    [2, 'required shell is missing or unsupported'],
  ),
  'skillsmith help': exitCodes([0, 'help page emitted'], [2, 'unknown command or topic']),
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
    ...(path === 'skillsmith status' ? { reportKind: 'status' } : {}),
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

const singularOption = (command: string, option: string): OptionRelationSpec => ({
  id: `${command}.${option}.single`.replaceAll(' ', '.').replaceAll('--', ''),
  command,
  kind: 'cardinality',
  subject: 'option-occurrences',
  whenOption: option,
  option,
  maximum: 1,
  label: `${option} may only be specified once`,
  description: `${option} may only be specified once`,
});

/**
 * Materialize the required current relation contract.
 *
 * Keeping this as a factory gives self-validation an unmodified contract to
 * compare against when a consumer casts and mutates the exported registry.
 * Invocation still interprets CURRENT_OPTION_RELATIONS directly.
 */
const requiredCurrentOptionRelations = (): readonly OptionRelationSpec[] => [
  conflicts('skillsmith', '--quiet', '--verbose'),
  conflicts('skillsmith', '--quiet', '--debug'),
  conflicts('skillsmith', '--color', '--no-color'),
  exclusive('skillsmith list', ['--enabled', '--disabled', '--unconfigured']),
  exclusive('skillsmith list', ['--verified', '--unverified']),
  ...scopeRelations('skillsmith list', ['user', 'project', 'system', 'managed']),
  exclusive('skillsmith commands', ['--enabled', '--disabled', '--unconfigured']),
  ...scopeRelations('skillsmith commands', ['user', 'project']),
  exclusive('skillsmith status', ['--system', '--user', '--project', '--managed']),
  ...scopeRelations('skillsmith status', ['system', 'user', 'project', 'managed']),
  {
    id: 'skillsmith.status.lockfile.requires.file',
    command: 'skillsmith status',
    kind: 'requires',
    option: '--lockfile',
    requiredOption: '--file',
    description: '--lockfile requires --file',
  },
  {
    id: 'skillsmith.status.scope.single',
    command: 'skillsmith status',
    kind: 'cardinality',
    subject: 'option-occurrences',
    whenOption: '--scope',
    option: '--scope',
    maximum: 1,
    label: '--scope may only be specified once',
    description: '--scope may only be specified once',
  },
  ...scopeRelations('skillsmith config get', ['user', 'project', 'system']),
  ...scopeRelations('skillsmith config set', ['user', 'project', 'system']),
  ...scopeRelations('skillsmith config list', ['user', 'project', 'system']),
  ...scopeRelations('skillsmith config unset', ['user', 'project', 'system']),
  conflicts('skillsmith doctor', '--all-tools', '--tool'),
  conflicts('skillsmith doctor', '--yes', '--dry-run'),
  {
    id: 'skillsmith.doctor.dry-run.requires.fix',
    command: 'skillsmith doctor',
    kind: 'requires',
    option: '--dry-run',
    requiredOption: '--fix',
    description: '--dry-run requires --fix',
  },
  {
    id: 'skillsmith.doctor.yes.requires.fix',
    command: 'skillsmith doctor',
    kind: 'requires',
    option: '--yes',
    requiredOption: '--fix',
    description: '--yes requires --fix',
  },
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
  {
    id: 'skillsmith.export.lockfile.requires.file',
    command: 'skillsmith export',
    kind: 'requires',
    option: '--lockfile',
    requiredOption: '--file',
    description: '--lockfile requires --file',
  },
  ...scopeRelations('skillsmith export', ['user', 'project', 'system', 'managed']),
  singularOption('skillsmith export', '--scope'),
  singularOption('skillsmith export', '--file'),
  singularOption('skillsmith export', '--lockfile'),
  conflicts('skillsmith verify', '--static', '--deep'),
  conflicts('skillsmith install', '--deep', '--no-verify'),
  conflicts('skillsmith install', '--yes', '--dry-run'),
  conflicts('skillsmith install', '--no-save', '--file'),
  conflicts('skillsmith install', '--no-save', '--lockfile'),
  {
    id: 'skillsmith.install.lockfile.requires.file',
    command: 'skillsmith install',
    kind: 'requires',
    option: '--lockfile',
    requiredOption: '--file',
    description: '--lockfile requires --file',
  },
  conflicts('skillsmith install', '--scope', '--user'),
  conflicts('skillsmith install', '--scope', '--project'),
  ...scopeRelations('skillsmith install', ['user', 'project']),
  singularOption('skillsmith install', '--scope'),
  singularOption('skillsmith install', '--file'),
  singularOption('skillsmith install', '--lockfile'),
  singularOption('skillsmith install', '--ref'),
  singularOption('skillsmith install', '--path'),
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
  {
    id: 'skillsmith.install.path.exactly-one-source',
    command: 'skillsmith install',
    kind: 'cardinality',
    subject: 'positionals',
    whenOption: '--path',
    exact: 1,
    label: '--path requires exactly one source target',
    description: '--path requires exactly one source target',
  },
  conflicts('skillsmith uninstall', '--no-save', '--file'),
  conflicts('skillsmith uninstall', '--no-save', '--lockfile'),
  {
    id: 'skillsmith.uninstall.lockfile.requires.file',
    command: 'skillsmith uninstall',
    kind: 'requires',
    option: '--lockfile',
    requiredOption: '--file',
    description: '--lockfile requires --file',
  },
  conflicts('skillsmith uninstall', '--scope', '--user'),
  conflicts('skillsmith uninstall', '--scope', '--project'),
  ...scopeRelations('skillsmith uninstall', ['user', 'project']),
  singularOption('skillsmith uninstall', '--scope'),
  singularOption('skillsmith uninstall', '--file'),
  singularOption('skillsmith uninstall', '--lockfile'),
  conflicts('skillsmith uninstall', '--all-scopes', '--scope'),
  conflicts('skillsmith uninstall', '--all-scopes', '--user'),
  conflicts('skillsmith uninstall', '--all-scopes', '--project'),
  conflicts('skillsmith uninstall', '--yes', '--dry-run'),
  ...scopeRelations('skillsmith dev', ['user', 'project']),
  {
    id: 'skillsmith.dev.scope.single',
    command: 'skillsmith dev',
    kind: 'cardinality',
    subject: 'option-occurrences',
    whenOption: '--scope',
    option: '--scope',
    maximum: 1,
    label: '--scope may only be specified once',
    description: '--scope may only be specified once',
  },
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
  ...scopeRelations('skillsmith promote', ['user', 'project']),
  {
    id: 'skillsmith.promote.scope.single',
    command: 'skillsmith promote',
    kind: 'cardinality',
    subject: 'option-occurrences',
    whenOption: '--scope',
    option: '--scope',
    maximum: 1,
    label: '--scope may only be specified once',
    description: '--scope may only be specified once',
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

export const CURRENT_OPTION_RELATIONS: readonly OptionRelationSpec[] =
  requiredCurrentOptionRelations();

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

const isRelationRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export const validateCurrentOptionRelations = (): readonly string[] => {
  const errors: string[] = [];
  const currentRelations = CURRENT_OPTION_RELATIONS as readonly unknown[];
  const requiredRelations = requiredCurrentOptionRelations();
  const records = currentRelations.filter(isRelationRecord);
  const ids = records
    .map((relation) => relation.id)
    .filter((id): id is string => typeof id === 'string');
  if (new Set(ids).size !== ids.length) errors.push('current option relation IDs duplicate');

  const requiredById = new Map(requiredRelations.map((relation) => [relation.id, relation]));
  const currentById = new Map(
    records
      .filter(
        (relation): relation is Readonly<Record<string, unknown>> & { readonly id: string } =>
          typeof relation.id === 'string',
      )
      .map((relation) => [relation.id, relation]),
  );
  for (const required of requiredRelations) {
    const current = currentById.get(required.id);
    if (current === undefined) {
      errors.push(`missing required current option relation ${required.id}`);
    } else if (JSON.stringify(current) !== JSON.stringify(required)) {
      errors.push(`${required.id} does not match the required current option relation contract`);
    }
  }
  for (const id of currentById.keys()) {
    if (!requiredById.has(id)) errors.push(`unexpected current option relation ${id}`);
  }

  const requiredCommands = new Set(requiredRelations.map((relation) => relation.command));
  for (const command of requiredCommands) {
    if (!records.some((relation) => relation.command === command))
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
      !records.some(
        (relation) => relation.command === spec.path && relation.kind === 'scope-consistency',
      )
    )
      errors.push(`${spec.path} has scope shorthands without a scope-consistency relation`);
  }

  const rootOptions =
    CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith')?.options ?? [];
  for (const [index, value] of currentRelations.entries()) {
    if (!isRelationRecord(value)) {
      errors.push(`current option relation at index ${index} must be an object`);
      continue;
    }
    const relation = value;
    const id =
      typeof relation.id === 'string' && relation.id.length > 0
        ? relation.id
        : `current option relation at index ${index}`;
    if (typeof relation.id !== 'string' || relation.id.length === 0)
      errors.push(`${id} must have a non-empty string ID`);
    if (typeof relation.command !== 'string' || relation.command.length === 0) {
      errors.push(`${id} must name a command`);
      continue;
    }
    if (typeof relation.description !== 'string' || relation.description.length === 0)
      errors.push(`${id} must have a non-empty description`);
    const spec = CURRENT_COMMAND_SPECS.find((candidate) => candidate.path === relation.command);
    if (spec === undefined) {
      errors.push(`${id} references unknown command ${relation.command}`);
      continue;
    }
    const options = new Map(
      (relation.command === 'skillsmith' ? rootOptions : [...rootOptions, ...spec.options]).map(
        (option) => [option.long, option],
      ),
    );
    const validateOperand = (operand: unknown, role: string): void => {
      if (typeof operand !== 'string' || !options.has(operand))
        errors.push(`${id} has unknown ${role} ${String(operand)}`);
    };

    if (relation.kind === 'conflicts') {
      if (
        !isStringArray(relation.options) ||
        relation.options.length !== 2 ||
        new Set(relation.options).size !== 2
      )
        errors.push(`${id} must name exactly two distinct options`);
      if (isStringArray(relation.options))
        for (const operand of relation.options) validateOperand(operand, 'option');
      continue;
    }
    if (relation.kind === 'exclusive-group') {
      if (
        !isStringArray(relation.options) ||
        relation.options.length < 2 ||
        new Set(relation.options).size !== relation.options.length
      )
        errors.push(`${id} must name at least two distinct options`);
      if (isStringArray(relation.options))
        for (const operand of relation.options) validateOperand(operand, 'option');
      continue;
    }
    if (relation.kind === 'requires') {
      validateOperand(relation.option, 'option');
      validateOperand(relation.requiredOption, 'required option');
      if (relation.option === relation.requiredOption)
        errors.push(`${id} cannot require an option to require itself`);
      continue;
    }
    if (relation.kind === 'scope-consistency') {
      validateOperand(relation.scopeOption, 'scope option');
      const scope =
        typeof relation.scopeOption === 'string' ? options.get(relation.scopeOption) : undefined;
      if (scope?.valueShape === 'boolean') errors.push(`${id} scope option must accept a value`);
      const sugars = Array.isArray(relation.sugars) ? relation.sugars : [];
      if (sugars.length === 0) errors.push(`${id} must name at least one scope shorthand`);
      if (
        !sugars.every(isRelationRecord) ||
        new Set(sugars.map((sugar) => sugar.option)).size !== sugars.length ||
        new Set(sugars.map((sugar) => sugar.value)).size !== sugars.length
      )
        errors.push(`${id} scope shorthand options and values must be unique`);
      for (const sugar of sugars) {
        if (!isRelationRecord(sugar)) {
          errors.push(`${id} scope shorthand must be an object`);
          continue;
        }
        validateOperand(sugar.option, 'scope shorthand');
        if (typeof sugar.option !== 'string' || options.get(sugar.option)?.valueShape !== 'boolean')
          errors.push(`${id} scope shorthand ${String(sugar.option)} must be boolean`);
        if (typeof sugar.value !== 'string' || !scope?.allowedValues.includes(sugar.value))
          errors.push(`${id} has unsupported scope shorthand value ${String(sugar.value)}`);
      }
      const expectedSugars = spec.options
        .filter(
          (option) =>
            option.valueShape === 'boolean' &&
            (scope?.allowedValues ?? []).includes(option.long.slice(2)),
        )
        .map((option) => option.long)
        .sort();
      const declaredSugars = sugars
        .filter(isRelationRecord)
        .map((sugar) => sugar.option)
        .filter((option): option is string => typeof option === 'string')
        .sort();
      if (JSON.stringify(declaredSugars) !== JSON.stringify(expectedSugars))
        errors.push(`${id} does not close the command's scope shorthands`);
      continue;
    }

    if (relation.kind !== 'cardinality') {
      errors.push(`${id} has unknown relation kind ${String(relation.kind)}`);
      continue;
    }
    validateOperand(relation.whenOption, 'trigger option');
    const bounds = [relation.exact, relation.maximum].filter(
      (bound): bound is unknown => bound !== undefined,
    );
    if (
      bounds.length !== 1 ||
      bounds.some((bound) => typeof bound !== 'number' || !Number.isInteger(bound) || bound < 0)
    )
      errors.push(`${id} must have one non-negative integer cardinality bound`);
    if (typeof relation.label !== 'string' || relation.label.length === 0)
      errors.push(`${id} must have a non-empty cardinality label`);
    if (relation.subject === 'positionals') {
      if (relation.option !== undefined)
        errors.push(`${id} positional cardinality cannot name an option`);
      if (spec.arguments.length === 0)
        errors.push(`${id} applies positional cardinality to a command without arguments`);
    } else if (relation.subject === 'option-occurrences') {
      if (relation.option === undefined)
        errors.push(`${id} option-occurrences cardinality must name an option`);
      else validateOperand(relation.option, 'counted option');
    } else {
      errors.push(`${id} has unknown cardinality subject ${String(relation.subject)}`);
      if (relation.option !== undefined)
        errors.push(`${id} invalid cardinality subject cannot name an option`);
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
