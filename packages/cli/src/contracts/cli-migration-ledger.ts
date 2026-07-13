import { SUPPORTED_TOOLS } from '@skillsmith/core';
import targetAuthorityJson from './cli-target-registry-v1.0.0.json';
import currentAuthorityJson from './commander-current-ledger-v0.7.0.json';
import currentStateJson from './commander-current-state-v0.json';
import type { CanonicalCommand } from './commander-surface.ts';
import { surfaceKeys } from './commander-surface.ts';

export type MigrationDisposition = 'K' | 'A' | 'C' | 'D' | 'N';
export interface MigrationEntry {
  key: string;
  disposition: MigrationDisposition;
  phase: string;
  validationOwner: string;
  option?: {
    flags?: string;
    short: string | null;
    long: string | null;
    attributeName?: string;
    requiredValue?: boolean;
    optionalValue?: boolean;
    variadic?: boolean;
    valueShape: 'boolean' | 'required' | 'optional';
    choices: readonly string[];
    defaultValue: string;
    defaultSource: 'literal' | 'contextual' | 'none';
    repeatable: boolean;
    negated: boolean;
    hidden?: boolean;
  };
  argument?: {
    required: boolean;
    variadic: boolean;
    choices: readonly string[];
    defaultValue: string;
    defaultSource: 'none';
  };
}
export interface TargetCommandOwnership {
  command: string;
  implementation: string;
  validations: readonly string[];
  workflows: readonly string[];
}
export interface MigrationLedger {
  schemaVersion: 1;
  snapshotVersion: '0.7.0';
  current: readonly MigrationEntry[];
  target: readonly MigrationEntry[];
  targetCommands: readonly TargetCommandOwnership[];
  optionGates: Readonly<Record<string, { target: string; phase: string; requiredNow: boolean }>>;
  currentHelpInventory: Readonly<
    Record<string, { visibleOptions: readonly string[]; hiddenOptions: readonly string[] }>
  >;
  targetHelpOwner: { phase: 'P17-G6-02A'; validation: 'EWP-OPT-TS05' };
}

const commandOwner = (path: string): string => {
  const top = path.replace(/^skillsmith ?/, '').split(' ')[0] ?? '';
  if (top === 'config') return 'EWP-CMD-CONFIG-TS01';
  if (top === 'version') return 'EWP-CMD-HELP-TS07';
  if (top === 'help' || top === '') return 'EWP-CMD-HELP-TS01';
  return `EWP-CMD-${top.toUpperCase()}-TS01`;
};

const commandGroup: Readonly<Record<string, string>> = {
  agents: 'P17-G3A-02',
  config: 'P17-G2-01',
  list: 'P17-G3A-02',
  commands: 'P17-G3A-02',
  status: 'P17-G3A-01',
  doctor: 'P17-G3B-03',
  check: 'P17-G1-02B',
  verify: 'P17-G1-05',
  completion: 'P17-G6-02B',
  version: 'P17-G6-02A',
  help: 'P17-G6-02A',
  install: 'P17-G4A-01',
  uninstall: 'P17-G4A-01',
  dev: 'P17-G3B-01',
  promote: 'P17-G3B-01',
  init: 'P17-G4A-03',
  export: 'P17-G4A-02',
  plan: 'P17-G4B-01',
  apply: 'P17-G4B-02',
  sync: 'P17-G5-01',
  update: 'P17-G5-02',
  undo: 'P17-G5-03',
  gc: 'P17-G5-04',
};

const toolChoices = SUPPORTED_TOOLS;
const scopeChoices: Readonly<Record<string, readonly string[]>> = {
  list: ['user', 'project', 'system', 'managed'],
  commands: ['user', 'project'],
  status: ['user', 'project', 'system', 'managed'],
  doctor: ['user', 'project', 'system'],
  check: ['user', 'project', 'system'],
  install: ['user', 'project'],
  uninstall: ['user', 'project'],
  dev: ['user', 'project'],
  promote: ['user', 'project'],
  init: ['user', 'project'],
  export: ['user', 'project', 'system', 'managed'],
  plan: ['user', 'project'],
  apply: ['user', 'project'],
  undo: ['user', 'project'],
};

