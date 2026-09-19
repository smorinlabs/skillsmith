import { toolRegistry } from '../agents/registry.ts';
import type { BuiltInToolId } from '../agents/registry.ts';
import { resolveProjectContext } from '../context/project.ts';
import type {
  PlanCheckV1Dto,
  PlanDiagnosticV1Dto,
  PlanOperationV1Dto,
} from '../contracts/v1/plan.ts';
import type {
  UpdateCandidateV1Dto,
  UpdateEffectV1Dto,
  UpdateGroupResultV1Dto,
  UpdateReportV1Dto,
  UpdateSummaryV1Dto,
} from '../contracts/v1/update.ts';
import { updateV1Codec } from '../contracts/v1/update.ts';
import { safeErrorCode } from '../errors.ts';
import type { SkillSmithError } from '../errors.ts';
import { createOperationGroupId } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  OperationDigest,
  OperationExecutionResult,
  OperationPlan,
} from '../planning/types.ts';
import { validateSavedReconcilePlanValue } from '../reconcile/index.ts';
import type { ValidatedSavedReconcilePlanValue } from '../reconcile/index.ts';
import { prepareUpdateArtifactsV1 } from '../update/artifacts.ts';
import type { PreparedUpdateArtifactsV1 } from '../update/artifacts.ts';
import { selectUpdateDeclarationsV1 } from '../update/candidates.ts';
import { executePreparedUpdatePlanV1 } from '../update/execute.ts';
import { prepareUpdateObservationV1 } from '../update/observe.ts';
import type { PreparedUpdateObservationV1, UpdateObservedSelectionV1 } from '../update/observe.ts';
import { createUpdateExecutionPlanV1, prepareUpdatePlanBaseV1 } from '../update/plan.ts';
import type { PreparedUpdateExecutionPlanV1, PreparedUpdatePlanBaseV1 } from '../update/plan.ts';
import type {
  UpdateApplicationRequestV1,
  UpdateRemoteRefInspectionV1,
  UpdateSelectionV1,
} from '../update/types.ts';
import { verifyUpdateCandidate } from '../update/verify.ts';
import type { UpdateVerificationOutcome } from '../update/verify.ts';
import { exitClassForApplicationError } from './exit-policy.ts';
import type {
  ApplicationService,
  CommandExitClass,
  CommandOutcome,
  CurrentApplicationContext,
  CurrentCommandRequest,
  MutationSummary,
} from './types.ts';
import { NO_MUTATION } from './types.ts';

export interface UpdateApplicationReport {
  readonly result: UpdateReportV1Dto | null;
}

const EMPTY_REPORT: UpdateApplicationReport = Object.freeze({ result: null });

const refusal = (
  exitClass: CommandExitClass,
  code: string,
  message: string,
): CommandOutcome<UpdateApplicationReport> => ({
  report: EMPTY_REPORT,
  diagnostics: [{ code, severity: 'error', message }],
  exitClass,
  mutation: NO_MUTATION,
  deprecations: [],
});

const skillSmithErrorMessage = (error: SkillSmithError): string =>
  error.code === 'unknown-tool' ? `unknown tool: ${error.tool}` : error.message;

const domainFailure = (
  error: SkillSmithError,
  signal?: AbortSignal,
): CommandOutcome<UpdateApplicationReport> =>
  refusal(
    exitClassForApplicationError(error, signal),
    `update-${error.code}`,
    skillSmithErrorMessage(error),
  );

const stringArray = (value: unknown): readonly string[] | null => {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.every((item) => typeof item === 'string' && item.length > 0)
    ? (values as readonly string[])
    : null;
};

const positionals = (request: CurrentCommandRequest): readonly string[] | null => {
  if (request.arguments.length === 1 && Array.isArray(request.arguments[0])) {
    return stringArray(request.arguments[0]);
  }
  return stringArray(request.arguments);
};

const bool = (options: Readonly<Record<string, unknown>>, key: string): boolean | null => {
  const value = options[key];
  return value === undefined ? false : typeof value === 'boolean' ? value : null;
};

