import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const RELEASE_TOOLCHAIN = Object.freeze({
  bun: '1.3.14',
  goreleaser: '2.17.1',
  npm: '12.0.1',
  goreleaserAction: 'f06c13b6b1a9625abc9e6e439d9c05a8f2190e94',
});

export type ReleaseTarget = Readonly<{
  id: 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64';
  bunTarget: 'bun-darwin-arm64' | 'bun-darwin-x64' | 'bun-linux-arm64' | 'bun-linux-x64';
  goos: 'darwin' | 'linux';
  goarch: 'arm64' | 'amd64';
  os: 'darwin' | 'linux';
  cpu: 'arm64' | 'x64';
  libc: 'glibc' | null;
}>;

export const RELEASE_TARGETS = [
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

const ARCHIVE_LAYOUT = Object.freeze({
  LICENSE: '0644',
  'completions/_skillsmith': '0644',
  'completions/skillsmith.bash': '0644',
  'completions/skillsmith.fish': '0644',
  skillsmith: '0755',
});

const NPM_PACKAGE_LAYOUTS = Object.freeze({
  launcher: Object.freeze({
    'package/LICENSE': '0644',
    'package/README.md': '0644',
    'package/bin/skillsmith.cjs': '0755',
    'package/package.json': '0644',
    'package/share/completions/_skillsmith': '0644',
    'package/share/completions/skillsmith.bash': '0644',
    'package/share/completions/skillsmith.fish': '0644',
  }),
  payload: Object.freeze({
    'package/LICENSE': '0644',
    'package/README.md': '0644',
    'package/bin/skillsmith': '0755',
    'package/package.json': '0644',
  }),
});

const FULL_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const LOWER_HEX_40 = /^[0-9a-f]{40}$/u;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

const sha256Hex = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

export const validateReleaseVersion = (version: string): string => {
  if (!FULL_SEMVER.test(version)) {
    throw new Error(`invalid release version: ${JSON.stringify(version)}`);
  }
  return version;
};

export const assertSourceRevision = (revision: string): void => {
  if (!LOWER_HEX_40.test(revision)) {
    throw new Error('source revision must be 40 lowercase hexadecimal characters');
  }
};

export const assertReleaseToolVersions = (
  input: Readonly<Record<'bun' | 'goreleaser' | 'npm', string>>,
): void => {
  for (const name of ['bun', 'goreleaser', 'npm'] as const) {
    if (input[name] !== RELEASE_TOOLCHAIN[name]) {
      throw new Error(`${name} ${input[name]} does not match ${RELEASE_TOOLCHAIN[name]}`);
    }
  }
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
    checksums: 'SHA256SUMS',
    artifacts: 'artifacts.json',
    metadata: 'metadata.json',
    cask: 'homebrew/Casks/skillsmith.rb',
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

export const assertNativeBinarySize = (bytes: number): void => {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes >= MAX_NATIVE_BINARY_BYTES) {
    throw new Error(`native binary must be smaller than ${MAX_NATIVE_BINARY_BYTES} bytes`);
  }
};

export type ArchiveEntry = Readonly<{
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'device';
  size: number;
  mode: string;
  owner?: string;
  group?: string;
}>;

const assertClosedLayout = (
  layout: Readonly<Record<string, string>>,
  entries: readonly Readonly<{
    path: string;
    mode: string;
    type?: ArchiveEntry['type'];
    size?: number;
    owner?: string;
    group?: string;
  }>[],
  label: string,
  requireRootOwnership = false,
): void => {
  if (entries.length !== Object.keys(layout).length) {
    throw new Error(`${label} must contain exactly ${Object.keys(layout).length} entries`);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      !entry.path ||
      entry.path.startsWith('/') ||
      entry.path.includes('\\') ||
      entry.path.split('/').includes('..') ||
      seen.has(entry.path)
    ) {
      throw new Error(`unsafe or duplicate ${label} entry: ${entry.path}`);
    }
    seen.add(entry.path);
    const expectedMode = layout[entry.path];
    if (expectedMode === undefined || entry.mode !== expectedMode) {
      throw new Error(`unexpected ${label} entry or mode: ${entry.path}`);
    }
    if (entry.type !== undefined && entry.type !== 'file') {
      throw new Error(`${label} entry is not a regular file: ${entry.path}`);
    }
    if (
      entry.size !== undefined &&
      (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size >= MAX_NATIVE_BINARY_BYTES)
    ) {
      throw new Error(`invalid ${label} entry size: ${entry.path}`);
    }
    if (
      (requireRootOwnership && entry.owner !== undefined && entry.owner !== 'root') ||
      (requireRootOwnership && entry.group !== undefined && entry.group !== 'root')
    ) {
      throw new Error(`${label} entry ownership is not root/root: ${entry.path}`);
    }
  }
};

