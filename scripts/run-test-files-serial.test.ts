import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWED_LIVE_E2E_SKIPS,
  EXPECTED_BUN_VERSION,
  buildBunTestCommand,
  discoverTestFiles,
  finalizeSuccessfulRun,
  manifestDigest,
  parseJUnitSummary,
  requireCleanRepository,
  requireHyphenSafePath,
  requirePinnedBunVersion,
  runFilesSerially,
  validateTerminalManifest,
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
    '.root-hidden.test.ts',
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
  expect(
    Bun.spawnSync(
      [
        'git',
        '-c',
        'user.name=Skillsmith Test',
        '-c',
        'user.email=skillsmith@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'test fixture',
      ],
      { cwd: root },
    ).exitCode,
  ).toBe(0);
  return root;
}

function terminalFiles(...extra: string[]): string[] {
  return [...extra, ...ALLOWED_LIVE_E2E_SKIPS.keys()].sort();
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

    const nestedSameFile = junit('alpha.test.ts').replace(
      '</testsuite>',
      '  <testsuite name="nested" file="alpha.test.ts" tests="1" assertions="7" failures="0" skipped="0"></testsuite>\n  </testsuite>',
    );
    expect(parseJUnitSummary(nestedSameFile, 'alpha.test.ts').tests).toBe(1);

    const secondFile = junit('alpha.test.ts').replace(
      '</testsuite>',
      '  <testsuite name="extra" file="extra.test.ts" tests="1" assertions="7" failures="0" skipped="0"></testsuite>\n  </testsuite>',
    );
    expect(() => parseJUnitSummary(secondFile, 'alpha.test.ts')).toThrow('reported extra.test.ts');

    const mismatchedOuter = junit('alpha.test.ts').replace(
      'file="alpha.test.ts" tests="1" assertions="7"',
      'file="alpha.test.ts" tests="2" assertions="8"',
    );
    expect(() => parseJUnitSummary(mismatchedOuter, 'alpha.test.ts')).toThrow(
      'root and outer-suite metrics disagree',
    );
  });

  test('runs every file exactly once in order and freezes the live-E2E skip counts', async () => {
    const files = terminalFiles('alpha.test.ts', 'omega.test.ts');
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
      assertions: 56,
      discovered: 8,
      duplicates: 0,
      executed: 8,
      passed: 8,
      skipped: 28,
      tests: 30,
    });
  });

  test('fails before starting another file on the first nonzero process', async () => {
    const calls: string[] = [];
    const files = [
      'alpha.test.ts',
      ...ALLOWED_LIVE_E2E_SKIPS.keys(),
      'broken.test.ts',
      'never.test.ts',
    ];

    await expect(
      runFilesSerially(files, async (file) => {
        calls.push(file);
        const skipped = ALLOWED_LIVE_E2E_SKIPS.get(file) ?? 0;
        return {
          exitCode: file === 'broken.test.ts' ? 9 : 0,
          junit: junit(file, Math.max(1, skipped), skipped),
        };
      }),
    ).rejects.toThrow(`broken.test.ts exited 9 after 8/${files.length} files`);
    expect(calls).toEqual(files.slice(0, -1));
  });

  test('rejects duplicate files and every unapproved or drifted skip', async () => {
    const duplicateCalls: string[] = [];
    await expect(
      runFilesSerially(terminalFiles('same.test.ts', 'same.test.ts'), async (file) => {
        duplicateCalls.push(file);
        return { exitCode: 0, junit: junit(file) };
      }),
    ).rejects.toThrow('duplicate test file same.test.ts');
    expect(duplicateCalls).toEqual([]);

    await expect(
      runFilesSerially(terminalFiles('ordinary.test.ts'), async (file) => {
        const skipped = file === 'ordinary.test.ts' ? 1 : (ALLOWED_LIVE_E2E_SKIPS.get(file) ?? 0);
        return { exitCode: 0, junit: junit(file, Math.max(1, skipped), skipped) };
      }),
    ).rejects.toThrow('ordinary.test.ts reported 1 skipped tests; expected 0');

    const liveFile = 'packages/core/tests/verify/live-e2e.test.ts';
    await expect(
      runFilesSerially(terminalFiles(), async (file) => {
        const skipped = file === liveFile ? 7 : (ALLOWED_LIVE_E2E_SKIPS.get(file) ?? 0);
        return { exitCode: 0, junit: junit(file, Math.max(1, skipped), skipped) };
      }),
    ).rejects.toThrow(`${liveFile} reported 7 skipped tests; expected 8`);
  });

  test('fails closed on missing or drifted live-E2E manifest closure', async () => {
    const files = terminalFiles('ordinary.test.ts');
    const missing = files.filter(
      (file) => file !== 'packages/cli/tests/commands/verify-live.test.ts',
    );
    const calls: string[] = [];

    await expect(
      runFilesSerially(missing, async (file) => {
        calls.push(file);
        return { exitCode: 0, junit: junit(file) };
      }),
    ).rejects.toThrow('test-file manifest is missing live-E2E file');
    expect(calls).toEqual([]);

    expect(() =>
      validateTerminalManifest(files, new Map([...ALLOWED_LIVE_E2E_SKIPS].slice(1))),
    ).toThrow('skip allowlist has 5 files; expected 6');
    expect(() =>
      validateTerminalManifest(
        files,
        new Map(
          [...ALLOWED_LIVE_E2E_SKIPS].map(([file, count], index) => [
            file,
            count - Number(index === 0),
          ]),
        ),
      ),
    ).toThrow('skip allowlist totals 27; expected 28');
  });

  test('enforces the pinned Bun, strict paths, cleanup, and post-run clean state', () => {
    expect(() => requirePinnedBunVersion(EXPECTED_BUN_VERSION)).not.toThrow();
    expect(() => requirePinnedBunVersion('1.3.15')).toThrow('requires Bun 1.3.14; found 1.3.15');
    expect(() => requireHyphenSafePath('/dev/shm/skillsmith-gate-123', 'fixture')).not.toThrow();
    expect(() => requireHyphenSafePath('/dev/shm/skillsmith_gate', 'fixture')).toThrow(
      'unsafe path component skillsmith_gate',
    );
    expect(() => requireHyphenSafePath('/dev/shm/skillsmith gate', 'fixture')).toThrow(
      'unsafe path component skillsmith gate',
    );

    const root = repositoryFixture();
    rmSync(join(root, 'untracked.test.ts'));
    expect(() => requireCleanRepository(root)).not.toThrow();
    const runRoot = join(root, 'runner-temp');
    mkdirSync(runRoot);
    writeFileSync(join(root, 'left-behind.txt'), 'residue\n');
    expect(() => finalizeSuccessfulRun(root, runRoot)).toThrow('requires a clean repository');
    expect(() => rmSync(runRoot)).toThrow();
  });
});
