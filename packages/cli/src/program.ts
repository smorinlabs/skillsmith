import { type VersionReport, runVersionApplication } from '@skillsmith/core';
import { Command, Option } from 'commander';
import { withCliErrorBoundary } from './output/error-boundary.ts';
import {
  type ApplicationRegistry,
  type RendererRegistry,
  createCliRuntimeAdapter,
} from './runtime/adapter.ts';
import { attachCommandSpecs, configureCommandFromSpec } from './runtime/command-spec.ts';
import { checkCommand } from './runtime/current/check.ts';
import { commandsCommand } from './runtime/current/commands.ts';
import { configCommand } from './runtime/current/config.ts';
import { devCommand } from './runtime/current/dev.ts';
import { doctorCommand } from './runtime/current/doctor.ts';
import { installCommand } from './runtime/current/install.ts';
import { listCommand } from './runtime/current/list.ts';
import { promoteCommand } from './runtime/current/promote.ts';
import { agentsCommand, completionCommand, helpCommand } from './runtime/current/root-commands.ts';
import { uninstallCommand } from './runtime/current/uninstall.ts';
import { verifyCommand } from './runtime/current/verify.ts';
import { type CliRuntimeIo, processRuntimeIo } from './runtime/io.ts';
import { installRuntimePreflight } from './runtime/preflight.ts';
import { CURRENT_COMMAND_SPECS } from './spec/index.ts';
import type { CommandSpec } from './spec/types.ts';

export interface ProgramBuildExtensions {
  readonly additionalSpecs?: readonly CommandSpec[];
  readonly applications?: ApplicationRegistry;
  readonly renderers?: RendererRegistry;
  readonly runtimePorts?: CliRuntimeIo & { readonly interaction?: unknown };
}

const addRuntimeCommand = (
  program: Command,
  spec: CommandSpec,
  runtime: ReturnType<typeof createCliRuntimeAdapter>,
): Command => {
  const command = configureCommandFromSpec(new Command(), spec);
  const documentation = `\nPRIMARY QUESTION\n  ${spec.primaryQuestion}\n\nEXAMPLES\n  ${spec.examples.join('\n  ')}\n`;
  const baseHelpInformation = command.helpInformation.bind(command);
  command.helpInformation = () => `${baseHelpInformation()}${documentation}`;
  command.action(async (...values: unknown[]) => {
    const invoked = values.at(-1) as Command;
    const positional = values.slice(0, Math.max(0, values.length - 2));
    const options = invoked.optsWithGlobals() as { json?: boolean };
    await runtime.execute({
      application: spec.application,
      reportKind: spec.reportKind ?? spec.application,
      request: { arguments: positional, options },
      context: {},
      format: options.json ? 'json' : 'human',
    });
  });
  program.addCommand(command);
  return command;
};

export const buildProgram = (
  signal?: AbortSignal,
  extensions: ProgramBuildExtensions = {},
): Command => {
  const runtime = createCliRuntimeAdapter({
    applications: {
      version: runVersionApplication as ApplicationRegistry[string],
      ...extensions.applications,
    },
    renderers: {
      version: {
        human: (outcome) => `${(outcome.report as VersionReport).version}\n`,
        json: (outcome) => `${JSON.stringify(outcome.report)}\n`,
      },
      ...extensions.renderers,
    },
    io: extensions.runtimePorts ?? processRuntimeIo,
  });

  const program = withCliErrorBoundary(
    new Command()
      .name('skillsmith')
      .description('SkillSmith installs and manages agent skills for AI coding tools.')
      .option('-V, --version', 'Print version')
      .helpOption('-h, --help', 'Show help')
      .option(
        '-v, --verbose',
        'Verbose output; repeatable',
        (_: string, prev: number) => prev + 1,
        0,
      )
      .option('-q, --quiet', 'Suppress non-error output', false)
      .addOption(
        new Option('--color <mode>', 'Colorize output')
          .choices(['auto', 'always', 'never'])
          .default('auto'),
      )
      .option('-C, --cd <dir>', 'Change directory before running', '.')
      .option('--config <file>', 'Use an explicit configuration file')
      .option('--no-color', 'Disable color output')
      .option('--no-prompt', 'Disable interactive prompts')
      .option('--debug', 'Print debug traces', false),
  );

  program.action(async (opts: { version?: boolean }) => {
    if (!opts.version) {
      program.outputHelp();
      return;
    }
    await runtime.execute({
      application: 'version',
      reportKind: 'version',
      request: {},
      context: {},
      format: 'human',
    });
  });

  const version = withCliErrorBoundary(
    new Command('version').description('Print SkillSmith version').action(async () => {
      await runtime.execute({
        application: 'version',
        reportKind: 'version',
        request: {},
        context: {},
        format: 'human',
      });
    }),
  );

  const templates = [
    withCliErrorBoundary(agentsCommand(signal)),
    configCommand(),
    listCommand(),
    commandsCommand(),
    doctorCommand(),
    checkCommand(),
    verifyCommand(signal),
    promoteCommand(signal),
    devCommand(signal),
    installCommand(signal),
    uninstallCommand(signal),
    version,
    withCliErrorBoundary(completionCommand(program)),
    withCliErrorBoundary(helpCommand(program)),
  ];
  attachCommandSpecs(program, CURRENT_COMMAND_SPECS, templates);
  installRuntimePreflight(program);

  for (const spec of extensions.additionalSpecs ?? []) {
    if (program.commands.some((command) => command.name() === spec.name)) continue;
    addRuntimeCommand(program, spec, runtime);
  }

  return program;
};
