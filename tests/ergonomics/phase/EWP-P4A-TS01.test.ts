import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../packages/core/tests/fixtures/acquire/remote.ts';
import { hermeticGitEnv, runGit } from '../../../packages/core/tests/fixtures/git-env.ts';

type UnknownRecord = Record<string, unknown>;

interface CliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Workspace {
  readonly root: string;
  readonly repository: string;
  readonly cwd: string;
  readonly projectManifest: string;
  readonly projectLock: string;
  readonly userManifest: string;
  readonly userLock: string;
  readonly env: Record<string, string | undefined>;
}

let remote: RemoteFixture;

beforeAll(async () => {
  remote = await buildRemoteFixture();
});

afterAll(async () => {
  if (remote !== undefined) await destroyRemoteFixture(remote);
});

setDefaultTimeout(30_000);

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const runCli = async (workspace: Workspace, args: readonly string[]): Promise<CliProduct> => {
  const env = hermeticGitEnv({ ...workspace.env, CI: '1', NO_COLOR: '1' });
  env.GIT_CONFIG_GLOBAL = workspace.env.GIT_CONFIG_GLOBAL;
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd: workspace.cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

const requireJson = (product: CliProduct, label: string): UnknownRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(product.stdout);
  } catch {
    throw new Error(
      `${label}: stdout was not JSON (exit ${product.exitCode})\nstdout:\n${product.stdout}\nstderr:\n${product.stderr}`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${label}: JSON report was not an object`);
  return parsed;
};

const requireExit = (product: CliProduct, expected: number, label: string): void => {
  if (product.exitCode !== expected) {
    throw new Error(
      `${label}: expected exit ${expected}, got ${product.exitCode}\nstdout:\n${product.stdout}\nstderr:\n${product.stderr}`,
    );
  }
};

const createWorkspace = async (label: string): Promise<Workspace> => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-p4a-ts01-${label}-`));
  const repository = join(root, 'repository');
  const cwd = join(repository, 'packages', 'app');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const data = join(root, 'data');
  const gitConfig = join(root, 'gitconfig');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(join(config, 'skillsmith'), { recursive: true }),
    mkdir(data, { recursive: true }),
    writeFile(
      gitConfig,
      `[url "${remote.multiUrl}"]\n\tinsteadOf = ${remote.multiSource}\n[protocol "file"]\n\tallow = always\n`,
    ),
  ]);
  runGit(repository, ['init', '--quiet']);
  return {
    root,
    repository,
    cwd,
    projectManifest: join(repository, 'skillsmith.toml'),
    projectLock: join(repository, 'skillsmith.lock'),
    userManifest: join(config, 'skillsmith', 'skillsmith.toml'),
    userLock: join(config, 'skillsmith', 'skillsmith.lock'),
    env: {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      SKILLSMITH_HOME: data,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_ALLOW_PROTOCOL: 'file:https',
    },
  };
};

const source = (): string => `${remote.multiSource}//plugins/fh/skills/factor-scan`;

const declaration = (name: 'factor-scan' | 'review', scope: 'user' | 'project'): string => {
  const sourcePath =
    name === 'factor-scan' ? 'plugins/fh/skills/factor-scan' : 'plugins/web/skills/review';
  return [
    'version = 1',
    '',
    '[[skills]]',
    `name = "${name}"`,
    `source = "fixture.invalid/acme/multi//${sourcePath}"`,
    'tools = ["claude-code"]',
    `scope = "${scope}"`,
    '',
  ].join('\n');
};

const readMaybe = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
};

const snapshot = async (paths: readonly string[]): Promise<ReadonlyMap<string, string | null>> =>
  new Map(await Promise.all(paths.map(async (path) => [path, await readMaybe(path)] as const)));

const expectUnchanged = async (
  before: ReadonlyMap<string, string | null>,
  label: string,
): Promise<void> => {
  for (const [path, bytes] of before) {
    expect(await readMaybe(path), `${label}: ${path}`).toBe(bytes);
  }
};

const expectPathBytes = async (
  expected: readonly (readonly [path: string, bytes: string | null])[],
  label: string,
): Promise<void> => {
  for (const [path, bytes] of expected) {
    expect(await readMaybe(path), `${label}: ${path}`).toBe(bytes);
  }
};

