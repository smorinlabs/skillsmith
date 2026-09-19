import { dirname, join, resolve } from 'node:path';
import type { RelevantCapabilityQueryV1 } from '../agents/capabilities.ts';
import { toolRegistry } from '../agents/registry.ts';
import {
  createArtifactPairOperationControllerV1,
  withArtifactPairExecutionAuthority,
} from '../artifacts/execution.ts';
import { type ResolvedArtifactPair, resolveArtifactPair } from '../artifacts/pair.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import { type SyncReportV1Dto, syncV1Codec } from '../contracts/v1/sync.ts';
import {
  type SkillSmithError,
  cancelledError,
  flipRefusedError,
  genericError,
  invalidArgumentError,
  permissionDeniedError,
  toolUnavailableError,
} from '../errors.ts';
import { createContentObservationExecutionPrecondition } from '../execution/preconditions.ts';
import type { ExecutionPrecondition } from '../execution/types.ts';
import {
  type ExplicitPlacementProjectLocationV1,
  createExplicitPlacementProjectLocationV1,
  createPlacementRevisionExecutionPreconditionsV1,
  createPlacementSnapshotAuthority,
  executePlacementOperationPlan,
  rebindPlacementSnapshotAuthorityForLedgerBootstrapV1,
  withPlacementLedgerBootstrapAuthorityV1,
} from '../place/execute.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import { contentHashOf, snapshotToStore } from '../place/store.ts';
import type { FlipResult, OriginRecord, PinnedRecord } from '../place/types.ts';
import { createBoundedForceEffect, createPlanningDiagnosticId } from '../planning/create.ts';
import type {
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  createContentObservationIdentityV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionPreconditionIdV1,
} from '../state/types.ts';
import { type PreparedSyncArtifactsV1, prepareSyncArtifactsV1 } from '../sync/artifacts.ts';
import { resolveSyncEndpoints } from '../sync/endpoints.ts';
import { executeSyncPlacementV1 } from '../sync/execute.ts';
import {
  type PreparedSyncStoreV1,
  prepareSyncStoreResourcesV1,
  toSyncReportOperationV1,
} from '../sync/internal-projections.ts';
import { observeSyncFleet } from '../sync/observe.ts';
import {
  type SyncFleetPlanProjectionV1,
  type SyncFleetResourceSelectionV1,
  type SyncFleetSelectedPairV1,
  createSyncPlan,
  projectSyncFleetPlanV1,
  selectSyncFleetResourcesV1,
} from '../sync/plan.ts';
import type { SyncFleetObservation } from '../sync/types.ts';
import type {
  ApplicationService,
  CommandExitClass,
  CommandOutcome,
  CurrentApplicationContext,
  CurrentCommandRequest,
  Diagnostic,
  MutationSummary,
  PreparedSyncApplication,
  SyncApplicationPort,
  SyncApplicationRequest,
} from './types.ts';
import { NO_MUTATION } from './types.ts';

/** Renderer-facing sync boundary; pre-domain usage/capability failures carry no wire report. */
export interface SyncApplicationReport {
  readonly result: SyncReportV1Dto | null;
}

const EMPTY_REPORT: SyncApplicationReport = Object.freeze({ result: null });

const failure = (
  exitClass: CommandExitClass,
  code: string,
  message: string,
  result: SyncReportV1Dto | null = null,
): CommandOutcome<SyncApplicationReport> => ({
  report: result === null ? EMPTY_REPORT : { result },
  diagnostics: [{ code, severity: 'error', message }],
  exitClass,
  mutation: NO_MUTATION,
  deprecations: [],
});

const errorExitClass = (error: SkillSmithError): CommandExitClass => {
  if (error.code === 'cancelled') return 'cancelled';
  if (error.code === 'invalid-argument') return 'usage';
  if (error.code === 'unknown-tool' || error.code === 'tool-unavailable') return 'capability';
  if (error.code === 'permission-denied') return 'permission';
  if (
    error.code === 'config-error' ||
    error.code === 'ledger-error' ||
    error.code === 'placement-not-found' ||
    error.code === 'flip-refused'
  )
    return 'state';
  return 'failure';
};

const errorText = (error: SkillSmithError): string =>
  error.code === 'unknown-tool' ? `unknown tool: ${error.tool}` : error.message;

const strings = (value: unknown): readonly string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0))
    return null;
  return value;
};

const positionalSkills = (arguments_: readonly unknown[]): readonly string[] | null => {
  if (arguments_.length === 0) return [];
  if (arguments_.length === 1 && Array.isArray(arguments_[0])) return strings(arguments_[0]);
  return strings(arguments_);
};

