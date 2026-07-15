import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { SUPPORTED_TOOLS } from '../agents/registry.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import {
  canonicalPlanningString,
  compareExecutableOperations,
  comparePlanChecks,
  comparePlanningDiagnostics,
  comparePlanningText,
  sortPlanningScopes,
  sortPlanningStrings,
  sortPlanningTools,
} from './order.ts';
import type {
  BoundedConflict,
  BoundedForceEffect,
  BoundedForceEffectInput,
  CurrentMutatorCommand,
  CurrentMutatorOperationPlan,
  ExecutableOperation,
  OperationExecutionResult,
  OperationExecutionResultInput,
  OperationGroupIdentity,
  OperationIdentity,
  OperationPairIdentity,
  OperationPlan,
  OperationPlanInput,
  OperationSelection,
  PlanCheck,
  PlanCheckIdentity,
  PlanningDiagnostic,
  PlanningDiagnosticIdentity,
} from './types.ts';
import {
  EXECUTABLE_OPERATION_KINDS,
  OPERATION_EXECUTION_OUTCOMES,
  OPERATION_SELECTION_SOURCES,
  PLANNING_DIAGNOSTIC_KINDS,
} from './vocabulary.ts';

type UnknownRecord = Record<string, unknown>;
interface SnapshotBudget {
  nodes: number;
}

const MAX_SNAPSHOT_NODES = 20_000;
const MAX_SNAPSHOT_DEPTH = 64;
const tools = new Set<string>(SUPPORTED_TOOLS);
const operationKinds = new Set<string>(EXECUTABLE_OPERATION_KINDS);
const selectionSources = new Set<string>(OPERATION_SELECTION_SOURCES);
const diagnosticKinds = new Set<string>(PLANNING_DIAGNOSTIC_KINDS);
const executionOutcomes = new Set<string>(OPERATION_EXECUTION_OUTCOMES);

const fail = (message: string): never => {
  throw new TypeError(`operation planning: ${message}`);
};

const snapshotOrdinary = (
  input: unknown,
  path = '$',
  active = new Set<object>(),
  budget: SnapshotBudget = { nodes: 0 },
  depth = 0,
): unknown => {
  budget.nodes += 1;
  if (budget.nodes > MAX_SNAPSHOT_NODES || depth > MAX_SNAPSHOT_DEPTH) {
    fail(`${path} exceeds the snapshot budget`);
  }
  if (
    input === null ||
    typeof input === 'string' ||
    typeof input === 'boolean' ||
    (typeof input === 'number' && Number.isFinite(input))
  ) {
    return input;
  }
  if (typeof input !== 'object') return fail(`${path} must contain plain data`);
  if (utilTypes.isProxy(input)) return fail(`${path} must not contain proxies`);
  const objectInput = input as object;
  if (active.has(objectInput)) return fail(`${path} contains a cycle`);
  active.add(objectInput);
  try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) fail(`${path} has an exotic array`);
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) {
          fail(`${path} contains non-index array properties`);
        }
      }
      if (Object.keys(input).length !== input.length) {
        fail(`${path} contains non-enumerable or sparse array elements`);
      }
      const output: unknown[] = [];
      for (let index = 0; index < input.length; index++) {
        if (!Object.hasOwn(input, index)) fail(`${path} is sparse`);
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !('value' in descriptor))
          return fail(`${path}[${index}] is an accessor`);
        output.push(
          snapshotOrdinary(descriptor.value, `${path}[${index}]`, active, budget, depth + 1),
        );
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      fail(`${path} has an exotic prototype`);
    const output: UnknownRecord = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string') return fail(`${path} contains symbol keys`);
      const stringKey = key as string;
      const descriptor = Object.getOwnPropertyDescriptor(input, stringKey);
      if (!descriptor || !('value' in descriptor)) {
        return fail(`${path}.${stringKey} is an accessor`);
      }
      if (!descriptor.enumerable) {
        return fail(`${path}.${stringKey} must be an enumerable data property`);
      }
      const child = snapshotOrdinary(
        descriptor.value,
        `${path}.${stringKey}`,
        active,
        budget,
        depth + 1,
      );
      Object.defineProperty(output, stringKey, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('operation planning:')) throw error;
    fail(`${path} could not be snapshotted`);
  } finally {
    active.delete(objectInput);
  }
  return fail(`${path} could not be snapshotted`);
};

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const record = (value: unknown, path: string): UnknownRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as UnknownRecord;
};

const array = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) return fail(`${path} must be an array`);
  return value as unknown[];
};

const string = (value: unknown, path: string, nullable = false): string | null => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${path} must be a non-empty string`);
  }
  if (containsSensitiveMaterial(value)) fail(`${path} contains sensitive material`);
  return value as string;
};

const boolean = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') return fail(`${path} must be boolean`);
  return value as boolean;
};

const literal = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): T => {
  if (typeof value !== 'string' || !allowed.has(value)) fail(`${path} is unsupported`);
  return value as T;
};

const exactKeys = (
  value: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail(`${path}.${key} is unknown`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required`);
};

const stringArray = (value: unknown, path: string, nonEmpty = false): string[] => {
  const values = array(value, path).map(
    (item, index) => string(item, `${path}[${index}]`) as string,
  );
  if (nonEmpty && values.length === 0) fail(`${path} must not be empty`);
  return values;
};

const rejectDuplicates = (values: readonly string[], path: string): void => {
  if (new Set(values).size !== values.length) fail(`${path} contains duplicate values`);
};

const validateOperationId = (value: unknown, path: string): void => {
  if (typeof value !== 'string' || !/^operation:v1:[0-9a-f]{64}$/.test(value)) {
    fail(`${path} must be a semantic operation ID`);
  }
};

const validateStructuredId = (value: unknown, prefix: string, path: string): void => {
  const expression = new RegExp(`^${prefix}:v1:[0-9a-f]{64}$`, 'u');
  if (typeof value !== 'string' || !expression.test(value)) {
    fail(`${path} must be a semantic ${prefix} ID`);
  }
};

