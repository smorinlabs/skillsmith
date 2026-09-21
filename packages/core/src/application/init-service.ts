import { join } from 'node:path';
import {
  type BuiltInToolId,
  type PlacementToolId,
  SUPPORTED_TOOLS,
  toolRegistry,
} from '../agents/registry.ts';
import { normalizeRegistryIdentity } from '../artifacts/identity.ts';
import { isInitConfigSnapshotEligible, planInitManifest } from '../artifacts/init.ts';
import { resolveArtifactPair, resolveExplicitArtifactPairLexically } from '../artifacts/pair.ts';
import { resolveEffectiveConfig } from '../config/effective.ts';
import type { EffectiveConfig } from '../config/types.ts';
import { resolveProjectContext } from '../context/project.ts';
import {
  executePreparedInit,
  observeInitManifest,
  prepareInitOperationPlan,
} from '../init/index.ts';
import type {
  InitArtifactSelection,
  InitDefaults,
  InitFailure,
  InitReport,
  InitRequest,
  InitSelectedBy,
  InitToolSource,
} from '../init/index.ts';
import { createBoundedForceEffect } from '../planning/create.ts';
import { detectTool } from '../scan/index.ts';
import { exitClassForApplicationError } from './exit-policy.ts';
import type {
  ApplicationService,
  CommandOutcome,
  CurrentCommandRequest,
  Diagnostic,
} from './types.ts';

const WRITABLE_TOOLS = Object.freeze([
  ...toolRegistry.toolsFor('plan'),
]) as readonly PlacementToolId[];
const writable = new Set<string>(WRITABLE_TOOLS);

export type InitApplicationReport = InitReport | null;

const stringOption = (request: CurrentCommandRequest, name: string): string | undefined =>
  typeof request.options[name] === 'string' ? request.options[name] : undefined;
const enabled = (request: CurrentCommandRequest, name: string): boolean =>
  request.options[name] === true;

const fail = (failure: InitFailure): CommandOutcome<InitApplicationReport> => ({
  report: null,
  diagnostics: [
    Object.freeze({
      code: failure.code,
      severity: 'error' as const,
      message: failure.message,
    }),
  ],
  exitClass: failure.exitClass,
  mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
  deprecations: [],
});

const selectedScope = (request: CurrentCommandRequest): 'user' | 'project' | null | false => {
  const values: ('user' | 'project')[] = [];
  const scope = stringOption(request, 'scope');
  if (scope !== undefined && scope !== 'user' && scope !== 'project') return false;
  if (scope !== undefined) values.push(scope);
  if (enabled(request, 'user')) values.push('user');
  if (enabled(request, 'project')) values.push('project');
  return values.length > 1 ? false : (values[0] ?? null);
};

const explicitTools = (request: CurrentCommandRequest): readonly BuiltInToolId[] | null => {
  const raw = request.options.tool;
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  if (
    values.some(
      (value) =>
        typeof value !== 'string' || !(SUPPORTED_TOOLS as readonly string[]).includes(value),
    )
  ) {
    return null;
  }
  const selected = new Set(values as BuiltInToolId[]);
  return Object.freeze(SUPPORTED_TOOLS.filter((tool) => selected.has(tool)));
};

const configuredTools = (config: EffectiveConfig): readonly BuiltInToolId[] => {
  const tools =
    config.toolSelection?.tools ??
    config.value.tools ??
    (config.value.tool === undefined ? [] : [config.value.tool]);
  const selected = new Set(tools);
  return Object.freeze(SUPPORTED_TOOLS.filter((tool) => selected.has(tool)));
};

const capabilityFailure = (message: string): InitFailure =>
  Object.freeze({ code: 'capability', message, exitClass: 'capability' as const });

const diagnosticForDetection = (tool: string): InitFailure =>
  Object.freeze({
    code: 'init-detection',
    message: `init could not determine whether ${tool} is available`,
    exitClass: 'failure' as const,
  });

const reportEffects = (
  action: InitReport['result']['action'],
  operationId: string | null,
  dryRun: boolean,
): InitReport['effects'] =>
  Object.freeze([
    Object.freeze({
      role: 'manifest' as const,
      action:
        action === 'create-manifest'
          ? ('create' as const)
          : action === 'replace-manifest'
            ? ('replace' as const)
            : action === 'migrate-project-config'
              ? ('migrate' as const)
              : ('unchanged' as const),
      operationId,
      outcome:
        action === 'noop'
          ? ('not-run' as const)
          : dryRun
            ? ('planned' as const)
            : ('succeeded' as const),
    }),
    Object.freeze({
      role: 'lock' as const,
      action: 'not-written' as const,
      operationId: null,
      outcome: 'not-run' as const,
    }),
    Object.freeze({
      role: 'live' as const,
      action: 'not-written' as const,
      operationId: null,
      outcome: 'not-run' as const,
    }),
    Object.freeze({
      role: 'ledger' as const,
      action: 'not-written' as const,
      operationId: null,
      outcome: 'not-run' as const,
    }),
  ]);

export const runInitApplication: ApplicationService<
  CurrentCommandRequest,
  InitApplicationReport