export const validateArchiveEntries = (entries: readonly ArchiveEntry[]): void => {
  assertClosedLayout(ARCHIVE_LAYOUT, entries, 'archive', true);
};

export const validateNpmPackageEntries = (
  kind: keyof typeof NPM_PACKAGE_LAYOUTS,
  entries: readonly Readonly<{ path: string; mode: string }>[],
): void => {
  assertClosedLayout(NPM_PACKAGE_LAYOUTS[kind], entries, `${kind} npm package`);
};

export const createControlledBuildEnvironment = (
  input: Readonly<{ path: string; home: string; tmpdir: string; tag: string }>,
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
  GORELEASER_CURRENT_TAG: input.tag,
});

const containsBytes = (haystack: Uint8Array | string, needle: string): boolean =>
  Buffer.from(haystack).indexOf(Buffer.from(needle)) >= 0;

export const assertNoReleaseLeaks = (
  input: Readonly<{
    canaries: readonly string[];
    outputs: Readonly<Record<string, Uint8Array | string>>;
  }>,
): void => {
  for (const canary of input.canaries) {
    if (!canary) throw new Error('release leak canary must be nonempty');
    for (const [name, output] of Object.entries(input.outputs)) {
      if (containsBytes(output, canary)) {
        throw new Error(`release output contains ${name} canary`);
      }
    }
  }
};

export const assertCompletionIdentity = (input: Readonly<Record<string, Uint8Array>>): void => {
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const bytes = input[shell];
    const expected = COMPLETION_CONTRACT[shell];
    if (
      bytes === undefined ||
      bytes.byteLength !== expected.bytes ||
      sha256Hex(bytes) !== expected.sha256
    ) {
      throw new Error(`${shell} completion bytes do not match the signed contract`);
    }
  }
  if (Object.keys(input).length !== 3) throw new Error('unexpected completion output');
};

export const assertSingleLineage = (input: Readonly<Record<string, string>>): void => {
  const values = Object.values(input);
  if (values.length < 2 || values.some((value) => !LOWER_HEX_64.test(value))) {
    throw new Error('single-lineage proof requires at least two valid SHA-256 observations');
  }
  if (new Set(values).size !== 1) {
    throw new Error('release channels do not contain one binary lineage');
  }
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

export const deriveProductionCaskFixture = (
  input: Readonly<{ cask: string; origin: string }>,
): string => {
  const version = input.cask.match(/^\s*version "([^"]+)"$/mu)?.[1];
  if (version === undefined || !validateReleaseVersion(version)) {
    throw new Error('production cask version is absent');
  }
  let replacements = 0;
  const transformed = input.cask.replace(
    /^(\s*)url "https:\/\/github\.com\/smorinlabs\/skillsmith\/releases\/download\/v#\{version\}\/([^"]+)",\n\s*verified: "github\.com\/smorinlabs\/skillsmith\/"$/gmu,
    (_match, indentation: string, artifact: string) => {
      replacements += 1;
      const filename = artifact.replaceAll('#{version}', version);
      return `${indentation}url "${input.origin.replace(/\/$/u, '')}/${filename}"`;
    },
  );
  if (replacements !== 4) {
    throw new Error('production cask must contain exactly four bounded URL transformations');
  }
  return transformed;
};

