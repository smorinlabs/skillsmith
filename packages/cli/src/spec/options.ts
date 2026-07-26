import { SUPPORTED_TOOLS } from '@skillsmith/core';
import currentState from '../contracts/commander-current-state-v0.json' with { type: 'json' };
import type {
  CommandOptionSpec,
  CompletionProviderKind,
  OptionHelpFamily,
  OptionHelpLevel,
} from './types.ts';

const KNOWN_SCOPES = ['system', 'user', 'project', 'managed'] as const;
const KNOWN_COLORS = ['auto', 'always', 'never'] as const;

const ALLOWED_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'skillsmith list': KNOWN_SCOPES,
  'skillsmith commands': ['user', 'project'],
  'skillsmith status': KNOWN_SCOPES,
  'skillsmith doctor': ['user', 'project', 'system'],
  'skillsmith check': ['user', 'project', 'system'],
  'skillsmith config get': ['user', 'project', 'system'],
  'skillsmith config set': ['user', 'project', 'system'],
  'skillsmith config list': ['user', 'project', 'system'],
  'skillsmith config unset': ['user', 'project', 'system'],
  'skillsmith install': ['user', 'project'],
  'skillsmith export': KNOWN_SCOPES,
  'skillsmith init': ['user', 'project'],
  'skillsmith plan': ['user', 'project'],
  'skillsmith apply': ['user', 'project'],
  'skillsmith undo': ['user', 'project'],
  'skillsmith uninstall': ['user', 'project'],
  'skillsmith dev': ['user', 'project'],
  'skillsmith promote': ['user', 'project'],
};

const DEFAULT_OPTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '--help': 'Show help for this command',
  '--tool': 'Restrict to a target tool; repeat to select more than one',
  '--scope': 'Restrict to a supported installation scope',
  '--user': 'Shorthand for --scope=user',
  '--project': 'Shorthand for --scope=project',
  '--system': 'Shorthand for --scope=system',
  '--managed': 'Shorthand for --scope=managed',
  '--json': 'Emit a versioned JSON report on stdout',
  '--strict': 'Treat warnings as failures',
  '--dry-run': 'Show the plan without changing anything',
  '--yes': 'Accept confirmations without prompting',
  '--all': 'Select every eligible placement',
  '--no-verify': 'Skip the verification gate',
  '--rollback': 'Restore the prior placement state',
};

const OPTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'skillsmith:--version': 'Print version',
  'skillsmith:--verbose': 'Verbose output; repeatable',
  'skillsmith:--quiet': 'Suppress non-error output',
  'skillsmith:--color': 'Colorize output: auto, always, or never',
  'skillsmith:--no-color': 'Disable color output',
  'skillsmith:--cd': 'Change directory before running',
  'skillsmith:--config': 'Use an explicit configuration file',
  'skillsmith:--no-prompt': 'Disable interactive prompts',
  'skillsmith:--debug': 'Print debug traces',
  'skillsmith agents:--tool': 'Narrow the scan to a tool; repeatable',
  'skillsmith agents:--detected-only': 'Omit the "Not detected" section',
  'skillsmith agents:--capabilities': 'Append the selected tools capability matrix',
  'skillsmith agents:--format': 'Output format: markdown or json',
  'skillsmith agents:--json': 'Emit the versioned agents JSON report',
  'skillsmith list:--tool': 'Narrow to a tool; repeatable',
  'skillsmith list:--scope': 'Narrow to an installation scope',
  'skillsmith list:--duplicates': 'Show only cross-scope duplicates',
  'skillsmith list:--mode': 'Narrow to dev, pinned, or unmanaged placements',
  'skillsmith list:--source': 'Match the recorded source with a glob',
  'skillsmith list:--revision': 'Match the recorded revision with a glob',
  'skillsmith list:--description': 'Match the skill description with a glob',
  'skillsmith list:--verified': 'Show only entries whose verification passed',
  'skillsmith list:--unverified': 'Show entries not recorded as verification-passed',
  'skillsmith list:--long': 'Show paths and details',
  'skillsmith list:--enabled': 'Show only enabled entries',
  'skillsmith list:--disabled': 'Show only disabled entries',
  'skillsmith list:--unconfigured': 'Show only entries that have never been toggled',
  'skillsmith commands:--tool': 'Narrow to a tool; repeatable',
  'skillsmith commands:--scope': 'Narrow to user or project scope',
  'skillsmith commands:--long': 'Show paths and details',
  'skillsmith commands:--enabled': 'Show only enabled entries',
  'skillsmith commands:--disabled': 'Show only disabled entries',
  'skillsmith commands:--unconfigured': 'Show only entries that have never been toggled',
  'skillsmith config get:--scope': 'Read from user, project, or system scope',
  'skillsmith config set:--scope': 'Write to user, project, or system scope',
  'skillsmith config list:--scope': 'List only user, project, or system scope',
  'skillsmith config unset:--scope': 'Remove from user, project, or system scope',
  'skillsmith doctor:--tool': 'Limit checks to tools; repeatable',
  'skillsmith doctor:--scope': 'Limit checks to a scope',
  'skillsmith doctor:--file': 'Use an explicit desired-state file',
  'skillsmith doctor:--fix': 'Repair the closed set of safely repairable artifact findings',
  'skillsmith doctor:--dry-run': 'Preview automatic repairs without changing artifacts',
  'skillsmith doctor:--yes': 'Approve the complete automatic repair plan without prompting',
  'skillsmith doctor:--lockfile': 'Use an explicit lockfile (requires --file)',
  'skillsmith doctor:--all-tools': 'Diagnose every known tool instead of the configured default',
  'skillsmith doctor:--offline': 'Skip network checks',
  'skillsmith check:--tool': 'Limit checks to tools; repeatable',
  'skillsmith check:--scope': 'Limit checks to a scope',
  'skillsmith check:--file': 'Use an explicit desired-state file',
  'skillsmith check:--lockfile': 'Use an explicit lockfile (requires --file)',
  'skillsmith check:--all-tools': 'Check every known tool instead of the configured default',
  'skillsmith check:--report-only': 'Report errors without failing the process',
  'skillsmith check:--exit-code': 'Deprecated; check already exits non-zero on error findings',
  'skillsmith status:--tool': 'Restrict status to a target tool; repeatable',
  'skillsmith status:--scope': 'Restrict status to one installation scope',
  'skillsmith status:--file': 'Read desired state from an explicit manifest',
  'skillsmith status:--lockfile': 'Read an explicit lockfile (requires --file)',
  'skillsmith status:--check': 'Exit 7 when the selected status product contains drift',
  'skillsmith export:--file': 'Write one explicit portable manifest',
  'skillsmith export:--lockfile': 'Write one explicit lockfile (requires --file)',
  'skillsmith export:--tool': 'Read one tool inventory; repeatable',
  'skillsmith export:--scope':
    'Read one scope; default: project in project context, otherwise user',
  'skillsmith export:--user': 'Read user placements and select the user pair',
  'skillsmith export:--project': 'Read current-project placements and select the project pair',
  'skillsmith export:--system': 'Read system placements as nonportable observations',
  'skillsmith export:--managed': 'Read policy-managed placements as nonportable observations',
  'skillsmith export:--strict': 'Fail without writes when any selected observation is nonportable',
  'skillsmith export:--force': 'Resolve only bounded selected declaration conflicts',
  'skillsmith export:--dry-run': 'Preview artifact effects without locking or writing',
  'skillsmith export:--json': 'Emit the strict export@1 report',
  'skillsmith gc:--dry-run': 'Preview the exact GC plan without locks or writes',
  'skillsmith gc:--older-than': 'Select only objects strictly older than this duration',
  'skillsmith gc:--forget-project':
    'Forget one exact missing registered project before reachability analysis; repeatable',
  'skillsmith gc:--yes': 'Approve the exact changing GC plan without prompting',
  'skillsmith gc:--json': 'Emit the strict gc@1 report',
  'skillsmith init:--file': 'Initialize one explicit desired-state manifest',
  'skillsmith init:--tool': 'Persist a writable tool default; repeatable',
  'skillsmith init:--scope': 'Persist user or project scope and select its default destination',
  'skillsmith init:--user': 'Initialize the user manifest and persist user scope',
  'skillsmith init:--project': 'Initialize the current project manifest and persist project scope',
  'skillsmith init:--force': 'Back up and replace only the selected existing manifest',
  'skillsmith init:--dry-run': 'Preview the exact manifest operation without writing',
  'skillsmith init:--json': 'Emit the strict init@1 report',
  'skillsmith plan:--file': 'Read one explicit desired-state manifest',
  'skillsmith plan:--lockfile': 'Read one explicit lockfile (requires --file)',
  'skillsmith plan:--tool': 'Restrict planning to a target tool; repeatable',
  'skillsmith plan:--scope': 'Restrict planning to user or project scope',
  'skillsmith plan:--user': 'Plan user-scope convergence',
  'skillsmith plan:--project': 'Plan current-project convergence',
  'skillsmith plan:--locked': 'Require every selected lock entry to be current',
  'skillsmith plan:--prune': 'Include bounded managed removals inside the selected authority',
  'skillsmith plan:--check': 'Exit 7 when the valid preview contains drift',
  'skillsmith plan:--out': 'Create one canonical saved-plan v1 artifact',
  'skillsmith plan:--force': 'Atomically replace only the selected saved-plan output',
  'skillsmith plan:--json': 'Emit the strict plan-report@1 report',
  'skillsmith apply:--file': 'Read one explicit desired-state manifest in fresh mode',
  'skillsmith apply:--lockfile': 'Read one explicit lockfile in fresh mode (requires --file)',
  'skillsmith apply:--plan': 'Validate or execute one exact reviewed saved-plan v1 artifact',
  'skillsmith apply:--tool': 'Restrict fresh convergence to a target tool; repeatable',
  'skillsmith apply:--scope': 'Restrict fresh convergence to user or project scope',
  'skillsmith apply:--user': 'Converge user-scope desired state in fresh mode',
  'skillsmith apply:--project': 'Converge current-project desired state in fresh mode',
  'skillsmith apply:--locked': 'Require every selected lock entry to be current in fresh mode',
  'skillsmith apply:--prune': 'Authorize bounded managed removals in fresh mode',
  'skillsmith apply:--yes': 'Approve a changing fresh plan without prompting',
  'skillsmith apply:--continue-on-error':
    'Continue with later independent fresh-plan groups after a failure',
  'skillsmith apply:--dry-run': 'Validate and render the exact plan without locking or writing',
  'skillsmith apply:--check': 'Exit 7 when the valid exact plan contains changes',
  'skillsmith apply:--json': 'Emit the strict apply-report@1 report',
  'skillsmith sync:--from': 'Read the exact source scope or project path',
  'skillsmith sync:--to': 'Write the exact destination user scope or project path',
  'skillsmith sync:--tool': 'Restrict sync to a target tool; repeatable',
  'skillsmith sync:--force': 'Back up and replace only selected destination conflicts',
  'skillsmith sync:--delete': 'Remove exact selected destination-only placements',
  'skillsmith sync:--save': 'Update the selected destination manifest and lockfile pair',
  'skillsmith sync:--file': 'Select one destination manifest (requires --save)',
  'skillsmith sync:--lockfile': 'Select one destination lockfile (requires --file and --save)',
  'skillsmith sync:--dry-run': 'Render the exact non-mutating sync plan',
  'skillsmith sync:--yes': 'Approve a guarded sync plan without prompting',
  'skillsmith sync:--continue-on-error':
    'Continue with later independent destination groups after a failure',
  'skillsmith sync:--json': 'Emit the strict sync@1 report',
  'skillsmith update:--all': 'Select every eligible declaration in the chosen manifest',
  'skillsmith update:--file': 'Select one explicit portable manifest',
  'skillsmith update:--lockfile': 'Select one explicit lockfile (requires --file)',
  'skillsmith update:--tool': 'Restrict each selected declaration to a tool; repeatable',
  'skillsmith update:--check': 'Exit 7 when a successfully evaluated update is available',
  'skillsmith update:--dry-run': 'Render the exact update plan without durable writes',
  'skillsmith update:--ref': 'Track one exact branch, tag, or full SHA',
  'skillsmith update:--pin': 'Freeze the selected moving ref to its resolved full SHA',
  'skillsmith update:--strict': 'Treat verification warnings or inconclusive results as blocking',
  'skillsmith update:--yes': 'Approve an exact multi-declaration update plan',
  'skillsmith update:--continue-on-error':
    'Continue with later independent declarations after a failure',
  'skillsmith update:--json': 'Emit the strict update@1 report',
  'skillsmith undo:--all': 'Select every eligible retained operation in the chosen scope',
  'skillsmith undo:--tool': 'Restrict selection to a target tool; repeatable',
  'skillsmith undo:--scope': 'Restrict selection to user or current-project scope',
  'skillsmith undo:--user': 'Select user-scope retained operations',
  'skillsmith undo:--project': 'Select current-project retained operations',
  'skillsmith undo:--dry-run': 'Render the exact undo plan without locking or writing',
  'skillsmith undo:--yes': 'Approve the exact changing undo plan without prompting',
  'skillsmith undo:--continue-on-error':
    'Continue with later independent undo groups after a failure',
  'skillsmith undo:--json': 'Emit the strict undo@1 report',
  'skillsmith verify:--tool': 'Restrict to tools; repeatable; default: all detected',
  'skillsmith verify:--static': 'Run static verification only; this is the default',
  'skillsmith verify:--deep': 'Also run isolated session-backed load verification',
  'skillsmith verify:--strict': 'Treat warnings as failures (exit 1 on any warning)',
  'skillsmith install:--tool': 'Target tool; repeatable; default: all detected',
  'skillsmith install:--scope': 'user or project; default: project in a git repo, otherwise user',
  'skillsmith install:--user': 'Shorthand for --scope=user',
  'skillsmith install:--project': 'Shorthand for --scope=project',
  'skillsmith install:--ref': 'Tag, branch, or full SHA; valid with a single source only',
  'skillsmith install:--pin': 'Freeze the resolved commit SHA in the ledger',
  'skillsmith install:--direct': 'Copy files instead of symlinking from the store',
  'skillsmith install:--force': 'Reinstall, replace, or override cross-scope shadowing',
  'skillsmith install:--strict': 'Make verify warnings block installation',
  'skillsmith install:--no-verify': 'Skip the verify gate and record that decision in the ledger',
  'skillsmith install:--deep': 'Run static and deep verification before placement',
  'skillsmith install:--continue-on-error': 'Keep going after per-source failures',
  'skillsmith install:--dry-run': 'Print the resolved plan without changing anything',
  'skillsmith install:--file': 'Use an explicit desired-state manifest',
  'skillsmith install:--lockfile': 'Use an explicit lockfile (requires --file)',
  'skillsmith install:--no-save':
    'Change live placement without inspecting or changing portable desired state',
  'skillsmith install:--path':
    'Use a custom placement directory for one source and one effective tool',
  'skillsmith install:--yes':
    'Approve a multi-group or backup-and-replace install plan without prompting',
  'skillsmith uninstall:--tool': 'Restrict removal to tools; repeatable',
  'skillsmith uninstall:--scope': 'Restrict removal to user or project scope',
  'skillsmith uninstall:--all-scopes': 'Remove from user scope and the current project',
  'skillsmith uninstall:--continue-on-error':
    'Continue with later independent declaration groups after a failure',
  'skillsmith uninstall:--force': 'Remove dev-mode or unmanaged placements too',
  'skillsmith uninstall:--dry-run': 'Print removals without executing them',
  'skillsmith uninstall:--file': 'Use an explicit desired-state manifest',
  'skillsmith uninstall:--lockfile': 'Use an explicit lockfile (requires --file)',
  'skillsmith uninstall:--no-save':
    'Change live placement without inspecting or changing portable desired state',
  'skillsmith uninstall:--yes':
    'Approve a multi-group or backup-and-replace uninstall plan without prompting',
  'skillsmith dev:--all': 'Demote every pinned placement with a recorded dev source',
  'skillsmith dev:--tool': 'Restrict to tools; repeatable',
  'skillsmith dev:--scope': 'Restrict selection to user or current-project placements',
  'skillsmith dev:--source': 'Create or adopt a placement from this development source',
  'skillsmith dev:--dest': 'Destination root for a created placement; requires one --tool',
  'skillsmith dev:--strict': 'Treat verify warnings as blocking on create or adopt',
  'skillsmith dev:--no-verify': 'Skip the static verify gate on create or adopt',
  'skillsmith dev:--continue-on-error': 'Continue with later independent groups after a failure',
  'skillsmith dev:--rollback': 'Undo the last dev flip or recover an interrupted one',
  'skillsmith dev:--yes': 'Approve one planned bulk demotion without prompting',
  'skillsmith promote:--all': 'Promote every dev-mode placement in the selected tools',
  'skillsmith promote:--tool': 'Restrict to tools; repeatable',
  'skillsmith promote:--scope': 'Restrict selection to user or current-project placements',
  'skillsmith promote:--strict': 'Make verify-gate warnings block promotion',
  'skillsmith promote:--no-verify': 'Skip the verify gate and record the result as unverified',
  'skillsmith promote:--allow-dirty': 'Allow snapshotting a dirty git tree',
  'skillsmith promote:--continue-on-error':
    'Continue with later independent groups after a failure',
  'skillsmith promote:--rollback': 'Undo the last promotion or recover an interrupted one',
  'skillsmith promote:--yes': 'Approve one planned bulk promotion without prompting',
};