> = async (command, context) => {
  const toolsOption = explicitTools(command);
  const scopeOption = selectedScope(command);
  if (toolsOption === null || scopeOption === false) {
    return fail({
      code: 'init-invalid-selection',
      message: 'init tool or scope selection is invalid',
      exitClass: 'usage',
    });
  }
  if (toolsOption.some((tool) => !writable.has(tool))) {
    return fail(
      capabilityFailure('init supports writable Claude Code, Codex, and Muse manifests only'),
    );
  }

  const explicitConfigPath =
    context.globalOptions.config ?? context.configuration.explicitConfigPath;
  const project = await resolveProjectContext(context.ports, {
    invocationCwd: context.invocationCwd,
    ...(context.globalOptions.cd === undefined ? {} : { cd: context.globalOptions.cd }),
    ...(explicitConfigPath === undefined ? {} : { explicitConfigPath }),
  });
  if (!project.ok) {
    return fail({
      code: 'init-project-context',
      message: 'init project context could not be resolved',
      exitClass: 'state',
    });
  }

  const explicitFile = stringOption(command, 'file');
  let selectedBy: InitSelectedBy;
  let discoveredFile: string | undefined;
  if (explicitFile !== undefined) {
    selectedBy = 'explicit-file';
  } else if (scopeOption === 'user') {
    selectedBy = 'user';
    discoveredFile = join(context.ports.xdg.config, 'skillsmith', 'skillsmith.toml');
  } else if (scopeOption === 'project') {
    selectedBy = 'project';
    discoveredFile = join(
      project.value.projectKind === 'git' && project.value.projectRoot !== null
        ? project.value.projectRoot
        : project.value.effectiveCwd,
      'skillsmith.toml',
    );
  } else if (project.value.projectKind === 'git' && project.value.projectRoot !== null) {
    selectedBy = 'project';
    discoveredFile = join(project.value.projectRoot, 'skillsmith.toml');
  } else {
    selectedBy = 'user';
    discoveredFile = join(context.ports.xdg.config, 'skillsmith', 'skillsmith.toml');
  }
  const pair =
    explicitFile === undefined
      ? await resolveArtifactPair(context.ports, project.value, {
          discoveredFile: discoveredFile as string,
        })
      : (() => {
          const lexical = resolveExplicitArtifactPairLexically({
            effectiveCwd: project.value.effectiveCwd,
            file: explicitFile,
          });
          return lexical.ok
            ? ({
                ok: true,
                value: {
                  file: {
                    token: explicitFile,
                    path: lexical.value.file as string,
                    portability: 'machine-bound' as const,
                    portableToken: null,
                  },
                  lockfile: {
                    token: null,
                    path: lexical.value.lockfile as string,
                    portability: 'machine-bound' as const,
                    portableToken: null,
                  },
                  lockfileSource: 'sibling' as const,
                },
              } as const)
            : lexical;
        })();
  if (!pair.ok) {
    return fail({
      code: pair.error.code,
      message: pair.error.message,
      exitClass: pair.error.exitClass,
    });
  }
  const selection: InitArtifactSelection = Object.freeze({
    outcome: 'selected',
    selectedBy,
    manifestPath: pair.value.file.path,
    lockPath: pair.value.lockfile.path,
    lockSource: 'sibling',
  });
  const observed = await observeInitManifest(context, selection.manifestPath);
  if (!observed.ok) return fail(observed.error);

  const configuration =
    context.effectiveConfig === undefined
      ? await resolveEffectiveConfig(context.ports, project.value, {
          configuration: context.configuration,
          automaticProjectTargetPath: selection.manifestPath,
          automaticProjectTargetEligible:
            observed.value.state === 'file' && isInitConfigSnapshotEligible(observed.value.bytes),
          fileExists: async (path: string) =>
            path === selection.manifestPath
              ? observed.value.state === 'file'
              : context.ports.fileExists(path),
          ...(observed.value.state === 'file'
            ? {
                readFile: async (path: string) =>
                  path === selection.manifestPath
                    ? new TextDecoder('utf-8', { fatal: true }).decode(
                        observed.value.state === 'file' ? observed.value.bytes : new Uint8Array(),
                      )
                    : context.ports.readText(path),
              }
            : {}),
        })
      : ({ ok: true, value: context.effectiveConfig } as const);
  if (!configuration.ok) {
    const selectedExit = exitClassForApplicationError(configuration.error, context.signal);
    return fail({
      code: 'init-configuration',
      message: 'effective init configuration could not be resolved',
      exitClass:
        selectedExit === 'permission' || selectedExit === 'cancelled' ? selectedExit : 'state',
    });
  }

  let tools = toolsOption;
  let toolSource: InitToolSource = tools.length > 0 ? 'explicit' : 'none';
  if (tools.length === 0) {
    const configured = configuredTools(configuration.value);
    if (configured.some((tool) => !writable.has(tool))) {
      return fail(capabilityFailure('configured init tools include a read-only adapter'));
    }
    if (configured.length > 0) {
      tools = configured;
      toolSource = 'config';
    } else {
      const detected: BuiltInToolId[] = [];
      for (const tool of WRITABLE_TOOLS) {
        const result = await detectTool(context.ports, tool, context.signal);
        if (!result.ok) return fail(diagnosticForDetection(tool));
        if (result.value.length > 0) detected.push(tool);
      }
      tools = Object.freeze(detected);
      toolSource = tools.length === 0 ? 'none' : 'detected';
    }
  }

  const configuredScope = configuration.value.value.scope;
  if (
    scopeOption === null &&
    configuredScope !== undefined &&
    configuredScope !== 'user' &&
    configuredScope !== 'project'
  ) {
    return fail(capabilityFailure('configured init scope is read-only'));
  }
  const scope =
    scopeOption ??
    (configuredScope === 'user' || configuredScope === 'project' ? configuredScope : null);
  const configuredRegistryDefault = configuration.value.value.registry?.default ?? null;
  const normalizedRegistryDefault =
    configuredRegistryDefault === null
      ? null
      : normalizeRegistryIdentity(configuredRegistryDefault, {}, 'registry.default');
  if (normalizedRegistryDefault !== null && !normalizedRegistryDefault.ok) {
    return fail({
      code: 'init-configuration',
      message: 'effective init registry default is not canonical',
      exitClass: 'state',
    });
  }
  const defaults: InitDefaults = Object.freeze({
    tools: tools.length === 0 ? null : tools,
    scope,
    path: scope === null ? null : (configuration.value.value.path ?? null),
    registryDefault: normalizedRegistryDefault === null ? null : normalizedRegistryDefault.value,
  });
  const skeleton = Object.freeze({
    ...(defaults.tools === null && defaults.scope === null && defaults.path === null
      ? {}
      : {
          defaults: Object.freeze({
            ...(defaults.tools === null ? {} : { tools: defaults.tools }),
            ...(defaults.scope === null ? {} : { scope: defaults.scope }),
            ...(defaults.path === null ? {} : { path: defaults.path }),
          }),
        }),
    ...(defaults.registryDefault === null
      ? {}
      : { registry: Object.freeze({ default: defaults.registryDefault }) }),
  });
  const request: InitRequest = Object.freeze({
    tools,
    explicitTools: toolsOption.length > 0,
    toolSource,
    scope,
    explicitScope: scopeOption !== null,
    file: selectedBy === 'explicit-file' ? selection.manifestPath : null,
    force: enabled(command, 'force'),
  });
  const dryRun = enabled(command, 'dryRun');
  const classification = planInitManifest({
    skeleton,
    current:
      observed.value.state === 'absent'
        ? { state: 'absent' }
        : { state: 'present', bytes: observed.value.bytes },
    legacyIntent: {
      requireMatch: Object.freeze([
        ...(toolsOption.length > 0 ? (['defaults.tools'] as const) : []),
        ...(scopeOption === null ? [] : (['defaults.scope'] as const)),
      ]),
    },
    force: request.force,
  });
  if (!classification.ok) {
    return fail({
      code: `init-${classification.error.reason}`,
      message: classification.error.message,
      exitClass: classification.error.exitCode === 2 ? 'usage' : 'state',
    });
  }
  const prepared = prepareInitOperationPlan({
    request,
    dryRun,
    defaults,
    selection,
    skeleton,
    classification: classification.value,
    observed: observed.value,
  });
  let durableExecutionFailure: InitFailure | null = null;
  if (!dryRun) {
    const execution = await executePreparedInit(context, prepared);
    if (!execution.ok) {
      if (execution.error.durableState !== 'after') return fail(execution.error);
      durableExecutionFailure = execution.error;
    }
  }
  const conflict = prepared.plan.operations[0]?.conflict ?? null;
  const force =
    conflict === null
      ? createBoundedForceEffect({
          supported: true,
          requested: request.force,
          applied: false,
          conflict: null,
        })
      : createBoundedForceEffect({
          supported: true,
          requested: true,
          applied: !dryRun,
          conflict,
        });
  const changed = prepared.result.action === 'noop' ? 0 : 1;
  const report: InitReport = Object.freeze({
    schemaVersion: 1,
    kind: 'skillsmith.init',
    reportVersion: 1,
    dryRun,
    requested: request,
    defaults,
    artifactSelection: selection,
    result: prepared.result,
    force,
    effects: reportEffects(prepared.result.action, prepared.result.operationId, dryRun),
    summary: Object.freeze({ changed, unchanged: changed === 0 ? 1 : 0 }),
  });
  const diagnostic: Diagnostic[] =
    durableExecutionFailure === null
      ? []
      : [
          Object.freeze({
            code: durableExecutionFailure.code,
            severity: 'error' as const,
            message: durableExecutionFailure.message,
          }),
        ];
  return {
    report,
    diagnostics: diagnostic,
    exitClass: durableExecutionFailure?.exitClass ?? 'success',
    mutation: {
      kind: dryRun ? 'preview' : changed === 0 ? 'none' : 'applied',
      planned: changed,
      changed: dryRun ? 0 : changed,
      unchanged: changed === 0 ? 1 : 0,
      failed: 0,
    },
    deprecations: [],
  };
};
