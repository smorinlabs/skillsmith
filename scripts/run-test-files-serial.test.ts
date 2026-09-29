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
import { delimiter, join } from 'node:path';
import {
  ALLOWED_LIVE_E2E_SKIPS,
  ENV_EWP_SKIP_COUNT,
  ENV_EWP_SKIP_FILE,
  ENV_NATIVE_SKIP_COUNT,
  ENV_NATIVE_SKIP_FILE,
  ENV_STRACE_SKIP_COUNT,
  ENV_STRACE_SKIP_FILE,
  type EnvSkipProbes,
  MINIMUM_BUN_VERSION,
  NATIVE_MIN_FREE_BYTES,
  PINNED_CAPABILITY_SKIPS,
  buildBunTestCommand,
  captureRepositoryIdentity,
  childTestEnvironment,
  createRunRoot,
  discoverTestFiles,
  ewpPtyEnabled,
  finalizeSuccessfulRun,
  manifestDigest,
  nativeCompileEnabled,
  parseJUnitSummary,
  requireCleanRepository,
  requireMinimumBunVersion,
  resolveAllowedSkips,
  runFilesSerially,
  straceLaneEnabled,
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
  return [...extra, ...resolveAllowedSkips().keys()].sort();
}

const straceProbes = (enabled: boolean): EnvSkipProbes =>
  enabled ? { platform: 'linux', which: () => '/usr/bin/strace' } : { platform: 'darwin' };

const nativeProbes = (enabled: boolean): EnvSkipProbes =>
  enabled
    ? { statfs: () => ({ bavail: NATIVE_MIN_FREE_BYTES, bsize: 1 }) }
    : { statfs: () => ({ bavail: 0, bsize: 4096 }) };

