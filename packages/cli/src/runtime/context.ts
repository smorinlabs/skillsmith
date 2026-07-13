import {
  type CurrentApplicationContext,
  type InteractionPort,
  defaultScanEnv,
} from '@skillsmith/core';
import type { Command } from 'commander';
import {
  createPolicyInteraction,
  promptInteraction,
  resolveInteractionPolicy,
} from './interaction.ts';

export interface RuntimeContextOptions {
  readonly signal?: AbortSignal;
  readonly interaction?: InteractionPort;
}

/** Construct the transitional context once per invocation; G1-04 replaces ScanEnv with ports. */
export const createCurrentApplicationContext = async (
  command: Command,
  options: RuntimeContextOptions = {},
): Promise<CurrentApplicationContext> => {
  const globals = command.optsWithGlobals() as {
    cd?: string;
    config?: string;
    json?: boolean;
    prompt?: boolean;
    yes?: boolean;
  };
  const policy = resolveInteractionPolicy({
    json: globals.json === true,
    noPrompt: globals.prompt === false,
    yes: globals.yes === true,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    env: await defaultScanEnv(),
    interaction: createPolicyInteraction(policy, options.interaction ?? promptInteraction()),
    invocationCwd: process.cwd(),
    envVars: process.env,
    globalOptions: {
      ...(globals.cd === undefined ? {} : { cd: globals.cd }),
      ...(globals.config === undefined ? {} : { config: globals.config }),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
};
