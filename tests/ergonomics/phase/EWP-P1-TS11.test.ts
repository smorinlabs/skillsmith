import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { buildProgram } from '../../../packages/cli/src/program.ts';
import { createCliRuntimeAdapter } from '../../../packages/cli/src/runtime/adapter.ts';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/registry.ts';
import { validateOptionInvocation } from '../../../packages/cli/src/spec/relations.ts';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { resolveRuntimeConfiguration } from '../../../packages/core/src/config/runtime.ts';
import { crossScopeDuplicate } from '../../../packages/core/src/doctor/checks/cross-scope-duplicate.ts';
import { runChecks } from '../../../packages/core/src/doctor/run.ts';
import { genericError } from '../../../packages/core/src/errors.ts';
import { defaultRuntimePorts } from '../../../packages/core/src/ports/default.ts';
import { err, ok } from '../../../packages/core/src/result.ts';
import { detectAll } from '../../../packages/core/src/scan/index.ts';
import { listCommands } from '../../../packages/core/src/scan/list-commands.ts';
import { listSkills } from '../../../packages/core/src/scan/list-skills.ts';
import { runVerify } from '../../../packages/core/src/verify/run.ts';
import type { ToolVerifier } from '../../../packages/core/src/verify/types.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const OBSERVATION_ROOT = join(ROOT, 'packages/core/src/observation');
const OBSERVATION_INDEX = join(OBSERVATION_ROOT, 'index.ts');
const DIAGNOSTICS_MODULE = join(ROOT, 'packages/cli/src/runtime/diagnostics.ts');
const VERIFY_FIXTURE = join(ROOT, 'packages/core/tests/fixtures/verify/dummytest');

const EVENT_KINDS = [
  'command.started',
  'command.completed',
  'plan.created',
  'operation.started',
  'operation.completed',
  'tool.detection.started',
  'tool.detection.completed',
  'tool.verification.started',
  'tool.verification.completed',
  'transaction.stage.started',
  'transaction.stage.completed',
  'transaction.committed',
  'transaction.rolled-back',
  'recovery.started',
  'recovery.completed',
] as const;

const OPERATION_KINDS = [
  'inventory',
  'diagnostics',
  'install',
  'update',
  'remove',
  'link-dev',
  'promote',
  'move-scope',
  'adapt',
  'repair',
  'write-manifest',
  'write-lock',
  'migrate-project-config',
  'migrate-ledger',
] as const;

const COMMON_KEYS = [
  'kind',
  'operationId',
  'parentOperationId',
  'command',
  'workflow',
  'groupId',
  'pairId',
  'attempt',
  'occurredAt',
  'monotonicMilliseconds',
] as const;

const PAYLOAD_KEYS: Readonly<Record<(typeof EVENT_KINDS)[number], readonly string[]>> = {
  'command.started': [],
  'command.completed': ['outcome', 'exitClass', 'errorCode', 'durationMilliseconds'],
  'plan.created': ['planId', 'operationCount'],
  'operation.started': ['operationKind'],
  'operation.completed': [
    'operationKind',
    'outcome',
    'errorCode',
    'standaloneCount',
    'bundledCount',
    'resultCount',
    'durationMilliseconds',
  ],
  'tool.detection.started': ['toolId'],
  'tool.detection.completed': [
    'toolId',
    'outcome',
    'errorCode',
    'resultCount',
    'durationMilliseconds',
  ],
  'tool.verification.started': ['toolId', 'modes'],
  'tool.verification.completed': [
    'toolId',
    'modes',
    'verdict',
    'errorCode',
    'durationMilliseconds',
  ],
  'transaction.stage.started': ['transactionId', 'stage'],
  'transaction.stage.completed': [
    'transactionId',
    'stage',
    'outcome',
    'errorCode',
    'durationMilliseconds',
  ],
  'transaction.committed': ['transactionId', 'durationMilliseconds'],
  'transaction.rolled-back': ['transactionId', 'reasonCode', 'durationMilliseconds'],
  'recovery.started': ['transactionId', 'recoveryKind'],
  'recovery.completed': [
    'transactionId',
    'recoveryKind',
    'outcome',
    'errorCode',
    'durationMilliseconds',
  ],
};

type UnknownRecord = Record<PropertyKey, unknown>;
type ObservationModule = UnknownRecord & {
  OBSERVATION_EVENT_KINDS?: readonly string[];
  OPERATION_KINDS?: readonly string[];
};

const record = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const callable = (value: unknown): ((...args: unknown[]) => unknown) | null =>
  typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null;

const importMaybe = async (path: string, query: string): Promise<UnknownRecord | null> => {
  try {
    await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return (await import(`${pathToFileURL(path).href}?${query}`)) as UnknownRecord;
  } catch (error) {
    throw new Error(`failed to import ${relative(ROOT, path)}: ${String(error)}`);
  }
};

const observationAuthority = async (query: string): Promise<ObservationModule | null> => {
  const loaded = (await importMaybe(OBSERVATION_INDEX, query)) as ObservationModule | null;
  expect(loaded, 'missing public core observation authority').not.toBeNull();
  return loaded;
};

const runCli = async (args: readonly string[], env: Record<string, string | undefined> = {}) => {
  const child = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd: ROOT,
    env: hermeticGitEnv({
      CI: '1',
      NO_COLOR: '1',
      HOME: join(ROOT, 'tests/ergonomics/fixtures/p1-ts11/home'),
      XDG_CONFIG_HOME: join(ROOT, 'tests/ergonomics/fixtures/p1-ts11/xdg/config'),
      XDG_DATA_HOME: join(ROOT, 'tests/ergonomics/fixtures/p1-ts11/xdg/data'),
      XDG_CACHE_HOME: '/tmp/skillsmith-p17-ts11-cache',
      SKILLSMITH_HOME: join(ROOT, 'tests/ergonomics/fixtures/p1-ts11/skillsmith-home'),
      CODEX_HOME: join(ROOT, 'tests/ergonomics/fixtures/p1-ts11/codex-home'),
      ...env,
    }),
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

const detectionEnv = () => ({
  homeDir: '/home/test',
  executableSearchPath: [] as string[],
  platform: 'linux' as const,
  xdg: { config: '/config', data: '/data', cache: '/cache' },
  fileExists: async () => false,
  realpath: async (path: string) => path,
  listDir: async () => [],
  readText: async () => '',
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  modifiedAt: async () => null,
  runVersion: async () => '9.9.9',
});

const typescriptFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat().sort();
};

const makeContext = (
  authority: ObservationModule,
  overrides: Partial<{ command: string; workflow: string; operationId: string }> = {},
) => {
  let wall = '2026-07-13T00:00:00.000Z';
  let mono = 10;
  const idPurposes: string[] = [];
  const clock = {
    wallNowIso: () => wall,
    monotonicMilliseconds: () => mono,
  };
  const id = {
    nextId: (purpose: string) => {
      idPurposes.push(purpose);
      return `operation-${idPurposes.length}`;
    },
  };
  const create = callable(authority.createOperationContext);
  expect(create, 'missing createOperationContext').not.toBeNull();
  const context = create?.({
    command: overrides.command ?? 'skillsmith fixture',
    workflow: overrides.workflow ?? 'fixture',
    clock,
    id,
    ...(overrides.operationId === undefined ? {} : { operationId: overrides.operationId }),
  }) as UnknownRecord | undefined;
  return {
    context,
    clock,
    id,
    idPurposes,
    setTime: (nextWall: string, nextMono: number) => {
      wall = nextWall;
      mono = nextMono;
    },
  };
};

const eventInputs = (): Readonly<Record<(typeof EVENT_KINDS)[number], UnknownRecord>> => ({
  'command.started': { kind: 'command.started' },
  'command.completed': {
    kind: 'command.completed',
    outcome: 'success',
    exitClass: 'success',
    errorCode: null,
    durationMilliseconds: 1,
  },
  'plan.created': { kind: 'plan.created', planId: 'plan-1', operationCount: 1 },
  'operation.started': { kind: 'operation.started', operationKind: 'inventory' },
  'operation.completed': {
    kind: 'operation.completed',
    operationKind: 'inventory',
    outcome: 'success',
    errorCode: null,
    standaloneCount: 1,
    bundledCount: 0,
    resultCount: 1,
    durationMilliseconds: 1,
  },
  'tool.detection.started': { kind: 'tool.detection.started', toolId: 'fixture-tool' },
  'tool.detection.completed': {
    kind: 'tool.detection.completed',
    toolId: 'fixture-tool',
    outcome: 'success',
    errorCode: null,
    resultCount: 1,
    durationMilliseconds: 1,
  },
  'tool.verification.started': {
    kind: 'tool.verification.started',
    toolId: 'fixture-tool',
    modes: ['static', 'deep'],
  },
  'tool.verification.completed': {
    kind: 'tool.verification.completed',
    toolId: 'fixture-tool',
    modes: ['static', 'deep'],
    verdict: 'pass',
    errorCode: null,
    durationMilliseconds: 1,
  },
  'transaction.stage.started': {
    kind: 'transaction.stage.started',
    transactionId: 'transaction-1',
    stage: 'prepared',
  },
  'transaction.stage.completed': {
    kind: 'transaction.stage.completed',
    transactionId: 'transaction-1',
    stage: 'prepared',
    outcome: 'success',
    errorCode: null,
    durationMilliseconds: 1,
  },
  'transaction.committed': {
    kind: 'transaction.committed',
    transactionId: 'transaction-1',
    durationMilliseconds: 1,
  },
  'transaction.rolled-back': {
    kind: 'transaction.rolled-back',
    transactionId: 'transaction-1',
    reasonCode: 'fixture-reason',
    durationMilliseconds: 1,
  },
  'recovery.started': {
    kind: 'recovery.started',
    transactionId: 'transaction-1',
    recoveryKind: 'resume',
  },
  'recovery.completed': {
    kind: 'recovery.completed',
    transactionId: 'transaction-1',
    recoveryKind: 'resume',
    outcome: 'success',
    errorCode: null,
    durationMilliseconds: 1,
  },
});

