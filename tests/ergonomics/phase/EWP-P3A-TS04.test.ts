import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dir, '../fixtures/p3a-ts04');
const MIXED_PATH = join(FIXTURES, 'mixed-fleet.json');
const HUMAN_PATH = join(FIXTURES, 'status-human.golden.txt');
const JSON_PATH = join(FIXTURES, 'status-v1.golden.json');
const EXPECTED_FIXTURES = Object.freeze({
  'mixed-fleet.json': Object.freeze({
    bytes: 5077,
    sha256: 'sha256:b74c036389944872147ba4eef4eded5a2fae78c34340ffcdfe2acc2d9ca98666',
  }),
  'status-human.golden.txt': Object.freeze({
    bytes: 6671,
    sha256: 'sha256:d1093ccc0bec667959897a591224508c63f67bb3a48e5695929437aac1526803',
  }),
  'status-v1.golden.json': Object.freeze({
    bytes: 40893,
    sha256: 'sha256:0a4cbcb5f2000948e19692153361854779167d9f368c497cf95d5909736df26b',
  }),
});

type UnknownRecord = Record<string, unknown>;
type Result<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly error: UnknownRecord }>;
interface StatusCodec {
  readonly descriptor: UnknownRecord;
  validate(input: unknown): Result<UnknownRecord>;
  encode(input: UnknownRecord): Result<string>;
}
type ToStatusV1Dto = (report: UnknownRecord) => UnknownRecord;
type RenderStatus = (dto: UnknownRecord) => string;

interface MixedFleetFixture {
  readonly schemaVersion: 1;
  readonly expected: Readonly<{
    readonly uniqueNames: 14;
    readonly placementRows: 15;
    readonly tools: readonly string[];
    readonly scopes: readonly string[];
    readonly verification: readonly string[];
  }>;
  readonly entries: readonly Readonly<{
    readonly name: string;
    readonly kind: string;
    readonly placements: readonly Readonly<{
      readonly tool: string;
      readonly scope: string;
      readonly path: string | null;
      readonly classification: string;
      readonly verification: string;
      readonly shadow?: string;
      readonly journal?: string;
    }>[];
  }>[];
}

const bytesOf = (path: string): Uint8Array => readFileSync(path);
const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const unwrap = <T>(result: Result<T>, label: string): T => {
  if (!result.ok) {
    const failure = result as Readonly<{ readonly ok: false; readonly error: UnknownRecord }>;
    expect(false, `${label}: ${JSON.stringify(failure.error)}`).toBeTrue();
    throw new Error(label);
  }
  expect(result.ok, label).toBeTrue();
  return result.value;
};

const mixed = JSON.parse(readFileSync(MIXED_PATH, 'utf8')) as MixedFleetFixture;
const golden = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as UnknownRecord;
const humanGolden = readFileSync(HUMAN_PATH, 'utf8');
let statusV1Codec: StatusCodec;
let toStatusV1Dto: ToStatusV1Dto;
let renderStatusHuman: RenderStatus;
let renderStatusJson: RenderStatus;

const sortedUnique = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();

const permuteObjectMembers = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(permuteObjectMembers);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as UnknownRecord)
      .reverse()
      .map(([key, child]) => [key, permuteObjectMembers(child)]),
  );
};

