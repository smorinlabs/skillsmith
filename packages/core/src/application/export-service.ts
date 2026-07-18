import { join } from 'node:path';
import { type BuiltInToolId, SUPPORTED_TOOLS } from '../agents/registry.ts';
import { type ResolvedArtifactPair, resolveArtifactPair } from '../artifacts/pair.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import {
  type ExportFailure,
  type ExportReport,
  type ExportRequest,
  type ExportResult,
  type ExportSourceScope,
  classifyExport,
  executeExportArtifacts,
  mergePortableCandidates,
  observeExport,
  prepareExportArtifacts,
  prepareExportLedgerMigration,
  previewExportEffects,
} from '../export/index.ts';
import type {
  ApplicationService,
  CurrentApplicationContext,
  CurrentCommandRequest,
  Diagnostic,
} from './types.ts';

const isTool = (value: string): value is BuiltInToolId =>
  (SUPPORTED_TOOLS as readonly string[]).includes(value);

const stringOption = (request: CurrentCommandRequest, name: string): string | undefined =>
  typeof request.options[name] === 'string' ? request.options[name] : undefined;

const enabled = (request: CurrentCommandRequest, name: string): boolean =>
  request.options[name] === true;

const selectedTools = (request: CurrentCommandRequest): readonly BuiltInToolId[] | null => {
  const value = request.options.tool;
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  if (!raw.every((tool): tool is string => typeof tool === 'string' && isTool(tool))) return null;
  const selected = new Set(raw);
  return Object.freeze(SUPPORTED_TOOLS.filter((tool) => selected.has(tool)));
};

const explicitScope = (request: CurrentCommandRequest): ExportSourceScope | null | false => {
  const selected: ExportSourceScope[] = [];
  const scope = stringOption(request, 'scope');
  if (
    scope !== undefined &&
    scope !== 'user' &&
    scope !== 'project' &&
    scope !== 'system' &&
    scope !== 'managed'
  ) {
    return false;
  }
  if (scope !== undefined) selected.push(scope);
  for (const candidate of ['user', 'project', 'system', 'managed'] as const) {
    if (enabled(request, candidate)) selected.push(candidate);
  }
  if (selected.length > 1) return false;
  return selected[0] ?? null;
};

const failureDiagnostic = (failure: ExportFailure): Diagnostic =>
  Object.freeze({ code: failure.code, severity: 'error', message: failure.message });

const selectionReport = (
  pair: ResolvedArtifactPair | null,
  selectedBy: 'explicit-file' | 'project' | 'user',
): ExportReport['artifactSelection'] =>
  pair === null
    ? Object.freeze({ outcome: 'none', reason: 'no-portable-candidates' })
    : Object.freeze({
        outcome: 'selected',
        selectedBy,
        manifestPath: pair.file.path,
        lockPath: pair.lockfile.path,
        lockSource: pair.lockfileSource,
      });

const reportOf = (
  request: ExportRequest,
  selection: ExportReport['artifactSelection'],
  results: readonly ExportResult[],
  effects: ExportReport['effects'],
  changed: number,
  unchanged: number,
): ExportReport => {
  const portable = results.filter((result) => result.action !== 'skipped').length;
  const skipped = results.length - portable;
  return Object.freeze({
    schemaVersion: 1,
    kind: 'skillsmith.export',
    reportVersion: 1,
    dryRun: request.dryRun,
    requested: Object.freeze({
      tools: request.tools,
      explicitTools: request.explicitTools,
      scope: request.scope,
      explicitScope: request.explicitScope,
      strict: request.strict,
      force: request.force,
    }),
    artifactSelection: selection,
    results: Object.freeze(results),
    effects: Object.freeze(effects),
    summary: Object.freeze({
      observed: results.length,
      portable,
      skipped,
      conflicts: 0,
      changed,
      unchanged,
    }),
  });
};

