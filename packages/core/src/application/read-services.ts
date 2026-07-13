import { join, parse, resolve } from 'node:path';
import { listSupportedTools } from '../agents/registry.ts';
import { SUPPORTED_TOOLS, type SupportedTool } from '../agents/types.ts';
import type { CommandEntry } from '../commands/types.ts';
import { CONFIG_ACCESSORS, getConfigValue } from '../config/accessors.ts';
import { resolveEffectiveConfig } from '../config/effective.ts';
import { saveConfig } from '../config/save.ts';
import {
  CONFIG_KEYS,
  type Config,
  type ConfigKey,
  type ConfigLayer,
  type EffectiveConfig,
  SCOPES,
  type Scope,
} from '../config/types.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import { builtInChecks } from '../doctor/registry.ts';
import { focusDoctorPorts, runChecks } from '../doctor/run.ts';
import type { CheckRunMode, CheckRunResult } from '../doctor/types.ts';
import type { SkillSmithError } from '../errors.ts';
import { detectAll } from '../scan/index.ts';
import { listCommands } from '../scan/list-commands.ts';
import { listSkills } from '../scan/list-skills.ts';
import { validateSelectionRequest } from '../selection/resolve.ts';
import type {
  SelectionPolicy,
  SelectionValidationError,
  ValidatedSelectionRequest,
} from '../selection/types.ts';
import type { SkillEntry } from '../skills/types.ts';
import { verifyPlugin } from '../verify/run.ts';
import { VERIFY_TOOLS, type VerifyReport, type VerifyTool } from '../verify/types.ts';
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

type ApplicationError = SkillSmithError | SelectionValidationError | ReadServiceError;

interface ReadServiceError {
  readonly code: string;
  readonly message: string;
  readonly exitClass?: CommandExitClass;
}

export interface AgentsReport {
  readonly detections: ReadonlyMap<
    SupportedTool,
    readonly import('../detect/types.ts').InstallRecord[]
  >;
  readonly format: 'markdown' | 'json';
  readonly detectedOnly: boolean;
}

export interface ConfigGetReport {
  readonly key: string;
  readonly value: string | null;
  readonly source?: ConfigLayer;
  readonly scope?: Exclude<Scope, 'managed'>;
}

export interface ConfigSetReport {
  readonly key: string;
  readonly value: string;
  readonly scope: Exclude<Scope, 'managed'>;
  readonly file: string | null;
}

export interface ConfigListReport {
  readonly scope?: Exclude<Scope, 'managed'>;
  readonly effective: Config;
  readonly sources: EffectiveConfig['sources'];
  readonly layers: EffectiveConfig['layers'];
}

export interface ConfigUnsetReport {
  readonly key: string;
  readonly scope: Exclude<Scope, 'managed'>;
  readonly file: string | null;
}

export interface ListReport {
  readonly entries: readonly SkillEntry[];
  readonly long: boolean;
}

export interface CommandsReport {
  readonly entries: readonly CommandEntry[];
  readonly long: boolean;
}

export interface HealthReport {
  readonly mode: CheckRunMode;
  readonly result: CheckRunResult | null;
}

export interface VerifyApplicationReport {
  readonly result: VerifyReport | null;
}

export interface CurrentReadApplicationReports {
  readonly agents: AgentsReport;
  readonly configGet: ConfigGetReport;
  readonly configSet: ConfigSetReport;
  readonly configList: ConfigListReport;
  readonly configUnset: ConfigUnsetReport;
  readonly list: ListReport;
  readonly commands: CommandsReport;
  readonly doctor: HealthReport;
  readonly check: HealthReport;
  readonly verify: VerifyApplicationReport;
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

const exitClassForError = (error: ApplicationError): CommandExitClass => {
  if ('exitClass' in error && error.exitClass !== undefined) return error.exitClass;
  switch (error.code) {
    case 'usage':
    case 'invalid-enum':
    case 'invalid-argument':
      return 'usage';
    case 'capability':
    case 'unknown-tool':
    case 'tool-unavailable':
      return 'capability';
    case 'source-unresolvable':
      return 'source';
    case 'permission-denied':
      return 'permission';
    case 'placement-not-found':
    case 'ledger-error':
    case 'config-error':
    case 'flip-refused':
      return 'state';
    default:
      return 'failure';
  }
};

const failed = <T>(report: T, error: ApplicationError): CommandOutcome<T> =>
  success(report, {
    diagnostics: [
      {
        code: error.code,
        severity: 'error',
        message: messageForError(error),
      },
    ],
    exitClass: exitClassForError(error),
  });

const usage = (message: string): ReadServiceError => ({
  code: 'usage',
  message,
  exitClass: 'usage',
});

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
  (config.notices ?? []).map((notice) => ({
    code: notice.code,
    severity: 'warning' as const,
    message: `legacy project config detected at ${notice.path}`,
    remediation: 'migrate the project configuration when the Phase 2 migration is available',
    details: {
      path: notice.path,
      migrationPending: notice.migrationPending,
      migrationPhase: notice.migrationPhase,
    },
  }));

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
    readFile: async (path) => (path === invalidProjectConfig ? '' : context.ports.readText(path)),
  });
};

