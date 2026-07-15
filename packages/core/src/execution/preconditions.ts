import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { canonicalPlanningString, comparePlanningText } from '../planning/order.ts';
import type { CurrentMutatorOperationPlan } from '../planning/types.ts';
import {
  containsSensitiveMaterial,
  isSensitivePropertyName,
  redactSensitiveString,
} from '../safety/redaction.ts';
import type {
  ExecutionPrecondition,
  ExecutionPreconditionInput,
  ExecutionPreconditionStateError,
  ExecutionScheduleOptions,
} from './types.ts';

type UnknownRecord = Record<string, unknown>;

const MAX_SNAPSHOT_NODES = 20_000;
const MAX_SNAPSHOT_DEPTH = 64;

const fail = (message: string): never => {
  throw new TypeError(`execution precondition: ${message}`);
};

const snapshotOrdinary = (
  value: unknown,
  path = '$',
  active = new Set<object>(),
  budget = { nodes: 0 },
  depth = 0,
): unknown => {
  budget.nodes += 1;
  if (budget.nodes > MAX_SNAPSHOT_NODES || depth > MAX_SNAPSHOT_DEPTH) {
    fail(`${path} exceeds the snapshot budget`);
  }
  if (typeof value === 'string') {
    if (containsSensitiveMaterial(value) && redactSensitiveString(value) !== value) {
      return fail(`${path} contains sensitive material`);
    }
    return value;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== 'object') return fail(`${path} must contain plain data`);
  const objectValue = value as object;
  if (utilTypes.isProxy(objectValue)) return fail(`${path} must not contain proxies`);
  if (active.has(objectValue)) return fail(`${path} contains a cycle`);
  active.add(objectValue);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${path} has an exotic array`);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) {
          return fail(`${path} contains non-index array properties`);
        }
      }
      if (Object.keys(value).length !== value.length) return fail(`${path} is sparse`);
      return value.map((_entry, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
          return fail(`${path}[${index}] is an accessor`);
        }
        return snapshotOrdinary(descriptor.value, `${path}[${index}]`, active, budget, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(`${path} has an exotic prototype`);
    }
    const output = Object.create(null) as UnknownRecord;
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== 'string') return fail(`${path} contains symbol keys`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return fail(`${path}.${key} is an accessor`);
      if (!descriptor.enumerable) return fail(`${path}.${key} must be enumerable`);
      // `OperationLocation` deliberately names its portable identifier `token`; it is a public,
      // non-credential planning identity. All other sensitive property names fail closed.
      const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
      const portableLocationToken =
        key === 'token' &&
        kindDescriptor !== undefined &&
        'value' in kindDescriptor &&
        kindDescriptor.value === 'portable' &&
        keys.length === 2 &&
        Object.hasOwn(value, 'token');
      if (isSensitivePropertyName(key) && !portableLocationToken) {
        return fail(`${path}.${key} contains sensitive material`);
      }
      const child = snapshotOrdinary(descriptor.value, `${path}.${key}`, active, budget, depth + 1);
      Object.defineProperty(output, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  } finally {
    active.delete(objectValue);
  }
};

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const semanticOperationId = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !/^operation:v1:[0-9a-f]{64}$/.test(value)) {
    return fail(`${path} must be a semantic operation ID`);
  }
  return value;
};

const cancelled = (): never => {
  throw Object.freeze({
    code: 'cancelled',
    message: 'execution precondition validation cancelled',
  });
};

const stateError = (
  code: ExecutionPreconditionStateError['code'],
  message: string,
): ExecutionPreconditionStateError => Object.freeze({ code, message });

export const createExecutionPrecondition = (
  input: ExecutionPreconditionInput,
): ExecutionPrecondition => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('input must be an object');
  }
  if (typeof input.observe !== 'function') fail('observe must be a function');
  if (!Array.isArray(input.operationIds) || input.operationIds.length === 0) {
    fail('operationIds must not be empty');
  }
  const operationIds = input.operationIds.map((operationId, index) =>
    semanticOperationId(operationId, `operationIds[${index}]`),
  );
  if (new Set(operationIds).size !== operationIds.length) {
    fail('operationIds contains duplicates');
  }
  operationIds.sort(comparePlanningText);
  const resource = snapshotOrdinary(input.resource, '$precondition.resource');
  const expected = snapshotOrdinary(input.expected, '$precondition.expected');
  const identity = {
    domain: 'skillsmith.execution-precondition',
    schemaVersion: 1,
    operationIds,
    resource,
    expected,
  } as const;
  const digest = createHash('sha256').update(canonicalPlanningString(identity)).digest('hex');
  return Object.freeze({
    preconditionId: `precondition:v1:${digest}`,
    operationIds: Object.freeze(operationIds),
    resource: deepFreeze(resource) as ExecutionPrecondition['resource'],
    expected: deepFreeze(expected),
    observe: input.observe,
  });
};

export const validateExecutionPreconditionCoverage = (
  plan: CurrentMutatorOperationPlan,
  preconditions: readonly ExecutionPrecondition[],
): readonly ExecutionPrecondition[] => {
  if (!Array.isArray(preconditions)) fail('registry must be an array');
  const operations = new Map(
    plan.operations.map((operation) => [operation.operationId, operation]),
  );
  const registry = new Map<string, ExecutionPrecondition>();
  for (const [index, precondition] of preconditions.entries()) {
    if (precondition === null || typeof precondition !== 'object') {
      return fail(`registry[${index}] must be a precondition`);
    }
    const { preconditionId } = precondition;
    if (
      typeof preconditionId !== 'string' ||
      !/^precondition:v1:[0-9a-f]{64}$/.test(preconditionId)
    ) {
      fail(`registry[${index}] has an invalid precondition ID`);
    }
    if (registry.has(preconditionId))
      fail(`registry contains duplicate precondition ${preconditionId}`);
    if (!Array.isArray(precondition.operationIds) || precondition.operationIds.length === 0) {
      fail(`precondition ${preconditionId} has empty operation coverage`);
    }
    registry.set(preconditionId, precondition);
  }

  const referenced = new Set<string>();
  for (const operation of plan.operations) {
    const mutates = Object.values(operation.mutates).some(Boolean);
    if (mutates && operation.preconditionIds.length === 0) {
      fail(`mutating operation ${operation.operationId} requires a precondition`);
    }
    for (const preconditionId of operation.preconditionIds) {
      if (referenced.has(`${operation.operationId}:${preconditionId}`)) {
        fail(`operation ${operation.operationId} has duplicate precondition coverage`);
      }
      referenced.add(`${operation.operationId}:${preconditionId}`);
      const precondition = registry.get(preconditionId);
      if (precondition === undefined) {
        return fail(
          `missing precondition ${preconditionId} for operation ${operation.operationId}`,
        );
      }
      if (!precondition.operationIds.includes(operation.operationId)) {
        fail(`precondition ${preconditionId} has an operation coverage mismatch`);
      }
    }
  }

  const referencedIds = new Set(plan.operations.flatMap((operation) => operation.preconditionIds));
  for (const precondition of registry.values()) {
    if (!referencedIds.has(precondition.preconditionId)) {
      fail(`registry contains extra precondition ${precondition.preconditionId}`);
    }
    for (const operationId of precondition.operationIds) {
      const operation = operations.get(operationId);
      if (operation === undefined) {
        return fail(`precondition ${precondition.preconditionId} references an unknown operation`);
      }
      if (!operation.preconditionIds.includes(precondition.preconditionId)) {
        fail(`precondition ${precondition.preconditionId} has an operation coverage mismatch`);
      }
    }
  }
  return Object.freeze(
    [...registry.values()].sort((left, right) =>
      comparePlanningText(left.preconditionId, right.preconditionId),
    ),
  );
};

export const validateExecutionPreconditions = async (
  plan: CurrentMutatorOperationPlan,
  preconditions: readonly ExecutionPrecondition[],
  options: ExecutionScheduleOptions = {},
): Promise<void> => {
  const ordered = validateExecutionPreconditionCoverage(plan, preconditions);
  for (const precondition of ordered) {
    if (options.signal?.aborted) cancelled();
    let actual: unknown;
    try {
      actual = snapshotOrdinary(
        await precondition.observe(),
        `$actual.${precondition.preconditionId}`,
      );
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'cancelled'
      ) {
        throw error;
      }
      throw stateError(
        'precondition-observation-failed',
        `execution precondition observation failed for ${precondition.preconditionId}`,
      );
    }
    if (canonicalPlanningString(actual) !== canonicalPlanningString(precondition.expected)) {
      throw stateError(
        'precondition-state-changed',
        `execution precondition state changed for ${precondition.preconditionId}`,
      );
    }
  }
};
