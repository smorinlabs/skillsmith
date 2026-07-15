import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { resolveProjectContext } from '../../../packages/core/src/context/project.ts';
import { defaultRuntimePorts } from '../../../packages/core/src/ports/default.ts';
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
});