const createStructuredPlanningId = (prefix: string, identity: object): string => {
  const digest = createHash('sha256').update(canonicalPlanningString(identity)).digest('hex');
  return `${prefix}:v1:${digest}`;
};

const validateDigest = (value: unknown, path: string): void => {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail(`${path} must be a sha256 digest`);
  }
};

const validateLocation = (value: unknown, path: string): void => {
  const location = record(value, path);
  if (location.kind === 'portable') {
    exactKeys(location, ['kind', 'token'], ['kind', 'token'], path);
    string(location.token, `${path}.token`);
    return;
  }
  if (location.kind === 'machine-bound') {
    exactKeys(location, ['kind', 'path'], ['kind', 'path'], path);
    string(location.path, `${path}.path`);
    return;
  }
  fail(`${path}.kind is unsupported`);
};

const validateSource = (value: unknown, path: string): void => {
  const source = record(value, path);
  if (source.kind === 'portable') {
    exactKeys(
      source,
      ['kind', 'identity', 'requestedRef', 'resolvedSha', 'sourcePath', 'contentHash'],
      ['kind', 'identity', 'requestedRef', 'resolvedSha', 'sourcePath', 'contentHash'],
      path,
    );
    const identity = record(source.identity, `${path}.identity`);
    exactKeys(
      identity,
      ['host', 'repository', 'path'],
      ['host', 'repository', 'path'],
      `${path}.identity`,
    );
    string(identity.host, `${path}.identity.host`);
    string(identity.repository, `${path}.identity.repository`);
    string(identity.path, `${path}.identity.path`, true);
    string(source.requestedRef, `${path}.requestedRef`, true);
    string(source.resolvedSha, `${path}.resolvedSha`);
    string(source.sourcePath, `${path}.sourcePath`);
    validateDigest(source.contentHash, `${path}.contentHash`);
    return;
  }
  if (source.kind === 'local-dev') {
    exactKeys(source, ['kind', 'path', 'contentHash'], ['kind', 'path', 'contentHash'], path);
    string(source.path, `${path}.path`);
    validateDigest(source.contentHash, `${path}.contentHash`);
    return;
  }
  fail(`${path}.kind is unsupported`);
};

const validateResource = (value: unknown, path: string): void => {
  const resource = record(value, path);
  switch (resource.kind) {
    case 'live':
      exactKeys(
        resource,
        ['kind', 'skill', 'tool', 'scope', 'projectRoot', 'location'],
        ['kind', 'skill', 'tool', 'scope', 'projectRoot', 'location'],
        path,
      );
      string(resource.skill, `${path}.skill`);
      literal(resource.tool, tools, `${path}.tool`);
      literal(resource.scope, new Set(['user', 'project']), `${path}.scope`);
      if (resource.projectRoot !== null)
        validateLocation(resource.projectRoot, `${path}.projectRoot`);
      validateLocation(resource.location, `${path}.location`);
      return;
    case 'manifest-bytes':
    case 'lock':
      exactKeys(resource, ['kind', 'location'], ['kind', 'location'], path);
      validateLocation(resource.location, `${path}.location`);
      return;
    case 'ledger':
    case 'ledger-schema':
      exactKeys(resource, ['kind', 'projectRoot'], ['kind', 'projectRoot'], path);
      if (resource.projectRoot !== null)
        validateLocation(resource.projectRoot, `${path}.projectRoot`);
      return;
    case 'store':
      exactKeys(resource, ['kind', 'contentHash'], ['kind', 'contentHash'], path);
      validateDigest(resource.contentHash, `${path}.contentHash`);
      return;
    case 'project-context':
      exactKeys(resource, ['kind', 'root'], ['kind', 'root'], path);
      validateLocation(resource.root, `${path}.root`);
      return;
    default:
      fail(`${path}.kind is unsupported`);
  }
};

const validateManifestSnapshot = (value: unknown, path: string): void => {
  const manifest = record(value, path);
  exactKeys(
    manifest,
    ['version', 'defaults', 'registry', 'skills'],
    ['version', 'defaults', 'registry', 'skills'],
    path,
  );
  if (manifest.version !== 1) fail(`${path}.version must be 1`);
  if (manifest.defaults !== null) {
    const defaults = record(manifest.defaults, `${path}.defaults`);
    exactKeys(defaults, ['tools', 'scope', 'path'], ['tools', 'scope', 'path'], `${path}.defaults`);
    if (defaults.tools !== null) {
      const defaultTools = stringArray(defaults.tools, `${path}.defaults.tools`);
      rejectDuplicates(defaultTools, `${path}.defaults.tools`);
      for (const tool of defaultTools) literal(tool, tools, `${path}.defaults.tools`);
    }
    if (defaults.scope !== null) {
      literal(defaults.scope, new Set(['user', 'project']), `${path}.defaults.scope`);
    }
    string(defaults.path, `${path}.defaults.path`, true);
  }
  if (manifest.registry !== null) {
    const registry = record(manifest.registry, `${path}.registry`);
    exactKeys(registry, ['default'], ['default'], `${path}.registry`);
    string(registry.default, `${path}.registry.default`, true);
  }
  for (const [index, entryValue] of array(manifest.skills, `${path}.skills`).entries()) {
    const entryPath = `${path}.skills[${index}]`;
    const entry = record(entryValue, entryPath);
    exactKeys(
      entry,
      ['name', 'source', 'ref', 'tools', 'scope', 'placement', 'path'],
      ['name', 'source', 'ref', 'tools', 'scope', 'placement', 'path'],
      entryPath,
    );
    string(entry.name, `${entryPath}.name`);
    const source = record(entry.source, `${entryPath}.source`);
    exactKeys(
      source,
      ['host', 'repository', 'path'],
      ['host', 'repository', 'path'],
      `${entryPath}.source`,
    );
    string(source.host, `${entryPath}.source.host`);
    string(source.repository, `${entryPath}.source.repository`);
    string(source.path, `${entryPath}.source.path`, true);
    string(entry.ref, `${entryPath}.ref`, true);
    const entryTools = stringArray(entry.tools, `${entryPath}.tools`);
    rejectDuplicates(entryTools, `${entryPath}.tools`);
    for (const tool of entryTools) literal(tool, tools, `${entryPath}.tools`);
    literal(entry.scope, new Set(['user', 'project']), `${entryPath}.scope`);
    literal(entry.placement, new Set(['symlink', 'copy']), `${entryPath}.placement`);
    string(entry.path, `${entryPath}.path`, true);
  }
};

