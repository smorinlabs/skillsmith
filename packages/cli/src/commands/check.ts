import {
  SCOPES,
  SUPPORTED_TOOLS,
  type Scope,
  type SupportedTool,
  builtInChecks,
  defaultScanEnv,
  noopLogger,
  runChecks,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderDoctorHuman } from '../output/doctor-human.ts';
import { renderDoctorJson } from '../output/doctor-json.ts';
import { failCliError, withCliErrorBoundary } from '../output/error-boundary.ts';
import { resolveCommandProjectContext } from '../util/project-context.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

export const checkCommand = (): Command =>
  withCliErrorBoundary(
    new Command('check')
      .description('Error-severity subset of doctor, suitable for CI')
      .option(
        '-t, --tool <name>',
        'Limit checks to tool(s).',
        (value: string, prev: string[]) => [...prev, value],
        [] as string[],
      )
      .addOption(
        new Option('-s, --scope <scope>', 'Limit to scope').choices(['user', 'project', 'system']),
      )
      .option('--user', 'shorthand for --scope=user', false)
      .option('--system', 'shorthand for --scope=system', false)
      .option('--project', 'shorthand for --scope=project', false)
      .option('--exit-code', 'Exit non-zero on any error finding', false)
      .option('--json', 'Emit JSON', false)
      .action(
        async (
          opts: {
            tool: string[];
            scope?: string;
            user: boolean;
            system: boolean;
            project: boolean;
            exitCode: boolean;
            json: boolean;
          },
          command: Command,
        ) => {
          const scopeR = resolveScopeFlags(opts);
          if (!scopeR.ok) {
            return failCliError({
              code: 'commander.invalidArgument',
              message: scopeR.error.message,
            });
          }
          const tools: readonly SupportedTool[] =
            opts.tool.length > 0 ? (opts.tool as SupportedTool[]) : SUPPORTED_TOOLS;
          const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : SCOPES;
          const env = await defaultScanEnv();
          const context = await resolveCommandProjectContext(command, env);
          if (!context.ok) return failCliError(context.error, opts.json ? 'json' : 'human');
          const r = await runChecks(builtInChecks, {
            env,
            mode: 'check',
            tools,
            scopes,
            scopeExplicit: scopeR.value !== null,
            cwd: context.value.projectRoot ?? context.value.effectiveCwd,
            envVars: process.env,
            offline: false,
            logger: noopLogger,
          });
          if (!r.ok) {
            return failCliError(r.error, opts.json ? 'json' : 'human');
          }
          process.stdout.write(opts.json ? renderDoctorJson(r.value) : renderDoctorHuman(r.value));
          if (opts.exitCode && r.value.counts.error > 0) process.exit(1);
        },
      ),
  );
