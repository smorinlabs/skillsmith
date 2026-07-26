import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../../packages/cli/tests/fixtures/cli.ts';
import { hermeticGitEnv } from '../../../../packages/core/tests/fixtures/git-env.ts';

export interface HelpFixture {
  readonly root: string;
  readonly home: string;
  readonly project: string;
}

export const createHelpFixture = async (): Promise<HelpFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-p6-help-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(project, { recursive: true })]);
  return { root, home, project };
};

export const destroyHelpFixture = async (fixture: HelpFixture): Promise<void> => {
  await rm(fixture.root, { recursive: true, force: true });
};

export const runHelpFixtureCli = async (fixture: HelpFixture, args: readonly string[]) => {
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd: fixture.project,
    env: hermeticGitEnv({
      CI: '1',
      HOME: fixture.home,
      NO_COLOR: '1',
      SKILLSMITH_HOME: join(fixture.home, '.skillsmith'),
      XDG_CONFIG_HOME: join(fixture.home, '.config'),
      XDG_DATA_HOME: join(fixture.home, '.local', 'share'),
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};
