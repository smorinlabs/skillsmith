import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Glob } from 'bun';
import { resolveRefViaLsRemote } from '../acquire/fetch.ts';
import { listSupportedTools, toolRegistry } from '../agents/registry.ts';
import { SUPPORTED_TOOLS, type SupportedTool } from '../agents/types.ts';
import { selectReadableArtifactContext } from '../artifacts/discovery.ts';
import { normalizePortablePath, normalizeRegistryIdentity } from '../artifacts/identity.ts';
import { resolveArtifactPair as resolveCoreArtifactPair } from '../artifacts/pair.ts';
import type { CommandEntry } from '../commands/types.ts';
import { CONFIG_ACCESSORS, getConfigTools, getConfigValue } from '../config/accessors.ts';
import { resolveEffectiveConfig } from '../config/effective.ts';
import { saveConfig } from '../config/save.ts';
import {
  CONFIG_KEYS,
  type Config,
  type ConfigKey,
  type ConfigLayer,
  type ConfigNotice,
  type EffectiveConfig,
  SCOPES,
  type Scope,
} from '../config/types.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import {
  type CapabilitySnapshotV1Dto,
  toCapabilitySnapshotV1Dto,
} from '../contracts/v1/capability-snapshot.ts';
import { type StatusV1Dto, statusV1Codec, toStatusV1Dto } from '../contracts/v1/status.ts';
import type { InstallRecord } from '../detect/types.ts';
import { builtInChecks } from '../doctor/registry.ts';
import {
  createDoctorRepairPlan,
  doctorMutationSummary,
  executeDoctorRepairPlan,
  executeDoctorRepairsObserved,
  identifyDoctorFindings,
} from '../doctor/repair.ts';
import { detectionPortsWithoutVersionProbe, focusDoctorPorts, runChecks } from '../doctor/run.ts';
import type {
  CheckRunContext,
  CheckRunMode,
  CheckRunResult,
  DoctorRunResult,
  DoctorSourceResolution,
} from '../doctor/types.ts';
import { type SkillSmithError, errorMessage, safeErrorCode } from '../errors.ts';
import { emitOperationPlanCreated } from '../execution/observation.ts';
import { readCommandInventory, readSkillInventory } from '../inventory/read.ts';
import { redactSensitiveValue } from '../safety/redaction.ts';
import { type CrossToolNameGroup, groupCrossToolNames } from '../scan/cross-tool-names.ts';
import { validateSelectionRequest } from '../selection/resolve.ts';
import type {
  SelectionPolicy,
  SelectionValidationError,
  ValidatedSelectionRequest,
} from '../selection/types.ts';
import type { SkillEntry } from '../skills/types.ts';
import { isStatusReadCancellation, readStatus } from '../status/read.ts';
import type {
  StatusArtifactSelection,
  StatusProjectPlacementContext,
  StatusReadError,
  StatusReadPorts,
  StatusReport,
} from '../status/types.ts';
import { verifyPlugin } from '../verify/run.ts';
import { VERIFY_TOOLS, type VerifyReport, type VerifyTool } from '../verify/types.ts';
import { exitClassForApplicationError, selectApplicationExitClass } from './exit-policy.ts';
import {
  type ApplicationService,
  type CommandExitClass,
  type CommandOutcome,
  type CurrentApplicationContext,
  type CurrentCommandRequest,
  type Deprecation,
  type Diagnostic,
  type MutationSummary,
  NO_MUTATION,
} from './types.ts';

type ApplicationError =
  | SkillSmithError
  | SelectionValidationError
  | ReadServiceError
  | StatusReadError;

interface ReadServiceError {
  readonly code: string;
  readonly message: string;
  readonly exitClass?: CommandExitClass;
}

export interface AgentsReport {
  readonly detections: ReadonlyMap<SupportedTool, readonly InstallRecord[]>;
  readonly format: 'markdown' | 'json';
  readonly detectedOnly: boolean;
  readonly showCapabilities?: boolean;
  readonly capabilities?: CapabilitySnapshotV1Dto;
}

export interface ConfigGetReport {
  readonly key: string;
  readonly value: string | null;
  readonly source?: ConfigLayer;
  readonly scope?: Exclude<Scope, 'managed'>;
  readonly notices?: readonly ConfigNotice[];
}

export interface ConfigSetReport {
  readonly key: string;
  readonly value: string;
  readonly scope: Exclude<Scope, 'managed'>;
  readonly file: string | null;
  readonly operation?: 'migrate-project-config';
}

export interface ConfigListReport {
  readonly scope?: Exclude<Scope, 'managed'>;
  readonly effective: Config;
  readonly sources: EffectiveConfig['sources'];
  readonly layers: EffectiveConfig['layers'];
  readonly notices?: readonly ConfigNotice[];
}

export interface ConfigUnsetReport {
  readonly key: string;
  readonly scope: Exclude<Scope, 'managed'>;
  readonly file: string | null;
  readonly operation?: 'migrate-project-config';
}

export interface InventorySelectionReport {
  readonly source: 'bounded-default';
  readonly tools: readonly SupportedTool[];
  readonly scopes: readonly Scope[];
  readonly filters: Readonly<Record<string, string | boolean | readonly string[] | null>>;
  readonly outcome: 'selected' | 'filter-noop';
}

export interface InventoryMemberReport {
  readonly scope: Scope;
  readonly path: string;
}

export interface InventoryVisibilityReport {
  readonly state: 'unique' | 'winner' | 'shadowed' | 'duplicate';
  readonly winner: string | null;
  readonly members: readonly InventoryMemberReport[];
}

export type ListApplicationEntry = SkillEntry &
  Readonly<{
    readonly mode?: 'dev' | 'pinned' | 'unmanaged';
    readonly placement?: 'symlink' | 'copy' | 'unknown';
    readonly source?: string | null;
    readonly revision?: string | null;
    readonly store?: string | null;
    readonly verification?: 'passed' | 'warned' | 'skipped' | 'unrecorded';
    readonly description?: string | null;
    readonly visibility?: InventoryVisibilityReport;
  }>;

export interface InventoryCollisionGroupReport {
  readonly tool: SupportedTool;
  readonly name: string;
  readonly winner: string | null;
  readonly members: readonly InventoryMemberReport[];
}

export interface ListReport {
  readonly selection?: InventorySelectionReport;
  readonly entries: readonly ListApplicationEntry[];
  readonly collisionGroups?: readonly InventoryCollisionGroupReport[];
  readonly long: boolean;
}

export type CommandApplicationEntry = CommandEntry &
  Readonly<{ readonly description?: string | null }>;

export interface CommandsReport {
  readonly selection?: InventorySelectionReport;
  readonly entries: readonly CommandApplicationEntry[];
  readonly long: boolean;
}

export interface CrossToolNamesReport {
  readonly groups: readonly CrossToolNameGroup[];
  readonly matchedEntries: number;
}

export interface HealthReport {
  readonly mode: CheckRunMode;
  readonly result: CheckRunResult | DoctorRunResult | null;
}

export interface VerifyApplicationReport {
  readonly result: VerifyReport | null;
}

export interface StatusApplicationReport {
  readonly result: StatusV1Dto | null;
}

export interface CurrentReadApplicationReports {
  readonly agents: AgentsReport;
  readonly configGet: ConfigGetReport;
  readonly configSet: ConfigSetReport;
  readonly configList: ConfigListReport;
  readonly configUnset: ConfigUnsetReport;
  readonly list: ListReport;
  readonly commands: CommandsReport;
  readonly crossToolNames: CrossToolNamesReport;
  readonly doctor: HealthReport;
  readonly check: HealthReport;
  readonly verify: VerifyApplicationReport;
  readonly status: StatusApplicationReport;
}

export type CurrentReadApplicationRegistry = Readonly<{
  [K in keyof CurrentReadApplicationReports]: ApplicationService<
    CurrentCommandRequest,
    CurrentReadApplicationReports[K]
  >;
}>;

const READ_POLICY: SelectionPolicy = {
  requiresSelection: false,
  allowBoundedDefault: true,
  allowAbsentCreate: false,
  allowedTools: SUPPORTED_TOOLS,
  allowedScopes: SCOPES,
  allowedCapabilities: ['read'],
};

const COMMANDS_POLICY: SelectionPolicy = {
  ...READ_POLICY,
  allowedScopes: ['user', 'project'],
};

const HEALTH_POLICY: SelectionPolicy = {
  ...READ_POLICY,
  allowedScopes: ['user', 'project', 'system'],
};