const boolean = (options: Readonly<Record<string, unknown>>, key: string): boolean | null => {
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
  | { readonly ok: true; readonly value: SyncApplicationRequest }
  | { readonly ok: false; readonly message: string } => {
  const from = scalar(request.options, 'from');
  const to = scalar(request.options, 'to');
  if (from === null) return { ok: false, message: '--from is required' };
  if (from === undefined) return { ok: false, message: '--from requires one non-empty value' };
  if (to === null) return { ok: false, message: '--to is required' };
  if (to === undefined) return { ok: false, message: '--to requires one non-empty value' };
  const skills = positionalSkills(request.arguments);
  if (skills === null)
    return { ok: false, message: 'sync skill targets must be non-empty strings' };
  const tools = strings(request.options.tool);
  if (tools === null) return { ok: false, message: '--tool must be a list of non-empty values' };
  const file = scalar(request.options, 'file');
  const lockfile = scalar(request.options, 'lockfile');
  if (file === undefined) return { ok: false, message: '--file requires one non-empty value' };
  if (lockfile === undefined)
    return { ok: false, message: '--lockfile requires one non-empty value' };
  const flags = ['force', 'delete', 'save', 'dryRun', 'yes', 'continueOnError'] as const;
  const values = Object.fromEntries(
    flags.map((key) => [key, boolean(request.options, key)]),
  ) as Record<(typeof flags)[number], boolean | null>;
  const invalid = flags.find((key) => values[key] === null);
  if (invalid !== undefined)
    return {
      ok: false,
      message: `--${invalid.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be boolean`,
    };
  if (values.yes && values.dryRun)
    return { ok: false, message: '--yes cannot be combined with --dry-run' };
  if (file !== null && !values.save) return { ok: false, message: '--file requires --save' };
  if (lockfile !== null && (file === null || !values.save))
    return { ok: false, message: '--lockfile requires --file and --save' };
  return {
    ok: true,
    value: {
      from,
      to,
      skills,
      tools,
      force: values.force as boolean,
      delete: values.delete as boolean,
      save: values.save as boolean,
      file,
      lockfile,
      dryRun: values.dryRun as boolean,
      yes: values.yes as boolean,
      continueOnError: values.continueOnError as boolean,
    },
  };
};

const reportExitClass = (report: SyncReportV1Dto): CommandExitClass => {
  const pairs = report.groups.flatMap(({ pairs }) => pairs);
  if (
    report.approval.outcome === 'cancelled' ||
    pairs.some(({ outcome }) => outcome === 'cancelled')
  )
    return 'cancelled';
  if (report.state === 'partial' || pairs.some(({ outcome }) => outcome === 'failed'))
    return 'failure';
  const classes = report.diagnostics
    .map(({ refusalClass }) => refusalClass)
    .filter((value): value is NonNullable<typeof value> => value !== null);
  // A dry-run is an exact, non-mutating preview. Planner-owned unsafe-destination conflicts stay
  // visible as usage refusals in the report, while the preview itself completes successfully.
  if (
    report.mode === 'dry-run' &&
    classes.length > 0 &&
    classes.every((value) => value === 'usage')
  ) {
    return 'success';
  }
  if (report.state === 'refused') {
    if (classes.includes('permission')) return 'permission';
    if (classes.includes('capability')) return 'capability';
    if (classes.includes('state')) return 'state';
    if (classes.includes('usage')) return 'usage';
    return 'failure';
  }
  return 'success';
};

const mutationFor = (report: SyncReportV1Dto): MutationSummary => {
  const planned = report.operations.length;
  const pairs = report.groups.flatMap(({ pairs }) => pairs);
  const changed = pairs.filter(({ outcome }) => outcome === 'succeeded').length;
  const failed = pairs.filter(({ outcome }) => outcome === 'failed').length;
  const unchanged = report.summary.unchanged;
  if (planned === 0 && changed === 0 && failed === 0) return NO_MUTATION;
  return {
    kind: report.mode === 'dry-run' || report.state === 'ready' ? 'preview' : 'applied',
    planned,
    changed,
    unchanged,
    failed,
  };
};

const success = (report: SyncReportV1Dto): CommandOutcome<SyncApplicationReport> => ({
  report: { result: report },
  diagnostics: [],
  exitClass: reportExitClass(report),
  mutation: mutationFor(report),
  deprecations: [],
});

const validatedReport = (
  report: SyncReportV1Dto,
):
  | { readonly ok: true; readonly value: SyncReportV1Dto }
  | { readonly ok: false; readonly diagnostic: Diagnostic } => {
  const validated = syncV1Codec.validate(report);
  return validated.ok
    ? validated
    : {
        ok: false,
        diagnostic: {
          code: 'invalid-sync-report',
          severity: 'error',
          message: `sync adapter returned an invalid report at ${validated.error.path.join('.') || '<root>'}: ${validated.error.message}`,
        },
      };
};

const approvalReport = (
  report: SyncReportV1Dto,
  outcome: 'refused' | 'cancelled',
): SyncReportV1Dto => ({ ...report, state: 'refused', approval: { required: true, outcome } });

const requestMatchesReport = (request: SyncApplicationRequest, report: SyncReportV1Dto): boolean =>
  report.mode === (request.dryRun ? 'dry-run' : 'execute') &&
  report.endpoints.from.selectedInput === request.from &&
  report.endpoints.to.selectedInput === request.to &&
  report.options.force === request.force &&
  report.options.delete === request.delete &&
  report.options.save === request.save &&
  report.options.dryRun === request.dryRun &&
  report.options.continueOnError === request.continueOnError;

const preparedApprovalReport = (report: SyncReportV1Dto): SyncReportV1Dto => {
  const pairs = report.groups.flatMap(({ pairs }) => pairs);
  const required =
    report.mode === 'execute' &&
    report.state !== 'refused' &&
    report.operations.length > 0 &&
    (report.groups.length > 1 ||
      pairs.some(({ action }) => action === 'remove') ||
      pairs.some(({ force }) => force.used));
  return {
    ...report,
    approval: required
      ? { required: true, outcome: 'pending' }
      : { required: false, outcome: 'not-required' },
  };
};

const executedApprovalReport = (report: SyncReportV1Dto, required: boolean): SyncReportV1Dto => ({
  ...report,
  approval: required
    ? { required: true, outcome: 'approved' }
    : { required: false, outcome: 'not-required' },
});

interface PreparedDefaultSyncV1 {
  readonly report: SyncReportV1Dto;
  readonly request: SyncApplicationRequest;
  readonly fleet: SyncFleetObservation;
  readonly selection: SyncFleetResourceSelectionV1;
  readonly projection: SyncFleetPlanProjectionV1;
  readonly authority: Awaited<ReturnType<typeof createPlacementSnapshotAuthority>> extends Result<
    infer Value,
    unknown
  >
    ? Value
    : never;
  readonly plan: OperationPlan<'sync'>;
  readonly expectedRevisions: readonly import('../state/types.ts').ExpectedRevisionV1[];
  readonly preconditions: readonly ExecutionPrecondition[];
  readonly stores: ReadonlyMap<string, PreparedSyncStoreV1>;
  readonly artifacts: PreparedSyncArtifactsV1 | null;
  consumed: boolean;
}

const defaultPrepared = new WeakMap<PreparedSyncApplication, PreparedDefaultSyncV1>();

const syncError = (
  failure: Readonly<{
    readonly message: string;
    readonly exitClass: 'failure' | 'usage' | 'state' | 'capability' | 'permission' | 'cancelled';
  }>,
): SkillSmithError => {
  switch (failure.exitClass) {
    case 'usage':
      return invalidArgumentError(failure.message);
    case 'state':
      return flipRefusedError(failure.message);
    case 'capability':
      return toolUnavailableError(failure.message);
    case 'permission':
      return permissionDeniedError(failure.message);
    case 'cancelled':
      return cancelledError(failure.message);
    case 'failure':
      return genericError(failure.message);
  }
};

const resolveTopProject = async (
  context: CurrentApplicationContext,
): Promise<Result<ProjectContext, SkillSmithError>> => {
  if (context.projectContext !== undefined) return ok(context.projectContext);
  const explicitConfigPath =
    context.globalOptions.config ?? context.configuration.explicitConfigPath;
  const project = await resolveProjectContext(context.ports, {
    invocationCwd: context.invocationCwd,
    ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
    ...(explicitConfigPath === undefined ? {} : { explicitConfigPath }),
  });
  return project.ok ? project : err(flipRefusedError('sync project context could not be resolved'));
};

const endpointDto = (
  endpoint: SyncFleetObservation['endpoints']['from'],
): SyncReportV1Dto['endpoints']['from'] => ({
  kind: endpoint.kind,
  scope: endpoint.scope,
  selectedInput: endpoint.selectedInput,
  projectRoot: endpoint.scope === 'project' ? endpoint.canonicalBase : null,
});

const pairOperation = (
  plan: OperationPlan<'sync'>,
  pair: SyncFleetSelectedPairV1,
): ExecutableOperation | null =>
  plan.operations.find(
    (operation) => operation.skill === pair.pair.skill && operation.tool === pair.pair.tool,
  ) ?? null;

const pairGroupId = (plan: OperationPlan<'sync'>, pair: SyncFleetSelectedPairV1): string | null => {
  const operation = pairOperation(plan, pair);
  if (operation !== null) return operation.groupId;
  return (
    plan.diagnostics.find(
      ({ affected }) => affected.skill === pair.pair.skill && affected.tool === pair.pair.tool,
    )?.correlation.groupId ?? null
  );
};

const forceProjection = (
  request: SyncApplicationRequest,
  operation: ExecutableOperation | null,
  outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run' = 'planned',
  applied?: boolean,
): SyncReportV1Dto['groups'][number]['pairs'][number]['force'] => {
  const conflict = operation?.conflict ?? null;
  const destination =
    conflict?.target.kind === 'live' && conflict.target.location.kind === 'machine-bound'
      ? conflict.target.location.path
      : null;
  const used = request.force && conflict !== null;
  const required = conflict !== null && conflict.backup === 'required';
  return {
    requested: request.force,
    used,
    conflictType: conflict?.class ?? null,
    destination,
    normal: conflict?.normal ?? 'apply',
    forced: conflict?.forced ?? 'not-applicable',
    required,
    outcome: required ? (used ? outcome : 'not-run') : 'not-required',
    ...(applied === undefined || !used ? {} : { used: applied }),
  };
};

const reportSummary = (
  groups: SyncReportV1Dto['groups'],
  effects: SyncReportV1Dto['effects'],
  diagnostics: SyncReportV1Dto['diagnostics'],
): SyncReportV1Dto['summary'] => {
  const pairs = groups.flatMap(({ pairs }) => pairs);
  return {
    groups: groups.length,
    pairs: pairs.length,
    planned: pairs.filter(({ outcome }) => outcome === 'planned').length,
    succeeded: pairs.filter(({ outcome }) => outcome === 'succeeded').length,
    failed: pairs.filter(({ outcome }) => outcome === 'failed').length,
    cancelled: pairs.filter(({ outcome }) => outcome === 'cancelled').length,
    skipped: pairs.filter(({ outcome }) => outcome === 'skipped').length,
    notRun: pairs.filter(({ outcome }) => outcome === 'not-run').length,
    changed: pairs.filter(
      ({ action }) => action === 'install' || action === 'update' || action === 'remove',
    ).length,
    unchanged: pairs.filter(({ action }) => action === 'noop').length,
    effects: effects.length,
    drift: pairs.filter(({ drift }) => drift.artifact || drift.live).length,
    refusals: diagnostics.filter(({ kind }) => kind === 'refuse').length,
  };
};

const previewSyncReport = (
  request: SyncApplicationRequest,
  fleet: SyncFleetObservation,
  selection: SyncFleetResourceSelectionV1,
  plan: OperationPlan<'sync'>,
  artifactPair: SyncReportV1Dto['artifactPair'] = null,
): SyncReportV1Dto => {
  const diagnostics = Object.freeze(
    plan.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      affected: { ...diagnostic.affected },
      correlation: { ...diagnostic.correlation },
      reason: { ...diagnostic.reason },
    })),
  ) as SyncReportV1Dto['diagnostics'];
  const groupIds = [...(plan.selection.groupIds ?? [])];
  const groups = Object.freeze(
    groupIds.map((groupId) => {
      const selectedPairs = selection.pairs.filter((pair) => pairGroupId(plan, pair) === groupId);
      const skill = selectedPairs[0]?.pair.skill;
      if (skill === undefined) throw new Error('sync group has no selected skill pair');
      return Object.freeze({
        groupId,
        skill,
        pairs: Object.freeze(
          selectedPairs.map((pair) => {
            const operation = pairOperation(plan, pair);
            const refused = plan.diagnostics.some(
              ({ kind, correlation }) =>
                kind === 'refuse' &&
                (correlation.pairId === operation?.pairId || correlation.groupId === groupId),
            );
            const action = refused
              ? ('refuse' as const)
              : operation?.kind === 'remove'
                ? ('remove' as const)
                : operation?.kind === 'install'
                  ? ('install' as const)
                  : operation?.kind === 'update' || operation?.kind === 'repair'
                    ? ('update' as const)
                    : ('noop' as const);
            const artifactDrift = plan.operations.some(
              (candidate) =>
                candidate.groupId === groupId &&
                (candidate.kind === 'migrate-project-config' ||
                  candidate.kind === 'write-manifest' ||
                  candidate.kind === 'write-lock'),
            );
            return Object.freeze({
              tool: pair.pair.tool,
              source: { scope: fleet.endpoints.from.scope, present: pair.source !== null },
              destination: {
                scope: fleet.endpoints.to.scope,
                present: pair.destination !== null,
              },
              action,
              outcome:
                refused || (request.dryRun && action === 'noop')
                  ? ('not-run' as const)
                  : ('planned' as const),
              skipReason: null,
              failure: null,
              force: forceProjection(request, operation),
              drift: {
                artifact: artifactDrift,
                live: action !== 'noop' && action !== 'refuse',
              },
            });
          }),
        ),
      });
    }),
  );
  const effects = Object.freeze(
    plan.operations.flatMap((operation): SyncReportV1Dto['effects'] => {
      const effect = (
        role: SyncReportV1Dto['effects'][number]['role'],
        action: string,
      ): SyncReportV1Dto['effects'][number] => ({
        role,
        action,
        operationId: operation.operationId,
        groupId: operation.groupId,
        outcome: 'planned',
      });
      if (operation.kind === 'write-manifest' || operation.kind === 'migrate-project-config') {
        return [effect('manifest', operation.kind)];
      }
      if (operation.kind === 'write-lock') return [effect('lock', operation.kind)];
      return [
        ...(operation.after.kind === 'placement' ? [effect('store', 'snapshot-store')] : []),
        ...(operation.conflict?.backup === 'required' ? [effect('backup', 'preserve-backup')] : []),
        effect('live', operation.kind),
        effect('ledger', operation.kind === 'remove' ? 'remove-placement' : 'record-placement'),
      ];
    }),
  );
  const refused = diagnostics.some(({ kind }) => kind === 'refuse');
  const report: SyncReportV1Dto = {
    schemaVersion: 1,
    kind: 'skillsmith.sync',
    command: 'sync',
    mode: request.dryRun ? 'dry-run' : 'execute',
    state: refused ? 'refused' : 'ready',
    endpoints: { from: endpointDto(fleet.endpoints.from), to: endpointDto(fleet.endpoints.to) },
    artifactPair,
    options: {
      force: request.force,
      delete: request.delete,
      save: request.save,
      dryRun: request.dryRun,
      continueOnError: request.continueOnError,
    },
    selection: {
      selectionSource: request.skills.length === 0 ? 'bounded-default' : 'explicit-targets',
      selectionOutcome: selection.pairs.length === 0 ? 'filter-noop' : 'selected',
      targets: [...new Set(request.skills)],
      skills: [...new Set(selection.pairs.map(({ pair }) => pair.skill))],
      tools: [...fleet.endpoints.tools],
      groupIds,
      sourceMembers: fleet.source.entries.length,
      destinationMembers: fleet.destination.entries.length,
    },
    operations: Object.freeze(plan.operations.map(toSyncReportOperationV1)),
    checks: Object.freeze(plan.checks.map((check) => ({ ...check }))) as SyncReportV1Dto['checks'],
    diagnostics,
    approval: { required: false, outcome: 'not-required' },
    groups,
    effects,
    summary: reportSummary(groups, effects, diagnostics),
  };
  return Object.freeze(report);
};

