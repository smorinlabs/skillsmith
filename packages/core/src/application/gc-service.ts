import type { LedgerModel, LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import { logicalJournalPairIdentity } from '../artifacts/registry.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import type { GcProjectV1Dto, GcReportV1Dto } from '../contracts/v1/gc.ts';
import { executeGcPlan, resumeGcRecovery } from '../gc/execute.ts';
import { observeGcState } from '../gc/observe.ts';
import {
  buildGcPlan,
  gcRequestDigest,
  normalizeGcForgetRoots,
  parseGcDuration,
  withoutLedgerProjectAt,
} from '../gc/plan.ts';
import { classifyGcReachability } from '../gc/reachability.ts';
import type { GcDuration, GcInventory, GcRecoveryObservation } from '../gc/types.ts';
import { emptyLedgerModel } from '../place/ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import { type Result, err, ok } from '../result.ts';
import type {
  ApplicationService,
  CommandOutcome,
  CurrentApplicationContext,
  CurrentCommandRequest,
  MutationSummary,
} from './types.ts';
import { NO_MUTATION } from './types.ts';

export interface GcApplicationReport {
  readonly result: GcReportV1Dto | null;
}

interface GcRequestError {
  readonly code: string;
  readonly message: string;
}

interface NormalizedGcRequest {
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly json: boolean;
  readonly prompt: boolean;
  readonly duration: GcDuration | null;
  readonly forgetProject: readonly string[];
}

const bool = (
  options: Readonly<Record<string, unknown>>,
  name: string,
  fallback = false,
): boolean | null => {
  const value = options[name];
  return value === undefined ? fallback : typeof value === 'boolean' ? value : null;
};

const strings = (value: unknown): readonly string[] | null => {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.every((item) => typeof item === 'string' && item.length > 0)
    ? (values as readonly string[])
    : null;
};

const normalize = (request: CurrentCommandRequest): Result<NormalizedGcRequest, GcRequestError> => {
  if (request.arguments.length !== 0) {
    return err({ code: 'gc-target', message: 'gc does not accept positional targets' });
  }
  const names = ['dryRun', 'yes', 'json', 'prompt'] as const;
  const values = Object.fromEntries(
    names.map((name) => [name, bool(request.options, name, name === 'prompt')]),
  ) as Record<(typeof names)[number], boolean | null>;
  const invalid = names.find((name) => values[name] === null);
  if (invalid !== undefined) {
    return err({ code: `gc-${invalid}`, message: `--${invalid} must be boolean` });
  }
  const dryRun = values.dryRun as boolean;
  const yes = values.yes as boolean;
  if (dryRun && yes) {
    return err({ code: 'gc-mode', message: '--dry-run conflicts with --yes' });
  }
  const rawDuration = request.options.olderThan;
  if (rawDuration !== undefined && typeof rawDuration !== 'string') {
    return err({ code: 'gc-duration', message: '--older-than requires one duration' });
  }
  const duration = rawDuration === undefined ? ok(null) : parseGcDuration(rawDuration);
  if (!duration.ok) return err({ code: duration.error.code, message: duration.error.message });
  const forgetProject = strings(request.options.forgetProject);
  if (forgetProject === null) {
    return err({
      code: 'gc-forget-project',
      message: '--forget-project requires non-empty paths',
    });
  }
  return ok(
    Object.freeze({
      dryRun,
      yes,
      json: values.json as boolean,
      prompt: values.prompt as boolean,
      duration: duration.value,
      forgetProject: Object.freeze([...forgetProject]),
    }),
  );
};

const resolveContext = async (
  context: CurrentApplicationContext,
): Promise<Result<ProjectContext, GcRequestError>> => {
  if (context.projectContext !== undefined) return ok(context.projectContext);
  const project = await resolveProjectContext(context.ports, {
    invocationCwd: context.invocationCwd,
    ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
    ...(context.globalOptions.config === undefined
      ? {}
      : { explicitConfigPath: context.globalOptions.config }),
  });
  return project.ok
    ? project
    : err({
        code: `gc-${project.error.code}`,
        message: 'message' in project.error ? project.error.message : project.error.code,
      });
};

const publicProject = (project: ProjectContext): GcReportV1Dto['project'] => {
  const root = project.projectRoot ?? project.effectiveCwd;
  return Object.freeze({
    effectiveCwd: project.effectiveCwd,
    root,
    identity: project.projectIdentity ?? root,
  });
};

const refusalReport = (
  project: GcReportV1Dto['project'],
  message: string,
  options: Readonly<{
    readonly sourceVersion?: 1 | 2 | null;
    readonly recovery?: GcRecoveryObservation;
    readonly inventory?: GcInventory;
  }> = {},
): GcReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.gc',
  command: 'gc',
  mode: 'execute',
  state: 'refused',
  planId: null,
  selectionSource: 'bounded-default',
  project,
  migration: {
    sourceVersion: options.sourceVersion ?? null,
    action: 'none',
    outcome: 'not-required',
  },
  olderThan: null,
  approval: { required: false, outcome: 'refused' },
  recovery: {
    state: options.recovery?.state === 'pending' ? 'pending' : 'refused',
    phase: options.recovery?.state === 'pending' ? options.recovery.record.phase : null,
  },
  projects: [],
  objects: [],
  actions: [],
  results: [],
  checks: [{ code: 'gc-safe', outcome: 'failed', message }],
  diagnostics:
    options.inventory?.state === 'refused'
      ? options.inventory.issues.map(({ code, path, reason }) => ({ code, path, message: reason }))
      : [{ code: 'gc-refused', path: null, message }],
  summary: {
    observedItems: 0,
    protectedItems: 0,
    ageFilteredItems: 0,
    eligibleItems: null,
    eligibleBytes: null,
    forgottenProjects: 0,
    reclaimedItems: 0,
    reclaimedBytes: 0,
    refusedItems: 1,
    failedItems: 0,
  },
});

