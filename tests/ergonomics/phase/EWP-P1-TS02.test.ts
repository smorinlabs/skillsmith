import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { resolveEffectiveConfig } from '../../../packages/core/src/config/effective.ts';
import { resolveRuntimeConfiguration } from '../../../packages/core/src/config/runtime.ts';
import { resolveProjectContext } from '../../../packages/core/src/context/project.ts';
import type { Config } from '../../../packages/core/src/index.ts';
import { defaultRuntimePorts } from '../../../packages/core/src/ports/default.ts';
import type { RuntimePorts } from '../../../packages/core/src/ports/types.ts';
import { hermeticGitEnv, runGit } from '../../../packages/core/tests/fixtures/git-env.ts';

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`unexpected resolution failure: ${JSON.stringify(result.error)}`);
  return result.value;
};

const initializeRepository = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  runGit(root, ['init', '--quiet']);
};

const runCli = async (
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
) => {
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

describe('EWP-P1-TS02', () => {
  test('effective config reports CLI > env > explicit > discovered > user > system precedence', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-config-'));
    const repository = join(sandbox, 'repository');
    const nested = join(repository, 'packages', 'api');
    const explicitConfig = join(nested, 'team.toml');
    const projectConfig = join(nested, 'skillsmith.toml');
    const userConfig = join(sandbox, 'xdg', 'skillsmith', 'config.toml');
    const systemConfig = '/etc/skillsmith/config.toml';
    await initializeRepository(repository);
    await mkdir(nested, { recursive: true });

    const files = new Map<string, string>([
      [systemConfig, 'tool = "opencode"\n'],
      [userConfig, 'tool = "codex"\n'],
      [projectConfig, 'tool = "claude-code"\n'],
      [explicitConfig, 'tool = "kilo-code"\n'],
    ]);

    try {
      const baseEnv = await defaultRuntimePorts();
      const env: RuntimePorts = {
        ...baseEnv,
        homeDir: join(sandbox, 'home'),
        xdg: {
          config: join(sandbox, 'xdg'),
          data: join(sandbox, 'data'),
          cache: join(sandbox, 'cache'),
        },
        fileExists: async (path) => files.has(path) || baseEnv.fileExists(path),
      };
      const context = unwrap(
        await resolveProjectContext(env, {
          invocationCwd: sandbox,
          cd: join('repository', 'packages', 'api'),
          explicitConfigPath: './team.toml',
        }),
      );
      const readFile = async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`unexpected read: ${path}`);
        return value;
      };

      const resolveTool = async (
        cli: Config | undefined,
        envVars: Record<string, string | undefined>,
      ) =>
        unwrap(
          await resolveEffectiveConfig(env, context, {
            ...(cli ? { cli } : {}),
            configuration: resolveRuntimeConfiguration(envVars),
            readFile,
          }),
        );

      const cli = await resolveTool({ tool: 'opencode' }, { SKILLSMITH_TOOL: 'codex' });
      expect(cli.value.tool).toBe('opencode');
      expect(cli.sources.tool).toBe('cli');

      const environment = await resolveTool(undefined, { SKILLSMITH_TOOL: 'codex' });
      expect(environment.value.tool).toBe('codex');
      expect(environment.sources.tool).toBe('env');

      const explicit = await resolveTool(undefined, {});
      expect(explicit.value.tool).toBe('kilo-code');
      expect(explicit.sources.tool).toBe('explicit-file');

      files.delete(explicitConfig);
      const discovered = await resolveTool(undefined, {});
      expect(discovered.value.tool).toBe('claude-code');
      expect(discovered.sources.tool).toBe('project');

      files.delete(projectConfig);
      const user = await resolveTool(undefined, {});
      expect(user.value.tool).toBe('codex');
      expect(user.sources.tool).toBe('user');

      files.delete(userConfig);
      const system = await resolveTool(undefined, {});
      expect(system.value.tool).toBe('opencode');
      expect(system.sources.tool).toBe('system');
      expect(system.layers.defaults).toEqual({});

      expect(cli.paths).toMatchObject({
        system: systemConfig,
        user: userConfig,
        project: projectConfig,
        'explicit-file': explicitConfig,
      });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('relative explicit config uses effective cwd and never relocates the live Git root', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-config-bases-'));
    const repository = join(sandbox, 'repository');
    const nested = join(repository, 'packages', 'api');
    await initializeRepository(repository);
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'skillsmith.toml'), 'tool = "codex"\n');
    await writeFile(join(nested, 'team.toml'), 'tool = "claude-code"\n');

    try {
      const env = await defaultRuntimePorts();
      const context = unwrap(
        await resolveProjectContext(env, {
          invocationCwd: sandbox,
          cd: join('repository', 'packages', 'api'),
          explicitConfigPath: './team.toml',
        }),
      );
      expect(context.effectiveCwd).toBe(nested);
      expect(context.projectRoot).toBe(await env.realpath(repository));
      expect(context.discoveredConfigPath).toBe(join(nested, 'skillsmith.toml'));
      expect(context.explicitConfigPath).toBe(join(nested, 'team.toml'));
      expect(context.explicitConfigPath).not.toBe(context.discoveredConfigPath);
      expect(context.explicitConfigPath).not.toBe(context.projectRoot);

      const effective = unwrap(
        await resolveEffectiveConfig(env, context, {
          configuration: resolveRuntimeConfiguration({}),
        }),
      );
      expect(effective.value.tool).toBe('claude-code');
      expect(effective.sources.tool).toBe('explicit-file');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('spawned --config is resolved after -C and reports its source layer', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-config-cli-'));
    const invocationCwd = join(sandbox, 'invocation');
    const repository = join(sandbox, 'repository');
    const nested = join(repository, 'packages', 'api');
    await initializeRepository(repository);
    await Promise.all([
      mkdir(invocationCwd, { recursive: true }),
      mkdir(nested, { recursive: true }),
      mkdir(join(sandbox, 'xdg', 'skillsmith'), { recursive: true }),
    ]);
    await writeFile(join(nested, 'skillsmith.toml'), 'tool = "codex"\n');
    await writeFile(join(nested, 'team.toml'), 'tool = "claude-code"\n');
    await writeFile(join(sandbox, 'xdg', 'skillsmith', 'config.toml'), 'tool = "kilo-code"\n');

    try {
      const result = await runCli(
        ['-C', nested, '--config', './team.toml', 'config', 'list', '--json'],
        invocationCwd,
        {
          HOME: join(sandbox, 'home'),
          XDG_CONFIG_HOME: join(sandbox, 'xdg'),
          XDG_DATA_HOME: join(sandbox, 'data'),
          XDG_CACHE_HOME: join(sandbox, 'cache'),
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe(
        `warning: legacy project config detected at ${join(nested, 'skillsmith.toml')}; migrate the project configuration in Phase 2 with config set or config unset\n`,
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        effective: { tool: 'claude-code' },
        sources: { tool: 'explicit-file' },
      });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('spawned SKILLSMITH_CONFIG follows -C, yields to --config, and never rebases the project', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-config-env-'));
    const invocationCwd = join(sandbox, 'invocation');
    const repository = join(sandbox, 'repository');
    const nested = join(repository, 'packages', 'api');
    const projectSkill = join(repository, '.claude', 'skills', 'context-skill');
    await initializeRepository(repository);
    await Promise.all([
      mkdir(invocationCwd, { recursive: true }),
      mkdir(nested, { recursive: true }),
      mkdir(projectSkill, { recursive: true }),
    ]);
    await writeFile(join(nested, 'skillsmith.toml'), 'tool = "opencode"\n');
    await writeFile(join(nested, 'environment.toml'), 'tool = "kilo-code"\n');
    await writeFile(join(nested, 'team.toml'), 'tool = "claude-code"\n');
    await writeFile(join(projectSkill, 'SKILL.md'), '---\nname: context-skill\n---\nfixture\n');
    const env = {
      HOME: join(sandbox, 'home'),
      XDG_CONFIG_HOME: join(sandbox, 'xdg'),
      XDG_DATA_HOME: join(sandbox, 'data'),
      XDG_CACHE_HOME: join(sandbox, 'cache'),
      SKILLSMITH_CONFIG: './environment.toml',
    };

    try {
      const fromEnvironment = await runCli(
        ['config', 'list', '-C', nested, '--json'],
        invocationCwd,
        env,
      );
      expect(fromEnvironment.exitCode).toBe(0);
      expect(fromEnvironment.stderr).toBe(
        `warning: legacy project config detected at ${join(nested, 'skillsmith.toml')}; migrate the project configuration in Phase 2 with config set or config unset\n`,
      );
      expect(JSON.parse(fromEnvironment.stdout)).toMatchObject({
        effective: { tool: 'kilo-code' },
        sources: { tool: 'explicit-file' },
      });

      const fromFlag = await runCli(
        ['config', 'list', '-C', nested, '--config', './team.toml', '--json'],
        invocationCwd,
        env,
      );
      expect(fromFlag.exitCode).toBe(0);
      expect(fromFlag.stderr).toBe(
        `warning: legacy project config detected at ${join(nested, 'skillsmith.toml')}; migrate the project configuration in Phase 2 with config set or config unset\n`,
      );
      expect(JSON.parse(fromFlag.stdout)).toMatchObject({
        effective: { tool: 'claude-code' },
        sources: { tool: 'explicit-file' },
      });

      const list = await runCli(
        ['list', '-C', nested, '--config', './team.toml', '--project', '--json'],
        invocationCwd,
        env,
      );
      expect(list.exitCode).toBe(0);
      expect(list.stderr).toBe('');
      expect(JSON.parse(list.stdout)).toMatchObject({
        skills: [
          {
            name: 'context-skill',
            tool: 'claude-code',
            scope: 'project',
            root: join(repository, '.claude', 'skills'),
          },
        ],
      });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