const shapeFromFlags = (flags: string, command = '') => {
  const long = /--[\w-]+/.exec(flags)?.[0] ?? null;
  const literal =
    long === '--cd'
      ? '.'
      : long === '--color'
        ? 'auto'
        : long === '--verbose'
          ? '0'
          : ['--format'].includes(long ?? '')
            ? 'markdown'
            : null;
  const contextual = [
    '--tool',
    '--scope',
    '--config',
    '--file',
    '--lockfile',
    '--older-than',
  ].includes(long ?? '');
  const boolean = !flags.includes('<') && !flags.includes('[');
  return {
    short: /(?:^|, )(-[A-Za-z])(?:,| |$)/.exec(flags)?.[1] ?? null,
    long: /--[\w-]+/.exec(flags)?.[0] ?? null,
    valueShape: flags.includes('<')
      ? ('required' as const)
      : flags.includes('[')
        ? ('optional' as const)
        : ('boolean' as const),
    choices:
      long === '--tool'
        ? [...toolChoices]
        : long === '--scope' && scopeChoices[command]
          ? [...scopeChoices[command]]
          : long === '--from' || long === '--to'
            ? []
            : (/\<([^>]*\|[^>]*)\>/.exec(flags)?.[1]?.split('|') ?? []),
    defaultValue:
      literal ?? (boolean ? 'false' : contextual ? 'resolved-by-command-contract' : 'unset'),
    defaultSource:
      literal !== null || boolean
        ? ('literal' as const)
        : contextual
          ? ('contextual' as const)
          : ('none' as const),
    repeatable: /--(?:tool|verbose|forget-project)/.test(flags),
    negated: /--no-/.test(flags),
  };
};

const targetArgumentShape = (command: string, value: string) => ({
  required: value.startsWith('<'),
  variadic: value.includes('...'),
  choices: command === 'completion' && value === '<shell>' ? ['bash', 'fish', 'zsh'] : [],
  defaultValue: 'unset' as const,
  defaultSource: 'none' as const,
});

