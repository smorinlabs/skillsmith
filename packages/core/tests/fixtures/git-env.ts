import { GIT_REPO_LOCAL_ENV_VARS } from '../../src/env/git.ts';

// Hermetic env for spawning git (or the CLI) from tests. Git hooks — e.g. the
// lefthook pre-push that runs `bun test` — export repo-location variables such
// as GIT_DIR; a child git inheriting them writes to the REAL repo instead of
// the fixture temp dir (issue #17).
//
export const GIT_REPO_SCRUB_VARS = GIT_REPO_LOCAL_ENV_VARS;

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
