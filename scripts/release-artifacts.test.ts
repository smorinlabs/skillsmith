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
  assertNativeBinarySize,
  assertNoReleaseLeaks,
  assertOwnedOutputRoot,
  assertSingleLineage,
  createHermeticBuildEnvironment,
  installDirectArchive,
  releaseArtifactNames,
  renderHomebrewFormula,
  renderLauncherPackageJson,
  renderPayloadPackageJson,
  renderReleaseManifest,
  renderSha256Sums,
  validateArchiveEntries,
  validateNpmPackageEntries,
  validateReleaseVersion,
} from './release-artifacts.ts';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const REVISION = 'c'.repeat(40);

const directEntries: readonly ArchiveEntry[] = [
  { path: 'skillsmith', type: 'file', size: 42, mode: '0755' },
  { path: 'LICENSE', type: 'file', size: 42, mode: '0644' },
  { path: 'completions/skillsmith.bash', type: 'file', size: 42, mode: '0644' },
  { path: 'completions/_skillsmith', type: 'file', size: 42, mode: '0644' },
  { path: 'completions/skillsmith.fish', type: 'file', size: 42, mode: '0644' },
];

const payloadEntries: readonly ArchiveEntry[] = [
  { path: 'package/package.json', type: 'file', size: 42, mode: '0644' },
  { path: 'package/README.md', type: 'file', size: 42, mode: '0644' },
  { path: 'package/LICENSE', type: 'file', size: 42, mode: '0644' },
  { path: 'package/bin/skillsmith', type: 'file', size: 42, mode: '0755' },
];