const failedReport = (
  request: ExportRequest,
  failure: ExportFailure,
  results: readonly ExportResult[] = [],
): ExportReport =>
  reportOf(
    request,
    Object.freeze({ outcome: 'refused', reason: failure.code }),
    results,
    failure.effects ?? [],
    0,
    0,
  );

const resolvePair = async (
  context: CurrentApplicationContext,
  project: ProjectContext,
  request: ExportRequest,
): Promise<
  | { pair: ResolvedArtifactPair | null; selectedBy: 'explicit-file' | 'project' | 'user' }
  | ExportFailure
> => {
  const selectedBy =
    request.file !== undefined ? 'explicit-file' : request.scope === 'project' ? 'project' : 'user';
  if (request.file === undefined && request.scope !== 'user' && request.scope !== 'project') {
    return { pair: null, selectedBy };
  }
  const discoveredFile =
    request.file !== undefined
      ? undefined
      : request.scope === 'user'
        ? join(context.ports.xdg.config, 'skillsmith', 'skillsmith.toml')
        : (project.discoveredConfigPath ??
          join(project.projectRoot ?? project.effectiveCwd, 'skillsmith.toml'));
  const resolved = await resolveArtifactPair(context.ports, project, {
    ...(discoveredFile === undefined ? {} : { discoveredFile }),
    ...(request.file === undefined ? {} : { file: request.file }),
    ...(request.lockfile === undefined ? {} : { lockfile: request.lockfile }),
  });
  return resolved.ok
    ? { pair: resolved.value, selectedBy }
    : Object.freeze({
        code: resolved.error.code,
        message: resolved.error.message,
        exitClass: resolved.error.exitClass,
      });
};