const normalizeLifecycleCask = (value: string): string =>
  value
    .replace(/^\s*version "[^"]+"$/gmu, 'version "<VERSION>"')
    .replace(/^\s*url "[^"]+"$/gmu, 'url "<URL>"')
    .replace(/^\s*sha256 "[0-9a-f]{64}"$/gmu, 'sha256 "<SHA256>"');

export const assertLifecycleCaskPair = (
  input: Readonly<{
    first: string;
    second: string;
    firstVersion: string;
    secondVersion: string;
  }>,
): void => {
  if (
    input.firstVersion === input.secondVersion ||
    !input.first.includes(`version "${input.firstVersion}"`) ||
    !input.second.includes(`version "${input.secondVersion}"`)
  ) {
    throw new Error('lifecycle casks must declare two exact distinct versions');
  }
  if (normalizeLifecycleCask(input.first) !== normalizeLifecycleCask(input.second)) {
    throw new Error('lifecycle casks differ outside version, URL, or SHA-256 fields');
  }
};

type GoreleaserArtifact = Readonly<{
  name?: unknown;
  path?: unknown;
  type?: unknown;
  goos?: unknown;
  goarch?: unknown;
}>;

export type GoreleaserInventory = Readonly<{
  binaries: Readonly<Record<ReleaseTargetId, string>>;
  archives: Readonly<Record<ReleaseTargetId, string>>;
  checksumsPath: string;
  metadataPath: string;
  caskPath: string;
}>;

const artifactPath = (artifact: GoreleaserArtifact, label: string): string => {
  if (typeof artifact.path !== 'string' || !isAbsolute(artifact.path)) {
    throw new Error(`${label} artifact path is not absolute`);
  }
  return artifact.path;
};

export const validateGoreleaserInventory = (input: unknown): GoreleaserInventory => {
  if (!Array.isArray(input)) throw new Error('GoReleaser artifacts.json must be an array');
  const artifacts = input as GoreleaserArtifact[];
  const byType = (type: string) => artifacts.filter((artifact) => artifact.type === type);
  const binaries = byType('Binary');
  const archives = byType('Archive');
  const checksums = byType('Checksum');
  const metadata = byType('Metadata');
  const casks = byType('Homebrew Cask');
  if (
    binaries.length !== 4 ||
    archives.length !== 4 ||
    checksums.length !== 1 ||
    metadata.length !== 1 ||
    casks.length !== 1 ||
    artifacts.length !== 11
  ) {
    throw new Error('GoReleaser inventory does not contain the exact 11-artifact contract');
  }
  const selectTargets = (
    candidates: readonly GoreleaserArtifact[],
    label: string,
  ): Record<ReleaseTargetId, string> =>
    Object.fromEntries(
      RELEASE_TARGETS.map((target) => {
        const matches = candidates.filter(
          (candidate) => candidate.goos === target.goos && candidate.goarch === target.goarch,
        );
        if (matches.length !== 1) {
          throw new Error(`${label} inventory is not unique for ${target.id}`);
        }
        return [target.id, artifactPath(matches[0] ?? {}, `${target.id} ${label}`)];
      }),
    ) as Record<ReleaseTargetId, string>;
  if (checksums[0]?.name !== 'SHA256SUMS' || metadata[0]?.name !== 'metadata.json') {
    throw new Error('GoReleaser checksum or metadata artifact name drifted');
  }
  return {
    binaries: selectTargets(binaries, 'binary'),
    archives: selectTargets(archives, 'archive'),
    checksumsPath: artifactPath(checksums[0] ?? {}, 'checksum'),
    metadataPath: artifactPath(metadata[0] ?? {}, 'metadata'),
    caskPath: artifactPath(casks[0] ?? {}, 'cask'),
  };
};

