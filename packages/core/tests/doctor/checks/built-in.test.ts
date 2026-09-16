import { describe, expect, test } from 'bun:test';
import { legacyInstall } from '../../../src/doctor/checks/legacy-install.ts';
import { multiInstall } from '../../../src/doctor/checks/multi-install.ts';
import { networkReach } from '../../../src/doctor/checks/network-reach.ts';
import { xdgPaths } from '../../../src/doctor/checks/xdg-paths.ts';
import { builtInChecks } from '../../../src/doctor/registry.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const baseEnv: ScanEnv = {
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async () => false,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async () => {},
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  modifiedAt: async () => null,
  withFileLock: (_p, fn) => fn(),
};

const baseCtx: CheckRunContext = {
  env: baseEnv,
  mode: 'doctor',
  tools: [],
  scopes: [],
  cwd: '/p',
  envVars: {},
  offline: true,
  logger: noopLogger,
};

describe('builtInChecks registry', () => {
  test('contains all 8 checks', () => {
    const ids = builtInChecks.map((c) => c.id).sort();
    expect(ids).toEqual([
      'config-parse',
      'cross-scope-duplicate',
      'legacy-install',
      'multi-install',
      'network-reach',
      'scope-writable',
      'tool-detected',
      'xdg-paths',
    ]);
  });
});

describe('xdgPaths', () => {
  test('all xdg dirs set → no findings', async () => {
    expect(await xdgPaths.run(baseCtx)).toEqual([]);
  });
  test('empty config → error finding', async () => {
    const ctx = { ...baseCtx, env: { ...baseEnv, xdg: { config: '', data: '/d', cache: '/c' } } };
    const findings = await xdgPaths.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
  });
});

describe('multiInstall', () => {
  test('no tools given → no findings', async () => {
    expect(await multiInstall.run(baseCtx)).toEqual([]);
  });
});

describe('legacyInstall', () => {
  test.each([
    { entries: ['.system'], protectedSystem: true, expected: 0 },
    { entries: ['.system', 'user-skill'], protectedSystem: true, expected: 1 },
    { entries: ['.system'], protectedSystem: false, expected: 1 },
    { entries: ['.codex-system-skills.marker'], protectedSystem: false, expected: 0 },
  ])('managed legacy entries: %j', async ({ entries, protectedSystem, expected }) => {
    const legacy = '/custom-codex/skills';
    const ctx: CheckRunContext = {
      ...baseCtx,
      tools: ['codex'],
      envVars: { CODEX_HOME: '/custom-codex' },
      env: {
        ...baseEnv,
        fileExists: async (path) =>
          path === legacy ||
          (protectedSystem && path === `${legacy}/.system/.codex-system-skills.marker`),
        listDir: async (path) => (path === legacy ? entries : []),
      },
    };
    expect(await legacyInstall.run(ctx)).toHaveLength(expected);
  });

  test('no Codex legacy dir → no findings', async () => {
    const ctx: CheckRunContext = { ...baseCtx, tools: ['codex'] };
    expect(await legacyInstall.run(ctx)).toEqual([]);
  });

  test('populated Codex legacy dir → one warning', async () => {
    const env: ScanEnv = {
      ...baseEnv,
      fileExists: async (p) => p === '/h/.codex/skills',
      listDir: async (p) => (p === '/h/.codex/skills' ? ['foo'] : []),
    };
    const ctx: CheckRunContext = { ...baseCtx, env, tools: ['codex'] };
    const findings = await legacyInstall.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.tool).toBe('codex');
  });
});

describe('networkReach', () => {
  test('offline → skipped, no findings', async () => {
    expect(await networkReach.run(baseCtx)).toEqual([]);
  });
});
