import { resolve } from 'node:path';
import {
  type VerifyReport,
  type VerifyTool,
  defaultScanEnv,
  getAgent,
  verifyPlugin,
} from '@skillsmith/core';
import { Argument, Command, Option } from 'commander';
import {
  CLI_SELECTION_POLICIES,
  validateCliAdapterSelection,
} from '../../commands/selection-validation.ts';
import {
  normalizeCliError,
  renderCliError,
  withCliErrorBoundary,
} from '../../output/error-boundary.ts';
import { renderVerifyHuman } from '../../output/verify-human.ts';
import { renderVerifyJson } from '../../output/verify-json.ts';

const TOOL_LABEL: Record<VerifyTool, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

const collectTool = (value: string, prev: string[]): string[] => {
  return [...prev, value];
};

export const verifyExitCode = (report: VerifyReport): 0 | 1 | 4 => {
  if (report.summary.verdict === 'fail') return 1;
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
  withCliErrorBoundary(
    new Command('verify')
      .description('Verify that a plugin loads under each target tool')
      .addArgument(new Argument('<path>', 'Plugin or bare skill directory'))
      .addOption(
        new Option(
          '-t, --tool <name>',
          'Restrict to tool(s): claude-code | codex. Repeatable. Default: all detected.',
        )
          .choices(['claude-code', 'codex', 'kilo-code', 'opencode'])
          .argParser(collectTool)
          .default([] as string[]),
      )
      .option('--static', 'Static verification only (no auth, no model call). Default.', false)
      .option(
        '--deep',
        'Also run session-backed load verification (isolated; no auth, no model call).',
        false,
      )
      .option('--strict', 'Treat warnings as failures (exit 1 on any warning).', false)
      .option('--json', 'Emit the versioned JSON report on stdout.', false)
      .action(
        async (
          pathArg: string,
          opts: { tool: string[]; static: boolean; deep: boolean; strict: boolean; json: boolean },
        ) => {
          const selection = validateCliAdapterSelection(
            {
              targets: [pathArg],
              all: false,
              tools: opts.tool,
              capability: 'read',
            },
            CLI_SELECTION_POLICIES.verify,
            opts.json ? 'json' : 'human',
          );
          const env = await defaultScanEnv();
          const tools: readonly VerifyTool[] = selection.tools;
          const r = await verifyPlugin(env, {
            path: resolve(pathArg),
            ...(tools.length > 0 ? { tools } : {}),
            deep: opts.deep,
            strict: opts.strict,
            ...(signal ? { signal } : {}),
          });

          if (!r.ok) {
            if (signal?.aborted) process.exit(130);
            const error = normalizeCliError(
              r.error.code === 'generic'
                ? { code: 'commander.invalidArgument', message: r.error.message }
                : r.error,
            );
            const format = opts.json ? 'json' : 'human';
            (opts.json ? process.stdout : process.stderr).write(renderCliError(error, format));
            process.exit(error.exitCode);
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
      ),
  );
