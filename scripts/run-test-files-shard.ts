#!/usr/bin/env bun

/**
 * Sharded variant of the serial test-file terminal runner.
 *
 * Contract (same as run-test-files-serial.ts):
 * - Every assigned test file runs in its own fresh `bun test` process with the
 *   same flags (`--timeout=60000 --max-concurrency=1 --no-orphans --retry=0`,
 *   JUnit reporter). No in-process reuse, no intra-shard parallelism.
 * - Per-file JUnit evidence is parsed with the same parser and the per-file
 *   pinned-capability skip expectation (PINNED_CAPABILITY_SKIPS) is enforced per file.
 * - The first failing file stops the shard, like the serial runner.
 * - The global guarantees (full-manifest coverage exactly once,
 *   EXPECTED_ALLOWED_SKIP_FILES, EXPECTED_ALLOWED_SKIPS totals) are NOT
 *   enforceable inside one shard, so each shard writes a machine-readable
 *   receipt plus its JUnit XML files and scripts/aggregate-shard-receipts.ts
 *   validates the union of all shards against an independently discovered
 *   manifest.
 *
 * Shard assignment: greedy longest-first bin packing over the per-file weights
 * in scripts/test-shard-weights.json (seconds measured by the serial CI
 * terminal; unknown files get `defaultSeconds`). Ties break by path and then by
 * lowest shard index, so assignment is deterministic, needs no shared state
 * between jobs, and degenerates to round-robin when all weights are equal.
 * Each shard runs its files in manifest (sorted-path) order.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PINNED_CAPABILITY_SKIPS,
  buildBunTestCommand,
  captureRepositoryIdentity,
  discoverTestFiles,
  finalizeSuccessfulRun,
  manifestDigest,
  parseJUnitSummary,
  requireCleanRepository,
  requirePinnedBunVersion,
  validateTerminalManifest,
} from './run-test-files-serial';

const repositoryRoot = resolve(import.meta.dir, '..');

export const SHARD_RECEIPT_SCHEMA_VERSION = 3;
export const SHARD_RUNNER = 'skillsmith-test-shard';

export type ShardFileSummary = {
  file: string;
  junitFile: string;
  exitCode: number;
  tests: number;
  skipped: number;
  assertions: number;
  durationMs: number;
};

export type ShardReceipt = {
  schemaVersion: number;
  runner: string;
  status: 'passed' | 'failed';
  shardIndex: number;
  shardTotal: number;
  manifestSha256: string;
  manifestSize: number;
  assigned: number;
  files: ShardFileSummary[];
  executed: number;
  passed: number;
  skipped: number;
  tests: number;
  assertions: number;
  durationMs: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function usage(): string {
  return 'usage: run-test-files-shard.ts --shard-index=<1-based> --shard-total=<N> [--out-dir=<path>] [--list-only]';
}

export function junitFileName(position: number): string {
  return `junit-${String(position + 1).padStart(4, '0')}.xml`;
}

export type ShardWeights = Readonly<{
  defaultSeconds: number;
  seconds: ReadonlyMap<string, number>;
}>;

export const EQUAL_WEIGHTS: ShardWeights = { defaultSeconds: 1, seconds: new Map() };

export function loadShardWeights(
  path = join(import.meta.dir, 'test-shard-weights.json'),
): ShardWeights {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    defaultSeconds?: unknown;
    seconds?: Record<string, unknown>;
  };
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;
  if (!valid(raw.defaultSeconds)) fail(`${path}: defaultSeconds must be a positive integer`);
  if (raw.seconds === null || typeof raw.seconds !== 'object')
    fail(`${path}: seconds must be an object`);
  const seconds = new Map<string, number>();
  for (const [file, value] of Object.entries(raw.seconds)) {
    if (!valid(value)) fail(`${path}: weight for ${file} must be a positive integer`);
    seconds.set(file, value);
  }
  return { defaultSeconds: raw.defaultSeconds, seconds };
}

/** Partition the manifest into `shardTotal` weight-balanced shards (1-based index). */
export function selectShardFiles(
  files: readonly string[],
  shardIndex: number,
  shardTotal: number,
  weights: ShardWeights = EQUAL_WEIGHTS,
): string[] {
  if (!Number.isInteger(shardTotal) || shardTotal < 1) {
    fail(`invalid shard total: ${shardTotal}`);
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 1 || shardIndex > shardTotal) {
    fail(`invalid shard index ${shardIndex} for ${shardTotal} shards`);
  }
  const weight = (file: string): number => weights.seconds.get(file) ?? weights.defaultSeconds;
  const loads = Array.from({ length: shardTotal }, () => 0);
  const owner = new Map<string, number>();
  const byWeight = files.toSorted(
    (left, right) => weight(right) - weight(left) || (left < right ? -1 : left > right ? 1 : 0),
  );
  for (const file of byWeight) {
    const target = loads.indexOf(Math.min(...loads));
    loads[target] = (loads[target] ?? 0) + weight(file);
    owner.set(file, target + 1);
  }
  return files.filter((file) => owner.get(file) === shardIndex);
}

function positiveInteger(name: string, raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) fail(`${usage()}\n${name} must be a positive integer: ${raw}`);
  return Number.parseInt(raw, 10);
}