const scalar = (
  options: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined => {
  const value = options[key];
  return value === undefined
    ? null
    : typeof value === 'string' && value.length > 0
      ? value
      : undefined;
};

const normalize = (
  request: CurrentCommandRequest,
):
  | { readonly ok: true; readonly value: UpdateApplicationRequestV1 }
  | { readonly ok: false; readonly message: string } => {
  const targets = positionals(request);
  if (targets === null) return { ok: false, message: 'update targets must be non-empty strings' };
  const tools = stringArray(request.options.tool);
  if (tools === null) return { ok: false, message: '--tool requires non-empty values' };
  const file = scalar(request.options, 'file');
  const lockfile = scalar(request.options, 'lockfile');
  const ref = scalar(request.options, 'ref');
  if (file === undefined) return { ok: false, message: '--file requires one non-empty path' };
  if (lockfile === undefined)
    return { ok: false, message: '--lockfile requires one non-empty path' };
  if (ref === undefined) return { ok: false, message: '--ref requires one non-empty Git ref' };
  const names = ['all', 'check', 'dryRun', 'pin', 'strict', 'yes', 'continueOnError'] as const;
  const values = Object.fromEntries(
    names.map((name) => [name, bool(request.options, name)]),
  ) as Record<(typeof names)[number], boolean | null>;
  const invalid = names.find((name) => values[name] === null);
  if (invalid !== undefined) return { ok: false, message: `--${invalid} must be boolean` };
  const all = values.all as boolean;
  const check = values.check as boolean;
  const dryRun = values.dryRun as boolean;
  const yes = values.yes as boolean;
  if (all && targets.length > 0) return { ok: false, message: '--all conflicts with targets' };
  if (!check && targets.length === 0 && !all)
    return { ok: false, message: 'update mutation and dry-run require targets or --all' };
  if (check && dryRun) return { ok: false, message: '--check conflicts with --dry-run' };
  if (check && yes) return { ok: false, message: '--check conflicts with --yes' };
  if (dryRun && yes) return { ok: false, message: '--dry-run conflicts with --yes' };
  if (lockfile !== null && file === null)
    return { ok: false, message: '--lockfile requires --file' };
  if (ref !== null && (targets.length !== 1 || all))
    return { ok: false, message: '--ref requires exactly one declaration target' };
  if (ref !== null && targets.some((target) => target.includes('*') || target.includes('?')))
    return { ok: false, message: '--ref requires an exact declaration target' };
  return {
    ok: true,
    value: Object.freeze({
      targets: Object.freeze([...targets]),
      all,
      file,
      lockfile,
      tools: Object.freeze([...tools]),
      check,
      dryRun,
      ref,
      pin: values.pin as boolean,
      strict: values.strict as boolean,
      yes,
      continueOnError: values.continueOnError as boolean,
    }),
  };
};

type VerificationByPair = ReadonlyMap<string, UpdateVerificationOutcome<BuiltInToolId>>;

const verificationKey = (skill: string, tool: string): string => `${skill}\0${tool}`;

const groupIdFor = (prepared: UpdateObservedSelectionV1, plan: OperationPlan<'update'>): string => {
  const planned = plan.operations.find(
    (operation) => operation.skill === prepared.selected.declaration.name,
  );
  if (planned !== undefined) return planned.groupId;
  const source =
    prepared.source?.source ??
    ({
      kind: 'portable',
      identity: prepared.selected.declaration.source,
      requestedRef: prepared.currentLock.requestedRef,
      resolvedSha: prepared.currentLock.resolvedSha,
      sourcePath: prepared.currentLock.sourcePath,
      contentHash: prepared.currentLock.contentHash as OperationDigest,
    } as const);
  return createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'update',
    skill: prepared.selected.declaration.name,
    source,
    scope: prepared.selected.declaration.scope,
    target: null,
  });
};

const operationsFor = (
  plan: OperationPlan<'update'>,
  prepared: UpdateObservedSelectionV1,
): readonly OperationPlan<'update'>['operations'][number][] => {
  const groupId = groupIdFor(prepared, plan);
  return plan.operations.filter((operation) => operation.groupId === groupId);
};

const candidateDto = (
  prepared: UpdateObservedSelectionV1,
  plan: OperationPlan<'update'>,
): UpdateCandidateV1Dto => {
  const hasOperations = operationsFor(plan, prepared).length > 0;
  const skipped = prepared.candidate.outcome === 'skipped-fixed';
  const failed = prepared.candidate.outcome === 'failed';
  const outcome: UpdateCandidateV1Dto['outcome'] = failed
    ? 'failed'
    : skipped
      ? 'skipped-fixed'
      : prepared.candidate.outcome === 'available' || hasOperations
        ? 'available'
        : 'current';
  return Object.freeze({
    groupId: groupIdFor(prepared, plan),
    skill: prepared.selected.declaration.name,
    current: Object.freeze({
      requestedRef: prepared.selected.declaration.ref,
      kind: prepared.currentInspection.kind,
      resolvedSha: prepared.currentLock.resolvedSha,
      contentHash: prepared.currentLock.contentHash,
    }),
    proposed:
      skipped || failed
        ? null
        : Object.freeze({
            requestedRef: prepared.candidate.proposedRequestedRef,
            kind: prepared.proposedInspection.kind,
            resolvedSha: prepared.proposedInspection.resolvedSha,
            contentHash: prepared.candidate.contentHash as string,
          }),
    transition: prepared.candidate.transition,
    outcome,
    failure: prepared.failure,
  });
};

