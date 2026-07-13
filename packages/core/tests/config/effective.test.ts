import { describe, expect, test } from 'bun:test';
import { resolveEffectiveConfig } from '../../src/config/effective.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import type { ScanEnv } from '../../src/env/types.ts';
import { runtimePorts } from '../fixtures/runtime-ports.ts';

const context = (project: string | null, explicit: string | null = null): ProjectContext => ({
  invocationCwd: '/repo',
  effectiveCwd: '/repo',
  projectRoot: '/repo',
  projectIdentity: '/repo',
  projectKind: 'git',
  discoveredConfigPath: project,
  explicitConfigPath: explicit,
});

const fixture = (files: Readonly<Record<string, string>>) => {
  let writes = 0;
  const env: ScanEnv = {
    homeDir: '/home/test',
    path: [],
    platform: 'linux',
    xdg: { config: '/config', data: '/data', cache: '/cache' },
    fileExists: async (path) => Object.hasOwn(files, path),
    realpath: async (path) => path,
    listDir: async () => [],
    readText: async (path) => files[path] ?? '',
    runVersion: async () => 'unknown',
    exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    pathKind: async () => 'absent',
    isExecutable: async () => false,
    readBytes: async () => new Uint8Array(),
    readLink: async () => '',
    makeSymlink: async () => {
      writes += 1;
    },
    rename: async () => {
      writes += 1;
    },
    copyTree: async () => {
      writes += 1;
    },
    removeTree: async () => {
      writes += 1;
    },
    makeDir: async () => {
      writes += 1;
    },
    writeTextFile: async () => {
      writes += 1;
    },
    fsyncFile: async () => {
      writes += 1;
    },
    fsyncDir: async () => {
      writes += 1;
    },
    modifiedAt: async () => null,
    withFileLock: (_path, fn) => fn(),
  };
  return { env, writes: () => writes };
};

