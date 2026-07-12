import {
  type ProjectContext,
  type Result,
  type ScanEnv,
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
  env: ScanEnv,
): Promise<Result<ProjectContext, SkillSmithError>> => {
  const options = command.optsWithGlobals() as GlobalProjectOptions;
  return resolveProjectContext(env, {
    invocationCwd: process.cwd(),
    ...(options.cd !== undefined ? { cd: options.cd } : {}),
    ...(options.config !== undefined ? { explicitConfigPath: options.config } : {}),
  });
};
