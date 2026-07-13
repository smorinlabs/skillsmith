import { types as utilTypes } from 'node:util';
import {
  captureOperationTime,
  isOperationContext,
  requireNonNegativeFinite,
  requireNonNegativeSafeInteger,
  requireObservationString,
} from './operation-context.ts';
import {
  type CompletionInput,
  type InstantInput,
  type InstantKind,
  OBSERVATION_EVENT_KINDS,
  OPERATION_KINDS,
  type ObservationEmitter,
  type ObservationSpan,
  type ObserverEvent,
  type ObserverEventKind,
  type ObserverEventPayloadMap,
  type ObserverPort,
  type OperationContext,
  type StartedInput,
  type StartedKind,
} from './types.ts';

type UnknownRecord = Record<string, unknown>;

const EVENT_KINDS = new Set<string>(OBSERVATION_EVENT_KINDS);
const OPERATION_KIND_SET = new Set<string>(OPERATION_KINDS);
const PLAN_CREATED = OBSERVATION_EVENT_KINDS[2];
const TRANSACTION_STAGE_STARTED = OBSERVATION_EVENT_KINDS[9];
const TRANSACTION_STAGE_COMPLETED = OBSERVATION_EVENT_KINDS[10];
const TRANSACTION_COMMITTED = OBSERVATION_EVENT_KINDS[11];
const TRANSACTION_ROLLED_BACK = OBSERVATION_EVENT_KINDS[12];
const RECOVERY_STARTED = OBSERVATION_EVENT_KINDS[13];
const RECOVERY_COMPLETED = OBSERVATION_EVENT_KINDS[14];
const OUTCOMES = new Set(['success', 'failure', 'cancelled', 'skipped']);
const EXIT_CLASSES = new Set([
  'success',
  'failure',
  'usage',
  'state',
  'capability',
  'source',
  'permission',
  'drift',
  'cancelled',
]);
const VERDICTS = new Set(['pass', 'warn', 'fail', 'inconclusive', 'unavailable', 'skipped']);
const STAGES = new Set(['prepared', 'staged', 'backed-up', 'live', 'committed']);
const RECOVERY_KINDS = new Set(['resume', 'rollback', 'cleanup']);
const TOOL_ID = /^[a-z][a-z0-9-]*$/;

