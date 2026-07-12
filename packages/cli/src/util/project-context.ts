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
  const explicitConfigPath = options.config ?? process.env.SKILLSMITH_CONFIG;
  return resolveProjectContext(env, {
    invocationCwd: process.cwd(),
    ...(options.cd !== undefined ? { cd: options.cd } : {}),
    ...(explicitConfigPath !== undefined ? { explicitConfigPath } : {}),
  });
};
