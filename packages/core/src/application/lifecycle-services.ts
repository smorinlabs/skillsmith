import {
  defaultInstallDeps,
  defaultUninstallDeps,
  runInstall,
  runUninstall,
} from '../acquire/run.ts';
import type {
  CandidateSkill,
  InstallDeps,
  InstallReport,
  InstallScope,
  UninstallReport,
} from '../acquire/types.ts';
import type { SupportedTool } from '../agents/types.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import type { SkillSmithError } from '../errors.ts';
import { runDev, runPromote, runRollback } from '../place/run.ts';
import type { FlipReport, FlipTool, JournalPhase } from '../place/types.ts';
import type { Result } from '../result.ts';
import { validateSelectionRequest } from '../selection/resolve.ts';
import type { SelectionCapability, SelectionPolicy } from '../selection/types.ts';
import {
  type ApplicationService,
  type CommandExitClass,
  type CommandOutcome,
  type CurrentApplicationContext,
  type CurrentCommandRequest,
  type Diagnostic,
  type InteractionPort,
  type MutationSummary,
  NO_MUTATION,
} from './types.ts';

/** A lifecycle renderer receives either the domain report or a structured pre-domain refusal. */
export interface LifecycleApplicationReport<TReport> {
  readonly command: 'install' | 'uninstall' | 'dev' | 'promote';
  readonly value: TReport | null;
}

export type InstallApplicationReport = LifecycleApplicationReport<InstallReport>;
export type UninstallApplicationReport = LifecycleApplicationReport<UninstallReport>;
export type DevApplicationReport = LifecycleApplicationReport<FlipReport>;
export type PromoteApplicationReport = LifecycleApplicationReport<FlipReport>;

export interface LifecycleDependencies {
  readonly resolveContext: typeof resolveProjectContext;
  readonly install: typeof runInstall;
  readonly uninstall: typeof runUninstall;
  readonly dev: typeof runDev;
  readonly promote: typeof runPromote;
  readonly rollback: typeof runRollback;
}

const DEFAULT_DEPENDENCIES: LifecycleDependencies = {
  resolveContext: resolveProjectContext,
  install: runInstall,
  uninstall: runUninstall,
  dev: runDev,
  promote: runPromote,
  rollback: runRollback,
};

const FLIP_TOOLS = ['claude-code', 'codex'] as const satisfies readonly SupportedTool[];
const MUTATION_POLICY = (
  capabilities: readonly SelectionCapability[],
  allowAbsentCreate = false,
): SelectionPolicy => ({
  requiresSelection: true,
  allowBoundedDefault: false,
  allowAbsentCreate,
  allowedTools: FLIP_TOOLS,
  allowedScopes: ['user', 'project'],
  allowedCapabilities: capabilities,
});

const POLICIES = {
  install: MUTATION_POLICY(['install'], true),
  uninstall: MUTATION_POLICY(['uninstall']),
  dev: MUTATION_POLICY(['dev', 'undo'], true),
  promote: MUTATION_POLICY(['promote', 'undo']),
} as const;

const stringArray = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
};

const positionals = (request: Readonly<CurrentCommandRequest>): readonly string[] => {
  const first = request.arguments[0];
  return Array.isArray(first) ? stringArray(first) : stringArray(request.arguments);
};

const bool = (
  options: Readonly<Record<string, unknown>>,
  key: string,
  fallback = false,
): boolean => (typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback);

