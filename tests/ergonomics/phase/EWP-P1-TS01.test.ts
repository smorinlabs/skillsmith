import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { resolveProjectContext } from '../../../packages/core/src/context/project.ts';
import { defaultRuntimePorts } from '../../../packages/core/src/ports/default.ts';
import { hermeticGitEnv, runGit } from '../../../packages/core/tests/fixtures/git-env.ts';

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok)
    throw new Error(`unexpected project-context failure: ${JSON.stringify(result.error)}`);
  return result.value;
};

const runCli = async (
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<CliResult> => {
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv({ ...env, CI: '1', NO_COLOR: '1' }),
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

const initializeRepository = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  runGit(root, ['init', '--quiet']);
  await writeFile(join(root, 'README.md'), 'fixture\n');
  runGit(root, ['add', 'README.md']);
  runGit(root, [
    '-c',
    'user.name=SkillSmith Tests',
    '-c',
    'user.email=tests@skillsmith.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
};

describe('EWP-P1-TS01', () => {
  test('-C resolves one frozen context before discovery without changing process cwd', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-context-'));
    const invocationCwd = join(sandbox, 'invocation');
    const repository = join(sandbox, 'repository');
    const nested = join(repository, 'packages', 'api');
    await mkdir(invocationCwd, { recursive: true });
    await initializeRepository(repository);
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'skillsmith.toml'), 'tool = "codex"\n');
    await writeFile(join(nested, 'team.toml'), 'tool = "claude-code"\n');

    try {
      const before = process.cwd();
      const env = await defaultRuntimePorts();
      const context = unwrap(
        await resolveProjectContext(env, {
          invocationCwd,
          cd: join('..', 'repository', 'packages', 'api'),
          explicitConfigPath: './team.toml',
        }),
      );

      expect(process.cwd()).toBe(before);
      expect(Object.isFrozen(context)).toBeTrue();
      expect(context).toEqual({
        invocationCwd,
        effectiveCwd: resolve(invocationCwd, '..', 'repository', 'packages', 'api'),
        projectRoot: await env.realpath(repository),
        projectIdentity: await env.realpath(repository),
        projectKind: 'git',
        discoveredConfigPath: join(nested, 'skillsmith.toml'),
        explicitConfigPath: join(nested, 'team.toml'),
      });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('root, nested, and symlink entries share one canonical Git identity', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-symlink-'));
    const repository = join(sandbox, 'repository');
    const nested = join(repository, 'packages', 'api');
    const linkedRepository = join(sandbox, 'linked-repository');
    await initializeRepository(repository);
    await mkdir(nested, { recursive: true });
    await symlink(repository, linkedRepository, 'dir');

    try {
      const env = await defaultRuntimePorts();
      const contexts = await Promise.all(
        [repository, nested, join(linkedRepository, 'packages', 'api')].map(async (invocationCwd) =>
          unwrap(await resolveProjectContext(env, { invocationCwd })),
        ),
      );
      const identity = await env.realpath(repository);

      expect(contexts.map((context) => context.projectRoot)).toEqual([
        identity,
        identity,
        identity,
      ]);
      expect(contexts.map((context) => context.projectIdentity)).toEqual([
        identity,
        identity,
        identity,
      ]);
      expect(contexts.every((context) => context.projectKind === 'git')).toBeTrue();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('Git worktrees resolve through Git even though .git is a file', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-worktree-'));
    const repository = join(sandbox, 'repository');
    const worktree = join(sandbox, 'worktree');
    await initializeRepository(repository);
    runGit(repository, ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
    const nested = join(worktree, 'nested');
    await mkdir(nested, { recursive: true });

    try {
      expect((await readFile(join(worktree, '.git'), 'utf8')).trim()).toStartWith('gitdir:');
      const env = await defaultRuntimePorts();
      const context = unwrap(await resolveProjectContext(env, { invocationCwd: nested }));
      expect(context.projectKind).toBe('git');
      expect(context.projectRoot).toBe(await env.realpath(worktree));
      expect(context.projectIdentity).toBe(await env.realpath(worktree));
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('outside Git the nearest manifest supplies a stable non-Git root', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-nongit-'));
    const projectRoot = join(sandbox, 'project');
    const nested = join(projectRoot, 'packages', 'api');
    await mkdir(nested, { recursive: true });
    await writeFile(join(projectRoot, 'skillsmith.toml'), 'tool = "codex"\n');

    try {
      const env = await defaultRuntimePorts();
      const context = unwrap(await resolveProjectContext(env, { invocationCwd: nested }));
      expect(context).toMatchObject({
        effectiveCwd: nested,
        projectRoot: await env.realpath(projectRoot),
        projectIdentity: await env.realpath(projectRoot),
        projectKind: 'non-git',
        discoveredConfigPath: join(projectRoot, 'skillsmith.toml'),
      });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('spawned project-aware commands honor global -C/config before or after subcommands', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-cd-cli-'));
    const invocationCwd = join(sandbox, 'invocation');
    const repository = join(sandbox, 'repository');
    const nested = join(repository, 'packages', 'api');
    const skillDir = join(repository, '.claude', 'skills', 'root-skill');
    const commandDir = join(repository, '.claude', 'commands');
    await initializeRepository(repository);
    await Promise.all([
      mkdir(invocationCwd, { recursive: true }),
      mkdir(nested, { recursive: true }),
      mkdir(skillDir, { recursive: true }),
      mkdir(commandDir, { recursive: true }),
    ]);
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: root-skill\n---\nfixture\n');
    await writeFile(join(commandDir, 'root-command.md'), '# Root command\n');
    await writeFile(join(nested, 'skillsmith.toml'), 'tool = "codex"\n');
    await writeFile(join(nested, 'team.toml'), 'tool = "claude-code"\n');
    const env = {
      HOME: join(sandbox, 'home'),
      XDG_CONFIG_HOME: join(sandbox, 'config'),
      XDG_DATA_HOME: join(sandbox, 'data'),
      XDG_CACHE_HOME: join(sandbox, 'cache'),
    };

    try {
      const cases = [
        {
          name: 'list with globals before the subcommand',
          kind: 'list',
          args: ['-C', nested, '--config', './team.toml', 'list', '--project', '--json'],
        },
        {
          name: 'list with globals after the subcommand',
          kind: 'list',
          args: ['list', '-C', nested, '--config', './team.toml', '--project', '--json'],
        },
        {
          name: 'commands with globals before the subcommand',
          kind: 'commands',
          args: ['-C', nested, '--config', './team.toml', 'commands', '--project', '--json'],
        },
        {
          name: 'commands with globals after the subcommand',
          kind: 'commands',
          args: ['commands', '-C', nested, '--config', './team.toml', '--project', '--json'],
        },
        {
          name: 'config list with globals before the subcommands',
          kind: 'config',
          args: ['-C', nested, '--config', './team.toml', 'config', 'list', '--json'],
        },
        {
          name: 'config list with globals after the subcommands',
          kind: 'config',
          args: ['config', 'list', '-C', nested, '--config', './team.toml', '--json'],
        },
      ] as const;
      for (const matrixCase of cases) {
        const result = await runCli(matrixCase.args, invocationCwd, env);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe(
          matrixCase.kind === 'config'
            ? `warning: legacy project config detected at ${join(nested, 'skillsmith.toml')}; migrate the project configuration in Phase 2 with config set or config unset\n`
            : '',
        );
        const output = JSON.parse(result.stdout) as Record<string, unknown>;

        if (matrixCase.kind === 'list') {
          expect(output).toMatchObject({
            entries: [
              {
                name: 'root-skill',
                tool: 'claude-code',
                scope: 'project',
                root: join(repository, '.claude', 'skills'),
              },
            ],
          });
        } else if (matrixCase.kind === 'commands') {
          expect(output).toMatchObject({
            entries: [
              {
                name: 'root-command',
                tool: 'claude-code',
                scope: 'project',
                root: commandDir,
              },
            ],
          });
        } else {
          expect(output).toMatchObject({
            effective: { tool: 'claude-code' },
            sources: { tool: 'explicit-file' },
            layers: {
              project: { tool: 'codex' },
              'explicit-file': { tool: 'claude-code' },
            },
          });
        }
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 30_000);
});
