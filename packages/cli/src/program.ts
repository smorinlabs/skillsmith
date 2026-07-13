import {
  CURRENT_APPLICATION_SERVICES,
  type CurrentCommandRequest,
  type InteractionPort,
} from '@skillsmith/core';
import type { Command } from 'commander';
import { HELP_TOPIC_NAMES } from './help/topics.ts';
import { withCliErrorBoundary } from './output/error-boundary.ts';
import {
  type ApplicationRegistry,
  type RendererRegistry,
  createCliRuntimeAdapter,
} from './runtime/adapter.ts';
import {
  type CommandActionFactory,
  attachCommandSpecs,
  createCommandFromSpec,
} from './runtime/command-spec.ts';
import { createCurrentApplicationContext } from './runtime/context.ts';
import { createCurrentRendererRegistry } from './runtime/current-renderers.ts';
import { type CliRuntimeIo, processRuntimeIo } from './runtime/io.ts';
import { installRuntimePreflight } from './runtime/preflight.ts';
import { CURRENT_COMMAND_SPECS } from './spec/index.ts';
import type { CommandSpec } from './spec/types.ts';

export interface ProgramBuildExtensions {
  readonly additionalSpecs?: readonly CommandSpec[];
  readonly applications?: ApplicationRegistry;
  readonly renderers?: RendererRegistry;
  readonly runtimePorts?: CliRuntimeIo & { readonly interaction?: InteractionPort };
}

const commandRequest = (values: readonly unknown[]): CurrentCommandRequest => {
  const command = values.at(-1) as Command;
  const options = command.optsWithGlobals() as Readonly<Record<string, unknown>>;
  return {
    arguments: values.slice(0, Math.max(0, values.length - 2)),
    options:
      command.name() === 'help'
        ? {
            ...options,
            knownHelpNames: [
              ...HELP_TOPIC_NAMES,
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

const VALUE_LONG_OPTIONS = new Set(
  CURRENT_COMMAND_SPECS.flatMap((spec) =>
    spec.options.filter((option) => option.valueShape !== 'boolean').map((option) => option.long),
  ),
);

const VALUE_SHORT_OPTIONS = new Set(
  CURRENT_COMMAND_SPECS.flatMap((spec) =>
    spec.options.flatMap((option) =>
      option.valueShape !== 'boolean' && option.short !== null ? [option.short] : [],
    ),
  ),
);

const requestsEagerVersion = (invocation: readonly string[]): boolean => {
  for (let index = 0; index < invocation.length; index++) {
    const token = invocation[index];
    if (token === undefined || token === '--') return false;
    if (token === '--version') return true;
    if (token === '--help') return false;
    if (VALUE_LONG_OPTIONS.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith('--')) continue;

    if (!token.startsWith('-') || token === '-') continue;
    const cluster = token.slice(1);
    for (let clusterIndex = 0; clusterIndex < cluster.length; clusterIndex++) {
      const flag = cluster[clusterIndex];
      if (flag === undefined) continue;
      if (VALUE_SHORT_OPTIONS.has(`-${flag}`)) {
        if (clusterIndex === cluster.length - 1) index++;
        break;
      }
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
  if (argv === undefined) return [];
  if (from === 'user') return argv;
  return argv.slice(from === 'electron' ? 1 : 2);
};

export const buildProgram = (
  signal?: AbortSignal,
  extensions: ProgramBuildExtensions = {},
): Command => {
  const rootSpec = CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith');
  if (rootSpec === undefined) throw new Error('CommandSpec registry is missing skillsmith');
  const program = withCliErrorBoundary(createCommandFromSpec(rootSpec));

  const runtime = createCliRuntimeAdapter({
    applications: {
      ...(CURRENT_APPLICATION_SERVICES as unknown as ApplicationRegistry),
      ...extensions.applications,
    },
    renderers: {
      ...createCurrentRendererRegistry(program),
      ...extensions.renderers,
    },
    io: extensions.runtimePorts ?? processRuntimeIo,
  });

  const actionFactory: CommandActionFactory = (spec, command) => {
    withCliErrorBoundary(command);
    return async (...values: unknown[]) => {
      const request = commandRequest(values);
      const application = request.options.version === true ? 'version' : spec.application;
      const context = CONTEXT_FREE_APPLICATIONS.has(application)
        ? {}
        : await createCurrentApplicationContext(command, {
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
        format: requestedFormat(request),
      });
    };
  };

  program.action(actionFactory(rootSpec, program));
  attachCommandSpecs(program, CURRENT_COMMAND_SPECS, actionFactory);
  installRuntimePreflight(program);

  for (const spec of extensions.additionalSpecs ?? []) {
    if (program.commands.some((command) => command.name() === spec.name)) continue;
    const command = createCommandFromSpec(spec);
    command.action(actionFactory(spec, command));
    program.addCommand(command);
  }

  const parseAsync = program.parseAsync.bind(program);
  program.parseAsync = (async (...args: Parameters<Command['parseAsync']>) => {
    const [argv, options] = args;
    if (requestsEagerVersion(invocationFromParse(argv, options?.from))) {
      await runtime.execute({
        application: 'version',
        reportKind: 'version',
        request: { arguments: [], options: { version: true } },
        context: {},
        format: 'human',
      });
      return program;
    }
    return parseAsync(...args);
  }) as Command['parseAsync'];
  return program;
};
