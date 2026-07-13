export { GIT_REPOSITORY_ENVIRONMENT as GIT_REPO_LOCAL_ENV_VARS } from '../ports/git.ts';
import { GIT_REPOSITORY_ENVIRONMENT } from '../ports/git.ts';
import type { ProcessPort } from '../ports/types.ts';
import type { ExecOptions, ExecResult } from './types.ts';

// `git rev-parse --local-env-vars` (git 2.50), plus defensive variables that
// also redirect repository discovery or writes. A Git command launched from a
// hook must never inherit the hook's repository context: `-C <dir>` does not
// override variables such as GIT_DIR or GIT_INDEX_FILE.
type GitExecOptions = Omit<ExecOptions, 'env' | 'unsetEnv'>;

/** Run production Git without inherited repository-local state.
 *
 * Normal user credentials and global/system configuration remain available;
 * only variables capable of redirecting the repository context are removed.
 */
export const execGit = (
  env: Pick<ProcessPort, 'exec'>,
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<ExecResult> =>
  env.exec('git', args, {
    ...opts,
    env: { GIT_TERMINAL_PROMPT: '0' },
    unsetEnv: GIT_REPOSITORY_ENVIRONMENT,
  });