const closedGates: EnvSkipProbes = {
  ...straceProbes(false),
  ...nativeProbes(false),
};

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
  for (const script of ['run-test-files-serial.ts', 'tool-versions.ts']) {
    copyFileSync(join(import.meta.dir, script), join(root, 'scripts', script));
  }
  for (const [file, count] of ALLOWED_LIVE_E2E_SKIPS) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(
      join(root, file),
      `import { test } from 'bun:test';\n${Array.from({ length: count }, (_, i) => `test.skip('live ${i}', () => {});`).join('\n')}\n`,
    );
  }
  for (const file of [ENV_STRACE_SKIP_FILE, ENV_NATIVE_SKIP_FILE, ENV_EWP_SKIP_FILE])
    mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(
    join(root, ENV_STRACE_SKIP_FILE),
    `import { test } from 'bun:test';\nconst lane2StraceOk = process.platform === 'linux' && Bun.which('strace') !== null;\n${Array.from({ length: ENV_STRACE_SKIP_COUNT }, (_, i) => `test.skipIf(!lane2StraceOk)('strace ${i}', () => {});`).join('\n')}\n`,
  );
  writeFileSync(
    join(root, ENV_NATIVE_SKIP_FILE),
    `import { test } from 'bun:test';\nimport { statfsSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nconst nativeEnabled = (() => { try { const s = statfsSync(tmpdir()); return s.bavail * s.bsize >= ${NATIVE_MIN_FREE_BYTES}; } catch { return false; } })();\ntest.skipIf(!nativeEnabled)('native control', () => {});\n`,
  );
  writeFileSync(
    join(root, ENV_EWP_SKIP_FILE),
    `import { test } from 'bun:test';\ntest.skipIf(process.platform !== 'linux')('pty control', () => {});\n`,
  );
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
    // The child runner resolves its env-gated skips against its own TMPDIR; mirror that
    // resolution exactly when computing the expected receipt total.
    const expectedSkips = [
      ...resolveAllowedSkips({ scratchDirectory: () => temporary }).values(),
    ].reduce((sum, count) => sum + count, 0);
    return {
      exitCode,
      stdout: await stdout,
      stderr: await stderr,
      expectedSkips,
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
      expect(result.stdout).toContain('serial test-file env-gated skips:');
      expect(result.expectedSkips).toBeGreaterThanOrEqual(42);
      expect(result.expectedSkips).toBeLessThanOrEqual(49);
      const receipt = result.stdout.match(/SERIAL_TEST_FILE_RECEIPT (.+)/)?.[1];
      expect(receipt).toBeDefined();
      expect(JSON.parse(receipt as string)).toMatchObject({
        discovered: 12,
        executed: 12,
        passed: 12,
        skipped: result.expectedSkips,
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

  test('resolves environment-gated skips from injected probes and fails closed on errors', () => {
    expect(straceLaneEnabled({ platform: 'linux', which: () => '/usr/bin/strace' })).toBe(true);
    expect(straceLaneEnabled({ platform: 'darwin', which: () => '/usr/bin/strace' })).toBe(false);
    expect(straceLaneEnabled({ platform: 'linux', which: () => null })).toBe(false);
    expect(
      straceLaneEnabled({
        platform: 'linux',
        which: () => {
          throw new Error('probe boom');
        },
      }),
    ).toBe(false);

    expect(
      nativeCompileEnabled({ statfs: () => ({ bavail: NATIVE_MIN_FREE_BYTES, bsize: 1 }) }),
    ).toBe(true);
    expect(
      nativeCompileEnabled({ statfs: () => ({ bavail: NATIVE_MIN_FREE_BYTES - 1, bsize: 1 }) }),
    ).toBe(false);
    expect(
      nativeCompileEnabled({
        statfs: () => {
          throw new Error('probe boom');
        },
      }),
    ).toBe(false);
    expect(
      nativeCompileEnabled({
        scratchDirectory: () => {
          throw new Error('probe boom');
        },
      }),
    ).toBe(false);

    expect(ewpPtyEnabled({ platform: 'linux' })).toBe(true);
    expect(ewpPtyEnabled({ platform: 'darwin' })).toBe(false);
    expect(ewpPtyEnabled({ platform: 'win32' })).toBe(false);
    expect(
      ewpPtyEnabled({
        get platform(): string {
          throw new Error('probe boom');
        },
      }),
    ).toBe(false);

    const resolved = resolveAllowedSkips(closedGates);
    expect(resolved.size).toBe(11);
    expect(resolved.get(ENV_STRACE_SKIP_FILE)).toBe(ENV_STRACE_SKIP_COUNT);
    expect(resolved.get(ENV_NATIVE_SKIP_FILE)).toBe(ENV_NATIVE_SKIP_COUNT);
    expect(resolved.get(ENV_EWP_SKIP_FILE)).toBe(ENV_EWP_SKIP_COUNT);
    const open = resolveAllowedSkips({
      ...straceProbes(true),
      ...nativeProbes(true),
    });
    expect(open.get(ENV_STRACE_SKIP_FILE)).toBe(0);
    expect(open.get(ENV_NATIVE_SKIP_FILE)).toBe(0);
    expect(open.get(ENV_EWP_SKIP_FILE)).toBe(0);
  });

  test('child environment drops GIT_* and the git exec path a hook prepends to PATH', () => {
    const hook = {
      PATH: ['/git-core', '/usr/bin', '/git-core'].join(delimiter),
      GIT_EXEC_PATH: '/git-core',
      GIT_DIR: '/repo/.git',
      HOME: '/home',
    };
    expect(childTestEnvironment(hook)).toEqual({
      PATH: ['/usr/bin', '/git-core'].join(delimiter),
      HOME: '/home',
    });
    expect(childTestEnvironment({ PATH: ['/a', '/b'].join(delimiter), HOME: '/home' })).toEqual({
      PATH: ['/a', '/b'].join(delimiter),
      HOME: '/home',
    });
  });

  test('sharded CI expects the pinned-capability skips, independent of the validating machine', () => {
    const open = resolveAllowedSkips({ ...straceProbes(true), ...nativeProbes(true) });
    expect([...PINNED_CAPABILITY_SKIPS]).toEqual([...open]);
    expect(
      validateTerminalManifest([...PINNED_CAPABILITY_SKIPS.keys()], PINNED_CAPABILITY_SKIPS),
    ).toBe([...ALLOWED_LIVE_E2E_SKIPS.values()].reduce((sum, count) => sum + count, 0));
  });

  test.each([
    { linux: true, straceFound: true, native: true },
    { linux: true, straceFound: true, native: false },
    { linux: true, straceFound: false, native: true },
    { linux: true, straceFound: false, native: false },
    { linux: false, straceFound: true, native: true },
    { linux: false, straceFound: true, native: false },
    { linux: false, straceFound: false, native: true },
    { linux: false, straceFound: false, native: false },
  ])(
    'runs every file exactly once in order with resolved env skips (linux=$linux straceFound=$straceFound native=$native)',
    async ({ linux, straceFound, native }) => {
      const allowed = resolveAllowedSkips({
        platform: linux ? 'linux' : 'darwin',
        which: () => (straceFound ? '/usr/bin/strace' : null),
        ...nativeProbes(native),
      });
      const files = terminalFiles('alpha.test.ts', 'omega.test.ts');
      const calls: string[] = [];

      const receipt = await runFilesSerially(
        files,
        async (file) => {
          calls.push(file);
          const skipped = allowed.get(file) ?? 0;
          return { exitCode: 0, junit: junit(file, Math.max(1, skipped), skipped) };
        },
        allowed,
      );

      const straceSkips = linux && straceFound ? 0 : ENV_STRACE_SKIP_COUNT;
      const nativeSkips = native ? 0 : ENV_NATIVE_SKIP_COUNT;
      const ewpSkips = linux ? 0 : ENV_EWP_SKIP_COUNT;
      expect(calls).toEqual(files);
      expect(allowed.size).toBe(11);
      expect(ALLOWED_LIVE_E2E_SKIPS.size).toBe(8);
      expect([...ALLOWED_LIVE_E2E_SKIPS.values()].reduce((sum, count) => sum + count, 0)).toBe(42);
      expect(ENV_STRACE_SKIP_COUNT).toBe(5);
      expect(ENV_NATIVE_SKIP_COUNT).toBe(1);
      expect(ENV_EWP_SKIP_COUNT).toBe(1);
      expect(receipt).toEqual({
        assertions: 91,
        discovered: 13,
        duplicates: 0,
        executed: 13,
        passed: 13,
        skipped: 42 + straceSkips + nativeSkips + ewpSkips,
        tests: 44 + Math.max(1, straceSkips) + Math.max(1, nativeSkips) + Math.max(1, ewpSkips),
      });
    },
  );

  test('pins environment-gated test magnitudes to their frozen counts', () => {
    const root = join(import.meta.dir, '..');
    const readTracked = (file: string): string => readFileSync(join(root, file), 'utf8');

    // A 6th lane-2 test runs (0 skips) on CI yet reports 6 skips on strace-less
    // machines, which only reddens macOS post-merge. Pin the gated count at the source.
    const rootperm = readTracked(ENV_STRACE_SKIP_FILE);
    expect(rootperm).toContain('lane2StraceOk');
    const blockStart = rootperm.indexOf('describe.skipIf(!lane2StraceOk)(');
    const blockEnd = rootperm.indexOf("describe('SC-I60-MF2A lane 3", blockStart);
    if (blockStart < 0 || blockEnd < 0) throw new Error('lane-2 block markers moved');
    const lane2Tests = rootperm.slice(blockStart, blockEnd).match(/\n\s*test\(/g) ?? [];
    expect(lane2Tests).toHaveLength(ENV_STRACE_SKIP_COUNT);

    const backup = readTracked(ENV_NATIVE_SKIP_FILE);
    expect(backup).toContain('NATIVE_ENABLED');
    expect(backup.match(/test\.skipIf\(/g) ?? []).toHaveLength(ENV_NATIVE_SKIP_COUNT);

    const ewp = readTracked(ENV_EWP_SKIP_FILE);
    expect(ewp).toContain("test.skipIf(process.platform !== 'linux')");
    expect(ewp.match(/test\.skipIf\(/g) ?? []).toHaveLength(ENV_EWP_SKIP_COUNT);
  });

  test('fails before starting another file on the first nonzero process', async () => {
    const calls: string[] = [];
    const allowed = resolveAllowedSkips(closedGates);
    const files = ['alpha.test.ts', ...allowed.keys(), 'broken.test.ts', 'never.test.ts'];

    await expect(
      runFilesSerially(
        files,
        async (file) => {
          calls.push(file);
          const skipped = allowed.get(file) ?? 0;
          return {
            exitCode: file === 'broken.test.ts' ? 9 : 0,
            junit: junit(file, Math.max(1, skipped), skipped),
          };
        },
        allowed,
      ),
    ).rejects.toThrow(`broken.test.ts exited 9 after 13/${files.length} files`);
    expect(calls).toEqual(files.slice(0, -1));
  });

  test('rejects duplicate files and every unapproved or drifted skip', async () => {
    const allowed = resolveAllowedSkips(closedGates);
    const duplicateCalls: string[] = [];
    await expect(
      runFilesSerially(
        terminalFiles('same.test.ts', 'same.test.ts'),
        async (file) => {
          duplicateCalls.push(file);
          return { exitCode: 0, junit: junit(file) };
        },
        allowed,
      ),
    ).rejects.toThrow('duplicate test file same.test.ts');
    expect(duplicateCalls).toEqual([]);

    await expect(
      runFilesSerially(
        terminalFiles('ordinary.test.ts'),
        async (file) => {
          const skipped = file === 'ordinary.test.ts' ? 1 : (allowed.get(file) ?? 0);
          return { exitCode: 0, junit: junit(file, Math.max(1, skipped), skipped) };
        },
        allowed,
      ),
    ).rejects.toThrow('ordinary.test.ts reported 1 skipped tests; expected 0');

    const liveFile = 'packages/core/tests/verify/live-e2e.test.ts';
    await expect(
      runFilesSerially(
        terminalFiles(),
        async (file) => {
          const skipped = file === liveFile ? 10 : (allowed.get(file) ?? 0);
          return { exitCode: 0, junit: junit(file, Math.max(1, skipped), skipped) };
        },
        allowed,
      ),
    ).rejects.toThrow(`${liveFile} reported 10 skipped tests; expected 11`);

    await expect(
      runFilesSerially(
        terminalFiles(),
        async (file) => {
          const skipped =
            file === ENV_STRACE_SKIP_FILE ? ENV_STRACE_SKIP_COUNT - 1 : (allowed.get(file) ?? 0);
          return { exitCode: 0, junit: junit(file, Math.max(1, skipped), skipped) };
        },
        allowed,
      ),
    ).rejects.toThrow(
      `${ENV_STRACE_SKIP_FILE} reported ${ENV_STRACE_SKIP_COUNT - 1} skipped tests; expected ${ENV_STRACE_SKIP_COUNT}`,
    );

    await expect(
      runFilesSerially(
        terminalFiles(),
        async (file) => {
          const skipped =
            file === ENV_EWP_SKIP_FILE ? ENV_EWP_SKIP_COUNT - 1 : (allowed.get(file) ?? 0);
          return { exitCode: 0, junit: junit(file, Math.max(1, skipped), skipped) };
        },
        allowed,
      ),
    ).rejects.toThrow(
      `${ENV_EWP_SKIP_FILE} reported ${ENV_EWP_SKIP_COUNT - 1} skipped tests; expected ${ENV_EWP_SKIP_COUNT}`,
    );
  });

  test('fails closed on missing or drifted allowlist closure', async () => {
    const allowed = resolveAllowedSkips(closedGates);
    const files = terminalFiles('ordinary.test.ts');
    const missing = files.filter(
      (file) => file !== 'packages/cli/tests/commands/verify-live.test.ts',
    );
    const calls: string[] = [];

    await expect(
      runFilesSerially(
        missing,
        async (file) => {
          calls.push(file);
          return { exitCode: 0, junit: junit(file) };
        },
        allowed,
      ),
    ).rejects.toThrow('test-file manifest is missing allowlisted file');
    expect(calls).toEqual([]);

    expect(() => validateTerminalManifest(files, new Map([...allowed].slice(1)))).toThrow(
      'skip allowlist has 10 files; expected 11',
    );
    expect(() =>
      validateTerminalManifest(
        files,
        new Map([...allowed].map(([file, count], index) => [file, count - Number(index === 0)])),
      ),
    ).toThrow(
      'live-E2E skip allowlist drifted for packages/core/tests/verify/live-e2e.test.ts: 10; expected 11',
    );
    const tamperedEnv = new Map(allowed);
    tamperedEnv.set(ENV_STRACE_SKIP_FILE, ENV_STRACE_SKIP_COUNT - 1);
    expect(() => validateTerminalManifest(files, tamperedEnv)).toThrow(
      `environment-gated skip entry drifted for ${ENV_STRACE_SKIP_FILE}: ${ENV_STRACE_SKIP_COUNT - 1}; expected 0 or ${ENV_STRACE_SKIP_COUNT}`,
    );
    const tamperedNative = new Map(allowed);
    tamperedNative.set(ENV_NATIVE_SKIP_FILE, ENV_NATIVE_SKIP_COUNT + 1);
    expect(() => validateTerminalManifest(files, tamperedNative)).toThrow(
      `environment-gated skip entry drifted for ${ENV_NATIVE_SKIP_FILE}: ${ENV_NATIVE_SKIP_COUNT + 1}; expected 0 or ${ENV_NATIVE_SKIP_COUNT}`,
    );
    const tamperedEwp = new Map(allowed);
    tamperedEwp.set(ENV_EWP_SKIP_FILE, ENV_EWP_SKIP_COUNT + 1);
    expect(() => validateTerminalManifest(files, tamperedEwp)).toThrow(
      `environment-gated skip entry drifted for ${ENV_EWP_SKIP_FILE}: ${ENV_EWP_SKIP_COUNT + 1}; expected 0 or ${ENV_EWP_SKIP_COUNT}`,
    );
  });

  test('creates symlink-free run roots for child TMPDIR', () => {
    const root = createRunRoot(tmpdir());
    temporaryDirectories.push(root);
    expect(readdirSync(root)).toEqual([]);
    expect(realpathSync(root)).toBe(root);
  });

  test('enforces the minimum Bun, cleanup, and post-run clean state', () => {
    expect(() => requireMinimumBunVersion(MINIMUM_BUN_VERSION)).not.toThrow();
    expect(() => requireMinimumBunVersion('1.3.15')).not.toThrow();
    expect(() => requireMinimumBunVersion('1.4.2')).not.toThrow();
    expect(() => requireMinimumBunVersion('1.3.13')).toThrow(
      'requires Bun 1.3.14 or newer; found 1.3.13',
    );

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