const configScope = (
  request: Readonly<CurrentCommandRequest>,
): Exclude<Scope, 'managed'> | ReadServiceError | undefined => {
  const scope = optionalString(request, 'scope');
  if (scope === undefined) return undefined;
  if (scope !== 'system' && scope !== 'user' && scope !== 'project') {
    return usage(`unknown config scope '${scope}' (expected user, project, or system)`);
  }
  return scope;
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

const configPatch = (key: ConfigKey, value: string): Partial<Config> =>
  CONFIG_ACCESSORS[key].patch(value);

const validateConfigValue = (key: ConfigKey, value: string): ReadServiceError | null => {
  const allowed =
    key === 'tool'
      ? listSupportedTools()
      : key === 'scope'
        ? (['system', 'user', 'project'] as const)
        : null;
  if (allowed !== null && !(allowed as readonly string[]).includes(value)) {
    return usage(`invalid value '${value}' for '${key}' (allowed: ${allowed.join(', ')})`);
  }
  return null;
};

const appliedMutation = (): MutationSummary => ({
  kind: 'applied',
  planned: 1,
  changed: 1,
  unchanged: 0,
  failed: 0,
});

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

const artifactPair = (
  project: ProjectContext,
  request: Readonly<CurrentCommandRequest>,
): { readonly file: string; readonly lockfile: string } | null | ReadServiceError => {
  const fileOption = optionalString(request, 'file');
  const lockfileOption = optionalString(request, 'lockfile');
  if (lockfileOption !== undefined && fileOption === undefined) {
    return usage('--lockfile requires --file');
  }
  if (fileOption === undefined) return null;
  const file = resolve(project.effectiveCwd, fileOption);
  if (lockfileOption !== undefined) {
    return { file, lockfile: resolve(project.effectiveCwd, lockfileOption) };
  }
  const parsed = parse(file);
  return { file, lockfile: join(parsed.dir, `${parsed.name}.lock`) };
};

export const runAgentsApplication: ApplicationService<CurrentCommandRequest, AgentsReport> = async (
  request,
  context,
) => {
  const report = (): AgentsReport => ({
    detections: new Map(),
    format: optionalString(request, 'format') === 'json' ? 'json' : 'markdown',
    detectedOnly: enabled(request, 'detectedOnly'),
  });
  const selection = validateReadSelection(request, READ_POLICY);
  if (!selection.ok) return failed(report(), selection.error);
  const detected = await detectAll(context.ports, {
    ...(selection.value.tools.length > 0 ? { tools: selection.value.tools } : {}),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    observation: context.observation,
  });
  if (!detected.ok) return failed(report(), detected.error);
  return success({ ...report(), detections: detected.value });
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
    const value = getConfigValue(config.value.layers[scope], key);
    if (value === undefined) {
      return failed(
        { key, value: null, scope },
        { code: 'config-unset', message: `'${key}' is not set at ${scope} scope` },
      );
    }
    return success({ key, value, scope }, { diagnostics: configNoticeDiagnostics(config.value) });
  }
  const source = config.value.sources[key];
  const value = source === undefined ? undefined : getConfigValue(config.value.layers[source], key);
  if (source === undefined || value === undefined) {
    return failed(empty, { code: 'config-unset', message: `'${key}' is not set` });
  }
  return success({ key, value, source }, { diagnostics: configNoticeDiagnostics(config.value) });
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
  const invalid = validateConfigValue(key, rawValue);
  if (invalid !== null) return failed(empty, invalid);
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const saved = await saveConfig(context.ports, {
    scope,
    patch: configPatch(key, rawValue),
    cwd: project.value.projectRoot ?? project.value.effectiveCwd,
  });
  if (!saved.ok) return failed(empty, saved.error);
  return success({ ...empty, key, file: saved.value.file }, { mutation: appliedMutation() });
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
  });
  if (!saved.ok) return failed(empty, saved.error);
  return success({ key, scope, file: saved.value.file }, { mutation: appliedMutation() });
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
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const config = await configFor(context, project.value);
  if (!config.ok) return failed(empty, config.error);
  const tools =
    selection.value.tools.length > 0
      ? selection.value.tools
      : config.value.value.tool
        ? [config.value.value.tool]
        : SUPPORTED_TOOLS;
  const listed = await listSkills(context.ports, {
    tools,
    scopes: scope.value === null ? SCOPES : [scope.value],
    ...(argumentStrings(request, 0).length > 0 ? { globs: argumentStrings(request, 0) } : {}),
    duplicatesOnly: enabled(request, 'duplicates'),
    ...(typeof filter === 'string' ? { enabledFilter: filter } : {}),
    cwd: project.value.projectRoot ?? project.value.effectiveCwd,
    configuration: context.configuration,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    observation: context.observation,
  });
  if (!listed.ok) return failed(empty, listed.error);
  return success(
    { ...empty, entries: listed.value },
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
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const config = await configFor(context, project.value);
  if (!config.ok) return failed(empty, config.error);
  const tools =
    selection.value.tools.length > 0
      ? selection.value.tools
      : config.value.value.tool
        ? [config.value.value.tool]
        : SUPPORTED_TOOLS;
  const listed = await listCommands(context.ports, {
    tools,
    scopes: scope.value === null ? ['user', 'project'] : [scope.value],
    ...(argumentStrings(request, 0).length > 0 ? { globs: argumentStrings(request, 0) } : {}),
    ...(typeof filter === 'string' ? { enabledFilter: filter } : {}),
    cwd: project.value.projectRoot ?? project.value.effectiveCwd,
    configuration: context.configuration,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    observation: context.observation,
  });
  if (!listed.ok) return failed(empty, listed.error);
  return success(
    { ...empty, entries: listed.value },
    { diagnostics: configNoticeDiagnostics(config.value) },
  );
};

