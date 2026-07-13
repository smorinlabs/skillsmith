import type { Command } from 'commander';
import { failCliError } from '../output/error-boundary.ts';
import { validateOptionInvocation } from '../spec/index.ts';
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
  const path = commandPath(command).split(' ').slice(1);
  let offset = 0;
  for (const segment of path) {
    const index = rawArgs.indexOf(segment, offset);
    if (index < 0) return rawArgs;
    offset = index + 1;
  }
  return rawArgs.slice(offset);
};

export const installRuntimePreflight = (program: Command): void => {
  program.hook('preAction', (thisCommand, actionCommand) => {
    const rawArgs = (program as Command & { rawArgs?: string[] }).rawArgs ?? [];
    const invocation = rawArgs.slice(2);
    const format = invocation.includes('--json') ? 'json' : 'human';
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
