import currentState from '../contracts/commander-current-state-v0.json' with { type: 'json' };
import type { CommandOptionSpec } from './types.ts';

const KNOWN_TOOLS = ['claude-code', 'codex', 'kilo-code', 'opencode'] as const;
const KNOWN_SCOPES = ['system', 'user', 'project', 'managed'] as const;
const KNOWN_COLORS = ['auto', 'always', 'never'] as const;

const ALLOWED_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'skillsmith list': KNOWN_SCOPES,
  'skillsmith commands': ['user', 'project'],
  'skillsmith doctor': ['user', 'project', 'system'],
  'skillsmith check': ['user', 'project', 'system'],
  'skillsmith config get': ['user', 'project', 'system'],
  'skillsmith config set': ['user', 'project', 'system'],
  'skillsmith config list': ['user', 'project', 'system'],
  'skillsmith config unset': ['user', 'project', 'system'],
  'skillsmith install': ['user', 'project'],
  'skillsmith uninstall': ['user', 'project'],
};

type StateOption = {
  readonly flags: string;
  readonly short: string | null;
  readonly long: string | null;
  readonly attributeName: string;
  readonly valueShape: 'boolean' | 'required' | 'optional';
  readonly choices: readonly string[];
  readonly defaultValue: string;
  readonly repeatable: boolean;
  readonly negated: boolean;
};

const decodeDefault = (value: string): unknown => {
  if (value === 'null' || value === 'unset') return undefined;
  if (value === 'resolved-by-command-contract') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const optionFromState = (path: string, option: StateOption): CommandOptionSpec => {
  const long = option.long ?? option.flags;
  const isTool = long === '--tool';
  const isScope = long === '--scope';
  const isColor = long === '--color';
  const parsed =
    option.negated && long === '--no-color'
      ? 'auto'
      : option.negated
        ? true
        : decodeDefault(option.defaultValue);
  return {
    flags: option.flags,
    long,
    short: option.short,
    attributeName: option.attributeName,
    valueShape: option.valueShape,
    knownValues: isTool
      ? KNOWN_TOOLS
      : isScope
        ? KNOWN_SCOPES
        : isColor
          ? KNOWN_COLORS
          : option.choices,
    allowedValues: isTool
      ? KNOWN_TOOLS
      : isScope
        ? (ALLOWED_SCOPES[path] ?? KNOWN_SCOPES)
        : option.choices,
    parserValues: option.choices,
    repeatable: option.repeatable,
    negated: option.negated,
    flagDefault: option.negated ? false : parsed,
    parsedDefault: parsed,
  };
};

const optionRows = currentState.filter(
  (row): row is (typeof currentState)[number] & { option: StateOption } =>
    row.key.startsWith('option:') && 'option' in row && row.option !== undefined,
);

export const optionsForPath = (path: string): readonly CommandOptionSpec[] => {
  const prefix = `option:${path}:`;
  const options = optionRows
    .filter((row) => row.key.startsWith(prefix))
    .map((row) => optionFromState(path, row.option));

  return options.sort((left, right) => left.flags.localeCompare(right.flags));
};