const validateLockSnapshot = (value: unknown, path: string): void => {
  const lock = record(value, path);
  exactKeys(
    lock,
    ['version', 'hashSchemaVersion', 'manifestHash', 'skills'],
    ['version', 'hashSchemaVersion', 'manifestHash', 'skills'],
    path,
  );
  if (lock.version !== 1) fail(`${path}.version must be 1`);
  if (lock.hashSchemaVersion !== 1) fail(`${path}.hashSchemaVersion must be 1`);
  validateDigest(lock.manifestHash, `${path}.manifestHash`);
  for (const [index, entryValue] of array(lock.skills, `${path}.skills`).entries()) {
    const entryPath = `${path}.skills[${index}]`;
    const entry = record(entryValue, entryPath);
    exactKeys(
      entry,
      ['name', 'source', 'requestedRef', 'resolvedSha', 'sourcePath', 'contentHash'],
      ['name', 'source', 'requestedRef', 'resolvedSha', 'sourcePath', 'contentHash'],
      entryPath,
    );
    string(entry.name, `${entryPath}.name`);
    string(entry.source, `${entryPath}.source`);
    string(entry.requestedRef, `${entryPath}.requestedRef`, true);
    string(entry.resolvedSha, `${entryPath}.resolvedSha`);
    string(entry.sourcePath, `${entryPath}.sourcePath`);
    validateDigest(entry.contentHash, `${entryPath}.contentHash`);
  }
};

const validateImage = (value: unknown, path: string): void => {
  const image = record(value, path);
  if (image.kind === 'absent') {
    exactKeys(image, ['kind', 'resource'], ['kind', 'resource'], path);
    validateResource(image.resource, `${path}.resource`);
    return;
  }
  if (image.kind === 'placement') {
    exactKeys(
      image,
      [
        'kind',
        'resource',
        'classification',
        'representation',
        'linkTarget',
        'dangling',
        'source',
        'contentHash',
      ],
      [
        'kind',
        'resource',
        'classification',
        'representation',
        'linkTarget',
        'dangling',
        'source',
        'contentHash',
      ],
      path,
    );
    validateResource(image.resource, `${path}.resource`);
    if (record(image.resource, `${path}.resource`).kind !== 'live') {
      fail(`${path}.resource must identify a live placement`);
    }
    literal(
      image.classification,
      new Set(['dev', 'pinned', 'store-linked', 'unmanaged']),
      `${path}.classification`,
    );
    literal(image.representation, new Set(['symlink', 'copy', 'other']), `${path}.representation`);
    if (image.linkTarget !== null) validateLocation(image.linkTarget, `${path}.linkTarget`);
    boolean(image.dangling, `${path}.dangling`);
    if (image.source !== null) validateSource(image.source, `${path}.source`);
    if (image.contentHash !== null) validateDigest(image.contentHash, `${path}.contentHash`);
    if ((image.source === null) !== (image.contentHash === null)) {
      fail(`${path}.source and contentHash must be present together`);
    }
    return;
  }
  if (image.kind === 'manifest') {
    exactKeys(
      image,
      ['kind', 'location', 'shape', 'version', 'byteHash', 'semanticHash', 'value'],
      ['kind', 'location', 'shape', 'version', 'byteHash', 'semanticHash', 'value'],
      path,
    );
    validateLocation(image.location, `${path}.location`);
    literal(image.shape, new Set(['canonical', 'legacy']), `${path}.shape`);
    if (image.version !== 1) fail(`${path}.version must be 1`);
    validateDigest(image.byteHash, `${path}.byteHash`);
    validateDigest(image.semanticHash, `${path}.semanticHash`);
    validateManifestSnapshot(image.value, `${path}.value`);
    return;
  }
  if (image.kind === 'lock') {
    exactKeys(
      image,
      ['kind', 'location', 'version', 'canonicalHash', 'value'],
      ['kind', 'location', 'version', 'canonicalHash', 'value'],
      path,
    );
    validateLocation(image.location, `${path}.location`);
    if (image.version !== 1) fail(`${path}.version must be 1`);
    validateDigest(image.canonicalHash, `${path}.canonicalHash`);
    validateLockSnapshot(image.value, `${path}.value`);
    return;
  }
  if (image.kind === 'ledger') {
    exactKeys(
      image,
      ['kind', 'projectRoot', 'schemaVersion', 'byteHash', 'semanticHash'],
      ['kind', 'projectRoot', 'schemaVersion', 'byteHash', 'semanticHash'],
      path,
    );
    if (image.projectRoot !== null) validateLocation(image.projectRoot, `${path}.projectRoot`);
    if (image.schemaVersion !== 1 && image.schemaVersion !== 2) {
      fail(`${path}.schemaVersion must be 1 or 2`);
    }
    validateDigest(image.byteHash, `${path}.byteHash`);
    validateDigest(image.semanticHash, `${path}.semanticHash`);
    return;
  }
  fail(`${path}.kind is unsupported`);
};

const validateReason = (value: unknown, path: string): void => {
  const reason = record(value, path);
  exactKeys(reason, ['code', 'message'], ['code', 'message'], path);
  string(reason.code, `${path}.code`);
  string(reason.message, `${path}.message`);
};

