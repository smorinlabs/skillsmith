import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createCliRuntimeAdapter } from '../../../packages/cli/src/runtime/adapter.ts';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/registry.ts';
import { validateOptionInvocation } from '../../../packages/cli/src/spec/relations.ts';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { defaultRuntimePorts } from '../../../packages/core/src/ports/default.ts';
import { ok } from '../../../packages/core/src/result.ts';
import { detectAll } from '../../../packages/core/src/scan/index.ts';
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
    env: hermeticGitEnv({ CI: '1', NO_COLOR: '1', ...env }),
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
      return 'operation-1';
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
  }, 20_000);

  test('family 2: correlates command/span lifecycle with independent clocks and deterministic error codes', async () => {
    const authority = await observationAuthority('ewp-p1-ts11-family-2');
    if (authority === null) return;
    const createEmitter = callable(authority.createObservationEmitter);
    expect(createEmitter, 'missing createObservationEmitter').not.toBeNull();
    if (createEmitter === null) return;
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
    expect(events[1]).toMatchObject({ outcome: 'success', exitClass: 'success', errorCode: null });

    const begin = callable(emitter.begin);
    const complete = callable(emitter.complete);
    expect(begin).not.toBeNull();
    expect(complete).not.toBeNull();
    if (begin === null || complete === null) return;
    built.setTime('2026-07-13T00:00:03.000Z', 40);
    const operationSpan = begin(built.context, {
      kind: 'operation.started',
      operationKind: 'inventory',
    });
    built.setTime('2026-07-13T00:00:04.000Z', 55);
    complete(operationSpan, {
      outcome: 'success',
      errorCode: null,
      standaloneCount: 1,
      bundledCount: 0,
      resultCount: 1,
    });
    expect(events.at(-1)).toMatchObject({ kind: 'operation.completed', durationMilliseconds: 15 });
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
        span = begin(built.context, { kind: 'command.started' });
      }).not.toThrow();
      expect(span).not.toBeNull();
      expect(() =>
        complete(span, { outcome: 'success', exitClass: 'success', errorCode: null }),
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
          text: 'before Bearer value-secret-canary after ghp_abcdefgh sk-abcdefgh',
          nearMiss: 'ghp_abcdefg sk-abcdefg',
        },
      ],
      accessor,
      proxy,
      sharedA: shared,
      sharedB: shared,
      cycle,
      nonfinite: Number.NaN,
      negativeZero: -0,
      bigint: 1n,
      fn: () => 'function-secret-canary',
      exotic: new Date(0),
    };
    const redacted = redact(input) as UnknownRecord;
    expect(Object.getPrototypeOf(redacted)).toBeNull();
    expect(Object.isFrozen(redacted)).toBeTrue();
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toMatch(
      /key-redaction-canary|value-secret-canary|getter-secret-canary|proxy-secret-canary|function-secret-canary/,
    );
    expect(JSON.stringify(redacted)).toContain('[REDACTED]');
    expect(JSON.stringify(redacted)).toContain('[ACCESSOR]');
    expect(JSON.stringify(redacted)).toContain('[PROXY]');
    expect(JSON.stringify(redacted)).toContain('[CIRCULAR]');
    expect(JSON.stringify(redacted)).toContain('[NON_FINITE]');
    expect(JSON.stringify(redacted)).toContain('[EXOTIC]');
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);
    expect((redacted.sharedA as object) === (redacted.sharedB as object)).toBeFalse();
    expect(Object.is((redacted as UnknownRecord).negativeZero, -0)).toBeTrue();
    const symbolKey = { safe: true, [Symbol('secret')]: 'symbol-secret-canary' };
    expect(redact(symbolKey)).toBe('[SYMBOL]');
    expect(input.authorization).toBe('Bearer key-redaction-canary');

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
    const ports = await defaultRuntimePorts();
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
      for (const event of events) observe?.(event);
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
    for (const path of coreFiles) {
      const source = await readFile(path, 'utf8');
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const file = relative(ROOT, path);
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
          const specifier = ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : node.moduleSpecifier.getText(tree);
          const importsLogger =
            specifier.endsWith('/env/logger.ts') ||
            node.importClause?.getText(tree).match(/\bLogger\b/) !== null;
          if (importsLogger && !loggerImportAllowlist.has(file))
            findings.push(`${file}: Logger import outside compatibility allowlist`);
          if (
            file.startsWith('packages/core/src/observation/') &&
            /(?:place|acquire|persist|journal|repository|packages\/cli|node:process)/.test(
              specifier,
            )
          )
            findings.push(`${file}: forbidden observation dependency ${specifier}`);
          if (
            /(?:place|acquire|persist|journal|repository|coordinator)/.test(file) &&
            specifier.includes('observation')
          )
            findings.push(`${file}: downstream state imports observation in G1-07`);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['info', 'warn', 'debug'].includes(node.expression.name.text) &&
          /(?:^|\.)logger$/i.test(node.expression.expression.getText(tree)) &&
          file !== 'packages/core/src/observation/logger-compat.ts'
        )
          findings.push(`${file}: free-form Logger.${node.expression.name.text}`);
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['emit', 'complete'].includes(node.expression.name.text) &&
          source.includes('observation') &&
          !ts.isExpressionStatement(node.parent)
        )
          findings.push(`${file}: observation result can drive a decision`);
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
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'write' &&
          /process\.(?:stdout|stderr)$/.test(node.expression.expression.getText(tree)) &&
          !processWriteAllowlist.has(file)
        )
          findings.push(`${file}: process stream write outside adapter allowlist`);
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }

    const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ])
      if (/(?:telemetry|opentelemetry|logging|logger)/i.test(name))
        findings.push(`package.json: forbidden observability dependency ${name}`);
    for (const name of Object.keys(packageJson.scripts ?? {}))
      if (/^(?:log|trace|telemetry)(?::|$)/i.test(name))
        findings.push(`package.json: forbidden observability script ${name}`);
    if (CURRENT_COMMAND_SPECS.some((spec) => /skillsmith (?:log|trace)$/.test(spec.path)))
      findings.push('command registry: forbidden log/trace command');
    if (
      CURRENT_COMMAND_SPECS.some((spec) =>
        spec.options.some((option) => /--(?:log|trace|telemetry)$/.test(option.long)),
      )
    )
      findings.push('command registry: forbidden log/trace/telemetry option');
    const adr = await readFile(
      join(ROOT, 'docs/adr/0009-operation-scoped-observation.md'),
      'utf8',
    ).catch(() => null);
    if (adr === null) findings.push('missing ADR 0009 operation-scoped observation');
    expect(findings).toEqual([]);
  });
});