const beforeResource = (image: OperationImage) => {
  if (image.kind === 'absent' || image.kind === 'placement') return image.resource;
  if (image.kind === 'manifest' || image.kind === 'opaque-manifest') {
    return { kind: 'manifest-bytes' as const, location: image.location };
  }
  if (image.kind === 'lock') return { kind: 'lock' as const, location: image.location };
  return { kind: 'ledger' as const, projectRoot: image.projectRoot };
};

const contentPreconditions = (
  context: CurrentApplicationContext,
  fleet: SyncFleetObservation,
  selection: SyncFleetResourceSelectionV1,
  plan: OperationPlan<'sync'>,
): readonly ExecutionPrecondition[] => {
  const expected = new Map(
    selection.pairs.flatMap((pair) =>
      pair.sourceContent === undefined
        ? []
        : [[pair.sourceContent.resourceId, pair.sourceContent] as const],
    ),
  );
  expected.set(selection.sourceMembership.resourceId, selection.sourceMembership);
  expected.set(selection.destinationMembership.resourceId, selection.destinationMembership);
  let reobserved: ReturnType<typeof observeSyncFleet> | null = null;
  const currentFleet = async () => {
    reobserved ??= observeSyncFleet(context, fleet.endpoints, { portableProof: 'none' });
    const result = await reobserved;
    if (!result.ok) throw syncError(result.error);
    return result.value;
  };
  const values: ExecutionPrecondition[] = [];
  for (const content of expected.values()) {
    const preconditionId = createContentObservationPreconditionIdV1(content);
    const operations = plan.operations.filter((operation) =>
      operation.preconditionIds.includes(preconditionId),
    );
    if (operations.length === 0) continue;
    values.push(
      createContentObservationExecutionPrecondition({
        operationIds: operations.map(({ operationId }) => operationId),
        resource: beforeResource(operations[0]?.before as OperationImage),
        expectedContent: content,
        observeContent: async () => {
          if (content.resourceId === selection.sourceMembership.resourceId) {
            const current = await currentFleet();
            return createContentObservationIdentityV1({
              ...content,
              contentRevision: current.source.membershipHash,
            });
          }
          if (content.resourceId === selection.destinationMembership.resourceId) {
            const current = await currentFleet();
            return createContentObservationIdentityV1({
              ...content,
              contentRevision: current.destination.membershipHash,
            });
          }
          const hashed = await contentHashOf(context.ports, content.targetIdentity);
          if (!hashed.ok) throw hashed.error;
          return createContentObservationIdentityV1({ ...content, contentRevision: hashed.value });
        },
      }),
    );
  }
  return Object.freeze(values);
};

