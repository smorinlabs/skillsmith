import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dir, '../fixtures/p3a-ts01');
const EXPECTED_FIXTURES = Object.freeze({
  'inventory-cases.json': Object.freeze({
    bytes: 19_573,
    sha256: 'sha256:f7ef7f0ba3b82789cb1cdd2169978e9f732b0355ab0c7df866d4b282c24be40a',
  }),
  'list-compact.golden.txt': Object.freeze({
    bytes: 1_173,
    sha256: 'sha256:9337910c989e7e593ee7be505bed88a4219d9204e315a0f69972f54f0cbb53da',
  }),
  'list-long.golden.txt': Object.freeze({
    bytes: 6_101,
    sha256: 'sha256:a5f2f0dd2397fc8126ca586ddd72ea17330eb50cc6845ba1e4a6da82fe017a55',
  }),
  'list-v3.golden.json': Object.freeze({
    bytes: 21_894,
    sha256: 'sha256:fcef06d10f747f5ab4c6b02a1613206bb6148d4c4568b0dca59f7e40a5b6cec5',
  }),
});

type UnknownRecord = Record<string, unknown>;
interface InventoryFixture {
  readonly schemaVersion: 1;
  readonly rows: readonly UnknownRecord[];
}
type RenderHuman = (
  rows: readonly UnknownRecord[],
  options: Readonly<{ readonly long: boolean }>,
  forbidden?: unknown,
) => string;
type RenderJson = (rows: readonly UnknownRecord[], forbidden?: unknown) => string;

const bytesOf = (name: string): Uint8Array => readFileSync(join(FIXTURES, name));
const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fixture = JSON.parse(
  readFileSync(join(FIXTURES, 'inventory-cases.json'), 'utf8'),
) as InventoryFixture;
const compactGolden = readFileSync(join(FIXTURES, 'list-compact.golden.txt'), 'utf8');
const longGolden = readFileSync(join(FIXTURES, 'list-long.golden.txt'), 'utf8');
const jsonGolden = readFileSync(join(FIXTURES, 'list-v3.golden.json'), 'utf8');

let renderListHuman: RenderHuman;
let renderListJson: RenderJson;

const recursivelyFreeze = (value: unknown, seen = new Set<object>()): unknown => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) recursivelyFreeze(child, seen);
  return Object.freeze(value);
};

const sortedUnique = (values: readonly unknown[]): readonly string[] =>
  [...new Set(values.map(String))].sort();

beforeAll(async () => {
  // Literal byte/hash/schema guards run before the planned production renderers are imported.
  for (const [name, expected] of Object.entries(EXPECTED_FIXTURES)) {
    const bytes = bytesOf(name);
    expect(bytes.byteLength, `${name} byte length`).toBe(expected.bytes);
    expect(sha256(bytes), `${name} SHA-256`).toBe(expected.sha256);
  }
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.rows).toHaveLength(24);
  expect(new Set(fixture.rows.map((row) => row.name))).toHaveLength(24);
  expect(compactGolden.endsWith('\n')).toBeTrue();
  expect(longGolden.endsWith('\n')).toBeTrue();
  expect(jsonGolden.endsWith('\n')).toBeTrue();

  const [humanModule, jsonModule] = await Promise.all([
    import('../../../packages/cli/src/output/list-human.ts'),
    import('../../../packages/cli/src/output/list-json.ts'),
  ]);
  renderListHuman = humanModule.renderListHuman as unknown as RenderHuman;
  renderListJson = jsonModule.renderListJson as unknown as RenderJson;
});

describe('EWP-P3A-TS01', () => {
  test('family 55: literal fixture guards freeze the exact 24-row mixed inventory dimensions', () => {
    expect(sortedUnique(fixture.rows.map((row) => row.tool))).toEqual([
      'claude-code',
      'codex',
      'kilo-code',
      'opencode',
    ]);
    expect(sortedUnique(fixture.rows.map((row) => row.scope))).toEqual([
      'managed',
      'project',
      'system',
      'user',
    ]);
    expect(sortedUnique(fixture.rows.map((row) => row.mode))).toEqual([
      'dev',
      'pinned',
      'unmanaged',
    ]);
    expect(
      sortedUnique(
        fixture.rows.map((row) => (row.origin as UnknownRecord | undefined)?.kind ?? 'missing'),
      ),
    ).toEqual(['plugin', 'policy', 'standalone']);
    expect(sortedUnique(fixture.rows.map((row) => row.enabled))).toEqual(['off', 'on', 'unset']);
    expect(sortedUnique(fixture.rows.map((row) => row.verification))).toEqual([
      'passed',
      'skipped',
      'unrecorded',
      'warned',
    ]);
    for (const row of fixture.rows) {
      expect(Object.keys(row).sort(), String(row.name)).toEqual(
        [
          'description',
          'enabled',
          'frontmatter',
          'mode',
          'name',
          'origin',
          'path',
          'placement',
          'realpath',
          'revision',
          'root',
          'scope',
          'source',
          'store',
          'tool',
          'verification',
          'visibility',
        ].sort(),
      );
    }
  });

  test('family 56: compact, long, and list@3 goldens are immutable, deterministic, and read-only', () => {
    const before = Object.fromEntries(
      Object.keys(EXPECTED_FIXTURES).map((name) => [name, sha256(bytesOf(name))]),
    );
    const frozenRows = recursivelyFreeze(structuredClone(fixture.rows)) as readonly UnknownRecord[];
    const forbiddenCalls: string[] = [];
    const forbiddenCapabilities = new Proxy(
      {},
      {
        get: (_target, property) => {
          forbiddenCalls.push(String(property));
          throw new Error(
            `inventory presentation touched forbidden capability ${String(property)}`,
          );
        },
      },
    );

    expect(renderListHuman(frozenRows, { long: false }, forbiddenCapabilities)).toBe(compactGolden);
    expect(renderListHuman(frozenRows, { long: true }, forbiddenCapabilities)).toBe(longGolden);
    expect(renderListJson(frozenRows, forbiddenCapabilities)).toBe(jsonGolden);
    expect(renderListJson(frozenRows, forbiddenCapabilities)).toBe(jsonGolden);
    expect(forbiddenCalls).toEqual([]);
    expect(frozenRows).toEqual(fixture.rows);
    expect(
      Object.fromEntries(
        Object.keys(EXPECTED_FIXTURES).map((name) => [name, sha256(bytesOf(name))]),
      ),
    ).toEqual(before);
  });
});
