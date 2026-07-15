import { join, resolve } from 'node:path';
import { listSupportedTools } from '../agents/registry.ts';
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
import { type StatusV1Dto, statusV1Codec, toStatusV1Dto } from '../contracts/v1/status.ts';
import { builtInChecks } from '../doctor/registry.ts';
import { focusDoctorPorts, runChecks } from '../doctor/run.ts';
import type { CheckRunMode, CheckRunResult } from '../doctor/types.ts';
import type { SkillSmithError } from '../errors.ts';
import { redactSensitiveValue } from '../safety/redaction.ts';
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
import { readStatus } from '../status/read.ts';
import type {
  StatusArtifactSelection,
  StatusProjectPlacementContext,
  StatusReadError,
  StatusReadPorts,
  StatusReport,
} from '../status/types.ts';
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
    diagnostics: redactSensitiveValue([
      { code: error.code, severity: 'error', message: messageForError(error) },
    ]) as readonly Diagnostic[],
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
  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const config = await configFor(context, project.value);
  if (!config.ok) return failed(empty, config.error);
  const tools =
    selection.value.tools.length > 0
      ? selection.value.tools
      : effectiveTools(config.value).length > 0
        ? effectiveTools(config.value)
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
      : effectiveTools(config.value).length > 0
        ? effectiveTools(config.value)
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
  const artifacts = await artifactPair(context.ports, project.value, request);
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
        : effectiveTools(config.value).length > 0
          ? effectiveTools(config.value)
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

const statusProjectPlacement = async (
  ports: CurrentApplicationContext['ports'],
  project: ProjectContext,
  explicitScope: Scope | null,
): Promise<StatusProjectPlacementContext | ReadServiceError> => {
  if (project.projectRoot !== null && project.projectIdentity !== null) {
    return Object.freeze({
      state: 'selected',
      source: 'shared-project',
      root: `${project.projectRoot}`,
      identity: `${project.projectIdentity}`,
    });
  }
  if (explicitScope !== 'project') return Object.freeze({ state: 'unselected' });
  try {
    const root = await ports.realpath(project.effectiveCwd);
    return Object.freeze({
      state: 'selected',
      source: 'explicit-non-git',
      root: `${root}`,
      identity: `${root}`,
    });
  } catch {
    return {
      code: 'status-project-context',
      message: 'cannot resolve explicit non-Git project context',
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

  const project = await projectFor(context);
  if (!project.ok) return failed(empty, project.error);
  const placement = await statusProjectPlacement(context.ports, project.value, scope.value);
  if ('code' in placement) return failed(empty, placement);

  const configuration = await configFor(context, project.value);
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
    const pair = await resolveCoreArtifactPair(
      context.ports,
      project.value,
      readable.source === 'explicit'
        ? {
            file: file as string,
            ...(lockfile === undefined ? {} : { lockfile }),
          }
        : { discoveredFile: readable.file },
    );
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
  doctor: runDoctorApplication,
  check: runCheckApplication,
  verify: runVerifyApplication,
  status: runStatusApplication,
});
