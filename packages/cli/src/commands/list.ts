import {
  SCOPES,
  SUPPORTED_TOOLS,
  type Scope,
  type SupportedTool,
  defaultScanEnv,
  listSkills,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { renderListHuman } from '../output/list-human.ts';
import { renderListJson } from '../output/list-json.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

export const listCommand = (): Command =>
  new Command('list')
    .alias('ls')
    .description('List installed skills across tools and scopes')
    .argument('[glob...]', 'glob filter(s)')
    .option(
      '-t, --tool <name>',
      'Narrow to a specific tool (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .addOption(
      new Option('-s, --scope <scope>', 'Narrow to a scope').choices(['user', 'project', 'system']),
    )
    .option('--user', 'shorthand for --scope=user', false)
    .option('--system', 'shorthand for --scope=system', false)
    .option('--project', 'shorthand for --scope=project', false)
    .option('--duplicates', 'Show only cross-scope duplicates', false)
    .option('-l, --long', 'Show paths and details', false)
    .option('--json', 'Emit JSON', false)
    .action(
      async (
        globs: string[],
        opts: {
          tool: string[];
          scope?: string;
          user: boolean;
          system: boolean;
          project: boolean;
          duplicates: boolean;
          long: boolean;
          json: boolean;
        },
      ) => {
        const scopeR = resolveScopeFlags(opts);
        if (!scopeR.ok) {
          process.stderr.write(`error: ${scopeR.error.message}\n`);
          process.exit(2);
        }
        const tools: readonly SupportedTool[] =
          opts.tool.length > 0 ? (opts.tool as SupportedTool[]) : SUPPORTED_TOOLS;
        const scopes: readonly Scope[] = scopeR.value ? [scopeR.value] : SCOPES;
        const env = await defaultScanEnv();
        const r = await listSkills(env, {
          tools,
          scopes,
          ...(globs.length > 0 ? { globs } : {}),
          duplicatesOnly: opts.duplicates,
          cwd: process.cwd(),
          envVars: process.env,
        });
        if (!r.ok) {
          process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
          process.exit(1);
        }
        process.stdout.write(
          opts.json ? renderListJson(r.value) : renderListHuman(r.value, { long: opts.long }),
        );
      },
    );
