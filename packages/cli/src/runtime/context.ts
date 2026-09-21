import {
  type CurrentApplicationContext,
  type InteractionPort,
  type ObservationBundle,
  type SearchApplicationContext,
  type SearchInteractionPort,
  type SearchProvider,
  createSkillsShProvider,
  defaultArtifactCoordinatorPorts,
  defaultRuntimePorts,
  defaultSearchPorts,
  defaultTimerPort,
  resolveRuntimeConfiguration,
} from '@skillsmith/core';
import type { Command } from 'commander';
import {
  createPolicyInteraction,
  promptInteraction,
  resolveInteractionPolicy,
} from './interaction.ts';
import { createSearchInteraction } from './search-interaction.ts';

export interface SearchContextOptions {
  readonly observation: ObservationBundle;
  readonly signal?: AbortSignal;
  readonly provider?: SearchProvider;
  readonly interaction?: SearchInteractionPort;
  readonly stdoutIsTTY?: boolean;
}

export const createSearchApplicationContext = (
  options: SearchContextOptions,
): SearchApplicationContext => ({
  observation: options.observation,
  provider: options.provider ?? createSkillsShProvider(defaultSearchPorts()),
  interaction:
    options.interaction ??
    createSearchInteraction(
      process.stdin,
      process.stderr,
      options.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
      defaultTimerPort,
    ),
  ...(options.signal ? { signal: options.signal } : {}),
});

export interface RuntimeContextOptions {
  readonly signal?: AbortSignal;
  readonly interaction?: InteractionPort;
  readonly observation: ObservationBundle;
}

/** Compose the read-only ambient capabilities used by the hidden completion transport. */
export const createCompletionRuntimeContext = async () => {
  const ports = await defaultRuntimePorts();
  return Object.freeze({
    cwd: process.cwd(),
    monotonicMilliseconds: () => ports.monotonicMilliseconds(),
    ports: Object.freeze({
      listDirBounded: ports.listDirBounded,
      pathKind: ports.pathKind,
      readFileMetadata: ports.readFileMetadata,
      readFileSnapshotNoFollow: ports.readFileSnapshotNoFollow,
    }),
  });
};

/** Construct one capability-scoped application context per invocation. */
export const createCurrentApplicationContext = async (
  command: Command,
  options: RuntimeContextOptions,
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
  const [ports, artifactCoordinator] = await Promise.all([
    defaultRuntimePorts(),
    defaultArtifactCoordinatorPorts(),
  ]);
  return {
    observation: options.observation,
    ports,
    artifactCoordinator,
    configuration: resolveRuntimeConfiguration(process.env),
    interaction: createPolicyInteraction(policy, options.interaction ?? promptInteraction()),
    invocationCwd: process.cwd(),
    globalOptions: {
      ...(globals.cd === undefined ? {} : { cd: globals.cd }),
      ...(globals.config === undefined ? {} : { config: globals.config }),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
};
