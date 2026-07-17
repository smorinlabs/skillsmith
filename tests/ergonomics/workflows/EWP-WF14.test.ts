import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { resolveProjectContext } from '../../../packages/core/src/context/project.ts';
import { defaultRuntimePorts } from '../../../packages/core/src/ports/default.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../packages/core/tests/fixtures/acquire/remote.ts';
import { hermeticGitEnv, runGit } from '../../../packages/core/tests/fixtures/git-env.ts';

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`unexpected context failure: ${JSON.stringify(result.error)}`);
  return result.value;
};

const runCli = async (
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
) => {
  const childEnv = hermeticGitEnv({ ...env, CI: '1', NO_COLOR: '1' });
  if (env.GIT_CONFIG_GLOBAL !== undefined) {
    childEnv.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  }
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: childEnv,
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

type UnknownRecord = Record<string, unknown>;

interface OwnershipWorkspace {
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

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const requireJson = (product: Awaited<ReturnType<typeof runCli>>, label: string): UnknownRecord => {
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

const createOwnershipWorkspace = async (label: string): Promise<OwnershipWorkspace> => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-wf14-${label}-`));
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

const ownershipSource = (): string => `${remote.multiSource}//plugins/fh/skills/factor-scan`;

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
  ownershipSource(),
  '--tool',
  'claude-code',
  '--no-verify',
  '--json',
  ...extra,
];

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

describe('EWP-WF14', () => {
  test('the Phase-1 slice keeps cross-command live roots invariant under nested config shadowing', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-wf14-context-'));
    const invocationCwd = join(sandbox, 'invocation');
    const repository = join(sandbox, 'repository');
    const nested = join(repository, 'packages', 'api');
    const projectSkill = join(repository, '.claude', 'skills', 'context-skill');
    const projectCommand = join(repository, '.claude', 'commands');
    await Promise.all([
      mkdir(invocationCwd, { recursive: true }),
      mkdir(nested, { recursive: true }),
      mkdir(projectSkill, { recursive: true }),
      mkdir(projectCommand, { recursive: true }),
    ]);
    runGit(repository, ['init', '--quiet']);
    await writeFile(join(nested, 'skillsmith.toml'), 'tool = "codex"\n');
    await writeFile(join(nested, 'team.toml'), 'tool = "claude-code"\n');
    await writeFile(join(projectSkill, 'SKILL.md'), '---\nname: context-skill\n---\nfixture\n');
    await writeFile(join(projectCommand, 'context-command.md'), '# Context command\n');
    const env = {
      HOME: join(sandbox, 'home'),
      XDG_CONFIG_HOME: join(sandbox, 'config'),
      XDG_DATA_HOME: join(sandbox, 'data'),
      XDG_CACHE_HOME: join(sandbox, 'cache'),
    };
    const global = ['-C', nested, '--config', './team.toml'] as const;

    try {
      const [list, commands, config] = await Promise.all([
        runCli([...global, 'list', '--project', '--json'], invocationCwd, env),
        runCli([...global, 'commands', '--project', '--json'], invocationCwd, env),
        runCli([...global, 'config', 'list', '--json'], invocationCwd, env),
      ]);
      expect([list.exitCode, commands.exitCode, config.exitCode]).toEqual([0, 0, 0]);
      expect([list.stderr, commands.stderr, config.stderr]).toEqual([
        '',
        '',
        `warning: legacy project config detected at ${join(nested, 'skillsmith.toml')}; migrate the project configuration in Phase 2 with config set or config unset\n`,
      ]);

      const listOutput = JSON.parse(list.stdout) as {
        schemaVersion: number;
        kind: string;
        entries: readonly { name: string; root: string; tool: string; scope: string }[];
      };
      expect({ schemaVersion: listOutput.schemaVersion, kind: listOutput.kind }).toEqual({
        schemaVersion: 3,
        kind: 'skillsmith.list',
      });
      expect(listOutput.entries).toEqual([
        expect.objectContaining({
          name: 'context-skill',
          root: join(repository, '.claude', 'skills'),
          tool: 'claude-code',
          scope: 'project',
        }),
      ]);

      const commandOutput = JSON.parse(commands.stdout) as {
        schemaVersion: number;
        kind: string;
        entries: readonly { name: string; root: string; tool: string; scope: string }[];
      };
      expect({ schemaVersion: commandOutput.schemaVersion, kind: commandOutput.kind }).toEqual({
        schemaVersion: 2,
        kind: 'skillsmith.commands',
      });
      expect(commandOutput.entries).toEqual([
        expect.objectContaining({
          name: 'context-command',
          root: projectCommand,
          tool: 'claude-code',
          scope: 'project',
        }),
      ]);
      expect(JSON.parse(config.stdout)).toMatchObject({
        effective: { tool: 'claude-code' },
        sources: { tool: 'explicit-file' },
      });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('the Phase-1 slice separates config selection from project identity without artifact writes', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-wf14-readonly-'));
    const repository = join(sandbox, 'repository');
    const nested = join(repository, 'packages', 'api');
    await mkdir(nested, { recursive: true });
    runGit(repository, ['init', '--quiet']);
    const discoveredPath = join(nested, 'skillsmith.toml');
    const explicitPath = join(nested, 'team-state.toml');
    const discoveredBefore = 'tool = "codex"\n';
    const explicitBefore = 'tool = "claude-code"\n';
    await writeFile(discoveredPath, discoveredBefore);
    await writeFile(explicitPath, explicitBefore);

    try {
      const env = await defaultRuntimePorts();
      const context = unwrap(
        await resolveProjectContext(env, {
          invocationCwd: nested,
          explicitConfigPath: './team-state.toml',
        }),
      );
      expect(context.projectRoot).toBe(await env.realpath(repository));
      expect(context.projectIdentity).toBe(await env.realpath(repository));
      expect(context.discoveredConfigPath).toBe(discoveredPath);
      expect(context.explicitConfigPath).toBe(explicitPath);
      expect(
        new Set([context.projectRoot, context.discoveredConfigPath, context.explicitConfigPath])
          .size,
      ).toBe(3);

      // WF14's manifest/lock ownership and write matrix remains a Phase-2/4 obligation. This
      // Phase-1 target proves only that context/config reads cannot silently acquire that role.
      expect(await readFile(discoveredPath, 'utf8')).toBe(discoveredBefore);
      expect(await readFile(explicitPath, 'utf8')).toBe(explicitBefore);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  describe('Phase-4 ownership extension', () => {
    beforeAll(async () => {
      remote = await buildRemoteFixture();
    });

    afterAll(async () => {
      if (remote !== undefined) await destroyRemoteFixture(remote);
    });

    test('ownership-first destination creates a new user pair inside a repository without touching project artifacts', async () => {
      const workspace = await createOwnershipWorkspace('new-user');
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
        const product = await runCli(installArgs(['--user']), workspace.cwd, workspace.env);
        expect(product.exitCode, product.stderr).toBe(0);
        const report = requireJson(product, 'new user destination');
        expectSelectedPair(
          report,
          workspace.userManifest,
          workspace.userLock,
          'sibling',
          'new-user',
        );
        expect(await readMaybe(workspace.userManifest)).toContain('name = "factor-scan"');
        expect(await readMaybe(workspace.userLock)).toContain('name = "factor-scan"');
        await expectUnchanged(before, 'new user inside repository');
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    });

    test('ownership-first destination follows a unique project owner even for user-scoped placement', async () => {
      const workspace = await createOwnershipWorkspace('project-owner');
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
        const product = await runCli(installArgs(['--user']), workspace.cwd, workspace.env);
        expect(product.exitCode, product.stderr).toBe(0);
        const report = requireJson(product, 'unique project owner');
        expectSelectedPair(
          report,
          workspace.projectManifest,
          workspace.projectLock,
          'sibling',
          'selected-project-owner',
        );
        expect(await readMaybe(workspace.projectManifest)).toContain('scope = "user"');
        await expectUnchanged(before, 'unique project owner');
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    });

    test('an explicit project file may own a user-scoped declaration without relocating the live root', async () => {
      const workspace = await createOwnershipWorkspace('explicit-user');
      const manifestPath = join(workspace.repository, 'team.toml');
      const lockPath = join(workspace.repository, 'team.lock');
      await Promise.all([
        writeFile(manifestPath, declaration('review', 'project')),
        writeFile(workspace.projectManifest, declaration('review', 'project')),
        writeFile(workspace.projectLock, '# project lock sentinel\n'),
        writeFile(workspace.userManifest, declaration('review', 'user')),
        writeFile(workspace.userLock, '# user lock sentinel\n'),
      ]);
      const before = await snapshot([
        workspace.projectManifest,
        workspace.projectLock,
        workspace.userManifest,
        workspace.userLock,
      ]);
      try {
        await expectPathBytes(
          [
            [manifestPath, declaration('review', 'project')],
            [lockPath, null],
            [workspace.projectManifest, declaration('review', 'project')],
            [workspace.projectLock, '# project lock sentinel\n'],
            [workspace.userManifest, declaration('review', 'user')],
            [workspace.userLock, '# user lock sentinel\n'],
          ],
          'explicit-owner fixture characterization',
        );
        const product = await runCli(
          installArgs(['--user', '--file', '../../team.toml']),
          workspace.cwd,
          workspace.env,
        );
        expect(product.exitCode, product.stderr).toBe(0);
        const report = requireJson(product, 'explicit project file');
        expectSelectedPair(report, manifestPath, lockPath, 'sibling', 'explicit-file');
        const manifest = await readMaybe(manifestPath);
        expect(manifest).toContain('name = "factor-scan"');
        expect(manifest).toContain('scope = "user"');
        const result = records(report.results)[0];
        expect(result).toMatchObject({ scope: 'user' });
        expect(result?.placementPath).toBe(
          join(workspace.env.HOME as string, '.claude', 'skills', 'factor-scan'),
        );
        await expectUnchanged(before, 'explicit project file');
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    });

    test('dual owners refuse install and uninstall before writes even when force is requested', async () => {
      const workspace = await createOwnershipWorkspace('dual-owner');
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
        const install = await runCli(installArgs(['--force']), workspace.cwd, workspace.env);
        const uninstall = await runCli(
          ['uninstall', 'factor-scan', '--tool', 'claude-code', '--user', '--force', '--json'],
          workspace.cwd,
          workspace.env,
        );
        expect([install.exitCode, uninstall.exitCode]).toEqual([2, 2]);
        for (const [label, product] of [
          ['install', install],
          ['uninstall', uninstall],
        ] as const) {
          const report = requireJson(product, `dual-owner ${label}`);
          expect(report).toMatchObject({
            schemaVersion: 2,
            saveMode: 'desired-state',
            artifactPair: null,
            artifactSelection: { outcome: 'refused', reason: 'ambiguous-owner' },
          });
          expect((report.artifactSelection as UnknownRecord).candidates).toEqual([
            workspace.projectManifest,
            workspace.userManifest,
          ]);
        }
        await expectUnchanged(before, 'dual-owner install/uninstall');
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    });

    test('the reported explicit pair is exact and every nonselected artifact remains byte-identical', async () => {
      const workspace = await createOwnershipWorkspace('exact-pair');
      const manifestPath = join(workspace.repository, 'state', 'team.toml');
      const siblingLock = join(workspace.repository, 'state', 'team.lock');
      const lockPath = join(workspace.repository, 'portable', 'team.state.lock');
      await Promise.all([
        mkdir(join(workspace.repository, 'state'), { recursive: true }),
        mkdir(join(workspace.repository, 'portable'), { recursive: true }),
        writeFile(workspace.projectManifest, declaration('review', 'project')),
        writeFile(workspace.projectLock, '# project lock sentinel\n'),
        writeFile(workspace.userManifest, declaration('review', 'user')),
        writeFile(workspace.userLock, '# user lock sentinel\n'),
      ]);
      const before = await snapshot([
        workspace.projectManifest,
        workspace.projectLock,
        workspace.userManifest,
        workspace.userLock,
        siblingLock,
      ]);
      try {
        await expectPathBytes(
          [
            [workspace.projectManifest, declaration('review', 'project')],
            [workspace.projectLock, '# project lock sentinel\n'],
            [workspace.userManifest, declaration('review', 'user')],
            [workspace.userLock, '# user lock sentinel\n'],
            [manifestPath, null],
            [lockPath, null],
            [siblingLock, null],
          ],
          'exact-pair fixture characterization',
        );
        const product = await runCli(
          installArgs([
            '--file',
            '../../state/team.toml',
            '--lockfile',
            '../../portable/team.state.lock',
          ]),
          workspace.cwd,
          workspace.env,
        );
        expect(product.exitCode, product.stderr).toBe(0);
        const report = requireJson(product, 'exact explicit pair');
        expectSelectedPair(report, manifestPath, lockPath, 'explicit', 'explicit-file');
        expect(await readMaybe(manifestPath)).toContain('name = "factor-scan"');
        expect(await readMaybe(lockPath)).toContain('name = "factor-scan"');
        await expectUnchanged(before, 'exact selected pair');
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    });
  });
});
