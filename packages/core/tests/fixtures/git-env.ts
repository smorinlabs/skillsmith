// Hermetic env for spawning git (or the CLI) from tests. Git hooks — e.g. the
// lefthook pre-push that runs `bun test` — export repo-location variables such
// as GIT_DIR; a child git inheriting them writes to the REAL repo instead of
// the fixture temp dir (issue #17).
//
// The first 15 names are `git rev-parse --local-env-vars` (git 2.50); the last
// 4 are defensive extras that also affect repo discovery/writes. Revisit on
// major git upgrades.
export const GIT_REPO_SCRUB_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_QUARANTINE_PATH',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;

// Scrub and config-pinning win over overrides: no test may reintroduce a
// repo-location var, so a poisoned caller can never opt back into the bug.
export const hermeticGitEnv = (
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  for (const name of GIT_REPO_SCRUB_VARS) delete env[name];
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  return env;
};

export const scrubGitRepoEnv = (): void => {
  for (const name of GIT_REPO_SCRUB_VARS) delete process.env[name];
};

export const runGit = (cwd: string, args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: hermeticGitEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }

  return new TextDecoder().decode(result.stdout);
};
