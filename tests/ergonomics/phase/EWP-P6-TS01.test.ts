import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const RELEASE_SOURCE = join(ROOT, 'scripts', 'release-artifacts.ts');
const BUILD_SOURCE = join(ROOT, 'scripts', 'build-release.ts');
const GORELEASER_SOURCE = join(ROOT, '.goreleaser.yaml');
const FORMULA_SOURCE = join(ROOT, 'packaging', 'homebrew', 'skillsmith.rb.tmpl');
const LAUNCHER_SOURCE = join(ROOT, 'packaging', 'npm', 'bin', 'skillsmith.cjs');
const WORKFLOW_SOURCE = join(ROOT, '.github', 'workflows', 'ci.yml');
const MAX_NATIVE_BINARY_BYTES = 134_217_728;
const HEX_40 = 'a'.repeat(40);
const HEX_64 = 'b'.repeat(64);

type ReleaseTarget = Readonly<{
  id: string;
  bunTarget: string;
  goos: string;
  goarch: string;
  os: string;
  cpu: string;
  libc: 'glibc' | null;
}>;

type ArchiveEntry = Readonly<{
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'device';
  size: number;
  mode: string;
  owner?: string;
  group?: string;
}>;

type CandidateTarget = Readonly<{
  id: string;
  binaryPath: string;
  archivePath: string;
  npmPath: string;
  binarySha256: string;
  archiveSha256: string;
  npmBinarySha256: string;
}>;

type Candidate = Readonly<{
  outputRoot: string;
  version: string;
  sourceRevision: string;
  artifactsPath: string;
  metadataPath: string;
  checksumsPath: string;
  caskPath: string;
  launcherPath: string;
  targets: readonly CandidateTarget[];
}>;

type ReleaseArtifactsApi = Readonly<{
  RELEASE_TARGETS?: readonly ReleaseTarget[];
  RELEASE_TOOLCHAIN?: Readonly<{
    bun: string;
    goreleaser: string;
    npm: string;
    goreleaserAction: string;
  }>;
  MAX_NATIVE_BINARY_BYTES?: number;
  COMPLETION_PATHS?: Readonly<Record<string, string>>;
  FIXTURE_EXECUTABLES?: Readonly<
    Record<string, Readonly<{ bytes: Uint8Array; sha256: string; version: string }>>
  >;
  validateReleaseVersion?: (value: string) => string;
  assertReleaseToolVersions?: (input: Readonly<Record<string, string>>) => void;
  assertSourceRevision?: (value: string) => void;
  assertOwnedOutputRoot?: (
    input: Readonly<{
      outputRoot: string;
      stagingRoot: string;
      existingEntries: readonly string[];
    }>,
  ) => void;
  assertNativeBinarySize?: (value: number) => void;
  validateArchiveEntries?: (entries: readonly ArchiveEntry[]) => void;
  validateNpmPackageEntries?: (
    kind: 'launcher' | 'payload',
    entries: readonly Readonly<{ path: string; mode: string }>[],
  ) => void;
  validateGoreleaserInventory?: (input: unknown) => unknown;
  assertCompletionIdentity?: (input: Readonly<Record<string, Uint8Array>>) => void;
  assertSingleLineage?: (input: Readonly<Record<string, string>>) => void;
  createControlledBuildEnvironment?: (
    input: Readonly<{
      path: string;
      home: string;
      tmpdir: string;
      tag: string;
    }>,
  ) => Readonly<Record<string, string>>;
  assertNoReleaseLeaks?: (
    input: Readonly<{
      canaries: readonly string[];
      outputs: Readonly<Record<string, Uint8Array | string>>;
    }>,
  ) => void;
  deriveProductionCaskFixture?: (
    input: Readonly<{
      cask: string;
      origin: string;
    }>,
  ) => string;
  assertLifecycleCaskPair?: (
    input: Readonly<{
      first: string;
      second: string;
      firstVersion: string;
      secondVersion: string;
    }>,
  ) => void;
  buildReleaseCandidate?: (input: unknown) => Promise<Candidate>;
  installDirectArchive?: (
    input: Readonly<{ archivePath: string; prefix: string }>,
  ) => Promise<Readonly<Record<'binary' | 'bash' | 'zsh' | 'fish', string>>>;
  uninstallDirectArchive?: (input: Readonly<{ prefix: string }>) => Promise<void>;
}>;

