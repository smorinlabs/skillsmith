import { CURRENT_COMMAND_SPECS, CURRENT_OPTION_RELATIONS } from './registry.ts';
import type { CommandOptionSpec, OptionInvocationResult, OptionRelationSpec } from './types.ts';

const failure = (message: string): OptionInvocationResult => ({
  ok: false,
  error: { code: 'usage', exitCode: 2, message },
});

interface ParsedInvocation {
  readonly occurrences: ReadonlyMap<string, number>;
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}

const optionSpellings = (option: CommandOptionSpec): readonly string[] =>
  option.flags.match(/--[\w-]+|-[A-Za-z]/g) ?? [];

const invocationOptions = (command: string): readonly CommandOptionSpec[] => {
  const root = CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith')?.options ?? [];
  const local = CURRENT_COMMAND_SPECS.find((spec) => spec.path === command)?.options ?? [];
  return command === 'skillsmith' ? root : [...root, ...local];
};

const recordOccurrence = (
  occurrences: Map<string, number>,
  values: Map<string, string[]>,
  option: CommandOptionSpec,
  value?: string,
): void => {
  occurrences.set(option.long, (occurrences.get(option.long) ?? 0) + 1);
  if (value !== undefined) values.set(option.long, [...(values.get(option.long) ?? []), value]);
};

const consumesFollowingValue = (option: CommandOptionSpec, next: string | undefined): boolean =>
  option.valueShape === 'required' ||
  (option.valueShape === 'optional' && next !== undefined && !next.startsWith('-'));

const parseInvocation = (command: string, args: readonly string[]): ParsedInvocation => {
  const options = invocationOptions(command);
  const bySpelling = new Map<string, CommandOptionSpec>();
  for (const option of options) {
    for (const spelling of optionSpellings(option)) bySpelling.set(spelling, option);
  }

  const occurrences = new Map<string, number>();
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined) continue;
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    if (token.startsWith('--')) {
      const spelling = token.split('=', 1)[0];
      const option = spelling === undefined ? undefined : bySpelling.get(spelling);
      if (option === undefined) {
        if (spelling !== undefined) occurrences.set(spelling, (occurrences.get(spelling) ?? 0) + 1);
        continue;
      }
      const equals = token.indexOf('=');
      const following = equals < 0 && consumesFollowingValue(option, args[index + 1]);
      recordOccurrence(
        occurrences,
        values,
        option,
        equals >= 0 ? token.slice(equals + 1) : following ? args[index + 1] : undefined,
      );
      if (following) index++;
      continue;
    }

    // Commander accepts boolean short-option clusters (`-qv`) and treats the
    // remainder after a value-taking short option as its attached value (`-tcodex`).
    for (let offset = 1; offset < token.length; offset++) {
      const option = bySpelling.get(`-${token[offset]}`);
      if (option === undefined) break;
      if (option.valueShape === 'boolean') {
        recordOccurrence(occurrences, values, option);
        continue;
      }
      const attached = token.slice(offset + 1);
      const following = attached.length === 0 && consumesFollowingValue(option, args[index + 1]);
      recordOccurrence(
        occurrences,
        values,
        option,
        attached.length > 0 ? attached : following ? args[index + 1] : undefined,
      );
      if (following) index++;
      break;
    }
  }
  return { occurrences, values, positionals };
};

const selected = (parsed: ParsedInvocation, option: string): boolean =>
  (parsed.occurrences.get(option) ?? 0) > 0;

const validateRelation = (
  relation: OptionRelationSpec,
  parsed: ParsedInvocation,
): OptionInvocationResult | null => {
  if (relation.kind === 'conflicts') {
    return relation.options.every((option) => selected(parsed, option))
      ? failure(relation.description)
      : null;
  }
  if (relation.kind === 'requires') {
    return selected(parsed, relation.option) && !selected(parsed, relation.requiredOption)
      ? failure(relation.description)
      : null;
  }
  if (relation.kind === 'distinct-values') {
    const values = parsed.values.get(relation.option) ?? [];
    return new Set(values).size !== values.length ? failure(relation.description) : null;
  }
  if (relation.kind === 'exclusive-group') {
    const active = relation.options.filter((option) => selected(parsed, option));
    return active.length > 1
      ? failure(`options are mutually exclusive: ${active.join(', ')}`)
      : null;
  }
  if (relation.kind === 'scope-consistency') {
    const activeSugars = relation.sugars.filter(({ option }) => selected(parsed, option));
    if (activeSugars.length > 1)
      return failure(
        `scope shorthands cannot be combined: ${activeSugars.map(({ option }) => option).join(', ')}`,
      );
    const explicitValues = parsed.values.get(relation.scopeOption) ?? [];
    const explicit = explicitValues.at(-1);
    const sugar = activeSugars[0];
    return explicit !== undefined && sugar !== undefined && explicit !== sugar.value
      ? failure(`${relation.scopeOption} ${explicit} cannot be combined with ${sugar.option}`)
      : null;
  }
  if (!selected(parsed, relation.whenOption)) return null;
  const count =
    relation.subject === 'positionals'
      ? parsed.positionals.length
      : (parsed.occurrences.get(relation.option ?? '') ?? 0);
  if (relation.exact !== undefined && count !== relation.exact) return failure(relation.label);
  if (relation.maximum !== undefined && count > relation.maximum) return failure(relation.label);
  return null;
};

/** Generic interpreter: all current behavior comes from CURRENT_OPTION_RELATIONS records. */
export const validateOptionInvocation = (
  command: string,
  args: readonly string[],
): OptionInvocationResult => {
  const parsed = parseInvocation(command, args);
  for (const relation of CURRENT_OPTION_RELATIONS) {
    if (relation.command !== command) continue;
    const result = validateRelation(relation, parsed);
    if (result !== null) return result;
  }
  return { ok: true };
};
