import { type SkillSmithError, unknownToolError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type InventoryBundle,
  TOOL_OPERATIONS,
  type ToolAdapter,
  type ToolCapabilityScope,
  type ToolOperation,
  type ToolOperationFact,
} from './adapter-types.ts';
import { claudeCodeAdapter } from './claude-code/index.ts';
import { codexAdapter } from './codex/index.ts';
import { kiloCodeAdapter } from './kilo-code/index.ts';
import { opencodeAdapter } from './opencode/index.ts';

const BUILT_IN_ADAPTERS = [
  claudeCodeAdapter,
  codexAdapter,
  kiloCodeAdapter,
  opencodeAdapter,
] as const;

type AdapterId<Adapter> = Adapter extends { readonly descriptor: { readonly id: infer Id } }
  ? Extract<Id, string>
  : never;
type BuiltInAdapter = (typeof BUILT_IN_ADAPTERS)[number];

export type BuiltInToolId = AdapterId<BuiltInAdapter>;
export type VerificationToolId = AdapterId<
  Extract<BuiltInAdapter, { readonly verification: unknown }>
>;
export type PlacementToolId = AdapterId<Extract<BuiltInAdapter, { readonly placement: unknown }>>;

/** Public 1.x name retained as a derived inventory projection. */
export type Agent = InventoryBundle<BuiltInToolId>;

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

