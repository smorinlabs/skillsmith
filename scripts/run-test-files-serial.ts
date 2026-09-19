#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const bunTestFilePattern = /(?:^|\/)[^/]+(?:\.(?:test|spec)|_(?:test|spec))\.(?:js|jsx|ts|tsx)$/;
const safePathComponentPattern = /^[A-Za-z0-9-]+$/;
const gitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
export const EXPECTED_BUN_VERSION = '1.3.14';
const EXPECTED_ALLOWED_SKIP_FILES = 7;
const EXPECTED_ALLOWED_SKIPS = 33;

export const ALLOWED_LIVE_E2E_SKIPS: ReadonlyMap<string, number> = new Map([
  ['packages/core/tests/verify/live-e2e.test.ts', 8],
  ['packages/core/tests/acquire/copy-replacement-recovery.test.ts', 5],
  ['packages/cli/tests/commands/install-live.test.ts', 3],
  ['packages/cli/tests/commands/verify-live.test.ts', 3],
  ['packages/cli/tests/commands/flip-live.test.ts', 2],
  ['packages/cli/tests/commands/install-remote-live.test.ts', 4],
  ['packages/cli/tests/commands/dev-source-live.test.ts', 8],
]);

export type JUnitSummary = {
  assertions: number;
  failures: number;
  skipped: number;
  tests: number;
};

export type SerialFileOutcome = {
  exitCode: number;
  junit: string;
};

export type SerialReceipt = {
  assertions: number;
  discovered: number;
  duplicates: number;
  executed: number;
  passed: number;
  skipped: number;
  tests: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function git(root: string, arguments_: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'core.fsmonitor=false', ...arguments_], {
    cwd: root,
    env: {
      ...gitEnvironment,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    fail(`git ${arguments_.join(' ')} failed in ${root}: ${decode(result.stderr).trim()}`);
  }
  return decode(result.stdout);
}

function isHiddenOrDependencyPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.') || segment === 'node_modules');
}

export function discoverTestFiles(root: string): string[] {
  const files = git(root, ['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter((path) => bunTestFilePattern.test(path) && !isHiddenOrDependencyPath(path))
    .sort();

  if (files.length === 0) fail('discovered zero tracked Bun test files');
  const duplicate = files.find((path, index) => files.indexOf(path) !== index);
  if (duplicate) fail(`duplicate test file ${duplicate}`);
  return files;
}

export function manifestDigest(files: readonly string[]): string {
  return createHash('sha256')
    .update(`${files.join('\n')}\n`)
    .digest('hex');
}

export function buildBunTestCommand(
  file: string,
  reportPath: string,
  bunExecutable = process.execPath,
): string[] {
  return [
    bunExecutable,
    'test',
    `./${file}`,
    '--timeout=60000',
    '--max-concurrency=1',
    '--no-orphans',
    '--retry=0',
    '--reporter=junit',
    `--reporter-outfile=${reportPath}`,
  ];
}

function attributes(fragment: string): Map<string, string> {
  return new Map(
    Array.from(fragment.matchAll(/\b([A-Za-z][\w-]*)="([^"]*)"/g), (match) => [
      match[1] ?? '',
      match[2] ?? '',
    ]),
  );
}

