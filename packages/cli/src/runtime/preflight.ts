import type { Command } from 'commander';
import { cliErrorFormatFromArgv, failCliError } from '../output/error-boundary.ts';
import { CURRENT_COMMAND_SPECS, validateOptionInvocation } from '../spec/index.ts';
import type { ColorFlag } from '../util/color.ts';
import { applyRuntimeColorMode } from './environment.ts';

const commandPath = (command: Command): string => {
  const names: string[] = [];
  for (let current: Command | null = command; current !== null; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(' ');
};

const commandArguments = (command: Command, rawArgs: readonly string[]): readonly string[] => {
  const segments = commandPath(command).split(' ').slice(1);
  if (segments.length === 0) return rawArgs;
  const optionShapes = new Map<string, 'boolean' | 'required' | 'optional'>();
  for (const spec of CURRENT_COMMAND_SPECS) {
    for (const option of spec.options) {
      for (const spelling of option.flags.match(/--[\w-]+|-[A-Za-z]/g) ?? []) {
        optionShapes.set(spelling, option.valueShape);
      }
    }
  }
  let segmentIndex = 0;
  for (let index = 0; index < rawArgs.length; index++) {
    const token = rawArgs[index];
    if (token === undefined) continue;
    const spelling = token.startsWith('--') ? token.split('=', 1)[0] : token;
    const shape = spelling === undefined ? undefined : optionShapes.get(spelling);
    if (shape !== undefined) {
      if (shape !== 'boolean' && !token.includes('=')) index++;
      continue;
    }
    const expectedPath = `skillsmith ${segments.slice(0, segmentIndex + 1).join(' ')}`;
    const aliases = CURRENT_COMMAND_SPECS.find((spec) => spec.path === expectedPath)?.aliases ?? [];
    if (token !== segments[segmentIndex] && !aliases.includes(token)) continue;
    segmentIndex++;
    if (segmentIndex === segments.length) return rawArgs.slice(index + 1);
  }
  return rawArgs;
};

export const installRuntimePreflight = (program: Command): void => {
  program.hook('preAction', (thisCommand, actionCommand) => {
    const rawArgs = (program as Command & { rawArgs?: string[] }).rawArgs ?? [];
    const invocation = rawArgs.slice(2);
    const format = cliErrorFormatFromArgv(invocation);
    const rootRelation = validateOptionInvocation('skillsmith', invocation);
    if (!rootRelation.ok) return failCliError(rootRelation.error, format, { exitCode: 2 });

    const path = commandPath(actionCommand);
    const relation = validateOptionInvocation(path, commandArguments(actionCommand, invocation));
    if (!relation.ok) return failCliError(relation.error, format, { exitCode: 2 });

    const opts = thisCommand.optsWithGlobals() as { color?: string | false };
    const raw = opts.color === false ? 'never' : (opts.color ?? 'auto');
    const flag: ColorFlag = raw === 'always' || raw === 'never' || raw === 'auto' ? raw : 'auto';
    applyRuntimeColorMode(flag);
  });
};