const PAYLOAD_KEYS: Readonly<Record<ObserverEventKind, readonly string[]>> = Object.freeze({
  'command.started': Object.freeze([]),
  'command.completed': Object.freeze(['outcome', 'exitClass', 'errorCode', 'durationMilliseconds']),
  [PLAN_CREATED]: Object.freeze(['planId', 'operationCount']),
  'operation.started': Object.freeze(['operationKind']),
  'operation.completed': Object.freeze([
    'operationKind',
    'outcome',
    'errorCode',
    'standaloneCount',
    'bundledCount',
    'resultCount',
    'durationMilliseconds',
  ]),
  'tool.detection.started': Object.freeze(['toolId']),
  'tool.detection.completed': Object.freeze([
    'toolId',
    'outcome',
    'errorCode',
    'resultCount',
    'durationMilliseconds',
  ]),
  'tool.verification.started': Object.freeze(['toolId', 'modes']),
  'tool.verification.completed': Object.freeze([
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

const COMPLETION_KEYS: Readonly<Record<StartedKind, readonly string[]>> = Object.freeze({
  'command.started': Object.freeze(['outcome', 'exitClass', 'errorCode']),
  'operation.started': Object.freeze([
    'outcome',
    'errorCode',
    'standaloneCount',
    'bundledCount',
    'resultCount',
  ]),
  'tool.detection.started': Object.freeze(['outcome', 'errorCode', 'resultCount']),
  'tool.verification.started': Object.freeze(['verdict', 'errorCode']),
  [TRANSACTION_STAGE_STARTED]: Object.freeze(['outcome', 'errorCode']),
  [RECOVERY_STARTED]: Object.freeze(['outcome', 'errorCode']),
});

const inspectClosedRecord = (value: unknown, expectedKeys: readonly string[]): UnknownRecord => {
  if (
    typeof value !== 'object' ||
    value === null ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  )
    throw new TypeError('event input must be a non-proxy ordinary object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('event input must be an ordinary object');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  )
    throw new TypeError('event input has an invalid property set');
  const result: UnknownRecord = Object.create(null) as UnknownRecord;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor))
      throw new TypeError(`event input ${key} must be an enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
};

const inspectDenseArray = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value) || utilTypes.isProxy(value))
    throw new TypeError('value must be an array');
  const keys = Reflect.ownKeys(value);
  const expectedKeys = [
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    'length',
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  )
    throw new TypeError('array must be dense and contain no extra properties');
  const clone: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor))
      throw new TypeError('array entries must be enumerable data properties');
    clone.push(descriptor.value);
  }
  return clone;
};

const requireMember = (value: unknown, values: ReadonlySet<string>, label: string): string => {
  if (typeof value !== 'string' || !values.has(value)) throw new TypeError(`${label} is invalid`);
  return value;
};

const requireToolId = (value: unknown): string => {
  const toolId = requireObservationString(value, 'toolId');
  if (!TOOL_ID.test(toolId)) throw new TypeError('toolId is invalid');
  return toolId;
};

const requireNullableCount = (value: unknown, label: string): number | null =>
  value === null ? null : requireNonNegativeSafeInteger(value, label);

const requireErrorForOutcome = (outcome: string, value: unknown): string | null => {
  if (outcome === 'success' || outcome === 'skipped') {
    if (value !== null)
      throw new TypeError('successful or skipped events require a null errorCode');
    return null;
  }
  return requireObservationString(value, 'errorCode');
};

const requireModes = (value: unknown): readonly ('static' | 'deep')[] => {
  const modes = inspectDenseArray(value);
  if (
    modes[0] !== 'static' ||
    (modes.length === 2 && modes[1] !== 'deep') ||
    (modes.length !== 1 && modes.length !== 2)
  )
    throw new TypeError('modes must be static or static,deep');
  return Object.freeze([...modes] as ('static' | 'deep')[]);
};

const payloadFor = (kind: ObserverEventKind, record: UnknownRecord): UnknownRecord => {
  switch (kind) {
    case 'command.started':
      return Object.create(null) as UnknownRecord;
    case 'command.completed': {
      const outcome = requireMember(
        record.outcome,
        new Set(['success', 'failure', 'cancelled']),
        'outcome',
      );
      const exitClass = requireMember(record.exitClass, EXIT_CLASSES, 'exitClass');
      if (
        (outcome === 'success' && exitClass !== 'success' && exitClass !== 'drift') ||
        (outcome === 'cancelled' && exitClass !== 'cancelled') ||
        (outcome === 'failure' && ['success', 'drift', 'cancelled'].includes(exitClass))
      )
        throw new TypeError('command outcome does not match exitClass');
      return {
        outcome,
        exitClass,
        errorCode: requireErrorForOutcome(outcome, record.errorCode),
        durationMilliseconds: requireNonNegativeFinite(
          record.durationMilliseconds,
          'durationMilliseconds',
        ),
      };
    }
    case PLAN_CREATED:
      return {
        planId: requireObservationString(record.planId, 'planId'),
        operationCount: requireNonNegativeSafeInteger(record.operationCount, 'operationCount'),
      };
    case 'operation.started':
      return {
        operationKind: requireMember(record.operationKind, OPERATION_KIND_SET, 'operationKind'),
      };
    case 'operation.completed': {
      const outcome = requireMember(record.outcome, OUTCOMES, 'outcome');
      return {
        operationKind: requireMember(record.operationKind, OPERATION_KIND_SET, 'operationKind'),
        outcome,
        errorCode: requireErrorForOutcome(outcome, record.errorCode),
        standaloneCount: requireNullableCount(record.standaloneCount, 'standaloneCount'),
        bundledCount: requireNullableCount(record.bundledCount, 'bundledCount'),
        resultCount: requireNullableCount(record.resultCount, 'resultCount'),
        durationMilliseconds: requireNonNegativeFinite(
          record.durationMilliseconds,
          'durationMilliseconds',
        ),
      };
    }
    case 'tool.detection.started':
      return { toolId: requireToolId(record.toolId) };
    case 'tool.detection.completed': {
      const outcome = requireMember(record.outcome, OUTCOMES, 'outcome');
      return {
        toolId: requireToolId(record.toolId),
        outcome,
        errorCode: requireErrorForOutcome(outcome, record.errorCode),
        resultCount: requireNonNegativeSafeInteger(record.resultCount, 'resultCount'),
        durationMilliseconds: requireNonNegativeFinite(
          record.durationMilliseconds,
          'durationMilliseconds',
        ),
      };
    }
    case 'tool.verification.started':
      return { toolId: requireToolId(record.toolId), modes: requireModes(record.modes) };
    case 'tool.verification.completed': {
      const verdict = requireMember(record.verdict, VERDICTS, 'verdict');
      const expectsNull = verdict === 'pass' || verdict === 'warn' || verdict === 'skipped';
      const errorCode = expectsNull
        ? record.errorCode === null
          ? null
          : (() => {
              throw new TypeError('verification verdict requires a null errorCode');
            })()
        : requireObservationString(record.errorCode, 'errorCode');
      return {
        toolId: requireToolId(record.toolId),
        modes: requireModes(record.modes),
        verdict,
        errorCode,
        durationMilliseconds: requireNonNegativeFinite(
          record.durationMilliseconds,
          'durationMilliseconds',
        ),
      };
    }
    case TRANSACTION_STAGE_STARTED:
      return {
        transactionId: requireObservationString(record.transactionId, 'transactionId'),
        stage: requireMember(record.stage, STAGES, 'stage'),
      };
    case TRANSACTION_STAGE_COMPLETED: {
      const outcome = requireMember(record.outcome, OUTCOMES, 'outcome');
      return {
        transactionId: requireObservationString(record.transactionId, 'transactionId'),
        stage: requireMember(record.stage, STAGES, 'stage'),
        outcome,
        errorCode: requireErrorForOutcome(outcome, record.errorCode),
        durationMilliseconds: requireNonNegativeFinite(
          record.durationMilliseconds,
          'durationMilliseconds',
        ),
      };
    }
    case TRANSACTION_COMMITTED:
      return {
        transactionId: requireObservationString(record.transactionId, 'transactionId'),
        durationMilliseconds: requireNonNegativeFinite(
          record.durationMilliseconds,
          'durationMilliseconds',
        ),
      };
    case TRANSACTION_ROLLED_BACK:
      return {
        transactionId: requireObservationString(record.transactionId, 'transactionId'),
        reasonCode: requireObservationString(record.reasonCode, 'reasonCode'),
        durationMilliseconds: requireNonNegativeFinite(
          record.durationMilliseconds,
          'durationMilliseconds',
        ),
      };
    case RECOVERY_STARTED:
      return {
        transactionId: requireObservationString(record.transactionId, 'transactionId'),
        recoveryKind: requireMember(record.recoveryKind, RECOVERY_KINDS, 'recoveryKind'),
      };
    case RECOVERY_COMPLETED: {
      const outcome = requireMember(record.outcome, OUTCOMES, 'outcome');
      return {
        transactionId: requireObservationString(record.transactionId, 'transactionId'),
        recoveryKind: requireMember(record.recoveryKind, RECOVERY_KINDS, 'recoveryKind'),
        outcome,
        errorCode: requireErrorForOutcome(outcome, record.errorCode),
        durationMilliseconds: requireNonNegativeFinite(
          record.durationMilliseconds,
          'durationMilliseconds',
        ),
      };
    }
  }
};

const createObserverEventAt = <Kind extends ObserverEventKind>(
  context: OperationContext,
  input: Readonly<{ kind: Kind } & ObserverEventPayloadMap[Kind]>,
  occurredAt: string,
  monotonicMilliseconds: number,
): Extract<ObserverEvent, { readonly kind: Kind }> => {
  if (!isOperationContext(context)) throw new TypeError('context is not an OperationContext');
  if (
    typeof input !== 'object' ||
    input === null ||
    utilTypes.isProxy(input) ||
    Array.isArray(input)
  )
    throw new TypeError('event input must be a non-proxy ordinary object');
  const kindDescriptor = Object.getOwnPropertyDescriptor(input, 'kind');
  if (
    kindDescriptor === undefined ||
    kindDescriptor.enumerable !== true ||
    !('value' in kindDescriptor)
  )
    throw new TypeError('event kind must be an enumerable data property');
  const kind = requireMember(kindDescriptor.value, EVENT_KINDS, 'event kind') as ObserverEventKind;
  const expected = ['kind', ...PAYLOAD_KEYS[kind]];
  const record = inspectClosedRecord(input, expected);
  const payload = payloadFor(kind, record);
  return Object.freeze({
    kind,
    operationId: context.operationId,
    parentOperationId: context.parentOperationId,
    command: context.command,
    workflow: context.workflow,
    groupId: context.groupId,
    pairId: context.pairId,
    attempt: context.attempt,
    occurredAt,
    monotonicMilliseconds,
    ...payload,
  }) as Extract<ObserverEvent, { readonly kind: Kind }>;
};

export const createObserverEvent = <const Kind extends ObserverEventKind>(
  context: OperationContext,
  input: Readonly<{ kind: Kind } & ObserverEventPayloadMap[Kind]>,
): Extract<ObserverEvent, { readonly kind: Kind }> => {
  if (!isOperationContext(context)) throw new TypeError('context is not an OperationContext');
  const time = captureOperationTime(context.clock);
  return createObserverEventAt(context, input, time.wall, time.monotonic);
};

export const noopObserver: ObserverPort = Object.freeze({ observe: () => {} });

type SpanDetails = Readonly<{
  owner: object;
  context: OperationContext;
  startedKind: StartedKind;
  identity: Readonly<UnknownRecord>;
  startedMonotonicMilliseconds: number;
}>;

const spans = new WeakMap<object, SpanDetails>();

const identityFor = (event: ObserverEvent): Readonly<UnknownRecord> => {
  switch (event.kind) {
    case 'command.started':
      return Object.freeze(Object.create(null) as UnknownRecord);
    case 'operation.started':
      return Object.freeze({ operationKind: event.operationKind });
    case 'tool.detection.started':
      return Object.freeze({ toolId: event.toolId });
    case 'tool.verification.started':
      return Object.freeze({ toolId: event.toolId, modes: event.modes });
    case TRANSACTION_STAGE_STARTED:
      return Object.freeze({ transactionId: event.transactionId, stage: event.stage });
    case RECOVERY_STARTED:
      return Object.freeze({
        transactionId: event.transactionId,
        recoveryKind: event.recoveryKind,
      });
    default:
      throw new TypeError('event kind cannot begin a span');
  }
};

const completionKindFor = (kind: StartedKind): ObserverEventKind => {
  switch (kind) {
    case 'command.started':
      return 'command.completed';
    case 'operation.started':
      return 'operation.completed';
    case 'tool.detection.started':
      return 'tool.detection.completed';
    case 'tool.verification.started':
      return 'tool.verification.completed';
    case TRANSACTION_STAGE_STARTED:
      return TRANSACTION_STAGE_COMPLETED;
    case RECOVERY_STARTED:
      return RECOVERY_COMPLETED;
  }
};

const observerFunction = (
  observer: ObserverPort,
): ((event: ObserverEvent) => void | PromiseLike<void>) => {
  if (typeof observer !== 'object' || observer === null || utilTypes.isProxy(observer))
    throw new TypeError('observer must be a non-proxy object');
  const descriptor = Object.getOwnPropertyDescriptor(observer, 'observe');
  if (
    descriptor === undefined ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'function' ||
    utilTypes.isProxy(descriptor.value)
  )
    throw new TypeError('observer.observe must be a non-proxy function');
  return descriptor.value as (event: ObserverEvent) => void | PromiseLike<void>;
};

const invokeBestEffort = (
  observer: ObserverPort,
  observe: (event: ObserverEvent) => void | PromiseLike<void>,
  event: ObserverEvent,
): void => {
  try {
    const result = Reflect.apply(observe, observer, [event]);
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  } catch {
    // Observation cannot acquire semantic authority over the observed operation.
  }
};

const toolIdFromEvent = (event: ObserverEvent): string | null => {
  switch (event.kind) {
    case 'tool.detection.started':
    case 'tool.detection.completed':
    case 'tool.verification.started':
    case 'tool.verification.completed':
      return event.toolId;
    default:
      return null;
  }
};

const cloneToolIds = (value: readonly string[] | undefined): ReadonlySet<string> => {
  if (value === undefined) return new Set<string>();
  const entries = inspectDenseArray(value);
  const clone: string[] = [];
  for (const entry of entries) {
    const toolId = requireToolId(entry);
    if (clone.includes(toolId)) throw new TypeError('toolIds must be unique');
    clone.push(toolId);
  }
  Object.freeze(clone);
  return new Set(clone);
};

export const createObservationEmitter = (input: {
  observer: ObserverPort;
  toolIds?: readonly string[];
}): ObservationEmitter => {
  const source = inspectClosedRecord(
    input,
    Object.prototype.hasOwnProperty.call(input, 'toolIds') ? ['observer', 'toolIds'] : ['observer'],
  );
  const observer = source.observer as ObserverPort;
  const observe = observerFunction(observer);
  const toolIds = cloneToolIds(source.toolIds as readonly string[] | undefined);
  const owner = Object.freeze(Object.create(null) as object);

  const emitter: ObservationEmitter = Object.freeze({
    begin<const Kind extends StartedKind>(
      context: OperationContext,
      beginInput: StartedInput<Kind>,
    ): ObservationSpan<Kind> | null {
      try {
        const event = createObserverEvent(context, beginInput) as ObserverEvent;
        const toolId = toolIdFromEvent(event);
        if (toolId !== null && !toolIds.has(toolId)) return null;
        const span = Object.freeze(Object.create(null) as object);
        spans.set(span, {
          owner,
          context,
          startedKind: event.kind as StartedKind,
          identity: identityFor(event),
          startedMonotonicMilliseconds: event.monotonicMilliseconds,
        });
        invokeBestEffort(observer, observe, event);
        return span as ObservationSpan<Kind>;
      } catch {
        return null;
      }
    },
    complete<const Kind extends StartedKind>(
      span: ObservationSpan<Kind> | null,
      completionInput: CompletionInput<Kind>,
    ): void {
      try {
        if (span === null || typeof span !== 'object') return;
        const details = spans.get(span);
        if (details === undefined || details.owner !== owner) return;
        spans.delete(span);
        const completion = inspectClosedRecord(
          completionInput,
          COMPLETION_KEYS[details.startedKind],
        );
        const time = captureOperationTime(details.context.clock);
        const durationMilliseconds = time.monotonic - details.startedMonotonicMilliseconds;
        if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0) return;
        const event = createObserverEventAt(
          details.context,
          {
            kind: completionKindFor(details.startedKind),
            ...details.identity,
            ...completion,
            durationMilliseconds,
          } as never,
          time.wall,
          time.monotonic,
        ) as ObserverEvent;
        invokeBestEffort(observer, observe, event);
      } catch {
        // Completion is best effort and never escapes into operation semantics.
      }
    },
    emit<const Kind extends InstantKind>(
      context: OperationContext,
      instantInput: InstantInput<Kind>,
    ): void {
      try {
        const event = createObserverEvent(context, instantInput) as ObserverEvent;
        const toolId = toolIdFromEvent(event);
        if (toolId !== null && !toolIds.has(toolId)) return;
        invokeBestEffort(observer, observe, event);
      } catch {
        // Instant emission is best effort and never escapes into operation semantics.
      }
    },
  });
  return emitter;
};
