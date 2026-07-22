import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../../packages/cli/tests/fixtures/cli.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
} from '../../../../packages/core/src/artifacts/ledger-types.ts';
import { deriveLedgerProjectRegistrations } from '../../../../packages/core/src/artifacts/registry.ts';
import { emptyLedgerModel, writeLedger } from '../../../../packages/core/src/place/ledger.ts';
import { defaultRuntimePorts } from '../../../../packages/core/src/ports/default.ts';
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
  readonly git: {
    readonly publicRemote: 'https://fixture.invalid/acme/project-a.git';
    readonly portableRemote: string;
    readonly transportConfig: string;
  };
  readonly projects: {
    readonly current: string;
    readonly a: string;
    readonly b: string;
    readonly bAlias: string;
    readonly c: string;
  };
  readonly skills: {
    readonly userLint: string;
    readonly userReview: string;
    readonly userClaudeReview: string;
    readonly projectALint: string;
    readonly projectAReview: string;
    readonly projectAClaudeReview: string;
    readonly projectBReview: string;
    readonly projectBExtra: string;
    readonly projectBClaudeReview: string;
    readonly managedClaudePolicy: string;
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
  const portableRemote = join(root, 'project-a.git');
  const gitConfig = join(root, 'gitconfig');
  const projects = Object.freeze({
    current: join(root, 'current'),
    a: join(root, 'project-a'),
    b: join(root, 'project-b'),
    bAlias: join(root, 'project-b-alias'),
    c: join(root, 'project-c'),
  });
  await Promise.all([home, config, data, cache].map((path) => mkdir(path, { recursive: true })));
  await Promise.all([projects.current, projects.a, projects.b, projects.c].map(createProject));

  const userRoot = join(home, '.agents', 'skills');
  const userClaudeRoot = join(home, '.claude', 'skills');
  const projectARoot = join(projects.a, '.agents', 'skills');
  const projectAClaudeRoot = join(projects.a, '.claude', 'skills');
  const projectACodexSources = join(projects.a, 'skill-sources', 'codex');
  const projectAClaudeSources = join(projects.a, 'skill-sources', 'claude-code');
  const projectBRoot = join(projects.b, '.agents', 'skills');
  const projectBClaudeRoot = join(projects.b, '.claude', 'skills');
  const managedClaudeBase = join(root, 'claude-managed');
  const managedClaudeRoot = join(managedClaudeBase, '.claude', 'skills');
  const [
    userLint,
    userReview,
    userClaudeReview,
    projectALintSource,
    projectAReviewSource,
    projectAClaudeReviewSource,
    projectBReview,
    projectBExtra,
    projectBClaudeReview,
    managedClaudePolicy,
  ] = await Promise.all([
    writeSkill(userRoot, 'lint', 'portable lint source'),
    writeSkill(userRoot, 'review', 'portable review source'),
    writeSkill(userClaudeRoot, 'review', 'Claude user review source'),
    // The workflow intentionally converges this same logical lint skill through user and
    // project-A endpoints so its final rerun proves endpoint spelling does not create drift.
    writeSkill(projectACodexSources, 'lint', 'portable lint source'),
    writeSkill(projectACodexSources, 'review', 'project A review source'),
    writeSkill(projectAClaudeSources, 'review', 'Claude project A review source'),
    writeSkill(projectBRoot, 'review', 'conflicting project B review destination'),
    writeSkill(projectBRoot, 'extra', 'destination-only project B skill'),
    writeSkill(projectBClaudeRoot, 'review', 'conflicting Claude project B review destination'),
    writeSkill(managedClaudeRoot, 'policy', 'managed Claude policy source'),
  ]);
  const projectALint = join(projectARoot, 'lint');
  const projectAReview = join(projectARoot, 'review');
  const projectAClaudeReview = join(projectAClaudeRoot, 'review');
  await Promise.all([
    mkdir(projectARoot, { recursive: true }),
    mkdir(projectAClaudeRoot, { recursive: true }),
  ]);
  await Promise.all([
    symlink('../../skill-sources/codex/lint', projectALint),
    symlink('../../skill-sources/codex/review', projectAReview),
    symlink('../../skill-sources/claude-code/review', projectAClaudeReview),
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
    symlink(projects.b, projects.bAlias),
  ]);
  runGit(projects.a, ['config', 'user.name', 'P17 Sync Fixture']);
  runGit(projects.a, ['config', 'user.email', 'sync@fixture.invalid']);
  runGit(projects.a, ['add', '.']);
  runGit(projects.a, ['commit', '--quiet', '-m', 'fixture: seed portable sources']);
  runGit(root, ['clone', '--quiet', '--bare', projects.a, portableRemote]);
  runGit(portableRemote, ['config', 'uploadpack.allowFilter', 'true']);
  runGit(portableRemote, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  runGit(projects.a, ['remote', 'add', 'origin', 'https://fixture.invalid/acme/project-a.git']);
  await writeFile(
    gitConfig,
    [
      `[url "file://${portableRemote}"]`,
      '\tinsteadOf = https://fixture.invalid/acme/project-a.git',
      '[protocol "file"]',
      '\tallow = always',
      '',
    ].join('\n'),
  );

  const skillsmithHome = join(data, 'skillsmith');
  await mkdir(skillsmithHome, { recursive: true });
  const recordedAt = '2026-07-21T00:00:00.000Z';
  const devPair = (
    placementPath: string,
    sourcePath: string,
    sourceRelPath: string,
  ): LedgerPairV1Dto =>
    Object.freeze({
      placementPath,
      mode: 'dev',
      dev: Object.freeze({
        sourcePath,
        resolvedPath: sourcePath,
        repoRoot: projects.a,
        sourceRelPath,
        remote: 'https://fixture.invalid/acme/project-a.git',
        recordedAt,
      }),
      pinned: null,
      journal: null,
    });
  const codexLintPair = devPair(projectALint, projectALintSource, 'skill-sources/codex/lint');
  const codexReviewPair = devPair(
    projectAReview,
    projectAReviewSource,
    'skill-sources/codex/review',
  );
  const claudeReviewPair = devPair(
    projectAClaudeReview,
    projectAClaudeReviewSource,
    'skill-sources/claude-code/review',
  );
  const emptyLedger = emptyLedgerModel(recordedAt);
  const ledgerProjects: LedgerModel['projects'] = Object.freeze({
    [projects.a]: Object.freeze({
      skills: Object.freeze({
        lint: Object.freeze({ tools: Object.freeze({ codex: codexLintPair }) }),
        review: Object.freeze({
          tools: Object.freeze({
            codex: codexReviewPair,
            'claude-code': claudeReviewPair,
          }),
        }),
      }),
    }),
  });
  const ledgerModel: LedgerModel = Object.freeze({
    ...emptyLedger,
    projects: ledgerProjects,
    projectRegistrations: deriveLedgerProjectRegistrations(ledgerProjects),
  });
  const basePorts = await defaultRuntimePorts();
  const ledgerWrite = await writeLedger(
    basePorts,
    join(skillsmithHome, 'placements.json'),
    ledgerModel,
  );
  if (!ledgerWrite.ok) {
    throw new Error(`sync fixture ledger failed: ${ledgerWrite.error.code}`);
  }
  return Object.freeze({
    root,
    cwd: projects.current,
    home,
    config,
    data,
    cache,
    ledger: join(skillsmithHome, 'placements.json'),
    store: join(skillsmithHome, 'store'),
    git: Object.freeze({
      publicRemote: 'https://fixture.invalid/acme/project-a.git',
      portableRemote,
      transportConfig: gitConfig,
    }),
    projects,
    skills: Object.freeze({
      userLint,
      userReview,
      userClaudeReview,
      projectALint,
      projectAReview,
      projectAClaudeReview,
      projectBReview,
      projectBExtra,
      projectBClaudeReview,
      managedClaudePolicy,
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
        CLAUDE_CODE_MANAGED_SETTINGS_PATH: managedClaudeBase,
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