describe('EWP-P1-TS11', () => {
  test('characterization: preserves current normal bytes and declared option/conflict inventory', async () => {
    const root = CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith');
    expect(root?.options.map((option) => [option.long, option.short, option.repeatable])).toEqual([
      ['--color', null, false],
      ['--config', null, false],
      ['--debug', null, false],
      ['--no-color', null, false],
      ['--no-prompt', null, false],
      ['--cd', '-C', false],
      ['--help', '-h', false],
      ['--quiet', '-q', false],
      ['--verbose', '-v', true],
      ['--version', '-V', false],
    ]);
    expect(validateOptionInvocation('skillsmith', ['-q', '-v']).ok).toBeFalse();
    expect(validateOptionInvocation('skillsmith', ['-q', '--debug']).ok).toBeFalse();
    expect(validateOptionInvocation('skillsmith', ['-vv', '--debug']).ok).toBeTrue();
    const [explicitVersion, eagerVersion, humanError, jsonError, configJson] = await Promise.all([
      runCli(['version']),
      runCli(['--version']),
      runCli(['agents', '--tool', 'ghost']),
      runCli(['agents', '--tool', 'ghost', '--format', 'json']),
      runCli(['config', 'list', '--json']),
    ]);
    expect(explicitVersion).toEqual(eagerVersion);
    expect(explicitVersion).toMatchObject({ exitCode: 0, stderr: '' });
    expect(explicitVersion.stdout).toMatch(/^\d+\.\d+\.\d+[^\n]*\n$/);
    expect(humanError).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: "error: unknown tool 'ghost'\n",
    });
    expect(JSON.parse(jsonError.stdout)).toEqual({
      schemaVersion: 1,
      kind: 'error',
      code: 'invalid-enum',
      message: "unknown tool 'ghost'",
      exitCode: 2,
    });
    expect(jsonError.stderr).toBe('');
    expect(record(JSON.parse(configJson.stdout))).toBeTrue();
    expect(configJson.stderr).toBe('');
  }, 20_000);

  test('characterization: preserves legacy Logger messages and structured result authority', async () => {
    const messages: string[] = [];
    const logger = {
      debug: (message: string) => messages.push(`debug:${message}`),
      info: (message: string) => messages.push(`info:${message}`),
      warn: (message: string) => messages.push(`warn:${message}`),
    };
    const detected = await detectAll(detectionEnv(), { tools: ['codex'], logger });
    expect(detected.ok).toBeTrue();
    expect(messages).toEqual(['debug:detecting codex']);

    const writes = { stdout: [] as string[], stderr: [] as string[], exits: [] as number[] };
    const runtime = createCliRuntimeAdapter({
      applications: {
        fixture: async () => ({
          report: { value: null },
          diagnostics: [{ code: 'fixture-error', severity: 'error', message: 'fixture failed' }],
          exitClass: 'failure',
          mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
          deprecations: [],
        }),
      },
      renderers: {
        fixture: {
          human: () => ({ stderr: 'error: fixture failed\n' }),
          json: () => ({ stdout: '{"fixture":false}\n' }),
        },
      },
      io: {
        stdout: { write: (value) => writes.stdout.push(value) },
        stderr: { write: (value) => writes.stderr.push(value) },
        exit: (code) => writes.exits.push(code),
      },
    });
    const result = await runtime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      format: 'human',
    });
    expect(result.outcome?.diagnostics[0]?.code).toBe('fixture-error');
    expect(writes).toEqual({ stdout: [], stderr: ['error: fixture failed\n'], exits: [1] });
  });

  test('family 1: publishes exact registry, payload closure, public types, and strict OperationContext', async () => {
    const fixture = join(ROOT, 'tests/ergonomics/fixtures/p1-ts11/tsconfig.json');
    const child = Bun.spawn([join(ROOT, 'node_modules/.bin/tsc'), '-p', fixture, '--noEmit'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const compileOutput = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
    expect(exitCode, compileOutput).toBe(0);

    const authority = await observationAuthority('ewp-p1-ts11-family-1');
    if (authority === null) return;
    expect(authority.OBSERVATION_EVENT_KINDS).toEqual([...EVENT_KINDS]);
    expect(Object.isFrozen(authority.OBSERVATION_EVENT_KINDS)).toBeTrue();
    expect(authority.OPERATION_KINDS).toEqual([...OPERATION_KINDS]);
    expect(Object.isFrozen(authority.OPERATION_KINDS)).toBeTrue();

    const built = makeContext(authority);
    expect(built.context).toBeDefined();
    if (built.context === undefined) return;
    expect(built.idPurposes).toEqual(['operation']);
    expect(Object.keys(built.context)).toEqual([
      'operationId',
      'parentOperationId',
      'command',
      'workflow',
      'groupId',
      'pairId',
      'attempt',
      'clock',
      'startedAt',
      'startedMonotonicMilliseconds',
    ]);
    expect(built.context).toMatchObject({
      operationId: 'operation-1',
      parentOperationId: null,
      command: 'skillsmith fixture',
      workflow: 'fixture',
      groupId: null,
      pairId: null,
      attempt: 1,
      startedAt: '2026-07-13T00:00:00.000Z',
      startedMonotonicMilliseconds: 10,
    });
    expect(Object.isFrozen(built.context)).toBeTrue();
    expect(Object.isFrozen(built.context.clock)).toBeTrue();

    const create = callable(authority.createOperationContext);
    expect(create).not.toBeNull();
    if (create === null) return;
    for (const command of ['', ' fixture', 'fixture ', 'bad\ncommand', 'x'.repeat(257)]) {
      expect(() =>
        create({ command, workflow: 'fixture', clock: built.clock, id: built.id }),
      ).toThrow(TypeError);
    }
    expect(() =>
      create({
        command: 'fixture',
        workflow: 'fixture',
        clock: built.clock,
        id: built.id,
        pairId: 'pair-1',
      }),
    ).toThrow(TypeError);
    for (const clock of [
      { wallNowIso: () => 'not-iso', monotonicMilliseconds: () => 1 },
      {
        wallNowIso: () => '2026-07-13T00:00:00.000Z',
        monotonicMilliseconds: () => Number.NaN,
      },
      {
        wallNowIso: new Proxy(() => '2026-07-13T00:00:00.000Z', {}),
        monotonicMilliseconds: () => 1,
      },
    ])
      expect(() =>
        create({ command: 'fixture', workflow: 'fixture', clock, id: built.id }),
      ).toThrow(TypeError);

    let explicitIdCalls = 0;
    const explicit = create({
      command: 'fixture',
      workflow: 'fixture',
      clock: built.clock,
      id: {
        nextId: () => {
          explicitIdCalls++;
          return 'unused';
        },
      },
      operationId: 'explicit-operation',
    }) as UnknownRecord;
    expect(explicitIdCalls).toBe(0);
    expect(explicit.operationId).toBe('explicit-operation');
    const createChild = callable(authority.createChildOperationContext);
    const target = callable(authority.withOperationTarget);
    const nextAttempt = callable(authority.nextOperationAttempt);
    expect(createChild).not.toBeNull();
    expect(target).not.toBeNull();
    expect(nextAttempt).not.toBeNull();
    if (createChild === null || target === null || nextAttempt === null) return;
    built.setTime('2026-07-13T00:00:02.000Z', 30);
    const childContext = createChild(built.context, {
      command: 'skillsmith child',
      workflow: 'child',
      id: built.id,
    }) as UnknownRecord;
    expect(childContext).toMatchObject({
      operationId: 'operation-2',
      parentOperationId: 'operation-1',
      groupId: null,
      pairId: null,
      attempt: 1,
      startedAt: '2026-07-13T00:00:02.000Z',
      startedMonotonicMilliseconds: 30,
    });
    let childGetterReads = 0;
    const hostileChild: UnknownRecord = { workflow: 'child', id: built.id };
    Object.defineProperty(hostileChild, 'command', {
      enumerable: true,
      get: () => {
        childGetterReads++;
        return 'skillsmith hostile-child';
      },
    });
    expect(() => createChild(built.context, hostileChild)).toThrow(TypeError);
    expect(childGetterReads).toBe(0);
    const callsBeforeTarget = built.idPurposes.length;
    const targeted = target(childContext, {
      groupId: 'group-1',
      pairId: 'pair-1',
    }) as UnknownRecord;
    expect(built.idPurposes).toHaveLength(callsBeforeTarget);
    expect(targeted).toMatchObject({
      operationId: 'operation-2',
      groupId: 'group-1',
      pairId: 'pair-1',
      attempt: 1,
      startedMonotonicMilliseconds: 30,
    });
    built.setTime('2026-07-13T00:00:03.000Z', 45);
    const attempted = nextAttempt(targeted) as UnknownRecord;
    expect(built.idPurposes).toHaveLength(callsBeforeTarget);
    expect(attempted).toMatchObject({
      operationId: 'operation-2',
      groupId: 'group-1',
      pairId: 'pair-1',
      attempt: 2,
      startedAt: '2026-07-13T00:00:03.000Z',
      startedMonotonicMilliseconds: 45,
    });
    const overflow = create({
      command: 'fixture',
      workflow: 'fixture',
      clock: built.clock,
      id: built.id,
      operationId: 'overflow-operation',
      attempt: Number.MAX_SAFE_INTEGER,
    });
    expect(() => nextAttempt(overflow)).toThrow(TypeError);
    expect(() =>
      create({
        command: 'fixture',
        workflow: 'fixture',
        clock: built.clock,
        id: built.id,
        attempt: 0,
      }),
    ).toThrow(TypeError);

    const createEvent = callable(authority.createObserverEvent);
    expect(createEvent, 'missing direct throwing event builder').not.toBeNull();
    if (createEvent === null) return;
    const fixtures = eventInputs();
    for (const kind of EVENT_KINDS) {
      built.setTime('2026-07-13T00:00:01.000Z', 20);
      const event = createEvent(built.context, fixtures[kind]) as UnknownRecord;
      expect(Object.keys(event), kind).toEqual([...COMMON_KEYS, ...PAYLOAD_KEYS[kind]]);
      expect(event.kind).toBe(kind);
      expect(Object.isFrozen(event)).toBeTrue();
      if (Array.isArray(event.modes)) expect(Object.isFrozen(event.modes)).toBeTrue();
    }
    expect(() =>
      createEvent(built.context, {
        kind: 'plan.created',
        planId: 'plan-1',
        operationCount: 1,
        extra: 1,
      }),
    ).toThrow(TypeError);
    for (const invalid of [
      {
        kind: 'command.completed',
        outcome: 'success',
        exitClass: 'success',
        errorCode: 'unexpected',
        durationMilliseconds: 1,
      },
      {
        kind: 'command.completed',
        outcome: 'failure',
        exitClass: 'failure',
        errorCode: null,
        durationMilliseconds: 1,
      },
      { kind: 'plan.created', planId: 'plan-1', operationCount: -1 },
      { kind: 'tool.verification.started', toolId: 'fixture-tool', modes: [] },
      {
        kind: 'tool.verification.started',
        toolId: 'fixture-tool',
        modes: ['static', 'static'],
      },
      {
        kind: 'tool.verification.started',
        toolId: 'fixture-tool',
        modes: ['deep', 'static'],
      },
      {
        kind: 'operation.completed',
        operationKind: 'inventory',
        outcome: 'success',
        errorCode: null,
        standaloneCount: null,
        bundledCount: null,
        resultCount: null,
        durationMilliseconds: 1,
      },
      {
        kind: 'operation.completed',
        operationKind: 'diagnostics',
        outcome: 'success',
        errorCode: null,
        standaloneCount: 1,
        bundledCount: 0,
        resultCount: 1,
        durationMilliseconds: 1,
      },
    ])
      expect(() => createEvent(built.context, invalid)).toThrow(TypeError);
    const exoticModes = ['static'];
    Object.setPrototypeOf(exoticModes, null);
    expect(() =>
      createEvent(built.context, {
        kind: 'tool.verification.started',
        toolId: 'fixture-tool',
        modes: exoticModes,
      }),
    ).toThrow(TypeError);
    let eventGetterReads = 0;
    const accessorEvent: UnknownRecord = { kind: 'plan.created', operationCount: 1 };
    Object.defineProperty(accessorEvent, 'planId', {
      enumerable: true,
      get: () => {
        eventGetterReads++;
        return 'plan-1';
      },
    });
    expect(() => createEvent(built.context, accessorEvent)).toThrow(TypeError);
    expect(eventGetterReads).toBe(0);
    let eventProxyReads = 0;
    const proxyEvent = new Proxy(
      { kind: 'plan.created', planId: 'plan-1', operationCount: 1 },
      {
        ownKeys: () => {
          eventProxyReads++;
          return ['kind', 'planId', 'operationCount'];
        },
      },
    );
    expect(() => createEvent(built.context, proxyEvent)).toThrow(TypeError);
    expect(eventProxyReads).toBe(0);
  }, 20_000);

  test('family 2: correlates command/span lifecycle with independent clocks and deterministic error codes', async () => {
    const authority = await observationAuthority('ewp-p1-ts11-family-2');
    if (authority === null) return;
    const createEmitter = callable(authority.createObservationEmitter);
    expect(createEmitter, 'missing createObservationEmitter').not.toBeNull();
    if (createEmitter === null) return;
    expect(() =>
      createEmitter({ observer: { observe: () => {} }, toolIds: ['fixture-tool', 'fixture-tool'] }),
    ).toThrow(TypeError);
    expect(() =>
      createEmitter({ observer: { observe: () => {} }, toolIds: ['INVALID_TOOL'] }),
    ).toThrow(TypeError);
    const timeline: string[] = [];
    const events: UnknownRecord[] = [];
    const built = makeContext(authority);
    if (built.context === undefined) return;
    const emitter = createEmitter({
      observer: {
        observe: (event: UnknownRecord) => {
          events.push(event);
          timeline.push(`event:${String(event.kind)}`);
        },
      },
      toolIds: ['fixture-tool'],
    }) as UnknownRecord;
    const runtime = createCliRuntimeAdapter({
      applications: {
        fixture: async () => {
          timeline.push('application');
          built.setTime('2026-07-13T00:00:03.000Z', 40);
          return {
            report: { value: true },
            diagnostics: [],
            exitClass: 'success',
            mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
            deprecations: [],
          };
        },
      },
      renderers: {
        fixture: {
          human: () => {
            timeline.push('renderer');
            built.setTime('2026-07-13T00:00:04.000Z', 50);
            return { stdout: 'fixture\n' };
          },
          json: () => ({ stdout: '{"fixture":true}\n' }),
        },
      },
      io: {
        stdout: {
          write: (value) => {
            timeline.push(`stdout:${value.trim()}`);
          },
        },
        stderr: { write: (value) => timeline.push(`stderr:${value.trim()}`) },
        exit: (code) => timeline.push(`exit:${code}`),
      },
    });
    built.setTime('2026-07-13T00:00:02.000Z', 30);
    await Reflect.apply(runtime.execute, runtime, [
      {
        application: 'fixture',
        reportKind: 'fixture',
        request: {},
        context: { observation: { context: built.context, emitter } },
        observation: { context: built.context, emitter },
        format: 'human',
      },
    ]);
    expect(timeline).toEqual([
      'event:command.started',
      'application',
      'renderer',
      'event:command.completed',
      'stdout:fixture',
      'exit:0',
    ]);
    expect(events.map((event) => event.kind)).toEqual(['command.started', 'command.completed']);
    for (const event of events)
      expect(event).toMatchObject({
        operationId: 'operation-1',
        parentOperationId: null,
        command: 'skillsmith fixture',
        workflow: 'fixture',
        groupId: null,
        pairId: null,
        attempt: 1,
      });
    expect(events[0]).toMatchObject({
      occurredAt: '2026-07-13T00:00:02.000Z',
      monotonicMilliseconds: 30,
    });
    expect(events[1]).toMatchObject({
      outcome: 'success',
      exitClass: 'success',
      errorCode: null,
      occurredAt: '2026-07-13T00:00:04.000Z',
      monotonicMilliseconds: 50,
      durationMilliseconds: 20,
    });

    const begin = callable(emitter.begin);
    const complete = callable(emitter.complete);
    expect(begin).not.toBeNull();
    expect(complete).not.toBeNull();
    if (begin === null || complete === null) return;
    built.setTime('2026-07-13T00:00:05.000Z', 60);
    const operationSpan = Reflect.apply(begin, emitter, [
      built.context,
      { kind: 'operation.started', operationKind: 'inventory' },
    ]);
    built.setTime('2026-07-13T00:00:06.000Z', 75);
    Reflect.apply(complete, emitter, [
      operationSpan,
      {
        outcome: 'success',
        errorCode: null,
        standaloneCount: 1,
        bundledCount: 0,
        resultCount: 1,
      },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'operation.completed', durationMilliseconds: 15 });

    const modes = ['static', 'deep'];
    const verificationSpan = Reflect.apply(begin, emitter, [
      built.context,
      { kind: 'tool.verification.started', toolId: 'fixture-tool', modes },
    ]);
    modes.splice(0, modes.length, 'deep');
    expect(events.at(-1)).toMatchObject({
      kind: 'tool.verification.started',
      modes: ['static', 'deep'],
    });
    expect(Object.isFrozen(events.at(-1)?.modes)).toBeTrue();
    Reflect.apply(complete, emitter, [verificationSpan, { verdict: 'pass', errorCode: null }]);

    const beforeUnknown = events.length;
    const unknownToolSpan = Reflect.apply(begin, emitter, [
      built.context,
      { kind: 'tool.detection.started', toolId: 'unknown-tool' },
    ]);
    expect(unknownToolSpan).toBeNull();
    expect(events).toHaveLength(beforeUnknown);
    const otherEmitter = createEmitter({
      observer: { observe: () => timeline.push('other-emitter') },
      toolIds: ['fixture-tool'],
    }) as UnknownRecord;
    const eventCount = events.length;
    Reflect.apply(callable(otherEmitter.complete) ?? (() => {}), otherEmitter, [
      operationSpan,
      {
        outcome: 'success',
        errorCode: null,
        standaloneCount: 1,
        bundledCount: 0,
        resultCount: 1,
      },
    ]);
    expect(events).toHaveLength(eventCount);
    expect(timeline).not.toContain('other-emitter');

    const createContext = callable(authority.createOperationContext);
    expect(createContext).not.toBeNull();
    if (createContext === null) return;
    let clockFails = false;
    const unstableContext = createContext({
      command: 'skillsmith unstable',
      workflow: 'unstable',
      operationId: 'unstable-operation',
      id: { nextId: () => 'unused' },
      clock: {
        wallNowIso: () => {
          if (clockFails) throw new Error('clock failed');
          return '2026-07-13T00:01:00.000Z';
        },
        monotonicMilliseconds: () => (clockFails ? Number.NaN : 100),
      },
    });
    const unstableEvents: UnknownRecord[] = [];
    const unstableEmitter = createEmitter({
      observer: { observe: (event: UnknownRecord) => unstableEvents.push(event) },
    }) as UnknownRecord;
    const unstableBegin = callable(unstableEmitter.begin);
    const unstableComplete = callable(unstableEmitter.complete);
    expect(unstableBegin).not.toBeNull();
    expect(unstableComplete).not.toBeNull();
    if (unstableBegin === null || unstableComplete === null) return;
    const unstableSpan = Reflect.apply(unstableBegin, unstableEmitter, [
      unstableContext,
      { kind: 'command.started' },
    ]);
    expect(unstableEvents).toHaveLength(1);
    clockFails = true;
    expect(() =>
      Reflect.apply(unstableComplete, unstableEmitter, [
        unstableSpan,
        { outcome: 'success', exitClass: 'success', errorCode: null },
      ]),
    ).not.toThrow();
    expect(unstableEvents).toHaveLength(1);
    expect(
      Reflect.apply(unstableBegin, unstableEmitter, [unstableContext, { kind: 'command.started' }]),
    ).toBeNull();
    expect(unstableEvents).toHaveLength(1);

    const completionCode = async (
      exitClass: string,
      diagnostics: readonly UnknownRecord[],
    ): Promise<UnknownRecord> => {
      const localEvents: UnknownRecord[] = [];
      const local = makeContext(authority, { operationId: `matrix-${exitClass}` });
      if (local.context === undefined) return {};
      const localEmitter = createEmitter({
        observer: { observe: (event: UnknownRecord) => localEvents.push(event) },
      });
      const adapter = createCliRuntimeAdapter({
        applications: {
          matrix: async () => ({
            report: {},
            diagnostics,
            exitClass,
            mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
            deprecations: [],
          }),
        },
        renderers: { matrix: { human: () => '', json: () => '' } },
        io: { stdout: { write: () => {} }, stderr: { write: () => {} }, exit: () => {} },
      });
      await Reflect.apply(adapter.execute, adapter, [
        {
          application: 'matrix',
          reportKind: 'matrix',
          request: {},
          context: { observation: { context: local.context, emitter: localEmitter } },
          observation: { context: local.context, emitter: localEmitter },
          format: 'human',
        },
      ]);
      return localEvents.at(-1) ?? {};
    };
    for (const [exitClass, expectedCode] of [
      ['failure', 'command-failed'],
      ['usage', 'usage'],
      ['state', 'state'],
      ['capability', 'capability'],
      ['source', 'source'],
      ['permission', 'permission'],
      ['cancelled', 'cancelled'],
    ] as const)
      expect(await completionCode(exitClass, [])).toMatchObject({
        kind: 'command.completed',
        errorCode: expectedCode,
      });
    expect(
      await completionCode('failure', [
        { code: 'notice', severity: 'warning', message: 'warning' },
        { code: 'first-error', severity: 'error', message: 'first' },
        { code: 'second-error', severity: 'error', message: 'second' },
      ]),
    ).toMatchObject({ errorCode: 'first-error' });
    expect(await completionCode('success', [])).toMatchObject({ errorCode: null });
    expect(await completionCode('drift', [])).toMatchObject({ errorCode: null });

    for (const failureMode of ['throw', 'missing-renderer', 'renderer-throw'] as const) {
      const failureEvents: UnknownRecord[] = [];
      const failureBuilt = makeContext(authority, { operationId: `runtime-${failureMode}` });
      if (failureBuilt.context === undefined) return;
      const failureEmitter = createEmitter({
        observer: { observe: (event: UnknownRecord) => failureEvents.push(event) },
      });
      const adapter = createCliRuntimeAdapter({
        applications: {
          fixture: async () => {
            if (failureMode === 'throw') throw new Error('classified failure');
            return {
              report: {},
              diagnostics: [],
              exitClass: 'success',
              mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
              deprecations: [],
            };
          },
        },
        renderers:
          failureMode === 'missing-renderer'
            ? {}
            : {
                fixture: {
                  human: () => {
                    if (failureMode === 'renderer-throw') throw new Error('renderer failure');
                    return '';
                  },
                  json: () => '',
                },
              },
        io: { stdout: { write: () => {} }, stderr: { write: () => {} }, exit: () => {} },
        classifyFailure: () => ({
          exitClass: 'permission',
          code: 'classified-runtime',
          message: 'classified',
        }),
        renderFailure: () => ({ stderr: 'error: classified\n' }),
      });
      await Reflect.apply(adapter.execute, adapter, [
        {
          application: 'fixture',
          reportKind: 'fixture',
          request: {},
          context: { observation: { context: failureBuilt.context, emitter: failureEmitter } },
          observation: { context: failureBuilt.context, emitter: failureEmitter },
          format: 'human',
        },
      ]);
      expect(failureEvents.map((event) => event.kind)).toEqual([
        'command.started',
        'command.completed',
      ]);
      expect(failureEvents.at(-1)).toMatchObject({
        outcome: 'failure',
        exitClass: 'permission',
        errorCode: 'classified-runtime',
      });
    }

    for (const mode of ['missing-application', 'returned-error'] as const) {
      const failureTimeline: string[] = [];
      const failureBuilt = makeContext(authority, { operationId: `ordered-${mode}` });
      if (failureBuilt.context === undefined) return;
      const failureEmitter = createEmitter({
        observer: {
          observe: (event: UnknownRecord) => failureTimeline.push(`event:${String(event.kind)}`),
        },
      });
      const adapter = createCliRuntimeAdapter({
        applications:
          mode === 'missing-application'
            ? {}
            : {
                fixture: async () => {
                  failureTimeline.push('application');
                  return { ok: false, error: new Error('returned failure') };
                },
              },
        renderers: {},
        io: {
          stdout: { write: (value) => failureTimeline.push(`stdout:${value.trim()}`) },
          stderr: { write: (value) => failureTimeline.push(`stderr:${value.trim()}`) },
          exit: (code) => failureTimeline.push(`exit:${code}`),
        },
        classifyFailure: () => ({
          exitClass: 'failure',
          code: 'ordered-failure',
          message: 'ordered failure',
        }),
        renderFailure: () => {
          failureTimeline.push('failure-renderer');
          return { stderr: 'error: ordered failure\n' };
        },
      });
      await Reflect.apply(adapter.execute, adapter, [
        {
          application: 'fixture',
          reportKind: 'fixture',
          request: {},
          context: { observation: { context: failureBuilt.context, emitter: failureEmitter } },
          observation: { context: failureBuilt.context, emitter: failureEmitter },
          format: 'human',
        },
      ]);
      expect(failureTimeline).toEqual([
        'event:command.started',
        ...(mode === 'returned-error' ? ['application'] : []),
        'failure-renderer',
        'event:command.completed',
        'stderr:error: ordered failure',
        'exit:1',
      ]);
    }

    const focusedWrites: string[] = [];
    let focusedContext: unknown;
    const focusedProgram = buildProgram(undefined, {
      operationPorts: {
        clock: {
          wallNowIso: () => '2026-07-13T01:00:00.000Z',
          monotonicMilliseconds: () => 100,
        },
        id: { nextId: (purpose: string) => `focused-${purpose}` },
      },
      applications: {
        version: async (_request, context) => {
          focusedContext = context;
          return {
            report: { version: '1.2.3-focused' },
            diagnostics: [],
            exitClass: 'success',
            mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
            deprecations: [],
          };
        },
      },
      renderers: {
        version: {
          human: () => '1.2.3-focused\n',
          json: () => '{"version":"1.2.3-focused"}\n',
        },
      },
      runtimePorts: {
        stdout: { write: (value) => focusedWrites.push(value) },
        stderr: { write: (value) => focusedWrites.push(value) },
        exit: () => {},
      },
    });
    await focusedProgram.parseAsync(['node', 'skillsmith', 'version']);
    expect(record(focusedContext)).toBeTrue();
    expect(record(focusedContext) ? Object.keys(focusedContext) : []).toEqual(['observation']);
    const focusedObservation = record(focusedContext) ? focusedContext.observation : undefined;
    expect(record(focusedObservation) ? focusedObservation.context : null).toMatchObject({
      operationId: 'focused-operation',
      command: 'skillsmith version',
      workflow: 'version',
      startedAt: '2026-07-13T01:00:00.000Z',
      startedMonotonicMilliseconds: 100,
    });
    expect(focusedWrites).toContain('1.2.3-focused\n');
  });

  test('family 3: isolates synchronous, rejected, and hanging observers without semantic authority', async () => {
    const authority = await observationAuthority('ewp-p1-ts11-family-3');
    if (authority === null) return;
    const createEmitter = callable(authority.createObservationEmitter);
    expect(createEmitter).not.toBeNull();
    if (createEmitter === null) return;
    const built = makeContext(authority);
    if (built.context === undefined) return;
    const attempts: string[] = [];
    for (const observer of [
      {
        observe: (event: UnknownRecord) => {
          attempts.push(`throw:${String(event.kind)}`);
          throw new Error('observer failure');
        },
      },
      {
        observe: (event: UnknownRecord) => {
          attempts.push(`reject:${String(event.kind)}`);
          return Promise.reject(new Error('observer rejection'));
        },
      },
      {
        observe: (event: UnknownRecord) => {
          attempts.push(`hang:${String(event.kind)}`);
          return new Promise<void>(() => {});
        },
      },
    ]) {
      const emitter = createEmitter({ observer }) as UnknownRecord;
      const begin = callable(emitter.begin);
      const complete = callable(emitter.complete);
      expect(begin).not.toBeNull();
      expect(complete).not.toBeNull();
      if (begin === null || complete === null) continue;
      let span: unknown;
      expect(() => {
        span = Reflect.apply(begin, emitter, [built.context, { kind: 'command.started' }]);
      }).not.toThrow();
      expect(span).not.toBeNull();
      expect(() =>
        Reflect.apply(complete, emitter, [
          span,
          { outcome: 'success', exitClass: 'success', errorCode: null },
        ]),
      ).not.toThrow();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toEqual([
      'throw:command.started',
      'throw:command.completed',
      'reject:command.started',
      'reject:command.completed',
      'hang:command.started',
      'hang:command.completed',
    ]);
    const baseline = await detectAll(detectionEnv(), { tools: ['codex'] });
    const throwingEmitter = createEmitter({
      observer: { observe: () => Promise.reject(new Error('scan observer rejection')) },
      toolIds: ['codex'],
    });
    const observed = (await Reflect.apply(detectAll, null, [
      detectionEnv(),
      {
        tools: ['codex'],
        observation: { context: built.context, emitter: throwingEmitter },
      },
    ])) as typeof baseline;
    expect(observed).toEqual(baseline);
    await Promise.resolve();
  });

  test('family 4: recursively redacts hostile nested values without reads, leaks, or mutation', async () => {
    const authority = await observationAuthority('ewp-p1-ts11-family-4');
    if (authority === null) return;
    const redact = callable(authority.redactObservationValue);
    expect(redact, 'missing redactObservationValue').not.toBeNull();
    if (redact === null) return;
    let getterReads = 0;
    let proxyReads = 0;
    const accessor: UnknownRecord = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterReads++;
        return 'getter-secret-canary';
      },
    });
    const proxy = new Proxy(
      { value: 'proxy-secret-canary' },
      {
        ownKeys: () => {
          proxyReads++;
          return ['value'];
        },
      },
    );
    const shared = { safe: 'value' };
    const cycle: UnknownRecord = {};
    cycle.self = cycle;
    const input: UnknownRecord = {
      authorization: 'Bearer key-redaction-canary',
      nested: [
        {
          text: 'before Bearer value-secret-canary after ghp_abcdefgh gho_abcdefgh ghu_abcdefgh ghs_abcdefgh ghr_abcdefgh sk-abcdefgh',
          nearMiss: 'ghp_abcdefg sk-abcdefg',
        },
      ],
      cookieJar: 'cookie-secret-canary',
      credentialValue: 'credential-secret-canary',
      passwordValue: 'password-secret-canary',
      clientSecret: 'named-secret-canary',
      tokenValue: 'token-secret-canary',
      accessor,
      proxy,
      sharedA: shared,
      sharedB: shared,
      cycle,
      nonfinite: Number.NaN,
      negativeZero: -0,
      bigint: 1n,
      undefinedValue: undefined,
      symbolValue: Symbol('symbol-value-secret-canary'),
      fn: () => 'function-secret-canary',
      exotic: new Date(0),
    };
    const redacted = redact(input) as UnknownRecord;
    expect(Object.getPrototypeOf(redacted)).toBeNull();
    expect(Object.isFrozen(redacted)).toBeTrue();
    expect(redacted.authorization).toBe('[REDACTED]');
    for (const key of [
      'cookieJar',
      'credentialValue',
      'passwordValue',
      'clientSecret',
      'tokenValue',
    ])
      expect(redacted[key]).toBe('[REDACTED]');
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toMatch(
      /key-redaction-canary|value-secret-canary|getter-secret-canary|proxy-secret-canary|function-secret-canary/,
    );
    expect(serialized).not.toMatch(
      /cookie-secret-canary|credential-secret-canary|password-secret-canary|named-secret-canary|token-secret-canary|symbol-value-secret-canary/,
    );
    for (const marker of [
      '[REDACTED]',
      '[ACCESSOR]',
      '[PROXY]',
      '[CIRCULAR]',
      '[NON_FINITE]',
      '[EXOTIC]',
      '[UNDEFINED]',
      '[BIGINT]',
      '[SYMBOL]',
      '[FUNCTION]',
    ])
      expect(serialized).toContain(marker);
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);
    expect((redacted.sharedA as object) === (redacted.sharedB as object)).toBeFalse();
    expect(Object.getPrototypeOf((redacted.nested as readonly unknown[])[0])).toBeNull();
    expect(Object.isFrozen(redacted.nested)).toBeTrue();
    expect(Object.isFrozen((redacted.nested as readonly unknown[])[0])).toBeTrue();
    expect((redacted.nested as readonly UnknownRecord[])[0]?.nearMiss).toBe(
      'ghp_abcdefg sk-abcdefg',
    );
    expect(Object.is((redacted as UnknownRecord).negativeZero, -0)).toBeTrue();
    const symbolKey = { safe: true, [Symbol('secret')]: 'symbol-secret-canary' };
    expect(redact(symbolKey)).toBe('[SYMBOL]');
    expect(input.authorization).toBe('Bearer key-redaction-canary');
    const sensitiveAccessor: UnknownRecord = {};
    Object.defineProperty(sensitiveAccessor, 'secretToken', {
      enumerable: true,
      get: () => {
        getterReads++;
        return 'sensitive-accessor-canary';
      },
    });
    expect(redact(sensitiveAccessor)).toEqual({ secretToken: '[REDACTED]' });
    expect(getterReads).toBe(0);

    let deep: unknown = 'leaf';
    for (let index = 0; index < 34; index++) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[MAX_DEPTH]');
    expect(JSON.stringify(redact(Array.from({ length: 4_097 }, (_, index) => index)))).toContain(
      '[MAX_NODES]',
    );
  });

  test('family 5: migrates current detection and verification to registry-bound typed events', async () => {
    const authority = await observationAuthority('ewp-p1-ts11-family-5');
    if (authority === null) return;
    const createEmitter = callable(authority.createObservationEmitter);
    expect(createEmitter).not.toBeNull();
    if (createEmitter === null) return;
    const built = makeContext(authority);
    if (built.context === undefined) return;
    const events: UnknownRecord[] = [];
    const emitter = createEmitter({
      observer: { observe: (event: UnknownRecord) => events.push(event) },
      toolIds: ['codex'],
    });
    let legacyCalls = 0;
    const detected = (await Reflect.apply(detectAll, null, [
      detectionEnv(),
      {
        tools: ['codex'],
        observation: { context: built.context, emitter },
        logger: {
          debug: () => legacyCalls++,
          info: () => legacyCalls++,
          warn: () => legacyCalls++,
        },
      },
    ])) as { readonly ok: boolean };
    expect(detected.ok).toBeTrue();
    expect(legacyCalls).toBe(0);
    expect(events.map((event) => event.kind)).toEqual([
      'tool.detection.started',
      'tool.detection.completed',
    ]);
    expect(events[0]?.toolId).toBe('codex');
    const detectionErrorEvents: UnknownRecord[] = [];
    const detectionErrorEmitter = createEmitter({
      observer: { observe: (event: UnknownRecord) => detectionErrorEvents.push(event) },
      toolIds: ['codex'],
    });
    const detectionError = (await Reflect.apply(detectAll, null, [
      { ...detectionEnv(), fileExists: async () => Promise.reject(new Error('probe failed')) },
      {
        tools: ['codex'],
        observation: { context: built.context, emitter: detectionErrorEmitter },
      },
    ])) as { readonly ok: boolean; readonly value?: Map<string, readonly unknown[]> };
    expect(detectionError.ok).toBeTrue();
    expect(detectionError.value?.get('codex')).toEqual([]);
    expect(detectionErrorEvents.map((event) => event.kind)).toEqual([
      'tool.detection.started',
      'tool.detection.completed',
    ]);
    expect(detectionErrorEvents.at(-1)).toMatchObject({
      outcome: 'failure',
      errorCode: 'generic',
      resultCount: 0,
    });

    const legacyAdapter = callable(authority.observationFromLegacyLogger);
    expect(legacyAdapter, 'missing Logger compatibility adapter').not.toBeNull();
    if (legacyAdapter === null) return;
    const legacyLines: Array<readonly [string, string, unknown?]> = [];
    const legacy = legacyAdapter(
      {
        debug: (message: string, metadata?: unknown) =>
          legacyLines.push(['debug', message, metadata]),
        info: (message: string, metadata?: unknown) =>
          legacyLines.push(['info', message, metadata]),
        warn: (message: string, metadata?: unknown) =>
          legacyLines.push(['warn', message, metadata]),
      },
      'detect',
      ['codex'],
    ) as UnknownRecord;
    expect(legacy.context).toMatchObject({
      operationId: 'legacy-observation',
      parentOperationId: null,
      command: 'legacy-scan',
      workflow: 'detect',
      groupId: null,
      pairId: null,
      attempt: 1,
      startedAt: '1970-01-01T00:00:00.000Z',
      startedMonotonicMilliseconds: 0,
    });
    const legacyEmitter = legacy.emitter as UnknownRecord;
    const legacyBegin = callable(legacyEmitter.begin);
    const legacyComplete = callable(legacyEmitter.complete);
    expect(legacyBegin).not.toBeNull();
    expect(legacyComplete).not.toBeNull();
    if (legacyBegin === null || legacyComplete === null || !record(legacy.context)) return;
    const legacySpan = Reflect.apply(legacyBegin, legacyEmitter, [
      legacy.context,
      { kind: 'tool.detection.started', toolId: 'codex' },
    ]);
    Reflect.apply(legacyComplete, legacyEmitter, [
      legacySpan,
      { outcome: 'failure', errorCode: 'generic', resultCount: 0 },
    ]);
    expect(legacyLines).toEqual([
      ['debug', 'detecting codex', undefined],
      ['warn', 'detection error for codex', { code: 'generic' }],
    ]);
    expect(JSON.stringify(legacyLines)).not.toContain('legacy-observation');

    const inventoryPorts = {
      ...(await defaultRuntimePorts()),
      homeDir: '/nonexistent/skillsmith-ts11-home',
      xdg: {
        config: '/nonexistent/skillsmith-ts11-config',
        data: '/nonexistent/skillsmith-ts11-data',
        cache: '/nonexistent/skillsmith-ts11-cache',
      },
    };
    const configuration = resolveRuntimeConfiguration({});
    const inventoryStart = events.length;
    const listedSkills = await Reflect.apply(listSkills, null, [
      inventoryPorts,
      {
        tools: [],
        scopes: [],
        cwd: ROOT,
        configuration,
        observation: { context: built.context, emitter },
      },
    ]);
    expect(record(listedSkills) && listedSkills.ok).toBeTrue();
    expect(events.slice(inventoryStart).map((event) => event.kind)).toEqual([
      'operation.started',
      'operation.completed',
    ]);
    expect(events.at(-1)).toMatchObject({
      operationKind: 'inventory',
      standaloneCount: 0,
      bundledCount: 0,
      resultCount: 0,
    });
    const commandsStart = events.length;
    const listedCommands = await Reflect.apply(listCommands, null, [
      inventoryPorts,
      {
        tools: [],
        scopes: [],
        cwd: ROOT,
        configuration,
        observation: { context: built.context, emitter },
      },
    ]);
    expect(record(listedCommands) && listedCommands.ok).toBeTrue();
    expect(events.slice(commandsStart).map((event) => event.kind)).toEqual([
      'operation.started',
      'operation.completed',
    ]);
    const diagnosticsStart = events.length;
    const diagnosticsResult = await Reflect.apply(runChecks, null, [
      [],
      {
        env: inventoryPorts,
        mode: 'doctor',
        tools: [],
        scopes: [],
        cwd: ROOT,
        configuration,
        offline: true,
        observation: { context: built.context, emitter },
      },
    ]);
    expect(record(diagnosticsResult) && diagnosticsResult.ok).toBeTrue();
    expect(events.slice(diagnosticsStart).map((event) => event.kind)).toEqual([
      'operation.started',
      'operation.completed',
    ]);
    expect(events.slice(diagnosticsStart)).toMatchObject([
      { operationKind: 'diagnostics' },
      {
        operationKind: 'diagnostics',
        outcome: 'success',
        standaloneCount: null,
        bundledCount: null,
        resultCount: null,
      },
    ]);

    const doctorStart = events.length;
    const doctorResult = await Reflect.apply(crossScopeDuplicate.run, crossScopeDuplicate, [
      {
        env: inventoryPorts,
        mode: 'doctor',
        tools: [],
        scopes: [],
        cwd: ROOT,
        configuration,
        offline: true,
        logger: { debug: () => {}, info: () => {}, warn: () => {} },
        observation: { context: built.context, emitter },
      },
    ]);
    expect(Array.isArray(doctorResult)).toBeTrue();
    expect(events.slice(doctorStart).map((event) => event.kind)).toEqual([
      'operation.started',
      'operation.completed',
    ]);

    const verifyEvents: UnknownRecord[] = [];
    const verifyBuilt = makeContext(authority, {
      command: 'skillsmith verify',
      workflow: 'verify',
      operationId: 'verify-operation',
    });
    if (verifyBuilt.context === undefined) return;
    const verifyEmitter = createEmitter({
      observer: { observe: (event: UnknownRecord) => verifyEvents.push(event) },
      toolIds: ['codex'],
    });
    const checker: ToolVerifier<'codex'> = async (_env, options) =>
      ok({
        tool: 'codex',
        available: true,
        toolVersion: '9.9.9',
        versionDrift: false,
        skipReason: null,
        verdict: 'pass',
        modes: options.modes.map((mode) => ({
          mode,
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict: 'pass',
          command: 'codex fixture',
          findings: [],
        })),
      });
    const ports = inventoryPorts;
    const verified = (await Reflect.apply(runVerify, null, [
      ports,
      {
        path: VERIFY_FIXTURE,
        tools: ['codex'],
        deep: true,
        observation: { context: verifyBuilt.context, emitter: verifyEmitter },
      },
      { codex: checker },
    ])) as { readonly ok: boolean };
    expect(verified.ok).toBeTrue();
    expect(verifyEvents.map((event) => event.kind)).toEqual([
      'tool.verification.started',
      'tool.verification.completed',
    ]);
    expect(verifyEvents[0]).toMatchObject({ toolId: 'codex', modes: ['static', 'deep'] });
    expect(verifyEvents[1]).toMatchObject({
      toolId: 'codex',
      modes: ['static', 'deep'],
      verdict: 'pass',
      errorCode: null,
    });

    const verificationCase = async (toolVerdict: UnknownRecord) => {
      const before = verifyEvents.length;
      const result = await Reflect.apply(runVerify, null, [
        ports,
        {
          path: VERIFY_FIXTURE,
          tools: ['codex'],
          observation: { context: verifyBuilt.context, emitter: verifyEmitter },
        },
        { codex: async () => ok(toolVerdict) },
      ]);
      expect(record(result) && result.ok).toBeTrue();
      return verifyEvents.slice(before);
    };
    const baseVerdict = {
      tool: 'codex',
      available: true,
      toolVersion: '9.9.9',
      versionDrift: false,
      skipReason: null,
      verdict: 'pass',
      modes: [
        {
          mode: 'static',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict: 'pass',
          command: 'codex fixture',
          findings: [],
        },
      ],
    };
    const cases: ReadonlyArray<readonly [UnknownRecord, string, string | null]> = [
      [
        {
          ...baseVerdict,
          available: false,
          toolVersion: null,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [],
        },
        'unavailable',
        'not-installed',
      ],
      [
        {
          ...baseVerdict,
          verdict: 'inconclusive',
          modes: [
            { ...baseVerdict.modes[0], status: 'error', skipReason: 'timeout', verdict: null },
          ],
        },
        'inconclusive',
        'timeout',
      ],
      [
        {
          ...baseVerdict,
          verdict: 'inconclusive',
          modes: [
            { ...baseVerdict.modes[0], status: 'error', skipReason: 'exec-error', verdict: null },
          ],
        },
        'inconclusive',
        'exec-error',
      ],
      [
        {
          ...baseVerdict,
          verdict: 'inconclusive',
          modes: [
            { ...baseVerdict.modes[0], status: 'error', skipReason: 'exec-error', verdict: null },
            {
              ...baseVerdict.modes[0],
              mode: 'deep',
              status: 'error',
              skipReason: 'timeout',
              verdict: null,
            },
          ],
        },
        'inconclusive',
        'timeout',
      ],
      [
        {
          ...baseVerdict,
          available: false,
          toolVersion: null,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [
            { ...baseVerdict.modes[0], status: 'error', skipReason: 'timeout', verdict: null },
          ],
        },
        'unavailable',
        'not-installed',
      ],
      [
        {
          ...baseVerdict,
          verdict: 'inconclusive',
          modes: [
            {
              ...baseVerdict.modes[0],
              status: 'skipped',
              skipReason: 'not-installed',
              verdict: null,
            },
          ],
        },
        'unavailable',
        'not-installed',
      ],
      [
        {
          ...baseVerdict,
          verdict: 'inconclusive',
          modes: [
            { ...baseVerdict.modes[0], status: 'skipped', skipReason: 'timeout', verdict: null },
          ],
        },
        'inconclusive',
        'timeout',
      ],
      [
        {
          ...baseVerdict,
          verdict: 'inconclusive',
          modes: [
            { ...baseVerdict.modes[0], status: 'skipped', skipReason: 'exec-error', verdict: null },
          ],
        },
        'inconclusive',
        'exec-error',
      ],
      [
        { ...baseVerdict, verdict: 'fail', modes: [{ ...baseVerdict.modes[0], verdict: 'fail' }] },
        'fail',
        'verification-failed',
      ],
      [
        { ...baseVerdict, verdict: 'warn', modes: [{ ...baseVerdict.modes[0], verdict: 'warn' }] },
        'warn',
        null,
      ],
      [baseVerdict, 'pass', null],
      [
        { ...baseVerdict, verdict: 'inconclusive', modes: [] },
        'inconclusive',
        'verification-inconclusive',
      ],
    ];
    for (const [toolVerdict, verdict, errorCode] of cases) {
      const emitted = await verificationCase(toolVerdict);
      expect(emitted.map((event) => event.kind)).toEqual([
        'tool.verification.started',
        'tool.verification.completed',
      ]);
      expect(emitted[1]).toMatchObject({ verdict, errorCode });
    }

    const errorBefore = verifyEvents.length;
    const returnedError = await Reflect.apply(runVerify, null, [
      ports,
      {
        path: VERIFY_FIXTURE,
        tools: ['codex'],
        observation: { context: verifyBuilt.context, emitter: verifyEmitter },
      },
      { codex: async () => err(genericError('fixture verify error')) },
    ]);
    expect(record(returnedError) && returnedError.ok).toBeFalse();
    expect(verifyEvents.slice(errorBefore).at(-1)).toMatchObject({
      verdict: 'fail',
      errorCode: 'generic',
    });
    const throwBefore = verifyEvents.length;
    await expect(
      Reflect.apply(runVerify, null, [
        ports,
        {
          path: VERIFY_FIXTURE,
          tools: ['codex'],
          observation: { context: verifyBuilt.context, emitter: verifyEmitter },
        },
        { codex: async () => Promise.reject(new Error('checker threw')) },
      ]),
    ).rejects.toThrow('checker threw');
    expect(verifyEvents.slice(throwBefore).at(-1)).toMatchObject({
      verdict: 'fail',
      errorCode: 'generic',
    });

    const missingEvents: UnknownRecord[] = [];
    const missingEmitter = createEmitter({
      observer: { observe: (event: UnknownRecord) => missingEvents.push(event) },
      toolIds: ['missing-tool'],
    });
    const missing = await Reflect.apply(runVerify, null, [
      ports,
      {
        path: VERIFY_FIXTURE,
        tools: ['missing-tool'],
        observation: { context: verifyBuilt.context, emitter: missingEmitter },
      },
      {},
    ]);
    expect(record(missing) && missing.ok).toBeFalse();
    expect(missingEvents.map((event) => event.kind)).toEqual([
      'tool.verification.started',
      'tool.verification.completed',
    ]);
    expect(missingEvents.at(-1)).toMatchObject({ verdict: 'fail', errorCode: 'generic' });

    const emptyEvents: UnknownRecord[] = [];
    const emptyEmitter = createEmitter({
      observer: { observe: (event: UnknownRecord) => emptyEvents.push(event) },
      toolIds: ['codex'],
    });
    await Reflect.apply(runVerify, null, [
      ports,
      {
        path: VERIFY_FIXTURE,
        tools: [],
        observation: { context: verifyBuilt.context, emitter: emptyEmitter },
      },
      {},
    ]);
    expect(emptyEvents).toEqual([]);

    const shortCircuitEvents: UnknownRecord[] = [];
    const shortCircuitCalls: string[] = [];
    const shortCircuitEmitter = createEmitter({
      observer: { observe: (event: UnknownRecord) => shortCircuitEvents.push(event) },
      toolIds: ['codex', 'second-tool'],
    });
    await Reflect.apply(runVerify, null, [
      ports,
      {
        path: VERIFY_FIXTURE,
        tools: ['codex', 'second-tool'],
        observation: { context: verifyBuilt.context, emitter: shortCircuitEmitter },
      },
      {
        codex: async () => {
          shortCircuitCalls.push('codex');
          return err(genericError('first failed'));
        },
        'second-tool': async () => {
          shortCircuitCalls.push('second-tool');
          return ok({ ...baseVerdict, tool: 'second-tool' });
        },
      },
    ]);
    expect(shortCircuitCalls).toEqual(['codex']);
    expect(shortCircuitEvents.map((event) => event.kind)).toEqual([
      'tool.verification.started',
      'tool.verification.completed',
    ]);

    const controller = new AbortController();
    controller.abort();
    const beforeAbort = verifyEvents.length;
    await Reflect.apply(runVerify, null, [
      ports,
      {
        path: VERIFY_FIXTURE,
        tools: ['codex'],
        signal: controller.signal,
        observation: { context: verifyBuilt.context, emitter: verifyEmitter },
      },
      { codex: checker },
    ]);
    expect(verifyEvents).toHaveLength(beforeAbort);
    await Reflect.apply(runVerify, null, [
      ports,
      {
        path: join(VERIFY_FIXTURE, 'missing-target'),
        tools: ['codex'],
        observation: { context: verifyBuilt.context, emitter: verifyEmitter },
      },
      { codex: checker },
    ]);
    expect(verifyEvents).toHaveLength(beforeAbort);
  });

  test('family 6: renders exact quiet, normal, verbose, trace, and debug policy through one sink', async () => {
    const [authority, diagnostics] = await Promise.all([
      observationAuthority('ewp-p1-ts11-family-6'),
      importMaybe(DIAGNOSTICS_MODULE, 'ewp-p1-ts11-family-6'),
    ]);
    expect(diagnostics, 'missing CLI diagnostic authority').not.toBeNull();
    if (authority === null || diagnostics === null) return;
    const resolveVerbosity = callable(diagnostics.resolveObservationVerbosity);
    const createSink = callable(diagnostics.createCliDiagnosticObserver);
    const createEvent = callable(authority.createObserverEvent);
    expect(resolveVerbosity).not.toBeNull();
    expect(createSink).not.toBeNull();
    expect(createEvent).not.toBeNull();
    if (resolveVerbosity === null || createSink === null || createEvent === null) return;
    expect(resolveVerbosity({})).toBe('normal');
    expect(resolveVerbosity({ quiet: true })).toBe('quiet');
    expect(resolveVerbosity({ verbose: 1 })).toBe('verbose');
    expect(resolveVerbosity({ verbose: 2 })).toBe('trace');
    expect(resolveVerbosity({ verbose: 1, debug: true })).toBe('debug');

    const built = makeContext(authority);
    if (built.context === undefined) return;
    built.setTime('2026-07-13T00:00:05.000Z', 60);
    const commandEvent = createEvent(built.context, { kind: 'command.started' });
    const toolEvent = createEvent(built.context, {
      kind: 'tool.detection.started',
      toolId: 'fixture-tool',
    });
    const render = (verbosity: string, events: readonly unknown[]) => {
      const writes: string[] = [];
      const sink = createSink(
        {
          stdout: { write: () => {} },
          stderr: { write: (value: string) => writes.push(value) },
          exit: () => {},
        },
        verbosity,
      ) as UnknownRecord;
      const observe = callable(sink.observe);
      expect(observe).not.toBeNull();
      if (observe !== null) for (const event of events) Reflect.apply(observe, sink, [event]);
      return writes;
    };
    expect(render('normal', [commandEvent, toolEvent])).toEqual([]);
    expect(render('quiet', [commandEvent, toolEvent])).toEqual([]);
    expect(render('verbose', [commandEvent, toolEvent])).toEqual([
      'detail: command.started operation=operation-1 command="skillsmith fixture"\n',
    ]);
    expect(render('trace', [toolEvent])).toEqual([
      'trace: tool.detection.started operation=operation-1 parent=- group=- pair=- attempt=1 at=2026-07-13T00:00:05.000Z monoMs=60 toolId=fixture-tool\n',
    ]);
    const debug = render('debug', [toolEvent]);
    expect(debug).toHaveLength(1);
    expect(debug[0]?.startsWith('debug: {')).toBeTrue();
    expect(JSON.parse(debug[0]?.slice('debug: '.length) ?? '{}')).toMatchObject({
      kind: 'tool.detection.started',
      toolId: 'fixture-tool',
    });
    const allEvents = EVENT_KINDS.map((kind) => createEvent(built.context, eventInputs()[kind]));
    const traceLines = render('trace', allEvents);
    expect(traceLines).toHaveLength(EVENT_KINDS.length);
    for (let index = 0; index < EVENT_KINDS.length; index++) {
      const kind = EVENT_KINDS[index];
      const line = traceLines[index] ?? '';
      expect(line).toStartWith(
        `trace: ${kind} operation=operation-1 parent=- group=- pair=- attempt=1 at=2026-07-13T00:00:05.000Z monoMs=60`,
      );
      let previous = -1;
      for (const key of PAYLOAD_KEYS[kind]) {
        const position = line.indexOf(` ${key}=`, previous + 1);
        expect(position, `${kind} missing/out-of-order ${key}`).toBeGreaterThan(previous);
        previous = position;
      }
      expect(line.endsWith('\n')).toBeTrue();
    }
    const debugLines = render('debug', allEvents);
    expect(debugLines).toHaveLength(EVENT_KINDS.length);
    for (let index = 0; index < EVENT_KINDS.length; index++) {
      const kind = EVENT_KINDS[index];
      const parsed = JSON.parse(debugLines[index]?.slice('debug: '.length) ?? '{}');
      expect(Object.keys(parsed)).toEqual([...COMMON_KEYS, ...PAYLOAD_KEYS[kind]]);
    }
    expect(
      render('verbose', [
        createEvent(built.context, eventInputs()['plan.created']),
        createEvent(built.context, eventInputs()['operation.started']),
        toolEvent,
      ]).map((line) => line.split(' ')[1]),
    ).toEqual(['plan.created', 'operation.started']);
    const secretBuilt = makeContext(authority, {
      command: 'skillsmith secret',
      workflow: 'fixture',
      operationId: 'secret-operation',
    });
    if (secretBuilt.context === undefined) return;
    secretBuilt.setTime('2026-07-13T00:00:06.000Z', 70);
    const secretEvent = createEvent(secretBuilt.context, {
      kind: 'plan.created',
      planId: 'Bearer sink-secret-canary',
      operationCount: 1,
    });
    for (const verbosity of ['verbose', 'trace', 'debug']) {
      const rendered = render(verbosity, [secretEvent]).join('');
      expect(rendered).not.toContain('sink-secret-canary');
      expect(rendered.split('\n').filter(Boolean)).toHaveLength(1);
      expect(rendered).toContain('[REDACTED]');
    }
  });

  test('family 7: preserves spawned stdout while verbosity stays on stderr and eager conflicts preflight', async () => {
    const secret = 'sk-spawnedsecretvalue';
    const [normal, quiet, verbose, trace, debug, mixed, jsonNormal, jsonQuiet, jsonVerbose] =
      await Promise.all([
        runCli(['version']),
        runCli(['version', '-q']),
        runCli(['version', '-v']),
        runCli(['version', '-vv']),
        runCli(['version', '--debug'], { SKILLSMITH_TS11_SECRET: secret }),
        runCli(['version', '-v', '--debug']),
        runCli(['config', 'list', '--json']),
        runCli(['config', 'list', '--json', '-q']),
        runCli(['-v', 'config', 'list', '--json']),
      ]);
    expect(quiet).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    for (const result of [verbose, trace, debug, mixed]) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(normal.stdout);
    }
    expect(verbose.stderr.split('\n').filter(Boolean)).toHaveLength(2);
    expect(verbose.stderr).toMatch(/^detail: command\.started/m);
    expect(trace.stderr).toMatch(/^trace: command\.started/m);
    expect(debug.stderr).toMatch(/^debug: \{"kind":"command\.started"/m);
    expect(mixed.stderr).toMatch(/^debug: /m);
    expect(mixed.stderr).not.toMatch(/^detail: /m);
    expect(debug.stderr).not.toContain(secret);
    expect(jsonQuiet.stdout).toBe(jsonNormal.stdout);
    expect(jsonVerbose.stdout).toBe(jsonNormal.stdout);
    expect(JSON.parse(jsonNormal.stdout)).toEqual(JSON.parse(jsonVerbose.stdout));
    expect(jsonVerbose.stderr).toMatch(/^detail: command\.started/m);

    const [humanErrorQuiet, jsonErrorNormal, jsonErrorQuiet, jsonErrorVerbose] = await Promise.all([
      runCli(['agents', '--tool', 'ghost', '-q']),
      runCli(['agents', '--tool', 'ghost', '--format', 'json']),
      runCli(['agents', '--tool', 'ghost', '--format', 'json', '-q']),
      runCli(['-v', 'agents', '--tool', 'ghost', '--format', 'json']),
    ]);
    expect(humanErrorQuiet).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: "error: unknown tool 'ghost'\n",
    });
    expect(jsonErrorQuiet.stdout).toBe(jsonErrorNormal.stdout);
    expect(jsonErrorVerbose.stdout).toBe(jsonErrorNormal.stdout);
    expect(JSON.parse(jsonErrorNormal.stdout)).toEqual(JSON.parse(jsonErrorVerbose.stdout));
    expect(jsonErrorQuiet.stderr).toBe('');
    expect(jsonErrorVerbose.stderr).toBe('');

    for (const invocation of [
      ['--version', '-qv'],
      ['--version', '--quiet', '--debug'],
    ] as const) {
      const result = await runCli(invocation);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^error: /);
      expect(result.stderr).not.toMatch(/^(?:detail|trace|debug): /m);
    }
    const [help, helpVerbose, helpDebug, helpQuiet] = await Promise.all([
      runCli(['--help']),
      runCli(['-v', '--help']),
      runCli(['--debug', '--help']),
      runCli(['-q', '--help']),
    ]);
    expect(helpVerbose).toEqual(help);
    expect(helpDebug).toEqual(help);
    expect(helpQuiet).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  }, 30_000);

  test('family 8: enforces parsed-AST ownership, decision independence, and P3B deferral', async () => {
    const findings: string[] = [];
    const coreFiles = await typescriptFiles(join(ROOT, 'packages/core/src'));
    const cliFiles = await typescriptFiles(join(ROOT, 'packages/cli/src'));
    const loggerImportAllowlist = new Set([
      'packages/core/src/env/logger.ts',
      'packages/core/src/observation/logger-compat.ts',
      'packages/core/src/scan/index.ts',
      'packages/core/src/scan/list-skills.ts',
      'packages/core/src/scan/list-commands.ts',
      'packages/core/src/doctor/types.ts',
      'packages/core/src/index.ts',
      'packages/core/src/public-types.ts',
    ]);
    const stateAdjacentObservationImportAllowlist = new Set([
      'packages/core/src/execution/observation.ts',
      'packages/core/src/execution/types.ts',
      'packages/core/src/execution/coordinator.ts',
      'packages/core/src/execution/scheduler.ts',
      'packages/core/src/application/lifecycle-services.ts',
      'packages/core/src/application/read-services.ts',
      'packages/core/src/doctor/repair.ts',
      'packages/core/src/acquire/run.ts',
      'packages/core/src/acquire/execute.ts',
      'packages/core/src/place/run.ts',
      'packages/core/src/place/execute.ts',
      'packages/core/src/place/recovery.ts',
      'packages/core/src/place/swap.ts',
      'packages/core/src/place/ledger-migration.ts',
    ]);
    const deferredEventLiteralAuthorities = new Set([
      'packages/core/src/observation/types.ts',
      'packages/core/src/execution/observation.ts',
    ]);
    const observationFreeOwnedFiles = new Set([
      'packages/core/src/artifacts/ledger-writer.ts',
      'packages/core/src/place/ledger-persistence.ts',
      'packages/core/src/place/logical-transactions.ts',
    ]);
    for (const path of coreFiles) {
      const source = await readFile(path, 'utf8');
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const file = relative(ROOT, path);
      const beginSpans = new Set<string>();
      const loggerMethodAliases = new Set<string>();
      const loggerBearing = /from\s+['"][^'"]*env\/logger\.ts['"]/.test(source);
      const collectBeginSpans = (node: ts.Node): void => {
        if (
          loggerBearing &&
          ts.isVariableDeclaration(node) &&
          node.initializer !== undefined &&
          ts.isPropertyAccessExpression(node.initializer) &&
          ['info', 'warn', 'debug'].includes(node.initializer.name.text) &&
          ts.isIdentifier(node.name)
        )
          loggerMethodAliases.add(node.name.text);
        if (loggerBearing && ts.isBindingElement(node)) {
          const method = (node.propertyName ?? node.name).getText(tree).replace(/["']/g, '');
          if (['info', 'warn', 'debug'].includes(method) && ts.isIdentifier(node.name))
            loggerMethodAliases.add(node.name.text);
        }
        if (
          source.includes('observation') &&
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          ts.isCallExpression(node.initializer) &&
          ts.isPropertyAccessExpression(node.initializer.expression) &&
          node.initializer.expression.name.text === 'begin'
        )
          beginSpans.add(node.name.text);
        ts.forEachChild(node, collectBeginSpans);
      };
      collectBeginSpans(tree);
      const isDecisionUse = (node: ts.Node): boolean => {
        for (
          let parent: ts.Node | undefined = node.parent;
          parent !== undefined;
          parent = parent.parent
        ) {
          if (
            ts.isIfStatement(parent) ||
            ts.isConditionalExpression(parent) ||
            ts.isWhileStatement(parent) ||
            ts.isDoStatement(parent) ||
            ts.isSwitchStatement(parent)
          )
            return true;
          if (ts.isExpressionStatement(parent) || ts.isVariableStatement(parent)) return false;
        }
        return false;
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
          const specifier = ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : node.moduleSpecifier.getText(tree);
          const importsLogger =
            specifier.endsWith('/env/logger.ts') ||
            /\bLogger\b/.test(node.importClause?.getText(tree) ?? '');
          if (importsLogger && !loggerImportAllowlist.has(file))
            findings.push(`${file}: Logger import outside compatibility allowlist`);
          if (
            file.startsWith('packages/core/src/observation/') &&
            /(?:place|acquire|persist|journal|repository|packages\/cli|node:process)/.test(
              specifier,
            )
          )
            findings.push(`${file}: forbidden observation dependency ${specifier}`);
          const stateAdjacentCandidate =
            /(?:place|acquire|persist|journal|repository|coordinator)/.test(file) ||
            stateAdjacentObservationImportAllowlist.has(file) ||
            observationFreeOwnedFiles.has(file);
          if (
            stateAdjacentCandidate &&
            specifier.includes('observation') &&
            (!stateAdjacentObservationImportAllowlist.has(file) ||
              observationFreeOwnedFiles.has(file))
          )
            findings.push(`${file}: downstream state imports observation in G1-07`);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['info', 'warn', 'debug'].includes(node.expression.name.text) &&
          loggerBearing &&
          file !== 'packages/core/src/observation/logger-compat.ts'
        )
          findings.push(`${file}: free-form Logger.${node.expression.name.text}`);
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          loggerMethodAliases.has(node.expression.text) &&
          file !== 'packages/core/src/observation/logger-compat.ts'
        )
          findings.push(`${file}: destructured free-form Logger method`);
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['emit', 'complete'].includes(node.expression.name.text) &&
          source.includes('observation') &&
          !ts.isExpressionStatement(node.parent)
        )
          findings.push(`${file}: observation result can drive a decision`);
        if (
          file.startsWith('packages/core/src/observation/') &&
          (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
          /\bprocess(?:\.|\[['"])(?:stdout|stderr)/.test(node.getText(tree))
        )
          findings.push(`${file}: observation accesses process stream`);
        if (
          source.includes('observation') &&
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'begin' &&
          isDecisionUse(node)
        )
          findings.push(`${file}: direct observation begin can drive a decision`);
        if (ts.isIdentifier(node) && beginSpans.has(node.text) && isDecisionUse(node))
          findings.push(`${file}: observation span can drive a decision`);
        if (
          (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
          [
            'plan.created',
            'transaction.stage.started',
            'transaction.stage.completed',
            'transaction.committed',
            'transaction.rolled-back',
            'recovery.started',
            'recovery.completed',
          ].includes(node.text) &&
          !deferredEventLiteralAuthorities.has(file)
        )
          findings.push(`${file}: future event literal outside registry`);
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }

    const processWriteAllowlist = new Set([
      'packages/cli/src/runtime/io.ts',
      'packages/cli/src/output/error-boundary.ts',
      'packages/cli/src/index.ts',
    ]);
    for (const path of cliFiles) {
      const source = await readFile(path, 'utf8');
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const file = relative(ROOT, path);
      const processAliases = new Set(['process']);
      const streamAliases = new Set<string>();
      const collectAliases = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === 'node:process'
        ) {
          const clause = node.importClause;
          if (clause?.name) processAliases.add(clause.name.text);
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
            for (const element of clause.namedBindings.elements) {
              const imported = (element.propertyName ?? element.name).text;
              if (imported === 'stdout' || imported === 'stderr')
                streamAliases.add(element.name.text);
            }
        }
        if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
          if (ts.isIdentifier(node.name)) {
            const value = node.initializer.getText(tree);
            if (
              [...processAliases].some(
                (alias) =>
                  value === `${alias}.stdout` ||
                  value === `${alias}.stderr` ||
                  value === `${alias}['stdout']` ||
                  value === `${alias}['stderr']`,
              ) ||
              (ts.isIdentifier(node.initializer) && streamAliases.has(node.initializer.text))
            )
              streamAliases.add(node.name.text);
          }
          if (
            ts.isObjectBindingPattern(node.name) &&
            ts.isIdentifier(node.initializer) &&
            processAliases.has(node.initializer.text)
          )
            for (const element of node.name.elements) {
              const imported = (element.propertyName ?? element.name).getText(tree);
              if ((imported === 'stdout' || imported === 'stderr') && ts.isIdentifier(element.name))
                streamAliases.add(element.name.text);
            }
        }
        ts.forEachChild(node, collectAliases);
      };
      collectAliases(tree);
      const visit = (node: ts.Node): void => {
        if (
          file === 'packages/cli/src/runtime/diagnostics.ts' &&
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === 'node:process'
        )
          findings.push(`${file}: diagnostic sink imports process`);
        if (
          file === 'packages/cli/src/runtime/diagnostics.ts' &&
          (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
          /\bprocess(?:\.|\[['"])(?:stdout|stderr)/.test(node.getText(tree))
        )
          findings.push(`${file}: diagnostic sink accesses process stream`);
        if (
          ts.isCallExpression(node) &&
          ((ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'write' &&
            (streamAliases.has(node.expression.expression.getText(tree)) ||
              /process\.(?:stdout|stderr)$/.test(node.expression.expression.getText(tree)))) ||
            (ts.isElementAccessExpression(node.expression) &&
              node.expression.argumentExpression.getText(tree).replace(/["']/g, '') === 'write' &&
              streamAliases.has(node.expression.expression.getText(tree)))) &&
          !processWriteAllowlist.has(file)
        )
          findings.push(`${file}: process stream write outside adapter allowlist`);
        if (
          (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
          [
            'plan.created',
            'transaction.stage.started',
            'transaction.stage.completed',
            'transaction.committed',
            'transaction.rolled-back',
            'recovery.started',
            'recovery.completed',
          ].includes(node.text)
        )
          findings.push(`${file}: future event literal in CLI`);
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }

    const packageInventories = {
      'package.json': {
        dependencies: [],
        devDependencies: [
          '@skillsmith/core',
          '@biomejs/biome',
          '@commitlint/cli',
          '@commitlint/config-conventional',
          '@types/bun',
          '@types/node',
          '@typescript-eslint/parser',
          'eslint',
          'eslint-import-resolver-typescript',
          'eslint-plugin-import',
          'eslint-plugin-security',
          'lefthook',
          'typescript',
        ],
        scripts: [
          'dev',
          'test',
          'test:smoke',
          'test:smoke:p2-ts04',
          'test:smoke:p2-ts04:recovery',
          'typecheck',
          'lint',
          'lint:boundaries',
          'fmt',
          'actions-lint',
          'check:p17',
          'check',
          'build:darwin-arm64',
          'build:darwin-x64',
          'build:linux-x64',
          'build:linux-arm64',
          'build',
          'postinstall',
        ],
      },
      'packages/core/package.json': {
        dependencies: ['gray-matter', 'proper-lockfile', 'smol-toml', 'zod'],
        devDependencies: ['@types/proper-lockfile'],
        scripts: ['test'],
      },
      'packages/cli/package.json': {
        dependencies: [
          '@clack/prompts',
          '@skillsmith/core',
          'chalk',
          'commander',
          'consola',
          'zod',
        ],
        devDependencies: [],
        scripts: ['test'],
      },
    } as const;
    for (const [file, expected] of Object.entries(packageInventories)) {
      const manifest = JSON.parse(await readFile(join(ROOT, file), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      for (const key of ['dependencies', 'devDependencies', 'scripts'] as const)
        if (JSON.stringify(Object.keys(manifest[key] ?? {})) !== JSON.stringify(expected[key]))
          findings.push(`${file}: ${key} inventory changed`);
    }
    const expectedPaths = [
      'skillsmith',
      'skillsmith agents',
      'skillsmith check',
      'skillsmith commands',
      'skillsmith completion',
      'skillsmith config',
      'skillsmith config get',
      'skillsmith config list',
      'skillsmith config set',
      'skillsmith config unset',
      'skillsmith dev',
      'skillsmith doctor',
      'skillsmith help',
      'skillsmith install',
      'skillsmith list',
      'skillsmith promote',
      'skillsmith status',
      'skillsmith uninstall',
      'skillsmith verify',
      'skillsmith version',
    ];
    if (
      JSON.stringify(CURRENT_COMMAND_SPECS.map((spec) => spec.path)) !==
      JSON.stringify(expectedPaths)
    )
      findings.push('command registry: command inventory changed');
    if (CURRENT_COMMAND_SPECS.reduce((count, spec) => count + spec.options.length, 0) !== 171)
      findings.push('command registry: option inventory changed');
    const optionInventory = CURRENT_COMMAND_SPECS.flatMap((spec) =>
      spec.options.map((option) => [spec.path, option.flags]),
    );
    const optionHash = new Bun.CryptoHasher('sha256')
      .update(JSON.stringify(optionInventory))
      .digest('hex');
    if (optionHash !== '146574fb60b83f6f61b9aa4ff901bd94bdd80b6e867d14eb893fc2a1a22e0bc8')
      findings.push('command registry: option rows changed');
    const adr = await readFile(
      join(ROOT, 'docs/adr/0009-operation-scoped-observation.md'),
      'utf8',
    ).catch(() => null);
    if (adr === null) findings.push('missing ADR 0009 operation-scoped observation');
    expect(findings).toEqual([]);
  }, 60_000);
});
