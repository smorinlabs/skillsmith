import {
  type CheckRunResult,
  type Result,
  SCOPES,
  SUPPORTED_TOOLS,
  type Scope,
  type SupportedTool,
  builtInChecks,
  defaultScanEnv,
  err,
  noopLogger,
  ok,
  resolveEffectiveConfig,
  runChecks,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderDoctorHuman } from '../output/doctor-human.ts';
import { renderDoctorJson } from '../output/doctor-json.ts';
import { failCliError, withCliErrorBoundary } from '../output/error-boundary.ts';
import { resolveArtifactPair } from '../util/artifact-pair.ts';
import { resolveCommandProjectContext } from '../util/project-context.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';
import { CLI_SELECTION_POLICIES, validateCliSelection } from './selection-validation.ts';

export interface CheckFlags {
  readonly reportOnly: boolean;
  readonly exitCode: boolean;
}

export interface CheckInputs {
  readonly cli: {
    readonly tools: readonly string[];
    readonly scope?: string;
    readonly allTools: boolean;
    readonly file?: string;
    readonly lockfile?: string;
  };
  readonly effectiveConfig: { readonly tool?: string; readonly scope?: string };
  readonly effectiveCwd: string;
}

export interface ResolvedCheckInputs {
  readonly tools: readonly SupportedTool[];
  readonly scopes: readonly Scope[];
  readonly file?: string;
  readonly lockfile?: string;
}

export interface CheckUsageError {
  readonly code: 'usage';
  readonly exitCode: 2;
  readonly message: string;
}

const usageError = (message: string): CheckUsageError => ({ code: 'usage', exitCode: 2, message });

export const resolveCheckExitCode = (
  report: CheckRunResult,
  flags: CheckFlags,
): Result<0 | 1, CheckUsageError> => {
  if (flags.reportOnly && flags.exitCode) {
    return err(usageError('--report-only cannot be combined with --exit-code'));
  }
  if (flags.reportOnly) return ok(0);
  return ok(report.counts.error > 0 ? 1 : 0);
};

const supportedTool = (value: string): SupportedTool | undefined =>
  SUPPORTED_TOOLS.find((candidate) => candidate === value);

const supportedScope = (value: string): Scope | undefined =>
  SCOPES.find((candidate) => candidate === value);

export const resolveCheckInputs = (
  input: CheckInputs,
): Result<ResolvedCheckInputs, CheckUsageError> => {
  if (input.cli.allTools && input.cli.tools.length > 0) {
    return err(usageError('--all-tools cannot be combined with --tool'));
  }
  const artifacts = resolveArtifactPair({
    effectiveCwd: input.effectiveCwd,
    ...(input.cli.file === undefined ? {} : { file: input.cli.file }),
    ...(input.cli.lockfile === undefined ? {} : { lockfile: input.cli.lockfile }),
  });
  if (!artifacts.ok) return artifacts;

  const rawTools = input.cli.allTools
    ? SUPPORTED_TOOLS
    : input.cli.tools.length > 0
      ? input.cli.tools
      : input.effectiveConfig.tool
        ? [input.effectiveConfig.tool]
        : SUPPORTED_TOOLS;
  const tools: SupportedTool[] = [];
  for (const raw of rawTools) {
    const tool = supportedTool(raw);
    if (tool === undefined) return err(usageError(`unknown tool '${raw}'`));
    tools.push(tool);
  }

  const rawScope = input.cli.scope ?? input.effectiveConfig.scope;
  const scopes: readonly Scope[] = rawScope === undefined ? SCOPES : [];
  let resolvedScopes = scopes;
  if (rawScope !== undefined) {
    const scope = supportedScope(rawScope);
    if (scope === undefined) return err(usageError(`unknown scope '${rawScope}'`));
    resolvedScopes = [scope];
  }

  if (artifacts.value.file === null || artifacts.value.lockfile === null) {
    return ok({ tools, scopes: resolvedScopes });
  }
  return ok({
    tools,
    scopes: resolvedScopes,
    file: artifacts.value.file,
    lockfile: artifacts.value.lockfile,
  });
};

