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

  test('does not mark non-project, absent, or empty/comment-only layers', async () => {
    const cases = [
      {
        files: { '/repo/team.toml': 'tool = "codex"\n' },
        project: null,
        explicit: '/repo/team.toml',
      },
      { files: {}, project: null, explicit: null },
      {
        files: { '/repo/skillsmith.toml': '# comments only\n' },
        project: '/repo/skillsmith.toml',
        explicit: null,
      },
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
});