export const resolveReleaseToolPath = (executables: readonly string[]): string => {
  if (executables.length === 0 || executables.some((path) => !isAbsolute(path))) {
    throw new Error('release tool paths must be nonempty absolute paths');
  }
  return [...new Set([...executables.map((path) => dirname(path)), '/usr/bin', '/bin'])].join(':');
};

const toolPath = (): string => {
  const ambientPath = process.env.PATH ?? '';
  const executables = [
    process.execPath,
    ...['goreleaser', 'npm', 'node', 'git', 'tar'].flatMap((name) => {
      const path = Bun.which(name, { PATH: ambientPath });
      return path === null ? [] : [path];
    }),
  ];
  return resolveReleaseToolPath(executables);
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
      `release subprocess failed (${child.exitCode}): ${basename(command[0] ?? 'unknown')}${
        detail ? `: ${detail.slice(0, 1000)}` : ''
      }`,
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

const inspectTarball = (
  path: string,
  allowedPaths: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): ArchiveEntry[] => {
  const lines = Buffer.from(runChecked(['tar', '-tvzf', path], { cwd, env, canaries: [] }).stdout)
    .toString('utf8')
    .split(/\r?\n/u)
    .filter(Boolean);
  if (lines.length !== allowedPaths.length) {
    throw new Error('tarball entry count does not match its closed layout');
  }
  const entries = lines.map((line) => {
    const matches = allowedPaths.filter((candidate) => line.endsWith(` ${candidate}`));
    if (matches.length !== 1) throw new Error('tarball contains an unexpected path');
    const pathName = matches[0] ?? '';
    const metadata = line
      .slice(10, -(pathName.length + 1))
      .trim()
      .split(/\s+/u);
    const ownerGroup = metadata.find((field) => field.includes('/'));
    const sizeText = ownerGroup === undefined ? metadata[3] : metadata[1];
    if (sizeText === undefined || !/^\d+$/u.test(sizeText)) {
      throw new Error('tarball entry size is not an unsigned decimal integer');
    }
    const [owner, group] = ownerGroup?.split('/') ?? [];
    return {
      path: pathName,
      type: 'file' as const,
      size: Number(sizeText),
      mode: permissionMode(line.slice(0, 10)),
      ...(owner === undefined ? {} : { owner }),
      ...(group === undefined ? {} : { group }),
    };
  });
  if (new Set(entries.map(({ path: pathName }) => pathName)).size !== allowedPaths.length) {
    throw new Error('tarball contains a duplicate or missing path');
  }
  return entries;
};

const extractTarEntry = (
  archivePath: string,
  entryPath: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Uint8Array =>
  runChecked(['tar', '-xOzf', archivePath, entryPath], { cwd, env, canaries: [] }).stdout;

const fileDigest = async (path: string): Promise<Readonly<{ sha256: string; bytes: number }>> => {
  const bytes = await readFile(path);
  return { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
};

const ensureExecutableHeader = async (path: string, target: ReleaseTarget): Promise<void> => {
  const bytes = await readFile(path);
  assertNativeBinarySize(bytes.byteLength);
  if (target.goos === 'linux') {
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error(`compiled binary header does not match ${target.id}`);
    }
    const machine = bytes.readUInt16LE(18);
    if (machine !== (target.goarch === 'arm64' ? 183 : 62)) {
      throw new Error(`compiled ELF architecture does not match ${target.id}`);
    }
    return;
  }
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`compiled binary header does not match ${target.id}`);
  }
  const cpu = bytes.readUInt32LE(4);
  if (cpu !== (target.goarch === 'arm64' ? 0x0100000c : 0x01000007)) {
    throw new Error(`compiled Mach-O architecture does not match ${target.id}`);
  }
};

const sourceCompletions = (
  repositoryRoot: string,
  env: Readonly<Record<string, string>>,
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
        { cwd: repositoryRoot, env, canaries: [] },
      );
      return [shell, result.stdout];
    }),
  ) as Record<'bash' | 'zsh' | 'fish', Uint8Array>;
  assertCompletionIdentity(output);
  return output;
};