const verificationRows = (
  prepared: UpdateObservedSelectionV1,
  verification: VerificationByPair,
  pending: boolean,
): UpdateGroupResultV1Dto['verification'] =>
  Object.freeze(
    prepared.selected.tools.map((tool) => {
      const observed = verification.get(verificationKey(prepared.selected.declaration.name, tool));
      const mode = toolRegistry.get(tool)?.verification?.gatePolicy.update ?? 'static';
      return Object.freeze({
        tool,
        mode,
        gate:
          prepared.candidate.outcome === 'skipped-fixed' || prepared.candidate.outcome === 'failed'
            ? 'skipped'
            : pending
              ? 'pending'
              : (observed?.gate ?? 'inconclusive'),
      });
    }),
  );

const resultFor = (
  operationId: string,
  results: readonly OperationExecutionResult[],
): OperationExecutionResult | undefined =>
  results.find((result) => result.operationId === operationId);

const groupDto = (
  prepared: UpdateObservedSelectionV1,
  candidate: UpdateCandidateV1Dto,
  plan: OperationPlan<'update'>,
  mode: UpdateReportV1Dto['mode'],
  verification: VerificationByPair,
  results: readonly OperationExecutionResult[],
  approvalTerminal: boolean,
): UpdateGroupResultV1Dto => {
  const operations = operationsFor(plan, prepared);
  const operationResults = operations
    .map(({ operationId }) => resultFor(operationId, results))
    .filter((result): result is OperationExecutionResult => result !== undefined);
  const blocked = prepared.selected.tools.some(
    (tool) => verification.get(verificationKey(prepared.selected.declaration.name, tool))?.blocked,
  );
  const failed =
    candidate.outcome === 'failed' ||
    blocked ||
    operationResults.some(({ outcome }) => outcome === 'failed' || outcome === 'rolled-back');
  const executionFailure = operationResults.find(({ outcome }) => outcome === 'failed');
  const cancelled = operationResults.some(({ outcome }) => outcome === 'cancelled');
  const skipped = candidate.outcome === 'skipped-fixed';
  const action: UpdateGroupResultV1Dto['action'] = skipped
    ? 'skip'
    : candidate.outcome === 'failed'
      ? 'refuse'
      : candidate.outcome === 'available'
        ? 'update'
        : 'noop';
  const outcome: UpdateGroupResultV1Dto['outcome'] = failed
    ? 'failed'
    : cancelled
      ? 'cancelled'
      : skipped
        ? 'skipped'
        : mode !== 'execute' || !approvalTerminal
          ? action === 'update'
            ? 'planned'
            : 'succeeded'
          : operationResults.some(({ outcome }) => outcome === 'skipped-after-failure')
            ? 'not-run'
            : 'succeeded';
  const artifactDrift = operations.some(
    ({ kind }) => kind === 'write-manifest' || kind === 'write-lock',
  );
  const liveDrift = operations.some(({ mutates }) => mutates.live);
  const converged = mode === 'execute' && outcome === 'succeeded';
  return Object.freeze({
    groupId: candidate.groupId,
    skill: candidate.skill,
    tools: Object.freeze([...prepared.selected.tools]),
    verification: verificationRows(prepared, verification, !approvalTerminal && mode === 'execute'),
    action,
    outcome,
    skipReason: skipped ? prepared.candidate.reason : null,
    failure: failed
      ? {
          code:
            prepared.failure?.code ??
            executionFailure?.error?.code ??
            (blocked ? 'update-verification-blocked' : 'update-execution-failed'),
          message:
            prepared.failure?.message ??
            executionFailure?.error?.message ??
            (blocked
              ? 'one or more selected verification gates blocked this group'
              : 'one or more selected update operations failed'),
        }
      : null,
    drift: {
      artifact: artifactDrift && !converged,
      live: liveDrift && !converged,
    },
  });
};

const planOperations = (plan: OperationPlan<'update'>): readonly PlanOperationV1Dto[] =>
  Object.freeze(
    plan.operations.map(({ dependencyMetadata, ...operation }) => {
      const publicImage = <Image extends typeof operation.before>(image: Image): Image =>
        (image.kind === 'placement' && image.source?.kind === 'local-dev'
          ? { ...image, source: null }
          : image) as Image;
      return Object.freeze({
        ...operation,
        before: publicImage(operation.before),
        after: publicImage(operation.after),
        dependsOn: Object.freeze([...dependencyMetadata.operationIds]),
        preconditionIds: Object.freeze([...operation.preconditionIds]),
        requiredCheckIds: Object.freeze([...operation.requiredCheckIds]),
        reversibility: Object.freeze({
          ...operation.reversibility,
          retentionResourceIds: Object.freeze([...operation.reversibility.retentionResourceIds]),
        }),
      } as PlanOperationV1Dto);
    }),
  );

