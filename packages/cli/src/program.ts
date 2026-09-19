import {
  CURRENT_APPLICATION_SERVICES,
  type ClockPort,
  type CurrentCommandRequest,
  type IdPort,
  type InteractionPort,
  type ObservationBundle,
  type ObservationVerbosity,
  createObservationEmitter,
  createOperationContext,
  defaultClockPort,
  defaultIdPort,
  toolRegistry,
} from '@skillsmith/core';
import type { Command } from 'commander';
import { HELP_TOPIC_LOOKUP_NAMES } from './help/topics.ts';
import {
  isCliBoundaryExit,
  normalizeCliError,
  renderCliError,
  setCliErrorInvocation,
  withCliErrorBoundary,
} from './output/error-boundary.ts';
import {
  type ApplicationRegistry,
  type RendererRegistry,
  createCliRuntimeAdapter,
} from './runtime/adapter.ts';
import {
  type CommandActionFactory,
  attachCommandSpecs,
  createCommandFromSpec,
  normalizeCommandSpec,
} from './runtime/command-spec.ts';
import { createCurrentApplicationContext } from './runtime/context.ts';
import { createCurrentRendererRegistry } from './runtime/current-renderers.ts';
import { createCliDiagnosticObserver, resolveObservationVerbosity } from './runtime/diagnostics.ts';
import { type CliRuntimeIo, processRuntimeIo } from './runtime/io.ts';
import { assertRootRuntimePreflight, installRuntimePreflight } from './runtime/preflight.ts';
import {
  type PresentationPolicy,
  presentHumanOutput,
  presentationPolicyForIo,
} from './runtime/presentation.ts';
import { CURRENT_COMMAND_SPECS } from './spec/index.ts';
import type { CommandSpecInput, NormalizedCommandSpec } from './spec/types.ts';

export interface ProgramBuildExtensions {
  readonly additionalSpecs?: readonly CommandSpecInput[];
  readonly applications?: ApplicationRegistry;
  readonly renderers?: RendererRegistry;
  readonly runtimePorts?: CliRuntimeIo & { readonly interaction?: InteractionPort };
  readonly operationPorts?: {
    readonly clock: Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>;
    readonly id: Pick<IdPort, 'nextId'>;
  };
}

const commandRequest = (values: readonly unknown[]): CurrentCommandRequest => {
  const command = values.at(-1) as Command;
  const options = {
    ...(command.optsWithGlobals() as Readonly<Record<string, unknown>>),
  } as Record<string, unknown>;
  // Preserve the distinction between Commander's implicit markdown default and
  // an explicit `--format markdown`, so the documented `--json` alias can win
  // only over the former while the explicit conflict remains a usage error.
  if (
    command.name() === 'agents' &&
    options.json === true &&
    options.format === 'markdown' &&
    command.getOptionValueSource('format') === 'default'
  ) {
    options.format = undefined;
  }
  return {
    arguments: values.slice(0, Math.max(0, values.length - 2)),
    options:
      command.name() === 'help'
        ? {
            ...options,
            knownHelpNames: [
              ...HELP_TOPIC_LOOKUP_NAMES,
              ...(command.parent?.commands.map((candidate) => candidate.name()) ?? []),
            ],
          }
        : options,
  };
};

const requestedFormat = (request: CurrentCommandRequest): 'human' | 'json' =>
  request.options.json === true || request.options.format === 'json' ? 'json' : 'human';

const CONTEXT_FREE_APPLICATIONS = new Set([
  'version',
  'rootHelp',
  'configHelp',
  'completion',
  'help',
]);

interface ValueOptionSpellings {
  readonly long: ReadonlyMap<string, 'required' | 'optional'>;
  readonly short: ReadonlyMap<string, 'required' | 'optional'>;
}

interface EagerValueOptionScope {
  readonly root: ValueOptionSpellings;
  readonly active: ValueOptionSpellings;
}

const valueOptionSpellings = (specs: readonly NormalizedCommandSpec[]): ValueOptionSpellings => {
  const long = new Map<string, 'required' | 'optional'>();
  const short = new Map<string, 'required' | 'optional'>();
  const longShapes = new Map<string, 'boolean' | 'required' | 'optional'>();
  const shortShapes = new Map<string, 'boolean' | 'required' | 'optional'>();
  const record = (
    spelling: string,
    shape: 'boolean' | 'required' | 'optional',
    shapes: Map<string, 'boolean' | 'required' | 'optional'>,
    values: Map<string, 'required' | 'optional'>,
  ): void => {
    const existing = shapes.get(spelling);
    if (existing !== undefined && existing !== shape) {
      throw new Error(
        `Option spelling ${spelling} has conflicting value shapes: ${existing} and ${shape}`,
      );
    }
    shapes.set(spelling, shape);
    if (shape !== 'boolean') values.set(spelling, shape);
  };

  for (const spec of specs) {
    for (const option of spec.options) {
      record(option.long, option.valueShape, longShapes, long);
      if (option.short !== null) record(option.short, option.valueShape, shortShapes, short);
    }
  }
  return { long, short };
};