const validateConflict = (value: unknown, path: string): void => {
  const conflict = record(value, path);
  exactKeys(
    conflict,
    ['class', 'normal', 'forced', 'target', 'backup'],
    ['class', 'normal', 'forced', 'target', 'backup'],
    path,
  );
  literal(
    conflict.class,
    new Set([
      'unmanaged-target',
      'modified-managed-target',
      'destination-exists',
      'source-changed',
    ]),
    `${path}.class`,
  );
  if (conflict.normal !== 'refuse') fail(`${path}.normal must be refuse`);
  validateResource(conflict.target, `${path}.target`);
  if (conflict.class === 'source-changed') {
    if (conflict.forced !== 'replace' || conflict.backup !== 'none')
      fail(`${path} source-changed policy is invalid`);
  } else if (conflict.forced !== 'backup-and-replace' || conflict.backup !== 'required') {
    fail(`${path} replacement policy is invalid`);
  }
};

const identityFromOperation = (operation: ExecutableOperation): OperationIdentity => ({
  domain: 'skillsmith.operation-identity',
  schemaVersion: 1,
  groupId: operation.groupId,
  pairId: operation.pairId,
  kind: operation.kind,
  skill: operation.skill,
  source: operation.source,
  tool: operation.tool,
  scope: operation.scope,
});

const validateIdentity = (value: unknown, path: string): OperationIdentity => {
  const identity = record(value, path);
  exactKeys(
    identity,
    ['domain', 'schemaVersion', 'groupId', 'pairId', 'kind', 'skill', 'source', 'tool', 'scope'],
    ['domain', 'schemaVersion', 'groupId', 'pairId', 'kind', 'skill', 'source', 'tool', 'scope'],
    path,
  );
  if (identity.domain !== 'skillsmith.operation-identity' || identity.schemaVersion !== 1) {
    fail(`${path} has an unsupported identity domain or schema`);
  }
  validateStructuredId(identity.groupId, 'group', `${path}.groupId`);
  if (identity.pairId !== null) {
    validateStructuredId(identity.pairId, 'pair', `${path}.pairId`);
  }
  literal(identity.kind, operationKinds, `${path}.kind`);
  string(identity.skill, `${path}.skill`, true);
  if (identity.source !== null) validateSource(identity.source, `${path}.source`);
  if (identity.tool !== null) literal(identity.tool, tools, `${path}.tool`);
  if (identity.scope !== null)
    literal(identity.scope, new Set(['user', 'project']), `${path}.scope`);
  return identity as unknown as OperationIdentity;
};

const validateGroupIdentity = (value: unknown, path: string): OperationGroupIdentity => {
  const identity = record(value, path);
  exactKeys(
    identity,
    ['domain', 'schemaVersion', 'command', 'skill', 'source', 'scope', 'target'],
    ['domain', 'schemaVersion', 'command', 'skill', 'source', 'scope', 'target'],
    path,
  );
  if (identity.domain !== 'skillsmith.operation-group-identity' || identity.schemaVersion !== 1) {
    fail(`${path} has an unsupported group identity domain or schema`);
  }
  literal(identity.command, new Set(['install', 'uninstall', 'dev', 'promote']), `${path}.command`);
  string(identity.skill, `${path}.skill`, true);
  if (identity.source !== null) validateSource(identity.source, `${path}.source`);
  if (identity.scope !== null) {
    literal(identity.scope, new Set(['user', 'project']), `${path}.scope`);
  }
  string(identity.target, `${path}.target`, true);
  if (
    identity.skill === null &&
    identity.source === null &&
    identity.scope === null &&
    identity.target === null
  ) {
    fail(`${path} must contain at least one grouping fact`);
  }
  return identity as unknown as OperationGroupIdentity;
};

const validatePairIdentity = (value: unknown, path: string): OperationPairIdentity => {
  const identity = record(value, path);
  exactKeys(
    identity,
    ['domain', 'schemaVersion', 'groupId', 'tool', 'resource'],
    ['domain', 'schemaVersion', 'groupId', 'tool', 'resource'],
    path,
  );
  if (identity.domain !== 'skillsmith.operation-pair-identity' || identity.schemaVersion !== 1) {
    fail(`${path} has an unsupported pair identity domain or schema`);
  }
  validateStructuredId(identity.groupId, 'group', `${path}.groupId`);
  literal(identity.tool, tools, `${path}.tool`);
  validateResource(identity.resource, `${path}.resource`);
  const resource = identity.resource as UnknownRecord;
  if (resource.kind === 'live' && resource.tool !== identity.tool) {
    fail(`${path}.tool must match its live resource`);
  }
  return identity as unknown as OperationPairIdentity;
};

export function createOperationGroupId(input: OperationGroupIdentity): string;
export function createOperationGroupId(input: unknown): string {
  const snapshot = snapshotOrdinary(input);
  const identity = validateGroupIdentity(snapshot, '$groupIdentity');
  return createStructuredPlanningId('group', identity);
}

export function createOperationPairId(input: OperationPairIdentity): string;
export function createOperationPairId(input: unknown): string {
  const snapshot = snapshotOrdinary(input);
  const identity = validatePairIdentity(snapshot, '$pairIdentity');
  return createStructuredPlanningId('pair', identity);
}

export function createOperationId(input: OperationIdentity): string;
export function createOperationId(input: unknown): string {
  const snapshot = snapshotOrdinary(input);
  const identity = validateIdentity(snapshot, '$identity');
  return createStructuredPlanningId('operation', identity);
}

