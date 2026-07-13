import {
  OBSERVATION_EVENT_KINDS,
  type ObservationVerbosity,
  type ObserverEvent,
  type ObserverEventKind,
  type ObserverPort,
  redactObservationValue,
} from '@skillsmith/core';
import type { CliRuntimeIo } from './io.ts';

const [
  COMMAND_STARTED,
  COMMAND_COMPLETED,
  PLAN_CREATED,
  OPERATION_STARTED,
  OPERATION_COMPLETED,
  TOOL_DETECTION_STARTED,
  TOOL_DETECTION_COMPLETED,
  TOOL_VERIFICATION_STARTED,
  TOOL_VERIFICATION_COMPLETED,
  TRANSACTION_STAGE_STARTED,
  TRANSACTION_STAGE_COMPLETED,
  TRANSACTION_COMMITTED,
  TRANSACTION_ROLLED_BACK,
  RECOVERY_STARTED,
  RECOVERY_COMPLETED,
] = OBSERVATION_EVENT_KINDS;

const PAYLOAD_KEYS: Readonly<Record<ObserverEventKind, readonly string[]>> = Object.freeze({
  [COMMAND_STARTED]: Object.freeze([]),
  [COMMAND_COMPLETED]: Object.freeze(['outcome', 'exitClass', 'errorCode', 'durationMilliseconds']),
  [PLAN_CREATED]: Object.freeze(['planId', 'operationCount']),
  [OPERATION_STARTED]: Object.freeze(['operationKind']),
  [OPERATION_COMPLETED]: Object.freeze([
    'operationKind',
    'outcome',
    'errorCode',
    'standaloneCount',
    'bundledCount',
    'resultCount',
    'durationMilliseconds',
  ]),
  [TOOL_DETECTION_STARTED]: Object.freeze(['toolId']),
  [TOOL_DETECTION_COMPLETED]: Object.freeze([
    'toolId',
    'outcome',
    'errorCode',
    'resultCount',
    'durationMilliseconds',
  ]),
  [TOOL_VERIFICATION_STARTED]: Object.freeze(['toolId', 'modes']),
  [TOOL_VERIFICATION_COMPLETED]: Object.freeze([
    'toolId',
    'modes',
    'verdict',
    'errorCode',
    'durationMilliseconds',
  ]),
  [TRANSACTION_STAGE_STARTED]: Object.freeze(['transactionId', 'stage']),
  [TRANSACTION_STAGE_COMPLETED]: Object.freeze([
    'transactionId',
    'stage',
    'outcome',
    'errorCode',
    'durationMilliseconds',
  ]),
  [TRANSACTION_COMMITTED]: Object.freeze(['transactionId', 'durationMilliseconds']),
  [TRANSACTION_ROLLED_BACK]: Object.freeze(['transactionId', 'reasonCode', 'durationMilliseconds']),
  [RECOVERY_STARTED]: Object.freeze(['transactionId', 'recoveryKind']),
  [RECOVERY_COMPLETED]: Object.freeze([
    'transactionId',
    'recoveryKind',
    'outcome',
    'errorCode',
    'durationMilliseconds',
  ]),
});

const VERBOSE_KINDS = new Set<ObserverEventKind>([
  COMMAND_STARTED,
  COMMAND_COMPLETED,
  PLAN_CREATED,
  OPERATION_STARTED,
  OPERATION_COMPLETED,
]);

const UNSAFE_TOKEN_CHARACTER = /[^A-Za-z0-9._:/@+\-]/;
const RAW_DIAGNOSTIC_CONTROL = /[\u0080-\u009f\u2028\u2029]/g;

const compactJson = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return 'null';
  return encoded.replace(
    RAW_DIAGNOSTIC_CONTROL,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const scalar = (value: unknown): string => {
  if (value === null) return '-';
  if (Array.isArray(value)) return compactJson(value);
  if (typeof value === 'string')
    return value.length > 0 && !UNSAFE_TOKEN_CHARACTER.test(value) ? value : compactJson(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return compactJson(value);
};

const payloadSuffix = (
  event: Readonly<Record<string, unknown>>,
  kind: ObserverEventKind,
  includeNull: boolean,
): string => {
  const fields: string[] = [];
  for (const key of PAYLOAD_KEYS[kind]) {
    const value = event[key];
    if (value === null && !includeNull) continue;
    fields.push(`${key}=${scalar(value)}`);
  }
  return fields.length === 0 ? '' : ` ${fields.join(' ')}`;
};

const detailLine = (event: Readonly<Record<string, unknown>>, kind: ObserverEventKind): string =>
  `detail: ${kind} operation=${scalar(event.operationId)} command=${scalar(event.command)}` +
  `${payloadSuffix(event, kind, false)}\n`;

const traceLine = (event: Readonly<Record<string, unknown>>, kind: ObserverEventKind): string =>
  `trace: ${kind} operation=${scalar(event.operationId)} parent=${scalar(event.parentOperationId)}` +
  ` group=${scalar(event.groupId)} pair=${scalar(event.pairId)} attempt=${scalar(event.attempt)}` +
  ` at=${scalar(event.occurredAt)} monoMs=${scalar(event.monotonicMilliseconds)}` +
  `${payloadSuffix(event, kind, true)}\n`;

export const resolveObservationVerbosity = (
  options: Readonly<{ quiet?: unknown; verbose?: unknown; debug?: unknown }>,
): ObservationVerbosity => {
  if (options.quiet === true) return 'quiet';
  if (options.debug === true) return 'debug';
  if (typeof options.verbose === 'number' && options.verbose >= 2) return 'trace';
  if (typeof options.verbose === 'number' && options.verbose >= 1) return 'verbose';
  return 'normal';
};

/** The sole observation presentation sink. It receives only recursively redacted event data. */
export const createCliDiagnosticObserver = (
  io: CliRuntimeIo,
  verbosity: ObservationVerbosity,
): ObserverPort =>
  Object.freeze({
    observe(event: ObserverEvent): void {
      if (verbosity === 'normal' || verbosity === 'quiet') return;
      const redacted = redactObservationValue(event);
      if (!record(redacted) || typeof redacted.kind !== 'string') return;
      const kind = redacted.kind as ObserverEventKind;
      if (verbosity === 'verbose') {
        if (VERBOSE_KINDS.has(kind)) io.stderr.write(detailLine(redacted, kind));
        return;
      }
      if (verbosity === 'trace') {
        io.stderr.write(traceLine(redacted, kind));
        return;
      }
      io.stderr.write(`debug: ${compactJson(redacted)}\n`);
    },
  });
