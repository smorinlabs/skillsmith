import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECK_EXIT_CODE_DEPRECATION,
  CURRENT_READ_APPLICATIONS,
  type CurrentReadApplicationRegistry,
  runAgentsApplication,
  runCheckApplication,
  runCommandsApplication,
  runConfigGetApplication,
  runConfigListApplication,
  runConfigSetApplication,
  runConfigUnsetApplication,
  runDoctorApplication,
  runListApplication,
  runVerifyApplication,
} from '../../src/application/read-services.ts';
import type {
  CurrentApplicationContext,
  CurrentCommandRequest,
  InteractionPort,
} from '../../src/application/types.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import type { EffectiveConfig } from '../../src/config/types.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import type { ScanEnv } from '../../src/env/types.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import { runtimePorts } from '../fixtures/runtime-ports.ts';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

const env = (root = '/h', overrides: Partial<ScanEnv> = {}): ScanEnv => ({
  homeDir: root,
  path: [],
  platform: 'linux',
  xdg: {
    config: join(root, '.config'),
    data: join(root, '.local', 'share'),
    cache: join(root, '.cache'),
  },
  fileExists: async () => false,
  realpath: async (path) => path,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }),
  pathKind: async () => 'absent',
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
  withFileLock: (_path, operation) => operation(),
  modifiedAt: async () => null,
  ...overrides,
});

const projectContext = (cwd = '/project'): ProjectContext => ({
  invocationCwd: cwd,
  effectiveCwd: cwd,
  projectRoot: cwd,
  projectIdentity: cwd,
  projectKind: 'git',
  discoveredConfigPath: null,
  explicitConfigPath: null,
});

const effectiveConfig = (value: EffectiveConfig['value'] = {}): EffectiveConfig => ({
  value,
  sources: value.tool === undefined ? {} : { tool: 'user' },
  layers: {
    defaults: {},
    system: {},
    user: value,
    project: {},
    'explicit-file': {},
    env: {},
    cli: {},
  },
  paths: {},
});

const interaction: InteractionPort = {
  mode: 'noninteractive',
  choose: async () => ({ status: 'refused', reason: 'not used by read services' }),
  confirm: async () => ({ status: 'refused', reason: 'not used by read services' }),
};

const observation = Object.freeze({
  context: createOperationContext({
    command: 'skillsmith test',
    workflow: 'test',
    clock: {
      wallNowIso: () => '2026-01-01T00:00:00.000Z',
      monotonicMilliseconds: () => 0,
    },
    id: { nextId: () => 'test-operation' },
  }),
  emitter: createObservationEmitter({
    observer: noopObserver,
    toolIds: ['claude-code', 'codex', 'kilo-code', 'opencode'],
  }),
});

const context = (
  scanEnv = env(),
  config: EffectiveConfig = effectiveConfig(),
  project: ProjectContext = projectContext(),
): CurrentApplicationContext => ({
  observation,
  ports: runtimePorts(scanEnv),
  configuration: resolveRuntimeConfiguration({}),
  interaction,
  invocationCwd: project.invocationCwd,
  globalOptions: {},
  projectContext: project,
  effectiveConfig: config,
});

const request = (
  arguments_: readonly unknown[] = [],
  options: Readonly<Record<string, unknown>> = {},
): CurrentCommandRequest => ({ arguments: arguments_, options });

const poisonedContext = (): CurrentApplicationContext =>
  new Proxy({} as CurrentApplicationContext, {
    get: (_target, property) => {
      throw new Error(`unexpected context access: ${String(property)}`);
    },
  });