const validateOperation = (value: unknown, path: string): ExecutableOperation => {
  const operation = record(value, path);
  exactKeys(
    operation,
    [
      'operationId',
      'groupId',
      'pairId',
      'kind',
      'dependencyMetadata',
      'skill',
      'source',
      'tool',
      'scope',
      'before',
      'after',
      'reason',
      'selectionSource',
      'preconditionIds',
      'requiredCheckIds',
      'reversibility',
      'mutates',
      'conflict',
    ],
    [
      'operationId',
      'groupId',
      'pairId',
      'kind',
      'dependencyMetadata',
      'skill',
      'source',
      'tool',
      'scope',
      'before',
      'after',
      'reason',
      'selectionSource',
      'preconditionIds',
      'requiredCheckIds',
      'reversibility',
      'mutates',
      'conflict',
    ],
    path,
  );
  validateOperationId(operation.operationId, `${path}.operationId`);
  validateStructuredId(operation.groupId, 'group', `${path}.groupId`);
  if (operation.pairId !== null) {
    validateStructuredId(operation.pairId, 'pair', `${path}.pairId`);
  }
  literal(operation.kind, operationKinds, `${path}.kind`);
  string(operation.skill, `${path}.skill`, true);
  if (operation.source !== null) validateSource(operation.source, `${path}.source`);
  if (operation.tool !== null) literal(operation.tool, tools, `${path}.tool`);
  if (operation.scope !== null)
    literal(operation.scope, new Set(['user', 'project']), `${path}.scope`);
  validateImage(operation.before, `${path}.before`);
  validateImage(operation.after, `${path}.after`);
  validateReason(operation.reason, `${path}.reason`);
  literal(operation.selectionSource, selectionSources, `${path}.selectionSource`);
  const preconditionIds = stringArray(operation.preconditionIds, `${path}.preconditionIds`);
  const requiredCheckIds = stringArray(operation.requiredCheckIds, `${path}.requiredCheckIds`);
  rejectDuplicates(preconditionIds, `${path}.preconditionIds`);
  rejectDuplicates(requiredCheckIds, `${path}.requiredCheckIds`);

  const dependency = record(operation.dependencyMetadata, `${path}.dependencyMetadata`);
  exactKeys(
    dependency,
    ['domain', 'schemaVersion', 'operationIds'],
    ['domain', 'schemaVersion', 'operationIds'],
    `${path}.dependencyMetadata`,
  );
  if (dependency.domain !== 'skillsmith.operation-dependency' || dependency.schemaVersion !== 1) {
    fail(`${path}.dependencyMetadata has an unsupported domain or schema version`);
  }
  const dependencyIds = stringArray(
    dependency.operationIds,
    `${path}.dependencyMetadata.operationIds`,
  );
  rejectDuplicates(dependencyIds, `${path}.dependencyMetadata.operationIds`);

  const reversibility = record(operation.reversibility, `${path}.reversibility`);
  exactKeys(
    reversibility,
    ['kind', 'retentionResourceIds'],
    ['kind', 'retentionResourceIds'],
    `${path}.reversibility`,
  );
  literal(
    reversibility.kind,
    new Set(['none', 'reversible', 'conditional']),
    `${path}.reversibility.kind`,
  );
  const retentionIds = stringArray(
    reversibility.retentionResourceIds,
    `${path}.reversibility.retentionResourceIds`,
  );
  rejectDuplicates(retentionIds, `${path}.reversibility.retentionResourceIds`);
  if (reversibility.kind === 'none' ? retentionIds.length !== 0 : retentionIds.length === 0) {
    fail(`${path}.reversibility retention is inconsistent`);
  }

  const mutates = record(operation.mutates, `${path}.mutates`);
  exactKeys(
    mutates,
    ['live', 'manifest', 'lock', 'ledger'],
    ['live', 'manifest', 'lock', 'ledger'],
    `${path}.mutates`,
  );
  for (const key of ['live', 'manifest', 'lock', 'ledger'])
    boolean(mutates[key], `${path}.mutates.${key}`);
  if (operation.conflict !== null) validateConflict(operation.conflict, `${path}.conflict`);

  const typed = operation as unknown as ExecutableOperation;
  if (typed.operationId !== createOperationId(identityFromOperation(typed))) {
    fail(`${path}.operationId does not match its semantic identity`);
  }
  return typed;
};

const validateCheck = (value: unknown, path: string): PlanCheck => {
  const check = record(value, path);
  const common = ['checkId', 'blocking', 'operationIds', 'kind'];
  const variantKeys: Record<string, string[]> = {
    'source-resolution': ['source'],
    capability: ['capabilityPreconditionId'],
    'content-integrity': ['source', 'expectedContentHash'],
    verification: ['tool', 'mode', 'expectedContentHash'],
    'precondition-validation': ['preconditionIds'],
  };
  const extras = typeof check.kind === 'string' ? variantKeys[check.kind] : undefined;
  if (!extras) return fail(`${path}.kind is unsupported`);
  exactKeys(check, [...common, ...extras], [...common, ...extras], path);
  validateStructuredId(check.checkId, 'check', `${path}.checkId`);
  if (check.blocking !== true) fail(`${path}.blocking must be true`);
  const operationIds = stringArray(check.operationIds, `${path}.operationIds`, true);
  rejectDuplicates(operationIds, `${path}.operationIds`);
  if (check.kind === 'source-resolution') {
    validateSource(check.source, `${path}.source`);
    if (record(check.source, `${path}.source`).kind !== 'portable') {
      fail(`${path}.source must be portable`);
    }
  }
  if (check.kind === 'capability')
    string(check.capabilityPreconditionId, `${path}.capabilityPreconditionId`);
  if (check.kind === 'content-integrity') {
    validateSource(check.source, `${path}.source`);
    validateDigest(check.expectedContentHash, `${path}.expectedContentHash`);
  }
  if (check.kind === 'verification') {
    literal(check.tool, tools, `${path}.tool`);
    literal(check.mode, new Set(['static', 'static+deep']), `${path}.mode`);
    validateDigest(check.expectedContentHash, `${path}.expectedContentHash`);
  }
  if (check.kind === 'precondition-validation') {
    const ids = stringArray(check.preconditionIds, `${path}.preconditionIds`, true);
    rejectDuplicates(ids, `${path}.preconditionIds`);
  }
  return check as unknown as PlanCheck;
};