export const runExportApplication: ApplicationService<CurrentCommandRequest, ExportReport> = async (
  command,
  context,
) => {
  const tools = selectedTools(command);
  const scopeOption = explicitScope(command);
  const placeholderRequest: ExportRequest = Object.freeze({
    tools: tools ?? Object.freeze([]),
    explicitTools: (tools?.length ?? 0) > 0,
    scope: scopeOption && typeof scopeOption === 'string' ? scopeOption : 'user',
    explicitScope: scopeOption !== null && scopeOption !== false,
    strict: enabled(command, 'strict'),
    force: enabled(command, 'force'),
    dryRun: enabled(command, 'dryRun'),
  });
  if (tools === null || scopeOption === false) {
    const failure: ExportFailure = Object.freeze({
      code: 'export-invalid-selection',
      message: 'export tool or scope selection is invalid',
      exitClass: 'usage',
    });
    return {
      report: failedReport(placeholderRequest, failure),
      diagnostics: [failureDiagnostic(failure)],
      exitClass: failure.exitClass,
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
  }

  const project = await resolveProjectContext(context.ports, {
    invocationCwd: context.invocationCwd,
    ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
    ...(context.globalOptions.config === undefined
      ? {}
      : { explicitConfigPath: context.globalOptions.config }),
  });
  if (!project.ok) {
    const failure: ExportFailure = Object.freeze({
      code: 'export-project-context',
      message: 'project context could not be resolved',
      exitClass: 'state',
    });
    return {
      report: failedReport(placeholderRequest, failure),
      diagnostics: [failureDiagnostic(failure)],
      exitClass: failure.exitClass,
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
  }

  const scope = scopeOption ?? (project.value.projectRoot === null ? 'user' : 'project');
  const request: ExportRequest = Object.freeze({
    tools: tools.length === 0 ? SUPPORTED_TOOLS : tools,
    explicitTools: tools.length > 0,
    scope,
    explicitScope: scopeOption !== null,
    ...(stringOption(command, 'file') === undefined
      ? {}
      : { file: stringOption(command, 'file') as string }),
    ...(stringOption(command, 'lockfile') === undefined
      ? {}
      : { lockfile: stringOption(command, 'lockfile') as string }),
    strict: enabled(command, 'strict'),
    force: enabled(command, 'force'),
    dryRun: enabled(command, 'dryRun'),
  });
  const pairResult = await resolvePair(context, project.value, request);
  if ('code' in pairResult) {
    return {
      report: failedReport(request, pairResult),
      diagnostics: [failureDiagnostic(pairResult)],
      exitClass: pairResult.exitClass,
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
  }

  const observed = await observeExport(context, project.value, request, pairResult.pair);
  if (!observed.ok) {
    return {
      report: failedReport(request, observed.error),
      diagnostics: [failureDiagnostic(observed.error)],
      exitClass: observed.error.exitClass,
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
  }
  const classified = await classifyExport(context, observed.value);
  if (!classified.ok) {
    return {
      report: failedReport(request, classified.error),
      diagnostics: [failureDiagnostic(classified.error)],
      exitClass: classified.error.exitClass,
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
  }
  const merged = mergePortableCandidates(classified.value.portable);
  if (!merged.ok) {
    return {
      report: failedReport(request, merged.error, classified.value.results),
      diagnostics: [failureDiagnostic(merged.error)],
      exitClass: merged.error.exitClass,
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
  }
  const skippedResults = classified.value.results.filter((result) => result.action === 'skipped');
  const portableResults: ExportResult[] = merged.value.map((candidate) =>
    Object.freeze({ ...candidate, action: 'add' as const, reason: null }),
  );
  const results = Object.freeze([...portableResults, ...skippedResults]);
  const diagnostics: Diagnostic[] = skippedResults.map((result) =>
    Object.freeze({
      code: `export-${result.reason}`,
      severity: 'warning' as const,
      message: `${result.name} was not portable (${result.reason})`,
    }),
  );

  if (request.strict && skippedResults.length > 0) {
    return {
      report: reportOf(
        request,
        selectionReport(pairResult.pair, pairResult.selectedBy),
        results,
        [],
        0,
        0,
      ),
      diagnostics,
      exitClass: 'failure',
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
  }
  if (merged.value.length === 0) {
    return {
      report: reportOf(
        request,
        Object.freeze({
          outcome: 'none',
          reason:
            observed.value.inventory.selection.outcome === 'filter-noop'
              ? 'filter-noop'
              : 'no-portable-candidates',
        }),
        results,
        [],
        0,
        0,
      ),
      diagnostics,
      exitClass: 'success',
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
  }

  const prepared = prepareExportArtifacts(observed.value, merged.value);
  if (!prepared.ok) {
    return {
      report: failedReport(request, prepared.error, results),
      diagnostics: [...diagnostics, failureDiagnostic(prepared.error)],
      exitClass: prepared.error.exitClass,
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
  }
  const effects = request.dryRun
    ? {
        ok: true as const,
        value: previewExportEffects(
          prepared.value,
          prepareExportLedgerMigration(context, observed.value, prepared.value),
        ),
      }
    : await executeExportArtifacts(
        context,
        observed.value,
        prepared.value,
        prepareExportLedgerMigration(context, observed.value, prepared.value),
      );
  if (!effects.ok) {
    return {
      report: failedReport(request, effects.error, results),
      diagnostics: [...diagnostics, failureDiagnostic(effects.error)],
      exitClass: effects.error.exitClass,
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 1 },
      deprecations: [],
    };
  }
  const changed =
    prepared.value.manifestChanged || prepared.value.lockChanged ? merged.value.length : 0;
  const unchanged = changed === 0 ? merged.value.length : 0;
  return {
    report: reportOf(
      request,
      selectionReport(pairResult.pair, pairResult.selectedBy),
      results,
      effects.value,
      changed,
      unchanged,
    ),
    diagnostics,
    exitClass: 'success',
    mutation: {
      kind: request.dryRun ? 'preview' : changed > 0 ? 'applied' : 'none',
      planned: effects.value.filter((effect) => effect.operationId !== null).length,
      changed,
      unchanged,
      failed: 0,
    },
    deprecations: [],
  };
};