const selectedArtifactPair = async (
  context: CurrentApplicationContext,
  topProject: ProjectContext,
  fleet: SyncFleetObservation,
  request: SyncApplicationRequest,
): Promise<Result<ResolvedArtifactPair | null, SkillSmithError>> => {
  if (!request.save) return ok(null);
  const destination = fleet.endpoints.to;
  const discoveredFile =
    request.file !== null
      ? undefined
      : destination.scope === 'user'
        ? join(context.ports.xdg.config, 'skillsmith', 'skillsmith.toml')
        : (destination.project.discoveredConfigPath ??
          join(destination.canonicalBase ?? destination.project.effectiveCwd, 'skillsmith.toml'));
  const pair = await resolveArtifactPair(context.ports, topProject, {
    ...(discoveredFile === undefined ? {} : { discoveredFile }),
    ...(request.file === null ? {} : { file: request.file }),
    ...(request.lockfile === null ? {} : { lockfile: request.lockfile }),
  });
  return pair.ok ? pair : err(syncError(pair.error));
};

const artifactPairDto = (
  pair: ResolvedArtifactPair | null,
  request: SyncApplicationRequest,
  fleet: SyncFleetObservation,
): SyncReportV1Dto['artifactPair'] =>
  pair === null
    ? null
    : {
        manifestPath: pair.file.path,
        lockPath: pair.lockfile.path,
        lockSource: pair.lockfileSource,
        selectionSource:
          request.file !== null
            ? 'explicit'
            : fleet.endpoints.to.scope === 'user'
              ? 'destination-user'
              : 'destination-project',
      };

