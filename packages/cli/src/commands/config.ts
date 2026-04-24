import { type Scope, type SkillSmithError, defaultScanEnv } from '@skillsmith/core';
import { Command, Option } from 'commander';
import { exitCodeForError } from '../util/exit-codes.ts';
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

function writeConfigError(err: ConfigError): never {
  if (err.code === 'unknown-key') {
    process.stderr.write(`error: unknown config key '${err.key}'\n`);
    process.exit(2);
  }
  if (err.code === 'unset') {
    process.stderr.write(
      `error: '${err.key}' is not set${err.scope ? ` at ${err.scope} scope` : ''}\n`,
    );
    process.exit(1);
  }
  if (err.code === 'invalid-value') {
    process.stderr.write(
      `error: invalid value '${err.value}' for '${err.key}' (allowed: ${err.allowed.join(', ')})\n`,
    );
    process.exit(2);
  }
  process.stderr.write(`error: ${JSON.stringify(err)}\n`);
  process.exit(exitCodeForError(err));
}

export const configCommand = (): Command => {
  const cmd = new Command('config').description('Manage SkillSmith configuration');

  cmd
    .command('get <key>')
    .description('Print a config value')
    .addOption(scopeOption())
    .option('--json', 'Emit JSON', false)
    .action(async (key: string, opts: { scope?: Scope; json: boolean }) => {
      const env = await defaultScanEnv();
      const r = await runConfigGet({
        env,
        key,
        ...(opts.scope ? { scope: opts.scope } : {}),
        json: opts.json,
      });
      if (!r.ok) writeConfigError(r.error);
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
    .action(async (key: string, value: string, opts: { scope?: Scope }) => {
      const env = await defaultScanEnv();
      const r = await runConfigSet({
        env,
        key,
        value,
        ...(opts.scope ? { scope: opts.scope } : {}),
      });
      if (!r.ok) writeConfigError(r.error);
      process.stderr.write(`wrote ${r.file}\n`);
    });

  cmd
    .command('list')
    .description('List effective config (or a single scope)')
    .addOption(scopeOption())
    .option('--json', 'Emit JSON', false)
    .action(async (opts: { scope?: Scope; json: boolean }) => {
      const env = await defaultScanEnv();
      const r = await runConfigList({
        env,
        ...(opts.scope ? { scope: opts.scope } : {}),
        json: opts.json,
      });
      if (!r.ok) writeConfigError(r.error);
      process.stdout.write(r.output);
    });

  cmd
    .command('unset <key>')
    .description('Remove a config value (default scope: user)')
    .addOption(scopeOption())
    .action(async (key: string, opts: { scope?: Scope }) => {
      const env = await defaultScanEnv();
      const r = await runConfigUnset({
        env,
        key,
        ...(opts.scope ? { scope: opts.scope } : {}),
      });
      if (!r.ok) writeConfigError(r.error);
      process.stderr.write(`updated ${r.file}\n`);
    });

  return cmd;
};