describe('current read application registry', () => {
  test('closes every assigned command spec over typed services', () => {
    const registry: CurrentReadApplicationRegistry = CURRENT_READ_APPLICATIONS;
    expect(Object.keys(registry)).toEqual([
      'agents',
      'configGet',
      'configSet',
      'configList',
      'configUnset',
      'list',
      'commands',
      'doctor',
      'check',
      'verify',
    ]);
    expect(Object.isFrozen(registry)).toBeTrue();
    expect(registry.agents).toBe(runAgentsApplication);
    expect(registry.configGet).toBe(runConfigGetApplication);
    expect(registry.configSet).toBe(runConfigSetApplication);
    expect(registry.configList).toBe(runConfigListApplication);
    expect(registry.configUnset).toBe(runConfigUnsetApplication);
    expect(registry.list).toBe(runListApplication);
    expect(registry.commands).toBe(runCommandsApplication);
    expect(registry.check).toBe(runCheckApplication);
    expect(registry.verify).toBe(runVerifyApplication);
  });

  test('source has no CLI runtime or environment construction dependency', async () => {
    const source = await readFile(
      join(import.meta.dir, '../../src/application/read-services.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/@skillsmith\/cli|commander|defaultScanEnv|\bprocess\b/);
    expect(source).not.toMatch(/render[A-Z]|stdout|stderr|stdin|exitCode\s*:/);
  });
});

describe('validation happens before discovery or effects', () => {
  test('unknown agents tool is a semantic usage/capability outcome', async () => {
    const outcome = await runAgentsApplication(
      request([], { tool: ['future-tool'] }),
      poisonedContext(),
    );
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.diagnostics[0]?.code).toBe('invalid-enum');
  });

  test('config validation does not resolve project state', async () => {
    const get = await runConfigGetApplication(request(['future.key']), poisonedContext());
    const set = await runConfigSetApplication(request(['tool', 'future-tool']), poisonedContext());
    expect(get.exitClass).toBe('usage');
    expect(get.diagnostics[0]?.message).toContain('unknown config key');
    expect(set.exitClass).toBe('usage');
    expect(set.diagnostics[0]?.message).toContain('invalid value');
  });

  test('cross-option relations fail before environment access', async () => {
    const list = await runListApplication(
      request([], { enabled: true, disabled: true }),
      poisonedContext(),
    );
    const check = await runCheckApplication(
      request([], { reportOnly: true, exitCode: true }),
      poisonedContext(),
    );
    const verify = await runVerifyApplication(
      request(['/plugin'], { static: true, deep: true }),
      poisonedContext(),
    );
    const doctor = await runDoctorApplication(request([], { scope: 'managed' }), poisonedContext());
    expect([list.exitClass, check.exitClass, verify.exitClass, doctor.exitClass]).toEqual([
      'usage',
      'usage',
      'usage',
      'capability',
    ]);
  });
});

describe('read and config outcomes', () => {
  test('agents, list, and commands return structured no-mutation reports', async () => {
    const current = context(env(), effectiveConfig({ tool: 'codex' }));
    const [agents, skills, commands] = await Promise.all([
      runAgentsApplication(request([], { detectedOnly: true }), current),
      runListApplication(request([[]], { long: true }), current),
      runCommandsApplication(request([[]]), current),
    ]);
    expect(agents.exitClass).toBe('success');
    expect(agents.report.detectedOnly).toBeTrue();
    expect([...agents.report.detections.keys()]).toEqual([
      'claude-code',
      'codex',
      'kilo-code',
      'opencode',
    ]);
    expect(skills.report).toEqual({ entries: [], long: true });
    expect(commands.report).toEqual({ entries: [], long: false });
    expect([agents.mutation.kind, skills.mutation.kind, commands.mutation.kind]).toEqual([
      'none',
      'none',
      'none',
    ]);
  });

  test('config get/list preserve effective values, sources, and notices', async () => {
    const config: EffectiveConfig = {
      ...effectiveConfig({ tool: 'codex' }),
      notices: [
        {
          code: 'legacy-project-config',
          path: '/project/skillsmith.toml',
          migrationPending: true,
          migrationPhase: 2,
        },
      ],
    };
    const current = context(env(), config);
    const get = await runConfigGetApplication(request(['tool']), current);
    const list = await runConfigListApplication(request(), current);
    expect(get.report).toEqual({ key: 'tool', value: 'codex', source: 'user' });
    expect(get.diagnostics[0]?.code).toBe('legacy-project-config');
    expect(list.report.effective).toEqual({ tool: 'codex' });
    expect(list.report.sources).toEqual({ tool: 'user' });
  });

  test('config set and unset report applied mutations and the touched file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-read-services-'));
    temporaryRoots.push(root);
    const current = context(env(root), effectiveConfig(), projectContext(root));
    const set = await runConfigSetApplication(
      request(['tool', 'codex'], { scope: 'user' }),
      current,
    );
    expect(set.exitClass).toBe('success');
    expect(set.report.file).toBe(join(root, '.config', 'skillsmith', 'config.toml'));
    expect(set.mutation).toEqual({
      kind: 'applied',
      planned: 1,
      changed: 1,
      unchanged: 0,
      failed: 0,
    });
    expect(await readFile(set.report.file as string, 'utf8')).toContain('tool = "codex"');

    const unset = await runConfigUnsetApplication(request(['tool'], { scope: 'user' }), current);
    expect(unset.exitClass).toBe('success');
    expect(unset.report.file).toBe(set.report.file);
    expect(unset.mutation.kind).toBe('applied');
    expect(await readFile(unset.report.file as string, 'utf8')).not.toContain('tool');
  });

  test('check deprecation remains semantic metadata', () => {
    expect(CHECK_EXIT_CODE_DEPRECATION).toEqual({
      spelling: '--exit-code',
      replacement: 'default check behavior',
      removalVersion: '2.0',
      message: '--exit-code is deprecated; check already fails on errors by default',
    });
    expect(Object.isFrozen(CHECK_EXIT_CODE_DEPRECATION)).toBeTrue();
  });
});
