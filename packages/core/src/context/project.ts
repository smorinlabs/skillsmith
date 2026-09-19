import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type SkillSmithError, errorMessage, genericError } from '../errors.ts';
import type { GitReadPorts } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { ProjectContext, ResolveProjectContextOptions } from './types.ts';

const PROJECT_CONFIG_NAME = 'skillsmith.toml';

const nearestConfig = async (
  env: GitReadPorts,
  start: string,
  boundary?: string,
): Promise<string | null> => {
  let directory = start;
  while (true) {
    const candidate = join(directory, PROJECT_CONFIG_NAME);
    if (await env.fileExists(candidate)) return candidate;
    if (boundary !== undefined && directory === boundary) return null;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
};

const canonicalDirectory = async (
  env: GitReadPorts,
  path: string,
): Promise<Result<string, SkillSmithError>> => {
  try {
    const canonical = await env.realpath(path);
    if ((await env.pathKind(canonical)) !== 'dir') {
      return err(genericError(`effective cwd is not a directory: ${path}`));
    }
    return ok(canonical);
  } catch (cause) {
    return err(
      genericError(`cannot resolve effective cwd '${path}': ${errorMessage(cause)}`, cause),
    );
  }
};

const resolveGitRoot = async (env: GitReadPorts, effectiveCwd: string): Promise<string | null> => {
  const reportedRoot = await env.git.findRepositoryRoot({ cwd: effectiveCwd });
  if (reportedRoot === null) return null;
  try {
    return await env.realpath(reportedRoot);
  } catch {
    return null;
  }
};

export const resolveProjectContext = async (
  env: GitReadPorts,
  options: ResolveProjectContextOptions,
): Promise<Result<ProjectContext, SkillSmithError>> => {
  const invocationCwd = resolve(options.invocationCwd);
  const requestedCwd = options.cd
    ? isAbsolute(options.cd)
      ? resolve(options.cd)
      : resolve(invocationCwd, options.cd)
    : invocationCwd;
  const canonicalCwd = await canonicalDirectory(env, requestedCwd);
  if (!canonicalCwd.ok) return canonicalCwd;

  const gitRoot = await resolveGitRoot(env, requestedCwd);
  const projectKind = gitRoot === null ? ('non-git' as const) : ('git' as const);
  const discoveredConfigPath = await nearestConfig(env, canonicalCwd.value, gitRoot ?? undefined);
  const projectRoot = gitRoot ?? (discoveredConfigPath ? dirname(discoveredConfigPath) : null);
  const explicitConfigPath = options.explicitConfigPath
    ? resolve(requestedCwd, options.explicitConfigPath)
    : null;

  return ok(
    Object.freeze({
      invocationCwd,
      effectiveCwd: requestedCwd,
      projectRoot,
      projectIdentity: projectRoot,
      projectKind,
      discoveredConfigPath,
      explicitConfigPath,
    }),
  );
};