describe('resolveEffectiveConfig compatibility notices', () => {
  test('marks a nonempty discovered legacy project config without changing precedence or bytes', async () => {
    const projectPath = '/repo/skillsmith.toml';
    const source = '# retained\ntool = "codex"\nscope = "project"\n';
    const files: Record<string, string> = { [projectPath]: source };
    const { env, writes } = fixture(files);

    const result = await resolveEffectiveConfig(runtimePorts(env), context(projectPath), {
      cli: { tool: 'opencode' },
      configuration: resolveRuntimeConfiguration({ SKILLSMITH_SCOPE: 'user' }),
      readFile: async (path) => files[path] ?? '',
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.value).toMatchObject({ tool: 'opencode', scope: 'user' });
    expect(result.value.sources).toMatchObject({ tool: 'cli', scope: 'env' });
    expect(result.value.layers.project).toEqual({ tool: 'codex', scope: 'project' });
    expect(result.value.notices).toEqual([
      {
        code: 'legacy-project-config',
        path: projectPath,
        migrationPending: true,
        migrationPhase: 2,
      },
    ]);
    expect(files[projectPath]).toBe(source);
    expect(writes()).toBe(0);
  });

  test('does not mark non-project or absent layers', async () => {
    const cases = [
      {
        files: { '/repo/team.toml': 'tool = "codex"\n' },
        project: null,
        explicit: '/repo/team.toml',
      },
      { files: {}, project: null, explicit: null },
    ] as const;

    for (const item of cases) {
      const { env, writes } = fixture(item.files);
      const result = await resolveEffectiveConfig(
        runtimePorts(env),
        context(item.project, item.explicit),
        {
          configuration: resolveRuntimeConfiguration({}),
          readFile: async (path) => item.files[path as keyof typeof item.files] ?? '',
        },
      );
      expect(result.ok).toBeTrue();
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(result.value.notices).toBeUndefined();
      expect(writes()).toBe(0);
    }
  });

  test('rejects empty and comment-only project documents without effects', async () => {
    for (const source of ['', ' \n\t', '# comments only\n']) {
      const projectPath = '/repo/skillsmith.toml';
      const files = { [projectPath]: source };
      const { env, writes } = fixture(files);
      const result = await resolveEffectiveConfig(runtimePorts(env), context(projectPath), {
        configuration: resolveRuntimeConfiguration({}),
        readFile: async (path) => files[path as keyof typeof files] ?? '',
      });
      expect(result.ok, JSON.stringify(source)).toBeFalse();
      expect(writes()).toBe(0);
    }
  });

  test('keeps malformed discovered project config on the existing error path', async () => {
    const projectPath = '/repo/skillsmith.toml';
    const files: Record<string, string> = { [projectPath]: 'unknown = true\n' };
    const { env, writes } = fixture(files);

    const result = await resolveEffectiveConfig(runtimePorts(env), context(projectPath), {
      configuration: resolveRuntimeConfiguration({}),
      readFile: async (path) => files[path] ?? '',
    });

    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error('expected config error');
    expect(result.error).toMatchObject({ code: 'config-error', file: projectPath });
    expect(writes()).toBe(0);
  });

  test('replaces scalar and plural tool selections by layer and reports effective and shadowed sources', async () => {
    const projectPath = '/repo/skillsmith.toml';
    const explicitPath = '/repo/team.toml';
    const files: Record<string, string> = {
      '/config/skillsmith/config.toml': 'tool = "kilo-code"\n',
      [projectPath]:
        'version = 1\n[defaults]\ntools = ["codex", "claude-code"]\nscope = "project"\n',
      [explicitPath]: 'version = 1\n[defaults]\ntools = ["opencode", "kilo-code"]\n',
    };
    const { env } = fixture(files);
    const result = await resolveEffectiveConfig(
      runtimePorts(env),
      context(projectPath, explicitPath),
      {
        configuration: resolveRuntimeConfiguration({ SKILLSMITH_TOOL: 'codex' }),
        readFile: async (path) => files[path] ?? '',
      },
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.value).toEqual({ tool: 'codex', scope: 'project' });
    expect(result.value.toolSelection).toEqual({
      tools: ['codex'],
      source: 'env',
      cardinality: 'scalar',
    });
    expect(result.value.notices).toContainEqual({
      code: 'plural-tool-selection',
      path: projectPath,
      tools: ['claude-code', 'codex'],
      source: 'project',
      disposition: 'shadowed',
    });
    expect(result.value.notices).toContainEqual({
      code: 'plural-tool-selection',
      path: explicitPath,
      tools: ['kilo-code', 'opencode'],
      source: 'explicit-file',
      disposition: 'shadowed',
    });
  });

  test('reads one shared discovered/explicit path once while retaining both roles', async () => {
    const path = '/repo/skillsmith.toml';
    const source = 'tool = "codex"\n';
    const { env } = fixture({ [path]: source });
    let reads = 0;
    let existenceChecks = 0;
    const ports = runtimePorts(env);
    const result = await resolveEffectiveConfig(
      {
        ...ports,
        fileExists: async (candidate) => {
          if (candidate === path) existenceChecks += 1;
          return ports.fileExists(candidate);
        },
      },
      context(path, path),
      {
        configuration: resolveRuntimeConfiguration({}),
        readFile: async () => {
          reads += 1;
          return source;
        },
      },
    );
    expect(result.ok).toBeTrue();
    expect(reads).toBe(1);
    expect(existenceChecks).toBe(1);
    if (result.ok) {
      expect(result.value.paths).toMatchObject({ project: path, 'explicit-file': path });
    }
  });

  test('drops an unsafe registry environment value before effective precedence', async () => {
    const { env } = fixture({});
    const result = await resolveEffectiveConfig(runtimePorts(env), context(null), {
      configuration: resolveRuntimeConfiguration({
        SKILLSMITH_REGISTRY: 'https://user:P17_ENV_SECRET@github.com/acme',
      }),
    });
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value.value.registry).toBeUndefined();
      expect(result.value.layers.env.registry).toBeUndefined();
      expect(result.value.sources['registry.default']).toBeUndefined();
    }
  });
});