const planChecks = (plan: OperationPlan<'update'>): readonly PlanCheckV1Dto[] =>
  Object.freeze(
    plan.checks.map((check) =>
      Object.freeze({
        ...check,
        operationIds: Object.freeze([...check.operationIds]),
        ...('preconditionIds' in check
          ? { preconditionIds: Object.freeze([...check.preconditionIds]) }
          : {}),
      } as PlanCheckV1Dto),
    ),
  );

const planDiagnostics = (plan: OperationPlan<'update'>): readonly PlanDiagnosticV1Dto[] =>
  Object.freeze(
    plan.diagnostics.map((diagnostic) =>
      Object.freeze({
        ...diagnostic,
        affected: Object.freeze({
          ...diagnostic.affected,
          source:
            diagnostic.affected.source?.kind === 'local-dev' ? null : diagnostic.affected.source,
        }),
        correlation: Object.freeze({ ...diagnostic.correlation }),
        reason: Object.freeze({ ...diagnostic.reason }),
      } as PlanDiagnosticV1Dto),
    ),
  );

const effectsFor = (
  plan: OperationPlan<'update'>,
  mode: UpdateReportV1Dto['mode'],
  results: readonly OperationExecutionResult[],
  approvalTerminal: boolean,
): readonly UpdateEffectV1Dto[] => {
  const effects: UpdateEffectV1Dto[] = [];
  for (const operation of plan.operations) {
    const execution = resultFor(operation.operationId, results)?.outcome;
    const outcome: UpdateEffectV1Dto['outcome'] =
      mode !== 'execute' || !approvalTerminal
        ? 'planned'
        : execution === 'succeeded'
          ? 'succeeded'
          : execution === 'cancelled'
            ? 'cancelled'
            : execution === 'failed' || execution === 'rolled-back'
              ? 'failed'
              : 'not-run';
    const roles: UpdateEffectV1Dto['role'][] = [];
    if (operation.mutates.manifest) roles.push('manifest');
    if (operation.mutates.lock) roles.push('lock');
    if (operation.mutates.live) roles.push('store', 'live');
    if (operation.mutates.ledger) roles.push('ledger');
    if (operation.conflict?.backup === 'required') roles.push('backup');
    for (const role of roles) {
      effects.push({
        role,
        action: operation.kind,
        operationId: operation.operationId,
        groupId: operation.groupId,
        outcome,
      });
    }
  }
  return Object.freeze(effects);
};

const summaryFor = (
  candidates: readonly UpdateCandidateV1Dto[],
  groups: readonly UpdateGroupResultV1Dto[],
  effects: readonly UpdateEffectV1Dto[],
  diagnostics: readonly PlanDiagnosticV1Dto[],
): UpdateSummaryV1Dto => ({
  groups: groups.length,
  candidates: candidates.length,
  current: candidates.filter(({ outcome }) => outcome === 'current').length,
  available: candidates.filter(({ outcome }) => outcome === 'available').length,
  skippedFixed: candidates.filter(({ outcome }) => outcome === 'skipped-fixed').length,
  candidateFailed: candidates.filter(({ outcome }) => outcome === 'failed').length,
  planned: groups.filter(({ outcome }) => outcome === 'planned').length,
  succeeded: groups.filter(({ outcome }) => outcome === 'succeeded').length,
  failed: groups.filter(({ outcome }) => outcome === 'failed').length,
  cancelled: groups.filter(({ outcome }) => outcome === 'cancelled').length,
  skipped: groups.filter(({ outcome }) => outcome === 'skipped').length,
  notRun: groups.filter(({ outcome }) => outcome === 'not-run').length,
  effects: effects.length,
  artifactDrift: groups.filter(({ drift }) => drift.artifact).length,
  liveDrift: groups.filter(({ drift }) => drift.live).length,
  refusals: diagnostics.filter(({ kind }) => kind === 'refuse').length,
});

const mutationFor = (
  report: UpdateReportV1Dto,
  results: readonly OperationExecutionResult[],
): MutationSummary => {
  if (report.mode !== 'execute') {
    return report.operations.length === 0
      ? NO_MUTATION
      : {
          kind: 'preview',
          planned: report.operations.length,
          changed: 0,
          unchanged: 0,
          failed: 0,
        };
  }
  if (
    report.approval.outcome === 'refused' ||
    report.approval.outcome === 'cancelled' ||
    results.length === 0
  ) {
    return NO_MUTATION;
  }
  const succeeded = new Set(
    report.effects.flatMap(({ operationId, outcome }) =>
      operationId !== null && outcome === 'succeeded' ? [operationId] : [],
    ),
  );
  const failed = new Set(
    report.effects.flatMap(({ operationId, outcome }) =>
      operationId !== null && outcome === 'failed' ? [operationId] : [],
    ),
  );
  const unchanged = new Set(
    report.effects.flatMap(({ operationId, outcome }) =>
      operationId !== null && (outcome === 'cancelled' || outcome === 'not-run')
        ? [operationId]
        : [],
    ),
  );
  const changed = new Set(succeeded);
  for (const result of results) {
    if (
      canonicalPlanningString(result.actualBefore) !== canonicalPlanningString(result.actualAfter)
    ) {
      changed.add(result.operationId);
    }
  }
  return {
    kind: 'applied',
    planned: report.operations.length,
    changed: changed.size,
    unchanged: unchanged.size,
    failed: failed.size,
  };
};