const failUsage = (error: CheckUsageError, json: boolean): never =>
  failCliError(error, json ? 'json' : 'human', { exitCode: 2 });

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
      .option('--file <path>', 'Use an explicit desired-state file')
      .option('--lockfile <path>', 'Use an explicit lockfile (requires --file)')
      .option('--all-tools', 'Check every known tool instead of the configured default', false)
      .option('--report-only', 'Report errors without failing the process', false)
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
            file?: string;
            lockfile?: string;
            allTools: boolean;
            reportOnly: boolean;
            exitCode: boolean;
            json: boolean;
          },
          command: Command,
        ) => {
          if (opts.reportOnly && opts.exitCode) {
            failUsage(usageError('--report-only cannot be combined with --exit-code'), opts.json);
          }
          if (opts.allTools && opts.tool.length > 0) {
            failUsage(usageError('--all-tools cannot be combined with --tool'), opts.json);
          }
          if (opts.lockfile !== undefined && opts.file === undefined) {
            failUsage(usageError('--lockfile requires --file'), opts.json);
          }
          const selection = validateCliSelection(
            {
              targets: [],
              all: false,
              tools: opts.tool,
              ...(opts.scope === undefined ? {} : { scopes: [opts.scope] }),
              capability: 'read',
            },
            CLI_SELECTION_POLICIES.check,
            opts.json ? 'json' : 'human',
          );
          const scopeR = resolveScopeFlags(opts);
          if (!scopeR.ok) {
            return failUsage(usageError(scopeR.error.message), opts.json);
          }
          const env = await defaultScanEnv();
          const context = await resolveCommandProjectContext(command, env);
          if (!context.ok) return failCliError(context.error, opts.json ? 'json' : 'human');
          let config = await resolveEffectiveConfig(env, context.value);
          if (
            !config.ok &&
            config.error.code === 'config-error' &&
            config.error.file === context.value.discoveredConfigPath
          ) {
            const invalidProjectConfig = context.value.discoveredConfigPath;
            config = await resolveEffectiveConfig(env, context.value, {
              readFile: async (path) => (path === invalidProjectConfig ? '' : env.readText(path)),
            });
          }
          if (!config.ok) return failCliError(config.error, opts.json ? 'json' : 'human');
          const inputs = resolveCheckInputs({
            cli: {
              tools: selection.tools,
              ...(scopeR.value === null ? {} : { scope: scopeR.value }),
              allTools: opts.allTools,
              ...(opts.file === undefined ? {} : { file: opts.file }),
              ...(opts.lockfile === undefined ? {} : { lockfile: opts.lockfile }),
            },
            effectiveConfig: config.value.value,
            effectiveCwd: context.value.effectiveCwd,
          });
          if (!inputs.ok) return failUsage(inputs.error, opts.json);
          const r = await runChecks(builtInChecks, {
            env,
            mode: 'check',
            tools: inputs.value.tools,
            scopes: inputs.value.scopes,
            scopeExplicit: scopeR.value !== null,
            cwd: context.value.projectRoot ?? context.value.effectiveCwd,
            ...(inputs.value.file && inputs.value.lockfile
              ? { artifactPair: { file: inputs.value.file, lockfile: inputs.value.lockfile } }
              : {}),
            envVars: process.env,
            offline: false,
            logger: noopLogger,
          });
          if (!r.ok) {
            return failCliError(r.error, opts.json ? 'json' : 'human');
          }
          process.stdout.write(opts.json ? renderDoctorJson(r.value) : renderDoctorHuman(r.value));
          const exit = resolveCheckExitCode(r.value, opts);
          if (!exit.ok) return failUsage(exit.error, opts.json);
          if (exit.value !== 0) process.exit(exit.value);
        },
      ),
  );
