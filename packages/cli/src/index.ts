#!/usr/bin/env bun
import { VERSION, defaultScanEnv } from '@skillsmith/core';
import { Command } from 'commander';
import { runAgents } from './commands/agents.ts';
import { HELP_TOPIC_NAMES, renderTopic } from './help/topics.ts';
import { type ColorFlag, resolveColorMode } from './util/color.ts';
import { exitCodeForError } from './util/exit-codes.ts';
import { installSigintHandler } from './util/signals.ts';

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

const main = async (): Promise<number> => {
  const controller = new AbortController();
  const sigint = installSigintHandler(controller);

  try {
    const program = new Command()
      .name('skillsmith')
      .description('SkillSmith installs and manages agent skills for AI coding tools.')
      .version(VERSION, '-V, --version')
      .helpOption('-h, --help', 'Show help')
      .option(
        '-v, --verbose',
        'Verbose output; repeatable',
        (_: string, prev: number) => prev + 1,
        0,
      )
      .option('-q, --quiet', 'Suppress non-error output', false)
      .option('--color <mode>', 'auto | always | never', 'auto')
      .option('-C, --cd <dir>', 'Change directory before running', '.')
      .option('--debug', 'Print debug traces', false);

    program.hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts() as { color?: string };
      const raw = opts.color ?? 'auto';
      const flag: ColorFlag = raw === 'always' || raw === 'never' || raw === 'auto' ? raw : 'auto';
      applyColorMode(flag);
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
      .option('--format <fmt>', 'Output format: markdown | json', 'markdown')
      .action(async (opts: { tool: string[]; detectedOnly: boolean; format: string }) => {
        if (opts.format !== 'markdown' && opts.format !== 'json') {
          process.stderr.write(`error: --format must be markdown or json (got ${opts.format})\n`);
          process.exit(2);
        }
        const env = await defaultScanEnv();
        const r = await runAgents({
          env,
          tools: opts.tool.length > 0 ? opts.tool : undefined,
          format: opts.format,
          detectedOnly: opts.detectedOnly,
          signal: controller.signal,
        });
        if (!r.ok) {
          process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
          process.exit(exitCodeForError(r.error));
        }
        process.stdout.write(`${r.output}\n`);
      });

    program
      .command('version')
      .description('Print SkillSmith version')
      .action(() => {
        process.stdout.write(`${VERSION}\n`);
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

    const args = process.argv.slice(2);
    if (args.length === 0) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync(process.argv);
    return sigint.wasInterrupted() ? 130 : 0;
  } finally {
    sigint.uninstall();
  }
};

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
