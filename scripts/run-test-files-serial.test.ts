import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWED_LIVE_E2E_SKIPS,
  EXPECTED_BUN_VERSION,
  buildBunTestCommand,
  captureRepositoryIdentity,
  discoverTestFiles,
  finalizeSuccessfulRun,
  manifestDigest,
  parseJUnitSummary,
  requireCleanRepository,
  requirePinnedBunVersion,
  runFilesSerially,
  validateTerminalManifest,
} from './run-test-files-serial';

const temporaryDirectories: string[] = [];

const fixtureGitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_OPTIONAL_LOCKS: '0',
};

function fixtureGit(root: string, args: string[]): string {
  const result = Bun.spawnSync(
    [
      'git',
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${devNull}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Skillsmith Test',
      '-c',
      'user.email=skillsmith@example.invalid',
      ...args,
    ],
    { cwd: root, env: { ...fixtureGitEnvironment, HOME: root }, stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

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

  fixtureGit(root, ['init', '--quiet']);
  fixtureGit(root, ['add', '--force', '--', ...tracked]);
  fixtureGit(root, ['commit', '--quiet', '-m', 'test fixture']);
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

function independentIdentity(root: string) {
  const digest = (path: string) =>
    createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex');
  return {
    head: fixtureGit(root, ['rev-parse', 'HEAD']),
    ref: fixtureGit(root, ['symbolic-ref', 'HEAD']),
    index: digest('.git/index'),
    config: digest('.git/config'),
    sentinel: digest('README.md'),
    status: fixtureGit(root, ['status', '--porcelain']),
  };
}

function initializeTerminalRepository(root: string): void {
  fixtureGit(root, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [
    ['user.name', 'Skillsmith Test'],
    ['user.email', 'skillsmith@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', devNull],
    ['core.fsmonitor', 'false'],
  ])
    fixtureGit(root, ['config', key as string, value as string]);
  writeFileSync(join(root, 'README.md'), 'sacrificial outer sentinel\n');
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-qm', 'test: sacrificial initial']);
}

async function terminalIntegration(mode: 'commit' | 'pass' | 'fail', poison = 'trio') {
  // Route fixture trees through an isolated base under /tmp rather than the
  // ambient TMPDIR for hermetic integration runs.
  const base = mkdtempSync(join('/tmp', 'skillsmith-serial-integration-'));
  temporaryDirectories.push(base);
  const root = join(base, 'runner');
  const outer = join(base, 'outer');
  const temporary = join(base, 'tmp');
  const home = join(base, 'home');
  for (const path of [join(root, 'scripts'), outer, temporary, home])
    mkdirSync(path, { recursive: true });
  initializeTerminalRepository(outer);
  copyFileSync(
    join(import.meta.dir, 'run-test-files-serial.ts'),
    join(root, 'scripts/run-test-files-serial.ts'),
  );
  for (const [file, count] of ALLOWED_LIVE_E2E_SKIPS) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(
      join(root, file),
      `import { test } from 'bun:test';\n${Array.from({ length: count }, (_, i) => `test.skip('live ${i}', () => {});`).join('\n')}\n`,
    );
  }
  writeFileSync(
    join(root, 'ordinary.test.ts'),
    `
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
test('real terminal child', () => {
  expect(Object.keys(process.env).filter(key => key.startsWith('GIT_'))).toEqual([]);
  expect(process.env.SKILLSMITH_SERIAL_CANARY).toBe('retained');
  expect(process.env.TMPDIR).toContain('skillsmith-serial-tests-');
  const git = (cwd, args) => {
    const result = Bun.spawnSync([${JSON.stringify(Bun.which('git'))}, '-c', 'core.hooksPath=${devNull}', '-c', 'commit.gpgsign=false', '-c', 'user.name=Skillsmith Test', '-c', 'user.email=skillsmith@example.invalid', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
  };
  ${
    mode === 'commit'
      ? "git(process.cwd(), ['commit', '--allow-empty', '-qm', 'test: child committed']);"
      : mode === 'fail'
        ? "git(process.cwd(), ['config', 'fixture.changed', 'true']); expect('deliberate child failure').toBe('pass');"
        : `const nested = mkdtempSync(join(process.env.TMPDIR, 'nested-'));
  try { git(nested, ['init', '-q']); git(nested, ['commit', '--allow-empty', '-qm', 'test: nested fixture']); }
  finally { rmSync(nested, { recursive: true, force: true }); }`
  }
});\n`,
  );
  initializeTerminalRepository(root);
  const before = independentIdentity(outer);
  const runnerBefore = independentIdentity(root);
  const gitDirectory = join(outer, '.git');
  const redirect = { GIT_DIR: gitDirectory, GIT_INDEX_FILE: join(gitDirectory, 'index') };
  const poisonEnvironment: Record<string, string> =
    poison === 'hook'
      ? redirect
      : poison === 'trio'
        ? { ...redirect, GIT_WORK_TREE: outer }
        : poison === 'common'
          ? { ...redirect, GIT_COMMON_DIR: gitDirectory }
          : poison === 'objects'
            ? {
                GIT_OBJECT_DIRECTORY: join(gitDirectory, 'objects'),
                GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDirectory, 'objects'),
              }
            : poison === 'config'
              ? {
                  GIT_CONFIG_COUNT: '1',
                  GIT_CONFIG_KEY_0: 'core.worktree',
                  GIT_CONFIG_VALUE_0: outer,
                  GIT_CONFIG_PARAMETERS: "'core.bare=false'",
                }
              : {
                  GIT_CEILING_DIRECTORIES: base,
                  GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
                  GIT_NAMESPACE: 'fixture-namespace',
                };
  const child = Bun.spawn([process.execPath, join(root, 'scripts/run-test-files-serial.ts')], {
    cwd: root,
    env: {
      ...fixtureGitEnvironment,
      HOME: home,
      XDG_CONFIG_HOME: home,
      TMPDIR: temporary,
      SKILLSMITH_SERIAL_CANARY: 'retained',
      ...poisonEnvironment,
      GIT_SKILLSMITH_TEST_CANARY: 'must disappear',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const exitCode = await child.exited;
    expect(independentIdentity(outer)).toEqual(before);
    expect(readdirSync(temporary)).toEqual([]);
    return {
      exitCode,
      stdout: await stdout,
      stderr: await stderr,
      runnerBefore,
      runnerAfter: independentIdentity(root),
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

describe('serial test-file terminal runner', () => {
  test('real runner rejects a successful child that commits in its terminal repository', async () => {
    const result = await terminalIntegration('commit');
    expect(result.runnerAfter.head).not.toBe(result.runnerBefore.head);
    expect(result.runnerAfter.status).toBe('');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HEAD');
    expect(result.stdout).not.toContain('SERIAL_TEST_FILE_RECEIPT');
  }, 30_000);

  test('rejects a committed change even when the terminal repository is clean', () => {
    const root = repositoryFixture();
    rmSync(join(root, 'untracked.test.ts'));
    const head = fixtureGit(root, ['rev-parse', 'HEAD']);
    const initial = captureRepositoryIdentity(root);
    fixtureGit(root, ['commit', '--allow-empty', '-qm', 'test: sacrificial extra commit']);
    expect(fixtureGit(root, ['rev-parse', 'HEAD'])).not.toBe(head);
    expect(fixtureGit(root, ['status', '--porcelain'])).toBe('');
    const runRoot = join(root, 'runner-temp');
    mkdirSync(runRoot);
    expect(() => finalizeSuccessfulRun(root, runRoot, initial)).toThrow(`HEAD: ${head} ->`);
  });

  test.each(['hook', 'trio', 'common', 'objects', 'config', 'discovery'])(
    'real runner isolates %s startup and emits a receipt only for unchanged repositories',
    async (poison) => {
      const result = await terminalIntegration('pass', poison);
      expect(result.exitCode).toBe(0);
      expect(result.runnerAfter).toEqual(result.runnerBefore);
      const receipt = result.stdout.match(/SERIAL_TEST_FILE_RECEIPT (.+)/)?.[1];
      expect(receipt).toBeDefined();
      expect(JSON.parse(receipt as string)).toMatchObject({
        discovered: 8,
        executed: 8,
        passed: 8,
        skipped: 34,
      });
    },
    30_000,
  );

  test('real runner retains child failure and repository mutation diagnostics', async () => {
    const result = await terminalIntegration('fail');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ordinary.test.ts exited 1');
    expect(result.stderr).toContain('repository identity changed: config:');
    expect(result.stdout).not.toContain('SERIAL_TEST_FILE_RECEIPT');
  }, 30_000);

  test.each(['config', 'index', 'headRef', 'worktreeConfig'])(
    'rejects clean repository %s drift',
    (kind) => {
      const root = repositoryFixture();
      rmSync(join(root, 'untracked.test.ts'));
      const initial = captureRepositoryIdentity(root);
      if (kind === 'config') fixtureGit(root, ['config', 'fixture.changed', 'true']);
      if (kind === 'index')
        fixtureGit(root, ['update-index', '--assume-unchanged', 'alpha.test.ts']);
      if (kind === 'headRef') fixtureGit(root, ['checkout', '-qb', 'same-commit']);
      if (kind === 'worktreeConfig')
        writeFileSync(join(root, '.git/config.worktree'), '[fixture]\nchanged = true\n');
      expect(fixtureGit(root, ['status', '--porcelain'])).toBe('');
      const runRoot = join(root, 'runner-temp');
      mkdirSync(runRoot);
      expect(() => finalizeSuccessfulRun(root, runRoot, initial)).toThrow(`${kind}:`);
      expect(() => rmSync(runRoot)).toThrow();
    },
  );

  test('observes an unchanged repository without rewriting its index or config', () => {
    const root = repositoryFixture();
    rmSync(join(root, 'untracked.test.ts'));
    const bytes = [readFileSync(join(root, '.git/index')), readFileSync(join(root, '.git/config'))];
    const initial = captureRepositoryIdentity(root);
    const runRoot = join(root, 'runner-temp');
    mkdirSync(runRoot);
    finalizeSuccessfulRun(root, runRoot, initial);
    expect(captureRepositoryIdentity(root)).toEqual(initial);
    expect([
      readFileSync(join(root, '.git/index')),
      readFileSync(join(root, '.git/config')),
    ]).toEqual(bytes);
  });

  test('resolves a detached linked worktree index and shared configuration', () => {
    const root = repositoryFixture();
    const linked = mkdtempSync(join(tmpdir(), 'skillsmith-serial-linked-'));
    temporaryDirectories.push(linked);
    fixtureGit(root, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const initial = captureRepositoryIdentity(linked);
    expect(initial.headRef).toBe('HEAD');
    expect(initial.commonDirectory).toBe(realpathSync(join(root, '.git')));
    expect(initial.gitDirectory).not.toBe(initial.commonDirectory);
    expect(initial.indexPath).toBe(join(initial.gitDirectory, 'index'));
    const runRoot = join(linked, 'runner-temp');
    mkdirSync(runRoot);
    finalizeSuccessfulRun(linked, runRoot, initial);
    fixtureGit(root, ['config', 'fixture.changed', 'true']);
    expect(() => finalizeSuccessfulRun(linked, runRoot, initial)).toThrow('config:');
  });

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
    expect(ALLOWED_LIVE_E2E_SKIPS.size).toBe(7);
    expect([...ALLOWED_LIVE_E2E_SKIPS.values()].reduce((sum, count) => sum + count, 0)).toBe(34);
    expect(receipt).toEqual({
      assertions: 63,
      discovered: 9,
      duplicates: 0,
      executed: 9,
      passed: 9,
      skipped: 34,
      tests: 36,
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
    ).rejects.toThrow(`broken.test.ts exited 9 after 9/${files.length} files`);
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
    ).toThrow('skip allowlist has 6 files; expected 7');
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
    ).toThrow('skip allowlist totals 33; expected 34');
  });

  test('enforces the pinned Bun, cleanup, and post-run clean state', () => {
    expect(() => requirePinnedBunVersion(EXPECTED_BUN_VERSION)).not.toThrow();
    expect(() => requirePinnedBunVersion('1.3.15')).toThrow('requires Bun 1.3.14; found 1.3.15');

    const root = repositoryFixture();
    rmSync(join(root, 'untracked.test.ts'));
    expect(() => requireCleanRepository(root)).not.toThrow();
    const initial = captureRepositoryIdentity(root);
    const runRoot = join(root, 'runner-temp');
    mkdirSync(runRoot);
    writeFileSync(join(root, 'left-behind.txt'), 'residue\n');
    expect(() => finalizeSuccessfulRun(root, runRoot, initial)).toThrow(
      'requires a clean repository',
    );
    expect(() => rmSync(runRoot)).toThrow();
  });
});
