import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type ReleaseTarget = Readonly<{
  id: 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64';
  bunTarget: 'bun-darwin-arm64' | 'bun-darwin-x64' | 'bun-linux-arm64' | 'bun-linux-x64';
  os: 'darwin' | 'linux';
  cpu: 'arm64' | 'x64';
  libc: 'glibc' | null;
}>;

export const RELEASE_TARGETS = [
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
] as const satisfies readonly ReleaseTarget[];

export type ReleaseTargetId = (typeof RELEASE_TARGETS)[number]['id'];

export const MAX_NATIVE_BINARY_BYTES = 134_217_728;

export const COMPLETION_PATHS = Object.freeze({
  bash: 'completions/skillsmith.bash',
  zsh: 'completions/_skillsmith',
  fish: 'completions/skillsmith.fish',
});

const COMPLETION_CONTRACT = Object.freeze({
  bash: {
    bytes: 2610,
    sha256: '11d3b601826f9a7545fae067411a6396d673e106566004a881e3c6537bcbe680',
  },
  zsh: {
    bytes: 7729,
    sha256: '0e02eef39059285743b1eeea59cf720092a69a616ee8556360d3d4c366ffad7a',
  },
  fish: {
    bytes: 9200,
    sha256: '11f7d19361766a447436dd9260c543420b43f7f0342bb102a96c73423a36af1b',
  },
});

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const LOWER_HEX_40 = /^[0-9a-f]{40}$/u;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

const sha256Hex = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

export const validateReleaseVersion = (version: string): string => {
  if (!SEMVER.test(version)) throw new Error(`invalid release version: ${JSON.stringify(version)}`);
  return version;
};

export const releaseArtifactNames = (versionInput: string) => {
  const version = validateReleaseVersion(versionInput);
  return {
    archives: Object.fromEntries(
      RELEASE_TARGETS.map(({ id }) => [id, `skillsmith-v${version}-${id}.tar.gz`]),
    ) as Record<ReleaseTargetId, string>,
    npmTarballs: {
      launcher: `smorinlabs-skillsmith-${version}.tgz`,
      ...Object.fromEntries(
        RELEASE_TARGETS.map(({ id }) => [id, `smorinlabs-skillsmith-${id}-${version}.tgz`]),
      ),
    } as Readonly<{ launcher: string } & Record<ReleaseTargetId, string>>,
    formula: 'skillsmith.rb',
    manifest: 'release-manifest.json',
    checksums: 'SHA256SUMS',
  } as const;
};

export const assertOwnedOutputRoot = (
  input: Readonly<{
    outputRoot: string;
    stagingRoot: string;
    existingEntries: readonly string[];
  }>,
): void => {
  const stagingRoot = resolve(input.stagingRoot);
  const outputRoot = resolve(input.outputRoot);
  const relation = relative(stagingRoot, outputRoot);
  if (!relation || relation === '..' || relation.startsWith('../') || isAbsolute(relation)) {
    throw new Error('release output must be a strict child of its owned staging root');
  }
  if (input.existingEntries.length > 0) {
    throw new Error(`release output is not empty: ${input.existingEntries.join(', ')}`);
  }
};

export type ArchiveEntry = Readonly<{
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'device';
  size: number;
  mode: string;
}>;

const ARCHIVE_LAYOUT = [
  ['skillsmith', '0755'],
  ['LICENSE', '0644'],
  ['completions/skillsmith.bash', '0644'],
  ['completions/_skillsmith', '0644'],
  ['completions/skillsmith.fish', '0644'],
] as const;

const NPM_PACKAGE_LAYOUTS = Object.freeze({
  launcher: Object.freeze({
    'package/package.json': '0644',
    'package/README.md': '0644',
    'package/LICENSE': '0644',
    'package/bin/skillsmith.cjs': '0755',
    'package/share/completions/skillsmith.bash': '0644',
    'package/share/completions/_skillsmith': '0644',
    'package/share/completions/skillsmith.fish': '0644',
  }),
  payload: Object.freeze({
    'package/package.json': '0644',
    'package/README.md': '0644',
    'package/LICENSE': '0644',
    'package/bin/skillsmith': '0755',
  }),
});

export const validateArchiveEntries = (entries: readonly ArchiveEntry[]): void => {
  if (entries.length !== ARCHIVE_LAYOUT.length) {
    throw new Error(`archive must contain exactly ${ARCHIVE_LAYOUT.length} entries`);
  }
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const expected = ARCHIVE_LAYOUT[index];
    if (expected === undefined) throw new Error('archive contains an extra entry');
    if (
      !entry.path ||
      entry.path.startsWith('/') ||
      entry.path.split('/').includes('..') ||
      entry.path.includes('\\') ||
      seen.has(entry.path)
    ) {
      throw new Error(`unsafe or duplicate archive entry: ${entry.path}`);
    }
    seen.add(entry.path);
    if (entry.type !== 'file')
      throw new Error(`archive entry is not a regular file: ${entry.path}`);
    if (entry.path !== expected[0] || entry.mode !== expected[1]) {
      throw new Error(`archive entry contract mismatch at index ${index}`);
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size >= MAX_NATIVE_BINARY_BYTES
    ) {
      throw new Error(`invalid archive entry size: ${entry.path}`);
    }
  }
};

