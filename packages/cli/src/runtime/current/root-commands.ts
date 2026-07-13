import { defaultScanEnv } from '@skillsmith/core';
import { Argument, Command, Option } from 'commander';
import { HELP_TOPIC_NAMES, renderTopic } from '../../help/topics.ts';
import { normalizeCliError, renderCliError } from '../../output/error-boundary.ts';
import { runAgents } from './agents.ts';
import { type Shell, runCompletion } from './completion.ts';
import { CLI_SELECTION_POLICIES, validateCliSelection } from './selection-validation.ts';

export const agentsCommand = (signal?: AbortSignal): Command =>
  new Command('agents')
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
        const result = await runAgents({
          env,
          tools: selection.tools.length > 0 ? selection.tools : undefined,
          format: opts.format,
          detectedOnly: opts.detectedOnly,
          ...(signal ? { signal } : {}),
        });
        if (!result.ok) {
          const error = normalizeCliError(result.error);
          const json = opts.format === 'json';
          (json ? process.stdout : process.stderr).write(
            renderCliError(error, json ? 'json' : 'human'),
          );
          process.exit(error.exitCode);
        }
        process.stdout.write(`${result.output}\n`);
      },
    );

export const completionCommand = (root: Command): Command =>
  new Command('completion')
    .description('Emit a shell completion script')
    .addArgument(new Argument('<shell>', 'Target shell').choices(['bash', 'zsh', 'fish']))
    .action((shell: Shell) => {
      process.stdout.write(runCompletion(root, shell));
    });

export const helpCommand = (root: Command): Command =>
  new Command('help')
    .argument('[topic]')
    .description('Help about a command or cross-cutting topic')
    .action((topic?: string) => {
      if (!topic) {
        root.outputHelp();
        return;
      }
      if ((HELP_TOPIC_NAMES as readonly string[]).includes(topic)) {
        const result = renderTopic(topic);
        if (result.ok) {
          process.stdout.write(`${result.value}\n`);
          return;
        }
        process.stderr.write(
          `error: internal: help topic '${topic}' is listed but has no content.\n`,
        );
        process.exit(1);
      }
      const command = root.commands.find((candidate) => candidate.name() === topic);
      if (command) {
        command.outputHelp();
        return;
      }
      process.stderr.write(
        `error: '${topic}' is not a known command or topic.\n` +
          `Known topics: ${HELP_TOPIC_NAMES.join(', ')}\n`,
      );
      process.exit(2);
    });
