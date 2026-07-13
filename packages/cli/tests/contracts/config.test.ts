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
  options: { readonly failRename?: boolean } = {},
) => {
  const files = new Map<string, string>([[file, source]]);
  const modes = new Map<string, number>([[file, 0o600]]);
  const mutations: string[] = [];
  const ports = {
    homeDir: '/home/test',
    executableSearchPath: [],
    platform: 'linux' as const,
    xdg: { config: '/config', data: '/data', cache: '/cache' },
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
});

describe('EWP-CMD-CONFIG-TS02', () => {
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
      mkdir(join(root, '.codex', 'skills', 'plural-codex'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, '.claude', 'skills', 'plural-claude', 'SKILL.md'),
        '---\nname: plural-claude\ndescription: fixture\n---\n',
      ),
      writeFile(
        join(root, '.codex', 'skills', 'plural-codex', 'SKILL.md'),
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
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      notices: [
        expect.objectContaining({
          code: 'legacy-project-config',
          path: file,
          migrationPending: true,
        }),
      ],
    });
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
    expect(await readFile(file, 'utf8')).toBe(expected);
    expect(await permissionBits(file)).toBe(0o600);
    expect(await unexpectedEntries(root, ['.git', 'cache', 'skillsmith.toml'])).toEqual([]);
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
});