export const validateNpmPackageEntries = (
  kind: keyof typeof NPM_PACKAGE_LAYOUTS,
  entries: readonly ArchiveEntry[],
): void => {
  const layout = NPM_PACKAGE_LAYOUTS[kind];
  const expectedPaths = Object.keys(layout);
  if (entries.length !== expectedPaths.length) {
    throw new Error(`${kind} npm package must contain exactly ${expectedPaths.length} entries`);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const expectedMode = layout[entry.path as keyof typeof layout];
    if (
      !entry.path ||
      entry.path.startsWith('/') ||
      entry.path.split('/').includes('..') ||
      entry.path.includes('\\') ||
      seen.has(entry.path) ||
      expectedMode === undefined
    ) {
      throw new Error(`unsafe or unexpected npm package entry: ${entry.path}`);
    }
    seen.add(entry.path);
    if (entry.type !== 'file') {
      throw new Error(`npm package entry is not a regular file: ${entry.path}`);
    }
    if (entry.mode !== expectedMode) {
      throw new Error(`npm package mode mismatch: ${entry.path}`);
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size >= MAX_NATIVE_BINARY_BYTES
    ) {
      throw new Error(`invalid npm package entry size: ${entry.path}`);
    }
  }
};

export const assertNativeBinarySize = (bytes: number): void => {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes >= MAX_NATIVE_BINARY_BYTES) {
    throw new Error(`native binary must be smaller than ${MAX_NATIVE_BINARY_BYTES} bytes`);
  }
};

export const createHermeticBuildEnvironment = (
  input: Readonly<{
    path: string;
    home: string;
    tmpdir: string;
  }>,
): Readonly<Record<string, string>> => ({
  PATH: input.path,
  HOME: input.home,
  TMPDIR: input.tmpdir,
  XDG_CONFIG_HOME: resolve(input.home, 'config'),
  XDG_CACHE_HOME: resolve(input.home, 'cache'),
  XDG_DATA_HOME: resolve(input.home, 'data'),
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  NO_COLOR: '1',
});

const containsBytes = (haystack: Uint8Array | string, needle: string): boolean => {
  const bytes = typeof haystack === 'string' ? Buffer.from(haystack) : Buffer.from(haystack);
  return bytes.indexOf(Buffer.from(needle)) >= 0;
};

export const assertNoReleaseLeaks = (
  input: Readonly<{
    canaries: readonly string[];
    outputs: Readonly<Record<string, Uint8Array | string>>;
  }>,
): void => {
  for (const canary of input.canaries) {
    if (!canary) throw new Error('release leak canary must be nonempty');
    for (const [name, output] of Object.entries(input.outputs)) {
      if (containsBytes(output, canary)) throw new Error(`release output contains ${name} canary`);
    }
  }
};

export const assertCompletionIdentity = (input: Readonly<Record<string, Uint8Array>>): void => {
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const bytes = input[shell];
    const expected = COMPLETION_CONTRACT[shell];
    if (bytes === undefined) throw new Error(`missing ${shell} completion bytes`);
    if (bytes.byteLength !== expected.bytes || sha256Hex(bytes) !== expected.sha256) {
      throw new Error(`${shell} completion bytes do not match the signed contract`);
    }
  }
  if (Object.keys(input).length !== 3) throw new Error('unexpected completion output');
};

const fixtureSource = (version: string): string => `#!/bin/sh
if [ "\${1-}" = "version" ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
printf '%s\\n' 'G6 lifecycle fixture ${version}' >&2
exit 64
`;

const makeFixture = (version: string, expectedSha256: string) => {
  const bytes = new TextEncoder().encode(fixtureSource(version));
  if (bytes.byteLength !== 160 || sha256Hex(bytes) !== expectedSha256) {
    throw new Error(`immutable release fixture drifted: ${version}`);
  }
  return Object.freeze({ version, bytes, sha256: expectedSha256 });
};

export const FIXTURE_EXECUTABLES = Object.freeze({
  '0.0.0-g6-fixture.1': makeFixture(
    '0.0.0-g6-fixture.1',
    'd2e29c65bd9afe1235f3105cbe297bd84c564a9c0026cc6320f059cd987797a6',
  ),
  '0.0.0-g6-fixture.2': makeFixture(
    '0.0.0-g6-fixture.2',
    '70f27666626752210b31be697cd63ff6554a6342936ea2ca435e1c5d53c7c3e9',
  ),
});

