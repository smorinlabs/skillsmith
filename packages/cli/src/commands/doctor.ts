import {
  SCOPES,
  SUPPORTED_TOOLS,
  type Scope,
  type SupportedTool,
  builtInChecks,
  defaultScanEnv,
  noopLogger,
  resolveEffectiveConfig,
  runChecks,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderDoctorHuman } from '../output/doctor-human.ts';
import { renderDoctorJson } from '../output/doctor-json.ts';
import { failCliError, withCliErrorBoundary } from '../output/error-boundary.ts';
import { resolveArtifactPair } from '../util/artifact-pair.ts';
import { renderConfigNotices } from '../util/config-notice.ts';
import { resolveCommandProjectContext } from '../util/project-context.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';
import { singularOption } from '../util/singular-option.ts';
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
      .option('--file <path>', 'Use an explicit desired-state file', singularOption('--file'))
      .option(
        '--lockfile <path>',
        'Use an explicit lockfile (requires --file)',
        singularOption('--lockfile'),
      )
      .option('--all-tools', 'Diagnose every known tool instead of the configured default', false)
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
            file?: string;
            lockfile?: string;
            allTools: boolean;
            offline: boolean;
            strict: boolean;
            json: boolean;
          },
          command: Command,
        ) => {
          if (opts.allTools && opts.tool.length > 0) {
            return failCliError(
              { code: 'usage', message: '--all-tools cannot be combined with --tool' },
              opts.json ? 'json' : 'human',
              { exitCode: 2 },
            );
          }
          if (opts.lockfile !== undefined && opts.file === undefined) {
            return failCliError(
              { code: 'usage', message: '--lockfile requires --file' },
              opts.json ? 'json' : 'human',
              { exitCode: 2 },
            );
          }
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
          const effectiveConfig =
            !opts.json && opts.file === undefined
              ? await resolveEffectiveConfig(env, context.value)
              : null;
          const artifacts = resolveArtifactPair({
            effectiveCwd: context.value.effectiveCwd,
            ...(opts.file === undefined ? {} : { file: opts.file }),
            ...(opts.lockfile === undefined ? {} : { lockfile: opts.lockfile }),
          });
          if (!artifacts.ok) {
            return failCliError(artifacts.error, opts.json ? 'json' : 'human', { exitCode: 2 });
          }
          const r = await runChecks(builtInChecks, {
            env,
            mode: 'doctor',
            tools,
            scopes,
            scopeExplicit: scopeR.value !== null,
            cwd: context.value.projectRoot ?? context.value.effectiveCwd,
            ...(artifacts.value.file && artifacts.value.lockfile
              ? {
                  artifactPair: {
                    file: artifacts.value.file,
                    lockfile: artifacts.value.lockfile,
                  },
                }
              : {}),
            envVars: process.env,
            offline: opts.offline,
            logger: noopLogger,
          });
          if (!r.ok) {
            return failCliError(r.error, opts.json ? 'json' : 'human');
          }
          if (effectiveConfig?.ok) {
            process.stderr.write(renderConfigNotices(effectiveConfig.value, 'human'));
          }
          process.stdout.write(opts.json ? renderDoctorJson(r.value) : renderDoctorHuman(r.value));
          const hadError = r.value.counts.error > 0;
          const hadWarning = r.value.counts.warning > 0;
          if (hadError || (opts.strict && hadWarning)) process.exit(1);
        },
      ),
  );
