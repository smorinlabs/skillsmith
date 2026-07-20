import { SUPPORTED_TOOLS } from '@skillsmith/core';
import currentState from '../contracts/commander-current-state-v0.json' with { type: 'json' };
import type { CommandOptionSpec } from './types.ts';

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
    description,
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
  return options.sort((left, right) => left.flags.localeCompare(right.flags));
};