const validateDiagnostic = (value: unknown, path: string): PlanningDiagnostic => {
  const diagnostic = record(value, path);
  exactKeys(
    diagnostic,
    [
      'diagnosticId',
      'kind',
      'severity',
      'refusalClass',
      'affected',
      'correlation',
      'reason',
      'selectionSource',
    ],
    [
      'diagnosticId',
      'kind',
      'severity',
      'refusalClass',
      'affected',
      'correlation',
      'reason',
      'selectionSource',
    ],
    path,
  );
  validateStructuredId(diagnostic.diagnosticId, 'diagnostic', `${path}.diagnosticId`);
  literal(diagnostic.kind, diagnosticKinds, `${path}.kind`);
  literal(diagnostic.severity, new Set(['info', 'warning', 'error']), `${path}.severity`);
  if (diagnostic.refusalClass !== null) {
    literal(
      diagnostic.refusalClass,
      new Set(['usage', 'state', 'capability', 'source', 'permission']),
      `${path}.refusalClass`,
    );
  }
  const affected = record(diagnostic.affected, `${path}.affected`);
  exactKeys(
    affected,
    ['skill', 'source', 'tool', 'scope', 'path'],
    ['skill', 'source', 'tool', 'scope', 'path'],
    `${path}.affected`,
  );
  string(affected.skill, `${path}.affected.skill`, true);
  if (affected.source !== null) validateSource(affected.source, `${path}.affected.source`);
  if (affected.tool !== null) literal(affected.tool, tools, `${path}.affected.tool`);
  if (affected.scope !== null)
    literal(affected.scope, new Set(['user', 'project']), `${path}.affected.scope`);
  if (affected.path !== null) validateLocation(affected.path, `${path}.affected.path`);
  const correlation = record(diagnostic.correlation, `${path}.correlation`);
  exactKeys(
    correlation,
    ['groupId', 'pairId', 'operationId'],
    ['groupId', 'pairId', 'operationId'],
    `${path}.correlation`,
  );
  string(correlation.groupId, `${path}.correlation.groupId`, true);
  string(correlation.pairId, `${path}.correlation.pairId`, true);
  string(correlation.operationId, `${path}.correlation.operationId`, true);
  if (correlation.groupId !== null) {
    validateStructuredId(correlation.groupId, 'group', `${path}.correlation.groupId`);
  }
  if (correlation.pairId !== null) {
    validateStructuredId(correlation.pairId, 'pair', `${path}.correlation.pairId`);
  }
  if (correlation.operationId !== null) {
    validateOperationId(correlation.operationId, `${path}.correlation.operationId`);
  }
  validateReason(diagnostic.reason, `${path}.reason`);
  literal(diagnostic.selectionSource, selectionSources, `${path}.selectionSource`);
  return diagnostic as unknown as PlanningDiagnostic;
};

const validateCheckIdentity = (value: unknown, path: string): PlanCheckIdentity => {
  const identity = record(value, path);
  const common = ['domain', 'schemaVersion', 'operationIds', 'kind'];
  const variantKeys: Record<string, string[]> = {
    'source-resolution': ['source'],
    capability: ['capabilityPreconditionId'],
    'content-integrity': ['source', 'expectedContentHash'],
    verification: ['tool', 'mode', 'expectedContentHash'],
    'precondition-validation': ['preconditionIds'],
  };
  const extras = typeof identity.kind === 'string' ? variantKeys[identity.kind] : undefined;
  if (!extras) return fail(`${path}.kind is unsupported`);
  exactKeys(identity, [...common, ...extras], [...common, ...extras], path);
  if (identity.domain !== 'skillsmith.plan-check-identity' || identity.schemaVersion !== 1) {
    fail(`${path} has an unsupported check identity domain or schema`);
  }
  const checkFacts = Object.fromEntries(
    Object.entries(identity).filter(([key]) => key !== 'domain' && key !== 'schemaVersion'),
  );
  const check = validateCheck(
    {
      checkId: `check:v1:${'0'.repeat(64)}`,
      blocking: true,
      ...checkFacts,
    },
    path,
  );
  for (const operationId of check.operationIds) {
    validateOperationId(operationId, `${path}.operationIds`);
  }
  identity.operationIds = sortPlanningStrings(check.operationIds);
  if ('preconditionIds' in check) {
    identity.preconditionIds = sortPlanningStrings(check.preconditionIds);
  }
  return identity as unknown as PlanCheckIdentity;
};

const validatePlanningDiagnosticIdentity = (
  value: unknown,
  path: string,
): PlanningDiagnosticIdentity => {
  const identity = record(value, path);
  exactKeys(
    identity,
    [
      'domain',
      'schemaVersion',
      'kind',
      'severity',
      'refusalClass',
      'affected',
      'correlation',
      'reasonCode',
      'selectionSource',
    ],
    [
      'domain',
      'schemaVersion',
      'kind',
      'severity',
      'refusalClass',
      'affected',
      'correlation',
      'reasonCode',
      'selectionSource',
    ],
    path,
  );
  if (
    identity.domain !== 'skillsmith.planning-diagnostic-identity' ||
    identity.schemaVersion !== 1
  ) {
    fail(`${path} has an unsupported diagnostic identity domain or schema`);
  }
  const diagnostic = validateDiagnostic(
    {
      diagnosticId: `diagnostic:v1:${'0'.repeat(64)}`,
      kind: identity.kind,
      severity: identity.severity,
      refusalClass: identity.refusalClass,
      affected: identity.affected,
      correlation: identity.correlation,
      reason: { code: identity.reasonCode, message: 'semantic diagnostic identity' },
      selectionSource: identity.selectionSource,
    },
    path,
  );
  if (diagnostic.correlation.groupId !== null) {
    validateStructuredId(diagnostic.correlation.groupId, 'group', `${path}.correlation.groupId`);
  }
  if (diagnostic.correlation.pairId !== null) {
    validateStructuredId(diagnostic.correlation.pairId, 'pair', `${path}.correlation.pairId`);
  }
  if (diagnostic.correlation.operationId !== null) {
    validateOperationId(diagnostic.correlation.operationId, `${path}.correlation.operationId`);
  }
  return identity as unknown as PlanningDiagnosticIdentity;
};

export function createPlanCheckId(input: PlanCheckIdentity): string;
export function createPlanCheckId(input: unknown): string {
  const snapshot = snapshotOrdinary(input);
  const identity = validateCheckIdentity(snapshot, '$checkIdentity');
  return createStructuredPlanningId('check', identity);
}

export function createPlanningDiagnosticId(input: PlanningDiagnosticIdentity): string;
export function createPlanningDiagnosticId(input: unknown): string {
  const snapshot = snapshotOrdinary(input);
  const identity = validatePlanningDiagnosticIdentity(snapshot, '$diagnosticIdentity');
  return createStructuredPlanningId('diagnostic', identity);
}