const runHealthApplication = async (
  mode: CheckRunMode,
  request: Readonly<CurrentCommandRequest>,
  context: CurrentApplicationContext,
): Promise<CommandOutcome<HealthReport>> => {
  const empty: HealthReport = { mode, result: null };
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
  const artifacts = artifactPair(project.value, request);
  if (artifacts && 'code' in artifacts) return failed(empty, artifacts);
  const config = await healthConfigFor(mode, request, context, project.value);
  if (!config.ok) return failed(empty, config.error);
  const tools =
    mode === 'doctor' || enabled(request, 'allTools')
      ? selection.value.tools.length > 0
        ? selection.value.tools
        : SUPPORTED_TOOLS
      : selection.value.tools.length > 0
        ? selection.value.tools
        : config.value.value.tool
          ? [config.value.value.tool]
          : SUPPORTED_TOOLS;
  const scopes =
    scope.value !== null
      ? [scope.value]
      : mode === 'check' && config.value.value.scope
        ? [config.value.value.scope]
        : SCOPES;
  const checked = await runChecks(builtInChecks, {
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
  });
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
  const hasError = checked.value.counts.error > 0;
  const strictWarning =
    mode === 'doctor' && enabled(request, 'strict') && checked.value.counts.warning > 0;
  const reportOnly = mode === 'check' && enabled(request, 'reportOnly');
  return success(
    { mode, result: checked.value },
    {
      diagnostics: configNoticeDiagnostics(config.value),
      exitClass: !reportOnly && (hasError || strictWarning) ? 'failure' : 'success',
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

export const CURRENT_READ_APPLICATIONS: CurrentReadApplicationRegistry = Object.freeze({
  agents: runAgentsApplication,
  configGet: runConfigGetApplication,
  configSet: runConfigSetApplication,
  configList: runConfigListApplication,
  configUnset: runConfigUnsetApplication,
  list: runListApplication,
  commands: runCommandsApplication,
  doctor: runDoctorApplication,
  check: runCheckApplication,
  verify: runVerifyApplication,
});
