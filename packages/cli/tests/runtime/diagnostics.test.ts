import { describe, expect, test } from 'bun:test';
import { createObserverEvent, createOperationContext } from '@skillsmith/core';
import {
  createCliDiagnosticObserver,
  resolveObservationVerbosity,
} from '../../src/runtime/diagnostics.ts';
import type { CliRuntimeIo } from '../../src/runtime/io.ts';

const memoryIo = () => {
  const stderr: string[] = [];
  const io: CliRuntimeIo = {
    stdout: { write: () => {} },
    stderr: { write: (value) => stderr.push(value) },
    exit: () => {},
  };
  return { io, stderr };
};

const operation = () => {
  let wall = '2026-07-13T00:00:00.000Z';
  let monotonic = 10;
  const context = createOperationContext({
    command: 'skillsmith fixture',
    workflow: 'fixture',
    operationId: 'fixture-operation',
    clock: {
      wallNowIso: () => wall,
      monotonicMilliseconds: () => monotonic,
    },
    id: { nextId: () => 'unused' },
  });
  return {
    context,
    setTime: (nextWall: string, nextMonotonic: number) => {
      wall = nextWall;
      monotonic = nextMonotonic;
    },
  };
};

describe('CLI observation diagnostics', () => {
  test('resolves the inherited quiet/verbose/trace/debug policy', () => {
    expect(resolveObservationVerbosity({})).toBe('normal');
    expect(resolveObservationVerbosity({ quiet: true })).toBe('quiet');
    expect(resolveObservationVerbosity({ verbose: 1 })).toBe('verbose');
    expect(resolveObservationVerbosity({ verbose: 2 })).toBe('trace');
    expect(resolveObservationVerbosity({ verbose: 1, debug: true })).toBe('debug');
  });

  test('renders stable detail and trace lines while normal and quiet stay silent', () => {
    const built = operation();
    built.setTime('2026-07-13T00:00:01.000Z', 20);
    const command = createObserverEvent(built.context, {
      kind: 'command.started',
    });
    const detection = createObserverEvent(built.context, {
      kind: 'tool.detection.started',
      toolId: 'fixture-tool',
    });

    for (const verbosity of ['normal', 'quiet'] as const) {
      const memory = memoryIo();
      const observer = createCliDiagnosticObserver(memory.io, verbosity);
      observer.observe(command);
      observer.observe(detection);
      expect(memory.stderr).toEqual([]);
    }

    const detail = memoryIo();
    const detailObserver = createCliDiagnosticObserver(detail.io, 'verbose');
    detailObserver.observe(command);
    detailObserver.observe(detection);
    expect(detail.stderr).toEqual([
      'detail: command.started operation=fixture-operation command="skillsmith fixture"\n',
    ]);

    const trace = memoryIo();
    createCliDiagnosticObserver(trace.io, 'trace').observe(detection);
    expect(trace.stderr).toEqual([
      'trace: tool.detection.started operation=fixture-operation parent=- group=- pair=- attempt=1 at=2026-07-13T00:00:01.000Z monoMs=20 toolId=fixture-tool\n',
    ]);
  });

  test('debug emits one compact, recursively redacted JSON event', () => {
    const built = operation();
    const event = createObserverEvent(built.context, {
      kind: 'plan.created',
      planId: 'Bearer sink-secret-canary',
      operationCount: 1,
    });
    const memory = memoryIo();
    createCliDiagnosticObserver(memory.io, 'debug').observe(event);

    expect(memory.stderr).toHaveLength(1);
    expect(memory.stderr[0]).not.toContain('sink-secret-canary');
    const parsed = JSON.parse(memory.stderr[0]?.slice('debug: '.length) ?? '{}');
    expect(parsed).toMatchObject({
      kind: 'plan.created',
      planId: '[REDACTED]',
      operationCount: 1,
    });
  });

  test('escapes every raw Unicode line separator in detail, trace, and debug output', () => {
    const built = operation();
    const planId = 'before\u0085next\u009bcontrol\u2028forged\u2029tail';
    const event = createObserverEvent(built.context, {
      kind: 'plan.created',
      planId,
      operationCount: 1,
    });

    for (const verbosity of ['verbose', 'trace', 'debug'] as const) {
      const memory = memoryIo();
      createCliDiagnosticObserver(memory.io, verbosity).observe(event);
      expect(memory.stderr).toHaveLength(1);
      const line = memory.stderr[0] ?? '';
      expect(line.endsWith('\n')).toBeTrue();
      expect(line.slice(0, -1)).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
      expect(line).toContain('\\u0085');
      expect(line).toContain('\\u009b');
      expect(line).toContain('\\u2028');
      expect(line).toContain('\\u2029');
      if (verbosity === 'debug') {
        const parsed = JSON.parse(line.slice('debug: '.length));
        expect(parsed.planId).toBe(planId);
      }
    }
  });
});
