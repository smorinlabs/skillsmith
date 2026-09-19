import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import { INVENTORY_CANCELLED } from '../../src/inventory/cancellation.ts';
import { projectSkillInventory, readSkillInventory } from '../../src/inventory/read.ts';
import { tagInventoryRootOrdinal } from '../../src/inventory/types.ts';
import type { SkillEntry } from '../../src/skills/types.ts';

const fixturePath = join(
  import.meta.dir,
  '../../../../tests/ergonomics/fixtures/p3a-ts03/duplicate-cases.json',
);

interface FixtureRow extends SkillEntry {
  readonly expected: Readonly<{
    readonly state: 'unique' | 'winner' | 'shadowed' | 'duplicate';
    readonly winner: string | null;
  }>;
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Readonly<{
  readonly rows: readonly FixtureRow[];
}>;
const enrichedFixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../../tests/ergonomics/fixtures/p3a-ts01/inventory-cases.json'),
    'utf8',
  ),
) as Readonly<{ readonly rows: readonly SkillEntry[] }>;

const keyOf = (row: Pick<FixtureRow, 'tool' | 'scope' | 'name' | 'root' | 'path'>): string =>
  [row.tool, row.scope, row.name, row.root, row.path].join('\u0000');

const recursivelyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return (
    Object.isFrozen(value) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor === undefined ||
        !('value' in descriptor) ||
        recursivelyFrozen(descriptor.value, seen)
      );
    })
  );
};