function numericAttribute(values: Map<string, string>, name: string): number {
  const value = values.get(name);
  if (!value || !/^\d+$/.test(value)) fail(`missing numeric JUnit attributes: ${name}`);
  return Number.parseInt(value, 10);
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function parseJUnitSummary(xml: string, expectedFile: string): JUnitSummary {
  const root = xml.match(/<testsuites\b([^>]*)>/);
  const suites = Array.from(xml.matchAll(/<testsuite\b([^>]*)>/g));
  if (!root || suites.length === 0) fail(`missing JUnit suite evidence for ${expectedFile}`);

  const rootAttributes = attributes(root[1] ?? '');
  const suiteAttributeSets = suites.map((suite) => attributes(suite[1] ?? ''));
  for (const suiteAttributes of suiteAttributeSets) {
    const reportedFile = decodeXml(suiteAttributes.get('file') ?? '');
    if (reportedFile !== expectedFile) {
      fail(`${expectedFile} JUnit evidence reported ${reportedFile || 'no file'}`);
    }
  }

  const summary = {
    assertions: numericAttribute(rootAttributes, 'assertions'),
    failures: numericAttribute(rootAttributes, 'failures'),
    skipped: numericAttribute(rootAttributes, 'skipped'),
    tests: numericAttribute(rootAttributes, 'tests'),
  };
  if (summary.tests === 0) fail(`${expectedFile} reported zero tests`);
  const outerSummary = {
    assertions: numericAttribute(suiteAttributeSets[0] ?? new Map(), 'assertions'),
    failures: numericAttribute(suiteAttributeSets[0] ?? new Map(), 'failures'),
    skipped: numericAttribute(suiteAttributeSets[0] ?? new Map(), 'skipped'),
    tests: numericAttribute(suiteAttributeSets[0] ?? new Map(), 'tests'),
  };
  if (JSON.stringify(outerSummary) !== JSON.stringify(summary)) {
    fail(`${expectedFile} JUnit root and outer-suite metrics disagree`);
  }
  return summary;
}

export function validateTerminalManifest(
  files: readonly string[],
  allowedSkips: ReadonlyMap<string, number> = ALLOWED_LIVE_E2E_SKIPS,
): number {
  if (allowedSkips.size !== EXPECTED_ALLOWED_SKIP_FILES) {
    fail(
      `live-E2E skip allowlist has ${allowedSkips.size} files; expected ${EXPECTED_ALLOWED_SKIP_FILES}`,
    );
  }
  const expectedSkips = [...allowedSkips.values()].reduce((sum, count) => sum + count, 0);
  if (expectedSkips !== EXPECTED_ALLOWED_SKIPS) {
    fail(`live-E2E skip allowlist totals ${expectedSkips}; expected ${EXPECTED_ALLOWED_SKIPS}`);
  }
  const fileSet = new Set(files);
  const missing = [...allowedSkips.keys()].filter((file) => !fileSet.has(file));
  if (missing.length > 0) fail(`test-file manifest is missing live-E2E file ${missing[0]}`);
  return expectedSkips;
}

export async function runFilesSerially(
  files: readonly string[],
  runFile: (file: string, index: number, total: number) => Promise<SerialFileOutcome>,
): Promise<SerialReceipt> {
  if (files.length === 0) fail('cannot run an empty test-file manifest');
  const duplicate = files.find((file, index) => files.indexOf(file) !== index);
  if (duplicate) fail(`duplicate test file ${duplicate}`);
  const expectedTotalSkips = validateTerminalManifest(files);
  const seen = new Set<string>();
  let assertions = 0;
  let executed = 0;
  let passed = 0;
  let skipped = 0;
  let tests = 0;

  for (const [index, file] of files.entries()) {
    seen.add(file);
    executed += 1;

    const outcome = await runFile(file, index, files.length);
    if (outcome.exitCode !== 0) {
      fail(`${file} exited ${outcome.exitCode} after ${executed}/${files.length} files`);
    }

    const summary = parseJUnitSummary(outcome.junit, file);
    if (summary.failures !== 0) {
      fail(`${file} reported ${summary.failures} JUnit failures after exit 0`);
    }
    const expectedSkips = ALLOWED_LIVE_E2E_SKIPS.get(file) ?? 0;
    if (summary.skipped !== expectedSkips) {
      fail(`${file} reported ${summary.skipped} skipped tests; expected ${expectedSkips}`);
    }

    assertions += summary.assertions;
    passed += 1;
    skipped += summary.skipped;
    tests += summary.tests;
  }

  if (skipped !== expectedTotalSkips) {
    fail(
      `serial test-file receipt totals ${skipped} skipped tests; expected ${expectedTotalSkips}`,
    );
  }

  return {
    assertions,
    discovered: files.length,
    duplicates: files.length - seen.size,
    executed,
    passed,
    skipped,
    tests,
  };
}

export function requireHyphenSafePath(path: string, label: string): void {
  const unsafe = resolve(path)
    .split(sep)
    .filter(Boolean)
    .find((segment) => !safePathComponentPattern.test(segment));
  if (unsafe) fail(`${label} contains unsafe path component ${unsafe}: ${resolve(path)}`);
}

export function requirePinnedBunVersion(actualVersion: string): void {
  if (actualVersion !== EXPECTED_BUN_VERSION) {
    fail(
      `serial test-file terminal runner requires Bun ${EXPECTED_BUN_VERSION}; found ${actualVersion}`,
    );
  }
}

export function requireCleanRepository(root: string): void {
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.length > 0) fail('serial test-file terminal runner requires a clean repository');
}

