import {
  defaultInstallDeps,
  defaultUninstallDeps,
  runInstallWithRegistry,
  runInstallWithRegistryObserved,
  runUninstallWithRegistry,
  runUninstallWithRegistryObserved,
} from '../acquire/run.ts';
import type { runInstall, runUninstall } from '../acquire/run.ts';
import type {
  CandidateSkill,
  InstallDeps,
  InstallReport,
  InstallScope,
  UninstallReport,
} from '../acquire/types.ts';
import { type LifecycleToolRegistry, toolRegistry } from '../agents/registry.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { ObservationBundle } from '../observation/index.ts';
import {
  prepareDevWithRegistry,
  prepareDevWithRegistryObserved,
  preparePromoteWithRegistry,
  preparePromoteWithRegistryObserved,
  prepareRollbackWithRegistry,
  prepareRollbackWithRegistryObserved,
} from '../place/run.ts';
import type { prepareDev, preparePromote, prepareRollback } from '../place/run.ts';
import type { FlipReport, FlipTool } from '../place/types.ts';
import type { OperationPlan } from '../planning/types.ts';
import type { Result } from '../result.ts';
import { validateSelectionRequest } from '../selection/resolve.ts';
import type { SelectionCapability, SelectionPolicy } from '../selection/types.ts';
import { exitClassForApplicationError, selectApplicationExitClass } from './exit-policy.ts';
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
  readonly prepareDev: typeof prepareDev;
  readonly preparePromote: typeof preparePromote;
  readonly prepareRollback: typeof prepareRollback;
}

type ObservedInstallDependency = (
  env: Parameters<typeof runInstall>[0],
  opts: Parameters<typeof runInstall>[1],
  deps: Parameters<typeof runInstall>[2],
  observation: ObservationBundle,
) => ReturnType<typeof runInstall>;
type ObservedUninstallDependency = (
  env: Parameters<typeof runUninstall>[0],
  opts: Parameters<typeof runUninstall>[1],
  deps: Parameters<typeof runUninstall>[2],
  observation: ObservationBundle,
) => ReturnType<typeof runUninstall>;
type ObservedPrepareDependency = (
  env: Parameters<typeof prepareDev>[0],
  opts: Parameters<typeof prepareDev>[1],
  deps: Parameters<typeof prepareDev>[2],
  observation: ObservationBundle,
) => ReturnType<typeof prepareDev>;
type ObservedRollbackDependency = (
  env: Parameters<typeof prepareRollback>[0],
  opts: Parameters<typeof prepareRollback>[1],
  deps: Parameters<typeof prepareRollback>[2],
  observation: ObservationBundle,
) => ReturnType<typeof prepareRollback>;

const defaultDependenciesFor = (registry: LifecycleToolRegistry): LifecycleDependencies => ({
  resolveContext: resolveProjectContext,
  install: (env, opts, deps = { ...defaultInstallDeps }, observation?: ObservationBundle) =>
    observation === undefined
      ? runInstallWithRegistry(env, opts, deps, registry)
      : runInstallWithRegistryObserved(env, opts, deps, registry, observation),
  uninstall: (env, opts, deps = { ...defaultUninstallDeps }, observation?: ObservationBundle) =>
    observation === undefined
      ? runUninstallWithRegistry(env, opts, deps, registry)
      : runUninstallWithRegistryObserved(env, opts, deps, registry, observation),
  prepareDev: (env, opts, deps, observation?: ObservationBundle) =>
    observation === undefined
      ? prepareDevWithRegistry(registry, env, opts, deps)
      : prepareDevWithRegistryObserved(registry, env, opts, observation, deps),
  preparePromote: (env, opts, deps, observation?: ObservationBundle) =>
    observation === undefined
      ? preparePromoteWithRegistry(registry, env, opts, deps)
      : preparePromoteWithRegistryObserved(registry, env, opts, observation, deps),
  prepareRollback: (env, opts, deps, observation?: ObservationBundle) =>
    observation === undefined
      ? prepareRollbackWithRegistry(registry, env, opts, deps)
      : prepareRollbackWithRegistryObserved(registry, env, opts, observation, deps),
});

