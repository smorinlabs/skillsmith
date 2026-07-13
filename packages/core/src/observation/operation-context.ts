import { types as utilTypes } from 'node:util';
import type { ClockPort, IdPort } from '../ports/types.ts';
import type { OperationContext } from './types.ts';

export interface CreateOperationContextInput {
  command: string;
  workflow: string;
  clock: Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>;
  id: Pick<IdPort, 'nextId'>;
  operationId?: string;
  parentOperationId?: string | null;
  groupId?: string | null;
  pairId?: string | null;
  attempt?: number;
}

const contexts = new WeakSet<object>();

const hasAsciiControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

export const requireObservationString = (value: unknown, label: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    hasAsciiControl(value)
  )
    throw new TypeError(`${label} must be a normalized non-empty string`);
  return value;
};

export const requireNullableObservationString = (value: unknown, label: string): string | null =>
  value === null ? null : requireObservationString(value, label);

export const requirePositiveSafeInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${label} must be a positive safe integer`);
  return value;
};

export const requireNonNegativeSafeInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
};

export const requireNonNegativeFinite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new TypeError(`${label} must be finite and non-negative`);
  return value;
};

const requireCanonicalWallTime = (value: unknown): string => {
  if (typeof value !== 'string')
    throw new TypeError('wall time must be a canonical UTC ISO string');
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new TypeError('wall time must be a canonical UTC ISO string');
  }
  if (canonical !== value) throw new TypeError('wall time must be a canonical UTC ISO string');
  return value;
};

const requireCallable = (value: unknown, label: string): ((...args: never[]) => unknown) => {
  if (typeof value !== 'function' || utilTypes.isProxy(value))
    throw new TypeError(`${label} must be a non-proxy function`);
  return value as (...args: never[]) => unknown;
};

const ownData = (input: object, key: PropertyKey, optional = false): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined) {
    if (optional) return undefined;
    throw new TypeError(`${String(key)} is required`);
  }
  if (!('value' in descriptor)) throw new TypeError(`${String(key)} must be a data property`);
  return descriptor.value;
};

const requireRecord = (value: unknown, label: string): object => {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value))
    throw new TypeError(`${label} must be a non-proxy object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} must be an ordinary object`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError(`${label} must not contain symbol keys`);
  return value;
};

const focusedClock = (
  input: Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>,
): Readonly<Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>> => {
  const source = requireRecord(input, 'clock');
  const wall = requireCallable(ownData(source, 'wallNowIso'), 'clock.wallNowIso');
  const monotonic = requireCallable(
    ownData(source, 'monotonicMilliseconds'),
    'clock.monotonicMilliseconds',
  );
  return Object.freeze({
    wallNowIso: () => Reflect.apply(wall, input, []) as string,
    monotonicMilliseconds: () => Reflect.apply(monotonic, input, []) as number,
  });
};

const captureTime = (
  clock: Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>,
): Readonly<{ wall: string; monotonic: number }> =>
  Object.freeze({
    wall: requireCanonicalWallTime(clock.wallNowIso()),
    monotonic: requireNonNegativeFinite(clock.monotonicMilliseconds(), 'monotonic milliseconds'),
  });

export const captureOperationTime = captureTime;

const freezeContext = (input: {
  operationId: string;
  parentOperationId: string | null;
  command: string;
  workflow: string;
  groupId: string | null;
  pairId: string | null;
  attempt: number;
  clock: Readonly<Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>>;
  startedAt: string;
  startedMonotonicMilliseconds: number;
}): OperationContext => {
  const context: OperationContext = Object.freeze({
    operationId: input.operationId,
    parentOperationId: input.parentOperationId,
    command: input.command,
    workflow: input.workflow,
    groupId: input.groupId,
    pairId: input.pairId,
    attempt: input.attempt,
    clock: input.clock,
    startedAt: input.startedAt,
    startedMonotonicMilliseconds: input.startedMonotonicMilliseconds,
  });
  contexts.add(context);
  return context;
};

export const isOperationContext = (value: unknown): value is OperationContext =>
  typeof value === 'object' && value !== null && contexts.has(value);

const requireContext = (value: unknown): OperationContext => {
  if (!isOperationContext(value)) throw new TypeError('context is not an OperationContext');
  return value;
};

export const createOperationContext = (input: CreateOperationContextInput): OperationContext => {
  const source = requireRecord(input, 'operation context input');
  const command = requireObservationString(ownData(source, 'command'), 'command');
  const workflow = requireObservationString(ownData(source, 'workflow'), 'workflow');
  const clockInput = ownData(source, 'clock') as Pick<
    ClockPort,
    'wallNowIso' | 'monotonicMilliseconds'
  >;
  const clock = focusedClock(clockInput);
  const idInput = requireRecord(ownData(source, 'id'), 'id');
  const nextId = requireCallable(ownData(idInput, 'nextId'), 'id.nextId');
  const explicitOperationId = ownData(source, 'operationId', true);
  const explicitValidatedOperationId =
    explicitOperationId === undefined
      ? undefined
      : requireObservationString(explicitOperationId, 'operationId');
  const parentValue = ownData(source, 'parentOperationId', true);
  const groupValue = ownData(source, 'groupId', true);
  const pairValue = ownData(source, 'pairId', true);
  const attemptValue = ownData(source, 'attempt', true);
  const parentOperationId = requireNullableObservationString(
    parentValue === undefined ? null : parentValue,
    'parentOperationId',
  );
  const groupId = requireNullableObservationString(
    groupValue === undefined ? null : groupValue,
    'groupId',
  );
  const pairId = requireNullableObservationString(
    pairValue === undefined ? null : pairValue,
    'pairId',
  );
  if (pairId !== null && groupId === null) throw new TypeError('pairId requires groupId');
  const attempt = requirePositiveSafeInteger(
    attemptValue === undefined ? 1 : attemptValue,
    'attempt',
  );
  const started = captureTime(clock);
  const operationId =
    explicitValidatedOperationId ??
    requireObservationString(
      Reflect.apply(nextId, ownData(source, 'id'), ['operation']),
      'operationId',
    );
  return freezeContext({
    operationId,
    parentOperationId,
    command,
    workflow,
    groupId,
    pairId,
    attempt,
    clock,
    startedAt: started.wall,
    startedMonotonicMilliseconds: started.monotonic,
  });
};

export const createChildOperationContext = (
  parent: OperationContext,
  input: {
    command: string;
    workflow: string;
    id: Pick<IdPort, 'nextId'>;
  },
): OperationContext => {
  const authority = requireContext(parent);
  return createOperationContext({
    command: input.command,
    workflow: input.workflow,
    clock: authority.clock,
    id: input.id,
    parentOperationId: authority.operationId,
  });
};

export const withOperationTarget = (
  context: OperationContext,
  target: { groupId: string | null; pairId: string | null },
): OperationContext => {
  const authority = requireContext(context);
  const source = requireRecord(target, 'operation target');
  const groupId = requireNullableObservationString(ownData(source, 'groupId'), 'groupId');
  const pairId = requireNullableObservationString(ownData(source, 'pairId'), 'pairId');
  if (pairId !== null && groupId === null) throw new TypeError('pairId requires groupId');
  return freezeContext({ ...authority, groupId, pairId });
};

export const nextOperationAttempt = (context: OperationContext): OperationContext => {
  const authority = requireContext(context);
  if (authority.attempt === Number.MAX_SAFE_INTEGER) throw new TypeError('attempt overflow');
  const started = captureTime(authority.clock);
  return freezeContext({
    ...authority,
    attempt: authority.attempt + 1,
    startedAt: started.wall,
    startedMonotonicMilliseconds: started.monotonic,
  });
};