export function parseShardArguments(argv: string[]): {
  shardIndex: number;
  shardTotal: number;
  outDir: string | null;
  listOnly: boolean;
} {
  let shardIndex: number | null = null;
  let shardTotal: number | null = null;
  let outDir: string | null = null;
  let listOnly = false;
  for (const argument of argv) {
    if (argument.startsWith('--shard-index=') && shardIndex === null) {
      shardIndex = positiveInteger('--shard-index', argument.slice('--shard-index='.length));
    } else if (argument.startsWith('--shard-total=') && shardTotal === null) {
      shardTotal = positiveInteger('--shard-total', argument.slice('--shard-total='.length));
    } else if (argument.startsWith('--out-dir=') && outDir === null) {
      outDir = argument.slice('--out-dir='.length);
      if (outDir === '') fail(`${usage()}\n--out-dir must not be empty`);
    } else if (argument === '--list-only' && !listOnly) {
      listOnly = true;
    } else {
      fail(`${usage()}\nunknown or repeated argument: ${argument}`);
    }
  }
  if (shardIndex === null || shardTotal === null) fail(usage());
  if (shardIndex > shardTotal) fail(`invalid shard index ${shardIndex} for ${shardTotal} shards`);
  return { shardIndex, shardTotal, outDir, listOnly };
}

export async function main(): Promise<void> {
  if (process.env.SKILLSMITH_E2E !== undefined) {
    fail('sharded test-file runner refuses SKILLSMITH_E2E');
  }
  const { shardIndex, shardTotal, outDir, listOnly } = parseShardArguments(process.argv.slice(2));

  requirePinnedBunVersion(Bun.version);
  requireCleanRepository(repositoryRoot);
  const initial = captureRepositoryIdentity(repositoryRoot);
  const testFiles = discoverTestFiles(repositoryRoot);
  validateTerminalManifest(testFiles, PINNED_CAPABILITY_SKIPS);
  const digest = manifestDigest(testFiles);
  const assigned = selectShardFiles(testFiles, shardIndex, shardTotal, loadShardWeights());
  if (assigned.length === 0) fail(`shard ${shardIndex}/${shardTotal} was assigned zero files`);

  console.log(
    `sharded test-file manifest: shard ${shardIndex}/${shardTotal}; ` +
      `${assigned.length}/${testFiles.length} files; sha256=${digest}; bun=${Bun.version}`,
  );
  if (listOnly) {
    for (const file of assigned) console.log(file);
    return;
  }

  const temporaryBase = resolve(process.env.TMPDIR ?? tmpdir());
  const outputRoot =
    outDir === null ? mkdtempSync(join(temporaryBase, 'skillsmith-test-shard-')) : resolve(outDir);
  const junitRoot = join(outputRoot, 'junit');
  mkdirSync(junitRoot, { recursive: true });
  const runRoot = mkdtempSync(join(temporaryBase, 'skillsmith-shard-run-'));
  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );

  const receipt: ShardReceipt = {
    schemaVersion: SHARD_RECEIPT_SCHEMA_VERSION,
    runner: SHARD_RUNNER,
    status: 'failed',
    shardIndex,
    shardTotal,
    manifestSha256: digest,
    manifestSize: testFiles.length,
    assigned: assigned.length,
    files: [],
    executed: 0,
    passed: 0,
    skipped: 0,
    tests: 0,
    assertions: 0,
    durationMs: 0,
  };
  const shardStarted = performance.now();

  const errors: unknown[] = [];
  try {
    for (const [position, file] of assigned.entries()) {
      const junitFile = junitFileName(position);
      const reportPath = join(junitRoot, junitFile);
      const command = buildBunTestCommand(file, reportPath);
      console.log(`[${position + 1}/${assigned.length}] ${file}`);
      const started = performance.now();
      const child = Bun.spawn(command, {
        cwd: repositoryRoot,
        env: { ...gitEnvironment, TMPDIR: runRoot },
        stderr: 'inherit',
        stdout: 'inherit',
      });
      const exitCode = await child.exited;
      const durationMs = Math.round(performance.now() - started);
      receipt.executed += 1;
      if (exitCode !== 0) {
        fail(
          `${file} exited ${exitCode} after ${position + 1}/${assigned.length} files (shard ${shardIndex}/${shardTotal})`,
        );
      }
      const summary = parseJUnitSummary(
        existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '',
        file,
      );
      if (summary.failures !== 0) {
        fail(`${file} reported ${summary.failures} JUnit failures after exit 0`);
      }
      const expectedSkips = PINNED_CAPABILITY_SKIPS.get(file) ?? 0;
      if (summary.skipped !== expectedSkips) {
        fail(`${file} reported ${summary.skipped} skipped tests; expected ${expectedSkips}`);
      }
      receipt.files.push({
        file,
        junitFile,
        exitCode,
        tests: summary.tests,
        skipped: summary.skipped,
        assertions: summary.assertions,
        durationMs,
      });
      receipt.passed += 1;
      receipt.skipped += summary.skipped;
      receipt.tests += summary.tests;
      receipt.assertions += summary.assertions;
    }
    if (receipt.passed !== assigned.length) {
      fail(`shard ${shardIndex}/${shardTotal} passed ${receipt.passed}/${assigned.length} files`);
    }
  } catch (error) {
    errors.push(error);
  }
  receipt.durationMs = Math.round(performance.now() - shardStarted);

  try {
    finalizeSuccessfulRun(repositoryRoot, runRoot, initial);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 0) receipt.status = 'passed';
  try {
    // The receipt is written on failure too (status "failed") so the uploaded
    // evidence explains the stop; the aggregator accepts only "passed".
    writeFileSync(join(outputRoot, 'shard-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    fail(
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join('\n'),
    );
  }
  console.log(
    `SHARD_TEST_FILE_RECEIPT ${JSON.stringify({ ...receipt, files: receipt.files.length, bun: Bun.version })}`,
  );
  console.log(`shard evidence directory: ${outputRoot}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
