import { createHash } from 'node:crypto';
import { canonicalPlanningString, comparePlanningText } from '../planning/order.ts';
import type {
  CurrentMutatorOperationPlan,
  OperationId,
  OperationResourceIdentity,
} from '../planning/types.ts';
import {
  containsSensitiveMaterial,
  isSensitivePropertyName,
  redactSensitiveString,
} from '../safety/redaction.ts';
import { type OrdinaryDataError, ownOrdinaryData } from '../state/ownership.ts';
import {
  type ContentObservationIdentityV1,
  type ExpectedRevisionV1,
  createContentObservationPreconditionIdV1,
  createExpectedRevisionPreconditionIdV1,
  isContentObservationIdentityV1,
  isExpectedRevisionV1,
} from '../state/types.ts';
import type {
  ExecutionPrecondition,
  ExecutionPreconditionInput,
  ExecutionPreconditionStateError,
  ExecutionScheduleOptions,
} from './types.ts';

interface ExpectedRevisionExecutionPreconditionInput {
  readonly operationIds: readonly OperationId[];
  readonly resource: OperationResourceIdentity;
  readonly expectedRevision: ExpectedRevisionV1;
  readonly observeRevision: () => Promise<ExpectedRevisionV1>;
}

interface ContentObservationExecutionPreconditionInput {
  readonly operationIds: readonly OperationId[];
  readonly resource: OperationResourceIdentity;
  readonly expectedContent: ContentObservationIdentityV1;
  readonly observeContent: () => Promise<ContentObservationIdentityV1>;
}

const fail = (message: string): never => {
  throw new TypeError(`execution precondition: ${message}`);
};

const executionOwnershipMessage = (error: OrdinaryDataError): string => {
  switch (error.reason) {
    case 'proxy':
      return `${error.path} must not contain proxies`;
    case 'accessor':
      return `${error.path} is an accessor`;
    case 'symbol-key':
      return `${error.path} contains symbol keys`;
    case 'non-index-array-property':
      return `${error.path} contains non-index array properties`;
    case 'exotic-array':
      return `${error.path} has an exotic array`;
    case 'exotic-prototype':
      return `${error.path} has an exotic prototype`;
    case 'non-enumerable':
      return `${error.path} must be enumerable`;
    case 'sparse':
      return `${error.path} is sparse`;
    case 'cycle':
      return `${error.path} contains a cycle`;
    case 'depth':
    case 'nodes':
      return `${error.path} exceeds the snapshot budget`;
    case 'rejected-property':
    case 'rejected-string':
      return `${error.path} contains sensitive material`;
    case 'non-finite':
    case 'unsupported':
      return `${error.path} must contain plain data`;
  }
};

const acceptsExecutionString = (_path: string, value: string): boolean =>
  !containsSensitiveMaterial(value) || redactSensitiveString(value) === value;

const acceptsExecutionProperty = (
  _propertyPath: string,
  key: string,
  parent: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  if (!isSensitivePropertyName(key)) return true;
  if (key !== 'token' || keys.length !== 2 || !Object.hasOwn(parent, 'token')) return false;
  const kind = Object.getOwnPropertyDescriptor(parent, 'kind');
  return kind !== undefined && 'value' in kind && kind.value === 'portable';
};

const ownExecutionData = (input: unknown, rootPath: string): unknown => {
  const owned = ownOrdinaryData(input, acceptsExecutionString, {
    rootPath,
    objectPrototype: 'null',
    acceptProperty: acceptsExecutionProperty,
  });
  return owned.ok ? owned.value : fail(executionOwnershipMessage(owned.error));
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
  const resource = ownExecutionData(input.resource, '$precondition.resource');
  const expected = ownExecutionData(input.expected, '$precondition.expected');
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
    resource: resource as ExecutionPrecondition['resource'],
    expected,
    observe: input.observe,
  });
};

/**
 * Bind an observer to one approved snapshot revision without changing the planner-owned identity.
 * The planner and executor intentionally share only this pure revision identity, never effects.
 */
export const createExpectedRevisionExecutionPrecondition = (
  input: ExpectedRevisionExecutionPreconditionInput,
): ExecutionPrecondition => {
  const precondition = createExecutionPrecondition({
    operationIds: input.operationIds,
    resource: input.resource,
    expected: input.expectedRevision,
    observe: input.observeRevision,
  });
  if (!isExpectedRevisionV1(precondition.expected)) {
    fail('expectedRevision must be a valid ExpectedRevisionV1');
  }
  return Object.freeze({
    ...precondition,
    preconditionId: createExpectedRevisionPreconditionIdV1(
      precondition.expected as ExpectedRevisionV1,
    ),
  });
};

/**
 * Bind execution coverage and an observer to one planner-owned content identity without changing
 * its operation-independent precondition ID.
 */
export const createContentObservationExecutionPrecondition = (
  input: ContentObservationExecutionPreconditionInput,
): ExecutionPrecondition => {
  if (!isContentObservationIdentityV1(input.expectedContent)) {
    fail('expectedContent must be a valid ContentObservationIdentityV1');
  }
  if (typeof input.observeContent !== 'function') {
    fail('observeContent must be a function');
  }
  const precondition = createExecutionPrecondition({
    operationIds: input.operationIds,
    resource: input.resource,
    expected: input.expectedContent,
    observe: async () => {
      const observed = await input.observeContent();
      if (!isContentObservationIdentityV1(observed)) {
        fail('content observer must return an exact ContentObservationIdentityV1');
      }
      return observed;
    },
  });
  return Object.freeze({
    ...precondition,
    preconditionId: createContentObservationPreconditionIdV1(input.expectedContent),
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
      actual = ownExecutionData(
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
