import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import rootPackage from '../../../package.json' with { type: 'json' };
import cliPackage from '../../../packages/cli/package.json' with { type: 'json' };
import { HELP_TOPIC_NAMES, renderTopic } from '../../../packages/cli/src/help/topics.ts';
import { buildProgram } from '../../../packages/cli/src/program.ts';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import corePackage from '../../../packages/core/package.json' with { type: 'json' };
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';
import { validateDocumentationDrift } from '../../../scripts/p17-documentation-drift.ts';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const readRepo = (path: string): Promise<string> => readFile(join(ROOT, path), 'utf8');

const commandInventory = () => {
  const program = buildProgram();
  const commands = program.commands.map((command) => command.name()).sort();
  const aliases = program.commands.flatMap((command) => command.aliases()).sort();
  return { program, commands, aliases, all: [...commands, ...aliases].sort() };
};

const markdownTokens = (line: string): string[] =>
  [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '').filter(Boolean);

const shellExamples = (markdown: string): string[] =>
  [...markdown.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((block) =>
    (block[1] ?? '')
      .split('\n')
      .map((line) => line.trim().replace(/^\$\s+/, ''))
      .filter((line) => line.startsWith('skillsmith ')),
  );

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

describe('EWP-P1-TS05', () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test('README current and future command inventories close against the live parser', async () => {
    const readme = await readRepo('README.md');
    const { all } = commandInventory();
    const today = readme.split('\n').find((line) => line.startsWith('**Today:**')) ?? '';
    const target = readme.split('\n').find((line) => line.startsWith('**P17 target:**')) ?? '';

    expect(markdownTokens(today).sort()).toEqual(all);
    expect(markdownTokens(target).sort()).toEqual(
      ['apply', 'gc', 'init', 'plan', 'sync', 'undo', 'update'].sort(),
    );
    for (const future of markdownTokens(target)) {
      expect(today).not.toContain(`\`${future}\``);
      expect(all).not.toContain(future);
    }
  });

  test('current tool capabilities, check gating, and inherited context flags are explicit', async () => {
    const readme = await readRepo('README.md');
    for (const tool of ['claude-code', 'codex', 'kilo-code', 'opencode']) {
      expect(readme).toContain(`\`${tool}\``);
    }
    expect(readme).toMatch(/(?:write|mutat)[^\n]*Claude Code[^\n]*Codex/i);
    expect(readme).toMatch(/verify[^\n]*Claude Code[^\n]*Codex/i);
    expect(readme).toMatch(/Kilo Code[^\n]*(?:read-only|detection)/i);
    expect(readme).toMatch(/opencode[^\n]*(?:read-only|detection)/i);
    expect(readme).toMatch(/check[^\n]*fail[^\n]*default/i);
    expect(readme).toContain('--report-only');
    expect(readme).toContain('-C');
    expect(readme).toContain('--config');
  });

  test('rendered user help is live and does not expose internal planning as its manual', () => {
    const live = new Set(commandInventory().all);
    for (const topic of HELP_TOPIC_NAMES) {
      const result = renderTopic(topic);
      expect(result.ok, topic).toBeTrue();
      if (!result.ok) throw new Error(`missing help topic ${topic}`);
      expect(result.value, topic).not.toMatch(/P17 disposition|docs\/superpowers|research\//i);
      for (const match of result.value.matchAll(/skillsmith\s+([a-z][a-z-]*)/g)) {
        expect(live.has(match[1] ?? ''), `${topic}: ${match[0]}`).toBeTrue();
      }
    }
  });

  test('documented current shell examples name live commands and declared options', async () => {
    const readme = await readRepo('README.md');
    const examples = shellExamples(readme);
    const { program, all } = commandInventory();
    const representative = new Set<string>();

    for (const example of examples) {
      const tokens = example.split(/\s+/);
      const commandName = tokens[1] ?? '';
      expect(all, example).toContain(commandName);
      representative.add(commandName);
      const command = program.commands.find(
        (candidate) =>
          candidate.name() === commandName || candidate.aliases().includes(commandName),
      );
      if (!command) continue;
      const flags = new Set(
        [...program.options, ...command.options].flatMap((option) =>
          [option.short, option.long].filter((value): value is string => value !== undefined),
        ),
      );
      for (const token of tokens.slice(2)) {
        if (!token.startsWith('-')) continue;
        expect(flags, example).toContain(token.split('=')[0] ?? token);
      }
    }

    for (const command of [
      'agents',
      'list',
      'config',
      'check',
      'verify',
      'install',
      'uninstall',
      'dev',
      'promote',
      'status',
      'completion',
    ]) {
      expect(representative.has(command), `missing current example for ${command}`).toBeTrue();
    }
  });

  test('root and package documentation matches package and async public API truth', async () => {
    const [readme, coreReadme, cliReadme] = await Promise.all([
      readRepo('README.md'),
      readRepo('packages/core/README.md'),
      readRepo('packages/cli/README.md'),
    ]);
    expect(corePackage.version).toBe(cliPackage.version);
    expect(corePackage.version).toBe(rootPackage.version);
    expect(readme).toMatch(/@skillsmith\/core[^\n]*(?:not published|workspace only)/i);
    expect(readme).not.toMatch(/bun add @skillsmith\/core|npm i @skillsmith\/core/);
    expect(readme).toContain('const env = await defaultScanEnv();');
    expect(coreReadme).toMatch(/not \(yet\) published to npm/i);
    expect(cliReadme).toMatch(/agents[^\n]*list[^\n]*config[^\n]*check/i);
  });

  test('exact legacy project config reads warn once and preserve source bytes', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-docs-'));
    const project = join(sandbox, 'project');
    const nested = join(project, 'packages', 'api');
    const configPath = join(project, 'skillsmith.toml');
    const source = '# retained comment\ntool = "codex"\nscope = "project"\n';
    const env = {
      HOME: join(sandbox, 'home'),
      XDG_CONFIG_HOME: join(sandbox, 'xdg', 'config'),
      XDG_DATA_HOME: join(sandbox, 'xdg', 'data'),
      XDG_CACHE_HOME: join(sandbox, 'xdg', 'cache'),
      SKILLSMITH_CONFIG: undefined,
      SKILLSMITH_TOOL: undefined,
      SKILLSMITH_SCOPE: undefined,
    };
    await Promise.all([
      mkdir(nested, { recursive: true }),
      mkdir(env.HOME, { recursive: true }),
      mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
      mkdir(env.XDG_DATA_HOME, { recursive: true }),
      mkdir(env.XDG_CACHE_HOME, { recursive: true }),
    ]);
    await writeFile(configPath, source);

    try {
      const result = await runCli(['config', 'list'], nested, env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('tool = "codex"');
      expect(result.stdout).toContain('scope = "project"');
      const warnings = result.stderr.trimEnd().split('\n').filter(Boolean);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/warning:.*legacy project config/i);
      expect(warnings[0]).toContain(configPath);
      expect(warnings[0]).toMatch(/Phase 2/i);
      expect(warnings[0]).toMatch(/read-only|migrat/i);
      expect(await readFile(configPath, 'utf8')).toBe(source);

      const doctorArgs = ['doctor', '--tool', 'codex', '--scope', 'user', '--offline'] as const;
      const doctor = await runCli(doctorArgs, nested, env);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).toContain('checks reported');
      const doctorWarnings = doctor.stderr.trimEnd().split('\n').filter(Boolean);
      expect(doctorWarnings).toHaveLength(1);
      expect(doctorWarnings[0]).toMatch(/warning:.*legacy project config/i);
      expect(doctorWarnings[0]).toContain(configPath);

      const doctorJson = await runCli([...doctorArgs, '--json'], nested, env);
      expect(doctorJson.exitCode).toBe(0);
      expect(doctorJson.stderr).toBe('');
      expect(() => JSON.parse(doctorJson.stdout)).not.toThrow();
      expect(await readFile(configPath, 'utf8')).toBe(source);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('the existing G0-04 reviewed documentation inventory remains compatible', async () => {
    const ledger = JSON.parse(
      await readRepo('projects/p17/reviews/P17-G0-04-documentation-drift.json'),
    ) as unknown;
    expect(validateDocumentationDrift(ledger)).toEqual([]);
  });
});