export const renderLauncherPackageJson = (versionInput: string) => {
  const version = validateReleaseVersion(versionInput);
  return {
    name: '@smorinlabs/skillsmith',
    version,
    description: 'Cross-tool skill management CLI',
    license: 'Apache-2.0',
    bin: { skillsmith: 'bin/skillsmith.cjs' },
    files: ['bin', 'share', 'README.md', 'LICENSE'],
    optionalDependencies: Object.fromEntries(
      RELEASE_TARGETS.map(({ id }) => [`@smorinlabs/skillsmith-${id}`, version]),
    ),
  };
};

export const renderPayloadPackageJson = (targetId: string, versionInput: string) => {
  const version = validateReleaseVersion(versionInput);
  const target = RELEASE_TARGETS.find(({ id }) => id === targetId);
  if (target === undefined) throw new Error(`unsupported release target: ${targetId}`);
  return {
    name: `@smorinlabs/skillsmith-${target.id}`,
    version,
    description: `Skillsmith native payload for ${target.id}`,
    license: 'Apache-2.0',
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc === null ? {} : { libc: [target.libc] }),
    files: ['bin/skillsmith', 'README.md', 'LICENSE'],
  };
};

const assertSha256 = (value: string, label: string): string => {
  if (!LOWER_HEX_64.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
};

export const renderSha256Sums = (entries: Readonly<Record<string, string>>): string => {
  const paths = Object.keys(entries).sort();
  if (paths.length !== 11) throw new Error('SHA256SUMS must contain exactly 11 public files');
  if (paths.includes('SHA256SUMS')) throw new Error('SHA256SUMS cannot hash itself');
  for (const path of paths) {
    if (!path || path.includes('/') || path.includes('\\') || path === '.' || path === '..') {
      throw new Error(`checksum path must be an immediate relative child: ${path}`);
    }
  }
  return `${paths.map((path) => `${assertSha256(entries[path] ?? '', path)}  ${path}`).join('\n')}\n`;
};

export const assertSingleLineage = (input: Readonly<Record<string, string>>): void => {
  const entries = Object.entries(input);
  if (entries.length < 2)
    throw new Error('single-lineage proof requires at least two observations');
  for (const [name, digest] of entries) assertSha256(digest, name);
  if (new Set(entries.map(([, digest]) => digest)).size !== 1) {
    throw new Error('release channels do not contain one binary lineage');
  }
};

export type ReleaseManifestTargetInput = Readonly<{
  id: ReleaseTargetId;
  binary: Readonly<{ sha256: string; bytes: number }>;
  archive: Readonly<{ path: string; sha256: string; bytes: number }>;
  npm: Readonly<{ path: string; sha256: string; bytes: number }>;
}>;

export type ReleaseManifestInput = Readonly<{
  version: string;
  sourceRevision: string;
  targets: readonly ReleaseManifestTargetInput[];
  launcher: Readonly<{ path: string; sha256: string; bytes: number }>;
  formula: Readonly<{ sha256: string; bytes: number }>;
  completions: Readonly<
    Record<'bash' | 'zsh' | 'fish', Readonly<{ sha256: string; bytes: number }>>
  >;
}>;

const assertByteCount = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} has invalid byte count`);
  return value;
};

export const renderReleaseManifest = (inputValue: unknown): string => {
  const input = inputValue as ReleaseManifestInput;
  const version = validateReleaseVersion(input.version);
  if (!LOWER_HEX_40.test(input.sourceRevision)) {
    throw new Error('source revision must be 40 lowercase hexadecimal characters');
  }
  if (
    input.targets.length !== RELEASE_TARGETS.length ||
    input.targets.some((target, index) => target.id !== RELEASE_TARGETS[index]?.id)
  ) {
    throw new Error('release manifest target order is invalid');
  }
  const names = releaseArtifactNames(version);
  const manifest = {
    schemaVersion: 1,
    name: 'skillsmith',
    version,
    sourceRevision: input.sourceRevision,
    targets: input.targets.map((value, index) => {
      const target = RELEASE_TARGETS[index];
      if (target === undefined) throw new Error('release target is absent');
      if (value.archive.path !== names.archives[target.id]) {
        throw new Error(`archive name mismatch for ${target.id}`);
      }
      if (value.npm.path !== names.npmTarballs[target.id]) {
        throw new Error(`npm tarball name mismatch for ${target.id}`);
      }
      assertNativeBinarySize(value.binary.bytes);
      return {
        id: target.id,
        bunTarget: target.bunTarget,
        os: target.os,
        cpu: target.cpu,
        libc: target.libc,
        binary: {
          sha256: assertSha256(value.binary.sha256, `${target.id} binary`),
          bytes: assertByteCount(value.binary.bytes, `${target.id} binary`),
          mode: '0755',
        },
        archive: {
          path: value.archive.path,
          sha256: assertSha256(value.archive.sha256, `${target.id} archive`),
          bytes: assertByteCount(value.archive.bytes, `${target.id} archive`),
        },
        npm: {
          name: `@smorinlabs/skillsmith-${target.id}`,
          path: value.npm.path,
          sha256: assertSha256(value.npm.sha256, `${target.id} npm package`),
          bytes: assertByteCount(value.npm.bytes, `${target.id} npm package`),
        },
      };
    }),
    launcher: {
      name: '@smorinlabs/skillsmith',
      path: input.launcher.path,
      sha256: assertSha256(input.launcher.sha256, 'launcher'),
      bytes: assertByteCount(input.launcher.bytes, 'launcher'),
    },
    formula: {
      path: names.formula,
      sha256: assertSha256(input.formula.sha256, 'formula'),
      bytes: assertByteCount(input.formula.bytes, 'formula'),
    },
    completions: (['bash', 'zsh', 'fish'] as const).map((shell) => ({
      shell,
      path: COMPLETION_PATHS[shell],
      sha256: assertSha256(input.completions[shell].sha256, `${shell} completion`),
      bytes: assertByteCount(input.completions[shell].bytes, `${shell} completion`),
    })),
  };
  if (input.launcher.path !== names.npmTarballs.launcher) {
    throw new Error('launcher tarball name mismatch');
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

export type HomebrewFormulaInput = Readonly<{
  version: string;
  archiveSha256: Readonly<Record<ReleaseTargetId, string>>;
  origin?: string;
}>;

export const renderHomebrewFormula = (input: HomebrewFormulaInput): string => {
  const version = validateReleaseVersion(input.version);
  const names = releaseArtifactNames(version);
  const origin = (
    input.origin ?? `https://github.com/smorinlabs/skillsmith/releases/download/v${version}`
  ).replace(/\/$/u, '');
  const branch = (id: ReleaseTargetId, indentation: string): string =>
    `${indentation}url "${origin}/${names.archives[id]}"\n${indentation}sha256 "${assertSha256(input.archiveSha256[id], id)}"`;
  return `class Skillsmith < Formula
  desc "Cross-tool skill management CLI"
  homepage "https://github.com/smorinlabs/skillsmith"
  version "${version}"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
${branch('darwin-arm64', '      ')}
    else
${branch('darwin-x64', '      ')}
    end
  end

  on_linux do
    if Hardware::CPU.arm?
${branch('linux-arm64', '      ')}
    else
${branch('linux-x64', '      ')}
    end
  end

  def install
    bin.install "skillsmith"
    bash_completion.install "completions/skillsmith.bash" => "skillsmith"
    zsh_completion.install "completions/_skillsmith"
    fish_completion.install "completions/skillsmith.fish"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/skillsmith version").strip
  end
end
`;
};

