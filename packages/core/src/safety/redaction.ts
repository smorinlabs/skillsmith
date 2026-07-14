import { types as utilTypes } from 'node:util';

const MAX_DEPTH = 32;
const MAX_NODES = 4_096;
const REDACTED = '[REDACTED]';
const KEY_COLLISION = '[KEY_COLLISION]';
const SENSITIVE_ASSIGNMENT_KEY =
  '(?:api[_-]?key|(?:[a-z0-9]+[_-])+(?:key|authorization|cookie|credential|password|secret|token)|authorization|cookie|credential|password|secret|token)';
const SENSITIVE_KEY_ANYWHERE = new RegExp(SENSITIVE_ASSIGNMENT_KEY, 'iu');
const AUTHORIZATION = /(\bauthorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/giu;
const AUTH_PAYLOAD = /\b(?:bearer|basic)\s+[^\s,;]+/giu;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/gu;
const OPENAI_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}\b/gu;
const COOKIE_HEADER = /(\bcookie\s*[:=]\s*)[^\r\n]+/giu;
const ASSIGNMENT = new RegExp(
  `\\b(${SENSITIVE_ASSIGNMENT_KEY})(\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;]+)`,
  'giu',
);
const EMBEDDED_URL = /(?:https?|ssh):\/\/[^\s<>"')\]]+/giu;
const ENCODED_DELIMITER = /%(?:40|3a|2f|3f|23)/iu;
const ENCODED_RUN = /(?:[A-Za-z0-9_-]|%[0-9a-f]{2}){4,}/giu;
const PERCENT_OCTETS = /(?:%[0-9a-f]{2})+/giu;
const ANY_PERCENT_OCTET = /%[0-9a-f]{2}/iu;
const MAX_PERCENT_DECODE_LAYERS = 32;

const safeUrl = (candidateInput: string): string => {
  let candidate = candidateInput;
  let trailing = '';
  while (/[.,;!]$/u.test(candidate)) {
    trailing = `${candidate.slice(-1)}${trailing}`;
    candidate = candidate.slice(0, -1);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return `[REDACTED_URL]${trailing}`;
  }

  const encodedIndex = candidate.search(ENCODED_DELIMITER);
  const decodedLooksSensitive = (() => {
    try {
      return SENSITIVE_KEY_ANYWHERE.test(decodeURIComponent(candidate));
    } catch {
      return true;
    }
  })();
  const unsafe =
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    encodedIndex >= 0 ||
    decodedLooksSensitive;
  if (!unsafe) return `${candidate}${trailing}`;

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
    return `[REDACTED_URL]${trailing}`;
  }
  if (parsed.hostname.length === 0 || parsed.port.length > 0) return `[REDACTED_URL]${trailing}`;

  let pathname = parsed.pathname;
  const pathEncodedIndex = pathname.search(ENCODED_DELIMITER);
  if (pathEncodedIndex >= 0) pathname = pathname.slice(0, pathEncodedIndex);
  const user = parsed.protocol === 'ssh:' && parsed.username === 'git' ? 'git@' : '';
  return `${parsed.protocol}//${user}${parsed.hostname}${pathname}${trailing}`;
};