const consumesFollowingValue = (
  shape: 'required' | 'optional',
  next: string | undefined,
): boolean => shape === 'required' || (next !== undefined && !next.startsWith('-'));

const longValueShape = (
  scope: EagerValueOptionScope,
  token: string,
): 'required' | 'optional' | undefined => {
  const rootShape = scope.root.long.get(token);
  return rootShape ?? scope.active.long.get(token);
};

const shortValueShape = (
  scope: EagerValueOptionScope,
  flag: string,
): 'required' | 'optional' | undefined => {
  const spelling = `-${flag}`;
  const rootShape = scope.root.short.get(spelling);
  return rootShape ?? scope.active.short.get(spelling);
};

const eagerValueOptionScopes = (
  invocation: readonly string[],
  rootSpec: NormalizedCommandSpec,
  specs: readonly NormalizedCommandSpec[],
  attachedAdditionalSpecs: ReadonlySet<NormalizedCommandSpec>,
): readonly (EagerValueOptionScope | undefined)[] => {
  const rootOptions = valueOptionSpellings([rootSpec]);
  const optionsBySpec = new Map<NormalizedCommandSpec, ValueOptionSpellings>();
  for (const spec of specs) {
    optionsBySpec.set(spec, spec === rootSpec ? rootOptions : valueOptionSpellings([spec]));
  }

  const directChild = (
    parent: NormalizedCommandSpec,
    token: string,
  ): NormalizedCommandSpec | undefined =>
    specs.find((candidate) => {
      if (candidate === rootSpec) return false;
      const attachedAtRoot = parent === rootSpec && attachedAdditionalSpecs.has(candidate);
      const declaredParent = candidate.path.split(' ').slice(0, -1).join(' ') === parent.path;
      return (
        (attachedAtRoot || declaredParent) &&
        (candidate.path.split(' ').at(-1) === token || candidate.aliases.includes(token))
      );
    });

  const scopes: (EagerValueOptionScope | undefined)[] = [];
  let activeSpec = rootSpec;
  let commandPathClosed = false;
  for (let index = 0; index < invocation.length; index++) {
    const token = invocation[index];
    if (token === undefined) continue;
    const scope = {
      root: rootOptions,
      active: optionsBySpec.get(activeSpec) ?? rootOptions,
    };
    scopes[index] = scope;
    if (token === '--') break;

    const longShape = longValueShape(scope, token);
    if (longShape !== undefined) {
      if (consumesFollowingValue(longShape, invocation[index + 1])) index++;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      if (!token.startsWith('--')) {
        const cluster = token.slice(1);
        for (let clusterIndex = 0; clusterIndex < cluster.length; clusterIndex++) {
          const flag = cluster[clusterIndex];
          const shortShape = flag === undefined ? undefined : shortValueShape(scope, flag);
          if (shortShape === undefined) continue;
          if (
            clusterIndex === cluster.length - 1 &&
            consumesFollowingValue(shortShape, invocation[index + 1])
          )
            index++;
          break;
        }
      }
      continue;
    }

    if (commandPathClosed) continue;
    const child = directChild(activeSpec, token);
    if (child === undefined) {
      commandPathClosed = true;
    } else {
      activeSpec = child;
    }
  }
  return scopes;
};

const requestsEagerVersion = (
  invocation: readonly string[],
  valueOptionScopes: readonly (EagerValueOptionScope | undefined)[],
): boolean => {
  for (let index = 0; index < invocation.length; index++) {
    const token = invocation[index];
    if (token === undefined) return false;
    const valueOptions = valueOptionScopes[index];
    if (valueOptions === undefined) continue;
    if (token === '--') return false;
    if (token === '--version') return true;
    if (token === '--help') return false;
    const longShape = longValueShape(valueOptions, token);
    if (longShape !== undefined) continue;
    if (token.startsWith('--')) continue;

    if (!token.startsWith('-') || token === '-') continue;
    const cluster = token.slice(1);
    for (let clusterIndex = 0; clusterIndex < cluster.length; clusterIndex++) {
      const flag = cluster[clusterIndex];
      if (flag === undefined) continue;
      const shortShape = shortValueShape(valueOptions, flag);
      if (shortShape !== undefined) break;
      if (flag === 'V') return true;
      if (flag === 'h') return false;
    }
  }
  return false;
};

