import { basename, dirname, resolve } from 'node:path';
import { SUPPORTED_TOOLS, type SupportedTool } from '../agents/types.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ApplyModeV1, ApplyReportV1Dto } from '../contracts/v1/apply.ts';
import type {
  PlanCheckV1Dto,
  PlanDiagnosticV1Dto,
  PlanOperationV1Dto,
  PlanV1Dto,
} from '../contracts/v1/plan.ts';
import { errorMessage, safeErrorCode } from '../errors.ts';
import { createPlanningDiagnosticId } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { OperationExecutionResult, PlanningDiagnosticIdentity } from '../planning/types.ts';
import {
  createFreshReconcileExecutionPlanV1,
  executeValidatedReconcilePlan,
  prepareReconcilePlan,
  validateSavedReconcilePlan,
  validateSavedReconcilePlanValue,
} from '../reconcile/index.ts';
import type { ValidatedSavedReconcilePlan } from '../reconcile/index.ts';
import type { PlanReconcileError } from '../reconcile/types.ts';
import { projectPlanReport } from './plan-service.ts';
import type {
  ApplicationService,
  CommandOutcome,
  CurrentApplicationContext,
  CurrentCommandRequest,
  Diagnostic,
} from './types.ts';
import { NO_MUTATION } from './types.ts';

/** Renderer-facing apply boundary; pre-domain refusals intentionally carry no wire report. */
export interface ApplyApplicationReport {
  readonly result: ApplyReportV1Dto | null;
}

const EMPTY_REPORT: ApplyApplicationReport = Object.freeze({ result: null });

const usageOutcome = (code: string, message: string): CommandOutcome<ApplyApplicationReport> => ({
  report: EMPTY_REPORT,
  diagnostics: [{ code, severity: 'error', message }],
  exitClass: 'usage',
  mutation: NO_MUTATION,
  deprecations: [],
});

const cancellationOutcome = (): CommandOutcome<ApplyApplicationReport> => ({
  report: EMPTY_REPORT,
  diagnostics: [{ code: 'apply-cancelled', severity: 'error', message: 'apply was cancelled' }],
  exitClass: 'cancelled',
  mutation: NO_MUTATION,
  deprecations: [],
});

const outcome = (
  result: ApplyReportV1Dto,
  exitClass: CommandOutcome<ApplyApplicationReport>['exitClass'],
  diagnostics: readonly Diagnostic[] = [],
  mutation: CommandOutcome<ApplyApplicationReport>['mutation'] = NO_MUTATION,
): CommandOutcome<ApplyApplicationReport> => ({
  report: { result },
  diagnostics,
  exitClass,
  mutation,
  deprecations: [],
});

const appendApplyFailureDiagnostic = (
  report: ApplyReportV1Dto,
  diagnostic: Diagnostic,
  operation: PlanOperationV1Dto | null,
  refusalClass: NonNullable<PlanDiagnosticV1Dto['refusalClass']>,
): ApplyReportV1Dto => {
  const liveResource =
    operation?.after.kind === 'placement'
      ? operation.after.resource
      : operation?.before.kind === 'placement'
        ? operation.before.resource
        : null;
  const affected: PlanDiagnosticV1Dto['affected'] = {
    skill: operation?.skill ?? null,
    source: operation?.source ?? null,
    tool: operation?.tool ?? null,
    scope: operation?.scope ?? null,
    path: liveResource?.location ?? null,
  };
  const correlation: PlanDiagnosticV1Dto['correlation'] = {
    groupId: operation?.groupId ?? null,
    pairId: operation?.pairId ?? null,
    operationId: operation?.operationId ?? null,
  };
  const projected: PlanDiagnosticV1Dto = {
    diagnosticId: createPlanningDiagnosticId({
      domain: 'skillsmith.planning-diagnostic-identity',
      schemaVersion: 1,
      kind: 'conflict',
      severity: 'error',
      refusalClass,
      affected: affected as unknown as PlanningDiagnosticIdentity['affected'],
      correlation,
      reasonCode: diagnostic.code,
      selectionSource: report.selection.selectionSource,
    }),
    kind: 'conflict',
    severity: 'error',
    refusalClass,
    affected,
    correlation,
    reason: { code: diagnostic.code, message: diagnostic.message },
    selectionSource: report.selection.selectionSource,
  };
  return {
    ...report,
    diagnostics: [...report.diagnostics, projected],
    summary: {
      ...report.summary,
      diagnostics: report.summary.diagnostics + 1,
      diagnosticKinds: {
        ...report.summary.diagnosticKinds,
        conflict: report.summary.diagnosticKinds.conflict + 1,
      },
    },
  };
};