const EXPECTED_TARGETS = [
  {
    id: 'darwin-arm64',
    bunTarget: 'bun-darwin-arm64',
    goos: 'darwin',
    goarch: 'arm64',
    os: 'darwin',
    cpu: 'arm64',
    libc: null,
  },
  {
    id: 'darwin-x64',
    bunTarget: 'bun-darwin-x64',
    goos: 'darwin',
    goarch: 'amd64',
    os: 'darwin',
    cpu: 'x64',
    libc: null,
  },
  {
    id: 'linux-arm64',
    bunTarget: 'bun-linux-arm64',
    goos: 'linux',
    goarch: 'arm64',
    os: 'linux',
    cpu: 'arm64',
    libc: 'glibc',
  },
  {
    id: 'linux-x64',
    bunTarget: 'bun-linux-x64',
    goos: 'linux',
    goarch: 'amd64',
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
  },
] as const;

const EXPECTED_COMPLETIONS = {
  bash: {
    path: 'completions/skillsmith.bash',
    bytes: 2610,
    sha256: '11d3b601826f9a7545fae067411a6396d673e106566004a881e3c6537bcbe680',
  },
  zsh: {
    path: 'completions/_skillsmith',
    bytes: 7729,
    sha256: '0e02eef39059285743b1eeea59cf720092a69a616ee8556360d3d4c366ffad7a',
  },
  fish: {
    path: 'completions/skillsmith.fish',
    bytes: 9200,
    sha256: '11f7d19361766a447436dd9260c543420b43f7f0342bb102a96c73423a36af1b',
  },
} as const;

const EXPECTED_ARCHIVE_ENTRIES: readonly ArchiveEntry[] = [
  { path: 'LICENSE', type: 'file', size: 1, mode: '0644', owner: 'root', group: 'root' },
  {
    path: 'completions/_skillsmith',
    type: 'file',
    size: 1,
    mode: '0644',
    owner: 'root',
    group: 'root',
  },
  {
    path: 'completions/skillsmith.bash',
    type: 'file',
    size: 1,
    mode: '0644',
    owner: 'root',
    group: 'root',
  },
  {
    path: 'completions/skillsmith.fish',
    type: 'file',
    size: 1,
    mode: '0644',
    owner: 'root',
    group: 'root',
  },
  { path: 'skillsmith', type: 'file', size: 1, mode: '0755', owner: 'root', group: 'root' },
];

const EXPECTED_LAUNCHER_ENTRIES = [
  { path: 'package/LICENSE', mode: '0644' },
  { path: 'package/README.md', mode: '0644' },
  { path: 'package/bin/skillsmith.cjs', mode: '0755' },
  { path: 'package/package.json', mode: '0644' },
  { path: 'package/share/completions/_skillsmith', mode: '0644' },
  { path: 'package/share/completions/skillsmith.bash', mode: '0644' },
  { path: 'package/share/completions/skillsmith.fish', mode: '0644' },
] as const;

const EXPECTED_PAYLOAD_ENTRIES = [
  { path: 'package/LICENSE', mode: '0644' },
  { path: 'package/README.md', mode: '0644' },
  { path: 'package/bin/skillsmith', mode: '0755' },
  { path: 'package/package.json', mode: '0644' },
] as const;

const temporaryRoots: string[] = [];
afterAll(async () => {
  await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true })));
});

const api = async (): Promise<ReleaseArtifactsApi> =>
  (await import('../../../scripts/release-artifacts.ts')) as ReleaseArtifactsApi;

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

const pathExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

