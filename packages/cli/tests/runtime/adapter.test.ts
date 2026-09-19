import { describe, expect, test } from 'bun:test';
import type { ObservationBundle } from '@skillsmith/core';
import {
  type RuntimeExitClass,
  type RuntimeOutcome,
  createCliRuntimeAdapter,
  exitCodeForClass,
} from '../../src/runtime/adapter.ts';
import {
  type InteractionPort,
  createPolicyInteraction,
  noninteractiveInteraction,
  resolveInteractionPolicy,
} from '../../src/runtime/interaction.ts';
import type { CliRuntimeIo } from '../../src/runtime/io.ts';

const successOutcome = (report: unknown = { value: 1 }): RuntimeOutcome => ({
  report,
  diagnostics: [],
  exitClass: 'success',
  mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
  deprecations: [],
});

const silentObservation = (): ObservationBundle =>
  ({
    context: {},
    emitter: { begin: () => null, complete: () => {}, emit: () => {} },
  }) as unknown as ObservationBundle;

const recordingObservation = (): {
  readonly observation: ObservationBundle;
  readonly completions: Record<string, unknown>[];
} => {
  const completions: Record<string, unknown>[] = [];
  return {
    completions,
    observation: {
      context: {},
      emitter: {
        begin: () => Object.freeze({}),
        complete: (_span: unknown, input: Record<string, unknown>) => completions.push(input),
        emit: () => {},
      },
    } as unknown as ObservationBundle,
  };
};

const memoryIo = (): {
  readonly io: CliRuntimeIo;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exits: number[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  return {
    stdout,
    stderr,
    exits,
    io: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
      exit: (code) => exits.push(code),
    },
  };
};

