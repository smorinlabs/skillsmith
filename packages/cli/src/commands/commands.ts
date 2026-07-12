import {
  SUPPORTED_TOOLS,
  type Scope,
  type SupportedTool,
  defaultScanEnv,
  listCommands,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderCommandsHuman } from '../output/commands-human.ts';
import { renderCommandsJson } from '../output/commands-json.ts';
import { failCliError, withCliErrorBoundary } from '../output/error-boundary.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

const COMMAND_SCOPES: readonly Scope[] = ['user', 'project'];

export const commandsCommand = (): Command =>
  withCliErrorBoundary(
    new Command('commands')
      .description('List installed slash commands across tools and scopes')
      .argument('[glob...]', 'glob filter(s)')
      .option(
        '-t, --tool <name>',
        'Narrow to a specific tool (repeatable)',
        (value: string, prev: string[]) => [...prev, value],
        [] as string[],
      )
      .addOption(
        new Option('-s, --scope <scope>', 'Narrow to a scope (user or project only)').choices([
          'user',
          'project',
        ]),
      )
      .option('--user', 'shorthand for --scope=user', false)
      .option('--project', 'shorthand for --scope=project', false)
      .option('-l, --long', 'Show paths and details', false)
      .option('--json', 'Emit JSON', false)
      .option('--enabled', 'Show only enabled entries', false)
      .option('--disabled', 'Show only disabled entries', false)
      .option('--unconfigured', 'Show only entries that have never been toggled', false)
      .action(
        async (
          globs: string[],
          opts: {
            tool: string[];
            scope?: string;
            user: boolean;
            project: boolean;
            long: boolean;
            json: boolean;
            enabled: boolean;
            disabled: boolean;
            unconfigured: boolean;
          },
        ) => {
          const filterCount = [opts.enabled, opts.disabled, opts.unconfigured].filter(
            Boolean,
          ).length;
          if (filterCount > 1) {
            failCliError({
              code: 'commander.invalidArgument',
              message: '--enabled, --disabled, and --unconfigured are mutually exclusive',
            });
          }
          const scopeR = resolveScopeFlags(opts);
          if (!scopeR.ok) {
            return failCliError({
              code: 'commander.invalidArgument',
              message: scopeR.error.message,
            });
          }
          if (scopeR.value === 'system' || scopeR.value === 'managed') {
            return failCliError({
              code: 'commander.invalidArgument',
              message: `scope '${scopeR.value}' is not available for commands (user or project only)`,
            });
          }
          const tools: readonly SupportedTool[] =
            opts.tool.length > 0 ? (opts.tool as SupportedTool[]) : SUPPORTED_TOOLS;
          const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : COMMAND_SCOPES;
          const enabledFilter = opts.enabled
            ? ('enabled-only' as const)
            : opts.disabled
              ? ('disabled-only' as const)
              : opts.unconfigured
                ? ('unconfigured-only' as const)
                : undefined;
          const env = await defaultScanEnv();
          const r = await listCommands(env, {
            tools,
            scopes,
            ...(globs.length > 0 ? { globs } : {}),
            ...(enabledFilter ? { enabledFilter } : {}),
            cwd: process.cwd(),
            envVars: process.env,
          });
          if (!r.ok) {
            return failCliError(r.error, opts.json ? 'json' : 'human');
          }
          process.stdout.write(
            opts.json
              ? renderCommandsJson(r.value)
              : renderCommandsHuman(r.value, { long: opts.long }),
          );
        },
      ),
  );
