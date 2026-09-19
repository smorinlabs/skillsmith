import { toolRegistry } from '../agents/registry.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import { type UndoReportV1Dto, toUndoV1Dto } from '../contracts/v1/undo.ts';
import type { OperationExecutionResult } from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { validateSelectionRequest } from '../selection/resolve.ts';
import type { SelectionPolicy } from '../selection/types.ts';
import { prepareUndo } from '../undo/execute.ts';
import { createUndoReport } from '../undo/plan.ts';
import type {
  PreparedUndoPlan,
  UndoError,
  UndoReport,
  UndoRequest,
  UndoTool,
} from '../undo/types.ts';
import type {
  ApplicationService,
  CommandOutcome,
  CurrentApplicationContext,
  CurrentCommandRequest,
  Diagnostic,
  MutationSummary,
} from './types.ts';
import { NO_MUTATION } from './types.ts';

export interface UndoApplicationReport {
  readonly result: UndoReportV1Dto | null;
}

export interface UndoApplicationDependencies {
  readonly resolveContext: typeof resolveProjectContext;
  readonly prepare: typeof prepareUndo;
}

const DEFAULT_DEPENDENCIES: UndoApplicationDependencies = Object.freeze({
  resolveContext: resolveProjectContext,
  prepare: prepareUndo,
});

const EMPTY_REPORT: UndoApplicationReport = Object.freeze({ result: null });
const UNDO_TOOLS = Object.freeze([...toolRegistry.toolsFor('undo')]) as readonly UndoTool[];

const refusal = (
  exitClass: UndoError['exitClass'],
  code: string,
  message: string,
  report: UndoApplicationReport = EMPTY_REPORT,
): CommandOutcome<UndoApplicationReport> => ({
  report,
  diagnostics: [{ code, severity: 'error', message }],
  exitClass,
  mutation: NO_MUTATION,
  deprecations: [],
});

const strings = (value: unknown): readonly string[] | null => {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.every((item) => typeof item === 'string' && item.trim().length > 0)
    ? (values as readonly string[])
    : null;
};

const targets = (request: CurrentCommandRequest): readonly string[] | null =>
  request.arguments.length === 1 && Array.isArray(request.arguments[0])
    ? strings(request.arguments[0])
    : strings(request.arguments);

const bool = (
  options: Readonly<Record<string, unknown>>,
  name: string,
  fallback = false,
): boolean | null => {
  const value = options[name];
  return value === undefined ? fallback : typeof value === 'boolean' ? value : null;
};

const normalizeScope = (
  options: Readonly<Record<string, unknown>>,
): Result<readonly ('user' | 'project')[], UndoError> => {
  const raw = options.scope;
  const scopes = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (scopes.length > 1 || scopes.some((scope) => scope !== 'user' && scope !== 'project')) {
    return err({
      code: 'undo-scope',
      message: scopes.length > 1 ? '--scope may be provided only once' : 'unknown undo scope',
      exitClass: 'usage',
    });
  }
  const user = bool(options, 'user');
  const project = bool(options, 'project');
  if (user === null || project === null) {
    return err({
      code: 'undo-scope',
      message: 'scope shorthands must be boolean',
      exitClass: 'usage',
    });
  }
  if (user && project) {
    return err({
      code: 'undo-scope',
      message: '--user conflicts with --project',
      exitClass: 'usage',
    });
  }
  const shorthand = user ? 'user' : project ? 'project' : null;
  const explicit = scopes[0] as 'user' | 'project' | undefined;
  if (explicit !== undefined && shorthand !== null && explicit !== shorthand) {
    return err({
      code: 'undo-scope',
      message: `--scope ${explicit} conflicts with --${shorthand}`,
      exitClass: 'usage',
    });
  }
  return ok(
    Object.freeze(explicit !== undefined ? [explicit] : shorthand === null ? [] : [shorthand]),
  );
};

interface NormalizedUndo {
  readonly request: UndoRequest;
  readonly tools: readonly string[];
  readonly scopes: readonly ('user' | 'project')[];
  readonly json: boolean;
  readonly prompt: boolean;
}