const writeCompletionInputs = async (
  repositoryRoot: string,
  completions: Readonly<Record<'bash' | 'zsh' | 'fish', Uint8Array>>,
): Promise<void> => {
  const root = join(repositoryRoot, 'build', 'release-input', 'completions');
  await mkdir(root, { recursive: true });
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const path = join(repositoryRoot, 'build', 'release-input', COMPLETION_PATHS[shell]);
    await writeFile(path, completions[shell], { mode: 0o644 });
    await chmod(path, 0o644);
  }
};

const readTrackedManifest = async (
  path: string,
  expectedName: string,
): Promise<Record<string, unknown>> => {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (
    manifest.name !== expectedName ||
    manifest.version !== '0.0.0' ||
    manifest.scripts !== undefined
  ) {
    throw new Error(`tracked npm manifest is not a safe staging source: ${expectedName}`);
  }
  return manifest;
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await chmod(path, 0o644);
};

const packDirectory = (
  directory: string,
  outputRoot: string,
  env: Readonly<Record<string, string>>,
): string => {
  const npm = Bun.which('npm', { PATH: env.PATH });
  if (npm === null) throw new Error('npm is absent from the controlled tool path');
  const result = runChecked(
    [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', outputRoot],
    { cwd: directory, env, canaries: [] },
  );
  const resultJson = JSON.parse(Buffer.from(result.stdout).toString('utf8')) as unknown;
  const records = Array.isArray(resultJson)
    ? resultJson
    : resultJson !== null && typeof resultJson === 'object'
      ? Object.values(resultJson)
      : [];
  if (records.length !== 1 || typeof (records[0] as { filename?: unknown }).filename !== 'string') {
    throw new Error('npm pack did not report exactly one tarball');
  }
  return join(outputRoot, (records[0] as { filename: string }).filename);
};

export const stageTrackedNpmPackages = async (
  input: Readonly<{
    repositoryRoot: string;
    workRoot: string;
    outputRoot: string;
    version: string;
    binaries: Readonly<Record<ReleaseTargetId, string>>;
    completions: Readonly<Record<'bash' | 'zsh' | 'fish', Uint8Array>>;
    env: Readonly<Record<string, string>>;
  }>,
): Promise<Readonly<{ launcher: string } & Record<ReleaseTargetId, string>>> => {
  const npmRoot = join(input.outputRoot, 'npm');
  const stageRoot = join(input.workRoot, 'npm');
  await mkdir(npmRoot, { recursive: true });
  await mkdir(stageRoot, { recursive: true });
  const launcherRoot = join(stageRoot, 'launcher');
  await mkdir(join(launcherRoot, 'bin'), { recursive: true });
  await mkdir(join(launcherRoot, 'share', 'completions'), { recursive: true });
  const launcherManifest = await readTrackedManifest(
    join(input.repositoryRoot, 'packaging', 'npm', 'package.json'),
    '@smorinlabs/skillsmith',
  );
  const optionalDependencies = launcherManifest.optionalDependencies as
    | Record<string, unknown>
    | undefined;
  if (
    optionalDependencies === undefined ||
    Object.keys(optionalDependencies).length !== RELEASE_TARGETS.length ||
    Object.values(optionalDependencies).some((value) => value !== '0.0.0')
  ) {
    throw new Error('tracked launcher optional dependencies are not exact staging versions');
  }
  await writeJson(join(launcherRoot, 'package.json'), {
    ...launcherManifest,
    version: input.version,
    optionalDependencies: Object.fromEntries(
      Object.keys(optionalDependencies).map((name) => [name, input.version]),
    ),
  });
  await copyFile(
    join(input.repositoryRoot, 'packaging', 'npm', 'README.md'),
    join(launcherRoot, 'README.md'),
  );
  await copyFile(join(input.repositoryRoot, 'LICENSE'), join(launcherRoot, 'LICENSE'));
  await chmod(join(launcherRoot, 'README.md'), 0o644);
  await chmod(join(launcherRoot, 'LICENSE'), 0o644);
  await copyFile(
    join(input.repositoryRoot, 'packaging', 'npm', 'bin', 'skillsmith.cjs'),
    join(launcherRoot, 'bin', 'skillsmith.cjs'),
  );
  await chmod(join(launcherRoot, 'bin', 'skillsmith.cjs'), 0o755);
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const path = join(launcherRoot, 'share', COMPLETION_PATHS[shell]);
    await writeFile(path, input.completions[shell], { mode: 0o644 });
    await chmod(path, 0o644);
  }
  const launcher = packDirectory(launcherRoot, npmRoot, input.env);
  const payloads = {} as Record<ReleaseTargetId, string>;
  for (const target of RELEASE_TARGETS) {
    const root = join(stageRoot, target.id);
    await mkdir(join(root, 'bin'), { recursive: true });
    const name = `@smorinlabs/skillsmith-${target.id}`;
    const manifest = await readTrackedManifest(
      join(input.repositoryRoot, 'packaging', 'npm', 'platform', target.id, 'package.json'),
      name,
    );
    await writeJson(join(root, 'package.json'), { ...manifest, version: input.version });
    await copyFile(
      join(input.repositoryRoot, 'packaging', 'npm', 'README.md'),
      join(root, 'README.md'),
    );
    await copyFile(join(input.repositoryRoot, 'LICENSE'), join(root, 'LICENSE'));
    await chmod(join(root, 'README.md'), 0o644);
    await chmod(join(root, 'LICENSE'), 0o644);
    await link(input.binaries[target.id], join(root, 'bin', 'skillsmith'));
    await chmod(join(root, 'bin', 'skillsmith'), 0o755);
    payloads[target.id] = packDirectory(root, npmRoot, input.env);
  }
  return { launcher, ...payloads };
};