const filterNoopReport = (
  artifacts: PreparedUpdateArtifactsV1,
  selection: UpdateSelectionV1,
  request: UpdateApplicationRequestV1,
  mode: UpdateReportV1Dto['mode'],
): UpdateReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.update',
  command: 'update',
  mode,
  state: 'current',
  artifactPair: {
    manifestPath: artifacts.pair.file.path,
    lockPath: artifacts.pair.lockfile.path,
    lockSource: artifacts.pair.lockfileSource,
    selectionSource: artifacts.selectionSource,
  },
  options: {
    all: request.all,
    ref: request.ref,
    pin: request.pin,
    strict: request.strict,
    continueOnError: request.continueOnError,
  },
  selection: {
    selectionSource: selection.selectionSource,
    selectionOutcome: 'filter-noop',
    targets: Object.freeze([...request.targets]),
    skills: Object.freeze([]),
    tools: Object.freeze([]),
    groupIds: Object.freeze([]),
  },
  candidates: Object.freeze([]),
  operations: Object.freeze([]),
  checks: Object.freeze([]),
  diagnostics: Object.freeze([]),
  approval: { required: false, outcome: 'not-required' },
  groups: Object.freeze([]),
  effects: Object.freeze([]),
  summary: summaryFor([], [], [], []),
});

const outcomeForReport = (
  report: UpdateReportV1Dto,
  forcedExit?: CommandExitClass,
  results: readonly OperationExecutionResult[] = [],
): CommandOutcome<UpdateApplicationReport> => ({
  report: { result: report },
  diagnostics:
    report.summary.failed > 0
      ? [{ code: 'update-failed', severity: 'error', message: 'one or more update groups failed' }]
      : [],
  exitClass:
    forcedExit ??
    (report.summary.failed + report.summary.candidateFailed > 0
      ? 'failure'
      : report.mode === 'check' && report.summary.available > 0
        ? 'drift'
        : 'success'),
  mutation: mutationFor(report, results),
  deprecations: [],
});

const cleanupOutcome = (
  outcome: CommandOutcome<UpdateApplicationReport>,
  error: unknown,
): CommandOutcome<UpdateApplicationReport> => {
  const code = safeErrorCode(error);
  const permission =
    code === 'permission' || code === 'permission-denied' || code === 'EACCES' || code === 'EPERM';
  const diagnostic = {
    code: 'update-source-cleanup',
    severity: 'error' as const,
    message: permission
      ? 'temporary update source state could not be removed because permission was denied'
      : 'temporary update source state could not be removed',
  };
  return {
    ...outcome,
    diagnostics: outcome.diagnostics.some(({ code: existing }) => existing === diagnostic.code)
      ? outcome.diagnostics
      : [...outcome.diagnostics, diagnostic],
    exitClass:
      outcome.exitClass === 'cancelled' ? 'cancelled' : permission ? 'permission' : 'failure',
  };
};

const runVerification = async (
  prepared: PreparedUpdateObservationV1,
  context: CurrentApplicationContext,
  strict: boolean,
): Promise<
  | { readonly ok: true; readonly value: VerificationByPair }
  | { readonly ok: false; readonly outcome: CommandOutcome<UpdateApplicationReport> }
> => {
  const outcomes = new Map<string, UpdateVerificationOutcome<BuiltInToolId>>();
  for (const selection of prepared.selections) {
    if (selection.source === null) continue;
    for (const tool of selection.selected.tools) {
      const verified = await verifyUpdateCandidate(
        context.ports,
        {
          tool,
          path: selection.source.materializedDir,
          strict,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          observation: context.observation,
        },
        toolRegistry,
      );
      if (!verified.ok)
        return { ok: false, outcome: domainFailure(verified.error, context.signal) };
      outcomes.set(verificationKey(selection.selected.declaration.name, tool), verified.value);
    }
  }
  return { ok: true, value: outcomes };
};

