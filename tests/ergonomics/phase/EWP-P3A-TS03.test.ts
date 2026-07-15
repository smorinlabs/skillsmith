import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_PATH = join(import.meta.dir, '../fixtures/p3a-ts03/duplicate-cases.json');
const PLANNED_PROJECTOR_PATH = join(
  import.meta.dir,
  '../../../packages/core/src/inventory/read.ts',
);
const FIXTURE_BYTES = 8738;
const FIXTURE_SHA256 = 'sha256:36f76ae82f78929beba6caec36393436df00f611bafc8599ddae0a963a36e18f';
const TOOLS = ['claude-code', 'codex', 'kilo-code', 'opencode'] as const;
const SCOPES = ['system', 'user', 'project', 'managed'] as const;
const SCOPE_ORDER = new Map(SCOPES.map((scope, index) => [scope, index] as const));

type UnknownRecord = Readonly<Record<string, unknown>>;
type Tool = (typeof TOOLS)[number];
type Scope = (typeof SCOPES)[number];

interface DuplicateRow {
  readonly id: string;
  readonly aliasOf?: string;
  readonly tool: Tool;
  readonly scope: Scope;
  readonly name: string;
  readonly root: string;
  readonly path: string;
  readonly realpath: string;
  readonly origin: UnknownRecord;
  readonly enabled: 'on' | 'off' | 'unset';
  readonly frontmatter: Readonly<{ readonly description: string }>;
  readonly expected: Readonly<{
    readonly state: 'unique' | 'winner' | 'shadowed' | 'duplicate';
    readonly winner: string | null;
  }>;
}

interface DuplicateFixture {
  readonly schemaVersion: 1;
  readonly expected: Readonly<{
    readonly rawObservations: 18;
    readonly normalizedPlacements: 17;
    readonly collisionIdentities: 5;
    readonly crossToolControls: 2;
    readonly uniqueControls: 3;
  }>;
  readonly rows: readonly DuplicateRow[];
}

interface InventoryProduct extends UnknownRecord {
  readonly entries: readonly UnknownRecord[];
  readonly collisionGroups: readonly UnknownRecord[];
}

type InventoryResult =
  | Readonly<{ readonly ok: true; readonly value: InventoryProduct }>
  | Readonly<{ readonly ok: false; readonly error: unknown }>;
type InventoryAuthority = (
  observations: readonly DuplicateRow[],
  options: UnknownRecord,
) => InventoryResult | Promise<InventoryResult>;

interface ScanExecution {
  readonly product: InventoryProduct;
  readonly authority: 'planned-projectSkillInventory';
  readonly error: unknown | null;
}

const bytesOf = (): Uint8Array => readFileSync(FIXTURE_PATH);
const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as DuplicateFixture;
const logicalKey = (row: Pick<DuplicateRow, 'tool' | 'scope' | 'name' | 'root' | 'path'>): string =>
  [row.tool, row.scope, row.name, row.root, row.path].join('\u0000');
const collisionKey = (row: Pick<DuplicateRow, 'tool' | 'name'>): string =>
  `${row.tool}\u0000${row.name}`;
const displayCollisionKey = (row: Pick<DuplicateRow, 'tool' | 'name'>): string =>
  `${row.tool}|${row.name}`;

let projectInventory: InventoryAuthority;

const recursivelyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor === undefined ||
      !('value' in descriptor) ||
      recursivelyFrozen(descriptor.value, seen)
    );
  });
};

const normalizedFixtureRows = (): readonly DuplicateRow[] => {
  const byPlacement = new Map<string, DuplicateRow>();
  for (const row of fixture.rows) {
    const key = logicalKey(row);
    const retained = byPlacement.get(key);
    if (retained === undefined) {
      byPlacement.set(key, row);
      continue;
    }
    expect(
      {
        tool: row.tool,
        scope: row.scope,
        name: row.name,
        root: row.root,
        path: row.path,
        realpath: row.realpath,
        origin: row.origin,
        enabled: row.enabled,
        frontmatter: row.frontmatter,
      },
      row.id,
    ).toEqual({
      tool: retained.tool,
      scope: retained.scope,
      name: retained.name,
      root: retained.root,
      path: retained.path,
      realpath: retained.realpath,
      origin: retained.origin,
      enabled: retained.enabled,
      frontmatter: retained.frontmatter,
    });
  }
  return [...byPlacement.values()];
};

// Reader effects, cancellation, and 8N+128 bounds are asserted by EWP-CMD-LIST-TS07 family 54.
const scanFixture = async (reverse = false, duplicatesOnly = false): Promise<ScanExecution> => {
  const observations = reverse ? [...fixture.rows].reverse() : fixture.rows;
  const result = await projectInventory(observations, {
    tools: TOOLS,
    scopes: SCOPES,
    duplicatesOnly,
  });
  if (!result.ok) {
    return {
      product: Object.freeze({ entries: Object.freeze([]), collisionGroups: Object.freeze([]) }),
      authority: 'planned-projectSkillInventory',
      error: result.error,
    };
  }
  return {
    product: result.value,
    authority: 'planned-projectSkillInventory',
    error: null,
  };
};