const diagnosticRefusalClass = (
  exitClass: CommandOutcome<ApplyApplicationReport>['exitClass'],
): NonNullable<PlanDiagnosticV1Dto['refusalClass']> =>
  exitClass === 'usage' ||
  exitClass === 'state' ||
  exitClass === 'capability' ||
  exitClass === 'source' ||
  exitClass === 'permission'
    ? exitClass
    : 'state';

const preparationFailure = (error: PlanReconcileError): CommandOutcome<ApplyApplicationReport> => ({
  report: EMPTY_REPORT,
  diagnostics: [
    {
      code: error.code === 'plan-cancelled' ? 'apply-cancelled' : error.code,
      severity: 'error',
      message: error.code === 'plan-cancelled' ? 'apply was cancelled' : error.message,
    },
  ],
  exitClass: error.exitClass,
  mutation: NO_MUTATION,
  deprecations: [],
});

type ReconcileRefusal = Readonly<{
  readonly refusalClass: NonNullable<PlanDiagnosticV1Dto['refusalClass']>;
  readonly reason: PlanDiagnosticV1Dto['reason'];
}>;

const refusalExitClass = (
  refusals: readonly ReconcileRefusal[],
): CommandOutcome<ApplyApplicationReport>['exitClass'] => {
  const precedence = {
    usage: 2,
    state: 3,
    capability: 4,
    source: 5,
    permission: 6,
  } as const;
  return refusals
    .map(({ refusalClass }) => refusalClass)
    .reduce((selected, candidate) =>
      precedence[candidate] > precedence[selected] ? candidate : selected,
    );
};