export const REQUIRED_COMPILE_FLAGS = [
  '--compile',
  '--bytecode',
  '--env=disable',
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
] as const;

export type BuildReleaseCandidateInput = Readonly<{
  repositoryRoot: string;
  stagingRoot: string;
  outputRoot: string;
  version: string;
  sourceRevision: string;
  target: 'all' | 'host' | ReleaseTargetId;
  compileFlags: readonly string[];
  fixture?: true;
  binaryOverrides?: Partial<Record<ReleaseTargetId, Uint8Array>>;
  canaries?: readonly string[];
}>;

export type BuiltReleaseTarget = Readonly<{
  target: ReleaseTarget;
  binarySha256: string;
  binaryBytes: number;
  archivePath: string;
  archiveSha256: string;
  npmPath: string;
  npmSha256: string;
}>;

export type BuildReleaseCandidateResult = Readonly<{
  outputRoot: string;
  version: string;
  sourceRevision: string;
  targets: readonly BuiltReleaseTarget[];
  manifestPath: string | null;
  checksumsPath: string | null;
  formulaPath: string | null;
  launcherPath: string | null;
}>;

const hostTarget = (): ReleaseTarget => {
  const id =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? 'darwin-arm64'
      : process.platform === 'darwin' && process.arch === 'x64'
        ? 'darwin-x64'
        : process.platform === 'linux' && process.arch === 'arm64'
          ? 'linux-arm64'
          : process.platform === 'linux' && process.arch === 'x64'
            ? 'linux-x64'
            : null;
  const target = RELEASE_TARGETS.find((candidate) => candidate.id === id);
  if (target === undefined)
    throw new Error(`unsupported build host: ${process.platform}/${process.arch}`);
  return target;
};