const targetRows: Readonly<Record<string, readonly string[]>> = {
  agents: [
    '-t, --tool <name>',
    '--detected-only',
    '--format <markdown|json>',
    '--json',
    '--capabilities',
  ],
  'config get': [
    '<key>',
    '--scope <user|project|system>',
    '--user',
    '--project',
    '--system',
    '--json',
  ],
  'config set': [
    '<key>',
    '<value>',
    '--scope <user|project|system>',
    '--user',
    '--project',
    '--system',
    '--json',
  ],
  'config list': ['--scope <user|project|system>', '--user', '--project', '--system', '--json'],
  'config unset': [
    '<key>',
    '--scope <user|project|system>',
    '--user',
    '--project',
    '--system',
    '--json',
  ],
  list: [
    '[glob...]',
    'alias:ls',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--system',
    '--managed',
    '--duplicates',
    '-l, --long',
    '--json',
    '--enabled',
    '--disabled',
    '--unconfigured',
    '--mode <dev|pinned|unmanaged>',
    '--source <glob>',
    '--revision <glob>',
    '--verified',
    '--unverified',
    '--description <glob>',
  ],
  commands: [
    '[glob...]',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '-l, --long',
    '--json',
    '--enabled',
    '--disabled',
    '--unconfigured',
  ],
  status: [
    '[skill...]',
    '--file <path>',
    '--lockfile <path>',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--system',
    '--managed',
    '--check',
    '--json',
  ],
  doctor: [
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--system',
    '--offline',
    '--strict',
    '--json',
    '--file <path>',
    '--lockfile <path>',
    '--all-tools',
    '--fix',
    '--dry-run',
    '-y, --yes',
  ],
  check: [
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--system',
    '--json',
    '--exit-code',
    '--file <path>',
    '--lockfile <path>',
    '--all-tools',
    '--report-only',
  ],
  verify: ['<path>', '-t, --tool <name>', '--static', '--deep', '--strict', '--json'],
  completion: ['<shell>'],
  version: [],
  help: ['[command|topic]'],
  install: [
    '<source...>',
    'alias:i',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--ref <git-ref>',
    '--pin',
    '--direct',
    '-f, --force',
    '--strict',
    '--no-verify',
    '--deep',
    '--continue-on-error',
    '--dry-run',
    '--json',
    '-y, --yes',
    '--file <path>',
    '--lockfile <path>',
    '--no-save',
    '-p, --path <dir>',
  ],
  uninstall: [
    '<skill...>',
    'alias:rm',
    'alias:remove',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--all-scopes',
    '-f, --force',
    '--dry-run',
    '--json',
    '-y, --yes',
    '--file <path>',
    '--lockfile <path>',
    '--no-save',
    '--continue-on-error',
  ],
  dev: [
    '<target...>',
    'alias:demote',
    '--all',
    '-t, --tool <name>',
    '--source <path>',
    '--dest <dir>',
    '--strict',
    '--no-verify',
    '--dry-run',
    '--json',
    '-y, --yes',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--continue-on-error',
    '--rollback',
  ],
  promote: [
    '<target...>',
    '--all',
    '-t, --tool <name>',
    '--strict',
    '--no-verify',
    '--allow-dirty',
    '--dry-run',
    '--json',
    '-y, --yes',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--continue-on-error',
    '--rollback',
  ],
  init: [
    '--file <path>',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '-f, --force',
    '--dry-run',
    '--json',
  ],
  export: [
    '--file <path>',
    '--lockfile <path>',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--system',
    '--managed',
    '--strict',
    '-f, --force',
    '--dry-run',
    '--json',
  ],
  plan: [
    '--file <path>',
    '--lockfile <path>',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--locked',
    '--prune',
    '--check',
    '--out <path>',
    '-f, --force',
    '--json',
  ],
  apply: [
    '--file <path>',
    '--lockfile <path>',
    '--plan <path>',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--locked',
    '--prune',
    '-y, --yes',
    '--continue-on-error',
    '--json',
    '--dry-run',
    '--check',
  ],
  sync: [
    '[skill...]',
    '--from <scope|path>',
    '--to <scope|path>',
    '-t, --tool <name>',
    '-f, --force',
    '--delete',
    '--save',
    '--file <path>',
    '--lockfile <path>',
    '--dry-run',
    '-y, --yes',
    '--continue-on-error',
    '--json',
  ],
  update: [
    '<skill...>',
    '--all',
    '--file <path>',
    '--lockfile <path>',
    '-t, --tool <name>',
    '--check',
    '--dry-run',
    '--ref <git-ref>',
    '--pin',
    '--strict',
    '-y, --yes',
    '--continue-on-error',
    '--json',
  ],
  undo: [
    '<skill...>',
    '--all',
    '-t, --tool <name>',
    '-s, --scope <scope>',
    '--user',
    '--project',
    '--dry-run',
    '-y, --yes',
    '--continue-on-error',
    '--json',
  ],
  gc: ['--dry-run', '--older-than <duration>', '--forget-project <path>', '-y, --yes', '--json'],
};

const newTargetSurfaces: Readonly<Record<string, readonly string[]>> = {
  agents: ['--json', '--capabilities'],
  'config get': ['--user', '--project', '--system'],
  'config set': ['--user', '--project', '--system', '--json'],
  'config list': ['--user', '--project', '--system'],
  'config unset': ['--user', '--project', '--system', '--json'],
  list: [
    '--mode <dev|pinned|unmanaged>',
    '--source <glob>',
    '--revision <glob>',
    '--verified',
    '--unverified',
    '--description <glob>',
  ],
  status: targetRows.status ?? [],
  doctor: ['--file <path>', '--lockfile <path>', '--all-tools', '--fix', '--dry-run', '-y, --yes'],
  check: ['--file <path>', '--lockfile <path>', '--all-tools', '--report-only'],
  install: ['--file <path>', '--lockfile <path>', '--no-save', '-p, --path <dir>'],
  uninstall: ['--file <path>', '--lockfile <path>', '--no-save', '--continue-on-error'],
  dev: ['-s, --scope <scope>', '--user', '--project', '--continue-on-error'],
  promote: ['-s, --scope <scope>', '--user', '--project', '--continue-on-error'],
  init: targetRows.init ?? [],
  export: targetRows.export ?? [],
  plan: targetRows.plan ?? [],
  apply: targetRows.apply ?? [],
  sync: targetRows.sync ?? [],
  update: targetRows.update ?? [],
  undo: targetRows.undo ?? [],
  gc: targetRows.gc ?? [],
};
const newCommands = new Set([
  'status',
  'init',
  'export',
  'plan',
  'apply',
  'sync',
  'update',
  'undo',
  'gc',
]);
const changedTargetKeys = new Set([
  'argument:skillsmith dev:<target...>',
  'argument:skillsmith promote:<target...>',
  'option:skillsmith dev:-y, --yes',
  'option:skillsmith promote:-y, --yes',
  'option:skillsmith install:-y, --yes',
  'option:skillsmith uninstall:-y, --yes',
  'option:skillsmith:-C, --cd <dir>',
  'option:skillsmith:--color <auto|always|never>',
  'option:skillsmith:-q, --quiet',
  'option:skillsmith:-v, --verbose',
  'option:skillsmith:--no-prompt',
  'option:skillsmith:--debug',
]);
const aliasTargetKeys = new Set([
  'option:skillsmith:-V, --version',
  'option:skillsmith apply:--dry-run',
  'option:skillsmith apply:--check',
]);
const phaseFor = (command: string): string =>
  commandGroup[command.split(' ')[0] ?? ''] ?? 'INVALID';