const runCli = (args: readonly string[]) =>
  Bun.spawnSync(['bun', 'run', 'packages/cli/src/index.ts', ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

const hostTargetId = (): string => {
  const key = `${process.platform}-${process.arch}`;
  const target = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux-x64',
  }[key];
  if (target === undefined) throw new Error(`unsupported test host: ${key}`);
  return target;
};

let candidatePromise: Promise<Candidate> | undefined;
const getCandidate = async (): Promise<Candidate> => {
  if (candidatePromise === undefined) {
    candidatePromise = (async () => {
      const release = await api();
      expect(typeof release.buildReleaseCandidate).toBe('function');
      if (release.buildReleaseCandidate === undefined) {
        throw new Error('standard GoReleaser candidate builder is absent');
      }
      const root = await mkdtemp(join(tmpdir(), 'skillsmith-g6-standard-candidate-'));
      temporaryRoots.push(root);
      const outputRoot = join(root, 'candidate');
      const version = String((await readJson(join(ROOT, 'package.json'))).version);
      const revision = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(revision.exitCode).toBe(0);
      return release.buildReleaseCandidate({
        repositoryRoot: ROOT,
        stagingRoot: root,
        outputRoot,
        version,
        sourceRevision: revision.stdout.toString().trim(),
        target: 'all',
      });
    })();
  }
  return candidatePromise;
};

const packageManifestPaths = Object.fromEntries(
  ['launcher', ...EXPECTED_TARGETS.map(({ id }) => id)].map((id) => [
    id,
    id === 'launcher'
      ? join(ROOT, 'packaging', 'npm', 'package.json')
      : join(ROOT, 'packaging', 'npm', 'platform', id, 'package.json'),
  ]),
);

describe('EWP-P6-TS01', () => {
  test('family 1: exact Bun, GoReleaser, archive, and npm target mapping', async () => {
    const release = await api();
    expect(release.RELEASE_TARGETS).toEqual(EXPECTED_TARGETS);

    const config = await readFile(GORELEASER_SOURCE, 'utf8');
    expect(config).toContain('builder: bun');
    for (const target of EXPECTED_TARGETS) {
      expect(config, target.id).toContain(`- ${target.bunTarget.slice(4)}`);
      const manifest = await readJson(String(packageManifestPaths[target.id]));
      expect(manifest.name).toBe(`@smorinlabs/skillsmith-${target.id}`);
      expect(manifest.version).toBe('0.0.0');
      expect(manifest.os).toEqual([target.os]);
      expect(manifest.cpu).toEqual([target.cpu]);
      expect(manifest.libc).toEqual(target.libc === null ? undefined : [target.libc]);
    }
    expect(config).toContain('skillsmith-v{{ .Version }}-{{ .Os }}-{{ .Arch }}');
  });

  test('family 2: fail-closed version, tool, revision, output, and size validation', async () => {
    const release = await api();
    expect(release.RELEASE_TOOLCHAIN).toEqual({
      bun: '1.3.14',
      goreleaser: '2.17.1',
      npm: '12.0.1',
      goreleaserAction: 'f06c13b6b1a9625abc9e6e439d9c05a8f2190e94',
    });
    expect(typeof release.assertReleaseToolVersions).toBe('function');
    expect(typeof release.assertSourceRevision).toBe('function');
    expect(typeof release.validateReleaseVersion).toBe('function');
    expect(typeof release.assertOwnedOutputRoot).toBe('function');
    expect(typeof release.assertNativeBinarySize).toBe('function');
    if (
      release.assertReleaseToolVersions === undefined ||
      release.assertSourceRevision === undefined ||
      release.validateReleaseVersion === undefined ||
      release.assertOwnedOutputRoot === undefined ||
      release.assertNativeBinarySize === undefined
    ) {
      return;
    }

    expect(release.validateReleaseVersion('1.2.3')).toBe('1.2.3');
    for (const invalid of ['', 'v1.2.3', '1.2', '../1.2.3', '1.2.3\n']) {
      expect(() => release.validateReleaseVersion?.(invalid), invalid).toThrow();
    }
    expect(() => release.assertSourceRevision?.(HEX_40)).not.toThrow();
    expect(() => release.assertSourceRevision?.('HEAD')).toThrow();
    expect(() =>
      release.assertReleaseToolVersions?.({ bun: '1.3.14', goreleaser: '2.17.1', npm: '12.0.1' }),
    ).not.toThrow();
    expect(() =>
      release.assertReleaseToolVersions?.({ bun: '1.3.14', goreleaser: '2.17.0', npm: '12.0.1' }),
    ).toThrow();
    expect(() =>
      release.assertOwnedOutputRoot?.({
        outputRoot: '/tmp/owned/candidate',
        stagingRoot: '/tmp/owned',
        existingEntries: [],
      }),
    ).not.toThrow();
    expect(() =>
      release.assertOwnedOutputRoot?.({
        outputRoot: '/tmp/outside',
        stagingRoot: '/tmp/owned',
        existingEntries: [],
      }),
    ).toThrow();
    expect(() =>
      release.assertOwnedOutputRoot?.({
        outputRoot: '/tmp/owned/candidate',
        stagingRoot: '/tmp/owned',
        existingEntries: ['occupied'],
      }),
    ).toThrow();
    expect(release.MAX_NATIVE_BINARY_BYTES).toBe(MAX_NATIVE_BINARY_BYTES);
    expect(() => release.assertNativeBinarySize?.(MAX_NATIVE_BINARY_BYTES - 1)).not.toThrow();
    expect(() => release.assertNativeBinarySize?.(MAX_NATIVE_BINARY_BYTES)).toThrow();
    expect(() => release.assertNativeBinarySize?.(MAX_NATIVE_BINARY_BYTES + 1)).toThrow();
  });

  test('family 3: standard GoReleaser inventory, four checksums, and no custom artifact graph', async () => {
    const releaseSource = await readFile(RELEASE_SOURCE, 'utf8');
    expect(releaseSource).not.toContain('renderReleaseManifest');
    expect(releaseSource).not.toContain('renderSha256Sums');
    expect(releaseSource).not.toContain('renderHomebrewFormula');
    expect(await pathExists(FORMULA_SOURCE)).toBeFalse();

    const release = await api();
    expect(typeof release.validateGoreleaserInventory).toBe('function');
    const candidate = await getCandidate();
    expect(await pathExists(candidate.artifactsPath)).toBeTrue();
    expect(await pathExists(candidate.metadataPath)).toBeTrue();
    expect(await pathExists(candidate.checksumsPath)).toBeTrue();
    expect(await pathExists(join(candidate.outputRoot, 'release-manifest.json'))).toBeFalse();
    const sums = (await readFile(candidate.checksumsPath, 'utf8')).trimEnd().split('\n');
    expect(sums).toHaveLength(4);
    expect(sums).toEqual(sums.toSorted());
    expect(
      sums.every((line) => /^[0-9a-f]{64} {2}skillsmith-v.+\.tar\.gz$/u.test(line)),
    ).toBeTrue();
    release.validateGoreleaserInventory?.(
      JSON.parse(await readFile(candidate.artifactsPath, 'utf8')),
    );
  });

  test('family 4: signed completions, order-independent closed archives, and safe extraction', async () => {
    const release = await api();
    expect(release.COMPLETION_PATHS).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED_COMPLETIONS).map(([shell, value]) => [shell, value.path]),
      ),
    );
    expect(typeof release.validateArchiveEntries).toBe('function');
    expect(typeof release.assertCompletionIdentity).toBe('function');
    if (release.validateArchiveEntries === undefined) return;

    expect(() => release.validateArchiveEntries?.(EXPECTED_ARCHIVE_ENTRIES)).not.toThrow();
    expect(() =>
      release.validateArchiveEntries?.(EXPECTED_ARCHIVE_ENTRIES.toReversed()),
    ).not.toThrow();
    for (const hostile of [
      { path: '../escape', type: 'file', size: 1, mode: '0644' },
      { path: '/absolute', type: 'file', size: 1, mode: '0644' },
      { path: 'skillsmith', type: 'symlink', size: 1, mode: '0755' },
      { path: 'device', type: 'device', size: 1, mode: '0644' },
      { path: 'extra', type: 'file', size: 1, mode: '0644' },
    ] as const) {
      expect(() =>
        release.validateArchiveEntries?.([...EXPECTED_ARCHIVE_ENTRIES, hostile]),
      ).toThrow();
    }

    const observed: Record<string, Uint8Array> = {};
    for (const [shell, expected] of Object.entries(EXPECTED_COMPLETIONS)) {
      const child = runCli(['completion', shell]);
      expect(child.exitCode, shell).toBe(0);
      expect(child.stderr.toString(), shell).toBe('');
      expect(child.stdout.byteLength, shell).toBe(expected.bytes);
      expect(sha256(child.stdout), shell).toBe(expected.sha256);
      observed[shell] = child.stdout;
    }
    release.assertCompletionIdentity?.(observed);
  });

  test('family 5: GoReleaser compiles once per target and fans out identical candidate bytes', async () => {
    const buildSource = await readFile(BUILD_SOURCE, 'utf8');
    expect(buildSource).toContain('goreleaser');
    expect(buildSource).toContain('release');
    expect(buildSource).toContain('--snapshot');
    expect(buildSource).toContain('--clean');
    expect(buildSource).not.toMatch(
      /Bun\.spawn(?:Sync)?\(\s*\[\s*['"]bun['"]\s*,\s*['"]build['"]/u,
    );

    const candidate = await getCandidate();
    const rootVersion = String((await readJson(join(ROOT, 'package.json'))).version);
    expect(candidate.version).toBe(rootVersion);
    expect(candidate.sourceRevision).toMatch(/^[0-9a-f]{40}$/u);
    expect(candidate.targets.map(({ id }) => id)).toEqual(EXPECTED_TARGETS.map(({ id }) => id));
    for (const target of candidate.targets) {
      expect(await pathExists(target.binaryPath), target.id).toBeTrue();
      expect(await pathExists(target.archivePath), target.id).toBeTrue();
      expect(await pathExists(target.npmPath), target.id).toBeTrue();
      expect(target.binarySha256, target.id).toBe(target.npmBinarySha256);
      expect(target.binarySha256, target.id).toMatch(/^[0-9a-f]{64}$/u);
      expect((await stat(target.binaryPath)).size, target.id).toBeLessThan(MAX_NATIVE_BINARY_BYTES);
    }

    const host = candidate.targets.find(({ id }) => id === hostTargetId());
    expect(host).toBeDefined();
    const release = await api();
    expect(typeof release.installDirectArchive).toBe('function');
    expect(typeof release.uninstallDirectArchive).toBe('function');
    if (
      host === undefined ||
      release.installDirectArchive === undefined ||
      release.uninstallDirectArchive === undefined
    ) {
      return;
    }
    const prefix = await mkdtemp(join(tmpdir(), 'skillsmith-g6-direct-install-'));
    temporaryRoots.push(prefix);
    const installed = await release.installDirectArchive({
      archivePath: host.archivePath,
      prefix,
    });
    const execution = Bun.spawnSync([installed.binary, 'version'], {
      cwd: prefix,
      env: { PATH: '/usr/bin:/bin', HOME: prefix, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(execution.exitCode, execution.stderr.toString()).toBe(0);
    expect(execution.stdout.toString().trim()).toBe(candidate.version);
    await release.uninstallDirectArchive({ prefix });
    for (const path of Object.values(installed)) expect(await pathExists(path)).toBeFalse();
  });

  test('family 6: five tracked script-free packages and exact npm/Bun launcher behavior', async () => {
    const launcherManifest = await readJson(String(packageManifestPaths.launcher));
    expect(launcherManifest.name).toBe('@smorinlabs/skillsmith');
    expect(launcherManifest.version).toBe('0.0.0');
    expect(launcherManifest.bin).toEqual({ skillsmith: 'bin/skillsmith.cjs' });
    expect(launcherManifest.scripts).toBeUndefined();
    const optional = launcherManifest.optionalDependencies as Record<string, string>;
    expect(Object.keys(optional ?? {}).toSorted()).toEqual(
      EXPECTED_TARGETS.map(({ id }) => `@smorinlabs/skillsmith-${id}`).toSorted(),
    );
    expect(new Set(Object.values(optional ?? {}))).toEqual(new Set(['0.0.0']));

    const launcher = await readFile(LAUNCHER_SOURCE, 'utf8');
    const lines = launcher.split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[1]).toBe(
      '\':\' //; runtime="$(command -v bun 2>/dev/null || command -v node 2>/dev/null)" || { echo "skillsmith requires Bun or Node.js" >&2; exit 1; }',
    );
    expect(lines[2]).toBe('\':\' //; exec "$runtime" "$0" "$@"');
    expect(launcher).not.toMatch(/postinstall|https?:\/\//u);

    const release = await api();
    expect(typeof release.validateNpmPackageEntries).toBe('function');
    release.validateNpmPackageEntries?.('launcher', EXPECTED_LAUNCHER_ENTRIES);
    release.validateNpmPackageEntries?.('payload', EXPECTED_PAYLOAD_ENTRIES);
    expect(() =>
      release.validateNpmPackageEntries?.('payload', [
        ...EXPECTED_PAYLOAD_ENTRIES,
        { path: 'package/postinstall.js', mode: '0644' },
      ]),
    ).toThrow();

    const root = await mkdtemp(join(tmpdir(), 'skillsmith-g6-launcher-runtime-'));
    temporaryRoots.push(root);
    const probe = join(root, 'skillsmith.cjs');
    await writeFile(probe, launcher, { mode: 0o755 });
    await chmod(probe, 0o755);
    for (const runtime of ['node', 'bun']) {
      const child = Bun.spawnSync([runtime, probe, 'version'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(child.stderr.toString(), runtime).not.toContain('SyntaxError');
      expect(child.exitCode, runtime).toBe(1);
      expect(child.stderr.toString(), runtime).toContain(
        `@smorinlabs/skillsmith-${hostTargetId()}`,
      );
    }
  });

  test('family 7: generated binary cask, bounded loopback derivation, and no bypass', async () => {
    const config = await readFile(GORELEASER_SOURCE, 'utf8');
    expect(config).toContain('homebrew_casks:');
    expect(config).not.toContain('brews:');
    const release = await api();
    expect(typeof release.deriveProductionCaskFixture).toBe('function');
    const candidate = await getCandidate();
    const cask = await readFile(candidate.caskPath, 'utf8');
    expect(cask).toContain('cask "skillsmith"');
    expect(cask).toContain('binary "skillsmith"');
    expect(cask).toContain('bash_completion');
    expect(cask).toContain('zsh_completion');
    expect(cask).toContain('fish_completion');
    expect(cask).not.toMatch(/preflight|postflight|xattr|quarantine|curl|system\s+["']sh/u);
    for (const target of EXPECTED_TARGETS) {
      expect(cask, target.id).toContain(`skillsmith-v${candidate.version}-${target.id}.tar.gz`);
    }
    const fixture = release.deriveProductionCaskFixture?.({
      cask,
      origin: 'http://127.0.0.1:43117',
    });
    expect(fixture).toContain('http://127.0.0.1:43117');
    expect(cask).not.toContain('127.0.0.1');
  });

  test('family 8: controlled credential-free environment, canary refusal, and honest cache claims', async () => {
    const release = await api();
    expect(typeof release.createControlledBuildEnvironment).toBe('function');
    expect(typeof release.assertNoReleaseLeaks).toBe('function');
    if (
      release.createControlledBuildEnvironment === undefined ||
      release.assertNoReleaseLeaks === undefined
    ) {
      return;
    }
    expect(
      release.createControlledBuildEnvironment({
        path: '/tools',
        home: '/isolated/home',
        tmpdir: '/isolated/tmp',
        tag: 'v1.2.3',
      }),
    ).toEqual({
      PATH: '/tools',
      HOME: '/isolated/home',
      TMPDIR: '/isolated/tmp',
      XDG_CONFIG_HOME: '/isolated/home/config',
      XDG_CACHE_HOME: '/isolated/home/cache',
      XDG_DATA_HOME: '/isolated/home/data',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      NO_COLOR: '1',
      GORELEASER_CURRENT_TAG: 'v1.2.3',
    });
    expect(() =>
      release.assertNoReleaseLeaks?.({
        canaries: ['credential-canary', 'dotenv-canary', 'bunfig-canary'],
        outputs: { log: 'safe', metadata: HEX_40 },
      }),
    ).not.toThrow();
    expect(() =>
      release.assertNoReleaseLeaks?.({
        canaries: ['credential-canary'],
        outputs: { archive: 'unsafe credential-canary value' },
      }),
    ).toThrow();
    const buildSource = await readFile(BUILD_SOURCE, 'utf8');
    expect(buildSource).toContain('--env=disable');
    expect(buildSource).toContain('--no-compile-autoload-dotenv');
    expect(buildSource).toContain('--no-compile-autoload-bunfig');
    expect(buildSource).not.toMatch(/hermetic|network-free/iu);
    expect(buildSource).not.toContain('canaries: [secretCanary, ROOT]');
  });

  test('family 9: immutable two-version fixtures and separately bounded cask upgrade lineage', async () => {
    const release = await api();
    expect(Object.keys(release.FIXTURE_EXECUTABLES ?? {}).toSorted()).toEqual([
      '0.0.0-g6-fixture.1',
      '0.0.0-g6-fixture.2',
    ]);
    const first = release.FIXTURE_EXECUTABLES?.['0.0.0-g6-fixture.1'];
    const second = release.FIXTURE_EXECUTABLES?.['0.0.0-g6-fixture.2'];
    expect(first?.sha256).toBe('d2e29c65bd9afe1235f3105cbe297bd84c564a9c0026cc6320f059cd987797a6');
    expect(second?.sha256).toBe('70f27666626752210b31be697cd63ff6554a6342936ea2ca435e1c5d53c7c3e9');
    expect(first === undefined ? '' : sha256(first.bytes)).toBe(first?.sha256);
    expect(second === undefined ? '' : sha256(second.bytes)).toBe(second?.sha256);
    expect(first?.sha256).not.toBe(second?.sha256);
    expect(typeof release.assertLifecycleCaskPair).toBe('function');
    release.assertLifecycleCaskPair?.({
      first: `version "0.0.0-g6-fixture.1"\nurl "http://127.0.0.1/one.tar.gz"\nsha256 "${HEX_64}"\n`,
      second: `version "0.0.0-g6-fixture.2"\nurl "http://127.0.0.1/two.tar.gz"\nsha256 "${'c'.repeat(64)}"\n`,
      firstVersion: '0.0.0-g6-fixture.1',
      secondVersion: '0.0.0-g6-fixture.2',
    });
    expect(() =>
      release.assertLifecycleCaskPair?.({
        first: 'version "0.0.0-g6-fixture.1"\nbinary "skillsmith"\n',
        second: 'version "0.0.0-g6-fixture.2"\nbinary "other"\n',
        firstVersion: '0.0.0-g6-fixture.1',
        secondVersion: '0.0.0-g6-fixture.2',
      }),
    ).toThrow();
  });

  test('family 10: truthful guidance, immutable tracked manifests, and no premature publication', async () => {
    const trackedBefore = await Promise.all(
      Object.values(packageManifestPaths).map((path) => readFile(String(path))),
    );
    const [readme, releases, packaging, packageSource, workflow, releaseSource] = await Promise.all(
      [
        readFile(join(ROOT, 'README.md'), 'utf8'),
        readFile(join(ROOT, 'docs', 'releases.md'), 'utf8'),
        readFile(join(ROOT, 'packaging', 'README.md'), 'utf8'),
        readFile(join(ROOT, 'package.json'), 'utf8'),
        readFile(WORKFLOW_SOURCE, 'utf8'),
        readFile(RELEASE_SOURCE, 'utf8'),
      ],
    );
    const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> };

    expect(readme).toContain('@smorinlabs/skillsmith');
    expect(readme).toContain('smorinlabs/tap/skillsmith');
    expect(readme).toMatch(/not yet published|public availability.*G6-04/iu);
    expect(releases).toContain('GoReleaser');
    expect(releases).toContain('SHA256SUMS');
    expect(releases).not.toContain('release-manifest.json');
    expect(packaging).toContain('Homebrew cask');
    expect(packaging).not.toContain('formula');
    expect(packageJson.scripts?.['build:release']).toBe(
      'bun scripts/build-release.ts --target all',
    );
    expect(releaseSource).not.toContain('mapping placeholder');
    expect(workflow).toContain(
      'goreleaser/goreleaser-action@f06c13b6b1a9625abc9e6e439d9c05a8f2190e94',
    );
    expect(workflow).toContain('version: v2.17.1');
    expect(workflow).toContain('install-only: true');
    expect(workflow).not.toMatch(/npm publish|gh release upload|attest-build-provenance|TAP_/u);
    expect(`${readme}\n${releases}\n${packaging}`).not.toMatch(/curl[^\n]*\|[^\n]*(?:sh|bash)/iu);

    const output = await mkdtemp(join(tmpdir(), 'skillsmith-g6-occupied-'));
    temporaryRoots.push(output);
    await writeFile(join(output, 'occupied'), 'refuse overwrite\n');
    const release = await api();
    expect(() =>
      release.assertOwnedOutputRoot?.({
        outputRoot: output,
        stagingRoot: dirname(output),
        existingEntries: ['occupied'],
      }),
    ).toThrow();
    const trackedAfter = await Promise.all(
      Object.values(packageManifestPaths).map((path) => readFile(String(path))),
    );
    expect(trackedAfter).toEqual(trackedBefore);
    expect((await readdir(output)).toSorted()).toEqual(['occupied']);
  });
});
