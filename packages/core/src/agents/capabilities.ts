import { hashCanonicalInput } from '../artifacts/hash.ts';
import type { CapabilityPreconditionV1 } from '../artifacts/plan-types.ts';
import { TOOL_OPERATIONS, type ToolCapabilityScope, type ToolOperation } from './adapter-types.ts';
import { type BuiltInToolId, type ToolRegistry, toolRegistry } from './registry.ts';

export interface RelevantCapabilityQueryV1 {
  readonly schemaVersion: 1;
  readonly tool: string;
  readonly operation: ToolOperation;
  readonly scope: ToolCapabilityScope;
}

export interface RelevantCapabilityFactV1 extends RelevantCapabilityQueryV1 {
  readonly capabilityVersion: number | null;
  readonly supported: boolean;
}

export interface RelevantCapabilitySnapshotV1 {
  readonly schemaVersion: 1;
  readonly facts: readonly RelevantCapabilityFactV1[];
}

const OPERATION_ORDER = new Map(
  TOOL_OPERATIONS.map((operation, index) => [operation, index] as const),
);
const SCOPE_ORDER = new Map<ToolCapabilityScope, number>(
  (
    [
      'user',
      'project',
      'system',
      'managed',
      'custom',
      'artifact',
    ] as const satisfies readonly ToolCapabilityScope[]
  ).map((scope, index) => [scope, index] as const),
);
const QUERY_KEYS = Object.freeze(['schemaVersion', 'tool', 'operation', 'scope']);

const queryKey = (query: RelevantCapabilityQueryV1): string =>
  `${query.tool}\0${query.operation}\0${query.scope}`;

const validQuery = (query: unknown): query is RelevantCapabilityQueryV1 => {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return false;
  const value = query as Readonly<Record<string, unknown>>;
  const keys = Object.keys(value).sort();
  return (
    keys.length === QUERY_KEYS.length &&
    keys.every((key, index) => key === [...QUERY_KEYS].sort()[index]) &&
    value.schemaVersion === 1 &&
    typeof value.tool === 'string' &&
    value.tool.length > 0 &&
    typeof value.operation === 'string' &&
    OPERATION_ORDER.has(value.operation as ToolOperation) &&
    typeof value.scope === 'string' &&
    SCOPE_ORDER.has(value.scope as ToolCapabilityScope)
  );
};

const compareQueriesByValue = (
  left: RelevantCapabilityQueryV1,
  right: RelevantCapabilityQueryV1,
): number => {
  if (left.tool !== right.tool) return left.tool < right.tool ? -1 : 1;
  const operation =
    (OPERATION_ORDER.get(left.operation) ?? 0) - (OPERATION_ORDER.get(right.operation) ?? 0);
  if (operation !== 0) return operation;
  return (SCOPE_ORDER.get(left.scope) ?? 0) - (SCOPE_ORDER.get(right.scope) ?? 0);
};

export const canonicalRelevantCapabilityQueriesV1 = (
  registry: Pick<ToolRegistry, 'ids'>,
  input: readonly RelevantCapabilityQueryV1[],
): readonly RelevantCapabilityQueryV1[] => {
  if (!Array.isArray(input)) throw new TypeError('relevant capability queries are invalid');
  const toolOrder = new Map(registry.ids.map((tool, index) => [tool, index] as const));
  const unique = new Map<string, RelevantCapabilityQueryV1>();
  for (const query of input) {
    if (!validQuery(query)) throw new TypeError('relevant capability query is invalid');
    const owned = Object.freeze({
      schemaVersion: 1 as const,
      tool: query.tool,
      operation: query.operation,
      scope: query.scope,
    });
    unique.set(queryKey(owned), owned);
  }
  return Object.freeze(
    [...unique.values()].sort((left, right) => {
      const leftOrder = toolOrder.get(left.tool);
      const rightOrder = toolOrder.get(right.tool);
      if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      if (leftOrder !== undefined && rightOrder === undefined) return -1;
      if (leftOrder === undefined && rightOrder !== undefined) return 1;
      return compareQueriesByValue(left, right);
    }),
  );
};

