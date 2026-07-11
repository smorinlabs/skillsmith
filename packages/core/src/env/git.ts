import type { ExecOptions, ExecResult, ScanEnv } from './types.ts';

// `git rev-parse --local-env-vars` (git 2.50), plus defensive variables that
// also redirect repository discovery or writes. A Git command launched from a
// hook must never inherit the hook's repository context: `-C <dir>` does not
// override variables such as GIT_DIR or GIT_INDEX_FILE.
export const GIT_REPO_LOCAL_ENV_VARS = [
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

type GitExecOptions = Omit<ExecOptions, 'env' | 'unsetEnv'>;

/** Run production Git without inherited repository-local state.
 *
 * Normal user credentials and global/system configuration remain available;
 * only variables capable of redirecting the repository context are removed.
 */
export const execGit = (
  env: ScanEnv,
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<ExecResult> =>
  env.exec('git', args, {
    ...opts,
    env: { GIT_TERMINAL_PROMPT: '0' },
    unsetEnv: GIT_REPO_LOCAL_ENV_VARS,
  });
