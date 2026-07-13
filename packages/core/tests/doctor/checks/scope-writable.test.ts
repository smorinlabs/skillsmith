import { describe, expect, test } from 'bun:test';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import { createScopeWritableCheck } from '../../../src/doctor/checks/scope-writable.ts';
import { focusDoctorPorts } from '../../../src/doctor/run.ts';
import type { CheckRunContext } from '../../../src/doctor/types.ts';
import { noopLogger } from '../../../src/env/logger.ts';
import type { PathKind, ScanEnv } from '../../../src/env/types.ts';
import { portError } from '../../../src/ports/errors.ts';
import { runtimePorts } from '../../fixtures/runtime-ports.ts';

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
  env: focusDoctorPorts(runtimePorts(fakeEnv(() => 'absent'))),
  mode: 'doctor',
  tools: ['claude-code'],
  scopes: ['user'],
  cwd: '/project',
  configuration: resolveRuntimeConfiguration({}),
  offline: true,
  logger: noopLogger,
  ...overrides,
});

const withAccess = (
  env: ScanEnv,
  assertWritableDirectory: CheckRunContext['env']['assertWritableDirectory'],
): CheckRunContext['env'] => focusDoctorPorts({ ...runtimePorts(env), assertWritableDirectory });

const denied = (uid = 501) =>
  portError({
    capability: 'path-access',
    operation: 'assertWritableDirectory',
    code: 'permission',
    message: 'permission denied',
    context: { uid },
  });

describe('scopeWritable', () => {
  test('probes the nearest existing ancestor without creating an absent root', async () => {
    const accessed: string[] = [];
    const made: string[] = [];
    const env = fakeEnv(
      (path) => (path === '/h' ? 'dir' : 'absent'),
      (path) => made.push(path),
    );
    const check = createScopeWritableCheck();

    const findings = await check.run(
      context({
        env: withAccess(env, async (path) => {
          accessed.push(path);
        }),
      }),
    );

    expect(findings).toEqual([]);
    expect(accessed).toEqual(['/h']);
    expect(made).toEqual([]);
  });

  test('reports structured context for an existing root that is not writable', async () => {
    const root = '/h/.claude/skills';
    const env = fakeEnv((path) => (path === root ? 'dir' : 'absent'));
    const check = createScopeWritableCheck();

    const findings = await check.run(
      context({
        env: withAccess(env, async () => {
          throw denied();
        }),
      }),
    );

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
    const check = createScopeWritableCheck();

    const findings = await check.run(
      context({
        env: withAccess(env, async () => {
          throw denied();
        }),
        tools: ['codex'],
        scopes: ['system'],
        scopeExplicit: false,
      }),
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
    const check = createScopeWritableCheck();

    const findings = await check.run(
      context({
        env: withAccess(env, async () => {
          throw new Error('permission denied');
        }),
        tools: ['codex'],
        scopes: ['system'],
        scopeExplicit: true,
      }),
    );

    expect(findings[0]?.severity).toBe('error');
  });

  test('keeps privileged-scope failures actionable for older callers without scope metadata', async () => {
    const env = fakeEnv((path) => (path === '/etc' ? 'dir' : 'absent'));
    const check = createScopeWritableCheck();

    const findings = await check.run(
      context({
        env: withAccess(env, async () => {
          throw new Error('permission denied');
        }),
        tools: ['codex'],
        scopes: ['system'],
      }),
    );

    expect(findings[0]?.severity).toBe('error');
  });

  test('rejects an existing writable file in place of the skill root', async () => {
    const root = '/h/.claude/skills';
    const accessed: string[] = [];
    const env = fakeEnv((path) => (path === root ? 'file' : 'absent'));
    const check = createScopeWritableCheck();

    const findings = await check.run(
      context({
        env: withAccess(env, async (path) => {
          accessed.push(path);
        }),
      }),
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        operation: `inspect ${JSON.stringify(root)} as a directory`,
        message: expect.stringContaining('expected a directory, found file'),
      }),
    ]);
    expect(accessed).toEqual([]);
  });

  test('rejects a writable file as the nearest existing ancestor', async () => {
    const ancestor = '/h/.claude';
    const accessed: string[] = [];
    const env = fakeEnv((path) => (path === ancestor ? 'file' : 'absent'));
    const check = createScopeWritableCheck();

    const findings = await check.run(
      context({
        env: withAccess(env, async (path) => {
          accessed.push(path);
        }),
      }),
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        operation: `inspect ${JSON.stringify(ancestor)} as a directory`,
        message: expect.stringContaining('expected a directory, found file'),
      }),
    ]);
    expect(accessed).toEqual([]);
  });
});
