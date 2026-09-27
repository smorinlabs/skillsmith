#!/usr/bin/env bun

/**
 * Validate the union of per-shard test evidence.
 *
 * This restores the global guarantees that run-test-files-serial.ts enforces
 * in a single process but no individual shard can check. The aggregator never
 * trusts a shard's view of the manifest: it discovers the manifest itself from
 * its own checkout of the same commit, recomputes every shard's assignment, and
 * fails closed unless
 * - exactly `--shard-total` shard evidence directories exist, one per index,
 * - every receipt is well-formed, reports status "passed", and names the same
 *   manifest digest and size as the independent discovery,
 * - every shard ran exactly its assigned files, in order (so no file is
 *   missing, duplicated, or foreign),
 * - every per-file JUnit report is present, is re-parsed here, and agrees with
 *   the receipt, with zero failures and the allowlisted skip count,
 * - no unreferenced JUnit files are present,
 * - the global skip allowlist (EXPECTED_ALLOWED_SKIP_FILES=8,
 *   EXPECTED_ALLOWED_SKIPS=42) holds over the union.
 *
 * Layout: --receipts=<dir> contains one subdirectory per shard, each with
 * `shard-receipt.json` and `junit/*.xml` as written by run-test-files-shard.ts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PINNED_CAPABILITY_SKIPS,
  discoverTestFiles,
  manifestDigest,
  parseJUnitSummary,
  validateTerminalManifest,
} from './run-test-files-serial';
import {
  SHARD_RECEIPT_SCHEMA_VERSION,
  SHARD_RUNNER,
  type ShardFileSummary,
  type ShardReceipt,
  type ShardWeights,
  junitFileName,
  loadShardWeights,
  selectShardFiles,
} from './run-test-files-shard';

const repositoryRoot = resolve(import.meta.dir, '..');

function fail(message: string): never {
  throw new Error(message);
}

export type ShardEvidence = {
  /** Where the evidence came from, for diagnostics only. */
  label: string;
  /** Parsed JSON of shard-receipt.json (unvalidated). */
  receipt: unknown;
  /** JUnit file name -> XML content, for every file in the shard's junit/ dir. */
  junit: ReadonlyMap<string, string>;
};

export type ShardTiming = {
  shardIndex: number;
  files: number;
  durationMs: number;
  fileDurationMs: number;
  slowestFile: string;
  slowestFileMs: number;
};

