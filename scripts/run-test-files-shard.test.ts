import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ShardEvidence,
  aggregateShardEvidence,
  parseShardReceipt,
  readShardEvidence,
} from './aggregate-shard-receipts';
import { ALLOWED_LIVE_E2E_SKIPS, manifestDigest } from './run-test-files-serial';
import {
  SHARD_RECEIPT_SCHEMA_VERSION,
  SHARD_RUNNER,
  type ShardReceipt,
  junitFileName,
  loadShardWeights,
  parseShardArguments,
  selectShardFiles,
} from './run-test-files-shard';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function junit(file: string, tests = 1, skipped = 0, assertions = 7, failures = 0): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="${tests}" assertions="${assertions}" failures="${failures}" skipped="${skipped}" time="0.1">
  <testsuite name="${file}" file="${file}" tests="${tests}" assertions="${assertions}" failures="${failures}" skipped="${skipped}" time="0.1"></testsuite>
</testsuites>\n`;
}

const MANIFEST = [
  ...[...ALLOWED_LIVE_E2E_SKIPS.keys()],
  'packages/core/tests/alpha.test.ts',
  'packages/core/tests/beta.test.ts',
  'scripts/gamma.test.ts',
].sort();

function shardEvidence(
  shardIndex: number,
  shardTotal: number,
  manifest: readonly string[] = MANIFEST,
): { label: string; receipt: ShardReceipt; junit: Map<string, string> } {
  const files = selectShardFiles(manifest, shardIndex, shardTotal).map((file, position) => ({
    file,
    junitFile: junitFileName(position),
    exitCode: 0,
    tests: (ALLOWED_LIVE_E2E_SKIPS.get(file) ?? 0) + 1,
    skipped: ALLOWED_LIVE_E2E_SKIPS.get(file) ?? 0,
    assertions: 7,
    durationMs: 100 * (position + 1),
  }));
  const receipt: ShardReceipt = {
    schemaVersion: SHARD_RECEIPT_SCHEMA_VERSION,
    runner: SHARD_RUNNER,
    status: 'passed',
    shardIndex,
    shardTotal,
    manifestSha256: manifestDigest(manifest),
    manifestSize: manifest.length,
    assigned: files.length,
    files,
    executed: files.length,
    passed: files.length,
    skipped: files.reduce((sum, entry) => sum + entry.skipped, 0),
    tests: files.reduce((sum, entry) => sum + entry.tests, 0),
    assertions: files.length * 7,
    durationMs: files.reduce((sum, entry) => sum + entry.durationMs, 0) + 50,
  };
  const xml = new Map(
    files.map((entry) => [entry.junitFile, junit(entry.file, entry.tests, entry.skipped)]),
  );
  return { label: `test-shard-${shardIndex}`, receipt, junit: xml };
}

function fourShards(): ReturnType<typeof shardEvidence>[] {
  return [1, 2, 3, 4].map((index) => shardEvidence(index, 4));
}

const aggregate = (evidence: readonly ShardEvidence[], total = 4) =>
  aggregateShardEvidence(MANIFEST, total, evidence);

describe('selectShardFiles', () => {
  test('deals the manifest round-robin across four shards', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    expect(selectShardFiles(files, 1, 4)).toEqual(['a.test.ts', 'e.test.ts']);
    expect(selectShardFiles(files, 2, 4)).toEqual(['b.test.ts']);
    expect(selectShardFiles(files, 3, 4)).toEqual(['c.test.ts']);
    expect(selectShardFiles(files, 4, 4)).toEqual(['d.test.ts']);
  });

  test('partitions are disjoint and complete', () => {
    const files = Array.from({ length: 412 }, (_, index) => `file-${index}.test.ts`);
    const union: string[] = [];
    for (let shard = 1; shard <= 4; shard += 1) union.push(...selectShardFiles(files, shard, 4));
    expect(union.toSorted()).toEqual(files.toSorted());
  });

  test('balances weighted files longest-first and keeps manifest order within a shard', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    const weights = {
      defaultSeconds: 1,
      seconds: new Map([
        ['c.test.ts', 10],
        ['a.test.ts', 6],
        ['e.test.ts', 5],
      ]),
    };
    expect(selectShardFiles(files, 1, 2, weights)).toEqual(['b.test.ts', 'c.test.ts', 'd.test.ts']);
    expect(selectShardFiles(files, 2, 2, weights)).toEqual(['a.test.ts', 'e.test.ts']);
  });

  test('the committed weights partition the tracked manifest completely and disjointly', () => {
    const weights = loadShardWeights();
    const files = [...weights.seconds.keys(), 'new/unweighted.test.ts'].sort();
    const shards = [1, 2, 3, 4].map((index) => selectShardFiles(files, index, 4, weights));
    expect(shards.flat().toSorted()).toEqual(files);
    for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
  });

  test('rejects out-of-range shard coordinates', () => {
    expect(() => selectShardFiles(['a.test.ts'], 0, 4)).toThrow();
    expect(() => selectShardFiles(['a.test.ts'], 5, 4)).toThrow();
    expect(() => selectShardFiles(['a.test.ts'], 1, 0)).toThrow();
  });
});

describe('parseShardArguments', () => {
  test('parses index, total, out-dir, and list-only', () => {
    expect(parseShardArguments(['--shard-index=2', '--shard-total=4'])).toEqual({
      shardIndex: 2,
      shardTotal: 4,
      outDir: null,
      listOnly: false,
    });
    expect(
      parseShardArguments([
        '--shard-index=1',
        '--shard-total=4',
        '--out-dir=/tmp/x',
        '--list-only',
      ]),
    ).toEqual({ shardIndex: 1, shardTotal: 4, outDir: '/tmp/x', listOnly: true });
  });

  test('rejects missing, malformed, repeated, out-of-range, and unknown arguments', () => {
    for (const argv of [
      ['--shard-index=1'],
      ['--shard-index=1', '--shard-total=4', '--bogus'],
      ['--shard-index=2abc', '--shard-total=4'],
      ['--shard-index=0', '--shard-total=4'],
      ['--shard-index=5', '--shard-total=4'],
      ['--shard-index=1', '--shard-index=2', '--shard-total=4'],
      ['--shard-index=1', '--shard-total=4', '--out-dir='],
    ]) {
      expect(() => parseShardArguments(argv)).toThrow();
    }
  });
});

describe('aggregateShardEvidence', () => {
  test('accepts a complete disjoint union and restores the global skip totals', () => {
    const result = aggregate(fourShards());
    expect(result.shards).toBe(4);
    expect(result.manifestSize).toBe(MANIFEST.length);
    expect(result.executed).toBe(MANIFEST.length);
    expect(result.passed).toBe(MANIFEST.length);
    expect(result.skipped).toBe(42);
    expect(result.timing.map((shard) => shard.shardIndex)).toEqual([1, 2, 3, 4]);
  });

  test('accepts shard evidence in any directory order', () => {
    expect(aggregate(fourShards().reverse()).executed).toBe(MANIFEST.length);
  });

  const rejects: [string, (shards: ReturnType<typeof fourShards>) => unknown[], RegExp][] = [
    ['a missing shard', (shards) => shards.slice(0, 3), /expected 4 shard evidence sets/],
    ['an extra shard', (shards) => [...shards, shards[0]], /expected 4 shard evidence sets/],
    [
      'a duplicate shard index',
      (shards) => [shards[0], shards[0], shards[2], shards[3]],
      /duplicate shard index/,
    ],
    [
      'a failed shard receipt',
      (shards) => {
        shards[1].receipt.status = 'failed';
        return shards;
      },
      /status is failed/,
    ],
    [
      'a foreign test file',
      (shards) => {
        shards[0].receipt.files[0].file = 'foreign/injected.test.ts';
        return shards;
      },
      /foreign test file/,
    ],
    [
      'a file duplicated within a shard',
      (shards) => {
        shards[0].receipt.files[1].file = shards[0].receipt.files[0].file;
        return shards;
      },
      /duplicate test file/,
    ],
    [
      'a file duplicated across shards',
      (shards) => {
        shards[1].receipt.files.push({
          ...shards[0].receipt.files[0],
          junitFile: 'junit-0099.xml',
        });
        return shards;
      },
      /foreign test file/,
    ],
    [
      'an incomplete shard (early stop)',
      (shards) => {
        shards[2].receipt.files.pop();
        return shards;
      },
      /missing 1 assigned test files/,
    ],
    [
      'files run out of order',
      (shards) => {
        shards[0].receipt.files.reverse();
        return shards;
      },
      /out of order/,
    ],
    [
      'a receipt from a different manifest',
      (shards) => {
        shards[3].receipt.manifestSha256 = 'f'.repeat(64);
        return shards;
      },
      /disagrees with independent discovery/,
    ],
    [
      'a receipt from a different shard total',
      (shards) => {
        shards[3].receipt.shardTotal = 5;
        return shards;
      },
      /reports shard total 5/,
    ],
    [
      'executed/passed counters that disagree with the assignment',
      (shards) => {
        shards[0].receipt.passed -= 1;
        return shards;
      },
      /assigned\/executed\/passed/,
    ],
    [
      'receipt numbers that disagree with JUnit evidence',
      (shards) => {
        shards[0].receipt.files[0].assertions = 99;
        return shards;
      },
      /disagrees with the receipt/,
    ],
    [
      'receipt totals that disagree with per-file entries',
      (shards) => {
        shards[0].receipt.tests += 1;
        return shards;
      },
      /receipt totals disagree/,
    ],
    [
      'missing JUnit evidence',
      (shards) => {
        shards[0].junit.delete('junit-0001.xml');
        return shards;
      },
      /missing JUnit evidence/,
    ],
    [
      'unreferenced JUnit evidence',
      (shards) => {
        shards[0].junit.set('junit-0999.xml', junit('x.test.ts'));
        return shards;
      },
      /unreferenced JUnit evidence/,
    ],
    [
      'JUnit evidence for another file',
      (shards) => {
        shards[0].junit.set('junit-0001.xml', junit('other.test.ts'));
        return shards;
      },
      /JUnit evidence reported other\.test\.ts/,
    ],
    [
      'JUnit failures',
      (shards) => {
        const entry = shards[0].receipt.files[0];
        shards[0].junit.set(entry.junitFile, junit(entry.file, entry.tests, entry.skipped, 7, 1));
        return shards;
      },
      /reported 1 failures/,
    ],
    [
      'an unexpected skip count',
      (shards) => {
        const shard = shards.find((item) =>
          item.receipt.files.some((entry) => !ALLOWED_LIVE_E2E_SKIPS.has(entry.file)),
        );
        if (!shard) throw new Error('fixture needs a non-allowlisted file');
        const entry = shard.receipt.files.find((item) => !ALLOWED_LIVE_E2E_SKIPS.has(item.file));
        if (!entry) throw new Error('fixture needs a non-allowlisted file');
        entry.skipped = 1;
        shard.receipt.skipped += 1;
        shard.junit.set(entry.junitFile, junit(entry.file, entry.tests, 1));
        return shards;
      },
      /skipped tests; expected 0/,
    ],
    [
      'a nonzero exit code',
      (shards) => {
        shards[0].receipt.files[0].exitCode = 1;
        return shards;
      },
      /exited 1/,
    ],
    [
      'a renamed JUnit file',
      (shards) => {
        shards[0].receipt.files[0].junitFile = '../../escape.xml';
        return shards;
      },
      /names JUnit file/,
    ],
  ];
  for (const [name, mutate, message] of rejects) {
    test(`fails closed on ${name}`, () => {
      expect(() => aggregate(mutate(fourShards()) as ShardEvidence[])).toThrow(message);
    });
  }

  test('fails closed when the independent manifest lacks an allowlisted live-E2E file', () => {
    const manifest = MANIFEST.filter(
      (file) => !ALLOWED_LIVE_E2E_SKIPS.has(file) || file.includes('flip'),
    );
    expect(() => aggregateShardEvidence(manifest, 4, [])).toThrow(/missing live-E2E file/);
  });
});

describe('parseShardReceipt rejects malformed receipts', () => {
  const valid = () => structuredClone(shardEvidence(1, 4).receipt) as Record<string, unknown>;
  const cases: [string, unknown][] = [
    ['null', null],
    ['an array', []],
    ['a missing key', (({ assigned: _assigned, ...rest }) => rest)(valid())],
    ['an extra key', { ...valid(), extra: true }],
    ['an old schema', { ...valid(), schemaVersion: 1 }],
    ['a foreign runner', { ...valid(), runner: 'other' }],
    ['a string count', { ...valid(), tests: '5' }],
    ['a negative count', { ...valid(), skipped: -1 }],
    ['a fractional count', { ...valid(), durationMs: 1.5 }],
    ['files that are not an array', { ...valid(), files: {} }],
    ['a file entry with a missing key', { ...valid(), files: [{ file: 'a.test.ts' }] }],
  ];
  for (const [name, value] of cases) {
    test(name, () => {
      expect(() => parseShardReceipt('fixture', value)).toThrow();
    });
  }
});

describe('readShardEvidence', () => {
  function writeEvidence(root: string, shards: ReturnType<typeof fourShards>): void {
    for (const shard of shards) {
      const directory = join(root, shard.label);
      mkdirSync(join(directory, 'junit'), { recursive: true });
      writeFileSync(join(directory, 'shard-receipt.json'), JSON.stringify(shard.receipt));
      for (const [name, xml] of shard.junit) writeFileSync(join(directory, 'junit', name), xml);
    }
  }
  function root(): string {
    const directory = mkdtempSync(join(tmpdir(), 'skillsmith-shard-evidence-'));
    temporaryRoots.push(directory);
    return directory;
  }

  test('round-trips uploaded evidence into a passing aggregate', () => {
    const directory = root();
    writeEvidence(directory, fourShards());
    expect(aggregate(readShardEvidence(directory)).executed).toBe(MANIFEST.length);
  });

  test('fails closed on malformed JSON, a missing receipt, and stray files', () => {
    const malformed = root();
    writeEvidence(malformed, fourShards());
    writeFileSync(join(malformed, 'test-shard-2', 'shard-receipt.json'), '{"schemaVersion": 2,');
    expect(() => readShardEvidence(malformed)).toThrow(/malformed shard receipt/);

    const missing = root();
    writeEvidence(missing, fourShards());
    rmSync(join(missing, 'test-shard-3', 'shard-receipt.json'));
    expect(() => readShardEvidence(missing)).toThrow(/missing shard receipt/);

    const stray = root();
    writeEvidence(stray, fourShards());
    writeFileSync(join(stray, 'stray.json'), '{}');
    expect(() => readShardEvidence(stray)).toThrow(/non-directory evidence entry/);
  });
});

describe('justfile gate split', () => {
  test('check-gates is exactly the canonical check recipe minus the test terminal', () => {
    const justfile = readFileSync(join(import.meta.dir, '..', 'justfile'), 'utf8');
    const recipe = (name: string): string[] => {
      const body = justfile.match(new RegExp(`^${name}:\\n((?: {4}[^\\n]*\\n)+)`, 'm'))?.[1];
      if (body === undefined) throw new Error(`justfile recipe ${name} is missing`);
      return body.trimEnd().split('\n');
    };
    const check = recipe('check');
    expect(check.at(-1)).toBe('    just test-terminal');
    expect(check.filter((line) => line.includes('test-terminal'))).toHaveLength(1);
    expect(recipe('check-gates')).toEqual(check.slice(0, -1));
  });
});