interface ReportInput {
  readonly artifacts: Awaited<ReturnType<typeof prepareUpdateArtifactsV1>> & { readonly ok: true };
  readonly prepared: PreparedUpdateObservationV1;
  readonly base: PreparedUpdatePlanBaseV1;
  readonly planned: PreparedUpdateExecutionPlanV1;
  readonly request: UpdateApplicationRequestV1;
  readonly mode: UpdateReportV1Dto['mode'];
  readonly verification: VerificationByPair;
  readonly results: readonly OperationExecutionResult[];
  readonly approval: UpdateReportV1Dto['approval'];
  readonly approvalTerminal: boolean;
}

const buildReport = (input: ReportInput): UpdateReportV1Dto => {
  const candidates = Object.freeze(
    input.prepared.selections.map((prepared) => candidateDto(prepared, input.planned.plan)),
  );
  const groups = Object.freeze(
    input.prepared.selections.map((prepared, index) =>
      groupDto(
        prepared,
        candidates[index] as UpdateCandidateV1Dto,
        input.planned.plan,
        input.mode,
        input.verification,
        input.results,
        input.approvalTerminal,
      ),
    ),
  );
  const operations = planOperations(input.planned.plan);
  const checks = planChecks(input.planned.plan);
  const diagnostics = planDiagnostics(input.planned.plan);
  const effects = effectsFor(input.planned.plan, input.mode, input.results, input.approvalTerminal);
  const summary = summaryFor(candidates, groups, effects, diagnostics);
  const state: UpdateReportV1Dto['state'] =
    input.approval.outcome === 'refused' || input.approval.outcome === 'cancelled'
      ? 'refused'
      : summary.failed + summary.candidateFailed + summary.cancelled > 0
        ? 'partial'
        : input.mode === 'check'
          ? summary.available > 0
            ? 'changes-available'
            : 'current'
          : input.mode === 'dry-run'
            ? summary.available > 0
              ? 'ready'
              : 'current'
            : summary.available > 0
              ? 'completed'
              : 'current';
  return {
    schemaVersion: 1,
    kind: 'skillsmith.update',
    command: 'update',
    mode: input.mode,
    state,
    artifactPair: {
      manifestPath: input.artifacts.value.pair.file.path,
      lockPath: input.artifacts.value.pair.lockfile.path,
      lockSource: input.artifacts.value.pair.lockfileSource,
      selectionSource: input.artifacts.value.selectionSource,
    },
    options: {
      all: input.request.all,
      ref: input.request.ref,
      pin: input.request.pin,
      strict: input.request.strict,
      continueOnError: input.request.continueOnError,
    },
    selection: {
      selectionSource: input.base.selection.selectionSource,
      selectionOutcome: input.prepared.selections.length === 0 ? 'filter-noop' : 'selected',
      targets: Object.freeze([...input.request.targets]),
      skills: Object.freeze(groups.map(({ skill }) => skill)),
      tools: Object.freeze(
        toolRegistry.ids.filter((tool) => groups.some(({ tools }) => tools.includes(tool))),
      ),
      groupIds: Object.freeze(groups.map(({ groupId }) => groupId)),
    },
    candidates,
    operations,
    checks,
    diagnostics,
    approval: input.approval,
    groups,
    effects,
    summary,
  };
};

export const runUpdateApplication: ApplicationService<
  CurrentCommandRequest,
  UpdateApplicationReport