const redactRecognizedString = (input: string): string =>
  input
    .replace(EMBEDDED_URL, safeUrl)
    .replace(AUTHORIZATION, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(AUTH_PAYLOAD, REDACTED)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(OPENAI_TOKEN, REDACTED)
    .replace(COOKIE_HEADER, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(
      ASSIGNMENT,
      (_match, key: string, delimiter: string) => `${key}${delimiter}${REDACTED}`,
    );

/** Redact recognized credential grammar while retaining useful non-secret diagnostics. */
export const redactSensitiveString = (input: string): string => {
  // Decode bounded percent-octet layers before scanning so an encoded credential *name* followed
  // by a literal delimiter (for example `%74oken=...`) cannot split the key from its value. This
  // is deliberately whole-string: URLs are then reduced by the same authority as plain text.
  let decoded = input;
  for (let depth = 0; depth < MAX_PERCENT_DECODE_LAYERS; depth += 1) {
    const next = decoded.replace(PERCENT_OCTETS, (candidate) => {
      try {
        return decodeURIComponent(candidate);
      } catch {
        return candidate;
      }
    });
    if (next === decoded) break;
    decoded = next;
  }
  // Each successful layer strictly shortens the string. If valid encodings still remain after the
  // fixed work budget, fail closed instead of silently re-emitting an arbitrarily nested payload.
  if (decoded !== input && ANY_PERCENT_OCTET.test(decoded)) return REDACTED;
  if (decoded !== input) {
    const decodedRedaction = redactRecognizedString(decoded);
    if (decodedRedaction !== decoded) return decodedRedaction;
  }

  const redacted = redactRecognizedString(input);
  return redacted.replace(ENCODED_RUN, (candidate) => {
    if (!candidate.includes('%')) return candidate;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return REDACTED;
    }
    const decodedRedaction = redactRecognizedString(decoded);
    return decodedRedaction === decoded ? candidate : decodedRedaction;
  });
};

/** The validation predicate and redactor deliberately share one scanner/pattern table. */
export const containsSensitiveMaterial = (input: string): boolean =>
  input.includes(REDACTED) || redactSensitiveString(input) !== input;

const safeErrorDescriptors = (
  descriptors: PropertyDescriptorMap,
): Readonly<Record<string, PropertyDescriptor | undefined>> => ({
  name: descriptors.name,
  message: descriptors.message,
  stack: descriptors.stack,
  cause: descriptors.cause,
  code: descriptors.code,
  exitCode: descriptors.exitCode,
});

interface ProjectedProperty {
  readonly originalKey: string;
  readonly outputKey: string;
  readonly descriptor: PropertyDescriptor;
}

/**
 * Project property names through the string authority before copying any values. A collision loses
 * the entire container so insertion order cannot select which original value survives.
 */
const projectPropertyNames = (
  entries: readonly (readonly [string, PropertyDescriptor | undefined])[],
  enumerableOnly: boolean,
): readonly ProjectedProperty[] | null => {
  const outputKeys = new Set<string>();
  const projected: ProjectedProperty[] = [];
  for (const [originalKey, descriptor] of entries) {
    if (descriptor === undefined || (enumerableOnly && descriptor.enumerable !== true)) continue;
    const outputKey = redactSensitiveString(originalKey);
    if (outputKeys.has(outputKey)) return null;
    outputKeys.add(outputKey);
    projected.push({ originalKey, outputKey, descriptor });
  }
  return projected;
};

/**
 * Recursively copy and freeze ordinary data without invoking accessors, iterators, proxy traps, or
 * exotic prototypes. Errors are reduced exclusively from safe own data descriptors.
 */
export const redactSensitiveValue = (input: unknown): unknown => {
  let visitedNodes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, depth: number): unknown => {
    visitedNodes++;
    if (visitedNodes > MAX_NODES) return '[MAX_NODES]';
    if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return redactSensitiveString(value);
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
    const nativeError = utilTypes.isNativeError(value);
    if (
      !nativeError &&
      ((!array && prototype !== Object.prototype && prototype !== null) ||
        (array && prototype !== Array.prototype))
    ) {
      return '[EXOTIC]';
    }

    ancestors.add(value);
    try {
      if (array) {
        const projected = projectPropertyNames(
          keys
            .filter((key): key is string => typeof key === 'string' && key !== 'length')
            .map((key) => [key, descriptors[key]] as const),
          true,
        );
        if (projected === null) return KEY_COLLISION;
        const result: unknown[] = [];
        for (const { originalKey, outputKey, descriptor } of projected) {
          const redacted = SENSITIVE_KEY_ANYWHERE.test(originalKey)
            ? REDACTED
            : !('value' in descriptor)
              ? '[ACCESSOR]'
              : visit(descriptor.value, depth + 1);
          Object.defineProperty(result, outputKey, {
            value: redacted,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return Object.freeze(result);
      }

      const result = Object.create(null) as Record<string, unknown>;
      const entries = nativeError
        ? Object.entries(safeErrorDescriptors(descriptors))
        : keys
            .filter((key): key is string => typeof key === 'string')
            .map((key) => [key, descriptors[key]] as const);
      const projected = projectPropertyNames(entries, !nativeError);
      if (projected === null) return KEY_COLLISION;
      for (const { originalKey, outputKey, descriptor } of projected) {
        Object.defineProperty(result, outputKey, {
          value: SENSITIVE_KEY_ANYWHERE.test(originalKey)
            ? REDACTED
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

/** Compatibility alias: deliberately the same function object, never a wrapper. */
export const redactObservationValue: typeof redactSensitiveValue = redactSensitiveValue;
