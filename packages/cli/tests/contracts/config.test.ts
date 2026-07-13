import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEffectiveConfig } from '../../../core/src/config/effective.ts';
import { resolveRuntimeConfiguration } from '../../../core/src/config/runtime.ts';
import { saveConfig } from '../../../core/src/config/save.ts';
import { resolveProjectContext } from '../../../core/src/context/project.ts';
import type { ProjectContext } from '../../../core/src/context/types.ts';
import { hermeticGitEnv, runGit } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const sandbox = async (label: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-config-${label}-`));
  temporaryRoots.push(root);
  return root;
};

const cliEnv = (root: string): Record<string, string | undefined> => ({
  HOME: join(root, 'home'),
  XDG_CONFIG_HOME: join(root, 'xdg'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  SKILLSMITH_CONFIG: undefined,
  SKILLSMITH_TOOL: undefined,
  SKILLSMITH_SCOPE: undefined,
  SKILLSMITH_PATH: undefined,
});

const runCli = async (
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
) => {
  const child = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv({ ...env, CI: '1', NO_COLOR: '1' }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
};

const permissionBits = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const unexpectedEntries = async (
  directory: string,
  allowed: readonly string[],
): Promise<readonly string[]> =>
  (await readdir(directory)).filter((name) => !allowed.includes(name)).sort();

const memorySavePorts = (
  file: string,
  source: string,
  options: { readonly failRename?: boolean; readonly systemConfigPath?: string } = {},
) => {
  const files = new Map<string, string>([[file, source]]);
  const modes = new Map<string, number>([[file, 0o600]]);
  const mutations: string[] = [];
  const ports = {
    homeDir: '/home/test',
    executableSearchPath: [],
    platform: 'linux' as const,
    xdg: { config: '/config', data: '/data', cache: '/cache' },
    ...(options.systemConfigPath === undefined
      ? {}
      : { systemConfigPath: options.systemConfigPath }),
    fileExists: async (path: string) => files.has(path),
    pathKind: async (path: string) => (files.has(path) ? ('file' as const) : ('absent' as const)),
    realpath: async (path: string) => path,
    listDir: async () => [],
    readText: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    readBytes: async (path: string) => new TextEncoder().encode(files.get(path) ?? ''),
    readLink: async () => '',
    isExecutable: async () => false,
    modifiedAt: async () => 0,
    makeDir: async () => {
      mutations.push('makeDir');
    },
    writeTextFile: async (path: string, text: string) => {
      mutations.push('writeTextFile');
      files.set(path, text);
    },
    makeSymlink: async () => {
      mutations.push('makeSymlink');
    },
    rename: async (from: string, to: string) => {
      mutations.push('rename');
      if (options.failRename) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      files.set(to, files.get(from) ?? '');
      files.delete(from);
      const mode = modes.get(from);
      if (mode !== undefined) modes.set(to, mode);
      modes.delete(from);
    },
    copyTree: async () => {
      mutations.push('copyTree');
    },
    removeTree: async (path: string) => {
      mutations.push('removeTree');
      files.delete(path);
      modes.delete(path);
    },
    fsyncFile: async () => {
      mutations.push('fsyncFile');
    },
    fsyncDir: async () => {
      mutations.push('fsyncDir');
    },
    withFileLock: async <T>(_path: string, operation: () => Promise<T>) => operation(),
    assertWritableDirectory: async () => {},
    exec: async () => ({ code: 0, stdout: new Uint8Array(), stderr: '', timedOut: false }),
    runVersion: async () => 'unknown' as const,
    wallNowIso: () => '2026-07-13T00:00:00.000Z',
    epochMilliseconds: () => 0,
    monotonicMilliseconds: () => 0,
    nextId: () => 'fixture',
    git: {
      findRepositoryRoot: async () => null,
      inspectWorktree: async ({ repositoryRoot }: { repositoryRoot: string }) => ({
        repositoryRoot,
        headSha: '',
        remoteUrl: null,
        dirtySummary: null,
      }),
      resolveRemoteRef: async () => null,
      initializeFetch: async () => {},
      fetchRef: async () => ({ sha: '' }),
      listTree: async () => [],
      readBlob: async () => new Uint8Array(),
      materializeTree: async () => '',
    },
    http: { request: async () => ({ status: 200, ok: true }) },
    readFileMetadata: async (path: string) => ({
      kind: files.has(path) ? 'file' : 'absent',
      mode: modes.get(path) ?? 0o600,
      identity: path,
    }),
    setFileMode: async (path: string, mode: number) => {
      mutations.push('setFileMode');
      modes.set(path, mode);
    },
  };
  return { files, modes, mutations, ports };
};

describe('EWP-CMD-CONFIG-TS01', () => {
  test('project set replaces only the canonical tools value and preserves CRLF, trivia, and mode', async () => {
    const root = await sandbox('ts01-lossless');
    const manifest = join(root, 'skillsmith.toml');
    runGit(root, ['init', '--quiet']);
    const before =
      '# desired\r\nversion = 1\r\n\r\n[registry]\r\ndefault = "github.com/acme"\r\n\r\n[defaults]\r\n"tools"\t=\t[ "codex", \'opencode\', ] # selected\r\nscope = "project"\r\n\r\n[[skills]]\r\nname = "keep"\r\nsource = "acme/keep"\r\n';
    const after = before.replace('[ "codex", \'opencode\', ]', '[ "claude-code", ]');
    await writeFile(manifest, before);
    await chmod(manifest, 0o600);
    expect(await readFile(manifest, 'utf8')).toBe(before);
    expect(await permissionBits(manifest)).toBe(0o600);

    const result = await runCli(
      ['config', 'set', 'tool', 'claude-code', '--scope', 'project'],
      root,
      cliEnv(root),
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(await readFile(manifest, 'utf8')).toBe(after);
    expect(await permissionBits(manifest)).toBe(0o600);
    expect(await unexpectedEntries(root, ['.git', 'cache', 'skillsmith.toml'])).toEqual([]);
  });

  test('an equivalent flat-config set is byte-identical and performs no mutating file effects', async () => {
    const file = '/config/skillsmith/config.toml';
    const source = '# retained\ntool  =  "codex" # selected\n';
    const fixture = memorySavePorts(file, source);
    const result = await saveConfig(fixture.ports, {
      scope: 'user',
      patch: { tool: 'codex' },
    });

    expect(result.ok).toBeTrue();
    expect({ bytes: fixture.files.get(file), mutations: fixture.mutations }).toEqual({
      bytes: source,
      mutations: [],
    });
  });

  test('spawned get, set, list, and unset honor user and project scope shorthands', async () => {
    const root = await sandbox('ts01-scope-shorthands');
    runGit(root, ['init', '--quiet']);
    const cases = [
      {
        flag: '--user',
        file: join(root, 'xdg', 'skillsmith', 'config.toml'),
        listed: 'tool = "codex"\n',
      },
      {
        flag: '--project',
        file: join(root, 'skillsmith.toml'),
        listed: 'tools = ["codex"]\n',
      },
    ] as const;

    for (const selected of cases) {
      const set = await runCli(
        ['config', 'set', 'tool', 'codex', selected.flag],
        root,
        cliEnv(root),
      );
      expect(set.exitCode, set.stderr).toBe(0);
      expect(set.stdout).toBe('');
      expect(set.stderr).toContain(selected.file);

      const get = await runCli(['config', 'get', 'tool', selected.flag], root, cliEnv(root));
      expect(get).toMatchObject({ exitCode: 0, stdout: 'codex\n', stderr: '' });

      const list = await runCli(['config', 'list', selected.flag], root, cliEnv(root));
      expect(list).toEqual({ exitCode: 0, stdout: selected.listed, stderr: '' });

      const unset = await runCli(['config', 'unset', 'tool', selected.flag], root, cliEnv(root));
      expect(unset.exitCode, unset.stderr).toBe(0);
      expect(unset.stdout).toBe('');
      expect(await readFile(selected.file, 'utf8')).not.toContain('codex');
    }
  });

  test('LF and final-no-newline flat edits preserve 0640/0644 modes and exact newline form', async () => {
    const root = await sandbox('ts01-newlines');
    const directory = join(root, 'xdg', 'skillsmith');
    const file = join(directory, 'config.toml');
    await mkdir(directory, { recursive: true });

    for (const fixture of [
      { source: '# lf\ntool = "codex"\n', expected: '# lf\ntool = "opencode"\n', mode: 0o640 },
      { source: '# final\ntool = "codex"', expected: '# final\ntool = "opencode"', mode: 0o644 },
    ]) {
      await writeFile(file, fixture.source);
      await chmod(file, fixture.mode);
      const result = await runCli(
        ['config', 'set', 'tool', 'opencode', '--user'],
        root,
        cliEnv(root),
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(await readFile(file, 'utf8')).toBe(fixture.expected);
      expect(await permissionBits(file)).toBe(fixture.mode);
      expect(await unexpectedEntries(directory, ['config.toml'])).toEqual([]);
    }
  });

  test('an injected system path supports lossless set, effective read, and unset without /etc IO', async () => {
    const file = '/fixture/system/config.toml';
    const source = '# system\ntool = "codex"\n';
    const fixture = memorySavePorts(file, source, { systemConfigPath: file });
    const set = await saveConfig(fixture.ports, {
      scope: 'system',
      patch: { tool: 'opencode' },
    });
    expect(set).toMatchObject({ ok: true, value: { file, changed: true } });
    expect(fixture.files.get(file)).toBe('# system\ntool = "opencode"\n');
    expect(fixture.modes.get(file)).toBe(0o600);

    const resolved = await resolveEffectiveConfig(
      fixture.ports,
      {
        invocationCwd: '/repo',
        effectiveCwd: '/repo',
        projectRoot: null,
        projectIdentity: null,
        projectKind: 'non-git',
        discoveredConfigPath: null,
        explicitConfigPath: null,
      },
      { configuration: resolveRuntimeConfiguration({}) },
    );
    expect(resolved).toMatchObject({
      ok: true,
      value: { value: { tool: 'opencode' }, sources: { tool: 'system' } },
    });

    const unset = await saveConfig(fixture.ports, { scope: 'system', delete: ['tool'] });
    expect(unset).toMatchObject({ ok: true, value: { file, changed: true } });
    expect(fixture.files.get(file)).not.toContain('tool');
    expect([...fixture.files.keys()].filter((path) => path.startsWith('/etc/'))).toEqual([]);
  });
});

describe('EWP-CMD-CONFIG-TS02', () => {
  test('seven-layer tool selection replaces scalar and plural authority without merging', async () => {
    const system = '/system/config.toml';
    const user = '/config/skillsmith/config.toml';
    const project = '/repo/skillsmith.toml';
    const explicit = '/repo/explicit.toml';
    const fixture = memorySavePorts(system, 'tool = "codex"\n', { systemConfigPath: system });
    fixture.files.set(user, 'tool = "kilo-code"\n');
    fixture.files.set(
      project,
      'version = 1\n[defaults]\ntools = ["codex", "claude-code"]\nscope = "project"\n',
    );
    fixture.files.set(
      explicit,
      'version = 1\n[defaults]\ntools = ["opencode"]\nscope = "project"\n',
    );
    const base: ProjectContext = {
      invocationCwd: '/repo',
      effectiveCwd: '/repo',
      projectRoot: '/repo',
      projectIdentity: '/repo',
      projectKind: 'git',
      discoveredConfigPath: project,
      explicitConfigPath: explicit,
    };
    const select = (
      selectedContext: ProjectContext,
      environment: Record<string, string | undefined>,
      cli?: { readonly tools: readonly ['claude-code', 'opencode'] },
    ) =>
      resolveEffectiveConfig(fixture.ports, selectedContext, {
        configuration: resolveRuntimeConfiguration(environment),
        ...(cli === undefined ? {} : { cli }),
      });

    const cli = await select(
      base,
      { SKILLSMITH_TOOL: 'kilo-code' },
      {
        tools: ['claude-code', 'opencode'],
      },
    );
    expect(cli).toMatchObject({
      ok: true,
      value: {
        sources: { tool: 'cli' },
        toolSelection: {
          tools: ['claude-code', 'opencode'],
          source: 'cli',
          cardinality: 'plural',
        },
        layers: {
          defaults: {},
          system: { tool: 'codex' },
          user: { tool: 'kilo-code' },
          project: { tools: ['claude-code', 'codex'] },
          'explicit-file': { tool: 'opencode' },
          env: { tool: 'kilo-code' },
          cli: { tools: ['claude-code', 'opencode'] },
        },
      },
    });
    if (!cli.ok) throw new Error(JSON.stringify(cli.error));
    expect(cli.value.notices).toEqual([
      expect.objectContaining({ source: 'project', disposition: 'shadowed' }),
      expect.objectContaining({ source: 'cli', disposition: 'effective' }),
    ]);

    const envSelected = await select(base, { SKILLSMITH_TOOL: 'kilo-code' });
    expect(envSelected).toMatchObject({
      ok: true,
      value: { toolSelection: { tools: ['kilo-code'], source: 'env', cardinality: 'scalar' } },
    });
    const explicitSelected = await select(base, {});
    expect(explicitSelected).toMatchObject({
      ok: true,
      value: {
        toolSelection: { tools: ['opencode'], source: 'explicit-file', cardinality: 'scalar' },
      },
    });
    const projectOnly = { ...base, explicitConfigPath: null };
    expect(await select(projectOnly, {})).toMatchObject({
      ok: true,
      value: {
        toolSelection: {
          tools: ['claude-code', 'codex'],
          source: 'project',
          cardinality: 'plural',
        },
      },
    });
    const flatOnly = { ...projectOnly, discoveredConfigPath: null };
    expect(await select(flatOnly, {})).toMatchObject({
      ok: true,
      value: { toolSelection: { tools: ['kilo-code'], source: 'user', cardinality: 'scalar' } },
    });
    fixture.files.delete(user);
    expect(await select(flatOnly, {})).toMatchObject({
      ok: true,
      value: { toolSelection: { tools: ['codex'], source: 'system', cardinality: 'scalar' } },
    });
    fixture.files.delete(system);
    expect(await select(flatOnly, {})).toMatchObject({
      ok: true,
      value: { value: {}, sources: {}, layers: { defaults: {} } },
    });
  });

  test('a project plural selection replaces a lower user scalar and scalar get refuses lossless projection', async () => {
    const root = await sandbox('ts02-precedence');
    runGit(root, ['init', '--quiet']);
    await mkdir(join(root, 'xdg', 'skillsmith'), { recursive: true });
    await writeFile(join(root, 'xdg', 'skillsmith', 'config.toml'), 'tool = "kilo-code"\n');
    await writeFile(
      join(root, 'skillsmith.toml'),
      'version = 1\n\n[defaults]\ntools = ["codex", "claude-code"]\nscope = "project"\n',
    );

    const listed = await runCli(['config', 'list', '--json'], root, cliEnv(root));
    expect(listed.exitCode, listed.stderr).toBe(0);
    const report = JSON.parse(listed.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({ sources: { tool: 'project' } });
    expect(listed.stdout).toContain('"claude-code"');
    expect(listed.stdout).toContain('"codex"');
    expect(listed.stdout).toContain('"effective"');

    const got = await runCli(['config', 'get', 'tool', '--json'], root, cliEnv(root));
    expect(got.exitCode).toBe(2);
    expect(got.stderr).toBe('');
    expect(JSON.parse(got.stdout)).toMatchObject({ exitCode: 2 });
    expect(got.stdout).toContain('config list');
  });

  test('an operational list consumes both tools from the effective plural selection', async () => {
    const root = await sandbox('ts02-operational');
    runGit(root, ['init', '--quiet']);
    await Promise.all([
      mkdir(join(root, '.claude', 'skills', 'plural-claude'), { recursive: true }),
      mkdir(join(root, '.agents', 'skills', 'plural-codex'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, '.claude', 'skills', 'plural-claude', 'SKILL.md'),
        '---\nname: plural-claude\ndescription: fixture\n---\n',
      ),
      writeFile(
        join(root, '.agents', 'skills', 'plural-codex', 'SKILL.md'),
        '---\nname: plural-codex\ndescription: fixture\n---\n',
      ),
      writeFile(
        join(root, 'skillsmith.toml'),
        'version = 1\n\n[defaults]\ntools = ["claude-code", "codex"]\nscope = "project"\n',
      ),
    ]);

    const result = await runCli(['list', '--project', '--json'], root, cliEnv(root));
    expect(result.exitCode, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      readonly skills?: readonly { readonly name: string; readonly tool: string }[];
    };
    expect(
      (parsed.skills ?? [])
        .filter((item) => item.name.startsWith('plural-'))
        .map((item) => item.tool)
        .sort(),
    ).toEqual(['claude-code', 'codex']);
  });

  test('human scoped and effective lists render plural tools with truthful source warnings', async () => {
    const root = await sandbox('ts02-human-plural');
    runGit(root, ['init', '--quiet']);
    await writeFile(
      join(root, 'skillsmith.toml'),
      'version = 1\n[defaults]\ntools = ["codex", "claude-code"]\nscope = "project"\n',
    );
    const warning =
      'warning: effective plural tool selection from project; use config list to inspect every selected tool\n';

    const scoped = await runCli(['config', 'list', '--project'], root, cliEnv(root));
    expect(scoped).toEqual({
      exitCode: 0,
      stdout: 'tools = ["claude-code","codex"]\nscope = "project"\n',
      stderr: warning,
    });
    const effective = await runCli(['config', 'list'], root, cliEnv(root));
    expect(effective).toEqual({
      exitCode: 0,
      stdout:
        'tools = ["claude-code","codex"]    # source: project\nscope = "project"    # source: project\n',
      stderr: warning,
    });
  });
});

describe('EWP-CMD-CONFIG-TS03', () => {
  test('project set selects the nested manifest while the live project root remains the Git root', async () => {
    const root = await sandbox('ts03-nested');
    const nested = join(root, 'packages', 'api');
    const deep = join(nested, 'src');
    await mkdir(deep, { recursive: true });
    runGit(root, ['init', '--quiet']);
    const rootFile = join(root, 'skillsmith.toml');
    const nestedFile = join(nested, 'skillsmith.toml');
    const rootBefore = '# root owner\ntool = "kilo-code"\nscope = "project"\n';
    const nestedBefore = '# nested owner\ntool = "codex"\nscope = "project"\n';
    await writeFile(rootFile, rootBefore);
    await writeFile(nestedFile, nestedBefore);

    const context = await resolveProjectContext(
      await import('../../../core/src/ports/default.ts').then((m) => m.defaultRuntimePorts()),
      {
        invocationCwd: deep,
      },
    );
    expect(context.ok).toBeTrue();
    if (!context.ok) throw new Error(JSON.stringify(context.error));
    expect(context.value.projectRoot).toBe(root);
    expect(context.value.discoveredConfigPath).toBe(nestedFile);

    const result = await runCli(
      ['config', 'set', 'tool', 'opencode', '--scope', 'project'],
      deep,
      cliEnv(root),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(rootFile, 'utf8')).toBe(rootBefore);
    expect(await readFile(nestedFile, 'utf8')).toContain('version = 1');
    expect(await readFile(nestedFile, 'utf8')).toContain('opencode');
  });

  test('the same discovered and explicit path is classified once while retaining both roles', async () => {
    const path = '/repo/skillsmith.toml';
    let reads = 0;
    const env = {
      homeDir: '/home/test',
      executableSearchPath: [],
      platform: 'linux' as const,
      xdg: { config: '/config', data: '/data', cache: '/cache' },
      fileExists: async (candidate: string) => candidate === path,
      pathKind: async (candidate: string) =>
        candidate === path ? ('file' as const) : ('absent' as const),
      realpath: async (candidate: string) => candidate,
      listDir: async () => [],
      readText: async () => '',
      readBytes: async () => new Uint8Array(),
      readLink: async () => '',
      isExecutable: async () => false,
      modifiedAt: async () => null,
    };
    const project: ProjectContext = {
      invocationCwd: '/repo',
      effectiveCwd: '/repo',
      projectRoot: '/repo',
      projectIdentity: '/repo',
      projectKind: 'git',
      discoveredConfigPath: path,
      explicitConfigPath: path,
    };
    const result = await resolveEffectiveConfig(env, project, {
      configuration: resolveRuntimeConfiguration({}),
      readFile: async (candidate) => {
        reads += 1;
        expect(candidate).toBe(path);
        return 'tool = "codex"\n';
      },
    });

    expect(result.ok).toBeTrue();
    expect(reads).toBe(1);
    if (result.ok) {
      expect(result.value.paths).toMatchObject({ project: path, 'explicit-file': path });
    }
  });

  test('spawned --config and -C resolve one explicit layer from the effective cwd', async () => {
    const root = await sandbox('ts03-explicit-cd');
    const nested = join(root, 'packages', 'api');
    await mkdir(nested, { recursive: true });
    runGit(root, ['init', '--quiet']);
    await writeFile(
      join(root, 'skillsmith.toml'),
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n',
    );
    await writeFile(
      join(root, 'overrides.toml'),
      'version = 1\n[defaults]\ntools = ["opencode"]\nscope = "project"\n',
    );

    const result = await runCli(
      ['-C', 'packages/api', '--config', '../../overrides.toml', 'config', 'list', '--json'],
      root,
      cliEnv(root),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      effective: { tool: 'opencode', scope: 'project' },
      sources: { tool: 'explicit-file', scope: 'explicit-file' },
      layers: {
        project: { tool: 'codex' },
        'explicit-file': { tool: 'opencode' },
      },
    });
  });
});

describe('EWP-CMD-CONFIG-TS04', () => {
  test('exact-legacy reads expose migration metadata without changing bytes or mode', async () => {
    const root = await sandbox('ts04-read');
    runGit(root, ['init', '--quiet']);
    const file = join(root, 'skillsmith.toml');
    const source = '# retained owner\ntool = "codex"\nscope = "project"\npath = "./skills"\n';
    await writeFile(file, source);
    await chmod(file, 0o640);

    const result = await runCli(['config', 'list', '--json'], root, cliEnv(root));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('warning: legacy project config');
    expect(result.stderr).toContain('Phase 2');
    expect(result.stderr).toContain('config set or config unset');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      notices: [
        expect.objectContaining({
          code: 'legacy-project-config',
          path: file,
          migrationPending: true,
        }),
      ],
    });

    const scopedJson = await runCli(['config', 'list', '--project', '--json'], root, cliEnv(root));
    expect(scopedJson.exitCode).toBe(0);
    expect(scopedJson.stderr).toBe(result.stderr);
    expect(JSON.parse(scopedJson.stdout)).toMatchObject({
      tool: 'codex',
      scope: 'project',
      notices: [expect.objectContaining({ code: 'legacy-project-config', path: file })],
    });

    const human = await runCli(['config', 'get', 'tool', '--project'], root, cliEnv(root));
    expect(human).toEqual({ exitCode: 0, stdout: 'codex\n', stderr: result.stderr });
    expect(await readFile(file, 'utf8')).toBe(source);
    expect(await permissionBits(file)).toBe(0o640);
    expect(await unexpectedEntries(root, ['.git', 'cache', 'skillsmith.toml'])).toEqual([]);
  });

  test('missing-key unset performs one exact lossless legacy migration without a paired lock', async () => {
    const root = await sandbox('ts04-migrate');
    runGit(root, ['init', '--quiet']);
    const file = join(root, 'skillsmith.toml');
    const source = '# retained owner\ntool = "codex"\nscope = "project"\npath = "./skills"\n';
    const expected =
      '# retained owner\nversion = 1\n\n[defaults]\ntools = ["codex"]\nscope = "project"\npath = "./skills"\n';
    await writeFile(file, source);
    await chmod(file, 0o600);

    const result = await runCli(
      ['config', 'unset', 'registry.default', '--scope', 'project'],
      root,
      cliEnv(root),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`migrated project config and updated ${file}\n`);
    expect(await readFile(file, 'utf8')).toBe(expected);
    expect(await permissionBits(file)).toBe(0o600);
    expect(await unexpectedEntries(root, ['.git', 'cache', 'skillsmith.toml'])).toEqual([]);
  });

  test('legacy set reports visible migration in human and JSON operation channels', async () => {
    const root = await sandbox('ts04-visible-migration');
    runGit(root, ['init', '--quiet']);
    const file = join(root, 'skillsmith.toml');
    await writeFile(file, '# retained\ntool = "codex"\nscope = "project"\n');

    const human = await runCli(
      ['config', 'set', 'tool', 'opencode', '--project'],
      root,
      cliEnv(root),
    );
    expect(human).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: `migrated project config and wrote ${file}\n`,
    });

    await writeFile(file, '# retained\ntool = "codex"\nscope = "project"\n');
    const json = await runCli(
      ['config', 'set', 'tool', 'opencode', '--project', '--json'],
      root,
      cliEnv(root),
    );
    expect(json.exitCode, json.stderr).toBe(0);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout)).toEqual({
      key: 'tool',
      value: 'opencode',
      scope: 'project',
      file,
      operation: 'migrate-project-config',
    });
  });

  test('mixed, empty, malformed, unknown, future, and nonportable legacy shapes refuse as state', async () => {
    const cases = [
      ['mixed', 'version = 1\ntool = "codex"\n'],
      ['empty', ''],
      ['comment-only', '# no document\n'],
      ['malformed', 'tool = [\n'],
      ['unknown', 'mystery = true\n'],
      ['future', 'version = 2\n'],
      ['nonportable-legacy', 'tool = "codex"\npath = "/opt/shared/skills"\n'],
    ] as const;
    const observed: {
      label: string;
      exitCode: number;
      unchanged: boolean;
      modePreserved: boolean;
      unexpected: readonly string[];
    }[] = [];
    for (const [label, source] of cases) {
      const root = await sandbox(`ts04-shape-${label}`);
      runGit(root, ['init', '--quiet']);
      const file = join(root, 'skillsmith.toml');
      await writeFile(file, source);
      const modeBefore = await permissionBits(file);
      const result = await runCli(['config', 'list', '--json'], root, cliEnv(root));
      observed.push({
        label,
        exitCode: result.exitCode,
        unchanged: (await readFile(file, 'utf8')) === source,
        modePreserved: (await permissionBits(file)) === modeBefore,
        unexpected: await unexpectedEntries(root, ['.git', 'cache', 'skillsmith.toml']),
      });
    }
    expect(observed).toEqual(
      cases.map(([label]) => ({
        label,
        exitCode: 3,
        unchanged: true,
        modePreserved: true,
        unexpected: [],
      })),
    );
  });
});

describe('EWP-CMD-CONFIG-TS05', () => {
  test('named set and unset v1 codecs preserve the current compact JSON bytes', async () => {
    const modulePath = join(import.meta.dir, '../../../core/src/contracts/v1/config.ts');
    const contracts = (await import(modulePath)) as Record<string, unknown>;
    expect({
      configSetV1Codec: typeof contracts.configSetV1Codec,
      toConfigSetV1Dto: typeof contracts.toConfigSetV1Dto,
      configUnsetV1Codec: typeof contracts.configUnsetV1Codec,
      toConfigUnsetV1Dto: typeof contracts.toConfigUnsetV1Dto,
    }).toEqual({
      configSetV1Codec: 'object',
      toConfigSetV1Dto: 'function',
      configUnsetV1Codec: 'object',
      toConfigUnsetV1Dto: 'function',
    });

    const setCodec = contracts.configSetV1Codec as {
      encode(value: unknown): { readonly ok: boolean; readonly value?: string };
    };
    const unsetCodec = contracts.configUnsetV1Codec as {
      encode(value: unknown): { readonly ok: boolean; readonly value?: string };
    };
    expect(
      setCodec.encode({
        key: 'tool',
        value: 'codex',
        scope: 'user',
        file: '/config/skillsmith/config.toml',
      }),
    ).toEqual({
      ok: true,
      value:
        '{"key":"tool","value":"codex","scope":"user","file":"/config/skillsmith/config.toml"}\n',
    });
    expect(
      unsetCodec.encode({
        key: 'tool',
        scope: 'user',
        file: '/config/skillsmith/config.toml',
      }),
    ).toEqual({
      ok: true,
      value: '{"key":"tool","scope":"user","file":"/config/skillsmith/config.toml"}\n',
    });
    expect(
      setCodec.encode({
        key: 'tool',
        value: 'opencode',
        scope: 'project',
        file: '/repo/skillsmith.toml',
        operation: 'migrate-project-config',
      }),
    ).toEqual({
      ok: true,
      value:
        '{"key":"tool","value":"opencode","scope":"project","file":"/repo/skillsmith.toml","operation":"migrate-project-config"}\n',
    });
  });

  test('rename permission denial preserves the original and removes staged residue', async () => {
    const file = '/config/skillsmith/config.toml';
    const source = '# retained\ntool = "codex"\n';
    const fixture = memorySavePorts(file, source, { failRename: true });
    const result = await saveConfig(fixture.ports, {
      scope: 'user',
      patch: { tool: 'opencode' },
    });
    const staged = [...fixture.files.keys()].filter((path) => path !== file);
    const stagedModes = [...fixture.modes.keys()].filter((path) => path !== file);

    expect({
      ok: result.ok,
      code: result.ok ? null : result.error.code,
      original: fixture.files.get(file),
      originalMode: fixture.modes.get(file),
      staged,
      stagedModes,
    }).toEqual({
      ok: false,
      code: 'permission-denied',
      original: source,
      originalMode: 0o600,
      staged: [],
      stagedModes: [],
    });
  });

  test('unsafe registry credentials refuse before writing and never echo the canary', async () => {
    const root = await sandbox('ts05-canary');
    const canary = 'P17_TS05_CREDENTIAL_CANARY';
    const unsafe = `https://user:${canary}%40secret@github.com/acme?token=${canary}`;
    const result = await runCli(
      ['config', 'set', 'registry.default', unsafe, '--scope', 'user', '--json'],
      root,
      cliEnv(root),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    const error = JSON.parse(result.stdout) as {
      readonly code?: string;
      readonly exitCode?: number;
    };
    expect(error).toMatchObject({ exitCode: 2 });
    expect(typeof error.code).toBe('string');
    expect(error.code).not.toBe('commander.unknownOption');
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(
      await readFile(join(root, 'xdg', 'skillsmith', 'config.toml'), 'utf8').catch(() => null),
    ).toBeNull();
  });

  test('unset registers JSON output and emits its named compact v1 document', async () => {
    const root = await sandbox('ts05-unset-json');
    const directory = join(root, 'xdg', 'skillsmith');
    const file = join(directory, 'config.toml');
    await mkdir(directory, { recursive: true });
    await writeFile(file, 'tool = "codex"\n');

    const result = await runCli(
      ['config', 'unset', 'tool', '--scope', 'user', '--json'],
      root,
      cliEnv(root),
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${JSON.stringify({ key: 'tool', scope: 'user', file })}\n`);
  });

  test('stored unsafe registry credentials are state errors and never reach output', async () => {
    const root = await sandbox('ts05-stored-canary');
    const directory = join(root, 'xdg', 'skillsmith');
    const file = join(directory, 'config.toml');
    const canary = 'P17_TS05_STORED_CREDENTIAL_CANARY';
    const source = `[registry]\ndefault = "https://user:${canary}%40secret@github.com/acme?token=${canary}"\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(file, source);

    const result = await runCli(['config', 'list', '--json'], root, cliEnv(root));

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 3 });
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(await readFile(file, 'utf8')).toBe(source);
  });

  test('scope conflicts and invalid values preserve usage exits and human/JSON channel ownership', async () => {
    const root = await sandbox('ts05-usage-channels');
    const conflicts = [
      ['config', 'get', 'tool', '--scope', 'project', '--user', '--json'],
      ['config', 'set', 'tool', 'codex', '--scope', 'project', '--user', '--json'],
      ['config', 'list', '--scope', 'project', '--user', '--json'],
      ['config', 'unset', 'tool', '--scope', 'project', '--user', '--json'],
    ] as const;
    for (const args of conflicts) {
      const result = await runCli(args, root, cliEnv(root));
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 2 });
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
    }

    const human = await runCli(
      ['config', 'set', 'tool', 'future-tool', '--user'],
      root,
      cliEnv(root),
    );
    expect(human.exitCode).toBe(2);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('invalid value');
    expect(human.stderr.trim().split('\n')).toHaveLength(1);
    expect(
      await readFile(join(root, 'xdg', 'skillsmith', 'config.toml'), 'utf8').catch(() => null),
    ).toBeNull();
  });
});