const targetEntries: MigrationEntry[] = [];
for (const flags of [
  '-h, --help',
  '-V, --version',
  '-C, --cd <dir>',
  '--config <file>',
  '--color <auto|always|never>',
  '--no-color',
  '-q, --quiet',
  '-v, --verbose',
  '--no-prompt',
  '--debug',
]) {
  const long = /--[\w-]+/.exec(flags)?.[0];
  targetEntries.push({
    key: `option:skillsmith:${flags}`,
    disposition: aliasTargetKeys.has(`option:skillsmith:${flags}`)
      ? 'A'
      : ['--config', '--no-color'].includes(long ?? '')
        ? 'N'
        : changedTargetKeys.has(`option:skillsmith:${flags}`)
          ? 'C'
          : 'K',
    phase: 'P17-G1-01',
    validationOwner: flags.includes('--version')
      ? 'EWP-CMD-HELP-TS07'
      : flags.includes('--help')
        ? 'EWP-CMD-HELP-TS01'
        : flags.includes('--config')
          ? 'EWP-P1-TS02'
          : 'EWP-P1-TS01',
    option: shapeFromFlags(flags),
  });
}
for (const [command, surfaces] of Object.entries(targetRows)) {
  targetEntries.push({
    key: `command:skillsmith ${command}`,
    disposition: newCommands.has(command) ? 'N' : 'K',
    phase: phaseFor(command),
    validationOwner: commandOwner(`skillsmith ${command}`),
  });
  for (const surface of surfaces) {
    const prefix = surface.startsWith('alias:')
      ? 'alias'
      : surface.startsWith('<') || surface.startsWith('[')
        ? 'argument'
        : 'option';
    const value = surface.replace(/^alias:/, '');
    const key = `${prefix}:skillsmith ${command}:${value}`;
    const disposition: MigrationDisposition = aliasTargetKeys.has(key)
      ? 'A'
      : prefix === 'alias'
        ? 'A'
        : /--rollback|--exit-code/.test(key)
          ? 'D'
          : changedTargetKeys.has(key)
            ? 'C'
            : newCommands.has(command) || newTargetSurfaces[command]?.includes(surface)
              ? 'N'
              : 'K';
    targetEntries.push({
      key,
      disposition,
      phase: phaseFor(command),
      validationOwner: commandOwner(`skillsmith ${command}`),
      ...(prefix === 'option' ? { option: shapeFromFlags(value, command) } : {}),
      ...(prefix === 'argument' ? { argument: targetArgumentShape(command, value) } : {}),
    });
  }
}