const toolPath = (): string => {
  const bunDirectory = dirname(process.execPath);
  return [bunDirectory, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
};

const runChecked = (
  command: readonly string[],
  input: Readonly<{
    cwd: string;
    env: Readonly<Record<string, string>>;
    canaries: readonly string[];
  }>,
): Readonly<{ stdout: Uint8Array; stderr: Uint8Array }> => {
  const child = Bun.spawnSync(command, {
    cwd: input.cwd,
    env: input.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assertNoReleaseLeaks({
    canaries: input.canaries,
    outputs: { stdout: child.stdout, stderr: child.stderr },
  });
  if (child.exitCode !== 0) {
    const detail =
      Buffer.from(child.stderr).toString('utf8').trim() ||
      Buffer.from(child.stdout).toString('utf8').trim();
    throw new Error(
      `release subprocess failed (${child.exitCode}): ${command[0] ?? 'unknown'}${detail ? `: ${detail.slice(0, 1000)}` : ''}`,
    );
  }
  return { stdout: child.stdout, stderr: child.stderr };
};

const permissionMode = (permissions: string): string => {
  if (!/^-[rwx-]{9}$/u.test(permissions)) {
    throw new Error('tar entry is not a regular file with ordinary POSIX permissions');
  }
  const values = [permissions.slice(1, 4), permissions.slice(4, 7), permissions.slice(7, 10)].map(
    (triple) =>
      (triple[0] === 'r' ? 4 : 0) + (triple[1] === 'w' ? 2 : 0) + (triple[2] === 'x' ? 1 : 0),
  );
  return `0${values.join('')}`;
};

const inspectTarball = async (
  input: Readonly<{
    path: string;
    allowedPaths: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    canaries: readonly string[];
  }>,
): Promise<ArchiveEntry[]> => {
  const verbose = Buffer.from(
    runChecked(['tar', '-tvzf', input.path], {
      cwd: input.cwd,
      env: input.env,
      canaries: input.canaries,
    }).stdout,
  )
    .toString('utf8')
    .split(/\r?\n/u)
    .filter(Boolean);
  if (verbose.length !== input.allowedPaths.length) {
    throw new Error('tarball entry count does not match its closed layout');
  }
  const entries = verbose.map((line) => {
    const matches = input.allowedPaths.filter((path) => line.endsWith(` ${path}`));
    if (matches.length !== 1) throw new Error('tarball contains an unexpected or ambiguous path');
    const path = matches[0] ?? '';
    const metadata = line
      .slice(10, -(path.length + 1))
      .trim()
      .split(/\s+/u);
    // GNU tar emits `owner/group size date time`; BSD tar emits
    // `links owner group size month day time`. Both are standard runner implementations.
    const sizeText = metadata[0]?.includes('/') === true ? metadata[1] : metadata[3];
    if (sizeText === undefined || !/^\d+$/u.test(sizeText)) {
      throw new Error('tarball entry size is not an unsigned decimal integer');
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) throw new Error('tarball entry size is not a safe integer');
    return {
      path,
      type: 'file' as const,
      size,
      mode: permissionMode(line.slice(0, 10)),
    };
  });
  if (new Set(entries.map(({ path }) => path)).size !== input.allowedPaths.length) {
    throw new Error('tarball contains a duplicate or missing path');
  }
  return entries;
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await chmod(path, 0o644);
};

const fileDigest = async (path: string): Promise<Readonly<{ sha256: string; bytes: number }>> => {
  const bytes = await readFile(path);
  return { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
};

const ensureExecutableHeader = async (path: string, target: ReleaseTarget): Promise<void> => {
  const bytes = await readFile(path);
  assertNativeBinarySize(bytes.byteLength);
  const elf = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const magic = bytes.readUInt32BE(0);
  const machO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]).has(magic);
  if ((target.os === 'linux' && !elf) || (target.os === 'darwin' && !machO)) {
    throw new Error(`compiled binary header does not match ${target.id}`);
  }
};

const copyCompletions = async (
  root: string,
  completions: Readonly<Record<'bash' | 'zsh' | 'fish', Uint8Array>>,
): Promise<void> => {
  const directory = join(root, 'completions');
  await mkdir(directory, { recursive: true });
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const path = join(root, COMPLETION_PATHS[shell]);
    await writeFile(path, completions[shell], { mode: 0o644 });
    await chmod(path, 0o644);
  }
};

const packDirectory = async (
  directory: string,
  outputRoot: string,
  filename: string,
  env: Readonly<Record<string, string>>,
  canaries: readonly string[],
): Promise<void> => {
  const packedRoot = join(dirname(directory), '.packed');
  await mkdir(packedRoot, { recursive: true });
  runChecked(
    [
      process.execPath,
      'pm',
      'pack',
      '--filename',
      join(packedRoot, filename),
      '--ignore-scripts',
      '--quiet',
    ],
    { cwd: directory, env, canaries },
  );
  await copyFile(join(packedRoot, filename), join(outputRoot, filename));
  await chmod(join(outputRoot, filename), 0o644);
  await rm(packedRoot, { recursive: true, force: true });
};

const createArchive = (
  directory: string,
  outputPath: string,
  env: Readonly<Record<string, string>>,
  canaries: readonly string[],
): void => {
  runChecked(
    [
      'tar',
      '-czf',
      outputPath,
      '-C',
      directory,
      'skillsmith',
      'LICENSE',
      'completions/skillsmith.bash',
      'completions/_skillsmith',
      'completions/skillsmith.fish',
    ],
    { cwd: directory, env, canaries },
  );
};

const packagePayload = async (
  input: Readonly<{
    packageRoot: string;
    outputRoot: string;
    target: ReleaseTarget;
    version: string;
    binaryPath: string;
    filename: string;
    repositoryRoot: string;
    env: Readonly<Record<string, string>>;
    canaries: readonly string[];
  }>,
): Promise<void> => {
  const root = join(input.packageRoot, `payload-${input.target.id}`);
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeJson(
    join(root, 'package.json'),
    renderPayloadPackageJson(input.target.id, input.version),
  );
  await copyFile(
    join(input.repositoryRoot, 'packaging', 'npm', 'README.md'),
    join(root, 'README.md'),
  );
  await copyFile(join(input.repositoryRoot, 'LICENSE'), join(root, 'LICENSE'));
  await chmod(join(root, 'README.md'), 0o644);
  await chmod(join(root, 'LICENSE'), 0o644);
  await copyFile(input.binaryPath, join(root, 'bin', 'skillsmith'));
  await chmod(join(root, 'bin', 'skillsmith'), 0o755);
  await packDirectory(root, input.outputRoot, input.filename, input.env, input.canaries);
};

const packageLauncher = async (
  input: Readonly<{
    packageRoot: string;
    outputRoot: string;
    version: string;
    filename: string;
    repositoryRoot: string;
    completions: Readonly<Record<'bash' | 'zsh' | 'fish', Uint8Array>>;
    env: Readonly<Record<string, string>>;
    canaries: readonly string[];
  }>,
): Promise<void> => {
  const root = join(input.packageRoot, 'launcher');
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'share'), { recursive: true });
  await writeJson(join(root, 'package.json'), renderLauncherPackageJson(input.version));
  await copyFile(
    join(input.repositoryRoot, 'packaging', 'npm', 'README.md'),
    join(root, 'README.md'),
  );
  await copyFile(join(input.repositoryRoot, 'LICENSE'), join(root, 'LICENSE'));
  await chmod(join(root, 'README.md'), 0o644);
  await chmod(join(root, 'LICENSE'), 0o644);
  await copyFile(
    join(input.repositoryRoot, 'packaging', 'npm', 'bin', 'skillsmith.cjs'),
    join(root, 'bin', 'skillsmith.cjs'),
  );
  await chmod(join(root, 'bin', 'skillsmith.cjs'), 0o755);
  await copyCompletions(join(root, 'share'), input.completions);
  await packDirectory(root, input.outputRoot, input.filename, input.env, input.canaries);
};