> = async (rawRequest, context) => {
  const normalized = normalize(rawRequest);
  if (!normalized.ok) return refusal('usage', 'update-options', normalized.message);
  const request = normalized.value;
  for (const tool of request.tools) {
    if (toolRegistry.get(tool) === undefined)
      return refusal('usage', 'update-unknown-tool', `unknown tool: ${tool}`);
  }
  const mode: UpdateReportV1Dto['mode'] = request.check
    ? 'check'
    : request.dryRun
      ? 'dry-run'
      : 'execute';
  const conservativelyBulk =
    request.all ||
    request.targets.length > 1 ||
    request.targets.some((target) => target.includes('*') || target.includes('?'));
  if (
    mode === 'execute' &&
    conservativelyBulk &&
    context.interaction.mode === 'noninteractive' &&
    !request.yes
  ) {
    return refusal(
      'usage',
      'update-approval-required',
      'noninteractive bulk update requires --yes',
    );
  }
  const project =
    context.projectContext === undefined
      ? await resolveProjectContext(context.ports, {
          invocationCwd: context.invocationCwd,
          ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
          ...(context.globalOptions.config === undefined
            ? {}
            : { explicitConfigPath: context.globalOptions.config }),
        })
      : { ok: true as const, value: context.projectContext };
  if (!project.ok) return domainFailure(project.error, context.signal);
  const artifacts = await prepareUpdateArtifactsV1(context.ports, project.value, request);
  if (!artifacts.ok)
    return refusal(artifacts.error.exitClass, artifacts.error.code, artifacts.error.message);
  const selection = selectUpdateDeclarationsV1({
    manifest: artifacts.value.manifest,
    targets: request.targets,
    all: request.all,
    tools: request.tools,
    registryOrder: toolRegistry.ids,
  });
  if (selection.declarations.length === 0) {
    const report = updateV1Codec.validate(
      filterNoopReport(artifacts.value, selection, request, mode),
    );
    return report.ok
      ? outcomeForReport(report.value)
      : refusal('failure', 'update-report-invalid', 'update filter no-op report invariant failed');
  }
  if (request.ref !== null && selection.declarations.length !== 1) {
    return refusal('usage', 'update-ref-selection', '--ref must resolve to one declaration');
  }
  for (const selected of selection.declarations) {
    for (const tool of selected.tools) {
      const capability = toolRegistry.capability(tool, 'update');
      if (!('supported' in capability) || !capability.supported) {
        return refusal('capability', 'update-tool-unavailable', `${tool} cannot be updated`);
      }
    }
  }
  const inspect = context.ports.git.inspectRemoteRef;
  if (selection.declarations.length > 0 && inspect === undefined) {
    return refusal(
      'capability',
      'update-ref-inspection-unavailable',
      'runtime does not provide exact Git remote-ref inspection',
    );
  }

  const inspected: Array<{
    readonly selected: (typeof selection.declarations)[number];
    readonly currentInspection: UpdateRemoteRefInspectionV1;
    readonly proposedInspection: UpdateRemoteRefInspectionV1;
  }> = [];
  for (const selected of selection.declarations) {
    const lock = artifacts.value.lock.skills.find(({ name }) => name === selected.declaration.name);
    if (lock === undefined) return refusal('state', 'update-lock-entry', 'lock entry is missing');
    const parsed = (await import('../acquire/source.ts')).parseSource(lock.source);
    if (!parsed.ok) return domainFailure(parsed.error, context.signal);
    try {
      const currentInspection = await (inspect as NonNullable<typeof inspect>)({
        remoteUrl: parsed.value.cloneUrl,
        ref: selected.declaration.ref,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const proposedInspection =
        request.ref === null || request.ref === selected.declaration.ref
          ? currentInspection
          : await (inspect as NonNullable<typeof inspect>)({
              remoteUrl: parsed.value.cloneUrl,
              ref: request.ref,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            });
      inspected.push({ selected, currentInspection, proposedInspection });
    } catch {
      if (context.signal?.aborted) {
        return refusal(
          'cancelled',
          'update-cancelled',
          'exact remote ref inspection was cancelled',
        );
      }
      return refusal(
        'source',
        'update-ref-inspection-failed',
        'exact remote ref inspection failed',
      );
    }
  }

  if (request.pin && request.ref === null) {
    const pinnable = inspected.some(
      ({ currentInspection }) =>
        currentInspection.kind === 'default' || currentInspection.kind === 'branch',
    );
    if (!pinnable)
      return refusal('usage', 'update-pin-fixed', '--pin requires an existing moving declaration');
  }

  const preparedResult = await prepareUpdateObservationV1(
    { artifacts: artifacts.value, request, selections: inspected },
    {
      ports: context.ports,
      configuration: context.configuration,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
  );
  if (!preparedResult.ok) {
    return refusal(
      preparedResult.error.exitClass,
      preparedResult.error.code,
      preparedResult.error.message,
    );
  }
  const prepared = preparedResult.value;
  const complete = async (
    outcome: CommandOutcome<UpdateApplicationReport>,
  ): Promise<CommandOutcome<UpdateApplicationReport>> => {
    try {
      await prepared.cleanup();
      return outcome;
    } catch (error) {
      return cleanupOutcome(outcome, error);
    }
  };

  const base = await prepareUpdatePlanBaseV1(
    { artifacts: artifacts.value, update: prepared, selection, request, project: project.value },
    {
      ports: context.ports,
      configuration: context.configuration,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
  );
  if (!base.ok) {
    return complete(refusal(base.error.exitClass, base.error.code, base.error.message));
  }
  const validated = await validateSavedReconcilePlanValue(
    base.value.projection.plan,
    {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: project.value,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
    'update',
  );
  if (!validated.ok) {
    return complete(
      refusal(validated.error.exitClass, validated.error.code, validated.error.message),
    );
  }
  const planned = createUpdateExecutionPlanV1(
    base.value,
    validated.value.plan,
    validated.value.guards,
    request.continueOnError,
  );
  if (!planned.ok) {
    return complete(refusal(planned.error.exitClass, planned.error.code, planned.error.message));
  }

  const candidates = prepared.selections.map((item) => candidateDto(item, planned.value.plan));
  const mutatingGroups = candidates.filter(({ outcome }) => outcome === 'available');
  const approvalRequired = mode === 'execute' && mutatingGroups.length > 1;
  let approval: UpdateReportV1Dto['approval'] = {
    required: approvalRequired,
    outcome: request.yes ? 'approved' : approvalRequired ? 'pending' : 'not-required',
  };
  if (approvalRequired && !request.yes) {
    const mutatingIds = new Set(mutatingGroups.map(({ groupId }) => groupId));
    const resolution = await context.interaction.confirm({
      id: 'update-exact-plan',
      message: `Apply ${mutatingGroups.length} exact update groups?`,
      preview: {
        kind: 'exact-update-preview',
        command: 'update',
        groupIds: mutatingGroups.map(({ groupId }) => groupId),
        operationIds: planned.value.plan.operations
          .filter(({ groupId }) => mutatingIds.has(groupId))
          .map(({ operationId }) => operationId),
      },
    });
    approval =
      resolution.status === 'cancelled'
        ? { required: true, outcome: 'cancelled' }
        : resolution.status === 'refused' || !resolution.value
          ? { required: true, outcome: 'refused' }
          : { required: true, outcome: 'approved' };
  }
  if (approval.outcome === 'refused' || approval.outcome === 'cancelled') {
    const report = buildReport({
      artifacts: { ok: true, value: artifacts.value },
      prepared,
      base: base.value,
      planned: planned.value,
      request,
      mode,
      verification: new Map(),
      results: [],
      approval,
      approvalTerminal: false,
    });
    const validatedReport = updateV1Codec.validate(report);
    if (!validatedReport.ok) {
      return complete(
        refusal('failure', 'update-report-invalid', 'update report invariant failed'),
      );
    }
    return complete(
      outcomeForReport(
        validatedReport.value,
        approval.outcome === 'cancelled' ? 'cancelled' : 'usage',
      ),
    );
  }

  const verified = await runVerification(prepared, context, request.strict);
  if (!verified.ok) return complete(verified.outcome);
  let results: readonly OperationExecutionResult[] = [];
  let executionCleanupFailure: Readonly<{
    readonly code: string;
    readonly message: string;
    readonly exitClass: CommandExitClass;
  }> | null = null;
  if (mode === 'execute' && planned.value.plan.operations.length > 0) {
    const blockedPairs = new Set<string>();
    const blockedGroups = new Set<string>();
    for (const selection of prepared.selections) {
      const selectedOutcomes = selection.selected.tools.map((tool) =>
        verified.value.get(verificationKey(selection.selected.declaration.name, tool)),
      );
      if (selectedOutcomes.length > 0 && selectedOutcomes.every((outcome) => outcome?.blocked)) {
        blockedGroups.add(groupIdFor(selection, planned.value.plan));
      }
      for (const tool of selection.selected.tools) {
        if (
          verified.value.get(verificationKey(selection.selected.declaration.name, tool))?.blocked
        ) {
          const operation = planned.value.plan.operations.find(
            (candidate) =>
              candidate.skill === selection.selected.declaration.name && candidate.tool === tool,
          );
          if (operation !== undefined) blockedPairs.add(operation.operationId);
        }
      }
    }
    const preparedSources = prepared.selections.flatMap(({ source }) =>
      source === null ? [] : [source],
    );
    const executed = await executePreparedUpdatePlanV1(
      validated.value as ValidatedSavedReconcilePlanValue<'update'>,
      planned.value,
      {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: project.value,
        artifactCoordinator: context.artifactCoordinator,
        observation: context.observation,
        preparedSources,
        blockedOperationIds: blockedPairs,
        blockedGroupIds: blockedGroups,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
    );
    if (!executed.ok && executed.error.results === undefined) {
      return complete(
        refusal(executed.error.exitClass, executed.error.code, executed.error.message),
      );
    }
    if (!executed.ok) {
      executionCleanupFailure = executed.error;
    }
    results = executed.ok ? executed.value : (executed.error.results ?? []);
  }

  const report = buildReport({
    artifacts: { ok: true, value: artifacts.value },
    prepared,
    base: base.value,
    planned: planned.value,
    request,
    mode,
    verification: verified.value,
    results,
    approval,
    approvalTerminal: true,
  });
  const validatedReport = updateV1Codec.validate(report);
  if (!validatedReport.ok) {
    return complete(
      refusal(
        'failure',
        'update-report-invalid',
        `update report invariant failed at ${validatedReport.error.path.join('.') || '<root>'}: ${validatedReport.error.message}`,
      ),
    );
  }
  const outcome = outcomeForReport(validatedReport.value, undefined, results);
  return complete(
    executionCleanupFailure === null
      ? outcome
      : cleanupOutcome(outcome, {
          code:
            executionCleanupFailure.exitClass === 'permission'
              ? 'permission-denied'
              : executionCleanupFailure.code,
        }),
  );
};