const topLevelCommands = [
  ...new Set(Object.keys(targetRows).map((command) => command.split(' ')[0])),
].filter((command): command is string => command !== undefined);
const validationCounts: Readonly<Record<string, number>> = {
  agents: 3,
  config: 5,
  list: 7,
  commands: 4,
  status: 6,
  doctor: 6,
  check: 5,
  verify: 4,
  completion: 6,
  help: 6,
  install: 8,
  uninstall: 7,
  dev: 6,
  promote: 6,
  init: 5,
  export: 9,
  plan: 12,
  apply: 14,
  sync: 10,
  update: 10,
  undo: 9,
  gc: 8,
};
const workflowOwners: Readonly<Record<string, readonly string[]>> = {
  status: ['EWP-WF02', 'EWP-WF11', 'EWP-WF14'],
  doctor: ['EWP-WF11'],
  help: ['EWP-WF16'],
  install: ['EWP-WF01', 'EWP-WF02'],
  uninstall: ['EWP-WF01', 'EWP-WF02'],
  dev: ['EWP-WF05'],
  promote: ['EWP-WF05'],
  init: ['EWP-WF03'],
  export: ['EWP-WF04'],
  plan: ['EWP-WF06', 'EWP-WF07', 'EWP-WF08'],
  apply: ['EWP-WF06', 'EWP-WF07', 'EWP-WF08'],
  sync: ['EWP-WF10'],
  update: ['EWP-WF09'],
  undo: ['EWP-WF11', 'EWP-WF14'],
  gc: ['EWP-WF12'],
};
const commandOwnership = topLevelCommands.map((command) => {
  const canonical = command === 'version' ? 'help' : command;
  const owner = `EWP-CMD-${canonical.toUpperCase()}`;
  const count = validationCounts[canonical] ?? 0;
  return {
    command: `skillsmith ${command}`,
    implementation: phaseFor(command),
    validations:
      command === 'version'
        ? ['EWP-CMD-HELP-TS07']
        : Array.from({ length: count }, (_, i) => `${owner}-TS${String(i + 1).padStart(2, '0')}`),
    workflows: workflowOwners[canonical] ?? [],
  };
});
const authoritativeCurrent = currentAuthorityJson as readonly MigrationEntry[];
const evolvingCurrentState = currentStateJson as readonly MigrationEntry[];
const authoritativeTarget = targetAuthorityJson as readonly MigrationEntry[];

export const migrationLedger: MigrationLedger = {
  schemaVersion: 1,
  snapshotVersion: '0.7.0',
  current: structuredClone(evolvingCurrentState),
  target: structuredClone(targetEntries),
  targetCommands: commandOwnership,
  optionGates: Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => {
      const id = `EWP-OPT-TS${String(index + 1).padStart(2, '0')}`;
      const owners = [
        'P17-G0-02',
        'P17-G1-03',
        'P17-G1-03',
        'P17-G1-02A',
        'P17-G6-02A',
        'P17-G1-01',
        'P17-G6-02A',
        'P17-G2-01',
        'P17-G4B-02',
        'P17-G1-02A',
      ];
      return [
        id,
        {
          target: `planned:packages/cli/tests/contracts/options.test.ts#${id}`,
          phase: owners[index] ?? 'invalid',
          requiredNow: index === 0,
        },
      ];
    }),
  ),
  currentHelpInventory: Object.fromEntries(
    evolvingCurrentState
      .filter((entry) => entry.key.startsWith('command:'))
      .map((entry) => entry.key.slice('command:'.length))
      .map((path) => [
        path,
        {
          visibleOptions: evolvingCurrentState
            .filter(
              (entry) => entry.key.startsWith(`option:${path}:`) && entry.option?.hidden !== true,
            )
            .map((entry) => entry.option?.flags)
            .filter((flags): flags is string => flags !== undefined)
            .sort(),
          hiddenOptions: evolvingCurrentState
            .filter(
              (entry) => entry.key.startsWith(`option:${path}:`) && entry.option?.hidden === true,
            )
            .map((entry) => entry.option?.flags)
            .filter((flags): flags is string => flags !== undefined)
            .sort(),
        },
      ]),
  ),
  targetHelpOwner: { phase: 'P17-G6-02A', validation: 'EWP-OPT-TS05' },
};

export const CLI_MIGRATION_PROVENANCE = {
  historicalSurface: {
    path: 'packages/cli/src/contracts/commander-surface-v0.7.0.json',
    sha256: 'd0de089c4f692bd2faecf15aa9643ff671850cfde24f6ba7d50b12e445c20df0',
    immutable: true,
  },
  historicalLedger: {
    path: 'packages/cli/src/contracts/commander-current-ledger-v0.7.0.json',
    sha256: '25625fe97807a8e89c3a62f070150cfc0f540c3d6c6b0331b35ae8af76cf2542',
    immutable: true,
  },
  evolvingCurrentState: {
    path: 'packages/cli/src/contracts/commander-current-state-v0.json',
    updatePolicy: 'update atomically with the owning phase implementation, tests, help, and ledger',
  },
} as const;

const allowedOwners = new Set([
  ...commandOwnership.flatMap((row) => [...row.validations, ...row.workflows]),
  ...Array.from({ length: 10 }, (_, index) => `EWP-OPT-TS${String(index + 1).padStart(2, '0')}`),
  'EWP-P1-TS01',
  'EWP-P1-TS02',
]);