const add = (violations: string[], condition: boolean, message: string): void => {
  if (!condition) violations.push(message);
};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const expectedMembers = (row: DuplicateRow): readonly UnknownRecord[] =>
  normalizedFixtureRows()
    .filter((candidate) => collisionKey(candidate) === collisionKey(row))
    .sort((left, right) => {
      const scope = (SCOPE_ORDER.get(left.scope) ?? -1) - (SCOPE_ORDER.get(right.scope) ?? -1);
      return scope !== 0 ? scope : left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    })
    .map((candidate) => Object.freeze({ scope: candidate.scope, path: candidate.path }));

const actualMembers = (row: UnknownRecord): readonly UnknownRecord[] => {
  const visibility = row.visibility as UnknownRecord | undefined;
  const members = visibility?.members;
  if (!Array.isArray(members)) return [];
  return members.map((member) => {
    const value = member as UnknownRecord;
    return Object.freeze({ scope: value.scope, path: value.path });
  });
};

beforeAll(async () => {
  // Literal byte/hash/schema guards execute before current or planned production modules are loaded.
  const bytes = bytesOf();
  expect(bytes.byteLength).toBe(FIXTURE_BYTES);
  expect(sha256(bytes)).toBe(FIXTURE_SHA256);
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.rows).toHaveLength(fixture.expected.rawObservations);
  expect(new Set(fixture.rows.map((row) => row.id)).size).toBe(fixture.rows.length);
  expect(normalizedFixtureRows()).toHaveLength(fixture.expected.normalizedPlacements);
  const groups = new Map<string, number>();
  for (const row of normalizedFixtureRows()) {
    groups.set(collisionKey(row), (groups.get(collisionKey(row)) ?? 0) + 1);
  }
  expect([...groups.values()].filter((count) => count > 1)).toHaveLength(
    fixture.expected.collisionIdentities,
  );

  const planned = (await import(PLANNED_PROJECTOR_PATH)) as UnknownRecord;
  if (typeof planned.projectSkillInventory !== 'function') {
    throw new Error('planned inventory/read.ts must export projectSkillInventory');
  }
  projectInventory = planned.projectSkillInventory as InventoryAuthority;
});