export interface ToolRegistry<ToolId extends string = string> {
  readonly adapters: readonly ToolAdapter<ToolId>[];
  readonly ids: readonly ToolId[];
  get(id: string): ToolAdapter<ToolId> | undefined;
  toolsFor(operation: ToolOperation): readonly ToolId[];
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
const REQUIRED_INVENTORY_OPERATIONS = [
  'detect',
  'inventory-skills',
  'inventory-commands',
  'diagnostics',
] as const satisfies readonly ToolOperation[];

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
  if (typeof inventory.installHint !== 'string' || inventory.installHint.trim() === '') {
    fail(`${adapter.descriptor.id} inventory install hint is empty`);
  }
  for (const operation of REQUIRED_INVENTORY_OPERATIONS) {
    if (adapter.descriptor.operations[operation].supported !== true) {
      fail(`${adapter.descriptor.id} required inventory operation ${operation} is unsupported`);
    }
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
  if (!operations || typeof operations !== 'object') fail(`${id} operations are missing`);
  const actual = Object.keys(operations).sort();
  const expected = [...TOOL_OPERATIONS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${id} operations are incomplete`);

  for (const operation of TOOL_OPERATIONS) {
    const capability = operations[operation];
    if (!capability || typeof capability !== 'object')
      fail(`${id} ${operation} capability missing`);
    if (typeof capability.supported !== 'boolean') {
      fail(`${id} ${operation} supported must be boolean`);
    }
    const scopes = capability.scopes;
    if (!Array.isArray(scopes)) fail(`${id} ${operation} scopes must be an array`);
    if (new Set(scopes).size !== scopes.length)
      fail(`${id} ${operation} scopes contain duplicates`);
    for (const scope of scopes) {
      if (typeof scope !== 'string') fail(`${id} ${operation} scope must be a string`);
      if (!VALID_SCOPES.has(scope)) fail(`${id} ${operation} scope '${scope}' is invalid`);
    }
    if (capability.supported) {
      if (operation === 'detect' && scopes.length !== 0) {
        fail(`${id} detect must be unscoped`);
      }
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
    const verification = adapter.verification;
    requireFunction(verification.verify, `${id} verification.verify`);
    if (
      typeof verification.verifiedAgainst !== 'string' ||
      verification.verifiedAgainst.trim() === ''
    ) {
      fail(`${id} verification version is empty`);
    }
    if (!Array.isArray(verification.modes)) fail(`${id} verification modes must be an array`);
    const expectedModes = [
      ...(verifyStatic ? (['static'] as const) : []),
      ...(verifyDeep ? (['deep'] as const) : []),
    ];
    if (JSON.stringify(verification.modes) !== JSON.stringify(expectedModes)) {
      fail(`${id} verification modes drift from its descriptor`);
    }
    const gatePolicy = verification.gatePolicy;
    if (
      !gatePolicy ||
      typeof gatePolicy !== 'object' ||
      typeof gatePolicy.installDeep !== 'boolean' ||
      (gatePolicy.promote !== 'static' && gatePolicy.promote !== 'static+deep')
    ) {
      fail(`${id} verification gate policy is invalid`);
    }
    if (
      !verifyStatic ||
      ((gatePolicy.installDeep || gatePolicy.promote === 'static+deep') && !verifyDeep)
    ) {
      fail(`${id} verification gate policy requires unsupported verification modes`);
    }
    if (!Array.isArray(verification.targetManifests) || verification.targetManifests.length === 0) {
      fail(`${id} verification target manifests are empty`);
    }
    for (const manifest of verification.targetManifests) {
      if (
        typeof manifest !== 'string' ||
        manifest.trim() === '' ||
        manifest.startsWith('/') ||
        manifest.split('/').includes('..')
      ) {
        fail(`${id} verification target manifest is invalid`);
      }
    }
    const rendered = verification.renderedFacts;
    if (
      !rendered ||
      typeof rendered !== 'object' ||
      (rendered.deepSkillCoverageSuffix !== null &&
        typeof rendered.deepSkillCoverageSuffix !== 'string') ||
      (rendered.installStaticNotice !== null && typeof rendered.installStaticNotice !== 'function')
    ) {
      fail(`${id} verification rendered facts are invalid`);
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
  if (
    adapter.adaptation &&
    (!Number.isSafeInteger(adapter.adaptation.version) || adapter.adaptation.version <= 0)
  ) {
    fail(`${id} adaptation version must be a positive safe integer`);
  }
};

const cloneAdapter = <ToolId extends string>(
  adapter: ToolAdapter<ToolId>,
): ToolAdapter<ToolId> => ({
  descriptor: {
    ...adapter.descriptor,
    operations: Object.fromEntries(
      TOOL_OPERATIONS.map((operation) => {
        const capability = adapter.descriptor.operations[operation];
        return [operation, { ...capability, scopes: [...capability.scopes] }] as const;
      }),
    ) as unknown as ToolAdapter<ToolId>['descriptor']['operations'],
  },
  inventory: { ...adapter.inventory },
  ...(adapter.verification
    ? {
        verification: {
          ...adapter.verification,
          modes: [...adapter.verification.modes],
          gatePolicy: { ...adapter.verification.gatePolicy },
          targetManifests: [...adapter.verification.targetManifests],
          renderedFacts: { ...adapter.verification.renderedFacts },
        },
      }
    : {}),
  ...(adapter.placement ? { placement: { ...adapter.placement } } : {}),
  ...(adapter.adaptation ? { adaptation: { ...adapter.adaptation } } : {}),
});

type RegisteredId<Adapters extends readonly ToolAdapter<string>[]> = AdapterId<Adapters[number]>;

export function createToolRegistry<const Adapters extends readonly ToolAdapter<string>[]>(
  input: Adapters,
): ToolRegistry<RegisteredId<Adapters>>;
export function createToolRegistry(input: readonly unknown[]): ToolRegistry;
export function createToolRegistry(input: readonly unknown[]): ToolRegistry {
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
    validateOperations(adapter);
    validateInventory(adapter);
    validateBundles(adapter);
  }

  const ordered = adapters
    .map((adapter) => cloneAdapter(adapter))
    .sort((left, right) => left.descriptor.order - right.descriptor.order);
  const byId = new Map(ordered.map((adapter) => [adapter.descriptor.id, adapter]));
  const registry: ToolRegistry = {
    adapters: ordered,
    ids: ordered.map((adapter) => adapter.descriptor.id),
    get: (id) => byId.get(id),
    toolsFor: (operation) =>
      Object.freeze(
        ordered
          .filter((adapter) => adapter.descriptor.operations[operation].supported)
          .map((adapter) => adapter.descriptor.id),
      ),
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
}

export const toolRegistry = createToolRegistry(BUILT_IN_ADAPTERS);

export const SUPPORTED_TOOLS = toolRegistry.ids as readonly [BuiltInToolId, ...BuiltInToolId[]];
export const VERIFY_TOOLS = Object.freeze([...toolRegistry.toolsFor('verify-static')]) as readonly [
  VerificationToolId,
  ...VerificationToolId[],
];
export const FLIP_TOOLS = Object.freeze([...toolRegistry.toolsFor('install')]) as readonly [
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