const capabilityRefusalReport = (
  request: Readonly<SyncApplicationRequest>,
  endpoints: SyncFleetObservation['endpoints'],
  tools: readonly (typeof toolRegistry.ids)[number][],
  code: string,
  message: string,
): SyncReportV1Dto => {
  const selectionSource: 'bounded-default' | 'explicit-targets' =
    request.skills.length === 0 ? 'bounded-default' : 'explicit-targets';
  const affected = {
    skill: null,
    source: null,
    tool: tools[0] ?? null,
    scope:
      endpoints.to.scope === 'user' || endpoints.to.scope === 'project' ? endpoints.to.scope : null,
    path: null,
  } as const;
  const correlation = { groupId: null, pairId: null, operationId: null } as const;
  const diagnostic = {
    diagnosticId: createPlanningDiagnosticId(
      {
        domain: 'skillsmith.planning-diagnostic-identity',
        schemaVersion: 1,
        kind: 'refuse',
        severity: 'error',
        refusalClass: 'capability',
        affected,
        correlation,
        reasonCode: code,
        selectionSource,
      },
      { registry: toolRegistry, toolOrder: toolRegistry.ids },
    ),
    kind: 'refuse',
    severity: 'error',
    refusalClass: 'capability',
    affected,
    correlation,
    reason: { code, message },
    selectionSource,
  } as const;
  const diagnostics = Object.freeze([diagnostic]) as SyncReportV1Dto['diagnostics'];
  const groups = Object.freeze([]) as SyncReportV1Dto['groups'];
  const effects = Object.freeze([]) as SyncReportV1Dto['effects'];
  return Object.freeze({
    schemaVersion: 1,
    kind: 'skillsmith.sync',
    command: 'sync',
    mode: request.dryRun ? 'dry-run' : 'execute',
    state: 'refused',
    endpoints: { from: endpointDto(endpoints.from), to: endpointDto(endpoints.to) },
    artifactPair: null,
    options: {
      force: request.force,
      delete: request.delete,
      save: request.save,
      dryRun: request.dryRun,
      continueOnError: request.continueOnError,
    },
    selection: {
      selectionSource,
      selectionOutcome: 'filter-noop',
      targets: [...new Set(request.skills)],
      skills: [],
      tools,
      groupIds: [],
      sourceMembers: 0,
      destinationMembers: 0,
    },
    operations: [],
    checks: [],
    diagnostics,
    approval: { required: false, outcome: 'not-required' },
    groups,
    effects,
    summary: reportSummary(groups, effects, diagnostics),
  } satisfies SyncReportV1Dto);
};