export type RepositoryIdentity = Readonly<{
  HEAD: string;
  headRef: string;
  gitDirectory: string;
  commonDirectory: string;
  indexPath: string;
  index: string | null;
  config: string | null;
  worktreeConfig: string | null;
}>;

function fileDigest(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function captureRepositoryIdentity(root: string): RepositoryIdentity {
  const gitDirectory = realpathSync(git(root, ['rev-parse', '--absolute-git-dir']).trim());
  const commonDirectory = realpathSync(
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
  );
  const indexPath = git(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'index',
  ]).trim();
  return {
    HEAD: git(root, ['rev-parse', '--verify', 'HEAD']).trim(),
    headRef: git(root, ['rev-parse', '--symbolic-full-name', 'HEAD']).trim(),
    gitDirectory,
    commonDirectory,
    indexPath,
    index: fileDigest(indexPath),
    config: fileDigest(join(commonDirectory, 'config')),
    worktreeConfig: fileDigest(join(gitDirectory, 'config.worktree')),
  };
}

function requireUnchangedRepository(root: string, initial: RepositoryIdentity): void {
  const final = captureRepositoryIdentity(root);
  const changes = (Object.keys(initial) as (keyof RepositoryIdentity)[])
    .filter((key) => initial[key] !== final[key])
    .map((key) => `${key}: ${initial[key] ?? 'missing'} -> ${final[key] ?? 'missing'}`);
  if (changes.length > 0)
    fail(`serial test-file repository identity changed: ${changes.join('; ')}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function finalizeSuccessfulRun(
  root: string,
  runRoot: string,
  initial: RepositoryIdentity,
): void {
  const errors: unknown[] = [];
  for (const action of [
    () => requireUnchangedRepository(root, initial),
    () => rmSync(runRoot, { force: true, recursive: true }),
    () => requireCleanRepository(root),
  ]) {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) fail(errors.map(errorMessage).join('\n'));
}

export async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    fail('serial test-file terminal runner accepts no arguments');
  }
  if (process.env.SKILLSMITH_E2E !== undefined) {
    fail('serial test-file terminal runner refuses SKILLSMITH_E2E');
  }

  requirePinnedBunVersion(Bun.version);
  requireHyphenSafePath(repositoryRoot, 'repository root');
  requireCleanRepository(repositoryRoot);
  const initial = captureRepositoryIdentity(repositoryRoot);
  const testFiles = discoverTestFiles(repositoryRoot);
  const digest = manifestDigest(testFiles);
  const temporaryBase = resolve(process.env.TMPDIR ?? tmpdir());
  requireHyphenSafePath(temporaryBase, 'TMPDIR');
  const runRoot = mkdtempSync(join(temporaryBase, 'skillsmith-serial-tests-'));

  console.log(
    `serial test-file manifest: ${testFiles.length} files; sha256=${digest}; bun=${Bun.version}`,
  );

  let receipt: SerialReceipt | undefined;
  const errors: unknown[] = [];
  try {
    receipt = await runFilesSerially(testFiles, async (file, index, total) => {
      const reportPath = join(runRoot, `junit-${String(index + 1).padStart(4, '0')}.xml`);
      const command = buildBunTestCommand(file, reportPath);
      console.log(`[${index + 1}/${total}] ${file}`);
      const child = Bun.spawn(command, {
        cwd: repositoryRoot,
        env: { ...gitEnvironment, TMPDIR: runRoot },
        stderr: 'inherit',
        stdout: 'inherit',
      });
      const exitCode = await child.exited;
      return {
        exitCode,
        junit: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '',
      };
    });
  } catch (error) {
    errors.push(error);
  }

  try {
    finalizeSuccessfulRun(repositoryRoot, runRoot, initial);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) fail(errors.map(errorMessage).join('\n'));
  console.log(
    `SERIAL_TEST_FILE_RECEIPT ${JSON.stringify({
      ...receipt,
      bun: Bun.version,
      manifestSha256: digest,
    })}`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