const VERIFY_POLICY: SelectionPolicy = {
  ...READ_POLICY,
  allowedTools: VERIFY_TOOLS,
};

const STATUS_POLICY: SelectionPolicy = {
  ...READ_POLICY,
  allowedScopes: SCOPES,
};

const success = <T>(
  report: T,
  options: {
    readonly diagnostics?: readonly Diagnostic[];
    readonly exitClass?: CommandExitClass;
    readonly mutation?: MutationSummary;
    readonly deprecations?: readonly Deprecation[];
  } = {},
): CommandOutcome<T> => ({
  report,
  diagnostics: options.diagnostics ?? [],
  exitClass: options.exitClass ?? 'success',
  mutation: options.mutation ?? NO_MUTATION,
  deprecations: options.deprecations ?? [],
});

const messageForError = (error: ApplicationError): string => {
  if ('tool' in error && typeof error.tool === 'string') return `Unknown tool: ${error.tool}`;
  if ('message' in error) return error.message;
  return error.code;
};

const failed = <T>(report: T, error: ApplicationError): CommandOutcome<T> =>
  success(report, {
    diagnostics: redactSensitiveValue([
      { code: error.code, severity: 'error', message: messageForError(error) },
    ]) as readonly Diagnostic[],
    exitClass: exitClassForApplicationError(error),
  });

const failedMany = <T>(
  report: T,
  errors: readonly ApplicationError[],
  signal?: AbortSignal,
): CommandOutcome<T> =>
  success(report, {
    diagnostics: redactSensitiveValue(
      errors.map((error) => ({
        code: error.code,
        severity: 'error' as const,
        message: messageForError(error),
      })),
    ) as readonly Diagnostic[],
    exitClass: signal?.aborted
      ? 'cancelled'
      : selectApplicationExitClass(
          errors.map((error) => exitClassForApplicationError(error, signal)),
        ),
  });

const usage = (message: string): ReadServiceError => ({
  code: 'usage',
  message,
  exitClass: 'usage',
});

const cancelled = (message: string): ReadServiceError => ({
  code: 'cancelled',
  message,
  exitClass: 'cancelled',
});

const isCancellationCause = (cause: unknown, seen = new Set<object>()): boolean => {
  const code = safeErrorCode(cause);
  if (code === 'ABORT_ERR' || code === 'cancelled') return true;
  if (cause === null || typeof cause !== 'object' || seen.has(cause)) return false;
  seen.add(cause);
  if (cause instanceof AggregateError) {
    return [...cause.errors].some((error) => isCancellationCause(error, seen));
  }
  const descriptor = Object.getOwnPropertyDescriptor(cause, 'cause');
  return descriptor !== undefined && 'value' in descriptor
    ? isCancellationCause(descriptor.value, seen)
    : false;
};

const normalizeReadCause = (cause: unknown, signal?: AbortSignal): ApplicationError => {
  const code = safeErrorCode(cause);
  if (signal?.aborted || isCancellationCause(cause)) {
    return cancelled('inventory read was cancelled');
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'permission-denied') {
    return {
      code: 'permission-denied',
      message: errorMessage(cause),
      exitClass: 'permission',
    };
  }
  if (code === 'source-unresolvable') {
    return { code, message: errorMessage(cause), exitClass: 'source' };
  }
  if (code === 'tool-unavailable' || code === 'placement-not-found' || code === 'capability') {
    return { code, message: errorMessage(cause), exitClass: 'capability' };
  }
  if (code === 'config-error' || code === 'ledger-error') {
    return { code, message: errorMessage(cause), exitClass: 'state' };
  }
  if (code === 'invalid-argument' || code === 'unknown-tool' || code === 'usage') {
    return { code, message: errorMessage(cause), exitClass: 'usage' };
  }
  return { code: code ?? 'generic', message: errorMessage(cause), exitClass: 'failure' };
};

const readCauses = (cause: unknown, signal?: AbortSignal): readonly ApplicationError[] => {
  if (cause instanceof AggregateError) {
    const errors = [...cause.errors].map((error) => normalizeReadCause(error, signal));
    if (signal?.aborted || errors.some((error) => error.code === 'cancelled')) {
      return [cancelled('inventory read was cancelled')];
    }
    return errors.length > 0 ? errors : [normalizeReadCause(cause, signal)];
  }
  return [normalizeReadCause(cause, signal)];
};

const option = (request: Readonly<CurrentCommandRequest>, name: string): unknown =>
  request.options[name];

const enabled = (request: Readonly<CurrentCommandRequest>, name: string): boolean =>
  option(request, name) === true;

