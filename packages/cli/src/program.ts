import { type VersionReport, defaultScanEnv, runVersionApplication } from '@skillsmith/core';
import { Argument, Command, Option } from 'commander';
import { runAgents } from './commands/agents.ts';
import { checkCommand } from './commands/check.ts';
import { commandsCommand } from './commands/commands.ts';
import { type Shell, runCompletion } from './commands/completion.ts';
import { configCommand } from './commands/config.ts';
import { devCommand } from './commands/dev.ts';
import { doctorCommand } from './commands/doctor.ts';
import { installCommand } from './commands/install.ts';
import { listCommand } from './commands/list.ts';
import { promoteCommand } from './commands/promote.ts';
import { CLI_SELECTION_POLICIES, validateCliSelection } from './commands/selection-validation.ts';
import { uninstallCommand } from './commands/uninstall.ts';
import { verifyCommand } from './commands/verify.ts';
import { HELP_TOPIC_NAMES, renderTopic } from './help/topics.ts';
import {
  failCliError,
  normalizeCliError,
  renderCliError,
  withCliErrorBoundary,
} from './output/error-boundary.ts';
import {
  type ApplicationRegistry,
  type RendererRegistry,
  createCliRuntimeAdapter,
} from './runtime/adapter.ts';
import { type CliRuntimeIo, processRuntimeIo } from './runtime/io.ts';
import { CURRENT_COMMAND_SPECS, validateOptionInvocation } from './spec/index.ts';
import type { CommandSpec } from './spec/types.ts';
import { type ColorFlag, resolveColorMode } from './util/color.ts';