const refuse = (
  exitClass: 'usage' | 'state' | 'cancelled',
  code: string,
  message: string,
  report: GcReportV1Dto | null = null,
): CommandOutcome<GcApplicationReport> => ({
  report: { result: report },
  diagnostics: [{ code, severity: 'error', message }],
  exitClass,
  mutation: NO_MUTATION,
  deprecations: [],
});

const visitPairs = (model: LedgerModel, root: string): readonly LedgerPairV1Dto[] =>
  Object.values(model.projects[root]?.skills ?? {}).flatMap(({ tools }) => Object.values(tools));

const forgetRows = async (
  context: CurrentApplicationContext,
  model: LedgerModel,
  project: ProjectContext,
  roots: readonly string[],
): Promise<Result<readonly GcProjectV1Dto[], GcRequestError>> => {
  const currentRoot = project.projectRoot ?? project.effectiveCwd;
  const rows: GcProjectV1Dto[] = [];
  for (const root of roots) {
    const current = root === currentRoot;
    const existing = (await context.ports.pathKind(root)) !== 'absent';
    const projectRecord = Object.hasOwn(model.projects, root);
    const registration = Object.hasOwn(model.projectRegistrations, root);
    const pendingLegacy = visitPairs(model, root).some(({ journal }) => journal != null);
    const pendingLogical = Object.values(model.transactions).some(
      (journal) => logicalJournalPairIdentity(journal)?.projectRoot === root,
    );
    if (current || existing || !projectRecord || !registration || pendingLegacy || pendingLogical) {
      const reason = current
        ? 'the current project cannot be forgotten'
        : existing
          ? 'only an absent project may be forgotten'
          : !projectRecord || !registration
            ? 'the exact project is not registered'
            : 'the project has pending recovery journal state';
      return err({ code: 'unsafe-forget', message: `${reason}: ${root}` });
    }
    rows.push(
      Object.freeze({
        root,
        current: false,
        existing: false,
        registered: true,
        requested: true,
        action: 'forget-project',
        outcome: 'planned',
        reason: null,
      }),
    );
  }
  return ok(Object.freeze(rows));
};

const retryArguments = (
  request: NormalizedGcRequest,
  roots: readonly string[],
): readonly string[] =>
  Object.freeze([
    'gc',
    ...(request.duration === null ? [] : ['--older-than', request.duration.input]),
    ...roots.flatMap((root) => ['--forget-project', root]),
    '--yes',
  ]);

const mutationFor = (report: GcReportV1Dto, dryRun: boolean): MutationSummary => ({
  kind: dryRun ? 'preview' : report.state === 'completed' ? 'applied' : 'none',
  planned: report.actions.length,
  changed: dryRun ? 0 : report.results.filter(({ outcome }) => outcome === 'succeeded').length,
  unchanged: report.summary.protectedItems + report.summary.ageFilteredItems,
  failed: report.summary.failedItems,
});

const success = (report: GcReportV1Dto, dryRun: boolean): CommandOutcome<GcApplicationReport> => ({
  report: { result: report },
  diagnostics: [],
  exitClass: 'success',
  mutation: mutationFor(report, dryRun),
  deprecations: [],
});

export const runGcApplication: ApplicationService<
  CurrentCommandRequest,
  GcApplicationReport