const defaultSyncApplicationPort: SyncApplicationPort = Object.freeze({
  prepare: async (
    request: Readonly<SyncApplicationRequest>,
    context: CurrentApplicationContext,
  ) => {
    try {
      if (context.signal?.aborted) return err(cancelledError('sync was cancelled'));
      const topProject = await resolveTopProject(context);
      if (!topProject.ok) return topProject;
      const tools =
        request.tools.length === 0
          ? Object.freeze([...toolRegistry.toolsFor('sync')])
          : request.tools;
      const endpoints = await resolveSyncEndpoints(context, topProject.value, {
        from: request.from,
        to: request.to,
        tools,
      });
      if (!endpoints.ok) {
        if (endpoints.error.exitClass === 'capability') {
          const fallbackTool = toolRegistry.toolsFor('sync')[0];
          const endpointFacts =
            fallbackTool === undefined
              ? endpoints
              : await resolveSyncEndpoints(context, topProject.value, {
                  from: request.from,
                  to: request.to,
                  tools: [fallbackTool],
                });
          if (endpointFacts.ok) {
            return ok(
              Object.freeze({
                report: capabilityRefusalReport(
                  request,
                  { ...endpointFacts.value, tools: tools as typeof endpointFacts.value.tools },
                  tools as readonly (typeof toolRegistry.ids)[number][],
                  endpoints.error.code,
                  endpoints.error.message,
                ),
              }),
            );
          }
        }
        return err(syncError(endpoints.error));
      }
      const fleet = await observeSyncFleet(context, endpoints.value, {
        portableProof: request.save ? 'exact' : 'none',
      });
      if (!fleet.ok) return err(syncError(fleet.error));
      const selection = selectSyncFleetResourcesV1(fleet.value, {
        targets: request.skills,
        delete: request.delete,
        continueOnError: request.continueOnError,
        save: request.save,
        force: request.force,
      });
      if (!selection.ok) return err(syncError(selection.error));
      const pair = await selectedArtifactPair(context, topProject.value, fleet.value, request);
      if (!pair.ok) return pair;
      const dataDir = resolveDataDir(context.ports, context.configuration);
      const storeRoot = storeRootOf(dataDir);
      const ledgerPath = ledgerPathOf(dataDir);
      const preparedStores = prepareSyncStoreResourcesV1(selection.value, storeRoot);
      const capabilityQueries: RelevantCapabilityQueryV1[] = selection.value.pairs.map(
        ({ pair: selectedPair }) => ({
          schemaVersion: 1,
          tool: selectedPair.tool,
          operation: 'sync',
          scope: selectedPair.scope,
        }),
      );
      let destinationProjectLocation: ExplicitPlacementProjectLocationV1 | undefined;
      if (
        fleet.value.endpoints.to.scope === 'project' &&
        fleet.value.endpoints.to.canonicalBase !== null
      ) {
        const created = await createExplicitPlacementProjectLocationV1(
          context.ports,
          fleet.value.endpoints.to.project,
          fleet.value.endpoints.to.canonicalBase,
        );
        if (!created.ok) return created;
        destinationProjectLocation = created.value;
      }
      const authority = await createPlacementSnapshotAuthority(
        toolRegistry,
        capabilityQueries,
        context.ports,
        fleet.value.endpoints.to.project,
        ledgerPath,
        storeRoot,
        selection.value.pairs.map(({ pair: selectedPair }) => selectedPair),
        preparedStores.resources,
        pair.value === null
          ? {
              manifestPath: join(dataDir, '.sync-live-only', 'manifest'),
              lockPath: join(dataDir, '.sync-live-only', 'lock'),
              observe: false,
            }
          : { manifestPath: pair.value.file.path, lockPath: pair.value.lockfile.path },
        destinationProjectLocation,
      );
      if (!authority.ok) return authority;
      const initialProjection = projectSyncFleetPlanV1(
        selection.value,
        authority.value,
        preparedStores.bindings,
      );
      if (!initialProjection.ok) return err(syncError(initialProjection.error));
      const initialPlan = createSyncPlan(
        initialProjection.value.request,
        authority.value.snapshot,
        {
          registry: toolRegistry,
          toolOrder: toolRegistry.ids,
        },
      );
      if (!initialPlan.ok) return err(genericError(initialPlan.error.message));
      const artifacts =
        pair.value === null
          ? ok<PreparedSyncArtifactsV1 | null>(null)
          : await prepareSyncArtifactsV1({
              ports: context.ports,
              homeDir: context.ports.homeDir,
              fleet: fleet.value,
              selection: selection.value,
              livePlan: initialPlan.value.plan,
              pair: pair.value,
            });
      if (!artifacts.ok) return artifacts;
      const projection = projectSyncFleetPlanV1(selection.value, authority.value, {
        ...preparedStores.bindings,
        ...(artifacts.value === null
          ? {}
          : {
              artifactPrefixOperationIdsByPair: artifacts.value.prefixOperationIdsByPair,
              compatibilityOperations: artifacts.value.operations.map(({ operation }) => operation),
            }),
      });
      if (!projection.ok) return err(syncError(projection.error));
      const planned = createSyncPlan(projection.value.request, authority.value.snapshot, {
        registry: toolRegistry,
        toolOrder: toolRegistry.ids,
      });
      if (!planned.ok) return err(genericError(planned.error.message));
      const plan = planned.value.plan;
      const preconditions = Object.freeze([
        ...createPlacementRevisionExecutionPreconditionsV1(
          authority.value,
          plan,
          planned.value.expectedRevisions,
        ),
        ...contentPreconditions(context, fleet.value, selection.value, plan),
        ...(artifacts.value?.preconditions ?? []),
      ]);
      const report = previewSyncReport(
        request,
        fleet.value,
        selection.value,
        plan,
        artifactPairDto(pair.value, request, fleet.value),
      );
      const token: PreparedSyncApplication = Object.freeze({ report });
      defaultPrepared.set(token, {
        report,
        request,
        fleet: fleet.value,
        selection: selection.value,
        projection: projection.value,
        authority: authority.value,
        plan,
        expectedRevisions: planned.value.expectedRevisions,
        preconditions,
        stores: preparedStores.stores,
        artifacts: artifacts.value,
        consumed: false,
      });
      return ok(token);
    } catch (error) {
      return err(
        error !== null && typeof error === 'object' && 'code' in error
          ? (error as SkillSmithError)
          : genericError(
              `sync preparation failed${error instanceof Error ? `: ${error.message}` : ''}`,
              error,
            ),
      );
    }
  },
  execute: async (token: PreparedSyncApplication, context: CurrentApplicationContext) => {
    const prepared = defaultPrepared.get(token);
    if (prepared === undefined)
      return err(invalidArgumentError('sync preparation token is invalid'));
    if (prepared.consumed) return err(flipRefusedError('sync preparation was already consumed'));
    prepared.consumed = true;
    const selectedByOperation = new Map(
      prepared.plan.operations.flatMap((operation) => {
        const selected = prepared.selection.pairs.find(
          ({ pair }) => pair.skill === operation.skill && pair.tool === operation.tool,
        );
        return selected === undefined ? [] : [[operation.operationId, selected] as const];
      }),
    );
    const projectedByOperation = new Map(
      prepared.plan.operations.flatMap((operation) => {
        const projected = prepared.projection.pairs.find(
          ({ skill, tool }) => skill === operation.skill && tool === operation.tool,
        );
        return projected === undefined ? [] : [[operation.operationId, projected] as const];
      }),
    );
    const artifactByOperation = new Map(
      (prepared.artifacts?.operations ?? []).map(({ operation, action }) => [
        operation.operationId,
        action,
      ]),
    );
    const forceFor = (operation: ExecutableOperation) =>
      operation.conflict === null
        ? createBoundedForceEffect({
            supported: true,
            requested: prepared.request.force,
            conflict: null,
          })
        : createBoundedForceEffect({
            supported: true,
            requested: true,
            conflict: operation.conflict,
          });
    try {
      const executePreparedPlan = (
        authority: PreparedDefaultSyncV1['authority'],
        preconditions: readonly ExecutionPrecondition[],
        artifactController: ReturnType<typeof createArtifactPairOperationControllerV1> | null,
      ) =>
        executePlacementOperationPlan({
          env: context.ports,
          ledgerPath: prepared.fleet.destination.ledgerPath,
          plan: prepared.plan,
          preconditions,
          authority,
          reportOp: 'sync',
          modelNow: () => context.ports.wallNowIso(),
          journalNow: () => context.ports.wallNowIso(),
          bindingForOperation: (operation) => {
            const artifactAction = artifactByOperation.get(operation.operationId);
            if (artifactAction !== undefined) {
              if (artifactController === null) {
                throw new Error('sync artifact execution authority is missing');
              }
              return {
                kind: 'external',
                binding: artifactController.bind(operation, artifactAction),
              };
            }
            const projected = projectedByOperation.get(operation.operationId);
            if (projected === undefined) throw new Error('sync operation binding is missing');
            const own = new Set([
              projected.liveResourceId,
              ...(projected.storeResourceId === null ? [] : [projected.storeResourceId]),
            ]);
            const mutable = [...authority.snapshot.live, ...authority.snapshot.store]
              .map(({ revision }) => revision)
              .filter(
                (revision): revision is typeof revision & Readonly<{ parentIdentity: string }> =>
                  'parentIdentity' in revision,
              );
            const parents = new Set(
              mutable
                .filter(({ resourceId }) => own.has(resourceId))
                .map(({ parentIdentity }) => parentIdentity),
            );
            return {
              kind: 'pair',
              stageResourceIds: Object.freeze(
                mutable
                  .filter(
                    ({ resourceId, parentIdentity }) =>
                      own.has(resourceId) || parents.has(parentIdentity),
                  )
                  .map(({ resourceId }) => resourceId),
              ),
            };
          },
          forceForOperation: forceFor,
          executePair: async (operation, ledger, observation) => {
            const selected = selectedByOperation.get(operation.operationId);
            if (selected === undefined) throw new Error('sync selected pair binding is missing');
            let store: PreparedSyncStoreV1 | null = null;
            let pinned: PinnedRecord | null = null;
            let origin: OriginRecord | null = null;
            if (selected.action === 'converge') {
              store = prepared.stores.get(selected.bindingKey) ?? null;
              if (store === null) throw new Error('sync selected store binding is missing');
              const snapshot = await snapshotToStore(context.ports, {
                sourceDir: store.sourcePath,
                skill: store.skill,
                storeRoot: storeRootOf(resolveDataDir(context.ports, context.configuration)),
                provenance: store.provenance,
                txId: context.ports.nextId('sync-store'),
              });
              if (!snapshot.ok) {
                return {
                  skill: selected.pair.skill,
                  tool: selected.pair.tool,
                  placementPath: selected.pair.placement.path,
                  action: 'failed',
                  reason: errorText(snapshot.error),
                  before: null,
                  after: null,
                  store: null,
                  verify: null,
                  error: snapshot.error,
                } satisfies FlipResult;
              }
              if (
                resolve(snapshot.value.storePath) !== resolve(store.storePath) ||
                snapshot.value.rev !== store.rev ||
                snapshot.value.contentHash !== store.contentHash
              ) {
                throw flipRefusedError('sync store snapshot differs from the approved plan');
              }
              pinned = {
                storePath: store.storePath,
                rev: store.rev,
                gitSha: store.provenance.gitSha,
                dirty: false,
                contentHash: store.contentHash,
                snapshotAt: context.ports.wallNowIso(),
                verify: 'passed',
                placement: selected.representation,
              };
              if (selected.operationSource?.kind === 'portable') {
                const source = selected.operationSource;
                origin = {
                  source: `${source.identity.host}/${source.identity.repository}${
                    source.identity.path === null ? '' : `//${source.identity.path}`
                  }`,
                  host: source.identity.host,
                  repo: source.identity.repository,
                  skillPath: source.sourcePath,
                  refRequested: source.requestedRef,
                  refResolved: source.resolvedSha,
                  pin: false,
                  installedAt: context.ports.wallNowIso(),
                };
              }
              if (
                selected.representation === 'symlink' &&
                (await context.ports.pathKind(dirname(selected.pair.placement.path))) === 'absent'
              ) {
                await context.ports.makeDir(dirname(selected.pair.placement.path));
              }
            }
            const executed = await executeSyncPlacementV1({
              env: context.ports,
              ledgerPath: prepared.fleet.destination.ledgerPath,
              ledger,
              operation,
              binding: {
                operationId: operation.operationId,
                placementPath: selected.pair.placement.path,
                scopeKey: selected.pair.scopeKey,
                storePath: store?.storePath ?? null,
                pinned,
                origin,
              },
              force: prepared.request.force,
              deps: {},
              options: context.signal === undefined ? {} : { signal: context.signal },
              ...(observation === undefined ? {} : { observation }),
            });
            const base = {
              skill: selected.pair.skill,
              tool: selected.pair.tool,
              placementPath: selected.pair.placement.path,
              before: null,
              after: null,
              store: null,
              verify: null,
            } as const;
            return executed.ok
              ? ({ ...base, action: 'updated', reason: null } satisfies FlipResult)
              : ({
                  ...base,
                  action: executed.error.code === 'flip-refused' ? 'refused' : 'failed',
                  reason: errorText(executed.error),
                  error: executed.error,
                } satisfies FlipResult);
          },
          onStarted: () => undefined,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          observation: context.observation,
          ...(artifactController === null ? {} : { locks: [] }),
        });
      const results = await withPlacementLedgerBootstrapAuthorityV1(
        {
          env: context.ports,
          artifactCoordinator: context.artifactCoordinator,
          ledgerPath: prepared.fleet.destination.ledgerPath,
          rollbackOnResult: (results: readonly OperationExecutionResult[]) =>
            results.length === 0 || results.some(({ outcome }) => outcome !== 'succeeded'),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
        async (bootstrap) => {
          const rebound = await rebindPlacementSnapshotAuthorityForLedgerBootstrapV1(
            prepared.authority,
            bootstrap,
          );
          if (!rebound.ok) throw rebound.error;
          const revisionPreconditionIds = new Set<string>(
            prepared.expectedRevisions.map(createExpectedRevisionPreconditionIdV1),
          );
          const preconditions = Object.freeze([
            ...createPlacementRevisionExecutionPreconditionsV1(
              rebound.value,
              prepared.plan,
              prepared.expectedRevisions,
            ),
            ...prepared.preconditions.filter(
              ({ preconditionId }) => !revisionPreconditionIds.has(preconditionId),
            ),
          ]);
          const artifactPair = prepared.artifacts?.pair ?? null;
          return artifactPair === null
            ? executePreparedPlan(rebound.value, preconditions, null)
            : withArtifactPairExecutionAuthority(
                {
                  artifactCoordinator: context.artifactCoordinator,
                  lockPort: context.ports,
                  pair: artifactPair,
                  ledgerPath: prepared.fleet.destination.ledgerPath,
                  ...(context.signal === undefined ? {} : { signal: context.signal }),
                },
                async (lease) =>
                  executePreparedPlan(
                    rebound.value,
                    preconditions,
                    createArtifactPairOperationControllerV1({
                      lease,
                      artifactCoordinator: context.artifactCoordinator,
                      pair: artifactPair,
                      ...(context.signal === undefined ? {} : { signal: context.signal }),
                    }),
                  ),
              );
        },
      );
      return ok(executedSyncReport(prepared, results));
    } catch (error) {
      return err(
        context.signal?.aborted
          ? cancelledError('sync was cancelled')
          : error !== null && typeof error === 'object' && 'code' in error
            ? (error as SkillSmithError)
            : genericError('sync execution failed', error),
      );
    }
  },
});

const executedSyncReport = (
  prepared: PreparedDefaultSyncV1,
  results: readonly OperationExecutionResult[],
): SyncReportV1Dto => {
  const resultById = new Map(results.map((result) => [result.operationId, result]));
  const groups = Object.freeze(
    prepared.report.groups.map((group) => ({
      ...group,
      pairs: Object.freeze(
        group.pairs.map((pair) => {
          const operation = prepared.plan.operations.find(
            (candidate) => candidate.groupId === group.groupId && candidate.tool === pair.tool,
          );
          const relevantOperations = prepared.plan.operations.filter(
            (candidate) =>
              candidate.groupId === group.groupId &&
              (candidate.pairId === null || candidate.tool === pair.tool),
          );
          const relevantResults = relevantOperations.flatMap((candidate) => {
            const result = resultById.get(candidate.operationId);
            return result === undefined ? [] : [result];
          });
          const failedResult = relevantResults.find(({ outcome }) => outcome === 'failed');
          const outcome =
            failedResult !== undefined
              ? ('failed' as const)
              : relevantResults.some(({ outcome: resultOutcome }) => resultOutcome === 'cancelled')
                ? ('cancelled' as const)
                : relevantResults.some(
                      ({ outcome: resultOutcome }) => resultOutcome === 'skipped-after-failure',
                    )
                  ? ('skipped' as const)
                  : relevantOperations.length === 0 ||
                      (relevantResults.length === relevantOperations.length &&
                        relevantResults.every(
                          ({ outcome: resultOutcome }) => resultOutcome === 'succeeded',
                        ))
                    ? ('succeeded' as const)
                    : ('not-run' as const);
          return {
            ...pair,
            outcome,
            skipReason: outcome === 'skipped' ? 'skipped-after-failure' : null,
            failure:
              outcome === 'failed'
                ? {
                    code: failedResult?.error?.code ?? 'sync-execution-failed',
                    message: failedResult?.error?.message ?? 'sync operation failed',
                  }
                : null,
            force: forceProjection(
              prepared.request,
              operation ?? null,
              outcome === 'succeeded'
                ? 'succeeded'
                : outcome === 'failed'
                  ? 'failed'
                  : outcome === 'cancelled'
                    ? 'cancelled'
                    : 'not-run',
            ),
          };
        }),
      ),
    })),
  );
  const effects = Object.freeze(
    prepared.report.effects.map((effect) => {
      const result = effect.operationId === null ? undefined : resultById.get(effect.operationId);
      return {
        ...effect,
        outcome:
          result?.outcome === 'succeeded'
            ? ('succeeded' as const)
            : result?.outcome === 'failed'
              ? ('failed' as const)
              : result?.outcome === 'cancelled'
                ? ('cancelled' as const)
                : ('not-run' as const),
      };
    }),
  );
  const diagnostics = prepared.report.diagnostics;
  const completed = groups
    .flatMap(({ pairs }) => pairs)
    .every(({ outcome }) => outcome === 'succeeded');
  return Object.freeze({
    ...prepared.report,
    state: completed ? 'completed' : 'partial',
    groups,
    effects,
    summary: reportSummary(groups, effects, diagnostics),
  });
};

export const runSyncApplication: ApplicationService<
  CurrentCommandRequest,
  SyncApplicationReport
> = async (request, context) => {
  const normalized = normalize(request);
  if (!normalized.ok) return failure('usage', 'invalid-sync-usage', normalized.message);
  const sync = context.sync ?? defaultSyncApplicationPort;
  const preparedResult = await sync.prepare(normalized.value, context);
  if (!preparedResult.ok) {
    return failure(
      errorExitClass(preparedResult.error),
      preparedResult.error.code,
      errorText(preparedResult.error),
    );
  }
  if (!requestMatchesReport(normalized.value, preparedResult.value.report)) {
    return failure(
      'failure',
      'invalid-sync-report',
      'sync adapter preparation does not match the normalized request',
    );
  }
  const preparedReport = validatedReport(preparedApprovalReport(preparedResult.value.report));
  if (!preparedReport.ok)
    return failure('failure', preparedReport.diagnostic.code, preparedReport.diagnostic.message);
  if (normalized.value.dryRun || preparedReport.value.state === 'refused')
    return success(preparedReport.value);

  if (preparedReport.value.approval.required) {
    const approval = await context.interaction.confirm({
      id: 'sync.exact-plan',
      message: 'Execute this exact sync plan?',
      preview: {
        kind: 'exact-sync-preview',
        command: 'sync',
        groupIds: preparedReport.value.selection.groupIds,
        operationIds: preparedReport.value.operations.map(({ operationId }) => operationId),
      },
    });
    if (approval.status === 'cancelled') {
      return failure(
        'cancelled',
        'sync-cancelled',
        'sync was cancelled',
        approvalReport(preparedReport.value, 'cancelled'),
      );
    }
    if (approval.status === 'refused' || approval.value !== true) {
      return failure(
        'usage',
        'sync-approval-required',
        approval.status === 'refused' ? approval.reason : 'sync approval was refused',
        approvalReport(preparedReport.value, 'refused'),
      );
    }
  }

  const approvalRequired = preparedReport.value.approval.required;
  const executed = await sync.execute(preparedResult.value, context);
  if (!executed.ok)
    return failure(errorExitClass(executed.error), executed.error.code, errorText(executed.error));
  if (!requestMatchesReport(normalized.value, executed.value)) {
    return failure(
      'failure',
      'invalid-sync-report',
      'sync adapter execution does not match the normalized request',
    );
  }
  const report = validatedReport(executedApprovalReport(executed.value, approvalRequired));
  return report.ok
    ? success(report.value)
    : failure('failure', report.diagnostic.code, report.diagnostic.message);
};
