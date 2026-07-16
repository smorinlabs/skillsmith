import { types as utilTypes } from 'node:util';
import { type Result, err, ok } from '../result.ts';

export type OrdinaryDataErrorReason =
  | 'unsupported'
  | 'proxy'
  | 'accessor'
  | 'symbol-key'
  | 'non-index-array-property'
  | 'exotic-array'
  | 'exotic-prototype'
  | 'non-enumerable'
  | 'sparse'
  | 'cycle'
  | 'non-finite'
  | 'depth'
  | 'nodes'
  | 'rejected-string'
  | 'rejected-property';

export interface OrdinaryDataError {
  readonly code: 'ordinary-data';
  readonly reason: OrdinaryDataErrorReason;
  readonly path: string;
}

export type OrdinaryStringPolicy = (path: string, value: string) => boolean;
export type OrdinaryPropertyPolicy = (
  propertyPath: string,
  key: string,
  parent: Readonly<Record<string, unknown>>,
  keys: readonly string[],
) => boolean;

export interface OrdinaryDataOwnershipOptions {
  readonly rootPath?: string;
  readonly objectPrototype?: 'ordinary' | 'null';
  readonly acceptProperty?: OrdinaryPropertyPolicy;
}

const MAX_OWNED_NODES = 20_000;
const MAX_OWNED_DEPTH = 64;

interface OwnershipBudget {
  nodes: number;
}

const ownershipError = (reason: OrdinaryDataErrorReason, path: string): OrdinaryDataError =>
  Object.freeze({ code: 'ordinary-data' as const, reason, path });

const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

const ownValue = (
  input: unknown,
  acceptString: OrdinaryStringPolicy,
  path: string,
  active: Set<object>,
  budget: OwnershipBudget,
  depth: number,
  options: OrdinaryDataOwnershipOptions,
): Result<unknown, OrdinaryDataError> => {
  budget.nodes += 1;
  if (budget.nodes > MAX_OWNED_NODES) return err(ownershipError('nodes', path));
  if (depth > MAX_OWNED_DEPTH) return err(ownershipError('depth', path));

  if (input === null || typeof input === 'boolean') return ok(input);
  if (typeof input === 'string') {
    try {
      return acceptString(path, input) ? ok(input) : err(ownershipError('rejected-string', path));
    } catch {
      return err(ownershipError('rejected-string', path));
    }
  }
  if (typeof input === 'number') {
    return Number.isFinite(input) ? ok(input) : err(ownershipError('non-finite', path));
  }
  if (typeof input !== 'object') return err(ownershipError('unsupported', path));
  if (utilTypes.isProxy(input)) return err(ownershipError('proxy', path));
  if (active.has(input)) return err(ownershipError('cycle', path));

  active.add(input);
  try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) {
        return err(ownershipError('exotic-array', path));
      }
      const keys = Reflect.ownKeys(input);
      for (const key of keys) {
        if (typeof key !== 'string') return err(ownershipError('symbol-key', path));
        if (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
          return err(ownershipError('non-index-array-property', path));
        }
      }
      if (Object.keys(input).length !== input.length) {
        return err(ownershipError('sparse', path));
      }
      const output: unknown[] = [];
      for (let index = 0; index < input.length; index += 1) {
        if (!Object.hasOwn(input, index)) return err(ownershipError('sparse', `${path}[${index}]`));
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !('value' in descriptor)) {
          return err(ownershipError('accessor', `${path}[${index}]`));
        }
        if (!descriptor.enumerable) {
          return err(ownershipError('non-enumerable', `${path}[${index}]`));
        }
        const owned = ownValue(
          descriptor.value,
          acceptString,
          `${path}[${index}]`,
          active,
          budget,
          depth + 1,
          options,
        );
        if (!owned.ok) return owned;
        output.push(owned.value);
      }
      return ok(Object.freeze(output));
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return err(ownershipError('exotic-prototype', path));
    }
    const rawKeys = Reflect.ownKeys(input);
    if (rawKeys.some((key) => typeof key !== 'string')) {
      return err(ownershipError('symbol-key', path));
    }
    const keys = rawKeys as string[];
    const output: Record<string, unknown> =
      options.objectPrototype === 'null' ? Object.create(null) : {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      const propertyPath = childPath(path, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        return err(ownershipError('accessor', propertyPath));
      }
      if (!descriptor.enumerable) {
        return err(ownershipError('non-enumerable', propertyPath));
      }
      if (options.acceptProperty !== undefined) {
        try {
          if (
            !options.acceptProperty(
              propertyPath,
              key,
              input as Readonly<Record<string, unknown>>,
              keys,
            )
          ) {
            return err(ownershipError('rejected-property', propertyPath));
          }
        } catch {
          return err(ownershipError('rejected-property', propertyPath));
        }
      }
      const owned = ownValue(
        descriptor.value,
        acceptString,
        propertyPath,
        active,
        budget,
        depth + 1,
        options,
      );
      if (!owned.ok) return owned;
      Object.defineProperty(output, key, {
        value: owned.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return ok(Object.freeze(output));
  } catch {
    return err(ownershipError('unsupported', path));
  } finally {
    active.delete(input);
  }
};

export const ownOrdinaryData = (
  input: unknown,
  acceptString: OrdinaryStringPolicy,
  options: OrdinaryDataOwnershipOptions = {},
): Result<unknown, OrdinaryDataError> => {
  const rootPath = options.rootPath ?? '$';
  if (typeof acceptString !== 'function') return err(ownershipError('unsupported', rootPath));
  return ownValue(input, acceptString, rootPath, new Set<object>(), { nodes: 0 }, 0, options);
};
