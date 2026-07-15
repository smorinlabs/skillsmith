import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_PATH = join(import.meta.dir, '../fixtures/p3a-ts03/duplicate-cases.json');
const PLANNED_READER_PATH = join(import.meta.dir, '../../../packages/core/src/inventory/read.ts');
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
  | Readonly<{ readonly ok: true; readonly value: InventoryProduct | readonly UnknownRecord[] }>
  | Readonly<{ readonly ok: false; readonly error: unknown }>;
type InventoryAuthority = (
  ports: UnknownRecord,
  options: UnknownRecord,
) => Promise<InventoryResult>;
type ResolveConfiguration = (env: Readonly<Record<string, string | undefined>>) => UnknownRecord;

interface ScanTracker {
  readonly calls: Record<string, number>;
  readonly forbidden: string[];
  readonly observations: string[];
}

interface ScanExecution {
  readonly product: InventoryProduct;
  readonly tracker: ScanTracker;
  readonly authority: 'planned-readSkillInventory' | 'current-listSkills-fallback';
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

let readInventory: InventoryAuthority;
let authorityKind: ScanExecution['authority'];
let configuration: UnknownRecord;

const increment = (tracker: ScanTracker, name: string): void => {
  tracker.calls[name] = (tracker.calls[name] ?? 0) + 1;
};

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

const portsFor = (rows: readonly DuplicateRow[], reverse: boolean) => {
  const rootEntries = new Map<string, string[]>();
  const files = new Map<string, string>();
  const realpaths = new Map<string, string>();
  for (const row of rows) {
    const names = rootEntries.get(row.root) ?? [];
    names.push(row.name);
    rootEntries.set(row.root, names);
    files.set(`${row.path}/SKILL.md`, `---\ndescription: ${row.frontmatter.description}\n---\n`);
    realpaths.set(row.path, row.realpath);
  }

  const tracker: ScanTracker = { calls: {}, forbidden: [], observations: [] };
  const read = <T>(name: string, operation: () => T): T => {
    increment(tracker, name);
    return operation();
  };
  const forbidden = (name: string): never => {
    tracker.forbidden.push(name);
    throw new Error(`inventory read invoked forbidden effect ${name}`);
  };
  const ports: UnknownRecord = Object.freeze({
    homeDir: '/h',
    executableSearchPath: Object.freeze([]),
    platform: 'linux',
    xdg: Object.freeze({ config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' }),
    fileExists: async (path: string) =>
      read('fileExists', () => rootEntries.has(path) || files.has(path)),
    listDir: async (path: string) =>
      read('listDir', () => {
        const values = [...(rootEntries.get(path) ?? [])];
        return reverse ? values.reverse() : values;
      }),
    readText: async (path: string) => read('readText', () => files.get(path) ?? ''),
    readBytes: async () => read('readBytes', () => new Uint8Array()),
    realpath: async (path: string) => read('realpath', () => realpaths.get(path) ?? path),
    pathKind: async (path: string) =>
      read('pathKind', () =>
        files.has(path) ? 'file' : rootEntries.has(path) || realpaths.has(path) ? 'dir' : 'absent',
      ),
    readFileMetadata: async (path: string) =>
      read('readFileMetadata', () => ({
        kind: files.has(path)
          ? 'file'
          : rootEntries.has(path) || realpaths.has(path)
            ? 'dir'
            : 'absent',
        mode: null,
        identity: realpaths.get(path) ?? path,
      })),
    readLink: async () => read('readLink', () => ''),
    isExecutable: async () => read('isExecutable', () => false),
    modifiedAt: async () => read('modifiedAt', () => null),
    writeText: async () => forbidden('writeText'),
    writeTextFile: async () => forbidden('writeTextFile'),
    makeDir: async () => forbidden('makeDir'),
    makeSymlink: async () => forbidden('makeSymlink'),
    rename: async () => forbidden('rename'),
    copyTree: async () => forbidden('copyTree'),
    removeTree: async () => forbidden('removeTree'),
    fsyncFile: async () => forbidden('fsyncFile'),
    fsyncDir: async () => forbidden('fsyncDir'),
    withFileLock: async () => forbidden('withFileLock'),
  });
  const observation: UnknownRecord = Object.freeze({
    context: Object.freeze({ command: 'skillsmith list', workflow: 'EWP-P3A-TS03' }),
    emitter: Object.freeze({
      begin: () => {
        tracker.observations.push('begin');
        return Object.freeze({ id: `span-${tracker.observations.length}` });
      },
      complete: () => {
        tracker.observations.push('complete');
      },
      emit: () => {
        tracker.observations.push('emit');
      },
    }),
  });
  return { ports, observation, tracker };
};

const toProduct = (value: InventoryProduct | readonly UnknownRecord[]): InventoryProduct =>
  Array.isArray(value)
    ? Object.freeze({ entries: value, collisionGroups: Object.freeze([]) })
    : (value as InventoryProduct);

const scanFixture = async (reverse = false, duplicatesOnly = false): Promise<ScanExecution> => {
  const harness = portsFor(fixture.rows, reverse);
  const result = await readInventory(harness.ports, {
    tools: TOOLS,
    scopes: SCOPES,
    duplicatesOnly,
    cwd: '/repo',
    configuration,
    observation: harness.observation,
  });
  if (!result.ok) {
    return {
      product: Object.freeze({ entries: Object.freeze([]), collisionGroups: Object.freeze([]) }),
      tracker: harness.tracker,
      authority: authorityKind,
      error: result.error,
    };
  }
  return {
    product: toProduct(result.value),
    tracker: harness.tracker,
    authority: authorityKind,
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

const checkTracker = (violations: string[], execution: ScanExecution, label: string): void => {
  const reads = Object.values(execution.tracker.calls).reduce((total, count) => total + count, 0);
  add(
    violations,
    reads <= 8 * fixture.expected.rawObservations + 128,
    `${label}: read calls ${reads} exceed 8N+128`,
  );
  add(
    violations,
    execution.tracker.forbidden.length === 0,
    `${label}: forbidden effects ${execution.tracker.forbidden.join(',')}`,
  );
  const begins = execution.tracker.observations.filter((event) => event === 'begin').length;
  const completes = execution.tracker.observations.filter((event) => event === 'complete').length;
  add(violations, begins > 0, `${label}: no observation span began`);
  add(violations, begins === completes, `${label}: observation spans did not balance`);
  add(
    violations,
    execution.tracker.observations.length <= 2 * TOOLS.length + 8,
    `${label}: observation events were unbounded (${execution.tracker.observations.length})`,
  );
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

  const [scanner, runtime] = await Promise.all([
    import('../../../packages/core/src/scan/list-skills.ts'),
    import('../../../packages/core/src/config/runtime.ts'),
  ]);
  const currentListSkills = scanner.listSkills as unknown as InventoryAuthority;
  if (await Bun.file(PLANNED_READER_PATH).exists()) {
    const planned = (await import(PLANNED_READER_PATH)) as UnknownRecord;
    if (typeof planned.readSkillInventory !== 'function') {
      throw new Error('planned inventory/read.ts must export readSkillInventory');
    }
    readInventory = planned.readSkillInventory as InventoryAuthority;
    authorityKind = 'planned-readSkillInventory';
  } else {
    readInventory = async (ports, options) => {
      const result = await currentListSkills(ports, options);
      return result.ok
        ? { ok: true, value: { entries: result.value, collisionGroups: Object.freeze([]) } }
        : result;
    };
    authorityKind = 'current-listSkills-fallback';
  }
  configuration = (runtime.resolveRuntimeConfiguration as ResolveConfiguration)({});
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
    checkTracker(violations, execution, 'family57');
    expect(violations, execution.authority).toEqual([]);
  });

  test('family 58: permutations, duplicate projection, aliases, shared targets, freezing, and bounds remain deterministic', async () => {
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
      checkTracker(violations, execution, label);
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
