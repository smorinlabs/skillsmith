import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ArchiveEntry,
  COMPLETION_PATHS,
  FIXTURE_EXECUTABLES,
  MAX_NATIVE_BINARY_BYTES,
  RELEASE_TARGETS,
  RELEASE_TOOLCHAIN,
  assertLifecycleCaskPair,
  assertNativeBinarySize,
  assertNoReleaseLeaks,
  assertOwnedOutputRoot,
  assertReleaseToolVersions,
  assertSingleLineage,
  assertSourceRevision,
  createControlledBuildEnvironment,
  deriveProductionCaskFixture,
  installDirectArchive,
  releaseArtifactNames,
  resolveReleaseToolPath,
  validateArchiveEntries,
  validateGoreleaserInventory,
  validateNpmPackageEntries,
  validateReleaseVersion,
} from './release-artifacts.ts';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const directEntries: readonly ArchiveEntry[] = [
  { path: 'skillsmith', type: 'file', size: 42, mode: '0755', owner: 'root', group: 'root' },
  { path: 'LICENSE', type: 'file', size: 42, mode: '0644', owner: 'root', group: 'root' },
  {
    path: 'completions/skillsmith.bash',
    type: 'file',
    size: 42,
    mode: '0644',
    owner: 'root',
    group: 'root',
  },
  {
    path: 'completions/_skillsmith',
    type: 'file',
    size: 42,
    mode: '0644',
    owner: 'root',
    group: 'root',
  },
  {
    path: 'completions/skillsmith.fish',
    type: 'file',
    size: 42,
    mode: '0644',
    owner: 'root',
    group: 'root',
  },
];

const payloadEntries = [
  { path: 'package/package.json', mode: '0644' },
  { path: 'package/README.md', mode: '0644' },
  { path: 'package/LICENSE', mode: '0644' },
  { path: 'package/bin/skillsmith', mode: '0755' },
] as const;