const sourceCompletions = (
  repositoryRoot: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
  canaries: readonly string[],
): Readonly<Record<'bash' | 'zsh' | 'fish', Uint8Array>> => {
  const output = Object.fromEntries(
    (['bash', 'zsh', 'fish'] as const).map((shell) => {
      const result = runChecked(
        [
          process.execPath,
          join(repositoryRoot, 'packages', 'cli', 'src', 'index.ts'),
          'completion',
          shell,
        ],
        { cwd, env, canaries },
      );
      return [shell, result.stdout];
    }),
  ) as Record<'bash' | 'zsh' | 'fish', Uint8Array>;
  assertCompletionIdentity(output);
  return output;
};

export const buildReleaseCandidate = async (
  input: BuildReleaseCandidateInput,
): Promise<BuildReleaseCandidateResult> => {
  const repositoryRoot = resolve(input.repositoryRoot);
  const stagingRoot = resolve(input.stagingRoot);
  const outputRoot = resolve(input.outputRoot);
  const version = validateReleaseVersion(input.version);
  if (!LOWER_HEX_40.test(input.sourceRevision)) throw new Error('invalid explicit source revision');
  if (JSON.stringify(input.compileFlags) !== JSON.stringify(REQUIRED_COMPILE_FLAGS)) {
    throw new Error('release compile hardening flags do not match the frozen contract');
  }
  if (input.binaryOverrides !== undefined && input.fixture !== true) {
    throw new Error('binary overrides are permitted only for explicit lifecycle fixtures');
  }
  if (input.fixture === true && input.binaryOverrides === undefined) {
    throw new Error('a lifecycle fixture must provide immutable binary overrides');
  }
  const existingEntries = await readdir(outputRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw error;
  });
  assertOwnedOutputRoot({ outputRoot, stagingRoot, existingEntries });

  const selectedTargets =
    input.target === 'all'
      ? [...RELEASE_TARGETS]
      : input.target === 'host'
        ? [hostTarget()]
        : [
            RELEASE_TARGETS.find(({ id }) => id === input.target) ??
              (() => {
                throw new Error(`unsupported release target: ${input.target}`);
              })(),
          ];
  const canaries = [...(input.canaries ?? [])];
  const workRoot = await mkdtemp(join(tmpdir(), 'skillsmith-release-'));
  const isolatedHome = join(workRoot, 'home');
  const isolatedTmp = join(workRoot, 'tmp');
  const env = createHermeticBuildEnvironment({
    path: toolPath(),
    home: isolatedHome,
    tmpdir: isolatedTmp,
  });
  const names = releaseArtifactNames(version);
  await mkdir(outputRoot, { recursive: true });
  await mkdir(isolatedHome, { recursive: true });
  await mkdir(isolatedTmp, { recursive: true });

  try {
    const completions = sourceCompletions(repositoryRoot, workRoot, env, canaries);
    const built: BuiltReleaseTarget[] = [];
    const manifestTargets: ReleaseManifestTargetInput[] = [];
    const archiveSha256 = {} as Record<ReleaseTargetId, string>;

    for (const target of selectedTargets) {
      const targetRoot = join(workRoot, target.id);
      const binaryPath = join(targetRoot, 'skillsmith');
      await mkdir(targetRoot, { recursive: true });
      const override = input.binaryOverrides?.[target.id];
      if (override === undefined) {
        runChecked(
          [
            process.execPath,
            'build',
            ...input.compileFlags,
            `--target=${target.bunTarget}`,
            join(repositoryRoot, 'packages', 'cli', 'src', 'index.ts'),
            '--outfile',
            relative(workRoot, binaryPath),
          ],
          { cwd: workRoot, env, canaries },
        );
        await ensureExecutableHeader(binaryPath, target);
      } else {
        assertNativeBinarySize(override.byteLength);
        await writeFile(binaryPath, override, { mode: 0o755 });
      }
      await chmod(binaryPath, 0o755);
      const binary = await fileDigest(binaryPath);

      if (target.id === hostTarget().id && override === undefined) {
        for (const args of [['version'], ['--help']] as const) {
          runChecked([binaryPath, ...args], { cwd: workRoot, env, canaries });
        }
        for (const shell of ['bash', 'zsh', 'fish'] as const) {
          const native = runChecked([binaryPath, 'completion', shell], {
            cwd: workRoot,
            env,
            canaries,
          });
          if (!Buffer.from(native.stdout).equals(Buffer.from(completions[shell]))) {
            throw new Error(`${shell} native completion drifted from direct execution`);
          }
        }
      }

      const archiveRoot = join(targetRoot, 'archive');
      await mkdir(archiveRoot, { recursive: true });
      await copyFile(binaryPath, join(archiveRoot, 'skillsmith'));
      await chmod(join(archiveRoot, 'skillsmith'), 0o755);
      await copyFile(join(repositoryRoot, 'LICENSE'), join(archiveRoot, 'LICENSE'));
      await chmod(join(archiveRoot, 'LICENSE'), 0o644);
      await copyCompletions(archiveRoot, completions);
      const archivePath = join(outputRoot, names.archives[target.id]);
      createArchive(archiveRoot, archivePath, env, canaries);
      await chmod(archivePath, 0o644);
      validateArchiveEntries(
        await inspectTarball({
          path: archivePath,
          allowedPaths: ARCHIVE_LAYOUT.map(([path]) => path),
          cwd: workRoot,
          env,
          canaries,
        }),
      );
      const archive = await fileDigest(archivePath);
      archiveSha256[target.id] = archive.sha256;

      const npmFilename = names.npmTarballs[target.id];
      await packagePayload({
        packageRoot: join(workRoot, 'packages'),
        outputRoot,
        target,
        version,
        binaryPath,
        filename: npmFilename,
        repositoryRoot,
        env,
        canaries,
      });
      validateNpmPackageEntries(
        'payload',
        await inspectTarball({
          path: join(outputRoot, npmFilename),
          allowedPaths: Object.keys(NPM_PACKAGE_LAYOUTS.payload),
          cwd: workRoot,
          env,
          canaries,
        }),
      );
      const npm = await fileDigest(join(outputRoot, npmFilename));
      built.push({
        target,
        binarySha256: binary.sha256,
        binaryBytes: binary.bytes,
        archivePath,
        archiveSha256: archive.sha256,
        npmPath: join(outputRoot, npmFilename),
        npmSha256: npm.sha256,
      });
      manifestTargets.push({
        id: target.id,
        binary,
        archive: { path: names.archives[target.id], ...archive },
        npm: { path: npmFilename, ...npm },
      });
    }

    const launcherFilename = names.npmTarballs.launcher;
    await packageLauncher({
      packageRoot: join(workRoot, 'packages'),
      outputRoot,
      version,
      filename: launcherFilename,
      repositoryRoot,
      completions,
      env,
      canaries,
    });
    const launcherPath = join(outputRoot, launcherFilename);
    validateNpmPackageEntries(
      'launcher',
      await inspectTarball({
        path: launcherPath,
        allowedPaths: Object.keys(NPM_PACKAGE_LAYOUTS.launcher),
        cwd: workRoot,
        env,
        canaries,
      }),
    );

    if (input.target !== 'all') {
      return {
        outputRoot,
        version,
        sourceRevision: input.sourceRevision,
        targets: built,
        manifestPath: null,
        checksumsPath: null,
        formulaPath: null,
        launcherPath,
      };
    }

    const launcher = await fileDigest(launcherPath);
    const formulaPath = join(outputRoot, names.formula);
    await writeFile(formulaPath, renderHomebrewFormula({ version, archiveSha256 }), {
      mode: 0o644,
    });
    await chmod(formulaPath, 0o644);
    const formula = await fileDigest(formulaPath);
    const completionManifest = Object.fromEntries(
      (['bash', 'zsh', 'fish'] as const).map((shell) => [
        shell,
        { sha256: sha256Hex(completions[shell]), bytes: completions[shell].byteLength },
      ]),
    ) as Record<'bash' | 'zsh' | 'fish', { sha256: string; bytes: number }>;
    const manifestPath = join(outputRoot, names.manifest);
    await writeFile(
      manifestPath,
      renderReleaseManifest({
        version,
        sourceRevision: input.sourceRevision,
        targets: manifestTargets,
        launcher: { path: launcherFilename, ...launcher },
        formula,
        completions: completionManifest,
      }),
      { mode: 0o644 },
    );
    await chmod(manifestPath, 0o644);
    const checksummedPaths = [
      ...Object.values(names.archives),
      ...Object.values(names.npmTarballs),
      names.formula,
      names.manifest,
    ];
    const checksums = Object.fromEntries(
      await Promise.all(
        checksummedPaths.map(async (path) => [
          path,
          (await fileDigest(join(outputRoot, path))).sha256,
        ]),
      ),
    );
    const checksumsPath = join(outputRoot, names.checksums);
    await writeFile(checksumsPath, renderSha256Sums(checksums), { mode: 0o644 });
    await chmod(checksumsPath, 0o644);
    const publicOutputs = Object.fromEntries(
      await Promise.all(
        [...checksummedPaths, names.checksums].map(async (path) => [
          path,
          await readFile(join(outputRoot, path)),
        ]),
      ),
    );
    assertNoReleaseLeaks({ canaries, outputs: publicOutputs });

    return {
      outputRoot,
      version,
      sourceRevision: input.sourceRevision,
      targets: built,
      manifestPath,
      checksumsPath,
      formulaPath,
      launcherPath,
    };
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
};

