import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

setDefaultTimeout(300_000);

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
  stageTrackedNpmPackages?: (
    input: Readonly<{
      repositoryRoot: string;
      workRoot: string;
      outputRoot: string;
      version: string;
      binaries: Readonly<Record<string, string>>;
      completions: Readonly<Record<'bash' | 'zsh' | 'fish', Uint8Array>>;
      env: Readonly<Record<string, string>>;
    }>,
  ) => Promise<Readonly<{ launcher: string } & Record<string, string>>>;
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

const runAsync = async (
  command: readonly string[],
  options: Readonly<{ cwd: string; env: Readonly<Record<string, string>> }>,
) => {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
};

const tarEntry = (archive: string, path: string): Uint8Array => {
  const result = Bun.spawnSync(['tar', '-xOzf', archive, path], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error('could not read packed package metadata');
  return result.stdout;
};

type RegistryHarness = Readonly<{
  origin: string;
  requests: string[];
  unexpected: string[];
  stop: () => void;
}>;

const digest = (algorithm: 'sha1' | 'sha512', value: Uint8Array): Buffer =>
  createHash(algorithm).update(value).digest();

const startRegistry = async (
  candidateInput: Candidate | readonly Candidate[],
): Promise<RegistryHarness> => {
  const candidates = Array.isArray(candidateInput) ? candidateInput : [candidateInput];
  const requests: string[] = [];
  const unexpected: string[] = [];
  const tarballPaths = candidates.flatMap((candidate) => [
    candidate.launcherPath,
    ...candidate.targets.map(({ npmPath }) => npmPath),
  ]);
  const packages = new Map<
    string,
    Map<
      string,
      Readonly<{ manifest: Record<string, unknown>; filename: string; bytes: Uint8Array }>
    >
  >();
  for (const path of tarballPaths) {
    const manifest = JSON.parse(
      Buffer.from(tarEntry(path, 'package/package.json')).toString('utf8'),
    ) as Record<string, unknown>;
    if (typeof manifest.name !== 'string') throw new Error('packed package name is absent');
    if (typeof manifest.version !== 'string') throw new Error('packed package version is absent');
    const versions = packages.get(manifest.name) ?? new Map();
    versions.set(manifest.version, {
      manifest,
      filename: path.split('/').at(-1) ?? '',
      bytes: await readFile(path),
    });
    packages.set(manifest.name, versions);
  }
  let origin = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method !== 'GET') {
        unexpected.push(`${request.method} ${url.pathname}`);
        return new Response('method not allowed', { status: 405 });
      }
      if (url.pathname.startsWith('/tarballs/')) {
        const filename = decodeURIComponent(url.pathname.slice('/tarballs/'.length));
        const record = [...packages.values()]
          .flatMap((versions) => [...versions.values()])
          .find((candidatePackage) => candidatePackage.filename === filename);
        if (record === undefined) {
          unexpected.push(`GET ${url.pathname}`);
          return new Response('unknown tarball', { status: 404 });
        }
        return new Response(record.bytes, {
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      const versions = packages.get(name);
      if (versions === undefined) {
        unexpected.push(`GET ${url.pathname}`);
        return new Response('unknown package', { status: 404 });
      }
      const metadata = Object.fromEntries(
        [...versions.entries()].map(([version, record]) => [
          version,
          {
            ...record.manifest,
            dist: {
              tarball: `${origin}/tarballs/${record.filename}`,
              shasum: digest('sha1', record.bytes).toString('hex'),
              integrity: `sha512-${digest('sha512', record.bytes).toString('base64')}`,
            },
          },
        ]),
      );
      const latest = candidates.at(-1)?.version;
      if (latest === undefined) throw new Error('registry has no candidate versions');
      return Response.json({
        name,
        'dist-tags': { latest },
        versions: metadata,
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    requests,
    unexpected,
    stop: () => server.stop(true),
  };
};

const startDenyServer = () => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).href}`);
      return new Response('external network denied by EWP-P6-TS01', { status: 502 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
};

const startArchiveServer = async (candidateInput: Candidate | readonly Candidate[]) => {
  const candidates = Array.isArray(candidateInput) ? candidateInput : [candidateInput];
  const requests: string[] = [];
  const unexpected: string[] = [];
  const archives = new Map<string, Uint8Array>();
  for (const candidate of candidates) {
    for (const target of candidate.targets) {
      archives.set(target.archivePath.split('/').at(-1) ?? '', await readFile(target.archivePath));
    }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const filename = decodeURIComponent(url.pathname.slice(1));
      const bytes = archives.get(filename);
      if (bytes === undefined || !['GET', 'HEAD'].includes(request.method)) {
        unexpected.push(`${request.method} ${url.pathname}`);
        return new Response('unknown archive', { status: 404 });
      }
      return new Response(request.method === 'HEAD' ? null : bytes, {
        headers: {
          'content-length': String(bytes.byteLength),
          'content-type': 'application/gzip',
        },
      });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    unexpected,
    stop: () => server.stop(true),
  };
};

const lifecycleCask = (candidate: Candidate, origin: string): string => {
  const targets = Object.fromEntries(candidate.targets.map((target) => [target.id, target]));
  const branch = (targetId: string, indentation: string): string => {
    const target = targets[targetId];
    if (target === undefined) throw new Error(`fixture target is absent: ${targetId}`);
    const filename = target.archivePath.split('/').at(-1);
    if (filename === undefined) throw new Error(`fixture archive name is absent: ${targetId}`);
    return `${indentation}url "${origin.replace(/\/$/u, '')}/${filename}"
${indentation}sha256 "${target.archiveSha256}"`;
  };
  return `cask "skillsmith" do
  version "${candidate.version}"

  on_arm do
    on_macos do
${branch('darwin-arm64', '      ')}
    end
    on_linux do
${branch('linux-arm64', '      ')}
    end
  end
  on_intel do
    on_macos do
${branch('darwin-x64', '      ')}
    end
    on_linux do
${branch('linux-x64', '      ')}
    end
  end

  name "SkillSmith"
  desc "Immutable G6 lifecycle fixture"
  homepage "https://github.com/smorinlabs/skillsmith"

  binary "skillsmith"
  bash_completion "completions/skillsmith.bash"
  zsh_completion "completions/_skillsmith"
  fish_completion "completions/skillsmith.fish"
end
`;
};

const createLifecycleCandidate = async (
  version: '0.0.0-g6-fixture.1' | '0.0.0-g6-fixture.2',
): Promise<Candidate> => {
  const release = await api();
  const fixture = release.FIXTURE_EXECUTABLES?.[version];
  if (fixture === undefined || release.stageTrackedNpmPackages === undefined) {
    throw new Error('immutable lifecycle fixture adapter is absent');
  }
  const root = await mkdtemp(join(tmpdir(), `skillsmith-g6-${version}-`));
  temporaryRoots.push(root);
  const outputRoot = join(root, 'candidate');
  const workRoot = join(root, 'work');
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  await Promise.all(
    [outputRoot, workRoot, home, temp].map((path) => mkdir(path, { recursive: true })),
  );
  const completions = {} as Record<'bash' | 'zsh' | 'fish', Uint8Array>;
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const completion = runCli(['completion', shell]);
    if (completion.exitCode !== 0)
      throw new Error(`could not generate ${shell} fixture completion`);
    completions[shell] = completion.stdout;
  }
  release.assertCompletionIdentity?.(completions);

  const binaries = {} as Record<string, string>;
  const targetDrafts: Array<Omit<CandidateTarget, 'npmPath'>> = [];
  for (const target of EXPECTED_TARGETS) {
    const binaryPath = join(outputRoot, 'raw', target.id, 'skillsmith');
    const archiveRoot = join(workRoot, 'archives', target.id);
    await mkdir(dirname(binaryPath), { recursive: true });
    await mkdir(join(archiveRoot, 'completions'), { recursive: true });
    await writeFile(binaryPath, fixture.bytes, { mode: 0o755 });
    await writeFile(join(archiveRoot, 'skillsmith'), fixture.bytes, { mode: 0o755 });
    await chmod(binaryPath, 0o755);
    await chmod(join(archiveRoot, 'skillsmith'), 0o755);
    await writeFile(join(archiveRoot, 'LICENSE'), await readFile(join(ROOT, 'LICENSE')), {
      mode: 0o644,
    });
    await chmod(join(archiveRoot, 'LICENSE'), 0o644);
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const path = join(archiveRoot, String(EXPECTED_COMPLETIONS[shell].path));
      await writeFile(path, completions[shell], { mode: 0o644 });
      await chmod(path, 0o644);
    }
    const archivePath = join(outputRoot, `skillsmith-v${version}-${target.id}.tar.gz`);
    const ownership =
      process.platform === 'darwin'
        ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
        : ['--owner=root', '--group=root'];
    const packed = Bun.spawnSync(
      [
        'tar',
        ...ownership,
        '-czf',
        archivePath,
        '-C',
        archiveRoot,
        'LICENSE',
        'completions/_skillsmith',
        'completions/skillsmith.bash',
        'completions/skillsmith.fish',
        'skillsmith',
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    if (packed.exitCode !== 0) {
      throw new Error(`could not pack ${target.id} fixture: ${packed.stderr.toString()}`);
    }
    binaries[target.id] = binaryPath;
    targetDrafts.push({
      id: target.id,
      binaryPath,
      archivePath,
      binarySha256: fixture.sha256,
      archiveSha256: sha256(await readFile(archivePath)),
      npmBinarySha256: fixture.sha256,
    });
  }
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: temp,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
  };
  const npmPackages = await release.stageTrackedNpmPackages({
    repositoryRoot: ROOT,
    workRoot,
    outputRoot,
    version,
    binaries,
    completions,
    env,
  });
  const targets: CandidateTarget[] = targetDrafts.map((target) => ({
    ...target,
    npmPath: npmPackages[target.id] ?? '',
  }));
  const checksumsPath = join(outputRoot, 'SHA256SUMS');
  await writeFile(
    checksumsPath,
    `${targets
      .map((target) => `${target.archiveSha256}  ${target.archivePath.split('/').at(-1) ?? ''}`)
      .toSorted()
      .join('\n')}\n`,
  );
  const artifactsPath = join(outputRoot, 'artifacts.json');
  const metadataPath = join(outputRoot, 'metadata.json');
  await writeFile(artifactsPath, '[]\n');
  await writeFile(metadataPath, `${JSON.stringify({ version })}\n`);
  const provisional: Candidate = {
    outputRoot,
    version,
    sourceRevision: HEX_40,
    artifactsPath,
    metadataPath,
    checksumsPath,
    caskPath: join(outputRoot, 'homebrew', 'Casks', 'skillsmith.rb'),
    launcherPath: npmPackages.launcher,
    targets,
  };
  await mkdir(dirname(provisional.caskPath), { recursive: true });
  await writeFile(provisional.caskPath, lifecycleCask(provisional, 'http://127.0.0.1'));
  return provisional;
};

const createPrivateToolPath = async (tools: readonly ('bun' | 'node' | 'npm' | 'sh')[]) => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-g6-tools-'));
  temporaryRoots.push(root);
  for (const tool of tools) {
    const source = tool === 'bun' ? process.execPath : Bun.which(tool);
    if (source === null) throw new Error(`required test tool is absent: ${tool}`);
    await symlink(source, join(root, tool));
  }
  return root;
};

const installedPackageNames = async (root: string): Promise<string[]> => {
  const names: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === 'package.json') {
        const metadata = JSON.parse(await readFile(path, 'utf8')) as { name?: string };
        if (metadata.name?.startsWith('@smorinlabs/skillsmith') === true) {
          names.push(metadata.name.slice('@smorinlabs/'.length));
        }
      }
    }
  };
  await visit(root);
  return names.toSorted();
};

const installedPackageRoot = async (root: string, expectedName: string): Promise<string> => {
  let match: string | undefined;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === 'package.json') {
        const metadata = JSON.parse(await readFile(path, 'utf8')) as { name?: string };
        if (metadata.name === expectedName) {
          if (match !== undefined)
            throw new Error(`installed package is duplicated: ${expectedName}`);
          match = directory;
        }
      }
    }
  };
  await visit(root);
  if (match === undefined) throw new Error(`installed package is absent: ${expectedName}`);
  return match;
};

const runPackageUpgradeLane = async (
  lane: 'npm' | 'bun',
  candidates: readonly [Candidate, Candidate],
  registry: RegistryHarness,
  denyOrigin: string,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-g6-${lane}-upgrade-`));
  temporaryRoots.push(root);
  const prefix = join(root, 'prefix');
  const home = join(root, 'home');
  const cache = join(root, 'cache');
  const work = join(root, 'work');
  const temp = join(root, 'tmp');
  await Promise.all(
    [prefix, home, cache, work, temp].map((path) => mkdir(path, { recursive: true })),
  );
  const toolPath = await createPrivateToolPath(
    lane === 'npm' ? ['sh', 'node', 'npm'] : ['sh', 'bun'],
  );
  const environment = {
    PATH: toolPath,
    HOME: home,
    TMPDIR: temp,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: denyOrigin,
    HTTPS_PROXY: denyOrigin,
    http_proxy: denyOrigin,
    https_proxy: denyOrigin,
    NO_UPDATE_NOTIFIER: '1',
    npm_config_update_notifier: 'false',
    ...(lane === 'bun' ? { BUN_INSTALL: prefix } : {}),
  };
  const userConfig = join(root, 'npmrc');
  await writeFile(userConfig, '', { mode: 0o600 });
  const packageRoot =
    lane === 'npm'
      ? join(prefix, 'lib', 'node_modules')
      : join(prefix, 'install', 'global', 'node_modules');
  const executable = join(prefix, 'bin', 'skillsmith');
  for (const candidate of candidates) {
    const command =
      lane === 'npm'
        ? [
            join(toolPath, 'npm'),
            'install',
            '--global',
            '--prefix',
            prefix,
            '--registry',
            registry.origin,
            '--cache',
            cache,
            '--userconfig',
            userConfig,
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--loglevel',
            'error',
            `@smorinlabs/skillsmith@${candidate.version}`,
          ]
        : [
            join(toolPath, 'bun'),
            'add',
            '--global',
            '--exact',
            '--registry',
            registry.origin,
            '--cache-dir',
            cache,
            '--ignore-scripts',
            `@smorinlabs/skillsmith@${candidate.version}`,
          ];
    const install = await runAsync(command, { cwd: work, env: environment });
    expect(install.exitCode, `${lane}/${candidate.version}: ${install.stderr.toString()}`).toBe(0);
    expect(await installedPackageNames(packageRoot), `${lane}/${candidate.version}`).toEqual([
      'skillsmith',
      `skillsmith-${hostTargetId()}`,
    ]);
    const version = await runAsync([executable, 'version'], { cwd: work, env: environment });
    expect(version.exitCode, `${lane}/${candidate.version}: ${version.stderr.toString()}`).toBe(0);
    expect(version.stdout.toString().trim(), lane).toBe(candidate.version);
    const expected = candidate.targets.find(({ id }) => id === hostTargetId());
    expect(expected).toBeDefined();
    const payloadRoot = await installedPackageRoot(
      packageRoot,
      `@smorinlabs/skillsmith-${hostTargetId()}`,
    );
    const payload = join(payloadRoot, 'bin', 'skillsmith');
    expect(sha256(await readFile(payload)), `${lane}/${candidate.version}`).toBe(
      expected?.binarySha256,
    );
    const launcherRoot = await installedPackageRoot(packageRoot, '@smorinlabs/skillsmith');
    const completionRoot = join(launcherRoot, 'share');
    for (const [shell, contract] of Object.entries(EXPECTED_COMPLETIONS)) {
      expect(
        sha256(await readFile(join(completionRoot, String(contract.path)))),
        `${lane}/${candidate.version}/${shell}`,
      ).toBe(contract.sha256);
    }
  }
  const uninstallCommand =
    lane === 'npm'
      ? [
          join(toolPath, 'npm'),
          'uninstall',
          '--global',
          '--prefix',
          prefix,
          '--cache',
          cache,
          '--userconfig',
          userConfig,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--loglevel',
          'error',
          '@smorinlabs/skillsmith',
          `@smorinlabs/skillsmith-${hostTargetId()}`,
        ]
      : [
          join(toolPath, 'bun'),
          'remove',
          '--global',
          '--cache-dir',
          cache,
          '@smorinlabs/skillsmith',
          `@smorinlabs/skillsmith-${hostTargetId()}`,
        ];
  const uninstall = await runAsync(uninstallCommand, { cwd: work, env: environment });
  expect(uninstall.exitCode, `${lane}: ${uninstall.stderr.toString()}`).toBe(0);
  expect(await installedPackageNames(packageRoot)).toEqual([]);
  expect(await pathExists(executable)).toBeFalse();
};

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
    expect(config).toContain('skillsmith-v{{ .Version }}-{{ .Os }}-{{ if eq .Arch "amd64" }}x64');
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
    expect(sums.map((line) => line.slice(66))).toEqual(
      sums.map((line) => line.slice(66)).toSorted(),
    );
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

    const candidate = await getCandidate();
    const registry = await startRegistry(candidate);
    const deny = startDenyServer();
    try {
      for (const lane of ['npm', 'bun'] as const) {
        const installRoot = await mkdtemp(join(tmpdir(), `skillsmith-g6-${lane}-install-`));
        temporaryRoots.push(installRoot);
        const prefix = join(installRoot, 'prefix');
        const home = join(installRoot, 'home');
        const cache = join(installRoot, 'cache');
        const work = join(installRoot, 'work');
        const temp = join(installRoot, 'tmp');
        await Promise.all(
          [prefix, home, cache, work, temp].map((path) => mkdir(path, { recursive: true })),
        );
        const toolPath = await createPrivateToolPath(
          lane === 'npm' ? ['sh', 'node', 'npm'] : ['sh', 'bun'],
        );
        const environment = {
          PATH: toolPath,
          HOME: home,
          TMPDIR: temp,
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_CACHE_HOME: join(home, 'cache'),
          XDG_DATA_HOME: join(home, 'data'),
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          TZ: 'UTC',
          NO_COLOR: '1',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
          HTTP_PROXY: deny.origin,
          HTTPS_PROXY: deny.origin,
          http_proxy: deny.origin,
          https_proxy: deny.origin,
          NO_UPDATE_NOTIFIER: '1',
          npm_config_update_notifier: 'false',
          ...(lane === 'bun' ? { BUN_INSTALL: prefix } : {}),
        };
        const userConfig = join(installRoot, 'npmrc');
        await writeFile(userConfig, '', { mode: 0o600 });
        const installCommand =
          lane === 'npm'
            ? [
                join(toolPath, 'npm'),
                'install',
                '--global',
                '--prefix',
                prefix,
                '--registry',
                registry.origin,
                '--cache',
                cache,
                '--userconfig',
                userConfig,
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                '--loglevel',
                'error',
                `@smorinlabs/skillsmith@${candidate.version}`,
              ]
            : [
                join(toolPath, 'bun'),
                'add',
                '--global',
                '--exact',
                '--registry',
                registry.origin,
                '--cache-dir',
                cache,
                '--ignore-scripts',
                `@smorinlabs/skillsmith@${candidate.version}`,
              ];
        const install = await runAsync(installCommand, { cwd: work, env: environment });
        expect(install.exitCode, `${lane}: ${install.stderr.toString()}`).toBe(0);
        const packageRoot =
          lane === 'npm'
            ? join(prefix, 'lib', 'node_modules')
            : join(prefix, 'install', 'global', 'node_modules');
        expect(await installedPackageNames(packageRoot), lane).toEqual([
          'skillsmith',
          `skillsmith-${hostTargetId()}`,
        ]);
        const executable = join(prefix, 'bin', 'skillsmith');
        const version = await runAsync([executable, 'version'], { cwd: work, env: environment });
        expect(version.exitCode, `${lane}: ${version.stderr.toString()}`).toBe(0);
        expect(version.stdout.toString().trim(), lane).toBe(candidate.version);
        const help = await runAsync([executable, '--help'], { cwd: work, env: environment });
        expect(help.exitCode, lane).toBe(0);
        expect(help.stdout.toString(), lane).toContain('SkillSmith');
        for (const [shell, expected] of Object.entries(EXPECTED_COMPLETIONS)) {
          const completion = await runAsync([executable, 'completion', shell], {
            cwd: work,
            env: environment,
          });
          expect(completion.exitCode, `${lane}/${shell}`).toBe(0);
          expect(sha256(completion.stdout), `${lane}/${shell}`).toBe(expected.sha256);
        }
        expect(Bun.which(lane === 'npm' ? 'bun' : 'node', { PATH: toolPath })).toBeNull();
        const uninstallCommand =
          lane === 'npm'
            ? [
                join(toolPath, 'npm'),
                'uninstall',
                '--global',
                '--prefix',
                prefix,
                '--cache',
                cache,
                '--userconfig',
                userConfig,
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                '--loglevel',
                'error',
                '@smorinlabs/skillsmith',
                `@smorinlabs/skillsmith-${hostTargetId()}`,
              ]
            : [
                join(toolPath, 'bun'),
                'remove',
                '--global',
                '--cache-dir',
                cache,
                '@smorinlabs/skillsmith',
                `@smorinlabs/skillsmith-${hostTargetId()}`,
              ];
        const uninstall = await runAsync(uninstallCommand, { cwd: work, env: environment });
        expect(uninstall.exitCode, `${lane}: ${uninstall.stderr.toString()}`).toBe(0);
        expect(await installedPackageNames(packageRoot)).toEqual([]);
        expect(await pathExists(executable)).toBeFalse();
      }

      const omitRoot = await mkdtemp(join(tmpdir(), 'skillsmith-g6-omit-optional-'));
      temporaryRoots.push(omitRoot);
      const prefix = join(omitRoot, 'prefix');
      const cache = join(omitRoot, 'cache');
      const work = join(omitRoot, 'work');
      const home = join(omitRoot, 'home');
      await Promise.all(
        [prefix, cache, work, home].map((path) => mkdir(path, { recursive: true })),
      );
      const toolPath = await createPrivateToolPath(['sh', 'bun']);
      const environment = {
        PATH: toolPath,
        HOME: home,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        HTTP_PROXY: deny.origin,
        HTTPS_PROXY: deny.origin,
        BUN_INSTALL: prefix,
      };
      const omitted = await runAsync(
        [
          join(toolPath, 'bun'),
          'add',
          '--global',
          '--exact',
          '--registry',
          registry.origin,
          '--cache-dir',
          cache,
          '--ignore-scripts',
          '--omit',
          'optional',
          `@smorinlabs/skillsmith@${candidate.version}`,
        ],
        { cwd: work, env: environment },
      );
      expect(omitted.exitCode, omitted.stderr.toString()).toBe(0);
      expect(
        await installedPackageNames(join(prefix, 'install', 'global', 'node_modules')),
      ).toEqual(['skillsmith']);
      const missing = await runAsync([join(prefix, 'bin', 'skillsmith'), 'version'], {
        cwd: work,
        env: environment,
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toContain('reinstall without --omit=optional');
      expect(registry.unexpected).toEqual([]);
      expect(deny.requests).toEqual([]);
    } finally {
      registry.stop();
      deny.stop();
    }
  });

  test('family 7: generated binary cask, bounded loopback derivation, no bypass, and Homebrew supported-platform receipt', async () => {
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
      expect(cask, target.id).toContain(`skillsmith-v#{version}-${target.id}.tar.gz`);
    }
    const fixture = release.deriveProductionCaskFixture?.({
      cask,
      origin: 'http://127.0.0.1:43117',
    });
    expect(fixture).toContain('http://127.0.0.1:43117');
    expect(cask).not.toContain('127.0.0.1');

    if (process.env.P17_G6_01_HOMEBREW_RECEIPT !== '1') return;
    expect(process.env.RUNNER_OS).toBe('macOS');
    expect(process.platform).toBe('darwin');
    expect(process.arch).toBe('arm64');
    expect(process.env.RUNNER_ARCH).toBe('ARM64');
    const brew = Bun.which('brew');
    const ruby = Bun.which('ruby');
    if (brew === null || ruby === null) {
      throw new Error('supported Homebrew receipt requires brew and Ruby');
    }
    const receiptRoot = await mkdtemp(join(tmpdir(), 'skillsmith-g6-homebrew-receipt-'));
    temporaryRoots.push(receiptRoot);
    const home = join(receiptRoot, 'home');
    const cache = join(receiptRoot, 'cache');
    const temp = join(receiptRoot, 'tmp');
    await Promise.all([home, cache, temp].map((path) => mkdir(path, { recursive: true })));
    const archiveServer = await startArchiveServer(candidate);
    const deny = startDenyServer();
    const environment = {
      PATH: [
        dirname(brew),
        dirname(process.execPath),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].join(':'),
      HOME: home,
      TMPDIR: temp,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'xdg-cache'),
      XDG_DATA_HOME: join(home, 'data'),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      NO_COLOR: '1',
      HOMEBREW_CACHE: cache,
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_INSTALL_FROM_API: '1',
      HOMEBREW_NO_ANALYTICS: '1',
      HOMEBREW_NO_ENV_HINTS: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      HTTP_PROXY: deny.origin,
      HTTPS_PROXY: deny.origin,
      http_proxy: deny.origin,
      https_proxy: deny.origin,
    };
    const runBrew = async (command: readonly string[], cwd = receiptRoot): Promise<string> => {
      const result = await runAsync(command, { cwd, env: environment });
      if (result.exitCode !== 0) {
        throw new Error(
          `Homebrew receipt failed (${result.exitCode}): ${command.join(' ')}: ${result.stderr
            .toString()
            .slice(0, 2000)}`,
        );
      }
      return result.stdout.toString().trim();
    };
    const tapName = 'p17/g6-receipt';
    const qualifiedCask = `${tapName}/skillsmith`;
    let tapped = false;
    let installed = false;
    try {
      await runBrew([brew, 'tap-new', tapName]);
      tapped = true;
      const tapRoot = await runBrew([brew, '--repository', tapName]);
      const caskRoot = join(tapRoot, 'Casks');
      const caskPath = join(caskRoot, 'skillsmith.rb');
      await mkdir(caskRoot, { recursive: true });
      const localCask = release.deriveProductionCaskFixture?.({
        cask,
        origin: archiveServer.origin,
      });
      if (localCask === undefined) throw new Error('bounded production cask fixture is absent');
      await writeFile(caskPath, localCask, { mode: 0o644 });
      await chmod(caskPath, 0o644);
      await runBrew([ruby, '-c', caskPath]);
      await runBrew([brew, 'install', '--cask', qualifiedCask]);
      installed = true;
      const brewPrefix = await runBrew([brew, '--prefix']);
      const binary = join(brewPrefix, 'bin', 'skillsmith');
      const version = await runBrew([binary, 'version']);
      expect(version).toBe(candidate.version);
      const selected = candidate.targets.find(({ id }) => id === 'darwin-arm64');
      if (selected === undefined) throw new Error('Darwin arm64 candidate is absent');
      expect(sha256(await readFile(binary))).toBe(selected.binarySha256);
      const completionPaths = {
        bash: join(brewPrefix, 'etc', 'bash_completion.d', 'skillsmith'),
        zsh: join(brewPrefix, 'share', 'zsh', 'site-functions', '_skillsmith'),
        fish: join(brewPrefix, 'share', 'fish', 'vendor_completions.d', 'skillsmith.fish'),
      } as const;
      for (const [shell, path] of Object.entries(completionPaths)) {
        expect(sha256(await readFile(path)), shell).toBe(
          EXPECTED_COMPLETIONS[shell as keyof typeof EXPECTED_COMPLETIONS].sha256,
        );
      }
      await runBrew([brew, 'uninstall', '--cask', '--force', qualifiedCask]);
      installed = false;
      expect(await pathExists(binary)).toBeFalse();
      for (const path of Object.values(completionPaths)) expect(await pathExists(path)).toBeFalse();
      await runBrew([brew, 'untap', '--force', tapName]);
      tapped = false;
      expect(archiveServer.unexpected).toEqual([]);
      expect(deny.requests).toEqual([]);
      const archiveRoute = `/${selected.archivePath.split('/').at(-1) ?? ''}`;
      expect(new Set(archiveServer.requests)).toEqual(
        new Set([`HEAD ${archiveRoute}`, `GET ${archiveRoute}`]),
      );
      process.stdout.write(
        `P17-G6-01-HOMEBREW-RECEIPT ${JSON.stringify({
          sourceRevision: candidate.sourceRevision,
          version: candidate.version,
          selectedArchiveSha256: selected.archiveSha256,
          installedBinarySha256: selected.binarySha256,
          skippedTests: 0,
          productionCaskUnchanged: true,
          quarantineBypass: false,
        })}\n`,
      );
    } finally {
      if (installed) {
        await runAsync([brew, 'uninstall', '--cask', '--force', qualifiedCask], {
          cwd: receiptRoot,
          env: environment,
        });
      }
      if (tapped) {
        await runAsync([brew, 'untap', '--force', tapName], {
          cwd: receiptRoot,
          env: environment,
        });
      }
      archiveServer.stop();
      deny.stop();
    }
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

  test('family 9: immutable two-version fixtures across direct/npm/Bun and Homebrew supported-platform upgrade', async () => {
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

    const candidates = [
      await createLifecycleCandidate('0.0.0-g6-fixture.1'),
      await createLifecycleCandidate('0.0.0-g6-fixture.2'),
    ] as const;
    const fixtureCasks = await Promise.all(
      candidates.map((candidate) => readFile(candidate.caskPath, 'utf8')),
    );
    release.assertLifecycleCaskPair?.({
      first: fixtureCasks[0],
      second: fixtureCasks[1],
      firstVersion: candidates[0].version,
      secondVersion: candidates[1].version,
    });
    for (const [index, cask] of fixtureCasks.entries()) {
      expect(cask.match(/^\s*url "/gmu), `fixture ${index + 1}`).toHaveLength(4);
      expect(cask.match(/^\s*sha256 "[0-9a-f]{64}"$/gmu), `fixture ${index + 1}`).toHaveLength(4);
    }

    if (
      release.installDirectArchive === undefined ||
      release.uninstallDirectArchive === undefined
    ) {
      throw new Error('direct archive lifecycle adapter is absent');
    }
    const directPrefix = await mkdtemp(join(tmpdir(), 'skillsmith-g6-direct-upgrade-'));
    temporaryRoots.push(directPrefix);
    let directPaths: Readonly<Record<'binary' | 'bash' | 'zsh' | 'fish', string>> | undefined;
    for (const candidate of candidates) {
      const selected = candidate.targets.find(({ id }) => id === hostTargetId());
      if (selected === undefined) throw new Error('host lifecycle archive is absent');
      directPaths = await release.installDirectArchive({
        archivePath: selected.archivePath,
        prefix: directPrefix,
      });
      const version = Bun.spawnSync([directPaths.binary, 'version'], {
        cwd: directPrefix,
        env: { PATH: '/usr/bin:/bin', HOME: directPrefix, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(version.exitCode, version.stderr.toString()).toBe(0);
      expect(version.stdout.toString().trim()).toBe(candidate.version);
      expect(sha256(await readFile(directPaths.binary))).toBe(selected.binarySha256);
      for (const [shell, path] of Object.entries(directPaths).filter(
        ([name]) => name !== 'binary',
      )) {
        expect(sha256(await readFile(path)), shell).toBe(
          EXPECTED_COMPLETIONS[shell as keyof typeof EXPECTED_COMPLETIONS].sha256,
        );
      }
    }
    await release.uninstallDirectArchive({ prefix: directPrefix });
    if (directPaths === undefined) throw new Error('direct fixture lifecycle did not run');
    for (const path of Object.values(directPaths)) expect(await pathExists(path)).toBeFalse();

    const registry = await startRegistry(candidates);
    const deny = startDenyServer();
    try {
      await runPackageUpgradeLane('npm', candidates, registry, deny.origin);
      await runPackageUpgradeLane('bun', candidates, registry, deny.origin);
      expect(registry.unexpected).toEqual([]);
      expect(deny.requests).toEqual([]);
    } finally {
      registry.stop();
      deny.stop();
    }

    const production = await getCandidate();
    const leakOutputs: Record<string, Uint8Array | string> = {
      checksums: await readFile(production.checksumsPath),
      cask: await readFile(production.caskPath),
    };
    for (const target of production.targets) {
      leakOutputs[`raw-${target.id}`] = await readFile(target.binaryPath);
      leakOutputs[`archive-${target.id}`] = tarEntry(target.archivePath, 'skillsmith');
      leakOutputs[`npm-${target.id}`] = tarEntry(target.npmPath, 'package/bin/skillsmith');
    }
    release.assertNoReleaseLeaks?.({
      canaries: candidates.flatMap(({ version }) => [version]),
      outputs: leakOutputs,
    });

    if (process.env.P17_G6_01_HOMEBREW_RECEIPT !== '1') return;
    expect(process.env.RUNNER_OS).toBe('macOS');
    expect(process.platform).toBe('darwin');
    expect(process.arch).toBe('arm64');
    const brew = Bun.which('brew');
    const ruby = Bun.which('ruby');
    if (brew === null || ruby === null)
      throw new Error('Homebrew lifecycle requires brew and Ruby');
    const receiptRoot = await mkdtemp(join(tmpdir(), 'skillsmith-g6-homebrew-upgrade-'));
    temporaryRoots.push(receiptRoot);
    const home = join(receiptRoot, 'home');
    const cache = join(receiptRoot, 'cache');
    const temp = join(receiptRoot, 'tmp');
    await Promise.all([home, cache, temp].map((path) => mkdir(path, { recursive: true })));
    const archiveServer = await startArchiveServer(candidates);
    const brewDeny = startDenyServer();
    const environment = {
      PATH: [dirname(brew), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      HOME: home,
      TMPDIR: temp,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'xdg-cache'),
      XDG_DATA_HOME: join(home, 'data'),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      NO_COLOR: '1',
      HOMEBREW_CACHE: cache,
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_INSTALL_FROM_API: '1',
      HOMEBREW_NO_ANALYTICS: '1',
      HOMEBREW_NO_ENV_HINTS: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      HTTP_PROXY: brewDeny.origin,
      HTTPS_PROXY: brewDeny.origin,
      http_proxy: brewDeny.origin,
      https_proxy: brewDeny.origin,
    };
    const runBrew = async (command: readonly string[]): Promise<string> => {
      const result = await runAsync(command, { cwd: receiptRoot, env: environment });
      if (result.exitCode !== 0) {
        throw new Error(
          `Homebrew upgrade failed (${result.exitCode}): ${command.join(' ')}: ${result.stderr
            .toString()
            .slice(0, 2000)}`,
        );
      }
      return result.stdout.toString().trim();
    };
    const tapName = 'p17/g6-lifecycle';
    const qualifiedCask = `${tapName}/skillsmith`;
    let tapped = false;
    let installed = false;
    try {
      await runBrew([brew, 'tap-new', tapName]);
      tapped = true;
      const tapRoot = await runBrew([brew, '--repository', tapName]);
      const caskPath = join(tapRoot, 'Casks', 'skillsmith.rb');
      await mkdir(dirname(caskPath), { recursive: true });
      const localCasks = candidates.map((candidate) =>
        lifecycleCask(candidate, archiveServer.origin),
      );
      release.assertLifecycleCaskPair?.({
        first: localCasks[0],
        second: localCasks[1],
        firstVersion: candidates[0].version,
        secondVersion: candidates[1].version,
      });
      await writeFile(caskPath, localCasks[0], { mode: 0o644 });
      await runBrew([ruby, '-c', caskPath]);
      await runBrew([brew, 'install', '--cask', qualifiedCask]);
      installed = true;
      const brewPrefix = await runBrew([brew, '--prefix']);
      const binary = join(brewPrefix, 'bin', 'skillsmith');
      expect(await runBrew([binary, 'version'])).toBe(candidates[0].version);
      expect(sha256(await readFile(binary))).toBe(first?.sha256);
      await writeFile(caskPath, localCasks[1], { mode: 0o644 });
      await runBrew([ruby, '-c', caskPath]);
      await runBrew([brew, 'upgrade', '--cask', qualifiedCask]);
      expect(await runBrew([binary, 'version'])).toBe(candidates[1].version);
      expect(sha256(await readFile(binary))).toBe(second?.sha256);
      const completionPaths = {
        bash: join(brewPrefix, 'etc', 'bash_completion.d', 'skillsmith'),
        zsh: join(brewPrefix, 'share', 'zsh', 'site-functions', '_skillsmith'),
        fish: join(brewPrefix, 'share', 'fish', 'vendor_completions.d', 'skillsmith.fish'),
      } as const;
      for (const [shell, path] of Object.entries(completionPaths)) {
        expect(sha256(await readFile(path)), shell).toBe(
          EXPECTED_COMPLETIONS[shell as keyof typeof EXPECTED_COMPLETIONS].sha256,
        );
      }
      await runBrew([brew, 'uninstall', '--cask', '--force', qualifiedCask]);
      installed = false;
      expect(await pathExists(binary)).toBeFalse();
      for (const path of Object.values(completionPaths)) expect(await pathExists(path)).toBeFalse();
      await runBrew([brew, 'untap', '--force', tapName]);
      tapped = false;
      expect(archiveServer.unexpected).toEqual([]);
      expect(brewDeny.requests).toEqual([]);
      const expectedRoutes = candidates.flatMap((candidate) => {
        const selected = candidate.targets.find(({ id }) => id === 'darwin-arm64');
        if (selected === undefined) throw new Error('Darwin arm64 lifecycle archive is absent');
        const route = `/${selected.archivePath.split('/').at(-1) ?? ''}`;
        return [`HEAD ${route}`, `GET ${route}`];
      });
      expect(new Set(archiveServer.requests)).toEqual(new Set(expectedRoutes));
      for (const route of expectedRoutes) {
        expect(
          archiveServer.requests.filter((request) => request === route).length,
        ).toBeGreaterThanOrEqual(1);
      }
      process.stdout.write(
        `P17-G6-01-HOMEBREW-UPGRADE-RECEIPT ${JSON.stringify({
          firstVersion: candidates[0].version,
          secondVersion: candidates[1].version,
          firstSha256: first?.sha256,
          secondSha256: second?.sha256,
          skippedTests: 0,
          quarantineBypass: false,
        })}\n`,
      );
    } finally {
      if (installed) {
        await runAsync([brew, 'uninstall', '--cask', '--force', qualifiedCask], {
          cwd: receiptRoot,
          env: environment,
        });
      }
      if (tapped) {
        await runAsync([brew, 'untap', '--force', tapName], {
          cwd: receiptRoot,
          env: environment,
        });
      }
      archiveServer.stop();
      brewDeny.stop();
    }
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
    expect(workflow).toContain('npm@12.0.1');
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
