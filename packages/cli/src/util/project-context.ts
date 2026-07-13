import {
  type GitReadPorts,
  type ProjectContext,
  type ResolvedRuntimeConfiguration,
  type Result,
  type SkillSmithError,
  resolveProjectContext,
} from '@skillsmith/core';
import type { Command } from 'commander';

interface GlobalProjectOptions {
  readonly cd?: string;
  readonly config?: string;
}

/** Resolve the invocation's immutable project context from Commander global options. */
export const resolveCommandProjectContext = (
  command: Command,
  ports: GitReadPorts,
  configuration: ResolvedRuntimeConfiguration,
  invocationCwd: string,
): Promise<Result<ProjectContext, SkillSmithError>> => {
  const options = command.optsWithGlobals() as GlobalProjectOptions;
  const explicitConfigPath = options.config ?? configuration.explicitConfigPath;
  return resolveProjectContext(ports, {
    invocationCwd,
    ...(options.cd !== undefined ? { cd: options.cd } : {}),
    ...(explicitConfigPath !== undefined ? { explicitConfigPath } : {}),
  });
};
