import { VERSION, defaultScanEnv } from '@skillsmith/core';
import { Argument, Command, Option } from 'commander';
import { runAgents } from './commands/agents.ts';
import { checkCommand } from './commands/check.ts';
import { commandsCommand } from './commands/commands.ts';
import { type Shell, runCompletion } from './commands/completion.ts';
import { configCommand } from './commands/config.ts';
import { crossToolNamesCommand } from './commands/cross-tool-names.ts';
import { devCommand } from './commands/dev.ts';
import { doctorCommand } from './commands/doctor.ts';
import { installCommand } from './commands/install.ts';
import { listCommand } from './commands/list.ts';
import { promoteCommand } from './commands/promote.ts';
import { uninstallCommand } from './commands/uninstall.ts';
import { verifyCommand } from './commands/verify.ts';
import { HELP_TOPIC_NAMES, renderTopic } from './help/topics.ts';
import { type ColorFlag, resolveColorMode } from './util/color.ts';
import { exitCodeForError } from './util/exit-codes.ts';

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

export const buildProgram = (signal?: AbortSignal): Command => {
  const program = new Command()
    .name('skillsmith')
    .description('SkillSmith installs and manages agent skills for AI coding tools.')
    .version(VERSION, '-V, --version')
    .helpOption('-h, --help', 'Show help')
    .option('-v, --verbose', 'Verbose output; repeatable', (_: string, prev: number) => prev + 1, 0)
    .option('-q, --quiet', 'Suppress non-error output', false)
    .addOption(
      new Option('--color <mode>', 'Colorize output')
        .choices(['auto', 'always', 'never'])
        .default('auto'),
    )
    .option('-C, --cd <dir>', 'Change directory before running', '.')
    .option('--debug', 'Print debug traces', false);

  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts() as { color?: string };
    const raw = opts.color ?? 'auto';
    const flag: ColorFlag = raw === 'always' || raw === 'never' || raw === 'auto' ? raw : 'auto';
    applyColorMode(flag);
  });

  // Map commander's usage errors (invalid choice, unknown command, missing arg)
  // to our exit-2 contract; everything else uses the error's own exitCode or 1.
  program.exitOverride((err) => {
    const usageCodes = new Set([
      'commander.invalidArgument',
      'commander.unknownCommand',
      'commander.missingArgument',
      'commander.unknownOption',
      'commander.excessArguments',
      'commander.missingMandatoryOptionValue',
    ]);
    if (usageCodes.has(err.code)) process.exit(2);
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') process.exit(0);
    process.exit(err.exitCode ?? 1);
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
        const env = await defaultScanEnv();
        const r = await runAgents({
          env,
          tools: opts.tool.length > 0 ? opts.tool : undefined,
          format: opts.format,
          detectedOnly: opts.detectedOnly,
          ...(signal ? { signal } : {}),
        });
        if (!r.ok) {
          process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
          process.exit(exitCodeForError(r.error));
        }
        process.stdout.write(`${r.output}\n`);
      },
    );

  program.addCommand(configCommand());
  program.addCommand(crossToolNamesCommand());
  program.addCommand(listCommand());
  program.addCommand(commandsCommand());
  program.addCommand(doctorCommand());
  program.addCommand(checkCommand());
  program.addCommand(verifyCommand(signal));
  program.addCommand(promoteCommand(signal));
  program.addCommand(devCommand(signal));
  program.addCommand(installCommand(signal));
  program.addCommand(uninstallCommand(signal));

  program
    .command('version')
    .description('Print SkillSmith version')
    .action(() => {
      process.stdout.write(`${VERSION}\n`);
    });

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
