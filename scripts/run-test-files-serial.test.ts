import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWED_LIVE_E2E_SKIPS,
  buildBunTestCommand,
  discoverTestFiles,
  manifestDigest,
  parseJUnitSummary,
  runFilesSerially,
} from './run-test-files-serial';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function repositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'skillsmith-serial-runner-test-'));
  temporaryDirectories.push(root);
  const tracked = [
    'alpha.test.ts',
    'beta_spec.js',
    'nested/gamma.spec.tsx',
    'nested/delta_test.jsx',
    '.hidden/ignored.test.ts',
    'node_modules/ignored.test.ts',
    'not-a-test.ts',
    'unsupported.test.mts',
  ];

  for (const path of [...tracked, 'untracked.test.ts']) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, 'export {};\n');
  }

  expect(Bun.spawnSync(['git', 'init', '--quiet'], { cwd: root }).exitCode).toBe(0);
  expect(Bun.spawnSync(['git', 'add', '--force', '--', ...tracked], { cwd: root }).exitCode).toBe(
    0,
  );
  return root;
}

function junit(file: string, tests = 1, skipped = 0): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="${tests}" assertions="7" failures="0" skipped="${skipped}" time="0.1">
  <testsuite name="${file}" file="${file}" tests="${tests}" assertions="7" failures="0" skipped="${skipped}" time="0.1"></testsuite>
</testsuites>\n`;
}

describe('serial test-file terminal runner', () => {
  test('discovers the complete tracked Bun filename surface in deterministic order', () => {
    const root = repositoryFixture();

    const files = discoverTestFiles(root);

    expect(files).toEqual([
      'alpha.test.ts',
      'beta_spec.js',
      'nested/delta_test.jsx',
      'nested/gamma.spec.tsx',
    ]);
    expect(manifestDigest(files)).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestDigest(files)).toBe(manifestDigest([...files]));
  });

  test('constructs one exact fresh-process Bun command without retry or isolation flags', () => {
    expect(buildBunTestCommand('nested/example.test.ts', '/tmp/report.xml', '/opt/bun')).toEqual([
      '/opt/bun',
      'test',
      './nested/example.test.ts',
      '--timeout=60000',
      '--max-concurrency=1',
      '--no-orphans',
      '--retry=0',
      '--reporter=junit',
      '--reporter-outfile=/tmp/report.xml',
    ]);
  });

  test('parses a one-file JUnit summary and rejects malformed or empty evidence', () => {
    expect(parseJUnitSummary(junit('alpha.test.ts'), 'alpha.test.ts')).toEqual({
      assertions: 7,
      failures: 0,
      skipped: 0,
      tests: 1,
    });
    expect(() => parseJUnitSummary('<testsuites/>', 'alpha.test.ts')).toThrow(
      'missing JUnit suite evidence',
    );
    expect(() => parseJUnitSummary(junit('alpha.test.ts', 0), 'alpha.test.ts')).toThrow(
      'reported zero tests',
    );
    expect(() => parseJUnitSummary(junit('other.test.ts'), 'alpha.test.ts')).toThrow(
      'reported other.test.ts',
    );
  });

  test('runs every file exactly once in order and freezes the live-E2E skip counts', async () => {
    const liveFile = 'packages/cli/tests/commands/install-live.test.ts';
    const files = ['alpha.test.ts', liveFile, 'omega.test.ts'];
    const calls: string[] = [];

    const receipt = await runFilesSerially(files, async (file) => {
      calls.push(file);
      const skipped = ALLOWED_LIVE_E2E_SKIPS.get(file) ?? 0;
      return { exitCode: 0, junit: junit(file, Math.max(1, skipped), skipped) };
    });

    expect(calls).toEqual(files);
    expect(ALLOWED_LIVE_E2E_SKIPS.size).toBe(6);
    expect([...ALLOWED_LIVE_E2E_SKIPS.values()].reduce((sum, count) => sum + count, 0)).toBe(28);
    expect(receipt).toEqual({
      assertions: 21,
      discovered: 3,
      duplicates: 0,
      executed: 3,
      passed: 3,
      skipped: 3,
      tests: 5,
    });
  });

  test('fails before starting another file on the first nonzero process', async () => {
    const calls: string[] = [];

    await expect(
      runFilesSerially(['alpha.test.ts', 'broken.test.ts', 'never.test.ts'], async (file) => {
        calls.push(file);
        return { exitCode: file === 'broken.test.ts' ? 9 : 0, junit: junit(file) };
      }),
    ).rejects.toThrow('broken.test.ts exited 9 after 2/3 files');
    expect(calls).toEqual(['alpha.test.ts', 'broken.test.ts']);
  });

  test('rejects duplicate files and every unapproved or drifted skip', async () => {
    const duplicateCalls: string[] = [];
    await expect(
      runFilesSerially(['same.test.ts', 'same.test.ts'], async (file) => {
        duplicateCalls.push(file);
        return { exitCode: 0, junit: junit(file) };
      }),
    ).rejects.toThrow('duplicate test file same.test.ts');
    expect(duplicateCalls).toEqual([]);

    await expect(
      runFilesSerially(['ordinary.test.ts'], async (file) => ({
        exitCode: 0,
        junit: junit(file, 1, 1),
      })),
    ).rejects.toThrow('ordinary.test.ts reported 1 skipped tests; expected 0');

    const liveFile = 'packages/core/tests/verify/live-e2e.test.ts';
    await expect(
      runFilesSerially([liveFile], async (file) => ({
        exitCode: 0,
        junit: junit(file, 7, 7),
      })),
    ).rejects.toThrow(`${liveFile} reported 7 skipped tests; expected 8`);
  });
});
