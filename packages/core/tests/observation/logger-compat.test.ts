import { describe, expect, test } from 'bun:test';
import { observationFromLegacyLogger } from '../../src/observation/index.ts';
import { resolveObservationBundle } from '../../src/observation/logger-compat.ts';

describe('legacy Logger observation adapter', () => {
  test('reproduces detection debug and warning messages without exposing synthetic identity', () => {
    const calls: Array<readonly [string, string, unknown?]> = [];
    const observation = observationFromLegacyLogger(
      {
        debug: (message, metadata) => calls.push(['debug', message, metadata]),
        info: (message, metadata) => calls.push(['info', message, metadata]),
        warn: (message, metadata) => calls.push(['warn', message, metadata]),
      },
      'detect',
      ['codex'],
    );
    const span = observation.emitter.begin(observation.context, {
      kind: 'tool.detection.started',
      toolId: 'codex',
    });
    observation.emitter.complete(span, {
      outcome: 'failure',
      errorCode: 'generic',
      resultCount: 0,
    });
    expect(calls).toEqual([
      ['debug', 'detecting codex', undefined],
      ['warn', 'detection error for codex', { code: 'generic' }],
    ]);
    expect(JSON.stringify(calls)).not.toContain('legacy-observation');
    expect(observation.context).toMatchObject({
      operationId: 'legacy-observation',
      command: 'legacy-scan',
      workflow: 'detect',
      startedAt: '1970-01-01T00:00:00.000Z',
      startedMonotonicMilliseconds: 0,
    });
  });

  test('redacts token-like typed values before invoking the legacy logger', () => {
    const calls: Array<readonly [string, string, unknown?]> = [];
    const observation = observationFromLegacyLogger(
      {
        debug: (message, metadata) => calls.push(['debug', message, metadata]),
        info: (message, metadata) => calls.push(['info', message, metadata]),
        warn: (message, metadata) => calls.push(['warn', message, metadata]),
      },
      'detect',
      ['sk-abcdefghi'],
    );
    const span = observation.emitter.begin(observation.context, {
      kind: 'tool.detection.started',
      toolId: 'sk-abcdefghi',
    });
    observation.emitter.complete(span, {
      outcome: 'failure',
      errorCode: 'sk-123456789abcdef',
      resultCount: 0,
    });
    expect(JSON.stringify(calls)).not.toContain('abcdef');
    expect(calls).toEqual([
      ['debug', 'detecting [REDACTED]', undefined],
      ['warn', 'detection error for [REDACTED]', { code: '[REDACTED]' }],
    ]);
  });

  test('reproduces inventory summaries for skill and command scans', () => {
    const messages: string[] = [];
    for (const activity of ['list-skills', 'list-commands'] as const) {
      const observation = observationFromLegacyLogger(
        {
          debug: (message) => messages.push(message),
          info: () => {},
          warn: () => {},
        },
        activity,
      );
      const span = observation.emitter.begin(observation.context, {
        kind: 'operation.started',
        operationKind: 'inventory',
      });
      observation.emitter.complete(span, {
        outcome: 'success',
        errorCode: null,
        standaloneCount: 2,
        bundledCount: 3,
        resultCount: 5,
      });
    }
    expect(messages).toEqual([
      'listSkills: 2 standalone + 3 plugin = 5 after filters',
      'listCommands: 2 standalone + 3 plugin = 5',
    ]);
  });

  test('does not invent a legacy summary for a failed inventory operation', () => {
    const messages: string[] = [];
    const observation = observationFromLegacyLogger(
      {
        debug: (message) => messages.push(message),
        info: () => {},
        warn: () => {},
      },
      'list-skills',
    );
    const span = observation.emitter.begin(observation.context, {
      kind: 'operation.started',
      operationKind: 'inventory',
    });
    observation.emitter.complete(span, {
      outcome: 'failure',
      errorCode: 'generic',
      standaloneCount: 2,
      bundledCount: 0,
      resultCount: 0,
    });
    expect(messages).toEqual([]);
  });

  test('prefers an explicit typed bundle, adapts only an explicit Logger, and otherwise uses noop observation', () => {
    const explicit = observationFromLegacyLogger(
      { debug: () => {}, info: () => {}, warn: () => {} },
      'detect',
    );
    const ignoredLoggerCalls: string[] = [];
    expect(
      resolveObservationBundle(
        explicit,
        {
          debug: (message) => ignoredLoggerCalls.push(message),
          info: () => {},
          warn: () => {},
        },
        'detect',
      ),
    ).toBe(explicit);
    expect(ignoredLoggerCalls).toEqual([]);

    const adaptedCalls: string[] = [];
    const adapted = resolveObservationBundle(
      undefined,
      {
        debug: (message) => adaptedCalls.push(message),
        info: () => {},
        warn: () => {},
      },
      'detect',
      ['codex'],
    );
    const adaptedSpan = adapted.emitter.begin(adapted.context, {
      kind: 'tool.detection.started',
      toolId: 'codex',
    });
    adapted.emitter.complete(adaptedSpan, {
      outcome: 'success',
      errorCode: null,
      resultCount: 1,
    });
    expect(adaptedCalls).toEqual(['detecting codex']);

    const fallback = resolveObservationBundle(undefined, undefined, 'list-skills', ['codex']);
    const fallbackSpan = fallback.emitter.begin(fallback.context, {
      kind: 'operation.started',
      operationKind: 'inventory',
    });
    expect(() =>
      fallback.emitter.complete(fallbackSpan, {
        outcome: 'success',
        errorCode: null,
        standaloneCount: 0,
        bundledCount: 0,
        resultCount: 0,
      }),
    ).not.toThrow();
    expect(fallback.context).toMatchObject({
      operationId: 'noop-observation',
      command: 'direct-scan',
      workflow: 'list-skills',
    });
  });
});
