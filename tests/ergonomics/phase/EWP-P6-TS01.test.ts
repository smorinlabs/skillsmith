import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const RELEASE_SOURCE = join(ROOT, 'scripts', 'release-artifacts.ts');
const BUILD_SOURCE = join(ROOT, 'scripts', 'build-release.ts');
const LAUNCHER_SOURCE = join(ROOT, 'packaging', 'npm', 'bin', 'skillsmith.cjs');
const FORMULA_SOURCE = join(ROOT, 'packaging', 'homebrew', 'skillsmith.rb.tmpl');
const WORKFLOW_SOURCE = join(ROOT, '.github', 'workflows', 'ci.yml');
const HEX_40 = 'a'.repeat(40);
const HEX_64 = 'b'.repeat(64);
const MAX_NATIVE_BINARY_BYTES = 134_217_728;

type ReleaseTarget = Readonly<{
  id: string;
  bunTarget: string;
  os: string;
  cpu: string;
  libc: 'glibc' | null;
}>;

type ArchiveEntry = Readonly<{
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'device';
  size: number;
  mode: string;
}>;

type ReleaseArtifactsApi = Readonly<{
  RELEASE_TARGETS?: readonly ReleaseTarget[];
  MAX_NATIVE_BINARY_BYTES?: number;
  COMPLETION_PATHS?: Readonly<Record<string, string>>;
  FIXTURE_EXECUTABLES?: Readonly<
    Record<string, Readonly<{ bytes: Uint8Array; sha256: string; version: string }>>
  >;
  releaseArtifactNames?: (version: string) => unknown;
  validateReleaseVersion?: (version: string) => string;
  assertOwnedOutputRoot?: (
    input: Readonly<{
      outputRoot: string;
      stagingRoot: string;
      existingEntries: readonly string[];
    }>,
  ) => void;
  validateArchiveEntries?: (entries: readonly ArchiveEntry[]) => void;
  renderReleaseManifest?: (input: unknown) => string;
  renderSha256Sums?: (entries: Readonly<Record<string, string>>) => string;
  assertSingleLineage?: (input: Readonly<Record<string, string>>) => void;
  assertCompletionIdentity?: (input: Readonly<Record<string, Uint8Array>>) => void;
  buildReleaseCandidate?: (input: unknown) => Promise<unknown>;
  installDirectArchive?: (input: unknown) => Promise<unknown>;
  uninstallDirectArchive?: (input: unknown) => Promise<unknown>;
  renderLauncherPackageJson?: (version: string) => unknown;
  renderPayloadPackageJson?: (target: string, version: string) => unknown;
  renderHomebrewFormula?: (input: unknown) => string;
  createHermeticBuildEnvironment?: (
    input: Readonly<{
      path: string;
      home: string;
      tmpdir: string;
    }>,
  ) => Readonly<Record<string, string>>;
  assertNoReleaseLeaks?: (
    input: Readonly<{
      canaries: readonly string[];
      outputs: Readonly<Record<string, Uint8Array | string>>;
    }>,
  ) => void;
  assertNativeBinarySize?: (bytes: number) => void;
}>;

const EXPECTED_TARGETS = [
  {
    id: 'darwin-arm64',
    bunTarget: 'bun-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    libc: null,
  },
  {
    id: 'darwin-x64',
    bunTarget: 'bun-darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    libc: null,
  },
  {
    id: 'linux-arm64',
    bunTarget: 'bun-linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    libc: 'glibc',
  },
  {
    id: 'linux-x64',
    bunTarget: 'bun-linux-x64',
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
  },
] as const;

const EXPECTED_ARCHIVE_ENTRIES: readonly ArchiveEntry[] = [
  { path: 'skillsmith', type: 'file', size: 1, mode: '0755' },
  { path: 'LICENSE', type: 'file', size: 1, mode: '0644' },
  { path: 'completions/skillsmith.bash', type: 'file', size: 1, mode: '0644' },
  { path: 'completions/_skillsmith', type: 'file', size: 1, mode: '0644' },
  { path: 'completions/skillsmith.fish', type: 'file', size: 1, mode: '0644' },
];

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