export const relevantCapabilityQueryDigestV1 = (
  queries: readonly RelevantCapabilityQueryV1[],
): `sha256:${string}` => {
  const canonical = [...queries].sort(compareQueriesByValue);
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-relevant-capability-queries',
      1,
      canonical.map(({ tool, operation, scope }) => [tool, operation, scope]),
    ]),
  );
  if (!hashed.ok) throw new Error('relevant capability query hash invariant failed');
  return hashed.value as `sha256:${string}`;
};

export const createRelevantCapabilitySnapshotV1 = (
  registry: Pick<ToolRegistry, 'get'>,
  queries: readonly RelevantCapabilityQueryV1[],
): RelevantCapabilitySnapshotV1 =>
  Object.freeze({
    schemaVersion: 1,
    facts: Object.freeze(
      queries.map((query) => {
        const adapter = registry.get(query.tool);
        const capability = adapter?.descriptor.operations[query.operation];
        return Object.freeze({
          schemaVersion: 1 as const,
          tool: query.tool,
          capabilityVersion: adapter?.descriptor.capabilityVersion ?? null,
          operation: query.operation,
          scope: query.scope,
          supported: capability?.supported === true && capability.scopes.includes(query.scope),
        });
      }),
    ),
  });

const isBuiltInTool = (tool: string): tool is BuiltInToolId =>
  toolRegistry.ids.some((candidate) => candidate === tool);

const preconditionHashes = (
  tool: BuiltInToolId,
  operation: ToolOperation,
  capabilityVersion: number,
  scopes: readonly ToolCapabilityScope[],
): Readonly<{
  expectedHash: CapabilityPreconditionV1['expectedHash'];
  preconditionId: string;
}> => {
  const expected = hashCanonicalInput(
    'capability',
    1,
    JSON.stringify([
      'skillsmith-capability-precondition',
      1,
      tool,
      operation,
      capabilityVersion,
      true,
      scopes,
    ]),
  );
  if (!expected.ok) throw new Error('capability precondition hash invariant failed');
  const identity = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-capability-precondition-identity', 1, expected.value]),
  );
  if (!identity.ok) throw new Error('capability precondition identity invariant failed');
  return Object.freeze({
    expectedHash: expected.value,
    preconditionId: `precondition:v1:${identity.value.slice('sha256:'.length)}`,
  });
};

export const toCapabilityPreconditionsV1 = (
  snapshot: RelevantCapabilitySnapshotV1,
): readonly CapabilityPreconditionV1[] => {
  const grouped = new Map<
    string,
    Readonly<{
      tool: BuiltInToolId;
      operation: ToolOperation;
      capabilityVersion: number;
      scopes: Set<ToolCapabilityScope>;
    }>
  >();
  for (const fact of snapshot.facts) {
    if (!fact.supported || fact.capabilityVersion === null || !isBuiltInTool(fact.tool)) {
      continue;
    }
    const key = `${fact.tool}\0${fact.operation}\0${fact.capabilityVersion}`;
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, {
        tool: fact.tool,
        operation: fact.operation,
        capabilityVersion: fact.capabilityVersion,
        scopes: new Set([fact.scope]),
      });
    } else {
      current.scopes.add(fact.scope);
    }
  }
  const output = [...grouped.values()]
    .sort((left, right) => {
      const tool = toolRegistry.ids.indexOf(left.tool) - toolRegistry.ids.indexOf(right.tool);
      if (tool !== 0) return tool;
      return (
        (OPERATION_ORDER.get(left.operation) ?? 0) - (OPERATION_ORDER.get(right.operation) ?? 0)
      );
    })
    .map((value) => {
      const scopes = [...value.scopes].sort(
        (left, right) => (SCOPE_ORDER.get(left) ?? 0) - (SCOPE_ORDER.get(right) ?? 0),
      );
      const hashes = preconditionHashes(
        value.tool,
        value.operation,
        value.capabilityVersion,
        scopes,
      );
      const precondition: CapabilityPreconditionV1 = {
        preconditionId: hashes.preconditionId,
        domain: 'capability',
        hashSchemaVersion: 1,
        expectedHash: hashes.expectedHash,
        tool: value.tool,
        operation: value.operation,
        capabilityVersion: value.capabilityVersion,
        supported: true,
        scopes,
      };
      Object.freeze(precondition.scopes);
      return Object.freeze(precondition);
    });
  return Object.freeze(output);
};