const optionalString = (
  options: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => (typeof options[key] === 'string' ? (options[key] as string) : undefined);

const tools = (options: Readonly<Record<string, unknown>>): readonly string[] =>
  stringArray(options.tool ?? options.tools);

const errorMessage = (error: SkillSmithError): string => {
  if ('message' in error) return error.message;
  return `unknown tool '${error.tool}'`;
};

const exitClassForError = (error: SkillSmithError): CommandExitClass => {
  switch (error.code) {
    case 'generic':
    case 'skill-parse-error':
    case 'flip-failed':
      return 'failure';
    case 'invalid-argument':
    case 'unknown-tool':
    case 'flip-refused':
      return 'usage';
    case 'config-error':
    case 'ledger-error':
      return 'state';
    case 'placement-not-found':
    case 'tool-unavailable':
      return 'capability';
    case 'source-unresolvable':
      return 'source';
    case 'permission-denied':
      return 'permission';
  }
};

const EXIT_PRECEDENCE: Readonly<Record<CommandExitClass, number>> = {
  success: 0,
  failure: 1,
  usage: 2,
  state: 3,
  capability: 4,
  source: 5,
  permission: 6,
  drift: 0,
  cancelled: 7,
};

const selectExitClass = (classes: readonly CommandExitClass[]): CommandExitClass =>
  classes.reduce<CommandExitClass>(
    (selected, candidate) =>
      EXIT_PRECEDENCE[candidate] > EXIT_PRECEDENCE[selected] ? candidate : selected,
    'success',
  );

const diagnosticForError = (error: SkillSmithError): Diagnostic => ({
  code: `skillsmith.${error.code}`,
  severity: 'error',
  message: errorMessage(error),
});

const refusal = <TReport>(
  command: LifecycleApplicationReport<TReport>['command'],
  exitClass: CommandExitClass,
  code: string,
  message: string,
): CommandOutcome<LifecycleApplicationReport<TReport>> => ({
  report: { command, value: null },
  diagnostics: [{ code, severity: 'error', message }],
  exitClass,
  mutation: NO_MUTATION,
  deprecations: [],
});

const domainFailure = <TReport>(
  command: LifecycleApplicationReport<TReport>['command'],
  error: SkillSmithError,
  signal?: AbortSignal,
): CommandOutcome<LifecycleApplicationReport<TReport>> => ({
  report: { command, value: null },
  diagnostics: [diagnosticForError(error)],
  exitClass: signal?.aborted ? 'cancelled' : exitClassForError(error),
  mutation: NO_MUTATION,
  deprecations: [],
});

const resolveContext = async (
  context: CurrentApplicationContext,
  dependencies: LifecycleDependencies,
): Promise<Result<ProjectContext, SkillSmithError>> => {
  if (context.projectContext !== undefined) return { ok: true, value: context.projectContext };
  const explicitConfigPath = context.globalOptions.config ?? context.envVars.SKILLSMITH_CONFIG;
  return dependencies.resolveContext(context.env, {
    invocationCwd: context.invocationCwd,
    ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
    ...(explicitConfigPath === undefined ? {} : { explicitConfigPath }),
  });
};

const scopeFlags = (
  options: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly value: InstallScope | null }
  | {
      readonly ok: false;
      readonly message: string;
      readonly exitClass: 'usage' | 'capability';
    } => {
  const shorthand = (['user', 'project', 'system', 'managed'] as const).filter((scope) =>
    bool(options, scope),
  );
  if (shorthand.length > 1) {
    return {
      ok: false,
      message: `conflicting scope shorthand flags: ${shorthand.map((scope) => `--${scope}`).join(' ')}`,
      exitClass: 'usage',
    };
  }
  const explicit = optionalString(options, 'scope');
  const known = ['user', 'project', 'system', 'managed'] as const;
  if (explicit !== undefined && !known.includes(explicit as (typeof known)[number])) {
    return { ok: false, message: `unknown scope '${explicit}'`, exitClass: 'usage' };
  }
  const selected = explicit ?? shorthand[0];
  if (explicit !== undefined && shorthand[0] !== undefined && explicit !== shorthand[0]) {
    return {
      ok: false,
      message: `--scope=${explicit} conflicts with --${shorthand[0]}`,
      exitClass: 'usage',
    };
  }
  if (selected === 'system' || selected === 'managed') {
    return {
      ok: false,
      message: `scope '${selected}' is unsupported for this operation`,
      exitClass: 'capability',
    };
  }
  return { ok: true, value: (selected as InstallScope | undefined) ?? null };
};

const validateMode = (
  options: Readonly<Record<string, unknown>>,
): { readonly ok: true } | { readonly ok: false; readonly message: string } => {
  if (bool(options, 'yes') && bool(options, 'dryRun')) {
    return { ok: false, message: '--yes cannot be combined with --dry-run' };
  }
  return { ok: true };
};

const journalPhase = (
  envVars: Readonly<Record<string, string | undefined>>,
): JournalPhase | undefined => {
  if (envVars.SKILLSMITH_E2E !== '1') return undefined;
  const phase = envVars.SKILLSMITH_TEST_PAUSE_AT;
  return phase === 'prepared' ||
    phase === 'staged' ||
    phase === 'backed-up' ||
    phase === 'live' ||
    phase === 'committed'
    ? phase
    : undefined;
};

const select = (
  command: keyof typeof POLICIES,
  targets: readonly string[],
  options: Readonly<Record<string, unknown>>,
  capability: SelectionCapability,
) =>
  validateSelectionRequest(
    {
      targets,
      all: bool(options, 'all'),
      tools: tools(options),
      ...(optionalString(options, 'scope') === undefined
        ? {}
        : { scopes: [optionalString(options, 'scope') as string] }),
      capability,
    },
    POLICIES[command],
  );

const interactiveInstallDeps = (
  interaction: InteractionPort,
  options: Readonly<Record<string, unknown>>,
) => {
  const deps: InstallDeps = { ...defaultInstallDeps };
  if (
    interaction.mode === 'interactive' &&
    !bool(options, 'json') &&
    bool(options, 'prompt', true)
  ) {
    deps.pick = async (candidates: readonly CandidateSkill[]): Promise<CandidateSkill | null> => {
      const resolution = await interaction.choose({
        id: 'install.ambiguous-skill',
        message: `${candidates.length} skills found — which one?`,
        choices: candidates.map((candidate) => ({
          value: candidate,
          label: candidate.name,
          hint: `//${candidate.path}`,
        })),
      });
      return resolution.status === 'resolved' ? resolution.value : null;
    };
  }
  return deps;
};

const reportOutcome = <TReport extends InstallReport | UninstallReport | FlipReport>(
  command: LifecycleApplicationReport<TReport>['command'],
  report: TReport,
  errors: readonly SkillSmithError[],
  mutation: MutationSummary,
  signal?: AbortSignal,
): CommandOutcome<LifecycleApplicationReport<TReport>> => ({
  report: { command, value: report },
  diagnostics: errors.map(diagnosticForError),
  exitClass: signal?.aborted
    ? 'cancelled'
    : selectExitClass(errors.map((error) => exitClassForError(error))),
  mutation,
  deprecations: [],
});

const installMutation = (report: InstallReport): MutationSummary => ({
  kind: report.dryRun ? 'preview' : 'applied',
  planned: report.results.length,
  changed: report.summary.installed + report.summary.updated + report.summary.repaired,
  unchanged: report.summary.noop + report.summary.skipped,
  failed: report.summary.refused + report.summary.failed,
});

const uninstallMutation = (report: UninstallReport): MutationSummary => ({
  kind: report.dryRun ? 'preview' : 'applied',
  planned: report.results.length,
  changed: report.summary.removed,
  unchanged: report.summary.noop,
  failed: report.summary.refused + report.summary.failed,
});

const flipMutation = (report: FlipReport): MutationSummary => ({
  kind: report.dryRun ? 'preview' : 'applied',
  planned: report.results.length,
  changed:
    report.summary.flipped +
    report.summary.updated +
    report.summary.rolledBack +
    report.summary.created +
    report.summary.adopted,
  unchanged: report.summary.noop + report.summary.skipped,
  failed: report.summary.refused + report.summary.failed,
});

export const createLifecycleApplicationServices = (
  overrides: Partial<LifecycleDependencies> = {},
) => {
  const dependencies: LifecycleDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  const install: ApplicationService<CurrentCommandRequest, InstallApplicationReport> = async (
    request,
    context,
  ) => {
    const sources = positionals(request);
    const options = request.options;
    const selection = select('install', sources, options, 'install');
    if (!selection.ok)
      return refusal(
        'install',
        selection.error.code === 'capability' ? 'capability' : 'usage',
        selection.error.code,
        selection.error.message,
      );
    const mode = validateMode(options);
    if (!mode.ok) return refusal('install', 'usage', 'mode-conflict', mode.message);
    if (bool(options, 'deep') && !bool(options, 'verify', true)) {
      return refusal(
        'install',
        'usage',
        'verify-conflict',
        '--deep and --no-verify contradict each other: --deep opts into a deeper verify gate, --no-verify skips the gate entirely',
      );
    }
    const scope = scopeFlags(options);
    if (!scope.ok) return refusal('install', scope.exitClass, 'scope', scope.message);
    const project = await resolveContext(context, dependencies);
    if (!project.ok) return domainFailure('install', project.error, context.signal);
    const pause = journalPhase(context.envVars);
    const result = await dependencies.install(
      context.env,
      {
        sources,
        ...(selection.value.tools.length === 0
          ? {}
          : { tools: selection.value.tools as readonly FlipTool[] }),
        ...(scope.value === null ? {} : { scope: scope.value }),
        ...(optionalString(options, 'ref') === undefined
          ? {}
          : { ref: optionalString(options, 'ref') as string }),
        pin: bool(options, 'pin'),
        direct: bool(options, 'direct'),
        force: bool(options, 'force'),
        strict: bool(options, 'strict'),
        noVerify: !bool(options, 'verify', true),
        deep: bool(options, 'deep'),
        continueOnError: bool(options, 'continueOnError'),
        dryRun: bool(options, 'dryRun'),
        cwd: project.value.projectRoot ?? project.value.effectiveCwd,
        envVars: { ...context.envVars },
        ...(pause === undefined ? {} : { testPauseAt: pause }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      interactiveInstallDeps(context.interaction, options),
    );
    if (!result.ok) return domainFailure('install', result.error, context.signal);
    const errors = result.value.results.flatMap((item) => (item.error ? [item.error] : []));
    return reportOutcome(
      'install',
      result.value,
      errors,
      installMutation(result.value),
      context.signal,
    );
  };

  const uninstall: ApplicationService<CurrentCommandRequest, UninstallApplicationReport> = async (
    request,
    context,
  ) => {
    const targets = positionals(request);
    const options = request.options;
    const selection = select('uninstall', targets, options, 'uninstall');
    if (!selection.ok)
      return refusal(
        'uninstall',
        selection.error.code === 'capability' ? 'capability' : 'usage',
        selection.error.code,
        selection.error.message,
      );
    const mode = validateMode(options);
    if (!mode.ok) return refusal('uninstall', 'usage', 'mode-conflict', mode.message);
    const scope = scopeFlags(options);
    if (!scope.ok) return refusal('uninstall', scope.exitClass, 'scope', scope.message);
    if (bool(options, 'allScopes') && scope.value !== null) {
      return refusal(
        'uninstall',
        'usage',
        'scope-conflict',
        '--all-scopes cannot be combined with --scope or a scope shorthand',
      );
    }
    const project = await resolveContext(context, dependencies);
    if (!project.ok) return domainFailure('uninstall', project.error, context.signal);
    const pause = journalPhase(context.envVars);
    const result = await dependencies.uninstall(
      context.env,
      {
        targets,
        ...(selection.value.tools.length === 0
          ? {}
          : { tools: selection.value.tools as readonly FlipTool[] }),
        ...(scope.value === null ? {} : { scope: scope.value }),
        allScopes: bool(options, 'allScopes'),
        force: bool(options, 'force'),
        dryRun: bool(options, 'dryRun'),
        cwd: project.value.projectRoot ?? project.value.effectiveCwd,
        envVars: { ...context.envVars },
        ...(pause === undefined ? {} : { testPauseAt: pause }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      { ...defaultUninstallDeps },
    );
    if (!result.ok) return domainFailure('uninstall', result.error, context.signal);
    const errors = result.value.results.flatMap((item) => (item.error ? [item.error] : []));
    return reportOutcome(
      'uninstall',
      result.value,
      errors,
      uninstallMutation(result.value),
      context.signal,
    );
  };

  const dev: ApplicationService<CurrentCommandRequest, DevApplicationReport> = async (
    request,
    context,
  ) => {
    const targets = positionals(request);
    const options = request.options;
    const rollback = bool(options, 'rollback');
    const selection = select('dev', targets, options, rollback ? 'undo' : 'dev');
    if (!selection.ok)
      return refusal(
        'dev',
        selection.error.code === 'capability' ? 'capability' : 'usage',
        selection.error.code,
        selection.error.message,
      );
    const mode = validateMode(options);
    if (!mode.ok) return refusal('dev', 'usage', 'mode-conflict', mode.message);
    const source = optionalString(options, 'source');
    const dest = optionalString(options, 'dest');
    if (bool(options, 'all') && source !== undefined)
      return refusal('dev', 'usage', 'source-conflict', '--all cannot be combined with --source');
    if (
      rollback &&
      (source !== undefined ||
        dest !== undefined ||
        bool(options, 'strict') ||
        !bool(options, 'verify', true))
    ) {
      return refusal(
        'dev',
        'usage',
        'rollback-conflict',
        '--rollback cannot be combined with --source, --dest, --strict, or --no-verify',
      );
    }
    if (source !== undefined && targets.length !== 1)
      return refusal(
        'dev',
        'usage',
        'source-target',
        '--source is only valid with exactly one positional target',
      );
    if (dest !== undefined && tools(options).length !== 1)
      return refusal(
        'dev',
        'usage',
        'dest-tool',
        `--dest requires exactly one --tool (got ${tools(options).length})`,
      );
    const project = await resolveContext(context, dependencies);
    if (!project.ok) return domainFailure('dev', project.error, context.signal);
    const pause = journalPhase(context.envVars);
    const flipOptions = {
      targets,
      all: bool(options, 'all'),
      ...(selection.value.tools.length === 0
        ? {}
        : { tools: selection.value.tools as readonly FlipTool[] }),
      ...(source === undefined ? {} : { source }),
      ...(dest === undefined ? {} : { dest }),
      strict: bool(options, 'strict'),
      noVerify: !bool(options, 'verify', true),
      dryRun: bool(options, 'dryRun'),
      cwd: project.value.projectRoot ?? project.value.effectiveCwd,
      envVars: { ...context.envVars },
      ...(pause === undefined ? {} : { testPauseAt: pause }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    const result = rollback
      ? await dependencies.rollback(context.env, { ...flipOptions, op: 'dev' })
      : await dependencies.dev(context.env, flipOptions);
    if (!result.ok) return domainFailure('dev', result.error, context.signal);
    const errors = result.value.results.flatMap((item) => (item.error ? [item.error] : []));
    return reportOutcome('dev', result.value, errors, flipMutation(result.value), context.signal);
  };

  const promote: ApplicationService<CurrentCommandRequest, PromoteApplicationReport> = async (
    request,
    context,
  ) => {
    const targets = positionals(request);
    const options = request.options;
    const rollback = bool(options, 'rollback');
    const selection = select('promote', targets, options, rollback ? 'undo' : 'promote');
    if (!selection.ok)
      return refusal(
        'promote',
        selection.error.code === 'capability' ? 'capability' : 'usage',
        selection.error.code,
        selection.error.message,
      );
    const mode = validateMode(options);
    if (!mode.ok) return refusal('promote', 'usage', 'mode-conflict', mode.message);
    if (
      rollback &&
      (bool(options, 'strict') || !bool(options, 'verify', true) || bool(options, 'allowDirty'))
    ) {
      return refusal(
        'promote',
        'usage',
        'rollback-conflict',
        '--rollback cannot be combined with --strict, --no-verify, or --allow-dirty',
      );
    }
    const project = await resolveContext(context, dependencies);
    if (!project.ok) return domainFailure('promote', project.error, context.signal);
    const pause = journalPhase(context.envVars);
    const flipOptions = {
      targets,
      all: bool(options, 'all'),
      ...(selection.value.tools.length === 0
        ? {}
        : { tools: selection.value.tools as readonly FlipTool[] }),
      strict: bool(options, 'strict'),
      noVerify: !bool(options, 'verify', true),
      allowDirty: bool(options, 'allowDirty'),
      dryRun: bool(options, 'dryRun'),
      cwd: project.value.projectRoot ?? project.value.effectiveCwd,
      envVars: { ...context.envVars },
      ...(pause === undefined ? {} : { testPauseAt: pause }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    const result = rollback
      ? await dependencies.rollback(context.env, { ...flipOptions, op: 'promote' })
      : await dependencies.promote(context.env, flipOptions);
    if (!result.ok) return domainFailure('promote', result.error, context.signal);
    const errors = result.value.results.flatMap((item) => (item.error ? [item.error] : []));
    return reportOutcome(
      'promote',
      result.value,
      errors,
      flipMutation(result.value),
      context.signal,
    );
  };

  return { install, uninstall, dev, promote } as const;
};

export const LIFECYCLE_APPLICATION_SERVICES = createLifecycleApplicationServices();
export const runInstallApplication = LIFECYCLE_APPLICATION_SERVICES.install;
export const runUninstallApplication = LIFECYCLE_APPLICATION_SERVICES.uninstall;
export const runDevApplication = LIFECYCLE_APPLICATION_SERVICES.dev;
export const runPromoteApplication = LIFECYCLE_APPLICATION_SERVICES.promote;