export type DirectArchiveInstallInput = Readonly<{
  archivePath: string;
  prefix: string;
}>;

const directInstallPaths = (prefix: string) => ({
  binary: join(prefix, 'bin', 'skillsmith'),
  bash: join(prefix, 'share', 'bash-completion', 'completions', 'skillsmith'),
  zsh: join(prefix, 'share', 'zsh', 'site-functions', '_skillsmith'),
  fish: join(prefix, 'share', 'fish', 'vendor_completions.d', 'skillsmith.fish'),
});

export const installDirectArchive = async (
  input: DirectArchiveInstallInput,
): Promise<Readonly<Record<'binary' | 'bash' | 'zsh' | 'fish', string>>> => {
  const extractRoot = await mkdtemp(join(tmpdir(), 'skillsmith-direct-install-'));
  const env = createHermeticBuildEnvironment({
    path: toolPath(),
    home: join(extractRoot, 'home'),
    tmpdir: join(extractRoot, 'tmp'),
  });
  try {
    validateArchiveEntries(
      await inspectTarball({
        path: resolve(input.archivePath),
        allowedPaths: ARCHIVE_LAYOUT.map(([path]) => path),
        cwd: extractRoot,
        env,
        canaries: [],
      }),
    );
    // Preserve the archive's signed modes even though this lifecycle runs under umask 077.
    runChecked(['tar', '-xpzf', resolve(input.archivePath), '-C', extractRoot], {
      cwd: extractRoot,
      env,
      canaries: [],
    });
    const archiveEntries = await Promise.all(
      ARCHIVE_LAYOUT.map(async ([path]) => {
        const metadata = await lstat(join(extractRoot, path));
        return {
          path,
          type: metadata.isFile() ? ('file' as const) : ('symlink' as const),
          size: metadata.size,
          mode: (metadata.mode & 0o777).toString(8).padStart(4, '0'),
        };
      }),
    );
    validateArchiveEntries(archiveEntries);
    const paths = directInstallPaths(resolve(input.prefix));
    await Promise.all(
      Object.values(paths).map((path) => mkdir(dirname(path), { recursive: true })),
    );
    await copyFile(join(extractRoot, 'skillsmith'), paths.binary);
    await chmod(paths.binary, 0o755);
    await copyFile(join(extractRoot, COMPLETION_PATHS.bash), paths.bash);
    await copyFile(join(extractRoot, COMPLETION_PATHS.zsh), paths.zsh);
    await copyFile(join(extractRoot, COMPLETION_PATHS.fish), paths.fish);
    await Promise.all([paths.bash, paths.zsh, paths.fish].map((path) => chmod(path, 0o644)));
    return paths;
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
};

export const uninstallDirectArchive = async (
  input: Readonly<{ prefix: string }>,
): Promise<void> => {
  await Promise.all(
    Object.values(directInstallPaths(resolve(input.prefix))).map((path) =>
      rm(path, { force: true }),
    ),
  );
};