const normalize = (request: CurrentCommandRequest): Result<NormalizedUndo, UndoError> => {
  const selectedTargets = targets(request);
  const selectedTools = strings(request.options.tool ?? request.options.tools);
  if (selectedTargets === null) {
    return err({
      code: 'undo-target',
      message: 'undo targets must be non-empty strings',
      exitClass: 'usage',
    });
  }
  if (selectedTools === null) {
    return err({
      code: 'undo-tool',
      message: '--tool requires non-empty values',
      exitClass: 'usage',
    });
  }
  const scope = normalizeScope(request.options);
  if (!scope.ok) return scope;
  const names = ['all', 'dryRun', 'yes', 'continueOnError', 'json', 'prompt'] as const;
  const values = Object.fromEntries(
    names.map((name) => [name, bool(request.options, name, name === 'prompt')]),
  ) as Record<(typeof names)[number], boolean | null>;
  const invalid = names.find((name) => values[name] === null);
  if (invalid !== undefined) {
    return err({
      code: `undo-${invalid}`,
      message: `--${invalid} must be boolean`,
      exitClass: 'usage',
    });
  }
  const all = values.all as boolean;
  const dryRun = values.dryRun as boolean;
  const yes = values.yes as boolean;
  if (all && selectedTargets.length > 0) {
    return err({
      code: 'undo-selection',
      message: '--all conflicts with targets',
      exitClass: 'usage',
    });
  }
  if (!all && selectedTargets.length === 0) {
    return err({
      code: 'undo-selection',
      message: 'undo requires targets or --all',
      exitClass: 'usage',
    });
  }
  if (dryRun && yes) {
    return err({
      code: 'undo-mode',
      message: '--dry-run conflicts with --yes',
      exitClass: 'usage',
    });
  }
  return ok({
    request: Object.freeze({
      targets: Object.freeze([...selectedTargets]),
      all,
      tools: Object.freeze([...selectedTools]) as readonly UndoTool[],
      scopes: scope.value,
      dryRun,
      yes,
      continueOnError: values.continueOnError as boolean,
    }),
    tools: selectedTools,
    scopes: scope.value,
    json: values.json as boolean,
    prompt: values.prompt as boolean,
  });
};

const projectFor = async (
  context: CurrentApplicationContext,
  dependencies: UndoApplicationDependencies,
): Promise<Result<ProjectContext, UndoError>> => {
  if (context.projectContext !== undefined) return ok(context.projectContext);
  const resolved = await dependencies.resolveContext(context.ports, {
    invocationCwd: context.invocationCwd,
    ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
    ...(context.globalOptions.config === undefined
      ? {}
      : { explicitConfigPath: context.globalOptions.config }),
  });
  return resolved.ok
    ? resolved
    : err({
        code: `undo-${resolved.error.code}`,
        message:
          'message' in resolved.error
            ? resolved.error.message
            : `unknown tool '${resolved.error.tool}'`,
        exitClass: resolved.error.code === 'permission-denied' ? 'permission' : 'usage',
      });
};

const diagnosticsForResults = (
  results: readonly OperationExecutionResult[],
): readonly Diagnostic[] =>
  results.flatMap((result) =>
    result.error === null
      ? []
      : [{ code: result.error.code, severity: 'error' as const, message: result.error.message }],
  );

const mutationFor = (
  report: UndoReport,
  results: readonly OperationExecutionResult[],
): MutationSummary => ({
  kind: report.mode === 'dry-run' ? 'preview' : 'applied',
  planned: report.operations.length,
  changed: results.filter(({ outcome }) => outcome === 'succeeded' || outcome === 'rolled-back')
    .length,
  unchanged:
    report.groups
      .flatMap(({ pairs }) => pairs)
      .filter(({ outcome }) => outcome === 'already-reversed').length +
    results.filter(({ outcome }) => outcome === 'skipped-after-failure').length,
  failed: results.filter(({ outcome }) => outcome === 'failed' || outcome === 'cancelled').length,
});

const outcome = (
  report: UndoReport,
  results: readonly OperationExecutionResult[],
  diagnostics: readonly Diagnostic[] = diagnosticsForResults(results),
): CommandOutcome<UndoApplicationReport> => ({
  report: { result: toUndoV1Dto(report) },
  diagnostics,
  exitClass: results.some(({ outcome }) => outcome === 'cancelled')
    ? 'cancelled'
    : results.some(({ error }) => error?.code === 'permission-denied')
      ? 'permission'
      : results.some(({ error }) =>
            ['unknown-tool', 'tool-unavailable'].includes(error?.code ?? ''),
          )
        ? 'capability'
        : results.some(({ error }) =>
              [
                'flip-refused',
                'ledger-error',
                'precondition-state-changed',
                'precondition-observation-failed',
              ].includes(error?.code ?? ''),
            )
          ? 'state'
          : results.some(({ outcome }) => outcome === 'failed')
            ? 'failure'
            : 'success',
  mutation: mutationFor(report, results),
  deprecations: [],
});

const approvalRefusal = (
  prepared: PreparedUndoPlan,
  status: 'refused' | 'cancelled',
  message: string,
): CommandOutcome<UndoApplicationReport> => {
  const report = createUndoReport(
    prepared.observation,
    prepared.plan,
    prepared.groups,
    'execute',
    { required: true, outcome: status },
    [],
  );
  return refusal(
    status === 'cancelled' ? 'cancelled' : 'usage',
    `undo-approval-${status}`,
    message,
    {
      result: toUndoV1Dto(report),
    },
  );
};

interface UndoCleanupApprovalMarker {
  readonly groupId: string;
  readonly pairId: string;
  readonly activeTransactionId: string;
}