describe('skill inventory projection', () => {
  test('collapses exact aliases and applies adapter-owned collision authority deterministically', () => {
    const before = structuredClone(fixture);
    const forward = projectSkillInventory(fixture.rows);
    const reverse = projectSkillInventory([...fixture.rows].reverse());
    expect(forward.ok).toBeTrue();
    expect(reverse.ok).toBeTrue();
    if (!forward.ok || !reverse.ok) return;

    expect(forward.value.entries).toHaveLength(17);
    expect(forward.value.collisionGroups).toHaveLength(5);
    expect(reverse.value).toEqual(forward.value);
    expect(recursivelyFrozen(forward.value)).toBeTrue();
    expect(fixture).toEqual(before);

    const expected = new Map<string, FixtureRow>();
    for (const row of fixture.rows) expected.set(keyOf(row), row);
    for (const entry of forward.value.entries) {
      const row = expected.get(keyOf(entry));
      expect(row, entry.path).toBeDefined();
      if (row === undefined) continue;
      expect(entry.visibility.state, entry.path).toBe(row.expected.state);
      expect(entry.visibility.winner, entry.path).toBe(row.expected.winner);
    }
  });

  test('rejects disagreeing facts at one raw logical placement', () => {
    const first = fixture.rows[0] as FixtureRow;
    const conflict: SkillEntry = {
      ...first,
      frontmatter: { description: 'different observation' },
    };
    const result = projectSkillInventory([first, conflict]);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error.code).toBe('config-error');
  });

  test('excludes internal root ordinal from exact-alias facts', () => {
    const source = fixture.rows[0] as FixtureRow;
    const first = tagInventoryRootOrdinal(structuredClone(source) as SkillEntry, 0);
    const second = tagInventoryRootOrdinal(structuredClone(source) as SkillEntry, 4);
    const result = projectSkillInventory([first, second]);

    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value.entries).toHaveLength(1);
  });

  test('preserves validated preprojected mode, placement, provenance metadata, and verification', () => {
    const source = enrichedFixture.rows.find((row) => row.name === 'c04');
    expect(source).toBeDefined();
    if (source === undefined) return;
    const result = projectSkillInventory([source]);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value.entries[0]).toEqual(
      expect.objectContaining({
        name: 'c04',
        mode: 'pinned',
        placement: 'symlink',
        source: 'github.com/acme/quality',
        revision: 'rev-c04',
        store: '/data/skillsmith/store/c04',
        verification: 'warned',
        description: 'Claude plugin skill',
      }),
    );

    const raw = Object.fromEntries(
      Object.entries(source).filter(([key]) => key !== 'visibility'),
    ) as unknown as SkillEntry;
    const rawResult = projectSkillInventory([raw]);
    expect(rawResult.ok).toBeTrue();
    if (rawResult.ok) expect(rawResult.value.entries[0]?.name).toBe('quality:c04');
  });

  test('accepts planned filter aliases with OR-within and AND-across semantics', () => {
    const filtered = projectSkillInventory(enrichedFixture.rows, {
      names: ['c02', 'x04', 'o01'],
      mode: 'dev',
      enabled: 'on',
    });
    expect(filtered.ok).toBeTrue();
    if (filtered.ok) expect(filtered.value.entries.map((entry) => entry.name)).toEqual(['c02']);

    const sourced = projectSkillInventory(enrichedFixture.rows, {
      source: 'github.com/acme/*',
      revision: 'rev-*',
      description: '*project*',
      verification: 'unverified',
    });
    expect(sourced.ok).toBeTrue();
    if (sourced.ok) {
      expect(sourced.value.entries.map((entry) => entry.name)).toEqual(['x05', 'k04', 'o04']);
    }

    const duplicates = projectSkillInventory(fixture.rows, { duplicates: true });
    expect(duplicates.ok).toBeTrue();
    if (duplicates.ok) {
      expect(
        duplicates.value.entries.every((entry) => entry.visibility.state !== 'unique'),
      ).toBeTrue();
      expect(duplicates.value.entries).toHaveLength(12);
    }
  });

  test('reads and correlates the ledger once by exact logical placement', async () => {
    const home = '/Users/alice';
    const root = `${home}/.claude/skills`;
    const path = `${root}/factor-scan`;
    const skillMd = `${path}/SKILL.md`;
    const ledgerPath = `${home}/.local/share/skillsmith/placements.json`;
    const ledgerBytes = readFileSync(join(import.meta.dir, '../fixtures/place/ledger.golden.json'));
    let ledgerReads = 0;
    const result = await readSkillInventory(
      {
        homeDir: home,
        executableSearchPath: Object.freeze([]),
        platform: 'darwin',
        xdg: Object.freeze({
          config: `${home}/.config`,
          data: `${home}/.local/share`,
          cache: `${home}/.cache`,
        }),
        fileExists: async (candidate) => candidate === root || candidate === skillMd,
        pathKind: async (candidate) =>
          candidate === ledgerPath
            ? 'file'
            : candidate === root
              ? 'dir'
              : candidate === path
                ? 'symlink'
                : candidate === skillMd
                  ? 'file'
                  : 'absent',
        realpath: async (candidate) =>
          candidate === path
            ? `${home}/.local/share/skillsmith/store/smorinlabs/smorinlabs-harness@3f2a1b9c0d4e/factor-scan`
            : candidate,
        listDir: async (candidate) => (candidate === root ? ['factor-scan'] : []),
        readText: async () => '---\ndescription: Factor scanner\n---\n',
        readBytes: async (candidate) => {
          if (candidate !== ledgerPath) return new Uint8Array();
          ledgerReads += 1;
          return ledgerBytes;
        },
        readLink: async () => '',
        isExecutable: async () => false,
        modifiedAt: async () => null,
      },
      {
        tools: ['claude-code'],
        scopes: ['user'],
        cwd: '/repo',
        configuration: resolveRuntimeConfiguration({}),
      },
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(ledgerReads).toBe(1);
    expect(result.value.entries).toHaveLength(1);
    expect(result.value.entries[0]).toEqual(
      expect.objectContaining({
        name: 'factor-scan',
        mode: 'pinned',
        placement: 'symlink',
        source: 'smorinlabs/smorinlabs-harness',
        revision: '3f2a1b9c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80',
        verification: 'passed',
      }),
    );
  });

  test('cancellation during the final placement observation wins over success', async () => {
    const home = '/h';
    const root = `${home}/.claude/skills`;
    const path = `${root}/one`;
    const skillMd = `${path}/SKILL.md`;
    const controller = new AbortController();
    const reading = readSkillInventory(
      {
        homeDir: home,
        executableSearchPath: [],
        platform: 'linux',
        xdg: { config: `${home}/.config`, data: `${home}/.local/share`, cache: `${home}/.cache` },
        fileExists: async (candidate) => candidate === root || candidate === skillMd,
        pathKind: async (candidate) => {
          if (candidate === path) controller.abort(new Error('private reason'));
          return candidate === root || candidate === path ? 'dir' : 'absent';
        },
        realpath: async (candidate) => candidate,
        listDir: async (candidate) => (candidate === root ? ['one'] : []),
        readText: async () => '---\n---\n',
        readBytes: async () => new Uint8Array(),
        readLink: async () => '',
        isExecutable: async () => false,
        modifiedAt: async () => null,
      },
      {
        tools: ['claude-code'],
        scopes: ['user'],
        cwd: '/repo',
        configuration: resolveRuntimeConfiguration({}),
        signal: controller.signal,
      },
    );

    await expect(reading).rejects.toEqual(INVENTORY_CANCELLED);
  });
});
