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
import { resolveScopeFlags } from '../util/scope-resolver.ts';

export const doctorCommand = (): Command =>
  new Command('doctor')
    .description('Diagnose SkillSmith and target-tool readiness')
    .option(
      '-t, --tool <name>',
      'Limit checks to tool(s). Repeatable.',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .addOption(
      new Option('-s, --scope <scope>', 'Limit to scope').choices(['user', 'project', 'system']),
    )
    .option('--user', 'shorthand for --scope=user', false)
    .option('--system', 'shorthand for --scope=system', false)
    .option('--project', 'shorthand for --scope=project', false)
    .option('--offline', 'Skip network checks', false)
    .option('--strict', 'Treat warnings as failures', false)
    .option('--json', 'Emit JSON', false)
    .action(
      async (opts: {
        tool: string[];
        scope?: string;
        user: boolean;
        system: boolean;
        project: boolean;
        offline: boolean;
        strict: boolean;
        json: boolean;
      }) => {
        const scopeR = resolveScopeFlags(opts);
        if (!scopeR.ok) {
          process.stderr.write(`error: ${scopeR.error.message}\n`);
          process.exit(2);
        }
        const tools: readonly SupportedTool[] =
          opts.tool.length > 0 ? (opts.tool as SupportedTool[]) : SUPPORTED_TOOLS;
        const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : SCOPES;
        const env = await defaultScanEnv();
        const r = await runChecks(builtInChecks, {
          env,
          mode: 'doctor',
          tools,
          scopes,
          scopeExplicit: scopeR.value !== null,
          cwd: process.cwd(),
          envVars: process.env,
          offline: opts.offline,
          logger: noopLogger,
        });
        if (!r.ok) {
          process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
          process.exit(1);
        }
        process.stdout.write(opts.json ? renderDoctorJson(r.value) : renderDoctorHuman(r.value));
        const hadError = r.value.counts.error > 0;
        const hadWarning = r.value.counts.warning > 0;
        if (hadError || (opts.strict && hadWarning)) process.exit(1);
      },
    );
