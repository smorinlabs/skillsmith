import type { OptionInvocationResult } from './types.ts';

const failure = (message: string): OptionInvocationResult => ({
  ok: false,
  error: { code: 'usage', exitCode: 2, message },
});

const has = (args: readonly string[], flag: string): boolean => args.includes(flag);
const count = (args: readonly string[], flag: string): number =>
  args.filter((value) => value === flag).length;

const VALUE_OPTIONS = new Set([
  '--color',
  '--config',
  '--cd',
  '-C',
  '--tool',
  '-t',
  '--scope',
  '-s',
  '--file',
  '--lockfile',
  '--ref',
  '--source',
  '--dest',
]);

const positionals = (args: readonly string[]): readonly string[] => {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === undefined) continue;
    if (VALUE_OPTIONS.has(value)) {
      index++;
      continue;
    }
    if (!value.startsWith('-')) values.push(value);
  }
  return values;
};

const conflict = (
  args: readonly string[],
  left: string,
  right: string,
  message = `${left} cannot be combined with ${right}`,
): OptionInvocationResult | null => (has(args, left) && has(args, right) ? failure(message) : null);

const scopeConflict = (args: readonly string[]): OptionInvocationResult | null => {
  const selectors = ['--scope', '--user', '--project', '--system', '--managed'].filter((flag) =>
    has(args, flag),
  );
  return selectors.length > 1
    ? failure(`scope selectors cannot be combined: ${selectors.join(', ')}`)
    : null;
};

const exclusive = (
  args: readonly string[],
  flags: readonly string[],
): OptionInvocationResult | null => {
  const selected = flags.filter((flag) => has(args, flag));
  return selected.length > 1
    ? failure(`options are mutually exclusive: ${selected.join(', ')}`)
    : null;
};

export const validateOptionInvocation = (
  command: string,
  args: readonly string[],
): OptionInvocationResult => {
  if (command === 'skillsmith') {
    return (
      conflict(args, '--quiet', '--verbose') ??
      conflict(args, '--quiet', '--debug') ??
      conflict(args, '--color', '--no-color') ?? { ok: true }
    );
  }

  if (command === 'skillsmith list' || command === 'skillsmith commands') {
    return exclusive(args, ['--enabled', '--disabled', '--unconfigured']) ?? { ok: true };
  }

  if (command.startsWith('skillsmith config ')) return scopeConflict(args) ?? { ok: true };

  if (command === 'skillsmith doctor' || command === 'skillsmith check') {
    const allTools = conflict(args, '--all-tools', '--tool');
    if (allTools) return allTools;
    if (has(args, '--lockfile') && !has(args, '--file'))
      return failure('--lockfile requires --file');
    if (command === 'skillsmith check') {
      return conflict(args, '--report-only', '--exit-code') ?? { ok: true };
    }
    return { ok: true };
  }

  if (command === 'skillsmith verify') {
    return conflict(args, '--static', '--deep') ?? { ok: true };
  }

  if (command === 'skillsmith install') {
    const relation =
      conflict(args, '--deep', '--no-verify') ??
      conflict(args, '--yes', '--dry-run') ??
      scopeConflict(args);
    if (relation) return relation;
    if (has(args, '--ref') && positionals(args).length !== 1)
      return failure('--ref requires exactly one source target');
    return { ok: true };
  }

  if (command === 'skillsmith uninstall') {
    const scope = scopeConflict(args);
    if (scope) return scope;
    if (
      has(args, '--all-scopes') &&
      ['--scope', '--user', '--project'].some((flag) => has(args, flag))
    ) {
      return failure('--all-scopes cannot be combined with singular scope selectors');
    }
    return conflict(args, '--yes', '--dry-run') ?? { ok: true };
  }

  if (command === 'skillsmith dev') {
    const relation =
      conflict(args, '--all', '--source') ??
      conflict(args, '--yes', '--dry-run') ??
      conflict(args, '--rollback', '--source') ??
      conflict(args, '--rollback', '--dest') ??
      conflict(args, '--rollback', '--strict') ??
      conflict(args, '--rollback', '--no-verify');
    if (relation) return relation;
    const targets = positionals(args);
    if (has(args, '--all') && targets.length > 0)
      return failure('--all cannot be combined with positional targets');
    if (has(args, '--source') && targets.length !== 1)
      return failure('--source requires exactly one target');
    if (has(args, '--dest') && count(args, '--tool') + count(args, '-t') !== 1)
      return failure('--dest requires exactly one --tool');
    return { ok: true };
  }

  if (command === 'skillsmith promote') {
    const relation =
      conflict(args, '--yes', '--dry-run') ??
      conflict(args, '--rollback', '--strict') ??
      conflict(args, '--rollback', '--no-verify') ??
      conflict(args, '--rollback', '--allow-dirty');
    if (relation) return relation;
    if (has(args, '--all') && positionals(args).length > 0)
      return failure('--all cannot be combined with positional targets');
  }

  return { ok: true };
};
