import { comparePlanningText } from '../planning/order.ts';
import { portError } from '../ports/errors.ts';
import type { LockPort } from '../ports/types.ts';
import type {
  ExecutionLockDescriptor,
  ExecutionLockHierarchyOptions,
  ExecutionLockRank,
} from './types.ts';

export const EXECUTION_LOCK_RANKS = Object.freeze([
  'artifact-group',
  'artifact-member',
  'ledger',
  'live',
] as const satisfies readonly ExecutionLockRank[]);

const rank = new Map<ExecutionLockRank, number>(
  EXECUTION_LOCK_RANKS.map((value, index) => [value, index]),
);
const descriptorKeys = Object.freeze(['key', 'path', 'rank']);

const fail = (message: string): never => {
  throw new TypeError(`execution lock hierarchy: ${message}`);
};

const cancellation = (): never => {
  throw portError({
    capability: 'lock',
    operation: 'withExecutionLockHierarchy',
    code: 'cancelled',
    message: 'execution lock hierarchy was cancelled',
    context: {},
  });
};

const normalizeDescriptors = (
  descriptors: readonly ExecutionLockDescriptor[],
): readonly ExecutionLockDescriptor[] => {
  if (!Array.isArray(descriptors)) fail('descriptors must be an array');
  const keys = new Set<string>();
  const paths = new Set<string>();
  const normalized = descriptors.map((descriptor, index) => {
    if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      return fail(`descriptor ${index} must be an object`);
    }
    const actualKeys = Object.keys(descriptor).sort();
    if (
      actualKeys.length !== descriptorKeys.length ||
      actualKeys.some((key, offset) => key !== descriptorKeys[offset])
    ) {
      return fail(`descriptor ${index} has an invalid exact shape`);
    }
    if (!rank.has(descriptor.rank)) fail(`descriptor ${index} rank is unsupported`);
    if (typeof descriptor.key !== 'string' || descriptor.key.length === 0) {
      return fail(`descriptor ${index} key must be a non-empty string`);
    }
    if (typeof descriptor.path !== 'string' || descriptor.path.length === 0) {
      return fail(`descriptor ${index} path must be a non-empty string`);
    }
    if (keys.has(descriptor.key)) fail(`descriptor ${index} has a duplicate key`);
    if (paths.has(descriptor.path)) fail(`descriptor ${index} has a duplicate path`);
    keys.add(descriptor.key);
    paths.add(descriptor.path);
    return Object.freeze({
      rank: descriptor.rank,
      key: descriptor.key,
      path: descriptor.path,
    });
  });
  normalized.sort(
    (left, right) =>
      (rank.get(left.rank) as number) - (rank.get(right.rank) as number) ||
      comparePlanningText(left.key, right.key),
  );
  return Object.freeze(normalized);
};

export const withExecutionLockHierarchy = async <T>(
  port: LockPort,
  descriptors: readonly ExecutionLockDescriptor[],
  operation: () => Promise<T>,
  options: ExecutionLockHierarchyOptions = {},
): Promise<T> => {
  if (typeof operation !== 'function') fail('operation must be a function');
  if (options.schedulingStarted) fail('locks cannot be acquired after scheduling has started');
  const ordered = normalizeDescriptors(descriptors);
  if (options.signal?.aborted) cancellation();
  const lockRequest =
    options.signal === undefined ? undefined : Object.freeze({ signal: options.signal });

  const acquire = async (index: number): Promise<T> => {
    if (options.signal?.aborted) cancellation();
    const descriptor = ordered[index];
    if (descriptor === undefined) return operation();
    return port.withFileLock(descriptor.path, () => acquire(index + 1), lockRequest);
  };

  return acquire(0);
};