type MutationSelectionCapability = Exclude<SelectionCapability, 'read'>;

const mutationPolicy = (
  registry: LifecycleToolRegistry,
  capability: MutationSelectionCapability,
  capabilities: readonly SelectionCapability[],
  allowAbsentCreate = false,
): SelectionPolicy<string> => ({
  requiresSelection: true,
  allowBoundedDefault: false,
  allowAbsentCreate,
  allowedTools: registry.toolsFor(capability),
  allowedScopes: ['user', 'project'],
  allowedCapabilities: capabilities,
});

const POLICIES = {
  install: { capabilities: ['install'], allowAbsentCreate: true },
  uninstall: { capabilities: ['uninstall'], allowAbsentCreate: false },
  dev: { capabilities: ['dev', 'undo'], allowAbsentCreate: true },
  promote: { capabilities: ['promote', 'undo'], allowAbsentCreate: false },
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
  exitClass: exitClassForApplicationError(error, signal),
  mutation: NO_MUTATION,
  deprecations: [],
});

const resolveContext = async (
  context: CurrentApplicationContext,
  dependencies: LifecycleDependencies,
): Promise<Result<ProjectContext, SkillSmithError>> => {
  if (context.projectContext !== undefined) return { ok: true, value: context.projectContext };
  const explicitConfigPath =
    context.globalOptions.config ?? context.configuration.explicitConfigPath;
  return dependencies.resolveContext(context.ports, {
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

const select = (
  registry: LifecycleToolRegistry,
  command: keyof typeof POLICIES,
  targets: readonly string[],
  options: Readonly<Record<string, unknown>>,
  capability: MutationSelectionCapability,
  normalizedScope?: InstallScope | null,
) =>
  validateSelectionRequest(
    {
      targets,
      all: bool(options, 'all'),
      tools: tools(options),
      ...((normalizedScope ?? optionalString(options, 'scope')) === undefined
        ? {}
        : { scopes: [(normalizedScope ?? optionalString(options, 'scope')) as string] }),
      capability,
    },
    mutationPolicy(
      registry,
      capability,
      POLICIES[command].capabilities,
      POLICIES[command].allowAbsentCreate,
    ),
    registry,
  );

type BulkApproval =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly exitClass: 'failure' | 'usage' | 'cancelled';
      readonly code: string;
      readonly message: string;
    };

const authorizeBulkPlan = async (
  command: 'dev' | 'promote',
  plan: OperationPlan<'dev' | 'promote'>,
  interaction: InteractionPort,
): Promise<BulkApproval> => {
  if (plan.operations.length === 0) return { ok: true };

  const operations = plan.operations;
  const groupCount = new Set(operations.map((operation) => operation.groupId)).size;
  const scopes = plan.selection.scopes;
  const scopeSummary = scopes.length === 0 ? 'the selected scopes' : scopes.join(', ');
  const resolution = await interaction.confirm({
    id: `${command}.bulk-approval`,
    message: `Confirm ${command} of ${groupCount} groups (${operations.length} operations) across ${scopeSummary}?`,
  });
  if (resolution.status === 'cancelled') {
    return {
      ok: false,
      exitClass: 'cancelled',
      code: 'approval-cancelled',
      message: `${command} bulk confirmation was cancelled`,
    };
  }
  if (resolution.status === 'refused') {
    return {
      ok: false,
      exitClass: 'usage',
      code: 'approval-required',
      message: `${command} bulk work requires approval or confirmation: ${resolution.reason}`,
    };
  }
  return resolution.value
    ? { ok: true }
    : {
        ok: false,
        exitClass: 'usage',
        code: 'approval-refused',
        message: `${command} bulk work was not approved`,
      };
};

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
    : selectApplicationExitClass(errors.map((error) => exitClassForApplicationError(error))),
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

const explicitBatchTargetFailure = (
  report: FlipReport,
  targetCount: number,
): FlipReport['results'][number] | undefined =>
  targetCount > 1
    ? report.results.find((result) => result.error?.code === 'placement-not-found')
    : undefined;

export const createLifecycleApplicationServices = (
  overrides: Partial<LifecycleDependencies> = {},
  registry: LifecycleToolRegistry = toolRegistry,
) => {
  const dependencies: LifecycleDependencies = { ...defaultDependenciesFor(registry), ...overrides };

  const install: ApplicationService<CurrentCommandRequest, InstallApplicationReport> = async (
    request,
    context,
  ) => {
    const sources = positionals(request);
    const options = request.options;
    const selection = select(registry, 'install', sources, options, 'install');
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
    const pause = context.configuration.journalPause;
    const result = await (dependencies.install as ObservedInstallDependency)(
      context.ports,
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
        configuration: context.configuration,
        ...(pause === undefined ? {} : { testPauseAt: pause }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      interactiveInstallDeps(context.interaction, options),
      context.observation,
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
    const selection = select(registry, 'uninstall', targets, options, 'uninstall');
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
    const pause = context.configuration.journalPause;
    const result = await (dependencies.uninstall as ObservedUninstallDependency)(
      context.ports,
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
        configuration: context.configuration,
        ...(pause === undefined ? {} : { testPauseAt: pause }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      { ...defaultUninstallDeps },
      context.observation,
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
    const mode = validateMode(options);
    if (!mode.ok) return refusal('dev', 'usage', 'mode-conflict', mode.message);
    const scope = scopeFlags(options);
    if (!scope.ok) return refusal('dev', scope.exitClass, 'scope', scope.message);
    const selection = select(
      registry,
      'dev',
      targets,
      options,
      rollback ? 'undo' : 'dev',
      scope.value,
    );
    if (!selection.ok)
      return refusal(
        'dev',
        selection.error.code === 'capability' ? 'capability' : 'usage',
        selection.error.code,
        selection.error.message,
      );
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
    const pause = context.configuration.journalPause;
    const flipOptions = {
      targets,
      all: bool(options, 'all'),
      selectionSource: bool(options, 'all')
        ? ('explicit-all' as const)
        : ('explicit-targets' as const),
      ...(selection.value.tools.length === 0
        ? {}
        : { tools: selection.value.tools as readonly FlipTool[] }),
      ...(scope.value === null ? {} : { scope: scope.value }),
      ...(source === undefined ? {} : { source }),
      ...(dest === undefined ? {} : { dest }),
      strict: bool(options, 'strict'),
      noVerify: !bool(options, 'verify', true),
      continueOnError: bool(options, 'continueOnError'),
      dryRun: bool(options, 'dryRun'),
      cwd: project.value.effectiveCwd,
      projectRoot: project.value.projectRoot,
      configuration: context.configuration,
      ...(pause === undefined ? {} : { testPauseAt: pause }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    const prepared = await (rollback
      ? (dependencies.prepareRollback as ObservedRollbackDependency)(
          context.ports,
          { ...flipOptions, op: 'dev' },
          undefined,
          context.observation,
        )
      : (dependencies.prepareDev as ObservedPrepareDependency)(
          context.ports,
          flipOptions,
          undefined,
          context.observation,
        ));
    if (!prepared.ok) return domainFailure('dev', prepared.error, context.signal);
    const missingTarget = explicitBatchTargetFailure(prepared.value.preview, targets.length);
    if (missingTarget !== undefined) {
      return refusal(
        'dev',
        'usage',
        'explicit-target-not-found',
        missingTarget.reason ?? 'one or more explicitly named targets were unmatched',
      );
    }
    let report: FlipReport;
    if (flipOptions.dryRun) {
      report = prepared.value.preview;
    } else {
      if (flipOptions.all || targets.length > 1) {
        const approval = await authorizeBulkPlan('dev', prepared.value.plan, context.interaction);
        if (!approval.ok)
          return refusal('dev', approval.exitClass, approval.code, approval.message);
      }
      const result = await prepared.value.execute();
      if (!result.ok) return domainFailure('dev', result.error, context.signal);
      report = result.value;
    }
    const errors = report.results.flatMap((item) => (item.error ? [item.error] : []));
    return reportOutcome('dev', report, errors, flipMutation(report), context.signal);
  };

  const promote: ApplicationService<CurrentCommandRequest, PromoteApplicationReport> = async (
    request,
    context,
  ) => {
    const targets = positionals(request);
    const options = request.options;
    const rollback = bool(options, 'rollback');
    const mode = validateMode(options);
    if (!mode.ok) return refusal('promote', 'usage', 'mode-conflict', mode.message);
    const scope = scopeFlags(options);
    if (!scope.ok) return refusal('promote', scope.exitClass, 'scope', scope.message);
    const selection = select(
      registry,
      'promote',
      targets,
      options,
      rollback ? 'undo' : 'promote',
      scope.value,
    );
    if (!selection.ok)
      return refusal(
        'promote',
        selection.error.code === 'capability' ? 'capability' : 'usage',
        selection.error.code,
        selection.error.message,
      );
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
    const pause = context.configuration.journalPause;
    const flipOptions = {
      targets,
      all: bool(options, 'all'),
      selectionSource: bool(options, 'all')
        ? ('explicit-all' as const)
        : ('explicit-targets' as const),
      ...(selection.value.tools.length === 0
        ? {}
        : { tools: selection.value.tools as readonly FlipTool[] }),
      ...(scope.value === null ? {} : { scope: scope.value }),
      strict: bool(options, 'strict'),
      noVerify: !bool(options, 'verify', true),
      allowDirty: bool(options, 'allowDirty'),
      continueOnError: bool(options, 'continueOnError'),
      dryRun: bool(options, 'dryRun'),
      cwd: project.value.effectiveCwd,
      projectRoot: project.value.projectRoot,
      configuration: context.configuration,
      ...(pause === undefined ? {} : { testPauseAt: pause }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    const prepared = await (rollback
      ? (dependencies.prepareRollback as ObservedRollbackDependency)(
          context.ports,
          { ...flipOptions, op: 'promote' },
          undefined,
          context.observation,
        )
      : (dependencies.preparePromote as ObservedPrepareDependency)(
          context.ports,
          flipOptions,
          undefined,
          context.observation,
        ));
    if (!prepared.ok) return domainFailure('promote', prepared.error, context.signal);
    const missingTarget = explicitBatchTargetFailure(prepared.value.preview, targets.length);
    if (missingTarget !== undefined) {
      return refusal(
        'promote',
        'usage',
        'explicit-target-not-found',
        missingTarget.reason ?? 'one or more explicitly named targets were unmatched',
      );
    }
    let report: FlipReport;
    if (flipOptions.dryRun) {
      report = prepared.value.preview;
    } else {
      if (flipOptions.all || targets.length > 1) {
        const approval = await authorizeBulkPlan(
          'promote',
          prepared.value.plan,
          context.interaction,
        );
        if (!approval.ok)
          return refusal('promote', approval.exitClass, approval.code, approval.message);
      }
      const result = await prepared.value.execute();
      if (!result.ok) return domainFailure('promote', result.error, context.signal);
      report = result.value;
    }
    const errors = report.results.flatMap((item) => (item.error ? [item.error] : []));
    return reportOutcome('promote', report, errors, flipMutation(report), context.signal);
  };

  return { install, uninstall, dev, promote } as const;
};

export const LIFECYCLE_APPLICATION_SERVICES = createLifecycleApplicationServices();
export const runInstallApplication = LIFECYCLE_APPLICATION_SERVICES.install;
export const runUninstallApplication = LIFECYCLE_APPLICATION_SERVICES.uninstall;
export const runDevApplication = LIFECYCLE_APPLICATION_SERVICES.dev;
export const runPromoteApplication = LIFECYCLE_APPLICATION_SERVICES.promote;
