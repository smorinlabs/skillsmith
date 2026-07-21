import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../../packages/cli/tests/fixtures/cli.ts';
import { hermeticGitEnv, runGit } from '../../../../packages/core/tests/fixtures/git-env.ts';

export const SYNC_SECRET_CANARIES = Object.freeze([
  'P17_SECRET_CANARY_SYNC_ENV',
  'P17_SECRET_CANARY_SYNC_FILE',
] as const);

export interface SyncCliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SyncFleet {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly cache: string;
  readonly ledger: string;
  readonly store: string;
  readonly projects: {
    readonly current: string;
    readonly a: string;
    readonly b: string;
    readonly c: string;
  };
  readonly skills: {
    readonly userLint: string;
    readonly userReview: string;
    readonly projectALint: string;
    readonly projectAReview: string;
    readonly projectBReview: string;
    readonly projectBExtra: string;
  };
  readonly artifacts: {
    readonly legacyManifest: string;
    readonly explicitManifest: string;
    readonly explicitLock: string;
  };
  readonly env: Readonly<Record<string, string | undefined>>;
}

const skillSource = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const writeSkill = async (root: string, name: string, description: string): Promise<string> => {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), skillSource(name, description));
  return path;
};

const createProject = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
  runGit(path, ['init', '--quiet']);
};

export const createSyncFleet = async (): Promise<SyncFleet> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-p5-sync-'));
  const home = join(root, 'home');
  const config = join(root, 'xdg', 'config');
  const data = join(root, 'xdg', 'data');
  const cache = join(root, 'xdg', 'cache');
  const projects = Object.freeze({
    current: join(root, 'current'),
    a: join(root, 'project-a'),
    b: join(root, 'project-b'),
    c: join(root, 'project-c'),
  });
  await Promise.all([home, config, data, cache].map((path) => mkdir(path, { recursive: true })));
  await Promise.all(Object.values(projects).map(createProject));

  const userRoot = join(home, '.agents', 'skills');
  const projectARoot = join(projects.a, '.agents', 'skills');
  const projectBRoot = join(projects.b, '.agents', 'skills');
  const [userLint, userReview, projectALint, projectAReview, projectBReview, projectBExtra] =
    await Promise.all([
      writeSkill(userRoot, 'lint', 'portable lint source'),
      writeSkill(userRoot, 'review', 'portable review source'),
      writeSkill(projectARoot, 'lint', 'project A lint source'),
      writeSkill(projectARoot, 'review', 'project A review source'),
      writeSkill(projectBRoot, 'review', 'conflicting project B review destination'),
      writeSkill(projectBRoot, 'extra', 'destination-only project B skill'),
    ]);

  const artifacts = Object.freeze({
    legacyManifest: join(projects.b, 'legacy.toml'),
    explicitManifest: join(projects.b, 'portable', 'team.toml'),
    explicitLock: join(projects.b, 'portable', 'team.lock'),
  });
  await Promise.all([
    mkdir(join(projects.b, 'portable'), { recursive: true }),
    writeFile(artifacts.legacyManifest, 'tool = "codex"\nscope = "project"\n'),
    writeFile(join(root, 'canary.txt'), `${SYNC_SECRET_CANARIES[1]}\n`),
  ]);

  const skillsmithHome = join(data, 'skillsmith');
  return Object.freeze({
    root,
    cwd: projects.current,
    home,
    config,
    data,
    cache,
    ledger: join(skillsmithHome, 'placements.json'),
    store: join(skillsmithHome, 'store'),
    projects,
    skills: Object.freeze({
      userLint,
      userReview,
      projectALint,
      projectAReview,
      projectBReview,
      projectBExtra,
    }),
    artifacts,
    env: Object.freeze(
      hermeticGitEnv({
        HOME: home,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: cache,
        SKILLSMITH_HOME: skillsmithHome,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CODEX_HOME: join(home, '.codex'),
        SKILLSMITH_CONFIG: undefined,
        SKILLSMITH_TOOL: undefined,
        SKILLSMITH_SCOPE: undefined,
        SKILLSMITH_PATH: undefined,
        P17_SYNC_TEST_CANARY: SYNC_SECRET_CANARIES[0],
        CI: '1',
        NO_COLOR: '1',
      }),
    ),
  });
};

export const destroySyncFleet = async (fleet: SyncFleet): Promise<void> => {
  await rm(fleet.root, { recursive: true, force: true });
};

export const runSyncCli = async (
  fleet: SyncFleet,
  args: readonly string[],
): Promise<SyncCliProduct> => {
  const child = Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args], {
    cwd: fleet.cwd,
    env: fleet.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return Object.freeze({ exitCode, stdout, stderr });
};

export const readSkillBytes = (path: string): Promise<Uint8Array> =>
  readFile(join(path, 'SKILL.md'));