const unique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
};

export const assertClosedMigrationLedger = (
  live: readonly CanonicalCommand[],
  ledger: MigrationLedger,
  currentStateAuthority: readonly MigrationEntry[] = evolvingCurrentState,
): void => {
  if (ledger.snapshotVersion !== '0.7.0')
    throw new Error('snapshot version is not immutable 0.7.0');
  const liveKeys = surfaceKeys(live);
  const ledgerKeys = ledger.current.map((entry) => entry.key);
  unique(liveKeys, 'live surface');
  unique(ledgerKeys, 'current ledger');
  unique(
    ledger.target.map((entry) => entry.key),
    'target ledger',
  );
  if (JSON.stringify(ledger.target) !== JSON.stringify(authoritativeTarget))
    throw new Error('target registry spelling, disposition, shape, or ownership differs');
  if (JSON.stringify([...liveKeys].sort()) !== JSON.stringify([...ledgerKeys].sort()))
    throw new Error('live/current ledger coverage differs');
  if (JSON.stringify(ledger.current) !== JSON.stringify(currentStateAuthority))
    throw new Error('current ledger metadata differs from evolving current-state authority');
  const covered = new Set([
    ...ledger.current.map((entry) => entry.key),
    ...ledger.target.map((entry) => entry.key),
  ]);
  for (const historical of authoritativeCurrent) {
    const inheritedReplacement = /^option:skillsmith [^:]+:(--no-prompt)$/.exec(historical.key);
    const promotedGlobal = inheritedReplacement?.[1];
    const coveredByPromotion =
      promotedGlobal !== undefined && covered.has(`option:skillsmith:${promotedGlobal}`);
    if (!covered.has(historical.key) && !coveredByPromotion)
      throw new Error(`historical 0.7 surface lost audit transition: ${historical.key}`);
    if (
      !['K', 'A', 'C', 'D', 'N'].includes(historical.disposition) ||
      !historical.phase ||
      !historical.validationOwner
    )
      throw new Error(`historical authority metadata invalid: ${historical.key}`);
  }
  for (const entry of [...ledger.current, ...ledger.target]) {
    if (!['K', 'A', 'C', 'D', 'N'].includes(entry.disposition))
      throw new Error(`unknown disposition: ${entry.key}`);
    if (!entry.phase || !entry.validationOwner || !allowedOwners.has(entry.validationOwner))
      throw new Error(`missing or unknown ownership: ${entry.key}`);
  }
  for (const command of live) {
    for (const option of command.options) {
      const key = `option:${command.path}:${option.flags}`;
      const metadata = ledger.current.find((entry) => entry.key === key)?.option;
      const expected = {
        flags: option.flags,
        short: option.short,
        long: option.long,
        attributeName: option.attributeName,
        requiredValue: option.requiredValue,
        optionalValue: option.optionalValue,
        variadic: option.variadic,
        valueShape: option.requiredValue
          ? 'required'
          : option.optionalValue
            ? 'optional'
            : 'boolean',
        choices: option.choices,
        defaultValue: JSON.stringify(option.defaultValue),
        defaultSource: option.defaultSource,
        repeatable: option.repeatable,
        negated: option.negated,
        hidden: option.hidden,
      };
      if (!metadata || JSON.stringify(metadata) !== JSON.stringify(expected))
        throw new Error(`current option metadata differs from live declaration: ${key}`);
    }
    for (const argument of command.arguments) {
      const key = `argument:${command.path}:${argument.name}`;
      const metadata = ledger.current.find((entry) => entry.key === key)?.argument;
      const expected = {
        required: argument.required,
        variadic: argument.variadic,
        choices: argument.choices,
        defaultValue: JSON.stringify(argument.defaultValue),
        defaultSource: 'none',
      };
      if (!metadata || JSON.stringify(metadata) !== JSON.stringify(expected))
        throw new Error(`current argument metadata differs from live declaration: ${key}`);
    }
  }
};

