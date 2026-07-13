import { types as utilTypes } from 'node:util';

const MAX_DEPTH = 32;
const MAX_NODES = 4_096;
const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token/i;
const BEARER = /Bearer\s+\S+/gi;
const GITHUB_TOKEN = /gh[pousr]_[A-Za-z0-9_]{8,}/g;
const OPENAI_TOKEN = /sk-[A-Za-z0-9_-]{8,}/g;

const redactString = (value: string): string =>
  value
    .replace(BEARER, '[REDACTED]')
    .replace(GITHUB_TOKEN, '[REDACTED]')
    .replace(OPENAI_TOKEN, '[REDACTED]');

export const redactObservationValue = (input: unknown): unknown => {
  let visitedNodes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, depth: number): unknown => {
    visitedNodes++;
    if (visitedNodes > MAX_NODES) return '[MAX_NODES]';
    if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : '[NON_FINITE]';
    if (typeof value === 'undefined') return '[UNDEFINED]';
    if (typeof value === 'bigint') return '[BIGINT]';
    if (typeof value === 'symbol') return '[SYMBOL]';
    if (typeof value === 'function') return utilTypes.isProxy(value) ? '[PROXY]' : '[FUNCTION]';
    if (utilTypes.isProxy(value)) return '[PROXY]';
    if (ancestors.has(value)) return '[CIRCULAR]';

    let prototype: object | null;
    let keys: readonly (string | symbol)[];
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Reflect.ownKeys(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return '[UNSAFE]';
    }
    if (keys.some((key) => typeof key === 'symbol')) return '[SYMBOL]';
    const array = Array.isArray(value);
    if (
      (!array && prototype !== Object.prototype && prototype !== null) ||
      (array && prototype !== Array.prototype)
    )
      return '[EXOTIC]';

    ancestors.add(value);
    try {
      if (array) {
        const result: unknown[] = [];
        for (const key of keys) {
          if (typeof key !== 'string' || key === 'length') continue;
          const descriptor = descriptors[key];
          if (descriptor === undefined || descriptor.enumerable !== true) continue;
          const redacted = SENSITIVE_KEY.test(key)
            ? '[REDACTED]'
            : !('value' in descriptor)
              ? '[ACCESSOR]'
              : visit(descriptor.value, depth + 1);
          Object.defineProperty(result, key, {
            value: redacted,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return Object.freeze(result);
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof key !== 'string') continue;
        const descriptor = descriptors[key];
        if (descriptor === undefined || descriptor.enumerable !== true) continue;
        Object.defineProperty(result, key, {
          value: SENSITIVE_KEY.test(key)
            ? '[REDACTED]'
            : !('value' in descriptor)
              ? '[ACCESSOR]'
              : visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return Object.freeze(result);
    } catch {
      return '[UNSAFE]';
    } finally {
      ancestors.delete(value);
    }
  };

  return visit(input, 0);
};