const cleanupApprovalMarkers = (prepared: PreparedUndoPlan): readonly UndoCleanupApprovalMarker[] =>
  prepared.groups.flatMap((group) =>
    group.pairs.flatMap((pair) =>
      prepared.plan.diagnostics.some(
        (diagnostic) =>
          diagnostic.reason.code === 'undo-cleanup-pending' &&
          diagnostic.correlation.groupId === group.groupId &&
          diagnostic.correlation.pairId === pair.pairId &&
          diagnostic.correlation.operationId === null,
      )
        ? [
            {
              groupId: group.groupId,
              pairId: pair.pairId,
              activeTransactionId: pair.activeTransactionId,
            },
          ]
        : [],
    ),
  );

export const createUndoApplicationService = (
  overrides: Partial<UndoApplicationDependencies> = {},
): ApplicationService<CurrentCommandRequest, UndoApplicationReport> => {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return async (rawRequest, context) => {
    const normalized = normalize(rawRequest);
    if (!normalized.ok) {
      return refusal(normalized.error.exitClass, normalized.error.code, normalized.error.message);
    }
    const policy: SelectionPolicy<UndoTool> = {
      requiresSelection: true,
      allowBoundedDefault: false,
      allowAbsentCreate: false,
      allowedTools: UNDO_TOOLS,
      allowedScopes: ['user', 'project'],
      allowedCapabilities: ['undo'],
    };
    const selection = validateSelectionRequest(
      {
        targets: normalized.value.request.targets,
        all: normalized.value.request.all,
        tools: normalized.value.tools,
        scopes: normalized.value.scopes,
        capability: 'undo',
      },
      policy,
      { ids: policy.allowedTools },
    );
    if (!selection.ok) {
      return refusal(
        selection.error.code === 'capability' ? 'capability' : 'usage',
        `undo-${selection.error.code}`,
        selection.error.message,
      );
    }
    const project = await projectFor(context, dependencies);
    if (!project.ok)
      return refusal(project.error.exitClass, project.error.code, project.error.message);
    const prepared = await dependencies.prepare(normalized.value.request, selection.value, {
      ports: context.ports,
      artifactCoordinator: context.artifactCoordinator,
      projectContext: project.value,
      configuration: context.configuration,
      observation: context.observation,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    if (!prepared.ok) {
      return refusal(prepared.error.exitClass, prepared.error.code, prepared.error.message);
    }
    if (normalized.value.request.dryRun) {
      return outcome(
        createUndoReport(
          prepared.value.observation,
          prepared.value.plan,
          prepared.value.groups,
          'dry-run',
          { required: false, outcome: 'not-required' },
          [],
        ),
        [],
      );
    }
    const cleanupPending = cleanupApprovalMarkers(prepared.value);
    const changing = prepared.value.plan.operations.length > 0 || cleanupPending.length > 0;
    if (!changing) {
      return outcome(
        createUndoReport(
          prepared.value.observation,
          prepared.value.plan,
          prepared.value.groups,
          'execute',
          { required: false, outcome: 'not-required' },
          [],
        ),
        [],
      );
    }
    if (!normalized.value.request.yes) {
      if (
        normalized.value.json ||
        !normalized.value.prompt ||
        context.interaction.mode === 'noninteractive'
      ) {
        return refusal(
          'usage',
          'undo-approval-required',
          'changing undo execution requires --yes in JSON or noninteractive mode',
        );
      }
      const approved = await context.interaction.confirm({
        id: 'undo.approval',
        message:
          cleanupPending.length === 0
            ? `Confirm undo of ${prepared.value.groups.length} groups (${prepared.value.plan.operations.length} operations)?`
            : `Confirm undo of ${prepared.value.groups.length} groups (${prepared.value.plan.operations.length} operations, ${cleanupPending.length} cleanup-pending pairs)?`,
        preview: {
          kind: 'exact-undo-preview',
          command: 'undo',
          groupIds: prepared.value.groups.map(({ groupId }) => groupId),
          operationIds: prepared.value.plan.operations.map(({ operationId }) => operationId),
          ...(cleanupPending.length === 0 ? {} : { cleanupPending }),
        },
      });
      if (approved.status === 'cancelled') {
        return approvalRefusal(prepared.value, 'cancelled', 'undo confirmation was cancelled');
      }
      if (approved.status === 'refused' || !approved.value) {
        return approvalRefusal(
          prepared.value,
          'refused',
          approved.status === 'refused'
            ? `undo confirmation was refused: ${approved.reason}`
            : 'undo was not approved',
        );
      }
    }
    const executed = await prepared.value.execute();
    if (!executed.ok) {
      return refusal(executed.error.exitClass, executed.error.code, executed.error.message);
    }
    return outcome(
      createUndoReport(
        prepared.value.observation,
        prepared.value.plan,
        prepared.value.groups,
        'execute',
        { required: true, outcome: 'approved' },
        executed.value.results,
      ),
      executed.value.results,
      [
        ...diagnosticsForResults(executed.value.results),
        ...executed.value.warnings.map((warning) => ({
          code: warning.code,
          severity: 'warning' as const,
          message: warning.message,
        })),
      ],
    );
  };
};

export const runUndoApplication = createUndoApplicationService();
