import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { toolRegistry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { writeSavedPlan } from '../artifacts/plan-writer.ts';
import { artifactContractRegistry } from '../artifacts/registry.ts';
import type {
  PlanCheckV1Dto,
  PlanDiagnosticV1Dto,
  PlanOperationV1Dto,
  PlanV1Dto,
} from '../contracts/v1/plan.ts';
import { isNormalizedPortError } from '../ports/errors.ts';
import type { FileReadPort } from '../ports/types.ts';
import { prepareReconcilePlan } from '../reconcile/index.ts';
import type { SavedPlanProjection } from '../reconcile/saved.ts';
import type { PlanReconcileError, ReconcilePlanProduct } from '../reconcile/types.ts';
import type { CommandExitClass, Diagnostic } from './types.ts';
import {
  type ApplicationService,
  type CommandOutcome,
  type CurrentCommandRequest,
  NO_MUTATION,
} from './types.ts';

export interface PlanApplicationReport {
  readonly result: PlanV1Dto | null;
}

const optionString = (request: CurrentCommandRequest, key: string): string | undefined => {
  const value = request.options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const singularScalarOptions = [
  { key: 'file', flag: '--file', noun: 'path' },
  { key: 'lockfile', flag: '--lockfile', noun: 'path' },
  { key: 'scope', flag: '--scope', noun: 'value' },
  { key: 'out', flag: '--out', noun: 'path' },
] as const;

const optionStrings = (request: CurrentCommandRequest, key: string): readonly string[] => {
  const value = request.options[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
};

const enabled = (request: CurrentCommandRequest, key: string): boolean =>
  request.options[key] === true;

const isWithin = (root: string, candidate: string): boolean => {
  const displacement = relative(root, candidate);
  return (
    displacement.length === 0 ||
    (displacement !== '..' && !displacement.startsWith('../') && !isAbsolute(displacement))
  );
};

/** Resolve through the nearest existing ancestor so a symlinked parent cannot bypass protection. */
const canonicalProtectionPath = async (ports: FileReadPort, path: string): Promise<string> => {
  let cursor = resolve(path);
  const missing: string[] = [];
  while ((await ports.pathKind(cursor)) === 'absent') {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    missing.push(basename(cursor));
    cursor = parent;
  }
  const canonicalAncestor = await ports.realpath(cursor);
  return resolve(canonicalAncestor, ...missing.reverse());
};

const outcome = (
  report: PlanApplicationReport,
  exitClass: CommandExitClass,
  diagnostics: readonly Diagnostic[] = [],
): CommandOutcome<PlanApplicationReport> => ({
  report,
  diagnostics,
  exitClass,
  mutation: NO_MUTATION,
  deprecations: [],
});

const failed = (
  error: PlanReconcileError,
  report: PlanApplicationReport = { result: null },
): CommandOutcome<PlanApplicationReport> =>
  outcome(report, error.exitClass, [
    { code: error.code, severity: 'error', message: error.message },
  ]);

const refusalOutcome = (
  report: PlanApplicationReport,
  refusals: readonly Readonly<{
    readonly refusalClass: NonNullable<PlanDiagnosticV1Dto['refusalClass']>;
    readonly reason: Readonly<{ readonly code: string; readonly message: string }>;
  }>[],
): CommandOutcome<PlanApplicationReport> => {
  const precedence = {
    usage: 2,
    state: 3,
    capability: 4,
    source: 5,
    permission: 6,
  } as const;
  const refusalClasses = refusals
    .map(({ refusalClass }) => refusalClass)
    .filter((value): value is NonNullable<PlanDiagnosticV1Dto['refusalClass']> => value !== null);
  const exitClass = refusalClasses.reduce((selected, candidate) =>
    precedence[candidate] > precedence[selected] ? candidate : selected,
  );
  return outcome(
    report,
    exitClass,
    refusals.map((diagnostic) => ({
      code: diagnostic.reason.code,
      severity: 'error',
      message: diagnostic.reason.message,
    })),
  );
};

const scopeFor = (
  request: CurrentCommandRequest,
):
  | { readonly ok: true; readonly value: 'user' | 'project' | null }
  | {
      readonly ok: false;
      readonly error: PlanReconcileError;
    } => {
  const explicit = optionString(request, 'scope');
  const user = enabled(request, 'user');
  const project = enabled(request, 'project');
  const selected = [explicit !== undefined, user, project].filter(Boolean).length;
  if (selected > 1) {
    return {
      ok: false,
      error: {
        code: 'plan-scope-conflict',
        message: 'scope forms are mutually exclusive',
        exitClass: 'usage',
      },
    };
  }
  const value = explicit ?? (user ? 'user' : project ? 'project' : null);
  if (value !== null && value !== 'user' && value !== 'project') {
    return {
      ok: false,
      error: {
        code: 'plan-scope-invalid',
        message: `unknown scope '${value}'`,
        exitClass: 'usage',
      },
    };
  }
  return { ok: true, value };
};

const cancellationFailure = (): PlanReconcileError => ({
  code: 'plan-cancelled',
  message: 'plan was cancelled',
  exitClass: 'cancelled',
});

/**
 * Project one prepared reconciliation product into the versioned plan report shared by `plan`
 * and fresh `apply`. Callers may add command-specific lifecycle facts, but must not rebuild or
 * reinterpret the operation/check/diagnostic projection.
 */
export const projectPlanReport = (
  product: ReconcilePlanProduct,
  projection: SavedPlanProjection,
  savedOutput: PlanV1Dto['savedOutput'],
  artifactSelectionSource: PlanV1Dto['artifactPair']['selectionSource'],
): PlanV1Dto => {
  const operations: PlanOperationV1Dto[] = product.plan.operations.map(
    ({ dependencyMetadata: _dependencyMetadata, ...operation }, index) => {
      const projected = projection.plan.operations[index];
      if (projected === undefined) {
        throw new TypeError(`saved plan projection omitted operation '${operation.operationId}'`);
      }
      return {
        ...operation,
        operationId: projected.operationId,
        groupId: projected.groupId,
        pairId: projected.pairId,
        dependsOn: [...projected.dependsOn],
        preconditionIds: [...projected.preconditionIds],
        requiredCheckIds: [...projected.requiredCheckIds],
        reversibility: {
          ...operation.reversibility,
          retentionResourceIds: [...projected.reversibility.retentionResourceIds],
        },
      } as PlanOperationV1Dto;
    },
  );
  const checks: PlanCheckV1Dto[] = product.plan.checks
    .map((check) => {
      const projectedId = projection.checkIds.get(check.checkId);
      const projected = projection.plan.checks.find(({ checkId }) => checkId === projectedId);
      if (projected === undefined) {
        throw new TypeError(`saved plan projection omitted check '${check.checkId}'`);
      }
      return {
        ...check,
        checkId: projected.checkId,
        operationIds: [...projected.operationIds],
        ...('preconditionIds' in projected
          ? { preconditionIds: [...projected.preconditionIds] }
          : {}),
      } as PlanCheckV1Dto;
    })
    .sort((left, right) => left.checkId.localeCompare(right.checkId));
  const diagnostics: PlanDiagnosticV1Dto[] = product.plan.diagnostics
    .map((diagnostic) => {
      const projectedId = projection.diagnosticIds.get(diagnostic.diagnosticId);
      const projected = projection.plan.diagnostics.find(
        ({ diagnosticId }) => diagnosticId === projectedId,
      );
      if (projected === undefined) {
        throw new TypeError(
          `saved plan projection omitted diagnostic '${diagnostic.diagnosticId}'`,
        );
      }
      return {
        ...diagnostic,
        diagnosticId: projected.diagnosticId,
        affected: { ...diagnostic.affected },
        correlation: { ...projected.correlation },
        reason: { ...diagnostic.reason },
      } as PlanDiagnosticV1Dto;
    })
    .sort((left, right) => left.diagnosticId.localeCompare(right.diagnosticId));
  const refusals = diagnostics.filter((diagnostic) => diagnostic.kind === 'refuse').length;
  const countKinds = <Kind extends string>(
    kinds: readonly Kind[],
    rows: readonly Readonly<{ readonly kind: Kind }>[],
  ): Record<Kind, number> =>
    Object.fromEntries(
      kinds.map((kind) => [kind, rows.filter((row) => row.kind === kind).length]),
    ) as Record<Kind, number>;
  return {
    schemaVersion: 1,
    kind: 'skillsmith.plan-report',
    command: 'plan',
    state: refusals > 0 ? 'refused' : 'ready',
    artifactPair: {
      manifestPath: product.input.observed.pair.file.path,
      lockPath: product.input.observed.pair.lockfile.path,
      lockSource: product.input.observed.pair.lockfileSource,
      selectionSource: artifactSelectionSource,
    },
    project: {
      effectiveCwd: product.input.observed.project.effectiveCwd,
      root: product.input.observed.project.projectRoot,
      identity: product.input.observed.project.projectIdentity,
    },
    options: {
      locked: product.input.request.locked,
      prune: product.input.request.prune,
      check: product.input.request.check,
    },
    selection: {
      selectionSource: product.plan.selection.source,
      selectionOutcome: product.input.selectionOutcome,
      requestedTools: [...product.input.request.tools],
      requestedScope: product.input.request.scope,
      skills: [...product.input.selectedSkills],
      tools: [...product.input.selectedTools],
      scopes: [...product.input.selectedScopes],
    },
    operations,
    checks,
    diagnostics,
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
    },
    savedOutput,
  };
};

export const runPlanApplication: ApplicationService<
  CurrentCommandRequest,
  PlanApplicationReport
> = async (request, context) => {
  if (request.arguments.length > 0) {
    return failed({
      code: 'plan-positional-unsupported',
      message: 'plan accepts no positional arguments',
      exitClass: 'usage',
    });
  }
  for (const { key, flag, noun } of singularScalarOptions) {
    const value = request.options[key];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      return failed({
        code: `plan-${key}-invalid`,
        message: `${flag} requires a non-empty ${noun}`,
        exitClass: 'usage',
      });
    }
  }
  const file = optionString(request, 'file');
  const lockfile = optionString(request, 'lockfile');
  const out = optionString(request, 'out');
  if (lockfile !== undefined && file === undefined) {
    return failed({
      code: 'plan-lockfile-requires-file',
      message: '--lockfile requires --file',
      exitClass: 'usage',
    });
  }
  if (out === '-') {
    return failed({
      code: 'plan-output-stdout-unsupported',
      message: '--out - is unsupported; use --json for stdout',
      exitClass: 'usage',
    });
  }
  const check = enabled(request, 'check');
  const force = enabled(request, 'force');
  if (check && (out !== undefined || force)) {
    return failed({
      code: 'plan-check-output-conflict',
      message: '--check conflicts with --out and --force',
      exitClass: 'usage',
    });
  }
  if (force && out === undefined) {
    return failed({
      code: 'plan-force-requires-output',
      message: '--force requires --out',
      exitClass: 'usage',
    });
  }
  const scope = scopeFor(request);
  if (!scope.ok) return failed(scope.error);
  const tools = optionStrings(request, 'tool');
  if (new Set(tools).size !== tools.length) {
    return failed({
      code: 'plan-tool-duplicate',
      message: '--tool must not repeat the same tool',
      exitClass: 'usage',
    });
  }
  const unknownTool = tools.find((tool) => toolRegistry.get(tool) === undefined);
  if (unknownTool !== undefined) {
    return failed({
      code: 'plan-tool-invalid',
      message: `unknown tool '${unknownTool}'`,
      exitClass: 'usage',
    });
  }
  if (context.signal?.aborted) return failed(cancellationFailure());

  const explicitConfigPath =
    context.globalOptions.config ?? context.configuration.explicitConfigPath;
  const prepared = await prepareReconcilePlan(
    {
      ...(file === undefined ? {} : { file }),
      ...(lockfile === undefined ? {} : { lockfile }),
      tools: tools as readonly SupportedTool[],
      scope: scope.value,
      locked: enabled(request, 'locked'),
      prune: enabled(request, 'prune'),
      check: enabled(request, 'check'),
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
  if (!prepared.ok) return failed(prepared.error);
  const { product, projection, observation, artifactSelectionSource } = prepared.value;
  const project = product.input.observed.project;
  const pair = product.input.observed.pair;
  const observed = product.input.observed;
  const refusals = product.plan.diagnostics.filter(
    (
      diagnostic,
    ): diagnostic is typeof diagnostic & {
      readonly refusalClass: NonNullable<typeof diagnostic.refusalClass>;
    } => diagnostic.kind === 'refuse' && diagnostic.refusalClass !== null,
  );

  let savedOutput: PlanV1Dto['savedOutput'] = null;
  if (out !== undefined) {
    if (refusals.length > 0) {
      return refusalOutcome(
        { result: projectPlanReport(product, projection, null, artifactSelectionSource) },
        refusals,
      );
    }
    const outputPath = resolve(project.effectiveCwd, out);
    const protectedFiles = [
      pair.file.path,
      pair.lockfile.path,
      observed.ledgerPath,
      project.discoveredConfigPath,
      project.explicitConfigPath,
      context.configuration.explicitConfigPath,
      context.globalOptions.config,
    ].filter((path): path is string => typeof path === 'string');
    const registeredLiveRoots = toolRegistry.ids.flatMap((tool) => {
      const placement = toolRegistry.get(tool)?.placement;
      return placement === undefined
        ? []
        : (['user', 'project'] as const).flatMap((selectedScope) =>
            placement
              .rootFacts(context.ports, selectedScope, {
                cwd:
                  selectedScope === 'project'
                    ? (project.projectRoot ?? project.effectiveCwd)
                    : project.effectiveCwd,
                configuration: context.configuration,
              })
              .map((fact) => fact.path),
          );
    });
    const protectedRoots = [
      observation.storeRoot,
      resolve(context.ports.xdg.config, 'skillsmith'),
      ...registeredLiveRoots,
      ...observation.desiredPlacements.flatMap((item) =>
        item.state === 'observed' ? [item.placement.root] : [],
      ),
      ...observation.prunePlacements.map((item) => item.placement.root),
    ];
    let aliasesSelectedState: boolean;
    try {
      const canonicalOutput = await canonicalProtectionPath(context.ports, outputPath);
      const canonicalFiles = await Promise.all(
        protectedFiles.map((path) => canonicalProtectionPath(context.ports, path)),
      );
      const canonicalRoots = await Promise.all(
        protectedRoots.map((path) => canonicalProtectionPath(context.ports, path)),
      );
      aliasesSelectedState =
        canonicalFiles.some((path) => path === canonicalOutput) ||
        canonicalRoots.some((path) => isWithin(path, canonicalOutput));
    } catch (error) {
      return failed({
        code: 'plan-output-inspection',
        message: 'saved plan output aliases could not be inspected safely',
        exitClass:
          isNormalizedPortError(error) && error.code === 'permission' ? 'permission' : 'state',
      });
    }
    if (aliasesSelectedState) {
      return failed({
        code: 'plan-output-selected-state',
        message: '--out must not alias selected artifacts, configuration, live roots, or store',
        exitClass: 'usage',
      });
    }
    const saved = projection.plan;
    const savedPlanCodec = artifactContractRegistry.get('plan', 1);
    if (savedPlanCodec === undefined) {
      return failed({
        code: 'plan-output-contract',
        message: 'saved plan artifact codec 1 is unavailable',
        exitClass: 'failure',
      });
    }
    const encoded = savedPlanCodec.encode(saved);
    if (!encoded.ok) {
      return failed({
        code: 'plan-output-contract',
        message: encoded.error.message,
        exitClass: 'failure',
      });
    }
    if (context.signal?.aborted) return failed(cancellationFailure());
    const written = await writeSavedPlan(
      { ...context.artifactCoordinator, rename: context.ports.rename },
      {
        path: outputPath,
        bytes: encoded.value,
        force: enabled(request, 'force'),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
    );
    if (!written.ok) return failed(written.error);
    savedOutput = {
      ...written.value,
      portability: saved.portability.kind,
    };
  }

  const report = projectPlanReport(product, projection, savedOutput, artifactSelectionSource);
  if (refusals.length > 0) return refusalOutcome({ result: report }, refusals);
  return outcome(
    { result: report },
    enabled(request, 'check') && report.summary.drift > 0 ? 'drift' : 'success',
  );
};
