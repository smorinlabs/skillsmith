import { describe, expect, test } from 'bun:test';
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
      format: 'human',
    });
    expect(humanResult).toMatchObject({
      exitCode: 1,
      failure: { exitClass: 'failure', code: 'generic', message: 'forged line' },
    });
    expect(human.stdout).toEqual([]);
    expect(human.stderr).toEqual(['error: forged line\n']);
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
      format: 'human',
    });
    expect(result.exitCode).toBe(4);
    expect(memory.stdout).toEqual(['capability report\n']);
    expect(memory.stderr).toEqual(['error: unavailable\n']);
    expect(memory.exits).toEqual([4]);
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