describe('shared CLI runtime adapter', () => {
  test('maps every semantic outcome class without numeric application policy', () => {
    const cases = [
      ['success', 0],
      ['failure', 1],
      ['usage', 2],
      ['state', 3],
      ['capability', 4],
      ['source', 5],
      ['permission', 6],
      ['drift', 7],
      ['cancelled', 130],
    ] as const satisfies readonly (readonly [RuntimeExitClass, number])[];
    for (const [exitClass, exitCode] of cases) expect(exitCodeForClass(exitClass)).toBe(exitCode);
  });

  test('selects the registered renderer and emits through injected IO only', async () => {
    for (const format of ['human', 'json'] as const) {
      const memory = memoryIo();
      const runtime = createCliRuntimeAdapter({
        applications: {
          fixture: async (request) => ({ ok: true, value: successOutcome(request) }),
        },
        renderers: {
          fixture: {
            human: (outcome) => `human:${JSON.stringify(outcome.report)}\n`,
            json: (outcome) => `${JSON.stringify({ kind: 'fixture', report: outcome.report })}\n`,
          },
        },
        io: memory.io,
      });

      const result = await runtime.execute({
        application: 'fixture',
        reportKind: 'fixture',
        request: { selected: true },
        context: { ignored: true },
        observation: silentObservation(),
        format,
      });

      expect(result.exitCode).toBe(0);
      expect(memory.stderr).toEqual([]);
      expect(memory.exits).toEqual([0]);
      expect(memory.stdout.join('')).toContain(format === 'human' ? 'human:' : '"kind":"fixture"');
    }
  });

  test('normalizes returned, thrown, and registry failures through one failure path', async () => {
    const cases = [
      {
        application: 'returned',
        service: async () => ({ ok: false as const, error: new Error('returned failure\nforged') }),
      },
      {
        application: 'thrown',
        service: async () => {
          throw new Error('thrown failure');
        },
      },
    ] as const;

    for (const fixture of cases) {
      const memory = memoryIo();
      const runtime = createCliRuntimeAdapter({
        applications: { [fixture.application]: fixture.service },
        renderers: {},
        io: memory.io,
      });
      const result = await runtime.execute({
        application: fixture.application,
        reportKind: 'unused',
        request: {},
        context: {},
        observation: silentObservation(),
        format: 'human',
      });
      expect(result.exitCode).toBe(1);
      expect(memory.stdout).toEqual([]);
      expect(memory.stderr.join('').split('\n')).toHaveLength(2);
      expect(memory.stderr.join('')).not.toContain('failure\nforged');
      expect(memory.exits).toEqual([1]);
    }

    const missing = memoryIo();
    const runtime = createCliRuntimeAdapter({ applications: {}, renderers: {}, io: missing.io });
    const result = await runtime.execute({
      application: 'missing',
      reportKind: 'missing',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'json',
    });
    expect(result.exitCode).toBe(1);
    expect(missing.stderr).toEqual([]);
    expect(missing.stdout).toHaveLength(1);
    expect(JSON.parse(missing.stdout[0] ?? '{}')).toMatchObject({
      schemaVersion: 1,
      kind: 'error',
      exitCode: 1,
    });
  });

  test('contains hostile failures and return values while retaining safe semantic exits', async () => {
    const hostile = new Proxy(
      {
        message: '\u001B[31mforged\r\nline\t\u001B[0m',
      },
      {
        get(target, key, receiver) {
          if (key === 'exitClass' || key === 'code' || key === 'name') {
            throw new Error(`hostile ${String(key)} getter`);
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const human = memoryIo();
    const humanRuntime = createCliRuntimeAdapter({
      applications: {
        hostile: async () => {
          throw hostile;
        },
      },
      renderers: {},
      io: human.io,
    });
    const humanResult = await humanRuntime.execute({
      application: 'hostile',
      reportKind: 'unused',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'human',
    });
    expect(humanResult).toMatchObject({
      exitCode: 1,
      failure: { exitClass: 'failure', code: 'generic', message: '[PROXY]' },
    });
    expect(human.stdout).toEqual([]);
    expect(human.stderr).toEqual(['error: [PROXY]\n']);
    expect(human.exits).toEqual([1]);

    const returned = memoryIo();
    const returnedRuntime = createCliRuntimeAdapter({
      applications: {
        hostile: async () =>
          new Proxy(
            { ok: false as const, error: new Error('unreachable') },
            {
              has() {
                throw new Error('hostile return-value trap\r\nforged');
              },
            },
          ),
      },
      renderers: {},
      io: returned.io,
    });
    const returnedResult = await returnedRuntime.execute({
      application: 'hostile',
      reportKind: 'unused',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'human',
    });
    expect(returnedResult).toMatchObject({
      exitCode: 1,
      failure: {
        exitClass: 'failure',
        code: 'generic',
        message: 'hostile return-value trap forged',
      },
    });
    expect(returned.stdout).toEqual([]);
    expect(returned.stderr).toEqual(['error: hostile return-value trap forged\n']);
    expect(returned.exits).toEqual([1]);

    const json = memoryIo();
    const jsonRuntime = createCliRuntimeAdapter({
      applications: {
        hostile: async () => {
          throw {
            exitClass: 'permission',
            code: 'bad code\r\n"x',
            message: '\u001B[31mdenied\r\nforged\tfield\u001B[0m',
          };
        },
      },
      renderers: {},
      io: json.io,
    });
    const jsonResult = await jsonRuntime.execute({
      application: 'hostile',
      reportKind: 'unused',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'json',
    });
    expect(jsonResult).toMatchObject({
      exitCode: 6,
      failure: { exitClass: 'permission', code: 'bad-code-x', message: 'denied forged field' },
    });
    expect(json.stderr).toEqual([]);
    expect(json.stdout).toEqual([
      '{"schemaVersion":1,"kind":"error","code":"bad-code-x","message":"denied forged field","exitCode":6}\n',
    ]);
    expect(json.exits).toEqual([6]);
  });

  test('contains renderer failures in the requested output format', async () => {
    const human = memoryIo();
    const humanRuntime = createCliRuntimeAdapter({
      applications: { fixture: async () => successOutcome() },
      renderers: {
        fixture: {
          human: () => {
            throw new Error('\u001B[31mrenderer\r\nfailed\tbadly\u001B[0m');
          },
          json: () => '',
        },
      },
      io: human.io,
    });
    const humanResult = await humanRuntime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'human',
    });
    expect(humanResult).toMatchObject({
      exitCode: 1,
      failure: { exitClass: 'failure', code: 'generic', message: 'renderer failed badly' },
    });
    expect(human.stdout).toEqual([]);
    expect(human.stderr).toEqual(['error: renderer failed badly\n']);
    expect(human.exits).toEqual([1]);

    const json = memoryIo();
    const jsonRuntime = createCliRuntimeAdapter({
      applications: { fixture: async () => successOutcome() },
      renderers: {
        fixture: {
          human: () => '',
          json: () => {
            throw {
              exitClass: 'capability',
              code: 'renderer code\r\nunsafe',
              message: '\u001B[33mJSON renderer\r\nfailed\u001B[0m',
            };
          },
        },
      },
      io: json.io,
    });
    const jsonResult = await jsonRuntime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'json',
    });
    expect(jsonResult).toMatchObject({
      exitCode: 4,
      failure: {
        exitClass: 'capability',
        code: 'renderer-code-unsafe',
        message: 'JSON renderer failed',
      },
    });
    expect(json.stderr).toEqual([]);
    expect(json.stdout).toEqual([
      '{"schemaVersion":1,"kind":"error","code":"renderer-code-unsafe","message":"JSON renderer failed","exitCode":4}\n',
    ]);
    expect(json.exits).toEqual([4]);
  });

  test('honors a semantic failure outcome after rendering its report', async () => {
    const memory = memoryIo();
    const runtime = createCliRuntimeAdapter({
      applications: {
        fixture: async () => ({ ...successOutcome(), exitClass: 'capability' }),
      },
      renderers: {
        fixture: {
          human: () => ({ stdout: 'capability report\n', stderr: 'error: unavailable\n' }),
          json: () => '{"kind":"capability-report"}\n',
        },
      },
      io: memory.io,
    });
    const result = await runtime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'human',
    });
    expect(result.exitCode).toBe(4);
    expect(memory.stdout).toEqual(['capability report\n']);
    expect(memory.stderr).toEqual(['error: unavailable\n']);
    expect(memory.exits).toEqual([4]);
  });

  test('freezes semantic completion before rendering and contains hostile diagnostic reads', async () => {
    const diagnostics: Array<{ code: string; severity: 'error'; message: string }> = [];
    const recorded = recordingObservation();
    const memory = memoryIo();
    const runtime = createCliRuntimeAdapter({
      applications: {
        fixture: async () => ({
          ...successOutcome(),
          diagnostics,
          exitClass: 'failure' as const,
        }),
      },
      renderers: {
        fixture: {
          human: (outcome) => {
            diagnostics.push({ severity: 'error', code: 'renderer-owned', message: 'forged' });
            (outcome as { exitClass: RuntimeExitClass }).exitClass = 'success';
            return 'failure report\n';
          },
          json: () => '',
        },
      },
      io: memory.io,
    });

    const result = await runtime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: recorded.observation,
      format: 'human',
    });
    expect(result.exitCode).toBe(1);
    expect(result.outcome?.exitClass).toBe('failure');
    expect(memory.stdout).toEqual(['failure report\n']);
    expect(memory.exits).toEqual([1]);
    expect(recorded.completions).toEqual([
      { outcome: 'failure', exitClass: 'failure', errorCode: 'command-failed' },
    ]);

    const hostileDiagnostic = {
      code: 'hostile-code',
      severity: 'error' as const,
      message: 'hostile',
    };
    Object.defineProperty(hostileDiagnostic, 'severity', {
      enumerable: true,
      get: () => {
        throw new Error('hostile severity');
      },
    });
    const hostileRecorded = recordingObservation();
    const hostileMemory = memoryIo();
    const hostileRuntime = createCliRuntimeAdapter({
      applications: {
        fixture: async () => ({
          ...successOutcome(),
          diagnostics: [hostileDiagnostic],
          exitClass: 'failure' as const,
        }),
      },
      renderers: { fixture: { human: () => 'unreachable\n', json: () => '' } },
      io: hostileMemory.io,
    });
    const hostileResult = await hostileRuntime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: hostileRecorded.observation,
      format: 'human',
    });
    expect(hostileResult).toMatchObject({
      exitCode: 1,
      failure: { code: 'generic', message: 'hostile severity' },
    });
    expect(hostileMemory.stdout).toEqual([]);
    expect(hostileMemory.stderr).toEqual(['error: hostile severity\n']);
    expect(hostileMemory.exits).toEqual([1]);
    expect(hostileRecorded.completions).toEqual([
      { outcome: 'failure', exitClass: 'failure', errorCode: 'generic' },
    ]);
  });

  test('recursively owns and freezes outcome data before hostile renderer access', async () => {
    const report = {
      nested: { value: 'original' },
      entries: [{ value: 'first' }],
    };
    const diagnostics = [
      {
        code: 'warning-code',
        severity: 'warning' as const,
        message: 'original warning',
        details: { source: 'application' },
      },
    ];
    const mutation = { kind: 'preview' as const, planned: 1, changed: 0, unchanged: 1, failed: 0 };
    const deprecations = [
      {
        spelling: '--old',
        replacement: '--new',
        removalVersion: '2.0',
        message: 'original deprecation',
      },
    ];
    const rendererMutations: string[] = [];
    const attempt = (label: string, mutate: () => void): void => {
      mutate();
      rendererMutations.push(label);
    };
    const memory = memoryIo();
    const runtime = createCliRuntimeAdapter({
      applications: {
        fixture: async () => ({
          report,
          diagnostics,
          exitClass: 'success' as const,
          mutation,
          deprecations,
        }),
      },
      renderers: {
        fixture: {
          human: (outcome) => {
            const ownedReport = outcome.report as {
              nested: { value: string };
              entries: Array<{ value: string }>;
            };
            attempt('report object', () => {
              ownedReport.nested.value = 'renderer-owned';
            });
            attempt('report array', () => {
              ownedReport.entries.push({ value: 'renderer-owned' });
            });
            attempt('report array item', () => {
              const first = ownedReport.entries[0];
              if (first !== undefined) first.value = 'renderer-owned';
            });
            attempt('diagnostics array', () => {
              (outcome.diagnostics as unknown[]).push({});
            });
            attempt('diagnostic object', () => {
              const diagnostic = outcome.diagnostics[0];
              if (diagnostic !== undefined)
                (diagnostic as { message: string }).message = 'renderer-owned';
            });
            attempt('diagnostic details', () => {
              const diagnostic = outcome.diagnostics[0];
              if (diagnostic?.details !== undefined)
                (diagnostic.details as { source: string }).source = 'renderer-owned';
            });
            attempt('mutation object', () => {
              (outcome.mutation as { planned: number }).planned = 99;
            });
            attempt('deprecations array', () => {
              (outcome.deprecations as unknown[]).push({});
            });
            attempt('deprecation object', () => {
              const deprecation = outcome.deprecations[0];
              if (deprecation !== undefined)
                (deprecation as { message: string }).message = 'renderer-owned';
            });
            return 'stable renderer bytes\n';
          },
          json: () => '',
        },
      },
      io: memory.io,
    });

    const result = await runtime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'human',
    });

    expect(rendererMutations).toEqual([
      'report object',
      'report array',
      'report array item',
      'diagnostics array',
      'diagnostic object',
      'diagnostic details',
      'mutation object',
      'deprecations array',
      'deprecation object',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toEqual({
      report: { nested: { value: 'original' }, entries: [{ value: 'first' }] },
      diagnostics: [
        {
          code: 'warning-code',
          severity: 'warning',
          message: 'original warning',
          details: { source: 'application' },
        },
      ],
      exitClass: 'success',
      mutation: { kind: 'preview', planned: 1, changed: 0, unchanged: 1, failed: 0 },
      deprecations: [
        {
          spelling: '--old',
          replacement: '--new',
          removalVersion: '2.0',
          message: 'original deprecation',
        },
      ],
    });
    expect(Object.isFrozen(result.outcome)).toBeTrue();
    expect(Object.isFrozen(result.outcome?.report)).toBeTrue();
    expect(
      Object.isFrozen((result.outcome?.report as { nested?: unknown } | undefined)?.nested),
    ).toBeTrue();
    expect(Object.isFrozen(result.outcome?.diagnostics)).toBeTrue();
    expect(Object.isFrozen(result.outcome?.diagnostics[0])).toBeTrue();
    expect(Object.isFrozen(result.outcome?.diagnostics[0]?.details)).toBeTrue();
    expect(Object.isFrozen(result.outcome?.mutation)).toBeTrue();
    expect(Object.isFrozen(result.outcome?.deprecations)).toBeTrue();
    expect(Object.isFrozen(result.outcome?.deprecations[0])).toBeTrue();
    expect(memory.stdout).toEqual(['stable renderer bytes\n']);
    expect(memory.exits).toEqual([0]);
  });

  test('snapshots Map-backed immutable proxies through the ReadonlyMap contract', async () => {
    const backing = new Map([['codex', [{ path: '/usr/bin/codex' }]]]);
    const immutable = new Proxy(backing, {
      get(target, key) {
        if (key === 'set' || key === 'delete' || key === 'clear') {
          return () => {
            throw new TypeError('immutable map');
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const memory = memoryIo();
    const runtime = createCliRuntimeAdapter({
      applications: { fixture: async () => successOutcome({ detections: immutable }) },
      renderers: {
        fixture: {
          human: (outcome) => {
            const detections = (outcome.report as { detections: ReadonlyMap<string, unknown> })
              .detections;
            return `${detections.get('codex') === undefined ? 'missing' : 'detected'}\n`;
          },
          json: () => '',
        },
      },
      io: memory.io,
    });

    const result = await runtime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'human',
    });

    expect(result.exitCode).toBe(0);
    expect(memory.stdout).toEqual(['detected\n']);
    expect(memory.stderr).toEqual([]);
    expect(memory.exits).toEqual([0]);
    expect(
      (result.outcome?.report as { detections: ReadonlyMap<string, unknown> }).detections,
    ).not.toBe(immutable);
    expect(
      Object.isFrozen(
        (result.outcome?.report as { detections: ReadonlyMap<string, unknown> }).detections,
      ),
    ).toBeTrue();
  });

  test('contains hostile nested snapshot reads through the failure boundary', async () => {
    const nested = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        throw new Error('hostile nested snapshot');
      },
    });
    let rendererCalled = false;
    const memory = memoryIo();
    const runtime = createCliRuntimeAdapter({
      applications: { fixture: async () => successOutcome({ nested }) },
      renderers: {
        fixture: {
          human: () => {
            rendererCalled = true;
            return 'unreachable\n';
          },
          json: () => '',
        },
      },
      io: memory.io,
    });

    await expect(
      runtime.execute({
        application: 'fixture',
        reportKind: 'fixture',
        request: {},
        context: {},
        observation: silentObservation(),
        format: 'human',
      }),
    ).resolves.toMatchObject({
      exitCode: 1,
      failure: { exitClass: 'failure', message: 'hostile nested snapshot' },
    });
    expect(rendererCalled).toBeFalse();
    expect(memory.stdout).toEqual([]);
    expect(memory.stderr).toEqual(['error: hostile nested snapshot\n']);
    expect(memory.exits).toEqual([1]);
  });

  test('preserves the current ReadonlyMap report contract in the owned snapshot', async () => {
    const records = [{ path: '/original', version: '1.0.0' }];
    const detections = new Map([['codex', records]]);
    const memory = memoryIo();
    const runtime = createCliRuntimeAdapter({
      applications: {
        fixture: async () => successOutcome({ detections }),
      },
      renderers: {
        fixture: {
          human: (outcome) =>
            `${JSON.stringify([...(outcome.report as { detections: ReadonlyMap<string, unknown> }).detections])}\n`,
          json: () => '',
        },
      },
      io: memory.io,
    });

    const result = await runtime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'human',
    });
    records[0] = { path: '/changed', version: '2.0.0' };
    detections.set('claude-code', []);

    const stableDetections = (
      result.outcome?.report as { detections?: ReadonlyMap<string, readonly unknown[]> } | undefined
    )?.detections;
    expect(stableDetections?.size).toBe(1);
    expect(stableDetections?.get('codex')).toEqual([{ path: '/original', version: '1.0.0' }]);
    expect([...(stableDetections ?? [])]).toEqual([
      ['codex', [{ path: '/original', version: '1.0.0' }]],
    ]);
    expect(Object.isFrozen(stableDetections)).toBeTrue();
    expect(Object.isFrozen(stableDetections?.get('codex'))).toBeTrue();
    expect(() => Map.prototype.set.call(stableDetections, 'forged', [])).toThrow();
    expect(memory.stdout).toEqual(['[["codex",[{"path":"/original","version":"1.0.0"}]]]\n']);
    expect(memory.exits).toEqual([0]);
  });

  test('owns renderer output, failure classification, and registry reads before effects', async () => {
    const outputMemory = memoryIo();
    const outputRecorded = recordingObservation();
    const outputRuntime = createCliRuntimeAdapter({
      applications: { fixture: async () => successOutcome() },
      renderers: {
        fixture: {
          human: () =>
            new Proxy(
              {},
              {
                get: () => {
                  throw new Error('hostile output getter');
                },
              },
            ),
          json: () => '',
        },
      },
      io: outputMemory.io,
    });
    await expect(
      outputRuntime.execute({
        application: 'fixture',
        reportKind: 'fixture',
        request: {},
        context: {},
        observation: outputRecorded.observation,
        format: 'human',
      }),
    ).resolves.toMatchObject({
      exitCode: 1,
      failure: { exitClass: 'failure', message: 'hostile output getter' },
    });
    expect(outputMemory.stdout).toEqual([]);
    expect(outputMemory.stderr).toEqual(['error: hostile output getter\n']);
    expect(outputMemory.exits).toEqual([1]);
    expect(outputRecorded.completions).toEqual([
      { outcome: 'failure', exitClass: 'failure', errorCode: 'generic' },
    ]);

    const mutationMemory = memoryIo();
    const mutationRuntime = createCliRuntimeAdapter({
      applications: {
        fixture: async () => {
          throw { exitClass: 'permission', code: 'denied', message: 'denied' };
        },
      },
      renderers: {},
      renderFailure: (failure) => {
        (failure as { exitClass: RuntimeExitClass }).exitClass = 'success';
        (failure as { code: string }).code = 'forged';
        return { stderr: 'custom failure\n' };
      },
      io: mutationMemory.io,
    });
    const mutationResult = await mutationRuntime.execute({
      application: 'fixture',
      reportKind: 'unused',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'human',
    });
    expect(mutationResult).toMatchObject({
      exitCode: 6,
      failure: { exitClass: 'permission', code: 'denied' },
    });
    expect(mutationMemory.stderr).toEqual(['custom failure\n']);
    expect(mutationMemory.exits).toEqual([6]);

    for (const classifyFailure of [
      () => ({ exitClass: 'bogus', code: 'bad', message: 'bad' }),
      () =>
        new Proxy(
          {},
          {
            get: () => {
              throw new Error('hostile classifier getter');
            },
          },
        ),
    ]) {
      const classifierMemory = memoryIo();
      const runtime = createCliRuntimeAdapter({
        applications: {
          fixture: async () => {
            throw new Error('application failed');
          },
        },
        renderers: {},
        classifyFailure: classifyFailure as never,
        io: classifierMemory.io,
      });
      const result = await runtime.execute({
        application: 'fixture',
        reportKind: 'unused',
        request: {},
        context: {},
        observation: silentObservation(),
        format: 'human',
      });
      expect(result.exitCode).toBe(1);
      expect(classifierMemory.exits).toEqual([1]);
    }

    for (const registry of ['applications', 'renderers'] as const) {
      const registryMemory = memoryIo();
      const hostileRegistry = new Proxy(
        {},
        {
          get: () => {
            throw new Error(`hostile ${registry} registry`);
          },
        },
      );
      const runtime = createCliRuntimeAdapter({
        applications:
          registry === 'applications' ? hostileRegistry : { fixture: async () => successOutcome() },
        renderers:
          registry === 'renderers'
            ? hostileRegistry
            : { fixture: { human: () => '', json: () => '' } },
        io: registryMemory.io,
      });
      const result = await runtime.execute({
        application: 'fixture',
        reportKind: 'fixture',
        request: {},
        context: {},
        observation: silentObservation(),
        format: 'human',
      });
      expect(result.exitCode).toBe(1);
      expect(registryMemory.stderr[0]).toContain(`hostile ${registry} registry`);
      expect(registryMemory.exits).toEqual([1]);
    }
  });

  test('isolates diagnostic buffer flush and discard failures from output and exit semantics', async () => {
    const successMemory = memoryIo();
    const successCalls: string[] = [];
    const successRuntime = createCliRuntimeAdapter({
      applications: { fixture: async () => successOutcome() },
      renderers: { fixture: { human: () => 'success\n', json: () => '' } },
      io: successMemory.io,
    });
    await expect(
      successRuntime.execute({
        application: 'fixture',
        reportKind: 'fixture',
        request: {},
        context: {},
        observation: silentObservation(),
        format: 'human',
        diagnosticBuffer: {
          flush: () => {
            successCalls.push('flush');
            throw new Error('flush failed');
          },
          discard: () => successCalls.push('discard'),
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(successCalls).toEqual(['flush']);
    expect(successMemory.stdout).toEqual(['success\n']);
    expect(successMemory.exits).toEqual([0]);

    const failureMemory = memoryIo();
    const failureCalls: string[] = [];
    const failureRuntime = createCliRuntimeAdapter({
      applications: {
        fixture: async () => {
          throw new Error('application failed');
        },
      },
      renderers: {},
      io: failureMemory.io,
    });
    await expect(
      failureRuntime.execute({
        application: 'fixture',
        reportKind: 'fixture',
        request: {},
        context: {},
        observation: silentObservation(),
        format: 'json',
        diagnosticBuffer: {
          flush: () => failureCalls.push('flush'),
          discard: () => {
            failureCalls.push('discard');
            throw new Error('discard failed');
          },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(failureCalls).toEqual(['discard']);
    expect(failureMemory.stderr).toEqual([]);
    expect(JSON.parse(failureMemory.stdout.join(''))).toMatchObject({
      kind: 'error',
      exitCode: 1,
    });
    expect(failureMemory.exits).toEqual([1]);
  });
});

describe('shared interaction policy', () => {
  const choice = {
    id: 'skill',
    message: 'Choose a skill',
    choices: [{ value: 'review', label: 'review' }],
  } as const;
  const confirmation = { id: 'apply', message: 'Apply changes?' } as const;

  test('keeps JSON and no-prompt noninteractive while yes confirms but never chooses', async () => {
    for (const input of [
      { json: true, noPrompt: false },
      { json: false, noPrompt: true },
    ]) {
      const policy = resolveInteractionPolicy({
        ...input,
        yes: true,
        stdinIsTTY: true,
        stderrIsTTY: true,
      });
      const interaction = createPolicyInteraction(policy);
      expect(await interaction.choose(choice)).toEqual({
        status: 'refused',
        reason: 'interactive input is unavailable',
      });
      expect(await interaction.confirm(confirmation)).toEqual({ status: 'resolved', value: true });
    }
  });

  test('delegates only with both TTYs and converts an abort to cancellation', async () => {
    const calls: string[] = [];
    const interactive: InteractionPort = {
      mode: 'interactive',
      choose: async <T>(request: { readonly choices: readonly { readonly value: T }[] }) => {
        calls.push('choose');
        const selected = request.choices[0];
        return selected === undefined
          ? { status: 'refused', reason: 'empty' }
          : { status: 'resolved', value: selected.value };
      },
      confirm: async () => {
        calls.push('confirm');
        return { status: 'resolved', value: false };
      },
    };
    const controller = new AbortController();
    const interaction = createPolicyInteraction(
      resolveInteractionPolicy({
        json: false,
        noPrompt: false,
        yes: false,
        stdinIsTTY: true,
        stderrIsTTY: true,
        signal: controller.signal,
      }),
      interactive,
    );
    expect(await interaction.choose(choice)).toEqual({ status: 'resolved', value: 'review' });
    controller.abort();
    expect(await interaction.confirm(confirmation)).toEqual({ status: 'cancelled' });
    expect(calls).toEqual(['choose']);

    expect(await noninteractiveInteraction().choose(choice)).toEqual({
      status: 'refused',
      reason: 'interactive input is unavailable',
    });
  });
});
