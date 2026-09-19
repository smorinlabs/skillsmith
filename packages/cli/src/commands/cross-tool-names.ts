import {
  SCOPES,
  SUPPORTED_TOOLS,
  type Scope,
  type SupportedTool,
  defaultScanEnv,
  groupCrossToolNames,
  listSkills,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderCrossToolNamesHuman } from '../output/cross-tool-names-human.ts';
import { renderCrossToolNamesJson } from '../output/cross-tool-names-json.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

export const crossToolNamesCommand = (): Command =>
  new Command('cross-tool-names')
    .description('Report skill names installed under two or more tools')
    .argument('[glob...]', 'glob filter(s)')
    .option(
      '-t, --tool <name>',
      'Narrow to a specific tool (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .addOption(
      new Option('-s, --scope <scope>', 'Narrow to a scope').choices([
        'user',
        'project',
        'system',
        'managed',
      ]),
    )
    .option('--user', 'shorthand for --scope=user', false)
    .option('--system', 'shorthand for --scope=system', false)
    .option('--project', 'shorthand for --scope=project', false)
    .option('--managed', 'shorthand for --scope=managed', false)
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
          system: boolean;
          project: boolean;
          managed: boolean;
          json: boolean;
          enabled: boolean;
          disabled: boolean;
          unconfigured: boolean;
        },
      ) => {
        const filterCount = [opts.enabled, opts.disabled, opts.unconfigured].filter(Boolean).length;
        if (filterCount > 1) {
          process.stderr.write(
            'error: --enabled, --disabled, and --unconfigured are mutually exclusive\n',
          );
          process.exit(2);
        }
        const scopeR = resolveScopeFlags(opts);
        if (!scopeR.ok) {
          process.stderr.write(`error: ${scopeR.error.message}\n`);
          process.exit(2);
        }
        const tools: readonly SupportedTool[] =
          opts.tool.length > 0 ? (opts.tool as SupportedTool[]) : SUPPORTED_TOOLS;
        const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : SCOPES;
        const enabledFilter = opts.enabled
          ? ('enabled-only' as const)
          : opts.disabled
            ? ('disabled-only' as const)
            : opts.unconfigured
              ? ('unconfigured-only' as const)
              : undefined;
        const env = await defaultScanEnv();
        const r = await listSkills(env, {
          tools,
          scopes,
          ...(globs.length > 0 ? { globs } : {}),
          ...(enabledFilter ? { enabledFilter } : {}),
          cwd: process.cwd(),
          envVars: process.env,
        });
        if (!r.ok) {
          process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
          process.exit(1);
        }
        const groups = groupCrossToolNames(r.value);
        process.stdout.write(
          opts.json
            ? renderCrossToolNamesJson(groups)
            : renderCrossToolNamesHuman(groups, r.value.length),
        );
      },
    );
