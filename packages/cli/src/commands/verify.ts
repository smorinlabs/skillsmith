import { resolve } from 'node:path';
import {
  type VerifyReport,
  type VerifyTool,
  defaultScanEnv,
  getAgent,
  verifyPlugin,
} from '@skillsmith/core';
import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { renderVerifyHuman } from '../output/verify-human.ts';
import { renderVerifyJson } from '../output/verify-json.ts';

const TOOL_LABEL: Record<VerifyTool, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

const collectTool = (value: string, prev: string[]): string[] => {
  if (value !== 'claude-code' && value !== 'codex')
    throw new InvalidArgumentError(`--tool must be one of claude-code, codex (got '${value}')`);
  return [...prev, value];
};

// `program.exitOverride()` (program.ts) is not inherited by commands attached via
// `addCommand` (only `.command()`-created subcommands copy parent settings), so a bad
// --tool value here would otherwise fall through commander's own `process.exit(1)`
// instead of our exit-2 usage-error contract. Mirror the same mapping locally.
const USAGE_ERROR_CODES = new Set([
  'commander.invalidArgument',
  'commander.missingArgument',
  'commander.unknownOption',
  'commander.excessArguments',
  'commander.missingMandatoryOptionValue',
]);

export const verifyExitCode = (report: VerifyReport): 0 | 1 | 4 => {
  if (report.summary.verdict === 'fail') return 1;
  if (report.summary.verdict === 'inconclusive') return 4;
  const anyRan = report.tools.some((t) => t.modes.some((m) => m.status === 'ran'));
  if (!anyRan) return 4;
  if (report.requested.explicitTools && report.tools.some((t) => !t.available)) return 4;
  if (report.requested.modes.includes('deep')) {
    const deepGap = report.tools.some(
      (t) => t.available && !t.modes.some((m) => m.mode === 'deep' && m.status === 'ran'),
    );
    if (deepGap) return 4;
  }
  return 0;
};

export const verifyCommand = (signal?: AbortSignal): Command =>
  new Command('verify')
    .description('Verify that a plugin loads under each target tool')
    .addArgument(new Argument('<path>', 'Plugin or bare skill directory'))
    .addOption(
      new Option(
        '-t, --tool <name>',
        'Restrict to tool(s): claude-code | codex. Repeatable. Default: all detected.',
      )
        .choices(['claude-code', 'codex'])
        .argParser(collectTool)
        .default([] as string[]),
    )
    .option('--static', 'Static verification only (no auth, no model call). Default.', false)
    .option(
      '--deep',
      'Also run native load verification (isolated; no auth, no model call).',
      false,
    )
    .option('--strict', 'Treat warnings as failures (exit 1 on any warning).', false)
    .option('--json', 'Emit the versioned JSON report on stdout.', false)
    .exitOverride((err) => {
      if (USAGE_ERROR_CODES.has(err.code)) process.exit(2);
      if (err.code === 'commander.helpDisplayed') process.exit(0);
      process.exit(err.exitCode ?? 1);
    })
    .action(
      async (
        pathArg: string,
        opts: { tool: string[]; static: boolean; deep: boolean; strict: boolean; json: boolean },
      ) => {
        const env = await defaultScanEnv();
        const tools = opts.tool as VerifyTool[];
        const r = await verifyPlugin(env, {
          path: resolve(pathArg),
          ...(tools.length > 0 ? { tools } : {}),
          deep: opts.deep,
          strict: opts.strict,
          ...(signal ? { signal } : {}),
        });

        if (!r.ok) {
          if (signal?.aborted) process.exit(130);
          process.stderr.write(
            `error: ${r.error.code === 'generic' ? r.error.message : JSON.stringify(r.error)}\n`,
          );
          process.exit(2);
        }

        const code = verifyExitCode(r.value);

        for (const tool of tools) {
          const verdict = r.value.tools.find((t) => t.tool === tool);
          if (!verdict || verdict.available) continue;
          const agentR = getAgent(tool);
          const installHint = agentR.ok ? agentR.value.installHint : '';
          process.stderr.write(
            `error: cannot verify: target tool '${tool}' is not installed on this system.\n\n` +
              `  'verify --tool ${tool}' requires the ${TOOL_LABEL[tool]} CLI. To install it:\n\n` +
              `    ${installHint}\n\n` +
              `  Re-run once installed, or drop --tool ${tool} to verify with detected tools only.\n`,
          );
        }

        process.stdout.write(
          opts.json ? renderVerifyJson(r.value) : renderVerifyHuman(r.value, code),
        );
        process.exit(signal?.aborted ? 130 : code);
      },
    );