type StateOption = {
  readonly flags: string;
  readonly short: string | null;
  readonly long: string | null;
  readonly attributeName: string;
  readonly valueShape: 'boolean' | 'required' | 'optional';
  readonly choices: readonly string[];
  readonly defaultValue: string;
  readonly repeatable: boolean;
  readonly negated: boolean;
};

const decodeDefault = (value: string): unknown => {
  if (value === 'null' || value === 'unset') return undefined;
  if (value === 'resolved-by-command-contract') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const OPTION_HELP_FAMILIES: Readonly<
  Record<Exclude<OptionHelpFamily, 'inherited-globals'>, ReadonlySet<string>>
> = {
  'targets-scope': new Set([
    '--all',
    '--all-scopes',
    '--all-tools',
    '--detected-only',
    '--managed',
    '--project',
    '--scope',
    '--system',
    '--tool',
    '--user',
  ]),
  'source-destination-artifacts': new Set([
    '--dest',
    '--file',
    '--forget-project',
    '--from',
    '--lockfile',
    '--older-than',
    '--out',
    '--path',
    '--pin',
    '--plan',
    '--ref',
    '--source',
    '--to',
  ]),
  'behavior-verification': new Set([
    '--allow-dirty',
    '--capabilities',
    '--check',
    '--deep',
    '--delete',
    '--description',
    '--direct',
    '--disabled',
    '--duplicates',
    '--enabled',
    '--fix',
    '--locked',
    '--mode',
    '--no-save',
    '--no-verify',
    '--offline',
    '--prune',
    '--report-only',
    '--revision',
    '--rollback',
    '--save',
    '--static',
    '--strict',
    '--unconfigured',
    '--unverified',
    '--verified',
  ]),
  'safety-approval': new Set(['--force', '--yes']),
  'automation-output': new Set([
    '--continue-on-error',
    '--dry-run',
    '--exit-code',
    '--format',
    '--help',
    '--json',
    '--long',
  ]),
};

const ADVANCED_OPTIONS = new Set([
  '--all-scopes',
  '--all-tools',
  '--allow-dirty',
  '--continue-on-error',
  '--debug',
  '--delete',
  '--description',
  '--direct',
  '--duplicates',
  '--exit-code',
  '--fix',
  '--force',
  '--forget-project',
  '--locked',
  '--lockfile',
  '--mode',
  '--no-save',
  '--no-verify',
  '--offline',
  '--older-than',
  '--out',
  '--path',
  '--pin',
  '--plan',
  '--prune',
  '--report-only',
  '--revision',
  '--rollback',
  '--save',
  '--static',
  '--unconfigured',
]);

const optionHelpMetadata = (
  path: string,
  long: string,
): { readonly helpFamily: OptionHelpFamily; readonly helpLevel: OptionHelpLevel } => {
  if (path === 'skillsmith') {
    return {
      helpFamily: 'inherited-globals',
      helpLevel: ADVANCED_OPTIONS.has(long) ? 'advanced' : 'common',
    };
  }
  const families = Object.entries(OPTION_HELP_FAMILIES).filter(([, options]) => options.has(long));
  if (families.length !== 1) {
    throw new Error(`option ${path} ${long} must belong to exactly one help family`);
  }
  return {
    helpFamily: families[0]?.[0] as OptionHelpFamily,
    helpLevel: ADVANCED_OPTIONS.has(long) ? 'advanced' : 'common',
  };
};

const optionFromState = (path: string, option: StateOption): CommandOptionSpec => {
  const long = option.long ?? option.flags;
  const description = OPTION_DESCRIPTIONS[`${path}:${long}`] ?? DEFAULT_OPTION_DESCRIPTIONS[long];
  if (description === undefined)
    throw new Error(`missing current option description for ${path} ${long}`);
  const isTool = long === '--tool';
  const isScope = long === '--scope';
  const isColor = long === '--color';
  const parsed =
    option.negated && long === '--no-color'
      ? 'auto'
      : option.negated
        ? true
        : decodeDefault(option.defaultValue);
  const help = optionHelpMetadata(path, long);
  const completionProvider: CompletionProviderKind | undefined =
    long === '--file'
      ? 'manifest'
      : long === '--config' ||
          long === '--cd' ||
          long === '--lockfile' ||
          long === '--plan' ||
          long === '--out' ||
          long === '--path' ||
          (path === 'skillsmith dev' && (long === '--source' || long === '--dest')) ||
          (path === 'skillsmith sync' && (long === '--from' || long === '--to')) ||
          (path === 'skillsmith gc' && long === '--forget-project')
        ? 'path'
        : undefined;
  return {
    flags: option.flags,
    long,
    short: option.short,
    attributeName: option.attributeName,
    valueShape: option.valueShape,
    knownValues: isTool
      ? SUPPORTED_TOOLS
      : isScope
        ? KNOWN_SCOPES
        : isColor
          ? KNOWN_COLORS
          : option.choices,
    allowedValues: isTool
      ? SUPPORTED_TOOLS
      : isScope
        ? (ALLOWED_SCOPES[path] ?? KNOWN_SCOPES)
        : option.choices,
    parserValues: isTool ? SUPPORTED_TOOLS : option.choices,
    repeatable: option.repeatable,
    negated: option.negated,
    flagDefault: option.negated ? false : parsed,
    parsedDefault: parsed,
    ...help,
    description,
    ...(completionProvider === undefined ? {} : { completionProvider }),
  };
};

const optionRows = currentState.filter(
  (row): row is (typeof currentState)[number] & { option: StateOption } =>
    row.key.startsWith('option:') && 'option' in row && row.option !== undefined,
);

export const optionsForPath = (path: string): readonly CommandOptionSpec[] => {
  const prefix = `option:${path}:`;
  const options = optionRows
    .filter((row) => row.key.startsWith(prefix))
    .filter(
      (row) =>
        !['skillsmith status', 'skillsmith apply'].includes(path) || row.option.long !== '--help',
    )
    .map((row) => optionFromState(path, row.option));

  if (path === 'skillsmith status') {
    const order = [
      '--file',
      '--lockfile',
      '--tool',
      '--scope',
      '--system',
      '--user',
      '--project',
      '--managed',
      '--check',
      '--json',
    ];
    return options.sort((left, right) => order.indexOf(left.long) - order.indexOf(right.long));
  }
  if (path === 'skillsmith export') {
    const order = [
      '--file',
      '--lockfile',
      '--tool',
      '--scope',
      '--user',
      '--project',
      '--system',
      '--managed',
      '--strict',
      '--force',
      '--dry-run',
      '--json',
    ];
    return options.sort((left, right) => order.indexOf(left.long) - order.indexOf(right.long));
  }
  if (path === 'skillsmith init') {
    const order = [
      '--file',
      '--tool',
      '--scope',
      '--user',
      '--project',
      '--force',
      '--dry-run',
      '--json',
      '--help',
    ];
    return options.sort((left, right) => order.indexOf(left.long) - order.indexOf(right.long));
  }
  if (path === 'skillsmith plan') {
    const order = [
      '--file',
      '--lockfile',
      '--tool',
      '--scope',
      '--user',
      '--project',
      '--locked',
      '--prune',
      '--check',
      '--out',
      '--force',
      '--json',
      '--help',
    ];
    return options.sort((left, right) => order.indexOf(left.long) - order.indexOf(right.long));
  }
  if (path === 'skillsmith apply') {
    const order = [
      '--file',
      '--lockfile',
      '--plan',
      '--tool',
      '--scope',
      '--user',
      '--project',
      '--locked',
      '--prune',
      '--yes',
      '--continue-on-error',
      '--dry-run',
      '--check',
      '--json',
    ];
    return options.sort((left, right) => order.indexOf(left.long) - order.indexOf(right.long));
  }
  if (path === 'skillsmith sync') {
    const order = [
      '--from',
      '--to',
      '--tool',
      '--force',
      '--delete',
      '--save',
      '--file',
      '--lockfile',
      '--dry-run',
      '--yes',
      '--continue-on-error',
      '--json',
      '--help',
    ];
    return options.sort((left, right) => order.indexOf(left.long) - order.indexOf(right.long));
  }
  if (path === 'skillsmith update') {
    const order = [
      '--all',
      '--file',
      '--lockfile',
      '--tool',
      '--check',
      '--dry-run',
      '--ref',
      '--pin',
      '--strict',
      '--yes',
      '--continue-on-error',
      '--json',
      '--help',
    ];
    return options.sort((left, right) => order.indexOf(left.long) - order.indexOf(right.long));
  }
  if (path === 'skillsmith undo') {
    const order = [
      '--all',
      '--tool',
      '--scope',
      '--user',
      '--project',
      '--dry-run',
      '--yes',
      '--continue-on-error',
      '--json',
      '--help',
    ];
    return options.sort((left, right) => order.indexOf(left.long) - order.indexOf(right.long));
  }
  return options.sort((left, right) => left.flags.localeCompare(right.flags));
};