describe('EWP-P3A-TS03', () => {
  test('family 57: exact fixture projects five tool-qualified identities, member lists, controls, and adapter results', async () => {
    const execution = await scanFixture();
    const rows = execution.product.entries;
    const violations: string[] = [];
    add(
      violations,
      execution.error === null,
      `inventory authority failed: ${String(execution.error)}`,
    );
    add(
      violations,
      rows.length === fixture.expected.normalizedPlacements,
      `expected ${fixture.expected.normalizedPlacements} placements, received ${rows.length}`,
    );

    const actualByKey = new Map(
      rows.map((row) => [logicalKey(row as unknown as DuplicateRow), row] as const),
    );
    const expectedRows = normalizedFixtureRows();
    add(
      violations,
      same([...actualByKey.keys()].sort(), expectedRows.map(logicalKey).sort()),
      'normalized logical placement keys differ from the frozen fixture',
    );
    for (const expected of expectedRows) {
      const key = logicalKey(expected);
      const actual = actualByKey.get(key);
      if (actual === undefined) {
        violations.push(`missing placement ${expected.id}`);
        continue;
      }
      const visibility = actual.visibility as UnknownRecord | undefined;
      add(
        violations,
        visibility?.state === expected.expected.state,
        `${expected.id}: visibility ${String(visibility?.state)} != ${expected.expected.state}`,
      );
      add(
        violations,
        visibility?.winner === expected.expected.winner,
        `${expected.id}: winner ${String(visibility?.winner)} != ${String(expected.expected.winner)}`,
      );
      add(
        violations,
        same(actualMembers(actual), expectedMembers(expected)),
        `${expected.id}: exact ordered member list mismatch`,
      );
    }

    const collisionIdentities = [
      ...new Set(
        rows
          .filter((row) => {
            const visibility = row.visibility as UnknownRecord | undefined;
            return visibility?.state !== undefined && visibility.state !== 'unique';
          })
          .map((row) => displayCollisionKey(row as unknown as DuplicateRow)),
      ),
    ].sort();
    const expectedCollisions = [
      'claude-code|claude-collision',
      'codex|codex-collision',
      'kilo-code|kilo-roots',
      'kilo-code|kilo-scope',
      'opencode|opencode-collision',
    ];
    add(
      violations,
      same(collisionIdentities, expectedCollisions),
      `collision identities differ: ${collisionIdentities.join(',')}`,
    );
    add(
      violations,
      execution.product.collisionGroups.length === fixture.expected.collisionIdentities,
      `collisionGroups length ${execution.product.collisionGroups.length} != ${fixture.expected.collisionIdentities}`,
    );

    const crossToolControls = rows.filter((row) => row.name === 'portable');
    add(
      violations,
      crossToolControls.length === fixture.expected.crossToolControls,
      `cross-tool controls ${crossToolControls.length} != ${fixture.expected.crossToolControls}`,
    );
    add(
      violations,
      same([...new Set(crossToolControls.map((row) => row.tool))].sort(), ['claude-code', 'codex']),
      'portable controls did not remain separate Claude/Codex identities',
    );
    add(
      violations,
      crossToolControls.every(
        (row) => (row.visibility as UnknownRecord | undefined)?.state === 'unique',
      ),
      'portable cross-tool controls were classified as duplicates',
    );

    const uniqueControls = rows.filter((row) => String(row.name).startsWith('unique-'));
    add(
      violations,
      uniqueControls.length === fixture.expected.uniqueControls,
      `unique controls ${uniqueControls.length} != ${fixture.expected.uniqueControls}`,
    );
    add(
      violations,
      same(uniqueControls.map((row) => row.name).sort(), [
        'unique-claude',
        'unique-kilo',
        'unique-opencode',
      ]),
      'unique controls differ from the frozen three-control set',
    );
    add(
      violations,
      uniqueControls.every(
        (row) => (row.visibility as UnknownRecord | undefined)?.state === 'unique',
      ),
      'a unique control was classified as a collision',
    );
    expect(violations, execution.authority).toEqual([]);
  });

  test('family 58: permutations, duplicate projection, aliases, shared targets, and freezing remain deterministic', async () => {
    const beforeBytes = sha256(bytesOf());
    const beforeFixture = structuredClone(fixture);
    const [forward, reverse, duplicateOnly] = await Promise.all([
      scanFixture(),
      scanFixture(true),
      scanFixture(false, true),
    ]);
    const violations: string[] = [];
    for (const [label, execution] of [
      ['forward', forward],
      ['reverse', reverse],
      ['duplicates', duplicateOnly],
    ] as const) {
      add(violations, execution.error === null, `${label}: ${String(execution.error)}`);
    }

    add(
      violations,
      same(reverse.product, forward.product),
      'reverse enumeration changed the immutable inventory product',
    );
    const expectedDuplicateKeys = new Set(
      normalizedFixtureRows()
        .filter((row) =>
          [
            'claude-code|claude-collision',
            'codex|codex-collision',
            'kilo-code|kilo-roots',
            'kilo-code|kilo-scope',
            'opencode|opencode-collision',
          ].includes(displayCollisionKey(row)),
        )
        .map(logicalKey),
    );
    add(
      violations,
      same(
        [
          ...new Set(
            duplicateOnly.product.entries.map((row) => logicalKey(row as unknown as DuplicateRow)),
          ),
        ].sort(),
        [...expectedDuplicateKeys].sort(),
      ),
      'duplicate-only projection did not retain every exact collision member',
    );
    add(
      violations,
      duplicateOnly.product.collisionGroups.length === fixture.expected.collisionIdentities,
      `duplicate-only collisionGroups length ${duplicateOnly.product.collisionGroups.length} != ${fixture.expected.collisionIdentities}`,
    );

    const codex = forward.product.entries.filter((row) => row.name === 'codex-collision');
    add(violations, codex.length === 3, `Codex alias collapse produced ${codex.length} placements`);
    add(
      violations,
      same(codex.map((row) => row.path).sort(), [
        '/h/.agents/skills/codex-collision',
        '/h/.codex/skills/codex-collision',
        '/repo/.agents/skills/codex-collision',
      ]),
      'Codex exact alias collapse retained the wrong logical paths',
    );

    const shared = forward.product.entries.filter((row) => row.name === 'kilo-roots');
    add(
      violations,
      shared.length === 2,
      `shared-realpath group produced ${shared.length} placements`,
    );
    add(
      violations,
      same(shared.map((row) => row.path).sort(), [
        '/repo/.claude/skills/kilo-roots',
        '/repo/.kilo/skills/kilo-roots',
      ]),
      'shared-realpath placements lost an exact logical path',
    );
    add(
      violations,
      new Set(shared.map((row) => row.realpath)).size === 1,
      'shared-realpath control no longer shares one physical target',
    );
    add(
      violations,
      recursivelyFrozen(forward.product),
      'forward inventory product is not deeply frozen',
    );
    add(
      violations,
      recursivelyFrozen(reverse.product),
      'reverse inventory product is not deeply frozen',
    );
    add(
      violations,
      recursivelyFrozen(duplicateOnly.product),
      'duplicate-only inventory product is not deeply frozen',
    );
    add(violations, same(fixture, beforeFixture), 'fixture object was mutated');
    add(
      violations,
      sha256(bytesOf()) === beforeBytes,
      'fixture bytes changed during inventory reads',
    );
    expect(violations, forward.authority).toEqual([]);
  });
});