const canonicalSelection = (value: unknown): OperationSelection => {
  const selection = record(value, '$plan.selection');
  exactKeys(
    selection,
    ['source', 'outcome', 'targets', 'all', 'skills', 'tools', 'scopes', 'groupIds'],
    ['source', 'tools', 'scopes'],
    '$plan.selection',
  );
  literal(selection.source, selectionSources, '$plan.selection.source');
  if (selection.outcome !== undefined)
    literal(selection.outcome, new Set(['selected', 'filter-noop']), '$plan.selection.outcome');
  if (selection.all !== undefined) boolean(selection.all, '$plan.selection.all');
  const output: UnknownRecord = { ...selection };
  for (const key of ['targets', 'skills', 'groupIds'] as const) {
    if (selection[key] === undefined) continue;
    const values = stringArray(selection[key], `$plan.selection.${key}`);
    rejectDuplicates(values, `$plan.selection.${key}`);
    if (key === 'groupIds') {
      for (const groupId of values) {
        validateStructuredId(groupId, 'group', '$plan.selection.groupIds');
      }
    }
    output[key] = sortPlanningStrings(values);
  }
  const selectedTools = stringArray(selection.tools, '$plan.selection.tools');
  rejectDuplicates(selectedTools, '$plan.selection.tools');
  for (const tool of selectedTools) literal(tool, tools, '$plan.selection.tools');
  output.tools = sortPlanningTools(selectedTools);
  const scopes = stringArray(selection.scopes, '$plan.selection.scopes');
  rejectDuplicates(scopes, '$plan.selection.scopes');
  for (const scope of scopes)
    literal(scope, new Set(['user', 'project']), '$plan.selection.scopes');
  output.scopes = sortPlanningScopes(scopes);
  return output as unknown as OperationSelection;
};

const canonicalizeCheck = (
  check: PlanCheck,
  operationIndex: ReadonlyMap<string, number>,
): PlanCheck => {
  const output = check as unknown as UnknownRecord;
  output.operationIds = [...check.operationIds].sort(
    (left, right) =>
      (operationIndex.get(left) ?? Number.POSITIVE_INFINITY) -
        (operationIndex.get(right) ?? Number.POSITIVE_INFINITY) || comparePlanningText(left, right),
  );
  if ('preconditionIds' in check)
    output.preconditionIds = sortPlanningStrings(check.preconditionIds);
  return output as unknown as PlanCheck;
};

export function createOperationPlan<Command extends CurrentMutatorCommand>(
  input: OperationPlanInput<Command>,
): OperationPlan<Command>;
export function createOperationPlan(input: unknown): CurrentMutatorOperationPlan {
  const snapshot = snapshotOrdinary(input);
  const plan = record(snapshot, '$plan');
  exactKeys(
    plan,
    [
      'domain',
      'schemaVersion',
      'command',
      'selection',
      'batchPolicy',
      'operations',
      'checks',
      'diagnostics',
    ],
    [
      'domain',
      'schemaVersion',
      'command',
      'selection',
      'batchPolicy',
      'operations',
      'checks',
      'diagnostics',
    ],
    '$plan',
  );
  if (plan.domain !== 'skillsmith.operation-plan' || plan.schemaVersion !== 1) {
    fail('$plan has an unsupported domain or schema version');
  }
  literal(plan.command, new Set(['install', 'uninstall', 'dev', 'promote']), '$plan.command');
  literal(plan.batchPolicy, new Set(['fail-fast', 'continue-on-error']), '$plan.batchPolicy');
  plan.selection = canonicalSelection(plan.selection);
  if (
    (plan.command === 'dev' || plan.command === 'promote') &&
    (plan.selection as unknown as OperationSelection).source === 'bounded-default'
  ) {
    fail(`$plan.selection.source must be explicit for ${plan.command}`);
  }

  const operations = array(plan.operations, '$plan.operations').map((operation, index) =>
    validateOperation(operation, `$plan.operations[${index}]`),
  );
  const operationIds = operations.map((operation) => operation.operationId);
  rejectDuplicates(operationIds, '$plan.operations.operationId');
  operations.sort(compareExecutableOperations);
  const operationIndex = new Map(
    operations.map((operation, index) => [operation.operationId, index]),
  );
  for (const operation of operations) {
    const dependencies = [...operation.dependencyMetadata.operationIds];
    dependencies.sort(
      (left, right) =>
        (operationIndex.get(left) ?? Number.POSITIVE_INFINITY) -
          (operationIndex.get(right) ?? Number.POSITIVE_INFINITY) ||
        comparePlanningText(left, right),
    );
    for (const dependency of dependencies) {
      const dependencyIndex = operationIndex.get(dependency);
      if (dependencyIndex === undefined) {
        fail(`operation ${operation.operationId} has a dangling dependency`);
      }
      if ((dependencyIndex as number) >= (operationIndex.get(operation.operationId) ?? -1)) {
        fail(`operation ${operation.operationId} has a forward or cyclic dependency`);
      }
    }
    (operation.dependencyMetadata as unknown as UnknownRecord).operationIds = dependencies;
    (operation as unknown as UnknownRecord).preconditionIds = sortPlanningStrings(
      operation.preconditionIds,
    );
    (operation as unknown as UnknownRecord).requiredCheckIds = sortPlanningStrings(
      operation.requiredCheckIds,
    );
  }

  const checks = array(plan.checks, '$plan.checks').map((check, index) =>
    validateCheck(check, `$plan.checks[${index}]`),
  );
  rejectDuplicates(
    checks.map((check) => check.checkId),
    '$plan.checks.checkId',
  );
  for (const check of checks) {
    for (const operationId of check.operationIds) {
      if (!operationIndex.has(operationId))
        fail(`check ${check.checkId} references an unknown operation`);
    }
  }
  const checkIds = new Set(checks.map((check) => check.checkId));
  for (const operation of operations) {
    for (const checkId of operation.requiredCheckIds) {
      if (!checkIds.has(checkId))
        fail(`operation ${operation.operationId} requires an unknown check`);
    }
  }
  for (const check of checks) canonicalizeCheck(check, operationIndex);
  checks.sort((left, right) => comparePlanChecks(operationIndex, left, right));

  const diagnostics = array(plan.diagnostics, '$plan.diagnostics').map((diagnostic, index) =>
    validateDiagnostic(diagnostic, `$plan.diagnostics[${index}]`),
  );
  rejectDuplicates(
    diagnostics.map((diagnostic) => diagnostic.diagnosticId),
    '$plan.diagnostics.diagnosticId',
  );
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.correlation.operationId !== null &&
      !operationIndex.has(diagnostic.correlation.operationId)
    ) {
      fail(`diagnostic ${diagnostic.diagnosticId} references an unknown operation`);
    }
  }
  diagnostics.sort(comparePlanningDiagnostics);
  plan.operations = operations;
  plan.checks = checks;
  plan.diagnostics = diagnostics;
  return deepFreeze(plan as unknown as CurrentMutatorOperationPlan);
}