const has = (options: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.hasOwn(options, key);
const enabled = (options: Readonly<Record<string, unknown>>, key: string): boolean =>
  options[key] === true;

const scalarOptions = [
  { key: 'file', flag: '--file' },
  { key: 'lockfile', flag: '--lockfile' },
  { key: 'plan', flag: '--plan' },
  { key: 'scope', flag: '--scope' },
] as const;

const booleanOptions = [
  { key: 'user', flag: '--user' },
  { key: 'project', flag: '--project' },
  { key: 'locked', flag: '--locked' },
  { key: 'prune', flag: '--prune' },
  { key: 'yes', flag: '--yes' },
  { key: 'continueOnError', flag: '--continue-on-error' },
  { key: 'json', flag: '--json' },
  { key: 'dryRun', flag: '--dry-run' },
  { key: 'check', flag: '--check' },
] as const;

const selectedMode = (request: CurrentCommandRequest): ApplyModeV1 => {
  const saved = typeof request.options.plan === 'string';
  if (enabled(request.options, 'dryRun')) return saved ? 'saved-dry-run' : 'fresh-dry-run';
  if (enabled(request.options, 'check')) return saved ? 'saved-check' : 'fresh-check';
  return saved ? 'saved-execute' : 'fresh-execute';
};

const isSavedMode = (mode: ApplyModeV1): mode is Extract<ApplyModeV1, `saved-${string}`> =>
  mode.startsWith('saved-');

const selectedScope = (request: CurrentCommandRequest): 'user' | 'project' | null => {
  if (request.options.user === true) return 'user';
  if (request.options.project === true) return 'project';
  return request.options.scope === 'user' || request.options.scope === 'project'
    ? request.options.scope
    : null;
};

const executionSummary = (): Pick<
  ApplyReportV1Dto['summary'],
  'succeeded' | 'failed' | 'cancelled' | 'rolledBack' | 'skipped'
> => ({ succeeded: 0, failed: 0, cancelled: 0, rolledBack: 0, skipped: 0 });

const countKinds = <Kind extends string>(
  kinds: readonly Kind[],
  rows: readonly Readonly<{ readonly kind: Kind }>[],
): Record<Kind, number> =>
  Object.fromEntries(
    kinds.map((kind) => [kind, rows.filter((row) => row.kind === kind).length]),
  ) as Record<Kind, number>;

const freshReport = (
  mode: Extract<ApplyModeV1, `fresh-${string}`>,
  plan: PlanV1Dto,
  continueOnError: boolean,
): ApplyReportV1Dto => {
  const refused = plan.state === 'refused';
  return {
    schemaVersion: 1,
    kind: 'skillsmith.apply-report',
    command: 'apply',
    mode,
    state: refused
      ? 'refused'
      : mode === 'fresh-execute' && plan.operations.length === 0
        ? 'completed'
        : 'ready',
    artifactPair: plan.artifactPair,
    savedPlan: null,
    project: plan.project,
    options: {
      locked: plan.options.locked,
      prune: plan.options.prune,
      check: mode === 'fresh-check',
      dryRun: mode === 'fresh-dry-run',
      continueOnError,
    },
    selection: plan.selection,
    operations: plan.operations,
    checks: plan.checks,
    diagnostics: plan.diagnostics,
    approval: { required: false, outcome: 'not-required' },
    validation: { outcome: 'not-run', replanned: false },
    results: [],
    summary: { ...plan.summary, ...executionSummary() },
  };
};

const savedReport = (
  mode: Extract<ApplyModeV1, `saved-${string}`>,
  planPath: string,
  savedPlan: ValidatedSavedReconcilePlan,
): ApplyReportV1Dto => {
  const operations = structuredClone(
    savedPlan.savedPlan.operations,
  ) as unknown as PlanOperationV1Dto[];
  const checks = structuredClone(savedPlan.savedPlan.checks) as unknown as PlanCheckV1Dto[];
  const diagnostics = structuredClone(
    savedPlan.savedPlan.diagnostics,
  ) as unknown as PlanDiagnosticV1Dto[];
  const predicates = savedPlan.savedPlan.selectionPreconditions[0];
  const refusals = diagnostics.filter(({ kind }) => kind === 'refuse').length;
  return {
    schemaVersion: 1,
    kind: 'skillsmith.apply-report',
    command: 'apply',
    mode,
    state: 'ready',
    artifactPair: null,
    savedPlan: {
      path: basename(planPath),
      portability: savedPlan.savedPlan.portability.kind,
      executorSchemaVersion: savedPlan.savedPlan.executorSchemaVersion,
      hashSchemaVersion: savedPlan.savedPlan.hashSchemaVersion,
    },
    // A portable validation report must not leak the machine on which it was validated. The
    // reviewed operations retain any explicit machine bindings when the artifact declares them.
    project: { effectiveCwd: '<saved-plan>', root: null, identity: null },
    options: {
      locked: savedPlan.savedPlan.options.locked,
      prune: savedPlan.savedPlan.options.prune,
      check: mode === 'saved-check',
      dryRun: mode === 'saved-dry-run',
      continueOnError: false,
    },
    selection: {
      selectionSource: savedPlan.savedPlan.selection.selectionSource,
      selectionOutcome: savedPlan.selectionOutcome,
      requestedTools: [...(predicates?.tools ?? [])],
      requestedScope: predicates?.scopes.length === 1 ? (predicates.scopes[0] ?? null) : null,
      skills: [...savedPlan.savedPlan.selection.skills],
      tools: [...savedPlan.savedPlan.selection.tools],
      scopes: [...savedPlan.savedPlan.selection.scopes],
    },
    operations,
    checks,
    diagnostics,
    approval: { required: false, outcome: 'prior-authorization' },
    validation: { outcome: 'valid', replanned: false },
    results: [],
    summary: {
      operations: operations.length,
      checks: checks.length,
      diagnostics: diagnostics.length,
      drift: operations.length,
      refusals,
      operationKinds: countKinds(
        [
          'install',
          'update',
          'remove',
          'link-dev',
          'promote',
          'move-scope',
          'adapt',
          'repair',
          'write-manifest',
          'write-lock',
          'migrate-project-config',
          'migrate-ledger',
        ] as const,
        operations,
      ),
      checkKinds: countKinds(
        [
          'source-resolution',
          'capability',
          'content-integrity',
          'verification',
          'precondition-validation',
        ] as const,
        checks,
      ),
      diagnosticKinds: countKinds(
        ['noop', 'skip', 'refuse', 'conflict', 'warning'] as const,
        diagnostics,
      ),
      ...executionSummary(),
    },
  };
};

const projectedExecutionResults = (
  results: readonly OperationExecutionResult[],
): ApplyReportV1Dto['results'] =>
  results.map((result) => ({
    operationId: result.operationId,
    outcome: result.outcome === 'skipped-after-failure' ? 'skipped' : result.outcome,
    reason:
      result.outcome === 'failed'
        ? result.error.message
        : result.outcome === 'skipped-after-failure'
          ? 'fail-fast'
          : result.outcome === 'cancelled'
            ? 'cancelled'
            : result.outcome === 'rolled-back'
              ? 'rolled back'
              : null,
    error: result.outcome === 'failed' ? result.error : null,
  }));

const completedReport = (
  base: ApplyReportV1Dto,
  results: readonly OperationExecutionResult[],
  approval: ApplyReportV1Dto['approval'],
): ApplyReportV1Dto => {
  const projected = projectedExecutionResults(results);
  const counts = {
    succeeded: projected.filter(({ outcome }) => outcome === 'succeeded').length,
    failed: projected.filter(({ outcome }) => outcome === 'failed').length,
    cancelled: projected.filter(({ outcome }) => outcome === 'cancelled').length,
    rolledBack: projected.filter(({ outcome }) => outcome === 'rolled-back').length,
    skipped: projected.filter(({ outcome }) => outcome === 'skipped').length,
  };
  return {
    ...base,
    state: projected.every(({ outcome }) => outcome === 'succeeded') ? 'completed' : 'partial',
    approval,
    validation: { outcome: 'valid', replanned: false },
    results: projected,
    summary: { ...base.summary, ...counts },
  };
};

const refusedExecutionReport = (
  base: ApplyReportV1Dto,
  approval: ApplyReportV1Dto['approval'],
  validation: 'not-run' | 'valid' | 'stale',
): ApplyReportV1Dto => ({
  ...base,
  state: 'refused',
  approval,
  validation: { outcome: validation, replanned: false },
  results: [],
  summary: { ...base.summary, ...executionSummary() },
});

const executionExitClass = (
  results: readonly OperationExecutionResult[],
): CommandOutcome<ApplyApplicationReport>['exitClass'] =>
  results.some(({ outcome }) => outcome === 'cancelled')
    ? 'cancelled'
    : results.some(
          ({ outcome, error }) =>
            outcome === 'failed' &&
            (error.code === 'permission' ||
              error.code === 'permission-denied' ||
              error.code === 'EACCES' ||
              error.code === 'EPERM'),
        )
      ? 'permission'
      : results.some(({ outcome }) => outcome === 'failed' || outcome === 'rolled-back')
        ? 'failure'
        : 'success';

const executionDiagnostics = (
  results: readonly OperationExecutionResult[],
): readonly Diagnostic[] =>
  results.flatMap((result) =>
    result.outcome === 'failed'
      ? [
          {
            code: result.error.code,
            severity: 'error' as const,
            message: result.error.message,
            remediation: result.error.remediation,
          },
        ]
      : [],
  );

const executionMutation = (
  results: readonly OperationExecutionResult[],
): CommandOutcome<ApplyApplicationReport>['mutation'] =>
  results.length === 0
    ? NO_MUTATION
    : {
        kind: 'applied',
        planned: results.length,
        changed: results.filter(
          ({ actualBefore, actualAfter }) =>
            canonicalPlanningString(actualBefore) !== canonicalPlanningString(actualAfter),
        ).length,
        unchanged: results.filter(
          ({ outcome }) => outcome === 'skipped-after-failure' || outcome === 'cancelled',
        ).length,
        failed: results.filter(({ outcome }) => outcome === 'failed').length,
      };

const freshCheckDestinationRootFailure = async (
  plan: PlanV1Dto,
  ports: Pick<CurrentApplicationContext['ports'], 'pathKind'>,
  signal?: AbortSignal,
): Promise<
  | Readonly<{
      exitClass: CommandOutcome<ApplyApplicationReport>['exitClass'];
      diagnostic: Diagnostic;
      operation: PlanOperationV1Dto;
    }>
  | undefined
> => {
  const observedRoots = new Set<string>();
  for (const operation of plan.operations) {
    if (operation.after.kind !== 'placement') continue;
    const location = operation.after.resource.location;
    if (location.kind !== 'machine-bound') continue;
    const root = dirname(location.path);
    if (observedRoots.has(root)) continue;
    observedRoots.add(root);
    let kind: Awaited<ReturnType<CurrentApplicationContext['ports']['pathKind']>>;
    try {
      kind = await ports.pathKind(root);
    } catch (error) {
      const code = signal?.aborted ? 'cancelled' : safeErrorCode(error);
      const permissionDenied =
        code === 'permission' ||
        code === 'permission-denied' ||
        code === 'EACCES' ||
        code === 'EPERM';
      return {
        exitClass: code === 'cancelled' ? 'cancelled' : permissionDenied ? 'permission' : 'failure',
        diagnostic: {
          code:
            code === 'cancelled'
              ? 'apply-cancelled'
              : permissionDenied
                ? 'apply-placement-root-permission'
                : 'apply-placement-root-observation',
          severity: 'error',
          message:
            code === 'cancelled'
              ? 'apply was cancelled'
              : permissionDenied
                ? 'a planned placement root could not be inspected because permission was denied'
                : 'a planned placement root could not be inspected safely',
        },
        operation,
      };
    }
    if (kind === 'file') {
      return {
        exitClass: 'failure',
        diagnostic: {
          code: 'apply-placement-root-not-directory',
          severity: 'error',
          message: `the planned ${operation.tool ?? 'tool'}/${operation.scope ?? 'scope'} placement root is not a directory`,
          remediation: 'replace the conflicting filesystem node with a directory and retry',
        },
        operation,
      };
    }
  }
  return undefined;
};

/** Project completed scheduler results when only post-execution source cleanup failed. */
export const projectRetainedExecutionFailure = (
  report: ApplyReportV1Dto,
  approval: ApplyReportV1Dto['approval'],
  error: PlanReconcileError,
  remediation: string,
): CommandOutcome<ApplyApplicationReport> | null => {
  const results = (
    error as PlanReconcileError & {
      readonly results?: readonly OperationExecutionResult[];
    }
  ).results;
  if (results === undefined) return null;
  const completed = completedReport(report, results, approval);
  const diagnostic = {
    code: error.code,
    severity: 'error' as const,
    message: error.message,
    remediation,
  };
  const resultExitClass = executionExitClass(results);
  return outcome(
    appendApplyFailureDiagnostic(
      completed,
      diagnostic,
      null,
      diagnosticRefusalClass(error.exitClass),
    ),
    resultExitClass === 'success' ? error.exitClass : resultExitClass,
    [...executionDiagnostics(results), diagnostic],
    executionMutation(results),
  );
};

const preflight = (
  request: CurrentCommandRequest,
):
  | { readonly ok: true; readonly mode: ApplyModeV1 }
  | {
      readonly ok: false;
      readonly outcome: CommandOutcome<ApplyApplicationReport>;
    } => {
  if (request.arguments.length > 0) {
    return {
      ok: false,
      outcome: usageOutcome('apply-positional', 'apply does not accept positional arguments'),
    };
  }

  for (const { key, flag } of scalarOptions) {
    if (has(request.options, key)) {
      const value = request.options[key];
      if (typeof value !== 'string' || value.length === 0) {
        return {
          ok: false,
          outcome: usageOutcome(`apply-${key}-invalid`, `${flag} requires a non-empty value`),
        };
      }
    }
  }
  for (const { key, flag } of booleanOptions) {
    if (has(request.options, key) && typeof request.options[key] !== 'boolean') {
      return {
        ok: false,
        outcome: usageOutcome(`apply-${key}-invalid`, `${flag} does not accept a value`),
      };
    }
  }

  const rawTools = request.options.tool;
  const tools = rawTools === undefined ? [] : rawTools;
  if (
    !Array.isArray(tools) ||
    tools.some((tool) => typeof tool !== 'string' || tool.length === 0)
  ) {
    return {
      ok: false,
      outcome: usageOutcome('apply-tool-invalid', '--tool requires a non-empty tool name'),
    };
  }
  const toolNames = tools as readonly string[];
  if (new Set(toolNames).size !== toolNames.length) {
    return {
      ok: false,
      outcome: usageOutcome('apply-tool-duplicate', '--tool must not repeat the same tool'),
    };
  }
  const knownTools = new Set<string>(SUPPORTED_TOOLS);
  const unknownTool = toolNames.find((tool) => !knownTools.has(tool));
  if (unknownTool !== undefined) {
    return {
      ok: false,
      outcome: usageOutcome('apply-tool-unknown', `unknown tool '${unknownTool}'`),
    };
  }

  const explicitScope = request.options.scope;
  if (explicitScope !== undefined && explicitScope !== 'user' && explicitScope !== 'project') {
    return {
      ok: false,
      outcome: usageOutcome('apply-scope-invalid', `unknown scope '${explicitScope}'`),
    };
  }
  if (
    [
      explicitScope !== undefined,
      enabled(request.options, 'user'),
      enabled(request.options, 'project'),
    ].filter(Boolean).length > 1
  ) {
    return {
      ok: false,
      outcome: usageOutcome('apply-scope-conflict', 'scope forms are mutually exclusive'),
    };
  }
  if (request.options.lockfile !== undefined && request.options.file === undefined) {
    return {
      ok: false,
      outcome: usageOutcome('apply-lockfile-requires-file', '--lockfile requires --file'),
    };
  }

  const dryRun = enabled(request.options, 'dryRun');
  const check = enabled(request.options, 'check');
  const yes = enabled(request.options, 'yes');
  if (dryRun && check) {
    return {
      ok: false,
      outcome: usageOutcome('apply-mode-conflict', '--dry-run and --check are mutually exclusive'),
    };
  }
  if (yes && (dryRun || check)) {
    return {
      ok: false,
      outcome: usageOutcome(
        'apply-approval-nonmutating-conflict',
        '--yes cannot be combined with --dry-run or --check',
      ),
    };
  }

  if (request.options.plan !== undefined) {
    const conflicting = [
      ['file', '--file'],
      ['lockfile', '--lockfile'],
      ['tool', '--tool'],
      ['scope', '--scope'],
      ['user', '--user'],
      ['project', '--project'],
      ['locked', '--locked'],
      ['prune', '--prune'],
      ['yes', '--yes'],
      ['continueOnError', '--continue-on-error'],
    ] as const;
    const selected = conflicting
      .filter(([key]) =>
        key === 'tool'
          ? toolNames.length > 0
          : typeof request.options[key] === 'boolean'
            ? enabled(request.options, key)
            : request.options[key] !== undefined,
      )
      .map(([, flag]) => flag);
    if (selected.length > 0) {
      return {
        ok: false,
        outcome: usageOutcome(
          'apply-saved-option-conflict',
          `--plan cannot be combined with ${selected.join(', ')}`,
        ),
      };
    }
  }
  return { ok: true, mode: selectedMode(request) };
};

/** Thin apply boundary: fresh read-only modes share plan preparation; saved/execution follow. */
export const runApplyApplication: ApplicationService<
  CurrentCommandRequest,
  ApplyApplicationReport
> = async (request, context) => {
  const checked = preflight(request);
  if (!checked.ok) return checked.outcome;
  if (context.signal?.aborted) return cancellationOutcome();
  if (isSavedMode(checked.mode)) {
    const explicitConfigPath =
      context.globalOptions.config ?? context.configuration.explicitConfigPath;
    const resolvedProject =
      context.projectContext === undefined
        ? await resolveProjectContext(context.ports, {
            invocationCwd: context.invocationCwd,
            ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
            ...(explicitConfigPath === undefined ? {} : { explicitConfigPath }),
          })
        : { ok: true as const, value: context.projectContext };
    if (!resolvedProject.ok) {
      return preparationFailure({
        code: 'apply-saved-project-context',
        message: errorMessage(resolvedProject.error),
        exitClass: resolvedProject.error.code === 'permission-denied' ? 'permission' : 'state',
      });
    }
    const requestedPlanPath = request.options.plan as string;
    const planPath = resolve(resolvedProject.value.effectiveCwd, requestedPlanPath);
    const validated = await validateSavedReconcilePlan(
      { planPath },
      {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: resolvedProject.value,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
    );
    if (!validated.ok) return preparationFailure(validated.error);
    const report = savedReport(checked.mode, requestedPlanPath, validated.value);
    if (checked.mode === 'saved-execute') {
      const executed = await executeValidatedReconcilePlan(validated.value, {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: resolvedProject.value,
        artifactCoordinator: context.artifactCoordinator,
        observation: context.observation,
        continueOnError: false,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (!executed.ok) {
        const retained = projectRetainedExecutionFailure(
          report,
          { required: false, outcome: 'prior-authorization' },
          executed.error,
          'retry the reviewed plan so temporary source cleanup can complete',
        );
        if (retained !== null) return retained;
        return outcome(
          refusedExecutionReport(
            report,
            { required: false, outcome: 'prior-authorization' },
            executed.error.exitClass === 'state' ? 'stale' : 'valid',
          ),
          executed.error.exitClass,
          [
            {
              code: executed.error.code,
              severity: 'error',
              message: executed.error.message,
              remediation: 'resolve the reported state and retry the reviewed plan',
            },
          ],
        );
      }
      const completed = completedReport(report, executed.value, {
        required: false,
        outcome: 'prior-authorization',
      });
      return outcome(
        completed,
        executionExitClass(executed.value),
        executionDiagnostics(executed.value),
        executionMutation(executed.value),
      );
    }
    if (checked.mode === 'saved-check') {
      return outcome(report, report.operations.length > 0 ? 'drift' : 'success');
    }
    return outcome(report, 'success', [], {
      kind: 'preview',
      planned: report.operations.length,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
  }

  const file = request.options.file as string | undefined;
  const lockfile = request.options.lockfile as string | undefined;
  const tools = (request.options.tool ?? []) as readonly SupportedTool[];
  const explicitConfigPath =
    context.globalOptions.config ?? context.configuration.explicitConfigPath;
  const prepared = await prepareReconcilePlan(
    {
      ...(file === undefined ? {} : { file }),
      ...(lockfile === undefined ? {} : { lockfile }),
      tools,
      scope: selectedScope(request),
      locked: enabled(request.options, 'locked'),
      prune: enabled(request.options, 'prune'),
      check: checked.mode === 'fresh-check',
    },
    {
      ports: context.ports,
      configuration: context.configuration,
      invocationCwd: context.invocationCwd,
      ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
      ...(explicitConfigPath === undefined ? {} : { explicitConfigPath }),
      ...(context.projectContext === undefined ? {} : { projectContext: context.projectContext }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
  );
  if (!prepared.ok) return preparationFailure(prepared.error);
  const plan = projectPlanReport(
    prepared.value.product,
    prepared.value.projection,
    null,
    prepared.value.artifactSelectionSource,
  );
  const refusals = plan.diagnostics.filter(
    (diagnostic): diagnostic is typeof diagnostic & ReconcileRefusal =>
      diagnostic.kind === 'refuse' && diagnostic.refusalClass !== null,
  );
  const report = freshReport(checked.mode, plan, enabled(request.options, 'continueOnError'));
  if (refusals.length > 0) {
    return outcome(
      report,
      refusalExitClass(refusals),
      refusals.map(({ reason }) => ({
        code: reason.code,
        severity: 'error',
        message: reason.message,
      })),
    );
  }
  if (checked.mode === 'fresh-check') {
    const rootFailure = await freshCheckDestinationRootFailure(plan, context.ports, context.signal);
    if (rootFailure !== undefined) {
      return outcome(
        appendApplyFailureDiagnostic(
          { ...report, state: 'refused' },
          rootFailure.diagnostic,
          rootFailure.operation,
          diagnosticRefusalClass(rootFailure.exitClass),
        ),
        rootFailure.exitClass,
        [rootFailure.diagnostic],
      );
    }
    return outcome(report, plan.summary.drift > 0 ? 'drift' : 'success');
  }
  if (checked.mode === 'fresh-dry-run') {
    return outcome(report, 'success', [], {
      kind: 'preview',
      planned: plan.operations.length,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
  }
  if (plan.operations.length === 0) return outcome(report, 'success');

  const projectContext = prepared.value.observation.resolved.observed.project;
  const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
    ports: context.ports,
    configuration: context.configuration,
    projectContext,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (!validated.ok) {
    return outcome(
      refusedExecutionReport(report, { required: false, outcome: 'not-required' }, 'stale'),
      validated.error.exitClass,
      [
        {
          code: validated.error.code,
          severity: 'error',
          message: validated.error.message,
          remediation: 'regenerate and review a new plan',
        },
      ],
    );
  }
  const executionPlan = createFreshReconcileExecutionPlanV1(
    validated.value.plan,
    enabled(request.options, 'continueOnError'),
  );
  if (!executionPlan.ok) {
    return outcome(
      refusedExecutionReport(report, { required: false, outcome: 'not-required' }, 'stale'),
      'state',
      [
        {
          code: executionPlan.error.code,
          severity: 'error',
          message: executionPlan.error.message,
          remediation: 'regenerate and review a new plan',
        },
      ],
    );
  }
  const executionValidated = Object.freeze({
    ...validated.value,
    plan: executionPlan.value,
  });

  const approval = await context.interaction.confirm({
    id: 'skillsmith.apply.confirm',
    message: `Apply ${plan.operations.length} reviewed operation${plan.operations.length === 1 ? '' : 's'}?`,
    preview: {
      kind: 'exact-operation-preview',
      command: 'apply',
      operationIds: executionPlan.value.operations.map(({ operationId }) => operationId),
    },
  });
  if (approval.status === 'cancelled') {
    return outcome(
      refusedExecutionReport(report, { required: true, outcome: 'cancelled' }, 'valid'),
      'cancelled',
      [{ code: 'apply-cancelled', severity: 'error', message: 'apply was cancelled' }],
    );
  }
  if (approval.status === 'refused' || !approval.value) {
    const reason = approval.status === 'refused' ? approval.reason : 'approval was not granted';
    return outcome(
      refusedExecutionReport(report, { required: true, outcome: 'refused' }, 'valid'),
      'usage',
      [
        {
          code: 'apply-approval-required',
          severity: 'error',
          message: `apply requires approval or confirmation: ${reason}`,
        },
      ],
    );
  }

  const executed = await executeValidatedReconcilePlan(executionValidated, {
    ports: context.ports,
    configuration: context.configuration,
    projectContext,
    artifactCoordinator: context.artifactCoordinator,
    observation: context.observation,
    continueOnError: enabled(request.options, 'continueOnError'),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (!executed.ok) {
    const retained = projectRetainedExecutionFailure(
      report,
      { required: true, outcome: 'approved' },
      executed.error,
      'retry the reviewed selection so temporary source cleanup can complete',
    );
    if (retained !== null) return retained;
    return outcome(
      refusedExecutionReport(
        report,
        { required: true, outcome: 'approved' },
        executed.error.exitClass === 'state' ? 'stale' : 'valid',
      ),
      executed.error.exitClass,
      [
        {
          code: executed.error.code,
          severity: 'error',
          message: executed.error.message,
          remediation: 'resolve the reported state and retry the reviewed selection',
        },
      ],
    );
  }
  const completed = completedReport(report, executed.value, {
    required: true,
    outcome: 'approved',
  });
  return outcome(
    completed,
    executionExitClass(executed.value),
    executionDiagnostics(executed.value),
    executionMutation(executed.value),
  );
};
