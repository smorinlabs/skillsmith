import { type SkillSmithError, unknownToolError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type Agent,
  type BuiltInToolId,
  type PlacementToolId,
  TOOL_OPERATIONS,
  type ToolAdapter,
  type ToolCapabilityScope,
  type ToolOperation,
  type ToolOperationFact,
  type VerificationToolId,
} from './adapter-types.ts';
import { claudeCodeAdapter } from './claude-code/index.ts';
import { codexAdapter } from './codex/index.ts';
import { kiloCodeAdapter } from './kilo-code/index.ts';
import { opencodeAdapter } from './opencode/index.ts';

export interface ToolCapabilityError {
  readonly code: 'capability';
  readonly exitCode: 4;
  readonly tool: string;
  readonly operation: ToolOperation;
  readonly remediation: string;
}

export interface ToolUsageError {
  readonly code: 'usage';
  readonly exitCode: 2;
  readonly tool: string;
  readonly operation: ToolOperation;
  readonly message: string;
}

export type ToolCapabilityResult = ToolOperationFact | ToolCapabilityError | ToolUsageError;

export interface ToolRegistry {
  readonly adapters: readonly ToolAdapter[];
  readonly ids: readonly string[];
  get(id: string): ToolAdapter | undefined;
  toolsFor(operation: ToolOperation): readonly string[];
  capability(id: string, operation: ToolOperation): ToolCapabilityResult;
}

const VALID_SCOPES = new Set<ToolCapabilityScope>([
  'user',
  'project',
  'system',
  'managed',
  'custom',
  'artifact',
]);
const MUTATION_OPERATIONS = new Set<ToolOperation>([
  'install',
  'uninstall',
  'dev',
  'promote',
  'undo',
  'plan',
  'apply',
  'sync',
  'update',
]);

const fail = (message: string): never => {
  throw new Error(`tool registry: ${message}`);
};

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
};

const requireFunction = (value: unknown, label: string): void => {
  if (typeof value !== 'function') fail(`${label} must be a function`);
};

const validateInventory = (adapter: ToolAdapter): void => {
  const inventory = adapter.inventory;
  if (!inventory || typeof inventory !== 'object')
    fail(`${adapter.descriptor.id} inventory missing`);
  if (inventory.tool !== adapter.descriptor.id) {
    fail(`${adapter.descriptor.id} descriptor/inventory identity drift`);
  }
  for (const method of [
    'detect',
    'getSkillRoots',
    'getCommandRoots',
    'getPluginSkillDir',
    'getPluginCommandDir',
  ] as const) {
    requireFunction(inventory[method], `${adapter.descriptor.id} inventory.${method}`);
  }
};