const installArgs = (extra: readonly string[] = []): readonly string[] => [
  'install',
  source(),
  '--tool',
  'claude-code',
  '--no-verify',
  '--json',
  ...extra,
];

const operationProjection = (report: UnknownRecord): unknown => ({
  artifactPair: report.artifactPair,
  artifactSelection: report.artifactSelection,
  artifactEffects: records(report.artifactEffects).map((effect) => ({
    groupId: effect.groupId,
    skill: effect.skill,
    manifestAction: effect.manifestAction,
    lockAction: effect.lockAction,
  })),
  placements: records(report.results).map((result) => ({
    requestIndex: result.requestIndex,
    groupId: result.groupId,
    pairId: result.pairId,
    source: result.source,
    skill: result.skill,
    tool: result.tool,
    scope: result.scope,
    placementPath: result.placementPath,
    action: result.action,
    placement: result.placement,
    force: result.force,
  })),
});

const expectPlanParity = (
  preview: UnknownRecord,
  execution: UnknownRecord,
  label: string,
): void => {
  expect(operationProjection(execution), `${label}: dry-run/execution operation intent`).toEqual(
    operationProjection(preview),
  );
};

const expectSelectedPair = (
  report: UnknownRecord,
  manifestPath: string,
  lockPath: string,
  lockSource: 'sibling' | 'explicit',
  selectedBy: string,
): void => {
  expect(report).toMatchObject({
    schemaVersion: 2,
    kind: 'skillsmith.install',
    saveMode: 'desired-state',
    artifactPair: { manifestPath, lockPath, lockSource },
    artifactSelection: { outcome: 'selected', selectedBy },
  });
};

const previewAndExecute = async (
  workspace: Workspace,
  extra: readonly string[],
  nonselectedBefore: ReadonlyMap<string, string | null>,
  expectedExit = 0,
): Promise<Readonly<{ preview: UnknownRecord; execution: UnknownRecord }>> => {
  const previewProduct = await runCli(workspace, installArgs([...extra, '--dry-run']));
  requireExit(previewProduct, expectedExit, 'install dry-run');
  const preview = requireJson(previewProduct, 'install dry-run');
  await expectUnchanged(nonselectedBefore, 'install dry-run nonselected artifacts');
  const executionProduct = await runCli(workspace, installArgs(extra));
  requireExit(executionProduct, expectedExit, 'install execution');
  const execution = requireJson(executionProduct, 'install execution');
  expectPlanParity(preview, execution, extra.join(' ') || 'default install');
  return { preview, execution };
};