const applyColorMode = (flag: ColorFlag): void => {
  const mode = resolveColorMode({
    color: flag,
    noColor: Boolean(process.env.NO_COLOR),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (mode === 'off') {
    process.env.NO_COLOR = '1';
    Reflect.deleteProperty(process.env, 'FORCE_COLOR');
  } else {
    process.env.FORCE_COLOR = '1';
    Reflect.deleteProperty(process.env, 'NO_COLOR');
  }
};

export interface ProgramBuildExtensions {
  readonly additionalSpecs?: readonly CommandSpec[];
  readonly applications?: ApplicationRegistry;
  readonly renderers?: RendererRegistry;
  readonly runtimePorts?: CliRuntimeIo & { readonly interaction?: unknown };
}

const optionForSpec = (spec: CommandSpec['options'][number]): Option => {
  const fixtureCompatible = spec as CommandSpec['options'][number] & {
    readonly choices?: readonly string[];
    readonly defaultValue?: unknown;
  };
  const choices = fixtureCompatible.knownValues ?? fixtureCompatible.choices ?? [];
  const defaultValue = fixtureCompatible.parsedDefault ?? fixtureCompatible.defaultValue;
  let option = new Option(spec.flags);
  if (choices.length > 0) option = option.choices([...choices]);
  if (spec.repeatable) {
    option.argParser((value: string, previous: string[] = []) => [...previous, value]);
    option.default(Array.isArray(defaultValue) ? defaultValue : []);
  } else if (defaultValue !== undefined && !spec.negated) {
    option.default(defaultValue);
  }
  return option;
};

const argumentForSpec = (spec: CommandSpec['arguments'][number]): Argument => {
  const suffix = spec.variadic ? '...' : '';
  const syntax = spec.required ? `<${spec.name}${suffix}>` : `[${spec.name}${suffix}]`;
  const argument = new Argument(syntax);
  if ((spec.choices?.length ?? 0) > 0) argument.choices([...spec.choices]);
  return argument;
};

const leafName = (spec: CommandSpec): string =>
  (spec.path ?? spec.name).split(' ').at(-1) ?? spec.name;

const commandPath = (command: Command): string => {
  const names: string[] = [];
  for (let current: Command | null = command; current !== null; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(' ');
};

const commandArguments = (command: Command, rawArgs: readonly string[]): readonly string[] => {
  const path = commandPath(command).split(' ').slice(1);
  let offset = 0;
  for (const segment of path) {
    const index = rawArgs.indexOf(segment, offset);
    if (index < 0) return rawArgs;
    offset = index + 1;
  }
  return rawArgs.slice(offset);
};

const addRuntimeCommand = (
  program: Command,
  spec: CommandSpec,
  runtime: ReturnType<typeof createCliRuntimeAdapter>,
): Command => {
  const command = new Command(leafName(spec)).description(spec.description);
  for (const alias of spec.aliases) command.alias(alias);
  for (const argument of spec.arguments) command.addArgument(argumentForSpec(argument));
  for (const option of spec.options) command.addOption(optionForSpec(option));
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

  program.hook('preAction', (thisCommand, actionCommand) => {
    const rawArgs = (program as Command & { rawArgs?: string[] }).rawArgs ?? [];
    const invocation = rawArgs.slice(2);
    const rootRelation = validateOptionInvocation('skillsmith', invocation);
    if (!rootRelation.ok) {
      const format = invocation.includes('--json') ? 'json' : 'human';
      return failCliError(rootRelation.error, format, { exitCode: 2 });
    }
    const path = commandPath(actionCommand);
    const relation = validateOptionInvocation(path, commandArguments(actionCommand, invocation));
    if (!relation.ok) {
      const format = invocation.includes('--json') ? 'json' : 'human';
      return failCliError(relation.error, format, { exitCode: 2 });
    }
    const opts = thisCommand.optsWithGlobals() as { color?: string | false };
    const raw = opts.color === false ? 'never' : (opts.color ?? 'auto');
    const flag: ColorFlag = raw === 'always' || raw === 'never' || raw === 'auto' ? raw : 'auto';
    applyColorMode(flag);
  });

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

  program
    .command('agents')
    .description('List every supported tool SkillSmith detects on this system')
    .option(
      '-t, --tool <name>',
      'Narrow scan to specific tool (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option('--detected-only', 'Omit the "Not detected" section', false)
    .addOption(
      new Option('--format <fmt>', 'Output format')
        .choices(['markdown', 'json'])
        .default('markdown'),
    )
    .action(
      async (opts: { tool: string[]; detectedOnly: boolean; format: 'markdown' | 'json' }) => {
        const format = opts.format === 'json' ? 'json' : 'human';
        const selection = validateCliSelection(
          {
            targets: [],
            all: false,
            tools: opts.tool,
            capability: 'read',
          },
          CLI_SELECTION_POLICIES.agents,
          format,
        );
        const env = await defaultScanEnv();
        const r = await runAgents({
          env,
          tools: selection.tools.length > 0 ? selection.tools : undefined,
          format: opts.format,
          detectedOnly: opts.detectedOnly,
          ...(signal ? { signal } : {}),
        });
        if (!r.ok) {
          const error = normalizeCliError(r.error);
          const json = opts.format === 'json';
          (json ? process.stdout : process.stderr).write(
            renderCliError(error, json ? 'json' : 'human'),
          );
          process.exit(error.exitCode);
        }
        process.stdout.write(`${r.output}\n`);
      },
    );

  program.addCommand(configCommand());
  program.addCommand(listCommand());
  program.addCommand(commandsCommand());
  program.addCommand(doctorCommand());
  program.addCommand(checkCommand());
  program.addCommand(verifyCommand(signal));
  program.addCommand(promoteCommand(signal));
  program.addCommand(devCommand(signal));
  program.addCommand(installCommand(signal));
  program.addCommand(uninstallCommand(signal));

  const versionSpec = CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith version');
  if (!versionSpec) throw new Error('current CommandSpec registry is missing version');
  addRuntimeCommand(program, versionSpec, runtime);

  for (const spec of extensions.additionalSpecs ?? []) {
    if (program.commands.some((command) => command.name() === leafName(spec))) continue;
    addRuntimeCommand(program, spec, runtime);
  }

  program
    .command('completion')
    .description('Emit a shell completion script')
    .addArgument(new Argument('<shell>', 'Target shell').choices(['bash', 'zsh', 'fish']))
    .action((shell: Shell) => {
      process.stdout.write(runCompletion(program, shell));
    });

  program
    .command('help [topic]')
    .description('Help about a command or cross-cutting topic')
    .action((topic?: string) => {
      if (!topic) {
        program.outputHelp();
        return;
      }
      if ((HELP_TOPIC_NAMES as readonly string[]).includes(topic)) {
        const r = renderTopic(topic);
        if (r.ok) {
          process.stdout.write(`${r.value}\n`);
          return;
        }
        process.stderr.write(
          `error: internal: help topic '${topic}' is listed but has no content.\n`,
        );
        process.exit(1);
      }
      const cmd = program.commands.find((c) => c.name() === topic);
      if (cmd) {
        cmd.outputHelp();
        return;
      }
      process.stderr.write(
        `error: '${topic}' is not a known command or topic.\n` +
          `Known topics: ${HELP_TOPIC_NAMES.join(', ')}\n`,
      );
      process.exit(2);
    });

  return program;
};