const validateOperations = (adapter: ToolAdapter): void => {
  const { id, operations } = adapter.descriptor;
  const actual = Object.keys(operations).sort();
  const expected = [...TOOL_OPERATIONS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${id} operations are incomplete`);

  for (const operation of TOOL_OPERATIONS) {
    const capability = operations[operation];
    if (!capability || typeof capability !== 'object')
      fail(`${id} ${operation} capability missing`);
    const scopes = capability.scopes;
    if (!Array.isArray(scopes)) fail(`${id} ${operation} scopes must be an array`);
    if (new Set(scopes).size !== scopes.length)
      fail(`${id} ${operation} scopes contain duplicates`);
    for (const scope of scopes) {
      if (!VALID_SCOPES.has(scope)) fail(`${id} ${operation} scope '${scope}' is invalid`);
    }
    if (capability.supported) {
      if (operation !== 'detect' && scopes.length === 0) {
        fail(`${id} supported ${operation} requires a scope`);
      }
      if (capability.remediation !== null) {
        fail(`${id} supported ${operation} must not declare remediation`);
      }
    } else {
      if (scopes.length > 0) fail(`${id} unsupported ${operation} cannot declare scopes`);
      if (typeof capability.remediation !== 'string' || capability.remediation.trim() === '') {
        fail(`${id} unsupported ${operation} requires remediation`);
      }
    }
  }
};

const validateBundles = (adapter: ToolAdapter): void => {
  const { id, operations } = adapter.descriptor;
  const verifyStatic = operations['verify-static'].supported;
  const verifyDeep = operations['verify-deep'].supported;
  const verificationDeclared = verifyStatic || verifyDeep;
  if (verificationDeclared && !adapter.verification) {
    fail(`${id} declares verification without a verifier bundle`);
  }
  if (!verificationDeclared && adapter.verification) {
    fail(`${id} verification bundle is undeclared by its descriptor`);
  }
  if (adapter.verification) {
    requireFunction(adapter.verification.verify, `${id} verification.verify`);
    if (!adapter.verification.verifiedAgainst.trim()) fail(`${id} verification version is empty`);
    const modes = new Set(adapter.verification.modes);
    if (modes.has('static') !== verifyStatic || modes.has('deep') !== verifyDeep) {
      fail(`${id} verification modes drift from its descriptor`);
    }
    if (adapter.verification.targetManifests.length === 0) {
      fail(`${id} verification target manifests are empty`);
    }
  }

  const mutationDeclared = [...MUTATION_OPERATIONS].some(
    (operation) => operations[operation].supported,
  );
  if (mutationDeclared && !adapter.placement) {
    fail(`${id} declares mutation without a placement bundle`);
  }
  if (!mutationDeclared && adapter.placement) {
    fail(`${id} read-only descriptor cannot register a placement or mutation bundle`);
  }
  if (adapter.placement) {
    for (const method of ['roots', 'standardRoots', 'list', 'resolve', 'noticeForRoot'] as const) {
      requireFunction(adapter.placement[method], `${id} placement.${method}`);
    }
  }

  const adaptationDeclared = operations.adapt.supported;
  if (adaptationDeclared && !adapter.adaptation) {
    fail(`${id} declares adaptation without an adaptation bundle`);
  }
  if (!adaptationDeclared && adapter.adaptation) {
    fail(`${id} adaptation bundle is undeclared by its descriptor`);
  }
};

export const createToolRegistry = (input: readonly unknown[]): ToolRegistry => {
  const adapters = input as readonly ToolAdapter[];
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const adapter of adapters) {
    if (!adapter || typeof adapter !== 'object' || !adapter.descriptor) {
      fail('adapter descriptor or inventory missing');
    }
    const descriptor = adapter.descriptor;
    if (!/^[a-z][a-z0-9-]*$/.test(descriptor.id)) fail(`adapter id '${descriptor.id}' is invalid`);
    if (ids.has(descriptor.id)) fail(`duplicate id '${descriptor.id}'`);
    ids.add(descriptor.id);
    if (!Number.isSafeInteger(descriptor.order))
      fail(`${descriptor.id} order must be a safe integer`);
    if (orders.has(descriptor.order)) fail(`duplicate order '${descriptor.order}'`);
    orders.add(descriptor.order);
    if (!Number.isSafeInteger(descriptor.capabilityVersion) || descriptor.capabilityVersion <= 0) {
      fail(`${descriptor.id} capability version must be a positive safe integer`);
    }
    validateInventory(adapter);
    validateOperations(adapter);
    validateBundles(adapter);
  }

  const ordered = [...adapters].sort(
    (left, right) => left.descriptor.order - right.descriptor.order,
  );
  const byId = new Map(ordered.map((adapter) => [adapter.descriptor.id, adapter]));
  const registry: ToolRegistry = {
    adapters: ordered,
    ids: ordered.map((adapter) => adapter.descriptor.id),
    get: (id) => byId.get(id),
    toolsFor: (operation) =>
      ordered
        .filter((adapter) => adapter.descriptor.operations[operation].supported)
        .map((adapter) => adapter.descriptor.id),
    capability: (id, operation) => {
      const adapter = byId.get(id);
      if (!adapter) {
        return {
          code: 'usage',
          exitCode: 2,
          tool: id,
          operation,
          message: `unknown tool '${id}'`,
        };
      }
      const capability = adapter.descriptor.operations[operation];
      if (capability.supported) return capability;
      return {
        code: 'capability',
        exitCode: 4,
        tool: id,
        operation,
        remediation: capability.remediation ?? `${id} does not support ${operation}`,
      };
    },
  };
  return deepFreeze(registry);
};

export const toolRegistry = createToolRegistry([
  claudeCodeAdapter,
  codexAdapter,
  kiloCodeAdapter,
  opencodeAdapter,
]);

export const SUPPORTED_TOOLS = toolRegistry.ids as readonly [BuiltInToolId, ...BuiltInToolId[]];
export const VERIFY_TOOLS = toolRegistry.toolsFor('verify-static') as readonly [
  VerificationToolId,
  ...VerificationToolId[],
];
export const FLIP_TOOLS = toolRegistry.toolsFor('install') as readonly [
  PlacementToolId,
  ...PlacementToolId[],
];
export const VERIFIED_AGAINST = Object.freeze(
  Object.fromEntries(
    toolRegistry.adapters.flatMap((adapter) =>
      adapter.verification
        ? [[adapter.descriptor.id, adapter.verification.verifiedAgainst] as const]
        : [],
    ),
  ) as Record<VerificationToolId, string>,
);

export const registry = Object.freeze(
  Object.fromEntries(
    toolRegistry.adapters.map((adapter) => [adapter.descriptor.id, adapter.inventory]),
  ) as Record<BuiltInToolId, Agent>,
);

export const listSupportedTools = (): readonly BuiltInToolId[] => SUPPORTED_TOOLS;

export const getAgent = (tool: string): Result<Agent, SkillSmithError> => {
  const adapter = toolRegistry.get(tool);
  return adapter ? ok(adapter.inventory as Agent) : err(unknownToolError(tool));
};