const optionalString = (
  request: Readonly<CurrentCommandRequest>,
  name: string,
): string | undefined => {
  const value = option(request, name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const strings = (request: Readonly<CurrentCommandRequest>, name: string): readonly string[] => {
  const value = option(request, name);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
};

const argumentString = (
  request: Readonly<CurrentCommandRequest>,
  index: number,
): string | undefined => {
  const value = request.arguments[index];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const argumentStrings = (
  request: Readonly<CurrentCommandRequest>,
  index: number,
): readonly string[] => {
  const value = request.arguments[index];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
};

const focusStatusPorts = (ports: CurrentApplicationContext['ports']): StatusReadPorts =>
  Object.freeze({
    homeDir: ports.homeDir,
    executableSearchPath: Object.freeze([...ports.executableSearchPath]),
    platform: ports.platform,
    xdg: Object.freeze({ ...ports.xdg }),
    ...(ports.systemConfigPath === undefined ? {} : { systemConfigPath: ports.systemConfigPath }),
    fileExists: (path: string) => ports.fileExists(path),
    pathKind: (path: string) => ports.pathKind(path),
    realpath: (path: string) => ports.realpath(path),
    listDir: (path: string) => ports.listDir(path),
    readText: (path: string) => ports.readText(path),
    readBytes: (path: string) => ports.readBytes(path),
    readLink: (path: string) => ports.readLink(path),
    isExecutable: (path: string) => ports.isExecutable(path),
    modifiedAt: (path: string) => ports.modifiedAt(path),
    readFileMetadata: (path: string) => ports.readFileMetadata(path),
  });

const resolveScope = (
  request: Readonly<CurrentCommandRequest>,
  shorthandScopes: readonly Scope[],
):
  | { readonly ok: true; readonly value: Scope | null }
  | { readonly ok: false; readonly error: ReadServiceError } => {
  const explicit = optionalString(request, 'scope');
  if (explicit !== undefined && !(SCOPES as readonly string[]).includes(explicit)) {
    return { ok: false, error: usage(`unknown scope '${explicit}'`) };
  }
  const shorthands = shorthandScopes.filter((scope) => enabled(request, scope));
  if (shorthands.length > 1) {
    return {
      ok: false,
      error: usage(`scope shorthands are mutually exclusive: ${shorthands.join(', ')}`),
    };
  }
  const shorthand = shorthands[0];
  if (explicit !== undefined && shorthand !== undefined && explicit !== shorthand) {
    return {
      ok: false,
      error: usage(`--scope=${explicit} cannot be combined with --${shorthand}`),
    };
  }
  return { ok: true, value: (explicit as Scope | undefined) ?? shorthand ?? null };
};

const validateReadSelection = (
  request: Readonly<CurrentCommandRequest>,
  policy: SelectionPolicy,
  scopes: readonly string[] = [],
):
  | { readonly ok: true; readonly value: ValidatedSelectionRequest }
  | { readonly ok: false; readonly error: SelectionValidationError } =>
  validateSelectionRequest(
    {
      targets: [],
      all: false,
      tools: strings(request, 'tool'),
      scopes,
      capability: 'read',
    },
    policy,
  );

const projectFor = async (
  context: CurrentApplicationContext,
): Promise<
  | { readonly ok: true; readonly value: ProjectContext }
  | { readonly ok: false; readonly error: SkillSmithError }
> => {
  if (context.projectContext !== undefined) return { ok: true, value: context.projectContext };
  const explicitConfigPath =
    context.globalOptions.config ?? context.configuration.explicitConfigPath;
  return resolveProjectContext(context.ports, {
    invocationCwd: context.invocationCwd,
    ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
    ...(explicitConfigPath === undefined ? {} : { explicitConfigPath }),
  });
};

const configFor = async (
  context: CurrentApplicationContext,
  project: ProjectContext,
): Promise<
  | { readonly ok: true; readonly value: EffectiveConfig }
  | { readonly ok: false; readonly error: SkillSmithError }
> => {
  if (context.effectiveConfig !== undefined) return { ok: true, value: context.effectiveConfig };
  return resolveEffectiveConfig(context.ports, project, {
    configuration: context.configuration,
  });
};

const configNoticeDiagnostics = (config: EffectiveConfig): readonly Diagnostic[] =>
  (config.notices ?? []).map((notice): Diagnostic => {
    if (notice.code === 'legacy-project-config') {
      return {
        code: notice.code,
        severity: 'warning',
        message: `legacy project config detected at ${notice.path}`,
        remediation: 'migrate the project configuration in Phase 2 with config set or config unset',
        details: {
          path: notice.path,
          migrationPending: notice.migrationPending,
          migrationPhase: notice.migrationPhase,
        },
      };
    }
    return {
      code: notice.code,
      severity: 'warning',
      message: `${notice.disposition} plural tool selection from ${notice.source}`,
      remediation: 'use config list to inspect every selected tool',
      details: {
        source: notice.source,
        disposition: notice.disposition,
        tools: notice.tools.join(','),
        ...(notice.path === undefined ? {} : { path: notice.path }),
      },
    };
  });

const healthConfigFor = async (
  mode: CheckRunMode,
  request: Readonly<CurrentCommandRequest>,
  context: CurrentApplicationContext,
  project: ProjectContext,
): Promise<
  | { readonly ok: true; readonly value: EffectiveConfig }
  | { readonly ok: false; readonly error: SkillSmithError }
> => {
  const needsConfig =
    mode === 'check' ||
    (!enabled(request, 'json') && optionalString(request, 'file') === undefined);
  if (!needsConfig) return { ok: true, value: emptyEffectiveConfig() };
  const config = await configFor(context, project);
  if (
    mode !== 'check' ||
    config.ok ||
    context.effectiveConfig !== undefined ||
    config.error.code !== 'config-error' ||
    config.error.file !== project.discoveredConfigPath ||
    project.discoveredConfigPath === null
  ) {
    return config;
  }
  const invalidProjectConfig = project.discoveredConfigPath;
  return resolveEffectiveConfig(context.ports, project, {
    configuration: context.configuration,
    readFile: async (path) =>
      path === invalidProjectConfig ? 'version = 1\n' : context.ports.readText(path),
  });
};

const configScope = (
  request: Readonly<CurrentCommandRequest>,
): Exclude<Scope, 'managed'> | ReadServiceError | undefined => {
  const scope = optionalString(request, 'scope');
  if (scope !== undefined && scope !== 'system' && scope !== 'user' && scope !== 'project') {
    return usage(`unknown config scope '${scope}' (expected user, project, or system)`);
  }
  const shorthand = (['system', 'user', 'project'] as const).filter((name) =>
    enabled(request, name),
  );
  if (shorthand.length > 1) {
    return usage('--system, --user, and --project are mutually exclusive');
  }
  const selected = shorthand[0];
  if (selected !== undefined && scope !== undefined && selected !== scope) {
    return usage(`--${selected} conflicts with --scope ${scope}`);
  }
  return selected ?? scope;
};

const configKey = (request: Readonly<CurrentCommandRequest>): ConfigKey | ReadServiceError => {
  const key = argumentString(request, 0);
  if (key === undefined) return usage('a configuration key is required');
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    return usage(`unknown config key '${key}'`);
  }
  return key as ConfigKey;
};

const emptyEffectiveConfig = (): EffectiveConfig => ({
  value: {},
  sources: {},
  layers: {
    defaults: {},
    system: {},
    user: {},
    project: {},
    'explicit-file': {},
    env: {},
    cli: {},
  },
  paths: {},
});

const effectiveTools = (config: EffectiveConfig): readonly SupportedTool[] =>
  config.toolSelection?.tools ?? (config.value.tool === undefined ? [] : [config.value.tool]);

const registryOrderedTools = (tools: readonly SupportedTool[]): readonly SupportedTool[] => {
  const selected = new Set(tools);
  return Object.freeze(SUPPORTED_TOOLS.filter((tool) => selected.has(tool)));
};

const configPatch = (key: ConfigKey, value: string): Partial<Config> =>
  CONFIG_ACCESSORS[key].patch(value);

const validateConfigValue = (
  key: ConfigKey,
  value: string,
  destinationScope: Exclude<Scope, 'managed'>,
): ReadServiceError | null => {
  const allowed =
    key === 'tool'
      ? listSupportedTools()
      : key === 'scope'
        ? (['system', 'user', 'project'] as const)
        : null;
  if (allowed !== null && !(allowed as readonly string[]).includes(value)) {
    return usage(`invalid value '${value}' for '${key}' (allowed: ${allowed.join(', ')})`);
  }
  if (key === 'registry.default' && !normalizeRegistryIdentity(value).ok) {
    return usage('invalid credential-free registry identity');
  }
  if (key === 'path') {
    const pathScope = destinationScope === 'project' ? 'project' : 'user';
    if (!normalizePortablePath(value, pathScope, 'config.path').ok) {
      return usage(`invalid portable path for ${destinationScope} scope`);
    }
  }
  return null;
};

const saveMutation = (changed: boolean): MutationSummary => ({
  kind: 'applied',
  planned: 1,
  changed: changed ? 1 : 0,
  unchanged: changed ? 0 : 1,
  failed: 0,
});

const projectConfigDestination = (project: ProjectContext): string =>
  project.discoveredConfigPath ??
  join(project.projectRoot ?? project.effectiveCwd, 'skillsmith.toml');

const enabledFilter = (
  request: Readonly<CurrentCommandRequest>,
): 'enabled-only' | 'disabled-only' | 'unconfigured-only' | ReadServiceError | undefined => {
  const active = (['enabled', 'disabled', 'unconfigured'] as const).filter((name) =>
    enabled(request, name),
  );
  if (active.length > 1) {
    return usage('--enabled, --disabled, and --unconfigured are mutually exclusive');
  }
  if (active[0] === 'enabled') return 'enabled-only';
  if (active[0] === 'disabled') return 'disabled-only';
  if (active[0] === 'unconfigured') return 'unconfigured-only';
  return undefined;
};

const verificationFilter = (
  request: Readonly<CurrentCommandRequest>,
): 'verified' | 'unverified' | ReadServiceError | undefined => {
  if (enabled(request, 'verified') && enabled(request, 'unverified')) {
    return usage('--verified and --unverified are mutually exclusive');
  }
  if (enabled(request, 'verified')) return 'verified';
  if (enabled(request, 'unverified')) return 'unverified';
  return undefined;
};

const validateMode = (
  request: Readonly<CurrentCommandRequest>,
): 'dev' | 'pinned' | 'unmanaged' | ReadServiceError | undefined => {
  const value = option(request, 'mode');
  if (value === undefined) return undefined;
  if (value === 'dev' || value === 'pinned' || value === 'unmanaged') return value;
  return usage(`unknown list mode '${String(value)}'`);
};

const globSyntaxError = (pattern: string): string | null => {
  if (pattern.length === 0) return 'must not be empty';
  if (pattern.includes('\u0000')) return 'must not contain NUL';

  const stack: string[] = [];
  let escaped = false;
  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[' || character === '{' || character === '(') {
      stack.push(character);
      continue;
    }
    const expected =
      character === ']' ? '[' : character === '}' ? '{' : character === ')' ? '(' : null;
    if (expected !== null && stack.pop() !== expected) return `has an unmatched '${character}'`;
  }
  if (escaped) return 'must not end with an escape';
  if (stack.length > 0) return `has an unmatched '${stack[stack.length - 1]}'`;
  try {
    new Glob(pattern);
  } catch {
    return 'could not be compiled';
  }
  return null;
};

const validateGlobs = (
  patterns: readonly Readonly<{ readonly label: string; readonly value: string }>[],
): ReadServiceError | null => {
  for (const { label, value } of patterns) {
    const reason = globSyntaxError(value);
    if (reason !== null) return usage(`${label} glob '${value}' ${reason}`);
  }
  return null;
};

const stringOptionValue = (
  request: Readonly<CurrentCommandRequest>,
  name: string,
): string | undefined => {
  const value = option(request, name);
  return typeof value === 'string' ? value : undefined;
};

const selectedListScopes = (scope: Scope | null, project: ProjectContext): readonly Scope[] =>
  scope !== null
    ? Object.freeze([scope])
    : project.projectRoot === null
      ? Object.freeze(['system', 'user', 'managed'] as const)
      : SCOPES;

const selectedCommandScopes = (
  scope: Scope | null,
  project: ProjectContext,
): readonly ('user' | 'project')[] =>
  scope === 'user' || scope === 'project'
    ? Object.freeze([scope])
    : project.projectRoot === null
      ? Object.freeze(['user'] as const)
      : Object.freeze(['user', 'project'] as const);

const artifactPair = async (
  ports: CurrentApplicationContext['ports'],
  project: ProjectContext,
  request: Readonly<CurrentCommandRequest>,
): Promise<{ readonly file: string; readonly lockfile: string } | null | ReadServiceError> => {
  const fileOption = optionalString(request, 'file');
  const lockfileOption = optionalString(request, 'lockfile');
  if (lockfileOption !== undefined && fileOption === undefined) {
    return usage('--lockfile requires --file');
  }
  if (fileOption === undefined) return null;
  const resolved = await resolveCoreArtifactPair(ports, project, {
    file: fileOption,
    ...(lockfileOption === undefined ? {} : { lockfile: lockfileOption }),
  });
  if (!resolved.ok) {
    return {
      code: resolved.error.code,
      message: resolved.error.message,
      exitClass: resolved.error.exitClass === 'usage' ? 'usage' : 'state',
    };
  }
  return { file: resolved.value.file.path, lockfile: resolved.value.lockfile.path };
};

const deepFreezeReadProduct = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreezeReadProduct(nested, seen);
  return Object.freeze(value);
};

const immutableDetectionMap = (
  entries: Iterable<readonly [SupportedTool, readonly InstallRecord[]]>,
): ReadonlyMap<SupportedTool, readonly InstallRecord[]> => {
  const backing = new Map(entries);
  const rejectMutation = (): never => {
    throw new TypeError('agents detection inventory is immutable');
  };
  const proxy = new Proxy(backing, {
    get(target, property) {
      if (property === 'set' || property === 'delete' || property === 'clear')
        return rejectMutation;
      if (property === 'size') return target.size;
      if (property === 'forEach') {
        return (
          callback: (
            value: readonly InstallRecord[],
            key: SupportedTool,
            map: ReadonlyMap<SupportedTool, readonly InstallRecord[]>,
          ) => void,
          thisArg?: unknown,
        ): void => {
          for (const [key, value] of target) callback.call(thisArg, value, key, proxy);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
  return Object.freeze(proxy);
};

const frozenInstallRecords = (records: readonly InstallRecord[]): readonly InstallRecord[] =>
  Object.freeze(records.map((record) => Object.freeze({ ...record })));

export const runAgentsApplication: ApplicationService<CurrentCommandRequest, AgentsReport> = async (
  request,
  context,
) => {
  const rawFormat = optionalString(request, 'format');
  const jsonAlias = enabled(request, 'json');
  const format: AgentsReport['format'] = jsonAlias || rawFormat === 'json' ? 'json' : 'markdown';
  const selectedAdapters = (tools: readonly SupportedTool[]) =>
    toolRegistry.adapters.filter((adapter) => tools.includes(adapter.descriptor.id));
  const report = (tools: readonly SupportedTool[] = SUPPORTED_TOOLS): AgentsReport =>
    Object.freeze({
      detections: immutableDetectionMap([]),
      format,
      detectedOnly: enabled(request, 'detectedOnly'),
      showCapabilities: enabled(request, 'capabilities'),
      capabilities: deepFreezeReadProduct(
        toCapabilitySnapshotV1Dto({ adapters: selectedAdapters(tools) }),
      ),
    });
  if (rawFormat !== undefined && rawFormat !== 'markdown' && rawFormat !== 'json') {
    return failed(report(), usage(`unknown agents format '${rawFormat}'`));
  }
  if (jsonAlias && rawFormat === 'markdown') {
    return failed(report(), usage('--json cannot be combined with --format markdown'));
  }
  const selection = validateReadSelection(request, READ_POLICY);
  if (!selection.ok) return failed(report(), selection.error);
  const tools = SUPPORTED_TOOLS.filter(
    (tool) => selection.value.tools.length === 0 || selection.value.tools.includes(tool),
  );
  const attempts = await Promise.all(
    tools.map(async (tool) => {
      const adapter = toolRegistry.get(tool);
      if (adapter === undefined) {
        return { tool, error: { code: 'unknown-tool', tool } as SkillSmithError } as const;
      }
      const span = context.observation.emitter.begin(context.observation.context, {
        kind: 'tool.detection.started',
        toolId: tool,
      });
      try {
        const detected = await adapter.inventory.detect(context.ports, context.signal);
        context.observation.emitter.complete(span, {
          outcome: detected.ok ? 'success' : 'failure',
          errorCode: detected.ok ? null : detected.error.code,
          resultCount: detected.ok ? detected.value.length : 0,
        });
        return detected.ok
          ? ({ tool, records: detected.value } as const)
          : ({ tool, error: detected.error } as const);
      } catch (cause) {
        context.observation.emitter.complete(span, {
          outcome: 'failure',
          errorCode: safeErrorCode(cause) ?? 'generic',
          resultCount: 0,
        });
        return { tool, cause } as const;
      }
    }),
  );
  const cancelledAttempt = attempts.find(
    (attempt) =>
      ('cause' in attempt && isCancellationCause(attempt.cause)) ||
      ('error' in attempt && isCancellationCause(attempt.error)),
  );
  if (context.signal?.aborted || cancelledAttempt !== undefined) {
    return failed(report(tools), {
      code: 'cancelled',
      message: 'agent detection was cancelled',
      exitClass: 'cancelled',
    });
  }
  const failedAttempt = attempts.find((attempt) => 'error' in attempt || 'cause' in attempt);
  if (failedAttempt !== undefined) {
    const normalized =
      'error' in failedAttempt
        ? failedAttempt.error
        : normalizeReadCause(failedAttempt.cause, context.signal);
    return failed(report(tools), {
      code: normalized.code,
      message: messageForError(normalized),
      exitClass: 'failure',
    });
  }
  const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const ordered = immutableDetectionMap(
    attempts.map(
      (attempt) =>
        [
          attempt.tool,
          frozenInstallRecords(
            [...(attempt.records ?? [])].sort(
              (left, right) =>
                compareText(left.path, right.path) ||
                compareText(left.version, right.version) ||
                compareText(left.installMethod, right.installMethod),
            ),
          ),
        ] as const,
    ),
  );
  return success(Object.freeze({ ...report(tools), detections: ordered }));
};

export const runConfigGetApplication: ApplicationService<
  CurrentCommandRequest,
  ConfigGetReport
> = async (request, context) => {
  const rawKey = argumentString(request, 0) ?? '';
  const empty: ConfigGetReport = { key: rawKey, value: null };
  const key = configKey(request);
  if (typeof key !== 'string') return failed(empty, key);
  const scope = configScope(request);
  if (scope && typeof scope === 'object') return failed(empty, scope);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const config = await configFor(context, project.value);
  if (!config.ok) return failed(empty, config.error);
  if (scope !== undefined) {
    const scopedTools = key === 'tool' ? getConfigTools(config.value.layers[scope]) : undefined;
    if (scopedTools !== undefined && scopedTools.length > 1) {
      return failed(
        {
          key,
          value: null,
          scope,
          ...(config.value.notices === undefined ? {} : { notices: config.value.notices }),
        },
        usage(`'tool' is plural at ${scope} scope; use config list to inspect every value`),
      );
    }
    const value = getConfigValue(config.value.layers[scope], key);
    if (value === undefined) {
      return failed(
        { key, value: null, scope },
        { code: 'config-unset', message: `'${key}' is not set at ${scope} scope` },
      );
    }
    return success(
      {
        key,
        value,
        scope,
        ...(config.value.notices === undefined ? {} : { notices: config.value.notices }),
      },
      { diagnostics: configNoticeDiagnostics(config.value) },
    );
  }
  if (key === 'tool' && config.value.toolSelection?.cardinality === 'plural') {
    return failed(
      {
        key,
        value: null,
        ...(config.value.notices === undefined ? {} : { notices: config.value.notices }),
      },
      usage(`'tool' is plural; use config list to inspect every value`),
    );
  }
  const source = config.value.sources[key];
  const value = source === undefined ? undefined : getConfigValue(config.value.layers[source], key);
  if (source === undefined || value === undefined) {
    return failed(empty, { code: 'config-unset', message: `'${key}' is not set` });
  }
  return success(
    {
      key,
      value,
      source,
      ...(config.value.notices === undefined ? {} : { notices: config.value.notices }),
    },
    { diagnostics: configNoticeDiagnostics(config.value) },
  );
};

export const runConfigSetApplication: ApplicationService<
  CurrentCommandRequest,
  ConfigSetReport
> = async (request, context) => {
  const rawKey = argumentString(request, 0) ?? '';
  const rawValue = argumentString(request, 1) ?? '';
  const selectedScope = configScope(request);
  const scope =
    selectedScope === undefined || typeof selectedScope === 'string'
      ? (selectedScope ?? 'user')
      : 'user';
  const empty: ConfigSetReport = { key: rawKey, value: rawValue, scope, file: null };
  if (selectedScope && typeof selectedScope === 'object') return failed(empty, selectedScope);
  const key = configKey(request);
  if (typeof key !== 'string') return failed(empty, key);
  if (argumentString(request, 1) === undefined) {
    return failed(empty, usage('a configuration value is required'));
  }
  const invalid = validateConfigValue(key, rawValue, scope);
  if (invalid !== null) return failed(empty, invalid);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const saved = await saveConfig(context.ports, {
    scope,
    patch: configPatch(key, rawValue),
    cwd: project.value.projectRoot ?? project.value.effectiveCwd,
    ...(scope === 'project' ? { file: projectConfigDestination(project.value) } : {}),
  });
  if (!saved.ok) return failed(empty, saved.error);
  return success(
    {
      ...empty,
      key,
      file: saved.value.file,
      ...(saved.value.operation === undefined ? {} : { operation: saved.value.operation }),
    },
    { mutation: saveMutation(saved.value.changed) },
  );
};

export const runConfigListApplication: ApplicationService<
  CurrentCommandRequest,
  ConfigListReport
> = async (request, context) => {
  const selectedScope = configScope(request);
  const emptyConfig = emptyEffectiveConfig();
  const empty: ConfigListReport = {
    effective: emptyConfig.value,
    sources: emptyConfig.sources,
    layers: emptyConfig.layers,
  };
  if (selectedScope && typeof selectedScope === 'object') return failed(empty, selectedScope);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const config = await configFor(context, project.value);
  if (!config.ok) return failed(empty, config.error);
  return success(
    {
      ...(selectedScope === undefined ? {} : { scope: selectedScope }),
      effective: config.value.value,
      sources: config.value.sources,
      layers: config.value.layers,
      ...(config.value.notices === undefined ? {} : { notices: config.value.notices }),
    },
    { diagnostics: configNoticeDiagnostics(config.value) },
  );
};

export const runConfigUnsetApplication: ApplicationService<
  CurrentCommandRequest,
  ConfigUnsetReport
> = async (request, context) => {
  const rawKey = argumentString(request, 0) ?? '';
  const selectedScope = configScope(request);
  const scope =
    selectedScope === undefined || typeof selectedScope === 'string'
      ? (selectedScope ?? 'user')
      : 'user';
  const empty: ConfigUnsetReport = { key: rawKey, scope, file: null };
  if (selectedScope && typeof selectedScope === 'object') return failed(empty, selectedScope);
  const key = configKey(request);
  if (typeof key !== 'string') return failed(empty, key);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const saved = await saveConfig(context.ports, {
    scope,
    delete: [key],
    cwd: project.value.projectRoot ?? project.value.effectiveCwd,
    ...(scope === 'project' ? { file: projectConfigDestination(project.value) } : {}),
  });
  if (!saved.ok) return failed(empty, saved.error);
  return success(
    {
      key,
      scope,
      file: saved.value.file,
      ...(saved.value.operation === undefined ? {} : { operation: saved.value.operation }),
    },
    { mutation: saveMutation(saved.value.changed) },
  );
};

export const runListApplication: ApplicationService<CurrentCommandRequest, ListReport> = async (
  request,
  context,
) => {
  const empty: ListReport = { entries: [], long: enabled(request, 'long') };
  const scope = resolveScope(request, ['user', 'system', 'project', 'managed']);
  if (!scope.ok) return failed(empty, scope.error);
  const selection = validateReadSelection(
    request,
    READ_POLICY,
    scope.value === null ? [] : [scope.value],
  );
  if (!selection.ok) return failed(empty, selection.error);
  const filter = enabledFilter(request);
  if (filter && typeof filter === 'object') return failed(empty, filter);
  const verification = verificationFilter(request);
  if (verification && typeof verification === 'object') return failed(empty, verification);
  const mode = validateMode(request);
  if (mode && typeof mode === 'object') return failed(empty, mode);
  const names = argumentStrings(request, 0);
  const source = stringOptionValue(request, 'source');
  const revision = stringOptionValue(request, 'revision');
  const description = stringOptionValue(request, 'description');
  const invalidGlob = validateGlobs([
    ...names.map((value) => ({ label: 'name', value })),
    ...(source === undefined ? [] : [{ label: 'source', value: source }]),
    ...(revision === undefined ? [] : [{ label: 'revision', value: revision }]),
    ...(description === undefined ? [] : [{ label: 'description', value: description }]),
  ]);
  if (invalidGlob !== null) return failed(empty, invalidGlob);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const config = await configFor(context, project.value);
  if (!config.ok) return failed(empty, config.error);
  const requestedTools =
    selection.value.tools.length > 0
      ? selection.value.tools
      : effectiveTools(config.value).length > 0
        ? effectiveTools(config.value)
        : SUPPORTED_TOOLS;
  const tools = registryOrderedTools(requestedTools);
  const scopes = selectedListScopes(scope.value, project.value);
  const filters = Object.freeze({
    names: Object.freeze([...names]),
    mode: typeof mode === 'string' ? mode : null,
    source: source ?? null,
    revision: revision ?? null,
    description: description ?? null,
    verification: typeof verification === 'string' ? verification : null,
    enabled: typeof filter === 'string' ? filter : null,
    duplicates: enabled(request, 'duplicates'),
  });
  const emptySelected: ListReport = {
    ...empty,
    selection: Object.freeze({
      source: 'bounded-default',
      tools,
      scopes,
      filters,
      outcome: 'selected',
    }),
    collisionGroups: Object.freeze([]),
  };
  let listed: Awaited<ReturnType<typeof readSkillInventory>>;
  try {
    listed = await readSkillInventory(context.ports, {
      tools,
      scopes,
      ...(names.length > 0 ? { globs: names } : {}),
      duplicatesOnly: enabled(request, 'duplicates'),
      ...(typeof filter === 'string' ? { enabledFilter: filter } : {}),
      ...(typeof mode === 'string' ? { modeFilter: mode } : {}),
      ...(source === undefined ? {} : { sourceGlob: source }),
      ...(revision === undefined ? {} : { revisionGlob: revision }),
      ...(description === undefined ? {} : { descriptionGlob: description }),
      ...(typeof verification === 'string' ? { verificationFilter: verification } : {}),
      cwd: project.value.projectRoot ?? project.value.effectiveCwd,
      configuration: context.configuration,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      observation: context.observation,
    });
  } catch (cause) {
    return failedMany(emptySelected, readCauses(cause, context.signal), context.signal);
  }
  if (!listed.ok) {
    if (context.signal?.aborted) {
      return failed(emptySelected, cancelled('inventory read was cancelled'));
    }
    return failed(emptySelected, listed.error);
  }
  return success(
    Object.freeze({
      ...empty,
      selection: Object.freeze({ ...listed.value.selection, filters }),
      entries: listed.value.entries,
      collisionGroups: listed.value.collisionGroups,
    }),
    { diagnostics: configNoticeDiagnostics(config.value) },
  );
};

export const runCommandsApplication: ApplicationService<
  CurrentCommandRequest,
  CommandsReport
> = async (request, context) => {
  const empty: CommandsReport = { entries: [], long: enabled(request, 'long') };
  const scope = resolveScope(request, ['user', 'project']);
  if (!scope.ok) return failed(empty, scope.error);
  const selection = validateReadSelection(
    request,
    COMMANDS_POLICY,
    scope.value === null ? [] : [scope.value],
  );
  if (!selection.ok) return failed(empty, selection.error);
  const filter = enabledFilter(request);
  if (filter && typeof filter === 'object') return failed(empty, filter);
  const names = argumentStrings(request, 0);
  const invalidGlob = validateGlobs(names.map((value) => ({ label: 'name', value })));
  if (invalidGlob !== null) return failed(empty, invalidGlob);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const config = await configFor(context, project.value);
  if (!config.ok) return failed(empty, config.error);
  const requestedTools =
    selection.value.tools.length > 0
      ? selection.value.tools
      : effectiveTools(config.value).length > 0
        ? effectiveTools(config.value)
        : SUPPORTED_TOOLS;
  const tools = registryOrderedTools(requestedTools);
  const scopes = selectedCommandScopes(scope.value, project.value);
  const filters = Object.freeze({
    names: Object.freeze([...names]),
    enabled: typeof filter === 'string' ? filter : null,
  });
  const emptySelected: CommandsReport = {
    ...empty,
    selection: Object.freeze({
      source: 'bounded-default',
      tools,
      scopes,
      filters,
      outcome: 'selected',
    }),
  };
  let listed: Awaited<ReturnType<typeof readCommandInventory>>;
  try {
    listed = await readCommandInventory(context.ports, {
      tools,
      scopes,
      ...(names.length > 0 ? { globs: names } : {}),
      ...(typeof filter === 'string' ? { enabledFilter: filter } : {}),
      cwd: project.value.projectRoot ?? project.value.effectiveCwd,
      configuration: context.configuration,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      observation: context.observation,
    });
  } catch (cause) {
    return failedMany(emptySelected, readCauses(cause, context.signal), context.signal);
  }
  if (!listed.ok) {
    if (context.signal?.aborted) {
      return failed(emptySelected, cancelled('inventory read was cancelled'));
    }
    return failed(emptySelected, listed.error);
  }
  return success(
    Object.freeze({
      ...empty,
      selection: Object.freeze({ ...listed.value.selection, filters }),
      entries: listed.value.entries,
    }),
    { diagnostics: configNoticeDiagnostics(config.value) },
  );
};

export const runCrossToolNamesApplication: ApplicationService<
  CurrentCommandRequest,
  CrossToolNamesReport
> = async (request, context) => {
  const empty: CrossToolNamesReport = { groups: [], matchedEntries: 0 };
  const scope = resolveScope(request, ['user', 'system', 'project', 'managed']);
  if (!scope.ok) return failed(empty, scope.error);
  const selection = validateReadSelection(
    request,
    READ_POLICY,
    scope.value === null ? [] : [scope.value],
  );
  if (!selection.ok) return failed(empty, selection.error);
  const filter = enabledFilter(request);
  if (filter && typeof filter === 'object') return failed(empty, filter);
  const names = argumentStrings(request, 0);
  const invalidGlob = validateGlobs(names.map((value) => ({ label: 'name', value })));
  if (invalidGlob !== null) return failed(empty, invalidGlob);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const config = await configFor(context, project.value);
  if (!config.ok) return failed(empty, config.error);
  const requestedTools =
    selection.value.tools.length > 0
      ? selection.value.tools
      : effectiveTools(config.value).length > 0
        ? effectiveTools(config.value)
        : SUPPORTED_TOOLS;
  const tools = registryOrderedTools(requestedTools);
  const scopes = selectedListScopes(scope.value, project.value);
  let listed: Awaited<ReturnType<typeof readSkillInventory>>;
  try {
    listed = await readSkillInventory(context.ports, {
      tools,
      scopes,
      ...(names.length > 0 ? { globs: names } : {}),
      ...(typeof filter === 'string' ? { enabledFilter: filter } : {}),
      cwd: project.value.projectRoot ?? project.value.effectiveCwd,
      configuration: context.configuration,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      observation: context.observation,
    });
  } catch (cause) {
    return failedMany(empty, readCauses(cause, context.signal), context.signal);
  }
  if (!listed.ok) {
    if (context.signal?.aborted) {
      return failed(empty, cancelled('inventory read was cancelled'));
    }
    return failed(empty, listed.error);
  }
  return success(
    Object.freeze({
      groups: groupCrossToolNames(listed.value.entries),
      matchedEntries: listed.value.entries.length,
    }),
    { diagnostics: configNoticeDiagnostics(config.value) },
  );
};

const runHealthApplication = async (
  mode: CheckRunMode,
  request: Readonly<CurrentCommandRequest>,
  context: CurrentApplicationContext,
): Promise<CommandOutcome<HealthReport>> => {
  const empty: HealthReport = { mode, result: null };
  if (mode === 'doctor') {
    const fix = enabled(request, 'fix');
    const dryRun = enabled(request, 'dryRun');
    const yes = enabled(request, 'yes');
    if (yes && dryRun) return failed(empty, usage('--yes cannot be combined with --dry-run'));
    if (dryRun && !fix) return failed(empty, usage('--dry-run requires --fix'));
    if (yes && !fix) return failed(empty, usage('--yes requires --fix'));
  }
  if (enabled(request, 'allTools') && strings(request, 'tool').length > 0) {
    return failed(empty, usage('--all-tools cannot be combined with --tool'));
  }
  if (mode === 'check' && enabled(request, 'reportOnly') && enabled(request, 'exitCode')) {
    return failed(empty, usage('--report-only cannot be combined with --exit-code'));
  }
  const scope = resolveScope(request, ['user', 'system', 'project']);
  if (!scope.ok) return failed(empty, scope.error);
  const selection = validateReadSelection(
    request,
    HEALTH_POLICY,
    scope.value === null ? [] : [scope.value],
  );
  if (!selection.ok) return failed(empty, selection.error);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const artifacts = await artifactPair(context.ports, project.value, request);
  if (artifacts && 'code' in artifacts) return failed(empty, artifacts);
  const config = await healthConfigFor(mode, request, context, project.value);
  if (!config.ok) return failed(empty, config.error);
  let tools: readonly SupportedTool[];
  if (selection.value.tools.length > 0) {
    tools = selection.value.tools;
  } else if (enabled(request, 'allTools')) {
    tools = SUPPORTED_TOOLS;
  } else if (mode === 'doctor') {
    const detectionPorts = detectionPortsWithoutVersionProbe(context.ports);
    const detected = await Promise.all(
      toolRegistry.adapters.map(async (adapter) => {
        const result = await adapter.inventory.detect(detectionPorts, context.signal);
        return result.ok && result.value.length > 0 ? adapter.descriptor.id : null;
      }),
    );
    tools = detected.filter((tool): tool is SupportedTool => tool !== null);
  } else {
    tools =
      effectiveTools(config.value).length > 0 ? effectiveTools(config.value) : SUPPORTED_TOOLS;
  }
  const scopes =
    scope.value !== null
      ? [scope.value]
      : mode === 'check' && config.value.value.scope
        ? [config.value.value.scope]
        : SCOPES;
  const checkContext = {
    env: focusDoctorPorts(context.ports),
    mode,
    tools,
    scopes,
    scopeExplicit: scope.value !== null,
    cwd: project.value.projectRoot ?? project.value.effectiveCwd,
    ...(artifacts === null ? {} : { artifactPair: artifacts }),
    configuration: context.configuration,
    offline: mode === 'doctor' && enabled(request, 'offline'),
    observation: context.observation,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  } satisfies CheckRunContext;
  let checked = await runChecks(builtInChecks, checkContext);
  if (!checked.ok) {
    if (context.signal?.aborted) {
      return failed(empty, {
        code: 'cancelled',
        message: 'check run was cancelled',
        exitClass: 'cancelled',
      });
    }
    return failed(empty, checked.error);
  }
  if (mode === 'doctor') {
    const fix = enabled(request, 'fix');
    if (fix && !enabled(request, 'offline')) {
      const resolutions: DoctorSourceResolution[] = [];
      let complete = true;
      for (const finding of checked.value.findings) {
        if (finding.sourceResolution === undefined) continue;
        const resolved = await resolveRefViaLsRemote(
          context.ports,
          finding.sourceResolution.remoteUrl,
          finding.sourceResolution.ref,
          context.signal,
        );
        if (context.signal?.aborted) {
          return failed(empty, cancelled('doctor source resolution was cancelled'));
        }
        if (!resolved.ok || resolved.value === null) {
          complete = false;
          continue;
        }
        resolutions.push({ ...finding.sourceResolution, resolvedSha: resolved.value });
      }
      if (complete && resolutions.length > 0) {
        checked = await runChecks(builtInChecks, {
          ...checkContext,
          sourceResolutions: resolutions,
        });
        if (!checked.ok) {
          if (context.signal?.aborted) {
            return failed(empty, cancelled('doctor source-resolution replanning was cancelled'));
          }
          return failed(empty, checked.error);
        }
      }
    }
    const findings = identifyDoctorFindings(checked.value.findings);
    const repairMode = !fix
      ? ('not-requested' as const)
      : enabled(request, 'dryRun')
        ? ('preview' as const)
        : ('execute' as const);
    const repairPlan = fix ? createDoctorRepairPlan(findings) : null;
    if (repairPlan !== null) emitOperationPlanCreated(context.observation, repairPlan.plan);
    const operations = repairPlan?.operations ?? [];
    let results = [] as DoctorRunResult['repair']['results'];
    if (repairMode === 'execute' && repairPlan !== null && operations.length > 0) {
      if (!enabled(request, 'yes')) {
        const approval = await context.interaction.confirm({
          id: 'doctor.repair-plan',
          message: `Apply ${operations.length} automatic repair${operations.length === 1 ? '' : 's'}?`,
        });
        if (approval.status === 'cancelled') {
          return failed(empty, cancelled('doctor repair approval was cancelled'));
        }
        if (approval.status === 'refused' || !approval.value) {
          return failed(
            empty,
            usage('doctor repair execution requires --yes when approval is unavailable or refused'),
          );
        }
      }
      try {
        results = await executeDoctorRepairPlan(
          repairPlan,
          (executionRequest) => executeDoctorRepairsObserved(executionRequest, context.observation),
          {
            ports: context.ports,
            artifactCoordinator: context.artifactCoordinator,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          },
        );
      } catch (error) {
        if (
          context.signal?.aborted ||
          (typeof error === 'object' &&
            error !== null &&
            (error as { code?: unknown }).code === 'cancelled')
        ) {
          return failed(empty, cancelled('doctor repair was cancelled'));
        }
        throw error;
      }
    }
    const mutation = doctorMutationSummary(repairMode, operations, results);
    const result: DoctorRunResult = {
      findings,
      counts: checked.value.counts,
      repair: { mode: repairMode, operations, results },
      mutation,
    };
    const artifactFailure = findings.find((finding) => finding.failureClass !== undefined);
    const handled = new Set(
      operations.flatMap((operation) => {
        if (repairMode === 'preview') return operation.findingIds;
        if (repairMode !== 'execute') return [];
        const repairResult = results.find(
          (candidate) => candidate.operationId === operation.operationId,
        );
        return repairResult !== undefined && repairResult.outcome !== 'failed'
          ? operation.findingIds
          : [];
      }),
    );
    const unhandled = findings.filter((finding) => !handled.has(finding.findingId));
    const strictWarning =
      enabled(request, 'strict') && unhandled.some((finding) => finding.severity === 'warning');
    const hasUnhandledError = unhandled.some((finding) => finding.severity === 'error');
    const failedRepair = results.find((repairResult) => repairResult.outcome === 'failed');
    const repairFailureClass: CommandExitClass | null =
      failedRepair?.error?.code === 'permission-denied'
        ? 'permission'
        : failedRepair?.error?.code === 'source-resolution'
          ? 'source'
          : failedRepair?.error?.code === 'stale-state'
            ? 'state'
            : failedRepair === undefined
              ? null
              : 'failure';
    return success(
      { mode, result },
      {
        diagnostics: configNoticeDiagnostics(config.value),
        mutation,
        exitClass:
          artifactFailure?.failureClass ??
          repairFailureClass ??
          (strictWarning || hasUnhandledError ? 'failure' : 'success'),
      },
    );
  }
  const hasError = checked.value.counts.error > 0;
  const reportOnly = mode === 'check' && enabled(request, 'reportOnly');
  return success(
    { mode, result: checked.value },
    {
      diagnostics: configNoticeDiagnostics(config.value),
      exitClass: !reportOnly && hasError ? 'failure' : 'success',
      deprecations:
        mode === 'check' && enabled(request, 'exitCode') ? [CHECK_EXIT_CODE_DEPRECATION] : [],
    },
  );
};

export const CHECK_EXIT_CODE_DEPRECATION: Deprecation = Object.freeze({
  spelling: '--exit-code',
  replacement: 'default check behavior',
  removalVersion: '2.0',
  message: '--exit-code is deprecated; check already fails on errors by default',
});

export const runDoctorApplication: ApplicationService<CurrentCommandRequest, HealthReport> = (
  request,
  context,
) => runHealthApplication('doctor', request, context);

export const runCheckApplication: ApplicationService<CurrentCommandRequest, HealthReport> = (
  request,
  context,
) => runHealthApplication('check', request, context);

export const verifyExitClass = (report: VerifyReport): CommandExitClass => {
  if (report.summary.verdict === 'fail') return 'failure';
  if (report.summary.verdict === 'inconclusive') return 'capability';
  const anyRan = report.tools.some((tool) => tool.modes.some((mode) => mode.status === 'ran'));
  if (!anyRan) return 'capability';
  if (report.requested.explicitTools && report.tools.some((tool) => !tool.available)) {
    return 'capability';
  }
  if (
    report.requested.modes.includes('deep') &&
    report.tools.some(
      (tool) =>
        tool.available && !tool.modes.some((mode) => mode.mode === 'deep' && mode.status === 'ran'),
    )
  ) {
    return 'capability';
  }
  return 'success';
};

export const runVerifyApplication: ApplicationService<
  CurrentCommandRequest,
  VerifyApplicationReport
> = async (request, context) => {
  const empty: VerifyApplicationReport = { result: null };
  if (enabled(request, 'static') && enabled(request, 'deep')) {
    return failed(empty, usage('--static cannot be combined with --deep'));
  }
  const target = argumentString(request, 0);
  if (target === undefined) return failed(empty, usage('a plugin or skill path is required'));
  const selection = validateReadSelection(request, VERIFY_POLICY);
  if (!selection.ok) return failed(empty, selection.error);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const verified = await verifyPlugin(context.ports, {
    path: resolve(project.value.effectiveCwd, target),
    ...(selection.value.tools.length > 0
      ? { tools: selection.value.tools as readonly VerifyTool[] }
      : {}),
    deep: enabled(request, 'deep'),
    strict: enabled(request, 'strict'),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    observation: context.observation,
  });
  if (!verified.ok) {
    if (context.signal?.aborted) {
      return failed(empty, {
        code: 'cancelled',
        message: 'verification was cancelled',
        exitClass: 'cancelled',
      });
    }
    return failed(empty, verified.error);
  }
  return success({ result: verified.value }, { exitClass: verifyExitClass(verified.value) });
};

const STATUS_APPLICATION_CANCELLED: ReadServiceError = Object.freeze({
  code: 'cancelled',
  message: 'status read was cancelled',
  exitClass: 'cancelled',
});
const STATUS_PROJECT_CONTEXT_FAILURE: ReadServiceError = Object.freeze({
  code: 'status-project-context',
  message: 'cannot resolve project context for status',
  exitClass: 'failure',
});
const STATUS_CONFIGURATION_FAILURE: ReadServiceError = Object.freeze({
  code: 'status-configuration',
  message: 'cannot resolve effective configuration for status',
  exitClass: 'failure',
});

const statusProjectPlacement = async (
  ports: CurrentApplicationContext['ports'],
  project: ProjectContext,
  explicitScope: Scope | null,
  signal?: AbortSignal,
): Promise<StatusProjectPlacementContext | ReadServiceError> => {
  const shared = project.projectRoot !== null && project.projectIdentity !== null;
  if (!shared && explicitScope !== 'project') return Object.freeze({ state: 'unselected' });
  if (isStatusReadCancellation(undefined, signal)) return STATUS_APPLICATION_CANCELLED;
  try {
    const canonicalCwd = `${await ports.realpath(project.effectiveCwd)}`;
    if (isStatusReadCancellation(undefined, signal)) return STATUS_APPLICATION_CANCELLED;
    if (shared) {
      const displacement = relative(project.projectRoot as string, canonicalCwd);
      if (
        displacement !== '' &&
        (displacement === '..' || displacement.startsWith(`..${sep}`) || isAbsolute(displacement))
      ) {
        return {
          code: 'status-project-context',
          message: 'resolved cwd is outside the selected project context',
          exitClass: 'failure',
        };
      }
      return Object.freeze({
        state: 'selected',
        source: 'shared-project',
        canonicalCwd,
        root: `${project.projectRoot}`,
        identity: `${project.projectIdentity}`,
      });
    }
    return Object.freeze({
      state: 'selected',
      source: 'explicit-non-git',
      canonicalCwd,
      root: canonicalCwd,
      identity: canonicalCwd,
    });
  } catch (error) {
    if (isStatusReadCancellation(error, signal)) return STATUS_APPLICATION_CANCELLED;
    return {
      code: 'status-project-context',
      message: shared
        ? 'cannot resolve selected project context'
        : 'cannot resolve explicit non-Git project context',
      exitClass: 'failure',
    };
  }
};

const statusHasDrift = (dto: StatusV1Dto): boolean =>
  dto.facts.some((fact) => fact.impact === 'drift') ||
  dto.entries.some(
    (entry) =>
      entry.facts.some((fact) => fact.impact === 'drift') ||
      entry.placements.some((placement) => placement.facts.some((fact) => fact.impact === 'drift')),
  );

export interface StatusReportRenderingError {
  readonly code: 'status-rendering-failed';
  readonly message: 'status report could not be rendered safely';
  readonly exitClass: 'failure';
}

export type FinalizedStatusApplicationReport =
  | Readonly<{ readonly ok: true; readonly value: StatusV1Dto }>
  | Readonly<{ readonly ok: false; readonly error: StatusReportRenderingError }>;

const STATUS_RENDERING_FAILURE: StatusReportRenderingError = Object.freeze({
  code: 'status-rendering-failed',
  message: 'status report could not be rendered safely',
  exitClass: 'failure',
});

/** Internal application boundary: redact first, then accept only the closed status@1 contract. */
export const finalizeStatusApplicationReport = (
  report: StatusReport,
): FinalizedStatusApplicationReport => {
  let candidate: unknown;
  try {
    candidate = redactSensitiveValue(toStatusV1Dto(report));
  } catch {
    return { ok: false, error: STATUS_RENDERING_FAILURE };
  }
  const parsed = statusV1Codec.validate(candidate);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, error: STATUS_RENDERING_FAILURE };
};

export const runStatusApplication: ApplicationService<
  CurrentCommandRequest,
  StatusApplicationReport
> = async (request, context) => {
  const empty: StatusApplicationReport = { result: null };
  const file = optionalString(request, 'file');
  const lockfile = optionalString(request, 'lockfile');
  if (lockfile !== undefined && file === undefined) {
    return failed(empty, usage('--lockfile requires --file'));
  }

  const scope = resolveScope(request, ['system', 'user', 'project', 'managed']);
  if (!scope.ok) return failed(empty, scope.error);
  const validated = validateSelectionRequest(
    {
      targets: argumentStrings(request, 0),
      all: false,
      tools: strings(request, 'tool'),
      scopes: scope.value === null ? [] : [scope.value],
      capability: 'read',
    },
    STATUS_POLICY,
  );
  if (!validated.ok) return failed(empty, validated.error);

  let preflightPortCancelled = false;
  const trackPreflight =
    <Arguments extends readonly unknown[], Value>(
      operation: (...arguments_: Arguments) => Promise<Value>,
    ): ((...arguments_: Arguments) => Promise<Value>) =>
    async (...arguments_) => {
      try {
        return await operation(...arguments_);
      } catch (error) {
        if (isStatusReadCancellation(error)) preflightPortCancelled = true;
        throw error;
      }
    };
  const preflightContext: CurrentApplicationContext = {
    ...context,
    ports: {
      ...context.ports,
      fileExists: trackPreflight(context.ports.fileExists),
      pathKind: trackPreflight(context.ports.pathKind),
      readText: trackPreflight(context.ports.readText),
      realpath: trackPreflight(context.ports.realpath),
      git: {
        ...context.ports.git,
        findRepositoryRoot: trackPreflight(context.ports.git.findRepositoryRoot),
      },
    },
  };
  const cancelled = (): boolean =>
    preflightPortCancelled || isStatusReadCancellation(undefined, context.signal);
  if (cancelled()) return failed(empty, STATUS_APPLICATION_CANCELLED);
  let project: Awaited<ReturnType<typeof projectFor>>;
  try {
    project = await projectFor(preflightContext);
  } catch (error) {
    return failed(
      empty,
      cancelled() || isStatusReadCancellation(error, context.signal)
        ? STATUS_APPLICATION_CANCELLED
        : STATUS_PROJECT_CONTEXT_FAILURE,
    );
  }
  if (cancelled()) return failed(empty, STATUS_APPLICATION_CANCELLED);
  if (!project.ok) return failed(empty, project.error);
  const placement = await statusProjectPlacement(
    context.ports,
    project.value,
    scope.value,
    context.signal,
  );
  if (cancelled()) return failed(empty, STATUS_APPLICATION_CANCELLED);
  if ('code' in placement) return failed(empty, placement);

  let configuration: Awaited<ReturnType<typeof configFor>>;
  try {
    configuration = await configFor(preflightContext, project.value);
  } catch (error) {
    return failed(
      empty,
      cancelled() || isStatusReadCancellation(error, context.signal)
        ? STATUS_APPLICATION_CANCELLED
        : STATUS_CONFIGURATION_FAILURE,
    );
  }
  if (cancelled()) return failed(empty, STATUS_APPLICATION_CANCELLED);
  if (!configuration.ok) return failed(empty, configuration.error);
  const configuredTools = effectiveTools(configuration.value);
  const tools =
    validated.value.tools.length > 0
      ? validated.value.tools
      : configuredTools.length > 0
        ? configuredTools
        : SUPPORTED_TOOLS;
  const toolSelectionSource =
    validated.value.tools.length > 0
      ? ('explicit' as const)
      : configuredTools.length > 0
        ? ('effective-config' as const)
        : ('unbounded-default' as const);
  const scopes =
    scope.value !== null
      ? [scope.value]
      : placement.state === 'selected'
        ? SCOPES
        : SCOPES.filter((candidate) => candidate !== 'project');

  const readable = selectReadableArtifactContext(context.ports, project.value, {
    ...(file === undefined ? {} : { explicitFile: file }),
    scope: scope.value,
  });
  let artifactSelection: StatusArtifactSelection;
  if (readable.state === 'unselected') {
    artifactSelection = Object.freeze({ state: 'unselected', reason: readable.reason });
  } else {
    if (isStatusReadCancellation(undefined, context.signal)) {
      return failed(empty, STATUS_APPLICATION_CANCELLED);
    }
    let selectorCancelled = false;
    const pair = await resolveCoreArtifactPair(
      {
        pathKind: async (path) => {
          try {
            return await context.ports.pathKind(path);
          } catch (error) {
            if (isStatusReadCancellation(error, context.signal)) selectorCancelled = true;
            throw error;
          }
        },
        realpath: async (path) => {
          try {
            return await context.ports.realpath(path);
          } catch (error) {
            if (isStatusReadCancellation(error, context.signal)) selectorCancelled = true;
            throw error;
          }
        },
      },
      project.value,
      readable.source === 'explicit'
        ? {
            file: file as string,
            ...(lockfile === undefined ? {} : { lockfile }),
          }
        : { discoveredFile: readable.file },
    );
    if (selectorCancelled || isStatusReadCancellation(undefined, context.signal)) {
      return failed(empty, STATUS_APPLICATION_CANCELLED);
    }
    if (!pair.ok) {
      return failed(empty, {
        code: pair.error.code,
        message: pair.error.message,
        exitClass: pair.error.exitClass === 'usage' ? 'usage' : 'state',
      });
    }
    artifactSelection = Object.freeze({
      state: 'selected',
      source: readable.source,
      manifestPath: `${pair.value.file.path}`,
      lockPath: `${pair.value.lockfile.path}`,
      lockSource: pair.value.lockfileSource,
    });
  }

  const read = await readStatus(focusStatusPorts(context.ports), {
    projectContext: project.value,
    projectPlacement: placement,
    configuration: context.configuration,
    targets: Object.freeze([...validated.value.targets]),
    tools: Object.freeze([...tools]),
    toolSelectionSource,
    scopes: Object.freeze([...scopes]),
    scopeSelectionSource: scope.value === null ? 'unbounded-default' : 'explicit',
    selectionSource:
      validated.value.selectionSource === 'explicit-targets'
        ? 'explicit-targets'
        : 'bounded-default',
    artifactSelection,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (!read.ok) return failed(empty, read.error);

  const parsed = finalizeStatusApplicationReport(read.value);
  if (!parsed.ok) return failed(empty, parsed.error);
  return success(
    { result: parsed.value },
    { exitClass: enabled(request, 'check') && statusHasDrift(parsed.value) ? 'drift' : 'success' },
  );
};

export const CURRENT_READ_APPLICATIONS: CurrentReadApplicationRegistry = Object.freeze({
  agents: runAgentsApplication,
  configGet: runConfigGetApplication,
  configSet: runConfigSetApplication,
  configList: runConfigListApplication,
  configUnset: runConfigUnsetApplication,
  list: runListApplication,
  commands: runCommandsApplication,
  crossToolNames: runCrossToolNamesApplication,
  doctor: runDoctorApplication,
  check: runCheckApplication,
  verify: runVerifyApplication,
  status: runStatusApplication,
});