const invocationFromParse = (
  argv: readonly string[] | undefined,
  from: 'node' | 'electron' | 'user' | undefined,
): readonly string[] => {
  const effectiveArgv = argv ?? process.argv;
  let effectiveFrom: 'node' | 'electron' | 'user' | 'eval' | undefined = from;

  // Match Commander's _prepareUserArgs convention exactly before Commander parses, because eager
  // version, preflight, color, and error-format routing all need the same user-argument view.
  if (argv === undefined && effectiveFrom === undefined) {
    if (process.versions?.electron) effectiveFrom = 'electron';
    if (
      (process.execArgv ?? []).some(
        (argument) =>
          argument === '-e' || argument === '--eval' || argument === '-p' || argument === '--print',
      )
    ) {
      effectiveFrom = 'eval';
    }
  }

  if (effectiveFrom === 'user') return effectiveArgv;
  if (effectiveFrom === 'eval') return effectiveArgv.slice(1);
  if (effectiveFrom === 'electron') {
    const electronProcess = process as NodeJS.Process & { readonly defaultApp?: boolean };
    return effectiveArgv.slice(electronProcess.defaultApp ? 2 : 1);
  }
  return effectiveArgv.slice(2);
};

const eagerPresentationOptions = (
  invocation: readonly string[],
  valueOptionScopes: readonly (EagerValueOptionScope | undefined)[],
): Readonly<{
  quiet?: true;
  debug?: true;
  verbose: number;
  color: 'auto' | 'always' | 'never' | false;
}> => {
  let quiet = false;
  let debug = false;
  let verbose = 0;
  let color: 'auto' | 'always' | 'never' | false = 'auto';
  for (let index = 0; index < invocation.length; index++) {
    const token = invocation[index];
    if (token === undefined) break;
    const valueOptions = valueOptionScopes[index];
    if (valueOptions === undefined) continue;
    if (token === '--') break;
    if (token === '--quiet') quiet = true;
    if (token === '--debug') debug = true;
    if (token === '--verbose') verbose++;
    if (token === '--no-color') color = false;
    const attachedColor = token.startsWith('--color=') ? token.slice('--color='.length) : undefined;
    const selectedColor = token === '--color' ? invocation[index + 1] : attachedColor;
    if (selectedColor === 'auto' || selectedColor === 'always' || selectedColor === 'never')
      color = selectedColor;
    const longShape = longValueShape(valueOptions, token);
    if (longShape !== undefined) continue;
    if (!token.startsWith('-') || token.startsWith('--') || token === '-') continue;
    const cluster = token.slice(1);
    for (let clusterIndex = 0; clusterIndex < cluster.length; clusterIndex++) {
      const flag = cluster[clusterIndex];
      if (flag === 'q') quiet = true;
      if (flag === 'v') verbose++;
      const shortShape = flag === undefined ? undefined : shortValueShape(valueOptions, flag);
      if (shortShape !== undefined) break;
    }
  }
  return {
    ...(quiet ? { quiet: true as const } : {}),
    ...(debug ? { debug: true as const } : {}),
    verbose,
    color,
  };
};

