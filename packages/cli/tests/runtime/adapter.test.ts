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
    options: [{ value: 'review', label: 'review' }],
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
      expect(await interaction.choose(choice)).toEqual({ kind: 'unavailable' });
      expect(await interaction.confirm(confirmation)).toEqual({ kind: 'answered', value: true });
    }
  });

  test('delegates only with both TTYs and converts an abort to cancellation', async () => {
    const calls: string[] = [];
    const interactive: InteractionPort = {
      choose: async <T>(request: { readonly options: readonly { readonly value: T }[] }) => {
        calls.push('choose');
        const selected = request.options[0];
        return selected === undefined
          ? { kind: 'unavailable' }
          : { kind: 'answered', value: selected.value };
      },
      confirm: async () => {
        calls.push('confirm');
        return { kind: 'answered', value: false };
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
    expect(await interaction.choose(choice)).toEqual({ kind: 'answered', value: 'review' });
    controller.abort();
    expect(await interaction.confirm(confirmation)).toEqual({ kind: 'cancelled' });
    expect(calls).toEqual(['choose']);

    expect(await noninteractiveInteraction().choose(choice)).toEqual({ kind: 'unavailable' });
  });
});