const fixtureSource = (version: string): string => `#!/bin/sh
if [ "\${1-}" = "version" ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
printf '%s\\n' 'G6 lifecycle fixture ${version}' >&2
exit 64
`;

const EXPECTED_FIXTURES = {
  '0.0.0-g6-fixture.1': 'd2e29c65bd9afe1235f3105cbe297bd84c564a9c0026cc6320f059cd987797a6',
  '0.0.0-g6-fixture.2': '70f27666626752210b31be697cd63ff6554a6342936ea2ca435e1c5d53c7c3e9',
} as const;

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

const releaseApi = async (): Promise<ReleaseArtifactsApi> =>
  (await import('../../../scripts/release-artifacts.ts')) as ReleaseArtifactsApi;

const runCli = (args: readonly string[]) =>
  Bun.spawnSync(['bun', 'run', 'packages/cli/src/index.ts', ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

describe('EWP-P6-TS01', () => {
  test('family 1: freezes the four targets, public artifact names, and package family', async () => {
    const api = await releaseApi();
    expect(api.RELEASE_TARGETS, 'the ordered release target matrix must be exported').toEqual(
      EXPECTED_TARGETS,
    );
    expect(typeof api.releaseArtifactNames).toBe('function');
    if (api.releaseArtifactNames === undefined) return;

    expect(api.releaseArtifactNames('1.2.3')).toEqual({
      archives: {
        'darwin-arm64': 'skillsmith-v1.2.3-darwin-arm64.tar.gz',
        'darwin-x64': 'skillsmith-v1.2.3-darwin-x64.tar.gz',
        'linux-arm64': 'skillsmith-v1.2.3-linux-arm64.tar.gz',
        'linux-x64': 'skillsmith-v1.2.3-linux-x64.tar.gz',
      },
      npmTarballs: {
        launcher: 'smorinlabs-skillsmith-1.2.3.tgz',
        'darwin-arm64': 'smorinlabs-skillsmith-darwin-arm64-1.2.3.tgz',
        'darwin-x64': 'smorinlabs-skillsmith-darwin-x64-1.2.3.tgz',
        'linux-arm64': 'smorinlabs-skillsmith-linux-arm64-1.2.3.tgz',
        'linux-x64': 'smorinlabs-skillsmith-linux-x64-1.2.3.tgz',
      },
      formula: 'skillsmith.rb',
      manifest: 'release-manifest.json',
      checksums: 'SHA256SUMS',
    });
  });

  test('family 2: fails closed on invalid versions, output roots, and hostile archives', async () => {
    const api = await releaseApi();
    expect(typeof api.validateReleaseVersion).toBe('function');
    expect(typeof api.assertOwnedOutputRoot).toBe('function');
    expect(typeof api.validateArchiveEntries).toBe('function');
    if (
      api.validateReleaseVersion === undefined ||
      api.assertOwnedOutputRoot === undefined ||
      api.validateArchiveEntries === undefined
    )
      return;

    expect(api.validateReleaseVersion('1.2.3')).toBe('1.2.3');
    for (const invalid of ['', 'v1.2.3', '1.2', '../1.2.3', '1.2.3\n']) {
      expect(() => api.validateReleaseVersion?.(invalid), invalid).toThrow();
    }
    expect(() =>
      api.assertOwnedOutputRoot?.({
        outputRoot: '/tmp/outside',
        stagingRoot: '/tmp/owned',
        existingEntries: [],
      }),
    ).toThrow();
    expect(() =>
      api.assertOwnedOutputRoot?.({
        outputRoot: '/tmp/owned/output',
        stagingRoot: '/tmp/owned',
        existingEntries: ['collision'],
      }),
    ).toThrow();
    expect(() => api.validateArchiveEntries?.(EXPECTED_ARCHIVE_ENTRIES)).not.toThrow();
    for (const hostile of [
      { path: '../escape', type: 'file', size: 1, mode: '0644' },
      { path: '/absolute', type: 'file', size: 1, mode: '0644' },
      { path: 'skillsmith', type: 'symlink', size: 1, mode: '0755' },
      { path: 'device', type: 'device', size: 1, mode: '0644' },
      { path: 'extra', type: 'file', size: 1, mode: '0644' },
    ] as const) {
      expect(() => api.validateArchiveEntries?.([...EXPECTED_ARCHIVE_ENTRIES, hostile])).toThrow();
    }
  });

  test('family 3: canonicalizes the manifest/checksums and enforces one binary lineage', async () => {
    const api = await releaseApi();
    expect(typeof api.renderReleaseManifest).toBe('function');
    expect(typeof api.renderSha256Sums).toBe('function');
    expect(typeof api.assertSingleLineage).toBe('function');
    if (api.renderSha256Sums === undefined || api.assertSingleLineage === undefined) return;

    const paths = [
      'skillsmith-v1.2.3-darwin-arm64.tar.gz',
      'skillsmith-v1.2.3-darwin-x64.tar.gz',
      'skillsmith-v1.2.3-linux-arm64.tar.gz',
      'skillsmith-v1.2.3-linux-x64.tar.gz',
      'smorinlabs-skillsmith-1.2.3.tgz',
      'smorinlabs-skillsmith-darwin-arm64-1.2.3.tgz',
      'smorinlabs-skillsmith-darwin-x64-1.2.3.tgz',
      'smorinlabs-skillsmith-linux-arm64-1.2.3.tgz',
      'smorinlabs-skillsmith-linux-x64-1.2.3.tgz',
      'skillsmith.rb',
      'release-manifest.json',
    ].sort();
    const entries = Object.fromEntries(paths.toReversed().map((path) => [path, HEX_64]));
    expect(api.renderSha256Sums(entries)).toBe(
      `${paths.map((path) => `${HEX_64}  ${path}`).join('\n')}\n`,
    );

    const lineage = {
      stagedBinary: HEX_64,
      archiveBinary: HEX_64,
      npmBinary: HEX_64,
      formulaArchive: HEX_64,
      manifestBinary: HEX_64,
      installedBinary: HEX_64,
    };
    expect(() => api.assertSingleLineage?.(lineage)).not.toThrow();
    expect(() => api.assertSingleLineage?.({ ...lineage, npmBinary: 'c'.repeat(64) })).toThrow();
  });

  test('family 4: packages the exact signed Bash, zsh, and Fish completion bytes', async () => {
    const observed: Record<string, Uint8Array> = {};
    for (const [shell, expected] of Object.entries(EXPECTED_COMPLETIONS)) {
      const child = runCli(['completion', shell]);
      expect(child.exitCode, shell).toBe(0);
      expect(child.stderr.toString(), shell).toBe('');
      const bytes = child.stdout;
      expect(bytes.byteLength, shell).toBe(expected.bytes);
      expect(sha256(bytes), shell).toBe(expected.sha256);
      observed[shell] = bytes;
    }

    const api = await releaseApi();
    expect(api.COMPLETION_PATHS).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED_COMPLETIONS).map(([shell, expected]) => [shell, expected.path]),
      ),
    );
    expect(typeof api.assertCompletionIdentity).toBe('function');
    api.assertCompletionIdentity?.(observed);
  });

  test('family 5: builds once and owns direct install, upgrade, execution, and uninstall', async () => {
    const api = await releaseApi();
    const buildSource = await readFile(BUILD_SOURCE, 'utf8');
    expect(buildSource).not.toContain('mapping placeholder');
    expect(typeof api.buildReleaseCandidate).toBe('function');
    expect(typeof api.installDirectArchive).toBe('function');
    expect(typeof api.uninstallDirectArchive).toBe('function');

    // The green implementation uses one memoized current-host build here for version/help/rendering/
    // completion and two immutable fixture candidates for install -> upgrade -> uninstall.
    expect(buildSource).toContain('--env=disable');
    expect(buildSource).toContain('--no-compile-autoload-dotenv');
    expect(buildSource).toContain('--no-compile-autoload-bunfig');
  });

  test('family 6: installs through npm without Bun and Bun without Node from loopback only', async () => {
    const api = await releaseApi();
    const launcher = await readFile(LAUNCHER_SOURCE, 'utf8');
    const lines = launcher.split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[1]).toBe(
      `':' //; runtime="$(command -v bun 2>/dev/null || command -v node 2>/dev/null)" || { echo "skillsmith requires Bun or Node.js" >&2; exit 1; }`,
    );
    expect(lines[2]).toBe(`':' //; exec "$runtime" "$0" "$@"`);
    expect(launcher).not.toMatch(/postinstall|https?:\/\//u);
    expect(typeof api.renderLauncherPackageJson).toBe('function');
    expect(typeof api.renderPayloadPackageJson).toBe('function');

    if (api.renderLauncherPackageJson !== undefined) {
      const metadata = api.renderLauncherPackageJson('1.2.3') as {
        name?: string;
        version?: string;
        optionalDependencies?: Record<string, string>;
        scripts?: unknown;
      };
      expect(metadata.name).toBe('@smorinlabs/skillsmith');
      expect(metadata.version).toBe('1.2.3');
      expect(Object.values(metadata.optionalDependencies ?? {})).toEqual(Array(4).fill('1.2.3'));
      expect(metadata.scripts).toBeUndefined();
    }

    const temporary = await mkdtemp(join(tmpdir(), 'skillsmith-g6-launcher-red-'));
    try {
      const probe = join(temporary, 'skillsmith.cjs');
      await Bun.write(probe, launcher);
      for (const runtime of ['node', 'bun']) {
        const child = Bun.spawnSync([runtime, probe, 'version'], {
          cwd: temporary,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(
          child.stderr.toString(),
          `${runtime} must parse the polyglot launcher`,
        ).not.toContain('SyntaxError');
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test('family 7: Homebrew supported-platform formula and receipt wiring are exact', async () => {
    const api = await releaseApi();
    const [formula, workflow] = await Promise.all([
      readFile(FORMULA_SOURCE, 'utf8'),
      readFile(WORKFLOW_SOURCE, 'utf8'),
    ]);
    expect(formula).toContain('class Skillsmith < Formula');
    expect(formula).toContain('bin.install "skillsmith"');
    expect(formula).toContain('bash_completion.install');
    expect(formula).toContain('zsh_completion.install');
    expect(formula).toContain('fish_completion.install');
    expect(typeof api.renderHomebrewFormula).toBe('function');
    expect(workflow).toContain('os: [macos-15, ubuntu-latest]');
    expect(workflow).toContain('P17 G6-01 Homebrew supported-platform receipt');
    expect(workflow).toContain("P17_G6_01_HOMEBREW_RECEIPT: '1'");
    expect(workflow).toContain('--timeout 300000');
    expect(workflow).toContain('--max-concurrency 1');
    expect(workflow).toContain('EWP-P6-TS01.*Homebrew supported-platform');

    if (process.env.P17_G6_01_HOMEBREW_RECEIPT === '1') {
      expect(process.env.RUNNER_OS).toBe('macOS');
      expect(process.platform).toBe('darwin');
      expect(process.arch).toBe('arm64');
      // The green receipt lane additionally audits, installs, tests, upgrades, and uninstalls the
      // loopback formula with zero skips, then prints the canonical single-line JSON receipt.
    }
  });

  test('family 8: scrubs build inputs, rejects leaks, and enforces the strict 128 MiB ceiling', async () => {
    const api = await releaseApi();
    expect(api.MAX_NATIVE_BINARY_BYTES).toBe(MAX_NATIVE_BINARY_BYTES);
    expect(typeof api.assertNativeBinarySize).toBe('function');
    expect(typeof api.createHermeticBuildEnvironment).toBe('function');
    expect(typeof api.assertNoReleaseLeaks).toBe('function');
    if (
      api.assertNativeBinarySize === undefined ||
      api.createHermeticBuildEnvironment === undefined ||
      api.assertNoReleaseLeaks === undefined
    )
      return;

    expect(() => api.assertNativeBinarySize?.(MAX_NATIVE_BINARY_BYTES - 1)).not.toThrow();
    expect(() => api.assertNativeBinarySize?.(MAX_NATIVE_BINARY_BYTES)).toThrow();
    expect(() => api.assertNativeBinarySize?.(MAX_NATIVE_BINARY_BYTES + 1)).toThrow();

    expect(
      api.createHermeticBuildEnvironment({
        path: '/tools',
        home: '/isolated/home',
        tmpdir: '/isolated/tmp',
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
    });
    expect(() =>
      api.assertNoReleaseLeaks?.({
        canaries: ['G6_SECRET_CANARY', '/absolute/repository/canary'],
        outputs: { manifest: `safe ${HEX_40}` },
      }),
    ).not.toThrow();
    expect(() =>
      api.assertNoReleaseLeaks?.({
        canaries: ['G6_SECRET_CANARY'],
        outputs: { log: 'prefix G6_SECRET_CANARY suffix' },
      }),
    ).toThrow();
  });

  test('family 9: separates the actual candidate from both immutable lifecycle fixtures', async () => {
    for (const [version, expectedHash] of Object.entries(EXPECTED_FIXTURES)) {
      const source = fixtureSource(version);
      expect(Buffer.byteLength(source), version).toBe(160);
      expect(sha256(source), version).toBe(expectedHash);
    }

    const api = await releaseApi();
    expect(Object.keys(api.FIXTURE_EXECUTABLES ?? {}).sort()).toEqual(
      Object.keys(EXPECTED_FIXTURES).sort(),
    );
    for (const [version, expectedHash] of Object.entries(EXPECTED_FIXTURES)) {
      const fixture = api.FIXTURE_EXECUTABLES?.[version];
      expect(fixture?.version).toBe(version);
      expect(fixture?.bytes.byteLength).toBe(160);
      expect(fixture?.sha256).toBe(expectedHash);
      expect(fixture === undefined ? '' : sha256(fixture.bytes)).toBe(expectedHash);
    }
  });

  test('family 10: keeps docs/package scripts truthful and refuses premature publication', async () => {
    const [readme, releases, packaging, packageSource, releaseSource] = await Promise.all([
      readFile(join(ROOT, 'README.md'), 'utf8'),
      readFile(join(ROOT, 'docs', 'releases.md'), 'utf8'),
      readFile(join(ROOT, 'packaging', 'README.md'), 'utf8'),
      readFile(join(ROOT, 'package.json'), 'utf8'),
      readFile(RELEASE_SOURCE, 'utf8'),
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> };

    expect(readme).toContain('@smorinlabs/skillsmith');
    expect(readme).toContain('smorinlabs/tap/skillsmith');
    expect(readme).toMatch(/not yet published|public availability.*G6-04/iu);
    expect(releases).toContain('release-manifest.json');
    expect(releases).toContain('SHA256SUMS');
    expect(packaging).not.toContain('mapping placeholder');
    expect(packageJson.scripts?.['build:release']).toBe(
      'bun scripts/build-release.ts --target all',
    );
    expect(releaseSource).not.toContain('mapping placeholder');
    expect(`${readme}\n${releases}\n${packaging}`).not.toMatch(/curl[^\n]*\|[^\n]*(?:sh|bash)/iu);
    expect(`${readme}\n${releases}`).not.toMatch(/(?:npm publish|brew tap-new|gh release upload)/u);
  });
});