export type AggregateReceipt = {
  shards: number;
  manifestSha256: string;
  manifestSize: number;
  executed: number;
  passed: number;
  skipped: number;
  tests: number;
  assertions: number;
  timing: ShardTiming[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const RECEIPT_KEYS = [
  'assertions',
  'assigned',
  'durationMs',
  'executed',
  'files',
  'manifestSha256',
  'manifestSize',
  'passed',
  'runner',
  'schemaVersion',
  'shardIndex',
  'shardTotal',
  'skipped',
  'status',
  'tests',
].join(',');
const FILE_KEYS = [
  'assertions',
  'durationMs',
  'exitCode',
  'file',
  'junitFile',
  'skipped',
  'tests',
].join(',');

function count(where: string, record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${where}: ${key} must be a non-negative integer`);
  }
  return value;
}

function text(where: string, record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '')
    fail(`${where}: ${key} must be a non-empty string`);
  return value;
}

/** Strictly validate an untrusted shard receipt; unknown or missing keys fail. */
export function parseShardReceipt(label: string, value: unknown): ShardReceipt {
  if (!isRecord(value)) fail(`${label}: shard receipt must be a JSON object`);
  const keys = Object.keys(value).toSorted().join(',');
  if (keys !== RECEIPT_KEYS) fail(`${label}: shard receipt keys ${keys}; expected ${RECEIPT_KEYS}`);
  if (value.schemaVersion !== SHARD_RECEIPT_SCHEMA_VERSION) {
    fail(`${label}: unexpected receipt schema ${String(value.schemaVersion)}`);
  }
  if (value.runner !== SHARD_RUNNER) fail(`${label}: foreign receipt runner`);
  if (value.status !== 'passed')
    fail(`${label}: shard status is ${String(value.status)}, not passed`);
  if (!Array.isArray(value.files)) fail(`${label}: files must be an array`);
  const files: ShardFileSummary[] = value.files.map((entry: unknown, position: number) => {
    const where = `${label} files[${position}]`;
    if (!isRecord(entry)) fail(`${where}: must be an object`);
    const entryKeys = Object.keys(entry).toSorted().join(',');
    if (entryKeys !== FILE_KEYS) fail(`${where}: keys ${entryKeys}; expected ${FILE_KEYS}`);
    return {
      file: text(where, entry, 'file'),
      junitFile: text(where, entry, 'junitFile'),
      exitCode: count(where, entry, 'exitCode'),
      tests: count(where, entry, 'tests'),
      skipped: count(where, entry, 'skipped'),
      assertions: count(where, entry, 'assertions'),
      durationMs: count(where, entry, 'durationMs'),
    };
  });
  return {
    schemaVersion: SHARD_RECEIPT_SCHEMA_VERSION,
    runner: SHARD_RUNNER,
    status: 'passed',
    shardIndex: count(label, value, 'shardIndex'),
    shardTotal: count(label, value, 'shardTotal'),
    manifestSha256: text(label, value, 'manifestSha256'),
    manifestSize: count(label, value, 'manifestSize'),
    assigned: count(label, value, 'assigned'),
    files,
    executed: count(label, value, 'executed'),
    passed: count(label, value, 'passed'),
    skipped: count(label, value, 'skipped'),
    tests: count(label, value, 'tests'),
    assertions: count(label, value, 'assertions'),
    durationMs: count(label, value, 'durationMs'),
  };
}

export function aggregateShardEvidence(
  manifest: readonly string[],
  shardTotal: number,
  evidence: readonly ShardEvidence[],
  weights?: ShardWeights,
): AggregateReceipt {
  if (!Number.isInteger(shardTotal) || shardTotal < 1) fail(`invalid shard total: ${shardTotal}`);
  if (manifest.length === 0) fail('independent manifest is empty');
  if (new Set(manifest).size !== manifest.length) fail('independent manifest has duplicates');
  const expectedTotalSkips = validateTerminalManifest(manifest, PINNED_CAPABILITY_SKIPS);
  const digest = manifestDigest(manifest);
  if (evidence.length !== shardTotal) {
    fail(`expected ${shardTotal} shard evidence sets; found ${evidence.length}`);
  }

  const receipts = evidence.map((item) => ({
    item,
    receipt: parseShardReceipt(item.label, item.receipt),
  }));
  const indices = new Set<number>();
  for (const { item, receipt } of receipts) {
    if (receipt.shardTotal !== shardTotal) {
      fail(`${item.label}: reports shard total ${receipt.shardTotal}; expected ${shardTotal}`);
    }
    if (receipt.shardIndex < 1 || receipt.shardIndex > shardTotal) {
      fail(`${item.label}: shard index ${receipt.shardIndex} out of range`);
    }
    if (indices.has(receipt.shardIndex)) {
      fail(`${item.label}: duplicate shard index ${receipt.shardIndex}`);
    }
    indices.add(receipt.shardIndex);
  }

  const union = new Map<string, number>();
  const timing: ShardTiming[] = [];
  let skipped = 0;
  let tests = 0;
  let assertions = 0;
  for (const { item, receipt } of receipts.toSorted(
    (left, right) => left.receipt.shardIndex - right.receipt.shardIndex,
  )) {
    const label = `${item.label} (shard ${receipt.shardIndex}/${shardTotal})`;
    if (receipt.manifestSha256 !== digest || receipt.manifestSize !== manifest.length) {
      fail(
        `${label}: manifest ${receipt.manifestSha256}/${receipt.manifestSize} disagrees with ` +
          `independent discovery ${digest}/${manifest.length}`,
      );
    }
    const expected = selectShardFiles(manifest, receipt.shardIndex, shardTotal, weights);
    const expectedSet = new Set(expected);
    const actual = receipt.files.map((entry) => entry.file);
    const seenInShard = new Set<string>();
    for (const file of actual) {
      if (!expectedSet.has(file)) fail(`${label}: foreign test file ${file}`);
      if (seenInShard.has(file)) fail(`${label}: duplicate test file ${file}`);
      seenInShard.add(file);
    }
    const missing = expected.filter((file) => !seenInShard.has(file));
    if (missing.length > 0) {
      fail(`${label}: missing ${missing.length} assigned test files, first ${missing[0]}`);
    }
    if (actual.join('\n') !== expected.join('\n')) fail(`${label}: test files ran out of order`);
    if (
      receipt.assigned !== expected.length ||
      receipt.executed !== expected.length ||
      receipt.passed !== expected.length
    ) {
      fail(
        `${label}: assigned/executed/passed ${receipt.assigned}/${receipt.executed}/${receipt.passed}; expected ${expected.length}`,
      );
    }

    const referenced = new Set<string>();
    let shardSkipped = 0;
    let shardTests = 0;
    let shardAssertions = 0;
    let fileDurationMs = 0;
    let slowestFile = '';
    let slowestFileMs = -1;
    for (const [position, entry] of receipt.files.entries()) {
      if (entry.junitFile !== junitFileName(position)) {
        fail(
          `${label}: ${entry.file} names JUnit file ${entry.junitFile}; expected ${junitFileName(position)}`,
        );
      }
      referenced.add(entry.junitFile);
      if (entry.exitCode !== 0) fail(`${label}: ${entry.file} exited ${entry.exitCode}`);
      const xml = item.junit.get(entry.junitFile);
      if (xml === undefined)
        fail(`${label}: missing JUnit evidence ${entry.junitFile} for ${entry.file}`);
      const summary = parseJUnitSummary(xml, entry.file);
      if (summary.failures !== 0)
        fail(`${label}: ${entry.file} reported ${summary.failures} failures`);
      if (
        summary.tests !== entry.tests ||
        summary.skipped !== entry.skipped ||
        summary.assertions !== entry.assertions
      ) {
        fail(`${label}: ${entry.file} JUnit evidence disagrees with the receipt`);
      }
      const expectedSkips = PINNED_CAPABILITY_SKIPS.get(entry.file) ?? 0;
      if (summary.skipped !== expectedSkips) {
        fail(
          `${label}: ${entry.file} reported ${summary.skipped} skipped tests; expected ${expectedSkips}`,
        );
      }
      if (union.has(entry.file)) fail(`duplicate test file across shards: ${entry.file}`);
      union.set(entry.file, receipt.shardIndex);
      shardSkipped += summary.skipped;
      shardTests += summary.tests;
      shardAssertions += summary.assertions;
      fileDurationMs += entry.durationMs;
      if (entry.durationMs > slowestFileMs) {
        slowestFileMs = entry.durationMs;
        slowestFile = entry.file;
      }
    }
    const unreferenced = [...item.junit.keys()].filter((name) => !referenced.has(name)).sort();
    if (unreferenced.length > 0) fail(`${label}: unreferenced JUnit evidence ${unreferenced[0]}`);
    if (
      shardSkipped !== receipt.skipped ||
      shardTests !== receipt.tests ||
      shardAssertions !== receipt.assertions
    ) {
      fail(`${label}: receipt totals disagree with its per-file entries`);
    }
    skipped += shardSkipped;
    tests += shardTests;
    assertions += shardAssertions;
    timing.push({
      shardIndex: receipt.shardIndex,
      files: expected.length,
      durationMs: receipt.durationMs,
      fileDurationMs,
      slowestFile,
      slowestFileMs,
    });
  }

  if (union.size !== manifest.length || manifest.some((file) => !union.has(file))) {
    fail(`shard union covers ${union.size} files; manifest has ${manifest.length}`);
  }
  if (skipped !== expectedTotalSkips) {
    fail(`aggregate receipt totals ${skipped} skipped tests; expected ${expectedTotalSkips}`);
  }
  return {
    shards: shardTotal,
    manifestSha256: digest,
    manifestSize: manifest.length,
    executed: union.size,
    passed: union.size,
    skipped,
    tests,
    assertions,
    timing,
  };
}

function usage(): string {
  return 'usage: aggregate-shard-receipts.ts --receipts=<dir> --shard-total=<N>';
}

export function readShardEvidence(root: string): ShardEvidence[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const foreign = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  if (foreign.length > 0) fail(`unexpected non-directory evidence entry ${foreign.sort()[0]}`);
  return entries
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const receiptPath = join(root, name, 'shard-receipt.json');
      const junitRoot = join(root, name, 'junit');
      if (!existsSync(receiptPath)) fail(`missing shard receipt: ${receiptPath}`);
      if (!existsSync(junitRoot) || !statSync(junitRoot).isDirectory()) {
        fail(`missing JUnit directory: ${junitRoot}`);
      }
      let receipt: unknown;
      try {
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      } catch (error) {
        fail(
          `malformed shard receipt ${receiptPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const junit = new Map<string, string>();
      for (const file of readdirSync(junitRoot, { withFileTypes: true })) {
        if (!file.isFile()) fail(`unexpected JUnit entry ${join(junitRoot, file.name)}`);
        junit.set(file.name, readFileSync(join(junitRoot, file.name), 'utf8'));
      }
      return { label: name, receipt, junit };
    });
}

export async function main(): Promise<void> {
  let receiptsDir: string | null = null;
  let shardTotal: number | null = null;
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--receipts=') && receiptsDir === null) {
      receiptsDir = argument.slice('--receipts='.length);
    } else if (argument.startsWith('--shard-total=') && shardTotal === null) {
      const raw = argument.slice('--shard-total='.length);
      if (!/^[1-9]\d*$/.test(raw)) fail(`${usage()}\n--shard-total must be a positive integer`);
      shardTotal = Number.parseInt(raw, 10);
    } else {
      fail(`${usage()}\nunknown or repeated argument: ${argument}`);
    }
  }
  if (receiptsDir === null || receiptsDir === '' || shardTotal === null) fail(usage());
  const manifest = discoverTestFiles(repositoryRoot);
  const aggregate = aggregateShardEvidence(
    manifest,
    shardTotal,
    readShardEvidence(resolve(receiptsDir)),
    loadShardWeights(),
  );
  const durations = aggregate.timing.map((shard) => shard.durationMs);
  const slowest = Math.max(...durations);
  const fastest = Math.min(...durations);
  for (const shard of aggregate.timing) {
    console.log(
      `shard ${shard.shardIndex}/${aggregate.shards}: ${shard.files} files; ${(shard.durationMs / 1000).toFixed(1)}s; ` +
        `slowest ${shard.slowestFile} ${(shard.slowestFileMs / 1000).toFixed(1)}s`,
    );
  }
  console.log(
    `shard skew: slowest ${(slowest / 1000).toFixed(1)}s; fastest ${(fastest / 1000).toFixed(1)}s; ` +
      `ratio ${(slowest / Math.max(fastest, 1)).toFixed(2)}`,
  );
  console.log(`AGGREGATE_TEST_FILE_RECEIPT ${JSON.stringify(aggregate)}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