const validateForceEffect = (value: unknown, path: string): void => {
  const force = record(value, path);
  exactKeys(
    force,
    [
      'requested',
      'applied',
      'conflictType',
      'target',
      'normalBehavior',
      'forcedBehavior',
      'backup',
    ],
    [
      'requested',
      'applied',
      'conflictType',
      'target',
      'normalBehavior',
      'forcedBehavior',
      'backup',
    ],
    path,
  );
  boolean(force.requested, `${path}.requested`);
  boolean(force.applied, `${path}.applied`);
  if (force.conflictType === null) {
    if (
      force.target !== null ||
      force.normalBehavior !== null ||
      force.forcedBehavior !== null ||
      force.backup !== null ||
      force.applied === true
    ) {
      fail(`${path} has conflict facts without a conflict`);
    }
    return;
  }
  literal(
    force.conflictType,
    new Set([
      'unmanaged-target',
      'modified-managed-target',
      'destination-exists',
      'source-changed',
    ]),
    `${path}.conflictType`,
  );
  validateResource(force.target, `${path}.target`);
  if (force.normalBehavior !== 'refuse') fail(`${path}.normalBehavior must be refuse`);
  literal(
    force.forcedBehavior,
    new Set(['backup-and-replace', 'replace']),
    `${path}.forcedBehavior`,
  );
  literal(force.backup, new Set(['required', 'none']), `${path}.backup`);
  if (!force.requested) fail(`${path} cannot carry a conflict when force was not requested`);
  if (force.conflictType === 'source-changed') {
    if (force.forcedBehavior !== 'replace' || force.backup !== 'none') {
      fail(`${path} source-changed policy is invalid`);
    }
  } else if (force.forcedBehavior !== 'backup-and-replace' || force.backup !== 'required') {
    fail(`${path} replacement policy is invalid`);
  }
};

export function createBoundedForceEffect(input: BoundedForceEffectInput): BoundedForceEffect;
export function createBoundedForceEffect(input: unknown): BoundedForceEffect {
  const snapshot = snapshotOrdinary(input);
  const request = record(snapshot, '$force');
  exactKeys(
    request,
    ['supported', 'requested', 'applied', 'conflict'],
    ['supported', 'requested', 'conflict'],
    '$force',
  );
  const supported = boolean(request.supported, '$force.supported');
  const requested = boolean(request.requested, '$force.requested');
  const applied =
    request.applied === undefined ? false : boolean(request.applied, '$force.applied');
  if (!supported && (requested || applied || request.conflict !== null))
    fail('$force is unsupported');
  if (!requested && (applied || request.conflict !== null)) fail('$force was not requested');
  if (request.conflict === null) {
    if (applied) fail('$force cannot apply without a conflict');
    return deepFreeze({
      requested,
      applied: false,
      conflictType: null,
      target: null,
      normalBehavior: null,
      forcedBehavior: null,
      backup: null,
    });
  }
  validateConflict(request.conflict, '$force.conflict');
  const conflict = request.conflict as unknown as BoundedConflict;
  if (conflict.class === 'source-changed') {
    return deepFreeze({
      requested: true,
      applied,
      conflictType: conflict.class,
      target: conflict.target,
      normalBehavior: conflict.normal,
      forcedBehavior: conflict.forced,
      backup: conflict.backup,
    });
  }
  return deepFreeze({
    requested: true,
    applied,
    conflictType: conflict.class,
    target: conflict.target,
    normalBehavior: conflict.normal,
    forcedBehavior: conflict.forced,
    backup: conflict.backup,
  });
}

export function createOperationExecutionResult(
  input: OperationExecutionResultInput,
): OperationExecutionResult;
export function createOperationExecutionResult(input: unknown): OperationExecutionResult {
  const snapshot = snapshotOrdinary(input);
  const result = record(snapshot, '$result');
  exactKeys(
    result,
    ['operationId', 'outcome', 'actualBefore', 'actualAfter', 'force', 'error'],
    ['operationId', 'outcome', 'actualBefore', 'actualAfter', 'force', 'error'],
    '$result',
  );
  validateOperationId(result.operationId, '$result.operationId');
  literal(result.outcome, executionOutcomes, '$result.outcome');
  validateImage(result.actualBefore, '$result.actualBefore');
  validateImage(result.actualAfter, '$result.actualAfter');
  if (result.force !== null) validateForceEffect(result.force, '$result.force');
  if (result.error !== null) {
    const error = record(result.error, '$result.error');
    exactKeys(
      error,
      ['code', 'message', 'remediation'],
      ['code', 'message', 'remediation'],
      '$result.error',
    );
    string(error.code, '$result.error.code');
    string(error.message, '$result.error.message');
    string(error.remediation, '$result.error.remediation');
  }
  if (result.outcome === 'failed' ? result.error === null : result.error !== null) {
    fail('$result.error must be present exactly for failed outcomes');
  }
  return deepFreeze(result as unknown as OperationExecutionResult);
}
