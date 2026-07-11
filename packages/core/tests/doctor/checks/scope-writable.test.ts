import { describe, expect, test } from 'bun:test';
import { constants } from 'node:fs';
import { createScopeWritableCheck } from '../../../src/doctor/checks/scope-writable.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';
import type { PathKind, ScanEnv } from '../../../src/env/types.ts';

const fakeEnv = (
  pathKind: (path: string) => PathKind,
  onMakeDir: (path: string) => void = () => {},
): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async () => false,
  realpath: async (path) => path,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  pathKind: async (path) => pathKind(path),
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async (path) => onMakeDir(path),
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  withFileLock: (_path, fn) => fn(),
  modifiedAt: async () => null,
});

const context = (overrides: Partial<CheckRunContext> = {}): CheckRunContext => ({
  env: fakeEnv(() => 'absent'),
  mode: 'doctor',
  tools: ['claude-code'],
  scopes: ['user'],
  cwd: '/project',
  envVars: {},
  offline: true,
  logger: noopLogger,
  ...overrides,
});

describe('scopeWritable', () => {
  test('probes the nearest existing ancestor without creating an absent root', async () => {
    const accessed: { path: string; mode: number }[] = [];
    const made: string[] = [];
    const env = fakeEnv(
      (path) => (path === '/h' ? 'dir' : 'absent'),
      (path) => made.push(path),
    );
    const check = createScopeWritableCheck(async (path, mode) => {
      accessed.push({ path, mode });
    });

    const findings = await check.run(context({ env }));

    expect(findings).toEqual([]);
    expect(accessed).toEqual([{ path: '/h', mode: constants.W_OK | constants.X_OK }]);
    expect(made).toEqual([]);
  });

  test('reports structured context for an existing root that is not writable', async () => {
    const root = '/h/.claude/skills';
    const env = fakeEnv((path) => (path === root ? 'dir' : 'absent'));
    const check = createScopeWritableCheck(
      async () => {
        throw new Error('permission denied');
      },
      () => 501,
    );

    const findings = await check.run(context({ env }));

    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        tool: 'claude-code',
        scope: 'user',
        path: root,
        operation: `access(${JSON.stringify(root)}, W_OK | X_OK) as uid 501`,
        reason: 'checks whether SkillSmith can install or update skills in this scope',
        scopeInUse: true,
      }),
    ]);
  });

  test('treats an expected privileged-scope failure as informational in a default sweep', async () => {
    const env = fakeEnv((path) => (path === '/etc' ? 'dir' : 'absent'));
    const check = createScopeWritableCheck(
      async () => {
        throw new Error('permission denied');
      },
      () => 501,
    );

    const findings = await check.run(
      context({ env, tools: ['codex'], scopes: ['system'], scopeExplicit: false }),
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'info',
        scope: 'system',
        path: '/etc/codex/skills',
        operation: 'access("/etc", W_OK | X_OK) as uid 501',
        scopeInUse: false,
      }),
    ]);
  });

  test('keeps an explicitly requested privileged-scope failure actionable', async () => {
    const env = fakeEnv((path) => (path === '/etc' ? 'dir' : 'absent'));
    const check = createScopeWritableCheck(async () => {
      throw new Error('permission denied');
    });

    const findings = await check.run(
      context({ env, tools: ['codex'], scopes: ['system'], scopeExplicit: true }),
    );

    expect(findings[0]?.severity).toBe('error');
  });

  test('keeps privileged-scope failures actionable for older callers without scope metadata', async () => {
    const env = fakeEnv((path) => (path === '/etc' ? 'dir' : 'absent'));
    const check = createScopeWritableCheck(async () => {
      throw new Error('permission denied');
    });

    const findings = await check.run(context({ env, tools: ['codex'], scopes: ['system'] }));

    expect(findings[0]?.severity).toBe('error');
  });
});