export const buildProgram = (
  signal?: AbortSignal,
  extensions: ProgramBuildExtensions = {},
): Command => {
  const rootSpec = CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith');
  if (rootSpec === undefined) throw new Error('CommandSpec registry is missing skillsmith');
  const runtimeIo = extensions.runtimePorts ?? processRuntimeIo;
  const program = withCliErrorBoundary(createCommandFromSpec(rootSpec), runtimeIo);
  const operationPorts = extensions.operationPorts ?? {
    clock: defaultClockPort,
    id: defaultIdPort,
  };

  const runtime = createCliRuntimeAdapter({
    applications: {
      ...(CURRENT_APPLICATION_SERVICES as unknown as ApplicationRegistry),
      ...extensions.applications,
    },
    renderers: {
      ...createCurrentRendererRegistry(program),
      ...extensions.renderers,
    },
    io: runtimeIo,
  });

  const createObservation = (
    command: string,
    workflow: string,
    verbosity: ObservationVerbosity,
  ): {
    readonly observation: ObservationBundle;
    readonly diagnosticBuffer: { flush(): void; discard(): void };
  } => {
    const pendingDiagnostics: string[] = [];
    let settled = false;
    const diagnosticBuffer = Object.freeze({
      flush: (): void => {
        if (settled) return;
        settled = true;
        for (const line of pendingDiagnostics) runtimeIo.stderr.write(line);
        pendingDiagnostics.length = 0;
      },
      discard: (): void => {
        settled = true;
        pendingDiagnostics.length = 0;
      },
    });
    const context = createOperationContext({
      command,
      workflow,
      clock: operationPorts.clock,
      id: operationPorts.id,
    });
    const emitter = createObservationEmitter({
      observer: createCliDiagnosticObserver(
        {
          stdout: { write: () => {} },
          stderr: {
            write: (value) => {
              if (!settled) pendingDiagnostics.push(value);
            },
          },
          exit: () => {},
        },
        verbosity,
      ),
      toolIds: toolRegistry.ids,
    });
    return {
      observation: Object.freeze({ context, emitter }),
      diagnosticBuffer,
    };
  };

  const failBeforeLifecycle = (
    error: unknown,
    format: 'human' | 'json',
    presentation: PresentationPolicy,
  ): void => {
    const normalized = normalizeCliError(error);
    const rendered = renderCliError(normalized, format);
    if (format === 'json') {
      runtimeIo.stdout.write(rendered);
    } else {
      const output = presentHumanOutput({ stderr: rendered }, presentation, 'error');
      runtimeIo.stderr.write(output.stderr ?? rendered);
    }
    runtimeIo.exit(normalized.exitCode);
  };

  const actionFactory: CommandActionFactory = (spec, command) => {
    withCliErrorBoundary(command, runtimeIo);
    return async (...values: unknown[]) => {
      const request = commandRequest(values);
      const application = request.options.version === true ? 'version' : spec.application;
      const identity =
        application === 'version'
          ? { command: 'skillsmith version', workflow: 'version' }
          : { command: spec.path, workflow: spec.application };
      const verbosity = resolveObservationVerbosity(request.options);
      const format = requestedFormat(request);
      const presentation = presentationPolicyForIo(request.options, format, runtimeIo);
      try {
        const prepared = createObservation(identity.command, identity.workflow, verbosity);
        const { observation } = prepared;
        const context = CONTEXT_FREE_APPLICATIONS.has(application)
          ? Object.freeze({ observation })
          : await createCurrentApplicationContext(command, {
              observation,
              ...(signal === undefined ? {} : { signal }),
              ...(extensions.runtimePorts?.interaction === undefined
                ? {}
                : { interaction: extensions.runtimePorts.interaction }),
            });
        await runtime.execute({
          application,
          reportKind: application === 'version' ? 'version' : (spec.reportKind ?? application),
          request,
          context,
          observation,
          format,
          presentation,
          quiet: verbosity === 'quiet',
          diagnosticBuffer: prepared.diagnosticBuffer,
        });
      } catch (error) {
        if (isCliBoundaryExit(error)) throw error;
        failBeforeLifecycle(error, format, presentation);
      }
    };
  };

  program.action(actionFactory(rootSpec, program));
  attachCommandSpecs(program, CURRENT_COMMAND_SPECS, actionFactory);
  installRuntimePreflight(program, runtimeIo);

  const attachedAdditionalSpecs: NormalizedCommandSpec[] = [];
  for (const input of extensions.additionalSpecs ?? []) {
    const spec = normalizeCommandSpec(input);
    if (program.commands.some((command) => command.name() === spec.name)) continue;
    const command = createCommandFromSpec(spec);
    command.action(actionFactory(spec, command));
    program.addCommand(command);
    attachedAdditionalSpecs.push(spec);
  }
  const eagerSpecs = [...CURRENT_COMMAND_SPECS, ...attachedAdditionalSpecs];
  valueOptionSpellings(eagerSpecs);

  const parseAsync = program.parseAsync.bind(program);
  program.parseAsync = (async (...args: Parameters<Command['parseAsync']>) => {
    try {
      const [argv, options] = args;
      const invocation = invocationFromParse(argv, options?.from);
      setCliErrorInvocation(program, invocation);
      const valueOptionScopes = eagerValueOptionScopes(
        invocation,
        rootSpec,
        eagerSpecs,
        new Set(attachedAdditionalSpecs),
      );
      if (requestsEagerVersion(invocation, valueOptionScopes)) {
        assertRootRuntimePreflight(invocation, runtimeIo);
        const presentation = eagerPresentationOptions(invocation, valueOptionScopes);
        const verbosity = resolveObservationVerbosity(presentation);
        const presentationPolicy = presentationPolicyForIo(presentation, 'human', runtimeIo);
        try {
          const prepared = createObservation('skillsmith version', 'version', verbosity);
          const { observation } = prepared;
          await runtime.execute({
            application: 'version',
            reportKind: 'version',
            request: {
              arguments: [],
              options: { version: true, ...presentation },
            },
            context: Object.freeze({ observation }),
            observation,
            format: 'human',
            presentation: presentationPolicy,
            quiet: verbosity === 'quiet',
            diagnosticBuffer: prepared.diagnosticBuffer,
          });
        } catch (error) {
          if (isCliBoundaryExit(error)) throw error;
          failBeforeLifecycle(error, 'human', presentationPolicy);
        }
        return program;
      }
      const parsed = await parseAsync(...args);
      return parsed;
    } catch (error) {
      if (isCliBoundaryExit(error)) return program;
      throw error;
    }
  }) as Command['parseAsync'];
  return program;
};
