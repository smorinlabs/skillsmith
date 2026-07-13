import {
  type Scope,
  type SkillSmithError,
  defaultScanEnv,
  resolveEffectiveConfig,
} from '@skillsmith/core';
import { Command, Option } from 'commander';
import { failCliError, withCliErrorBoundary } from '../../output/error-boundary.ts';
import { renderConfigNotices } from '../../util/config-notice.ts';
import { resolveCommandProjectContext } from '../../util/project-context.ts';
import { runConfigGet } from './config/get.ts';
import { runConfigList } from './config/list.ts';
import { runConfigSet } from './config/set.ts';
import { runConfigUnset } from './config/unset.ts';

const scopeOption = () =>
  new Option('--scope <s>', 'user | project | system').choices(['user', 'project', 'system']);

type ConfigError =
  | { code: 'unknown-key'; key: string }
  | { code: 'unset'; key: string; scope?: Scope }
  | { code: 'invalid-value'; key: string; value: string; allowed: readonly string[] }
  | SkillSmithError;

function writeConfigError(err: ConfigError, json = false): never {
  const format = json ? 'json' : 'human';
  if (err.code === 'unknown-key') {
    return failCliError(
      { code: 'commander.invalidArgument', message: `unknown config key '${err.key}'` },
      format,
    );
  }
  if (err.code === 'unset') {
    return failCliError(
      {
        code: 'generic',
        message: `'${err.key}' is not set${err.scope ? ` at ${err.scope} scope` : ''}`,
      },
      format,
    );
  }
  if (err.code === 'invalid-value') {
    return failCliError(
      {
        code: 'commander.invalidArgument',
        message: `invalid value '${err.value}' for '${err.key}' (allowed: ${err.allowed.join(', ')})`,
      },
      format,
    );
  }
  return failCliError(err, format);
}

export const configCommand = (): Command => {
  const cmd = withCliErrorBoundary(
    new Command('config').description('Manage SkillSmith configuration'),
  );

  cmd
    .command('get <key>')
    .description('Print a config value')
    .addOption(scopeOption())
    .option('--json', 'Emit JSON', false)
    .action(async (key: string, opts: { scope?: Scope; json: boolean }, command: Command) => {
      const env = await defaultScanEnv();
      const context = await resolveCommandProjectContext(command, env);
      if (!context.ok) writeConfigError(context.error, opts.json);
      let effectiveConfig: Awaited<ReturnType<typeof resolveEffectiveConfig>> | undefined;
      const r = await runConfigGet({
        env,
        key,
        ...(opts.scope ? { scope: opts.scope } : {}),
        json: opts.json,
        loadConfig: async (scanEnv) => {
          effectiveConfig = await resolveEffectiveConfig(scanEnv, context.value);
          return effectiveConfig;
        },
      });
      if (!r.ok) writeConfigError(r.error, opts.json);
      if (effectiveConfig?.ok) {
        process.stderr.write(
          renderConfigNotices(effectiveConfig.value, opts.json ? 'json' : 'human'),
        );
      }
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ key, value: r.value, ...(r.source ? { source: r.source } : {}) }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`${r.value}\n`);
      }
    });

  cmd
    .command('set <key> <value>')
    .description('Set a config value (default scope: user)')
    .addOption(scopeOption())
    .action(async (key: string, value: string, opts: { scope?: Scope }, command: Command) => {
      const env = await defaultScanEnv();
      const context = await resolveCommandProjectContext(command, env);
      if (!context.ok) writeConfigError(context.error);
      const r = await runConfigSet({
        env,
        key,
        value,
        ...(opts.scope ? { scope: opts.scope } : {}),
        cwd: context.value.projectRoot ?? context.value.effectiveCwd,
      });
      if (!r.ok) writeConfigError(r.error);
      process.stderr.write(`wrote ${r.file}\n`);
    });

  cmd
    .command('list')
    .description('List effective config (or a single scope)')
    .addOption(scopeOption())
    .option('--json', 'Emit JSON', false)
    .action(async (opts: { scope?: Scope; json: boolean }, command: Command) => {
      const env = await defaultScanEnv();
      const context = await resolveCommandProjectContext(command, env);
      if (!context.ok) writeConfigError(context.error, opts.json);
      let effectiveConfig: Awaited<ReturnType<typeof resolveEffectiveConfig>> | undefined;
      const r = await runConfigList({
        env,
        ...(opts.scope ? { scope: opts.scope } : {}),
        json: opts.json,
        loadConfig: async (scanEnv) => {
          effectiveConfig = await resolveEffectiveConfig(scanEnv, context.value);
          return effectiveConfig;
        },
      });
      if (!r.ok) writeConfigError(r.error, opts.json);
      if (effectiveConfig?.ok) {
        process.stderr.write(
          renderConfigNotices(effectiveConfig.value, opts.json ? 'json' : 'human'),
        );
      }
      process.stdout.write(r.output);
    });

  cmd
    .command('unset <key>')
    .description('Remove a config value (default scope: user)')
    .addOption(scopeOption())
    .action(async (key: string, opts: { scope?: Scope }, command: Command) => {
      const env = await defaultScanEnv();
      const context = await resolveCommandProjectContext(command, env);
      if (!context.ok) writeConfigError(context.error);
      const r = await runConfigUnset({
        env,
        key,
        ...(opts.scope ? { scope: opts.scope } : {}),
        cwd: context.value.projectRoot ?? context.value.effectiveCwd,
      });
      if (!r.ok) writeConfigError(r.error);
      process.stderr.write(`updated ${r.file}\n`);
    });

  return cmd;
};