> = async (rawRequest, context) => {
  const normalized = normalize(rawRequest);
  if (!normalized.ok) return refuse('usage', normalized.error.code, normalized.error.message);
  const resolved = await resolveContext(context);
  if (!resolved.ok) return refuse('usage', resolved.error.code, resolved.error.message);
  const project = publicProject(resolved.value);
  const normalizedRoots = normalizeGcForgetRoots(
    resolved.value.effectiveCwd,
    normalized.value.forgetProject,
  );
  if (!normalizedRoots.ok) {
    return refuse('usage', normalizedRoots.error.code, normalizedRoots.error.message);
  }
  const dataDir = resolveDataDir(context.ports, context.configuration);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const observed = await observeGcState(context.ports, { dataDir, storeRoot, ledgerPath });
  if ('error' in observed) {
    return refuse(
      'state',
      'gc-observation',
      observed.error,
      refusalReport(project, observed.error),
    );
  }
  if (observed.recovery.state === 'pending') {
    const digest = gcRequestDigest(normalized.value.duration, normalizedRoots.value);
    if (digest !== observed.recovery.record.requestDigest) {
      const remediation = observed.recovery.record.retryArguments.join(' ');
      const message = `GC has pending recovery for a different request; retry: ${remediation}`;
      return refuse(
        'state',
        'gc-recovery-request-mismatch',
        message,
        refusalReport(project, message, {
          sourceVersion: observed.ledger.sourceVersion,
          recovery: observed.recovery,
        }),
      );
    }
    if (normalized.value.dryRun) {
      const pending: GcReportV1Dto = Object.freeze({
        ...observed.recovery.record.approvedReport,
        mode: 'dry-run',
        state: 'partial',
        recovery: { state: 'pending' as const, phase: observed.recovery.record.phase },
        diagnostics: [
          {
            code: 'gc-recovery-pending',
            path: null,
            message: `retry: ${observed.recovery.record.retryArguments.join(' ')}`,
          },
        ],
      });
      return success(pending, true);
    }
    const resumed = await resumeGcRecovery(context.ports, {
      dataDir,
      storeRoot,
      ledgerPath,
      recovery: observed.recovery,
    });
    return resumed.ok
      ? success(resumed.report, false)
      : refuse('state', 'gc-execution', resumed.reason, resumed.report);
  }
  if (observed.inventory.state === 'refused') {
    const message = 'GC store inventory is unsafe; no action was selected';
    return refuse(
      'state',
      'gc-inventory-refused',
      message,
      refusalReport(project, message, {
        sourceVersion: observed.ledger.sourceVersion,
        inventory: observed.inventory,
      }),
    );
  }
  const nowMilliseconds = Date.parse(context.ports.wallNowIso());
  if (!Number.isSafeInteger(nowMilliseconds)) {
    const message = 'GC clock observation is invalid';
    return refuse('state', 'gc-clock', message, refusalReport(project, message));
  }
  const model =
    observed.ledger.state === 'present'
      ? observed.ledger.model
      : emptyLedgerModel(new Date(nowMilliseconds).toISOString());
  const projects = await forgetRows(context, model, resolved.value, normalizedRoots.value);
  if (!projects.ok) return refuse('usage', projects.error.code, projects.error.message);
  const postForget = withoutLedgerProjectAt(model, normalizedRoots.value);
  if (!postForget.ok) return refuse('usage', postForget.error.code, postForget.error.message);
  const classified = classifyGcReachability({
    model: postForget.value,
    objects: observed.inventory.objects,
    nowMilliseconds,
    olderThanMilliseconds: normalized.value.duration?.milliseconds ?? null,
  });
  if (classified.state === 'refused') {
    return refuse(
      'state',
      'gc-reachability-refused',
      classified.reason,
      refusalReport(project, classified.reason, {
        sourceVersion: observed.ledger.sourceVersion,
      }),
    );
  }
  const plan = buildGcPlan({
    sourceLedger: observed.ledger,
    model,
    postForgetModel: postForget.value,
    inventory: observed.inventory,
    classifications: classified.classifications,
    duration: normalized.value.duration,
    nowMilliseconds,
    projects: projects.value,
    dataDir,
    storeRoot,
    ledgerPath,
    project,
    retryArguments: retryArguments(normalized.value, normalizedRoots.value),
    normalizedForgetRoots: normalizedRoots.value,
  });
  if (normalized.value.dryRun) return success(plan.report, true);
  if (plan.actions.length === 0) {
    const noOpReport: GcReportV1Dto = Object.freeze({
      ...plan.report,
      mode: 'execute',
      state: 'no-op',
      approval: { required: false, outcome: 'not-required' as const },
    });
    return success(noOpReport, false);
  }
  if (!normalized.value.yes) {
    if (
      normalized.value.json ||
      !normalized.value.prompt ||
      context.interaction.mode === 'noninteractive'
    ) {
      return refuse(
        'usage',
        'gc-approval-required',
        'changing GC execution requires --yes in JSON or noninteractive mode',
      );
    }
    const approval = await context.interaction.confirm({
      id: 'gc.approval',
      message: `Confirm ${plan.actions.length} exact GC actions?`,
      preview: {
        kind: 'exact-gc-preview',
        command: 'gc',
        planId: plan.planId,
        operationIds: plan.actions.map(({ actionId }) => actionId),
      },
    });
    if (approval.status === 'cancelled') {
      return refuse('cancelled', 'gc-approval-cancelled', 'GC confirmation was cancelled');
    }
    if (approval.status === 'refused' || !approval.value) {
      return refuse(
        'usage',
        'gc-approval-refused',
        approval.status === 'refused' ? approval.reason : 'GC was not approved',
      );
    }
  }
  const executed = await executeGcPlan(context.ports, plan);
  return executed.ok
    ? success(executed.report, false)
    : refuse('state', 'gc-execution', executed.reason, executed.report);
};