beforeAll(async () => {
  // Literal hash/count/schema guards run before any planned status module is imported.
  for (const [name, expected] of Object.entries(EXPECTED_FIXTURES)) {
    const bytes = bytesOf(join(FIXTURES, name));
    expect(bytes.byteLength, name).toBe(expected.bytes);
    expect(sha256(bytes), name).toBe(expected.sha256);
  }
  expect(mixed.schemaVersion).toBe(1);
  expect(mixed.entries).toHaveLength(mixed.expected.uniqueNames);
  expect(new Set(mixed.entries.map((entry) => entry.name)).size).toBe(mixed.expected.uniqueNames);
  expect(mixed.entries.flatMap((entry) => entry.placements)).toHaveLength(
    mixed.expected.placementRows,
  );
  expect(
    sortedUnique(mixed.entries.flatMap((entry) => entry.placements.map((p) => p.tool))),
  ).toEqual([...mixed.expected.tools].sort());
  expect(
    sortedUnique(mixed.entries.flatMap((entry) => entry.placements.map((p) => p.scope))),
  ).toEqual([...mixed.expected.scopes].sort());
  expect(
    sortedUnique(mixed.entries.flatMap((entry) => entry.placements.map((p) => p.verification))),
  ).toEqual([...mixed.expected.verification].sort());
  expect(golden).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.status',
    summary: { entries: 14 },
  });
  expect(humanGolden.endsWith('\n')).toBeTrue();

  const [statusModule, contractModule, humanModule, jsonModule] = await Promise.all([
    import('../../../packages/core/src/status/index.ts').catch(() => null),
    import('../../../packages/core/src/contracts/v1/status.ts').catch(() => null),
    import('../../../packages/cli/src/output/status-human.ts').catch(() => null),
    import('../../../packages/cli/src/output/status-json.ts').catch(() => null),
  ]);
  if (
    statusModule === null ||
    typeof statusModule.readStatus !== 'function' ||
    contractModule === null ||
    typeof contractModule.toStatusV1Dto !== 'function' ||
    typeof contractModule.statusV1Codec !== 'object' ||
    humanModule === null ||
    typeof humanModule.renderStatusHuman !== 'function' ||
    jsonModule === null ||
    typeof jsonModule.renderStatusJson !== 'function'
  ) {
    throw new Error('missing G3A-01 status authority');
  }
  statusV1Codec = contractModule.statusV1Codec as StatusCodec;
  toStatusV1Dto = contractModule.toStatusV1Dto as ToStatusV1Dto;
  renderStatusHuman = humanModule.renderStatusHuman as RenderStatus;
  renderStatusJson = jsonModule.renderStatusJson as RenderStatus;
});

describe('EWP-P3A-TS04', () => {
  test('family 26: literal fixture hash/count/schema, exact mixed fleet, goldens/sort, deterministic read-only rendering', () => {
    const before = Object.fromEntries(
      Object.keys(EXPECTED_FIXTURES).map((name) => [name, sha256(bytesOf(join(FIXTURES, name)))]),
    );
    const entries = golden.entries as readonly UnknownRecord[];
    const placementRows = entries.flatMap(
      (entry) => (entry.placements as readonly UnknownRecord[]) ?? [],
    );
    expect(entries.map((entry) => entry.name)).toEqual(
      [...mixed.entries.map((entry) => entry.name)].sort(),
    );
    expect(placementRows).toHaveLength(15);
    expect(entries.find((entry) => entry.name === 'shadowed-fleet')?.placements).toHaveLength(2);
    expect(entries.find((entry) => entry.name === 'lock-only')?.placements).toHaveLength(0);

    expect(statusV1Codec.descriptor).toEqual({
      id: 'status',
      version: 1,
      wireKind: 'skillsmith.status',
      embeddedVersion: 'schemaVersion',
      unknownFields: 'reject-recursive',
      formatting: { indent: 2, terminalLf: true },
      migrations: [],
      compatibility: 'conservative',
    });
    const validated = unwrap(statusV1Codec.validate(golden), 'strict status@1 golden');
    expect(unwrap(statusV1Codec.encode(validated), 'status@1 encode')).toBe(
      readFileSync(JSON_PATH, 'utf8'),
    );
    const permuted = unwrap(
      statusV1Codec.validate(permuteObjectMembers(golden)),
      'permuted object-member status@1',
    );
    expect(unwrap(statusV1Codec.encode(permuted), 'permuted status@1 encode')).toBe(
      readFileSync(JSON_PATH, 'utf8'),
    );

    const { schemaVersion: _schemaVersion, kind: _kind, ...report } = golden;
    const forbiddenCalls: string[] = [];
    const forbiddenCapabilities = new Proxy(
      {},
      {
        get: (_target, property) => {
          forbiddenCalls.push(String(property));
          throw new Error(`status presentation touched forbidden capability ${String(property)}`);
        },
      },
    );
    const mapped = (toStatusV1Dto as (...args: unknown[]) => UnknownRecord)(
      structuredClone(report),
      forbiddenCapabilities,
    );
    expect(mapped).toEqual(golden);
    expect(renderStatusJson(mapped)).toBe(readFileSync(JSON_PATH, 'utf8'));
    expect(renderStatusJson(mapped)).toBe(readFileSync(JSON_PATH, 'utf8'));
    expect(
      (renderStatusHuman as (...args: unknown[]) => string)(mapped, forbiddenCapabilities),
    ).toBe(humanGolden);
    expect(forbiddenCalls).toEqual([]);

    expect(
      Object.fromEntries(
        Object.keys(EXPECTED_FIXTURES).map((name) => [name, sha256(bytesOf(join(FIXTURES, name)))]),
      ),
    ).toEqual(before);
  });
});