describe('standard release artifact adapter', () => {
  test('freezes toolchain, target mapping, and standard version-derived names', () => {
    expect(RELEASE_TOOLCHAIN).toEqual({
      bun: '1.3.14',
      goreleaser: '2.17.1',
      npm: '12.0.1',
      goreleaserAction: 'f06c13b6b1a9625abc9e6e439d9c05a8f2190e94',
    });
    expect(RELEASE_TARGETS.map(({ id, goos, goarch }) => ({ id, goos, goarch }))).toEqual([
      { id: 'darwin-arm64', goos: 'darwin', goarch: 'arm64' },
      { id: 'darwin-x64', goos: 'darwin', goarch: 'amd64' },
      { id: 'linux-arm64', goos: 'linux', goarch: 'arm64' },
      { id: 'linux-x64', goos: 'linux', goarch: 'amd64' },
    ]);
    expect(validateReleaseVersion('1.2.3-rc.1+build.7')).toBe('1.2.3-rc.1+build.7');
    for (const invalid of ['', 'v1.2.3', '1.2', '01.2.3', '../1.2.3', '1.2.3\n']) {
      expect(() => validateReleaseVersion(invalid), invalid).toThrow();
    }
    expect(releaseArtifactNames('1.2.3')).toEqual({
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
      checksums: 'SHA256SUMS',
      artifacts: 'artifacts.json',
      metadata: 'metadata.json',
      cask: 'homebrew/Casks/skillsmith.rb',
    });
  });

  test('fails closed on tool, revision, output, and size drift', () => {
    expect(() =>
      assertReleaseToolVersions({ bun: '1.3.14', goreleaser: '2.17.1', npm: '12.0.1' }),
    ).not.toThrow();
    expect(() =>
      assertReleaseToolVersions({ bun: '1.3.14', goreleaser: '2.17.0', npm: '12.0.1' }),
    ).toThrow();
    expect(() => assertSourceRevision('a'.repeat(40))).not.toThrow();
    expect(() => assertSourceRevision('HEAD')).toThrow();
    expect(() =>
      assertOwnedOutputRoot({
        stagingRoot: '/tmp/release',
        outputRoot: '/tmp/release/candidate',
        existingEntries: [],
      }),
    ).not.toThrow();
    for (const outputRoot of ['/tmp/release', '/tmp/outside']) {
      expect(() =>
        assertOwnedOutputRoot({ stagingRoot: '/tmp/release', outputRoot, existingEntries: [] }),
      ).toThrow();
    }
    expect(() =>
      assertOwnedOutputRoot({
        stagingRoot: '/tmp/release',
        outputRoot: '/tmp/release/candidate',
        existingEntries: ['collision'],
      }),
    ).toThrow();
    expect(MAX_NATIVE_BINARY_BYTES).toBe(134_217_728);
    expect(() => assertNativeBinarySize(MAX_NATIVE_BINARY_BYTES - 1)).not.toThrow();
    expect(() => assertNativeBinarySize(MAX_NATIVE_BINARY_BYTES)).toThrow();
    expect(() => assertNativeBinarySize(MAX_NATIVE_BINARY_BYTES + 1)).toThrow();
    expect(
      resolveReleaseToolPath([
        '/Users/runner/.bun/bin/bun',
        '/Users/runner/hostedtoolcache/goreleaser/2.17.1/arm64/goreleaser',
        '/opt/homebrew/bin/npm',
        '/opt/homebrew/bin/node',
        '/opt/homebrew/bin/git',
        '/usr/bin/tar',
      ]),
    ).toBe(
      '/Users/runner/.bun/bin:/Users/runner/hostedtoolcache/goreleaser/2.17.1/arm64:/opt/homebrew/bin:/usr/bin:/bin',
    );
    expect(() => resolveReleaseToolPath([])).toThrow();
    expect(() => resolveReleaseToolPath(['goreleaser'])).toThrow();
  });

  test('accepts only order-independent closed archive and npm layouts', () => {
    expect(() => validateArchiveEntries(directEntries)).not.toThrow();
    expect(() => validateArchiveEntries(directEntries.toReversed())).not.toThrow();
    expect(() => validateNpmPackageEntries('payload', payloadEntries)).not.toThrow();
    for (const hostile of [
      directEntries.map((entry, index) =>
        index === 0 ? { ...entry, path: '../skillsmith' } : entry,
      ),
      directEntries.map((entry, index) =>
        index === 0 ? { ...entry, type: 'symlink' as const } : entry,
      ),
      directEntries.map((entry, index) => (index === 0 ? { ...entry, mode: '0644' } : entry)),
      [...directEntries, { path: 'extra', type: 'file' as const, size: 1, mode: '0644' }],
    ]) {
      expect(() => validateArchiveEntries(hostile)).toThrow();
    }
    expect(() =>
      validateNpmPackageEntries('payload', [
        ...payloadEntries.slice(0, 3),
        { path: 'package/bin/../escape', mode: '0755' },
      ]),
    ).toThrow();
  });

  test('normalizes the exact standard GoReleaser inventory', () => {
    const artifacts = [
      { type: 'Metadata', name: 'metadata.json', path: '/dist/metadata.json' },
      ...RELEASE_TARGETS.flatMap((target) => [
        {
          type: 'Binary',
          name: 'skillsmith',
          path: `/dist/${target.id}/skillsmith`,
          goos: target.goos,
          goarch: target.goarch,
        },
        {
          type: 'Archive',
          name: `skillsmith-v1.2.3-${target.id}.tar.gz`,
          path: `/dist/skillsmith-v1.2.3-${target.id}.tar.gz`,
          goos: target.goos,
          goarch: target.goarch,
        },
      ]),
      { type: 'Checksum', name: 'SHA256SUMS', path: '/dist/SHA256SUMS' },
      { type: 'Homebrew Cask', name: 'skillsmith.rb', path: '/dist/Casks/skillsmith.rb' },
    ];
    const inventory = validateGoreleaserInventory(artifacts);
    expect(inventory.binaries['linux-x64']).toBe('/dist/linux-x64/skillsmith');
    expect(inventory.archives['darwin-arm64']).toBe('/dist/skillsmith-v1.2.3-darwin-arm64.tar.gz');
    expect(inventory.checksumsPath).toBe('/dist/SHA256SUMS');
    expect(() => validateGoreleaserInventory([...artifacts, artifacts[0]])).toThrow();
  });

  test('derives only bounded production cask URLs and validates lifecycle diffs', () => {
    const branch = (target: string) =>
      `  sha256 "${SHA_A}"\n  url "https://github.com/smorinlabs/skillsmith/releases/download/v#{version}/skillsmith-v#{version}-${target}.tar.gz",\n    verified: "github.com/smorinlabs/skillsmith/"`;
    const production = `version "1.2.3"\n${['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(branch).join('\n')}`;
    const fixture = deriveProductionCaskFixture({
      cask: production,
      origin: 'http://127.0.0.1:12345/',
    });
    expect(fixture.match(/http:\/\/127\.0\.0\.1:12345/gu)).toHaveLength(4);
    expect(fixture).not.toContain('verified:');
    expect(production).toContain('github.com/smorinlabs/skillsmith/releases');

    const first = `version "0.0.0-g6-fixture.1"\nurl "http://127.0.0.1/one"\nsha256 "${SHA_A}"\n`;
    const second = `version "0.0.0-g6-fixture.2"\nurl "http://127.0.0.1/two"\nsha256 "${SHA_B}"\n`;
    expect(() =>
      assertLifecycleCaskPair({
        first,
        second,
        firstVersion: '0.0.0-g6-fixture.1',
        secondVersion: '0.0.0-g6-fixture.2',
      }),
    ).not.toThrow();
    expect(() =>
      assertLifecycleCaskPair({
        first,
        second: `${second}binary "other"\n`,
        firstVersion: '0.0.0-g6-fixture.1',
        secondVersion: '0.0.0-g6-fixture.2',
      }),
    ).toThrow();
  });

  test('controls child inputs, rejects canaries, and freezes fixture identities', () => {
    expect(
      createControlledBuildEnvironment({
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
      assertNoReleaseLeaks({ canaries: ['secret'], outputs: { metadata: 'safe' } }),
    ).not.toThrow();
    expect(() =>
      assertNoReleaseLeaks({ canaries: ['secret'], outputs: { metadata: 'unsafe-secret' } }),
    ).toThrow();
    expect(() => assertSingleLineage({ archive: SHA_A, npm: SHA_A })).not.toThrow();
    expect(() => assertSingleLineage({ archive: SHA_A, npm: SHA_B })).toThrow();
    expect(COMPLETION_PATHS).toEqual({
      bash: 'completions/skillsmith.bash',
      zsh: 'completions/_skillsmith',
      fish: 'completions/skillsmith.fish',
    });
    for (const fixture of Object.values(FIXTURE_EXECUTABLES)) {
      expect(fixture.bytes.byteLength).toBe(160);
      expect(createHash('sha256').update(fixture.bytes).digest('hex')).toBe(fixture.sha256);
    }
  });

  test('rejects an exact-name symlink before direct archive installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-release-hostile-'));
    try {
      const source = join(root, 'source');
      await mkdir(join(source, 'completions'), { recursive: true });
      await symlink('/etc/passwd', join(source, 'skillsmith'));
      await Promise.all([
        writeFile(join(source, 'LICENSE'), 'license\n'),
        writeFile(join(source, 'completions', 'skillsmith.bash'), 'bash\n'),
        writeFile(join(source, 'completions', '_skillsmith'), 'zsh\n'),
        writeFile(join(source, 'completions', 'skillsmith.fish'), 'fish\n'),
      ]);
      const archive = join(root, 'hostile.tar.gz');
      const packed = Bun.spawnSync(
        [
          'tar',
          '-czf',
          archive,
          '-C',
          source,
          'skillsmith',
          'LICENSE',
          'completions/skillsmith.bash',
          'completions/_skillsmith',
          'completions/skillsmith.fish',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(packed.exitCode, packed.stderr.toString()).toBe(0);
      await expect(
        installDirectArchive({ archivePath: archive, prefix: join(root, 'prefix') }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