describe('release artifact model', () => {
  test('freezes the ordered target matrix and version-derived names', () => {
    expect(RELEASE_TARGETS.map(({ id }) => id)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
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
      formula: 'skillsmith.rb',
      manifest: 'release-manifest.json',
      checksums: 'SHA256SUMS',
    });
  });

  test('rejects output escape, collision, and non-strict size boundaries', () => {
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
  });

  test('accepts only the closed regular-file archive and npm layouts', () => {
    expect(() => validateArchiveEntries(directEntries)).not.toThrow();
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
        { path: 'package/bin/../escape', type: 'file', size: 42, mode: '0755' },
      ]),
    ).toThrow();
    expect(() =>
      validateNpmPackageEntries('payload', [
        ...payloadEntries.slice(0, 3),
        { path: 'package/bin/skillsmith', type: 'device', size: 42, mode: '0755' },
      ]),
    ).toThrow();
  });

  test('rejects an exact-name symlink from a direct archive before installation', async () => {
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
      ).rejects.toThrow('unexpected or ambiguous path');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('renders exact launcher and per-target payload metadata with no scripts', () => {
    const launcher = renderLauncherPackageJson('1.2.3');
    expect(launcher).toEqual({
      name: '@smorinlabs/skillsmith',
      version: '1.2.3',
      description: 'Cross-tool skill management CLI',
      license: 'Apache-2.0',
      bin: { skillsmith: 'bin/skillsmith.cjs' },
      files: ['bin', 'share', 'README.md', 'LICENSE'],
      optionalDependencies: {
        '@smorinlabs/skillsmith-darwin-arm64': '1.2.3',
        '@smorinlabs/skillsmith-darwin-x64': '1.2.3',
        '@smorinlabs/skillsmith-linux-arm64': '1.2.3',
        '@smorinlabs/skillsmith-linux-x64': '1.2.3',
      },
    });
    expect('scripts' in launcher).toBeFalse();
    expect(renderPayloadPackageJson('linux-arm64', '1.2.3')).toMatchObject({
      name: '@smorinlabs/skillsmith-linux-arm64',
      version: '1.2.3',
      os: ['linux'],
      cpu: ['arm64'],
      libc: ['glibc'],
      files: ['bin/skillsmith', 'README.md', 'LICENSE'],
    });
    expect(renderPayloadPackageJson('darwin-x64', '1.2.3')).not.toHaveProperty('libc');
    expect(() => renderPayloadPackageJson('win32-x64', '1.2.3')).toThrow();
  });

  test('canonicalizes the manifest, checksums, and single-lineage proof', () => {
    const names = releaseArtifactNames('1.2.3');
    const manifest = renderReleaseManifest({
      version: '1.2.3',
      sourceRevision: REVISION,
      targets: RELEASE_TARGETS.map(({ id }) => ({
        id,
        binary: { sha256: SHA_A, bytes: 123 },
        archive: { path: names.archives[id], sha256: SHA_A, bytes: 456 },
        npm: { path: names.npmTarballs[id], sha256: SHA_A, bytes: 789 },
      })),
      launcher: { path: names.npmTarballs.launcher, sha256: SHA_A, bytes: 12 },
      formula: { sha256: SHA_A, bytes: 34 },
      completions: {
        bash: { sha256: SHA_A, bytes: 2610 },
        zsh: { sha256: SHA_A, bytes: 7729 },
        fish: { sha256: SHA_A, bytes: 9200 },
      },
    });
    expect(manifest.endsWith('\n')).toBeTrue();
    const parsed = JSON.parse(manifest) as { targets: unknown[]; completions: unknown[] };
    expect(parsed.targets).toHaveLength(4);
    expect(parsed.completions).toHaveLength(3);
    const checksumPaths = [
      ...Object.values(names.archives),
      ...Object.values(names.npmTarballs),
      names.formula,
      names.manifest,
    ];
    const sums = renderSha256Sums(Object.fromEntries(checksumPaths.map((path) => [path, SHA_A])));
    expect(sums.split('\n').filter(Boolean)).toHaveLength(11);
    expect(sums).toBe(
      `${checksumPaths
        .toSorted()
        .map((path) => `${SHA_A}  ${path}`)
        .join('\n')}\n`,
    );
    expect(() => assertSingleLineage({ archive: SHA_A, npm: SHA_A })).not.toThrow();
    expect(() => assertSingleLineage({ archive: SHA_A, npm: SHA_B })).toThrow();
  });

  test('renders one formula model with exact public and substituted origins', () => {
    const hashes = Object.fromEntries(RELEASE_TARGETS.map(({ id }) => [id, SHA_A]));
    const publicFormula = renderHomebrewFormula({ version: '1.2.3', archiveSha256: hashes });
    const localFormula = renderHomebrewFormula({
      version: '1.2.3',
      archiveSha256: hashes,
      origin: 'http://127.0.0.1:12345/releases/',
    });
    expect(localFormula).toBe(
      publicFormula.replaceAll(
        'https://github.com/smorinlabs/skillsmith/releases/download/v1.2.3',
        'http://127.0.0.1:12345/releases',
      ),
    );
    for (const { id } of RELEASE_TARGETS) {
      expect(publicFormula).toContain(`skillsmith-v1.2.3-${id}.tar.gz`);
    }
    expect(publicFormula).toContain('bin.install "skillsmith"');
    expect(publicFormula).toContain('shell_output("#{bin}/skillsmith version")');
  });

  test('scrubs the build environment and refuses byte-level canary leaks', () => {
    expect(
      createHermeticBuildEnvironment({
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
      assertNoReleaseLeaks({ canaries: ['secret'], outputs: { manifest: 'safe' } }),
    ).not.toThrow();
    expect(() =>
      assertNoReleaseLeaks({ canaries: ['secret'], outputs: { manifest: 'unsafe-secret-value' } }),
    ).toThrow();
    expect(() => assertNoReleaseLeaks({ canaries: [''], outputs: {} })).toThrow();
  });

  test('freezes completion placement and both immutable lifecycle executable hashes', () => {
    expect(COMPLETION_PATHS).toEqual({
      bash: 'completions/skillsmith.bash',
      zsh: 'completions/_skillsmith',
      fish: 'completions/skillsmith.fish',
    });
    expect(Object.keys(FIXTURE_EXECUTABLES)).toEqual(['0.0.0-g6-fixture.1', '0.0.0-g6-fixture.2']);
    for (const fixture of Object.values(FIXTURE_EXECUTABLES)) {
      expect(fixture.bytes.byteLength).toBe(160);
      expect(createHash('sha256').update(fixture.bytes).digest('hex')).toBe(fixture.sha256);
    }
  });
});