describe('EWP-P4A-TS01', () => {
  test('explicit file selects its sibling lock or one explicit lock without touching automatic candidates', async () => {
    for (const explicitLock of [false, true]) {
      const workspace = await createWorkspace(explicitLock ? 'explicit-lock' : 'sibling-lock');
      const manifestPath = join(workspace.repository, 'state', 'team.toml');
      const siblingLock = join(workspace.repository, 'state', 'team.lock');
      const lockPath = explicitLock
        ? join(workspace.repository, 'portable', 'team.state.lock')
        : siblingLock;
      await Promise.all([
        mkdir(join(workspace.repository, 'state'), { recursive: true }),
        mkdir(join(workspace.repository, 'portable'), { recursive: true }),
        writeFile(workspace.projectManifest, declaration('review', 'project')),
        writeFile(workspace.projectLock, '# project lock sentinel\n'),
        writeFile(workspace.userManifest, declaration('review', 'user')),
        writeFile(workspace.userLock, '# user lock sentinel\n'),
      ]);
      const nonselected = [
        workspace.projectManifest,
        workspace.projectLock,
        workspace.userManifest,
        workspace.userLock,
        ...(explicitLock ? [siblingLock] : []),
      ];
      const before = await snapshot(nonselected);
      const relativeManifest = '../../state/team.toml';
      const extra = explicitLock
        ? ['--file', relativeManifest, '--lockfile', '../../portable/team.state.lock']
        : ['--file', relativeManifest];

      try {
        await expectPathBytes(
          [
            [workspace.projectManifest, declaration('review', 'project')],
            [workspace.projectLock, '# project lock sentinel\n'],
            [workspace.userManifest, declaration('review', 'user')],
            [workspace.userLock, '# user lock sentinel\n'],
            [manifestPath, null],
            [lockPath, null],
          ],
          'explicit-pair fixture characterization',
        );
        const { preview, execution } = await previewAndExecute(workspace, extra, before);
        expectSelectedPair(
          preview,
          manifestPath,
          lockPath,
          explicitLock ? 'explicit' : 'sibling',
          'explicit-file',
        );
        expectSelectedPair(
          execution,
          manifestPath,
          lockPath,
          explicitLock ? 'explicit' : 'sibling',
          'explicit-file',
        );
        await expectUnchanged(before, explicitLock ? 'explicit lock' : 'sibling lock');
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    }
  });

  test('a unique project declaration owner wins independently of effective user scope', async () => {
    const workspace = await createWorkspace('project-owner');
    await Promise.all([
      writeFile(workspace.projectManifest, declaration('factor-scan', 'project')),
      writeFile(workspace.userManifest, declaration('review', 'user')),
      writeFile(workspace.userLock, '# user lock sentinel\n'),
    ]);
    const before = await snapshot([workspace.userManifest, workspace.userLock]);
    try {
      await expectPathBytes(
        [
          [workspace.projectManifest, declaration('factor-scan', 'project')],
          [workspace.projectLock, null],
          [workspace.userManifest, declaration('review', 'user')],
          [workspace.userLock, '# user lock sentinel\n'],
        ],
        'unique-project fixture characterization',
      );
      const { preview, execution } = await previewAndExecute(workspace, ['--user'], before);
      expectSelectedPair(
        preview,
        workspace.projectManifest,
        workspace.projectLock,
        'sibling',
        'selected-project-owner',
      );
      expectSelectedPair(
        execution,
        workspace.projectManifest,
        workspace.projectLock,
        'sibling',
        'selected-project-owner',
      );
      await expectUnchanged(before, 'unique project owner');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  test('a unique user declaration owner wins independently of the enclosing repository', async () => {
    const workspace = await createWorkspace('user-owner');
    await Promise.all([
      writeFile(workspace.projectManifest, declaration('review', 'project')),
      writeFile(workspace.projectLock, '# project lock sentinel\n'),
      writeFile(workspace.userManifest, declaration('factor-scan', 'user')),
    ]);
    const before = await snapshot([workspace.projectManifest, workspace.projectLock]);
    try {
      await expectPathBytes(
        [
          [workspace.projectManifest, declaration('review', 'project')],
          [workspace.projectLock, '# project lock sentinel\n'],
          [workspace.userManifest, declaration('factor-scan', 'user')],
          [workspace.userLock, null],
        ],
        'unique-user fixture characterization',
      );
      const { preview, execution } = await previewAndExecute(workspace, [], before);
      expectSelectedPair(
        preview,
        workspace.userManifest,
        workspace.userLock,
        'sibling',
        'user-owner',
      );
      expectSelectedPair(
        execution,
        workspace.userManifest,
        workspace.userLock,
        'sibling',
        'user-owner',
      );
      await expectUnchanged(before, 'unique user owner');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  }, 30_000);

  test('dual ownership refuses before every artifact and live write', async () => {
    const workspace = await createWorkspace('dual-owner');
    await Promise.all([
      writeFile(workspace.projectManifest, declaration('factor-scan', 'project')),
      writeFile(workspace.projectLock, '# project lock sentinel\n'),
      writeFile(workspace.userManifest, declaration('factor-scan', 'user')),
      writeFile(workspace.userLock, '# user lock sentinel\n'),
    ]);
    const livePath = join(workspace.env.HOME as string, '.claude', 'skills', 'factor-scan');
    const before = await snapshot([
      workspace.projectManifest,
      workspace.projectLock,
      workspace.userManifest,
      workspace.userLock,
      livePath,
    ]);
    try {
      await expectPathBytes(
        [
          [workspace.projectManifest, declaration('factor-scan', 'project')],
          [workspace.projectLock, '# project lock sentinel\n'],
          [workspace.userManifest, declaration('factor-scan', 'user')],
          [workspace.userLock, '# user lock sentinel\n'],
          [livePath, null],
        ],
        'dual-owner fixture characterization',
      );
      const { preview, execution } = await previewAndExecute(workspace, ['--force'], before, 2);
      for (const report of [preview, execution]) {
        expect(report).toMatchObject({
          schemaVersion: 2,
          kind: 'skillsmith.install',
          saveMode: 'desired-state',
          artifactPair: null,
          artifactSelection: { outcome: 'refused', reason: 'ambiguous-owner' },
        });
        expect(
          (report.artifactSelection as UnknownRecord).candidates,
          'refusal names both owners',
        ).toEqual([workspace.projectManifest, workspace.userManifest]);
      }
      await expectUnchanged(before, 'dual-owner refusal');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  test('a new declaration selects the project pair from effective project scope', async () => {
    const workspace = await createWorkspace('new-project');
    await Promise.all([
      writeFile(workspace.userManifest, declaration('review', 'user')),
      writeFile(workspace.userLock, '# user lock sentinel\n'),
    ]);
    const before = await snapshot([workspace.userManifest, workspace.userLock]);
    try {
      await expectPathBytes(
        [
          [workspace.projectManifest, null],
          [workspace.projectLock, null],
          [workspace.userManifest, declaration('review', 'user')],
          [workspace.userLock, '# user lock sentinel\n'],
        ],
        'new-project fixture characterization',
      );
      const { preview, execution } = await previewAndExecute(workspace, [], before);
      expectSelectedPair(
        preview,
        workspace.projectManifest,
        workspace.projectLock,
        'sibling',
        'new-project',
      );
      expectSelectedPair(
        execution,
        workspace.projectManifest,
        workspace.projectLock,
        'sibling',
        'new-project',
      );
      await expectUnchanged(before, 'new project declaration');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  test('a new user declaration selects the user pair even when cwd is inside a repository', async () => {
    const workspace = await createWorkspace('new-user');
    await Promise.all([
      writeFile(workspace.projectManifest, declaration('review', 'project')),
      writeFile(workspace.projectLock, '# project lock sentinel\n'),
    ]);
    const before = await snapshot([workspace.projectManifest, workspace.projectLock]);
    try {
      await expectPathBytes(
        [
          [workspace.projectManifest, declaration('review', 'project')],
          [workspace.projectLock, '# project lock sentinel\n'],
          [workspace.userManifest, null],
          [workspace.userLock, null],
        ],
        'new-user fixture characterization',
      );
      const { preview, execution } = await previewAndExecute(workspace, ['--user'], before);
      expectSelectedPair(
        preview,
        workspace.userManifest,
        workspace.userLock,
        'sibling',
        'new-user',
      );
      expectSelectedPair(
        execution,
        workspace.userManifest,
        workspace.userLock,
        'sibling',
        'new-user',
      );
      await expectUnchanged(before, 'new user declaration');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  test('no-save performs no portable discovery or write and reports conditional unevaluated drift', async () => {
    const workspace = await createWorkspace('no-save');
    await Promise.all([
      writeFile(workspace.projectManifest, declaration('factor-scan', 'project')),
      writeFile(workspace.projectLock, '# project lock sentinel\n'),
      writeFile(workspace.userManifest, declaration('factor-scan', 'user')),
      writeFile(workspace.userLock, '# user lock sentinel\n'),
    ]);
    const before = await snapshot([
      workspace.projectManifest,
      workspace.projectLock,
      workspace.userManifest,
      workspace.userLock,
    ]);
    const livePath = join(workspace.env.HOME as string, '.claude', 'skills', 'factor-scan');
    try {
      await expectPathBytes(
        [
          [workspace.projectManifest, declaration('factor-scan', 'project')],
          [workspace.projectLock, '# project lock sentinel\n'],
          [workspace.userManifest, declaration('factor-scan', 'user')],
          [workspace.userLock, '# user lock sentinel\n'],
          [livePath, null],
        ],
        'no-save fixture characterization',
      );
      const { preview, execution } = await previewAndExecute(
        workspace,
        ['--user', '--no-save'],
        before,
      );
      for (const report of [preview, execution]) {
        expect(report).toMatchObject({
          schemaVersion: 2,
          kind: 'skillsmith.install',
          saveMode: 'live-only',
          artifactPair: null,
          artifactSelection: { outcome: 'none', reason: 'no-save' },
        });
        expect(records(report.results)).not.toHaveLength(0);
        for (const result of records(report.results)) {
          expect(result.drift).toMatchObject({
            status: 'not-evaluated',
            futureApply: 'depends-on-selected-manifest',
          });
        }
      }
      await expectUnchanged(before, 'no-save');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });
});
