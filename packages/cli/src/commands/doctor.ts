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
import { CLI_SELECTION_POLICIES, validateCliSelection } from './selection-validation.ts';

export const doctorCommand = (): Command =>
  withCliErrorBoundary(
    new Command('doctor')
      .description('Diagnose SkillSmith and target-tool readiness')
      .option(
        '-t, --tool <name>',
        'Limit checks to tool(s). Repeatable.',
        (value: string, prev: string[]) => [...prev, value],
        [] as string[],
      )
      .addOption(
        new Option('-s, --scope <scope>', 'Limit to scope').choices([
          'system',
          'user',
          'project',
          'managed',
        ]),
      )
      .option('--user', 'shorthand for --scope=user', false)
      .option('--system', 'shorthand for --scope=system', false)
      .option('--project', 'shorthand for --scope=project', false)
      .option('--offline', 'Skip network checks', false)
      .option('--strict', 'Treat warnings as failures', false)
      .option('--json', 'Emit JSON', false)
      .action(
        async (
          opts: {
            tool: string[];
            scope?: string;
            user: boolean;
            system: boolean;
            project: boolean;
            offline: boolean;
            strict: boolean;
            json: boolean;
          },
          command: Command,
        ) => {
          const selection = validateCliSelection(
            {
              targets: [],
              all: false,
              tools: opts.tool,
              ...(opts.scope === undefined ? {} : { scopes: [opts.scope] }),
              capability: 'read',
            },
            CLI_SELECTION_POLICIES.doctor,
            opts.json ? 'json' : 'human',
          );
          const scopeR = resolveScopeFlags(opts);
          if (!scopeR.ok) {
            return failCliError({
              code: 'commander.invalidArgument',
              message: scopeR.error.message,
            });
          }
          const tools: readonly SupportedTool[] =
            selection.tools.length > 0 ? selection.tools : SUPPORTED_TOOLS;
          const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : SCOPES;
          const env = await defaultScanEnv();
          const context = await resolveCommandProjectContext(command, env);
          if (!context.ok) return failCliError(context.error, opts.json ? 'json' : 'human');
          const r = await runChecks(builtInChecks, {
            env,
            mode: 'doctor',
            tools,
            scopes,
            scopeExplicit: scopeR.value !== null,
            cwd: context.value.projectRoot ?? context.value.effectiveCwd,
            envVars: process.env,
            offline: opts.offline,
            logger: noopLogger,
          });
          if (!r.ok) {
            return failCliError(r.error, opts.json ? 'json' : 'human');
          }
          process.stdout.write(opts.json ? renderDoctorJson(r.value) : renderDoctorHuman(r.value));
          const hadError = r.value.counts.error > 0;
          const hadWarning = r.value.counts.warning > 0;
          if (hadError || (opts.strict && hadWarning)) process.exit(1);
        },
      ),
  );