export type BuiltReleaseTarget = Readonly<{
  id: ReleaseTargetId;
  binaryPath: string;
  archivePath: string;
  npmPath: string;
  binarySha256: string;
  archiveSha256: string;
  npmBinarySha256: string;
}>;

export type BuildReleaseCandidateInput = Readonly<{
  repositoryRoot: string;
  stagingRoot: string;
  outputRoot: string;
  version: string;
  sourceRevision: string;
  target: 'all';
  canaries?: readonly string[];
}>;

export type BuildReleaseCandidateResult = Readonly<{
  outputRoot: string;
  version: string;
  sourceRevision: string;
  artifactsPath: string;
  metadataPath: string;
  checksumsPath: string;
  caskPath: string;
  launcherPath: string;
  targets: readonly BuiltReleaseTarget[];
}>;

export const buildReleaseCandidate = async (
  input: BuildReleaseCandidateInput,
): Promise<BuildReleaseCandidateResult> => {
  const repositoryRoot = resolve(input.repositoryRoot);
  const stagingRoot = resolve(input.stagingRoot);
  const outputRoot = resolve(input.outputRoot);
  const version = validateReleaseVersion(input.version);
  assertSourceRevision(input.sourceRevision);
  if (input.target !== 'all')
    throw new Error('standard release candidates require all four targets');
  await mkdir(stagingRoot, { recursive: true });
  const existingEntries = await readdir(outputRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  assertOwnedOutputRoot({ outputRoot, stagingRoot, existingEntries });

  const workRoot = await mkdtemp(join(stagingRoot, '.release-work-'));
  const isolatedHome = join(workRoot, 'home');
  const isolatedTemp = join(workRoot, 'tmp');
  await mkdir(isolatedHome, { recursive: true });
  await mkdir(isolatedTemp, { recursive: true });
  const env = createControlledBuildEnvironment({
    path: toolPath(),
    home: isolatedHome,
    tmpdir: isolatedTemp,
    tag: `v${version}`,
  });
  const goreleaser = Bun.which('goreleaser', { PATH: env.PATH });
  const npm = Bun.which('npm', { PATH: env.PATH });
  if (goreleaser === null || npm === null) {
    throw new Error('exact GoReleaser and npm tools must be installed before candidate build');
  }
  const goreleaserOutput = Buffer.from(
    runChecked([goreleaser, '--version'], { cwd: repositoryRoot, env, canaries: [] }).stdout,
  ).toString('utf8');
  const goreleaserVersion = goreleaserOutput.match(/GitVersion:\s*v?([^\s]+)/u)?.[1];
  const npmVersion = Buffer.from(
    runChecked([npm, '--version'], { cwd: repositoryRoot, env, canaries: [] }).stdout,
  )
    .toString('utf8')
    .trim();
  assertReleaseToolVersions({
    bun: Bun.version,
    goreleaser: goreleaserVersion ?? '',
    npm: npmVersion,
  });

  const revision = Buffer.from(
    runChecked(['git', 'rev-parse', '--verify', 'HEAD'], {
      cwd: repositoryRoot,
      env,
      canaries: [],
    }).stdout,
  )
    .toString('utf8')
    .trim();
  if (revision !== input.sourceRevision) {
    throw new Error('candidate source revision does not match repository HEAD');
  }

  try {
    const completions = sourceCompletions(repositoryRoot, env);
    await writeCompletionInputs(repositoryRoot, completions);
    const sourceConfig = await readFile(join(repositoryRoot, '.goreleaser.yaml'), 'utf8');
    if (!/^dist: dist\/release$/mu.test(sourceConfig)) {
      throw new Error('GoReleaser source config has an unexpected dist root');
    }
    const derivedConfig = sourceConfig.replace(
      /^dist: dist\/release$/mu,
      `dist: ${JSON.stringify(outputRoot)}`,
    );
    const configPath = join(workRoot, `goreleaser-${randomUUID()}.yaml`);
    await writeFile(configPath, derivedConfig, { mode: 0o600 });
    runChecked([goreleaser, 'release', '--snapshot', '--clean', '--config', configPath], {
      cwd: repositoryRoot,
      env,
      canaries: input.canaries ?? [],
    });

    const artifactsPath = join(outputRoot, 'artifacts.json');
    const inventory = validateGoreleaserInventory(
      JSON.parse(await readFile(artifactsPath, 'utf8')) as unknown,
    );
    const metadata = JSON.parse(await readFile(inventory.metadataPath, 'utf8')) as {
      version?: unknown;
      commit?: unknown;
      tag?: unknown;
    };
    if (
      metadata.version !== version ||
      metadata.commit !== input.sourceRevision ||
      metadata.tag !== `v${version}`
    ) {
      throw new Error('GoReleaser metadata does not match candidate identity');
    }
    const names = releaseArtifactNames(version);
    for (const target of RELEASE_TARGETS) {
      if (basename(inventory.archives[target.id]) !== names.archives[target.id]) {
        throw new Error(`archive name drifted for ${target.id}`);
      }
      await ensureExecutableHeader(inventory.binaries[target.id], target);
      validateArchiveEntries(
        inspectTarball(
          inventory.archives[target.id],
          Object.keys(ARCHIVE_LAYOUT),
          repositoryRoot,
          env,
        ),
      );
    }
    const npmPackages = await stageTrackedNpmPackages({
      repositoryRoot,
      workRoot,
      outputRoot,
      version,
      binaries: inventory.binaries,
      completions,
      env,
    });
    const targets: BuiltReleaseTarget[] = [];
    for (const target of RELEASE_TARGETS) {
      const binary = await fileDigest(inventory.binaries[target.id]);
      const archive = await fileDigest(inventory.archives[target.id]);
      assertNativeBinarySize(binary.bytes);
      validateNpmPackageEntries(
        'payload',
        inspectTarball(
          npmPackages[target.id],
          Object.keys(NPM_PACKAGE_LAYOUTS.payload),
          repositoryRoot,
          env,
        ),
      );
      const npmBinary = extractTarEntry(
        npmPackages[target.id],
        'package/bin/skillsmith',
        repositoryRoot,
        env,
      );
      const archiveBinary = extractTarEntry(
        inventory.archives[target.id],
        'skillsmith',
        repositoryRoot,
        env,
      );
      assertSingleLineage({
        raw: binary.sha256,
        archive: sha256Hex(archiveBinary),
        npm: sha256Hex(npmBinary),
      });
      targets.push({
        id: target.id,
        binaryPath: inventory.binaries[target.id],
        archivePath: inventory.archives[target.id],
        npmPath: npmPackages[target.id],
        binarySha256: binary.sha256,
        archiveSha256: archive.sha256,
        npmBinarySha256: sha256Hex(npmBinary),
      });
    }
    validateNpmPackageEntries(
      'launcher',
      inspectTarball(
        npmPackages.launcher,
        Object.keys(NPM_PACKAGE_LAYOUTS.launcher),
        repositoryRoot,
        env,
      ),
    );
    const checksumLines = (await readFile(inventory.checksumsPath, 'utf8')).trimEnd().split('\n');
    const expectedArchives = Object.values(names.archives).toSorted();
    if (
      checksumLines.length !== 4 ||
      checksumLines.some((line) => !/^[0-9a-f]{64} {2}[^\s]+$/u.test(line)) ||
      checksumLines
        .map((line) => line.slice(66))
        .toSorted()
        .join('\n') !== expectedArchives.join('\n')
    ) {
      throw new Error('GoReleaser checksum closure is invalid');
    }
    const cask = await readFile(inventory.caskPath, 'utf8');
    if (
      !cask.includes('binary "skillsmith"') ||
      /preflight|postflight|xattr|quarantine|curl|system\s+["']sh/u.test(cask)
    ) {
      throw new Error('generated cask contains a missing binary stanza or forbidden bypass');
    }
    if ((input.canaries ?? []).length > 0) {
      const outputFiles: Record<string, Uint8Array> = {};
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await visit(path);
          else if (entry.isFile()) outputFiles[relative(outputRoot, path)] = await readFile(path);
        }
      };
      await visit(outputRoot);
      assertNoReleaseLeaks({ canaries: input.canaries ?? [], outputs: outputFiles });
    }
    return {
      outputRoot,
      version,
      sourceRevision: input.sourceRevision,
      artifactsPath,
      metadataPath: inventory.metadataPath,
      checksumsPath: inventory.checksumsPath,
      caskPath: inventory.caskPath,
      launcherPath: npmPackages.launcher,
      targets,
    };
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
};

const directInstallPaths = (prefix: string) => ({
  binary: join(prefix, 'bin', 'skillsmith'),
  bash: join(prefix, 'share', 'bash-completion', 'completions', 'skillsmith'),
  zsh: join(prefix, 'share', 'zsh', 'site-functions', '_skillsmith'),
  fish: join(prefix, 'share', 'fish', 'vendor_completions.d', 'skillsmith.fish'),
});

export const installDirectArchive = async (
  input: Readonly<{ archivePath: string; prefix: string }>,
): Promise<Readonly<Record<'binary' | 'bash' | 'zsh' | 'fish', string>>> => {
  const extractRoot = await mkdtemp(join(tmpdir(), 'skillsmith-direct-install-'));
  const env = createControlledBuildEnvironment({
    path: toolPath(),
    home: join(extractRoot, 'home'),
    tmpdir: join(extractRoot, 'tmp'),
    tag: 'v0.0.0',
  });
  try {
    validateArchiveEntries(
      inspectTarball(resolve(input.archivePath), Object.keys(ARCHIVE_LAYOUT), extractRoot, env),
    );
    runChecked(['tar', '-xpzf', resolve(input.archivePath), '-C', extractRoot], {
      cwd: extractRoot,
      env,
      canaries: [],
    });
    for (const path of Object.keys(ARCHIVE_LAYOUT)) {
      const metadata = await lstat(join(extractRoot, path));
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`extracted archive entry is not a regular file: ${path}`);
      }
    }
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