export const assertCommandOptionMatrix = (ledger: MigrationLedger): void => {
  unique(
    ledger.target.map((entry) => entry.key),
    'target matrix',
  );
  const byCommand = new Map<string, Set<string>>();
  for (const entry of ledger.target.filter((item) => item.key.startsWith('option:'))) {
    const expected = authoritativeTarget.find((item) => item.key === entry.key);
    if (!entry.option || JSON.stringify(entry.option) !== JSON.stringify(expected?.option))
      throw new Error(`contradictory option shape/default: ${entry.key}`);
    unique(entry.option.choices, `${entry.key} choices`);
    if (entry.option.negated && entry.option.valueShape !== 'boolean')
      throw new Error(`negated option is not boolean: ${entry.key}`);
    const [, command, flags] = /^option:(skillsmith(?: [^:]+)?):(.+)$/.exec(entry.key) ?? [];
    if (!command || !flags) throw new Error(`malformed option key: ${entry.key}`);
    const short = /(?:^|, )(-[A-Za-z])(?:,| |$)/.exec(flags)?.[1];
    if (!short) continue;
    const seen = byCommand.get(command) ?? new Set<string>();
    if (seen.has(short)) throw new Error(`duplicate short flag ${short} on ${command}`);
    seen.add(short);
    byCommand.set(command, seen);
  }
};

export const assertTargetOwnership = (ledger: MigrationLedger): void => {
  const targetCommands = [
    ...new Set(
      ledger.target
        .filter((entry) => entry.key.startsWith('command:'))
        .map(
          (entry) =>
            `skillsmith ${
              entry.key
                .slice(8)
                .replace(/^skillsmith /, '')
                .split(' ')[0]
            }`,
        ),
    ),
  ];
  unique(targetCommands, 'target commands');
  unique(
    ledger.targetCommands.map((entry) => entry.command),
    'command owners',
  );
  if (ledger.targetCommands.length !== 23)
    throw new Error('target command count is not exactly 23');
  if (
    JSON.stringify([...targetCommands].sort()) !==
    JSON.stringify(ledger.targetCommands.map((entry) => entry.command).sort())
  )
    throw new Error('target command ownership differs');
  if (JSON.stringify(ledger.targetCommands) !== JSON.stringify(commandOwnership))
    throw new Error(
      'target validation/workflow ownership differs from immutable catalog authority',
    );
};

export const assertOptionGateOwnership = (ledger: MigrationLedger): void => {
  const expected = Array.from(
    { length: 10 },
    (_, index) => `EWP-OPT-TS${String(index + 1).padStart(2, '0')}`,
  );
  if (JSON.stringify(Object.keys(ledger.optionGates).sort()) !== JSON.stringify(expected))
    throw new Error('option gate set differs');
  const exactPhases = [
    'P17-G0-02',
    'P17-G1-03',
    'P17-G1-03',
    'P17-G1-02A',
    'P17-G6-02A',
    'P17-G1-01',
    'P17-G6-02A',
    'P17-G2-01',
    'P17-G4B-02',
    'P17-G1-02A',
  ];
  for (const id of expected) {
    const gate = ledger.optionGates[id];
    const index = expected.indexOf(id);
    if (
      gate?.target !== `planned:packages/cli/tests/contracts/options.test.ts#${id}` ||
      gate.phase !== exactPhases[index]
    )
      throw new Error(`invalid owner for ${id}`);
  }
  if (expected.filter((id) => ledger.optionGates[id]?.requiredNow).join() !== 'EWP-OPT-TS01')
    throw new Error('future option gates promoted early');
};

export const assertHelpAndTargetClosure = (
  surface: readonly CanonicalCommand[],
  ledger: MigrationLedger,
): void => {
  if (
    ledger.targetHelpOwner.phase !== 'P17-G6-02A' ||
    ledger.targetHelpOwner.validation !== 'EWP-OPT-TS05'
  )
    throw new Error('future target help owner missing');
  if (JSON.stringify(ledger.target) !== JSON.stringify(authoritativeTarget))
    throw new Error('target registry spelling, disposition, shape, or ownership differs');
  const actual = Object.fromEntries(
    surface.map((command) => [
      command.path,
      {
        visibleOptions: command.options
          .filter((option) => !option.hidden)
          .map((option) => option.flags)
          .sort(),
        hiddenOptions: command.options
          .filter((option) => option.hidden)
          .map((option) => option.flags)
          .sort(),
      },
    ]),
  );
  if (JSON.stringify(actual) !== JSON.stringify(ledger.currentHelpInventory))
    throw new Error('current help inventory is stale');
  assertClosedMigrationLedger(surface, ledger);
  assertTargetOwnership(ledger);
};
