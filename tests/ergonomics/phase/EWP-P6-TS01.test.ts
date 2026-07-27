import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
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
  buildReleaseCandidate?: (input: unknown) => Promise<BuiltCandidate>;
  installDirectArchive?: (input: unknown) => Promise<InstalledPaths>;
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

type BuiltCandidate = Readonly<{
  outputRoot: string;
  version: string;
  sourceRevision: string;
  launcherPath: string | null;
  manifestPath: string | null;
  formulaPath: string | null;
  targets: readonly Readonly<{
    target: ReleaseTarget;
    binarySha256: string;
    archivePath: string;
    archiveSha256: string;
    npmPath: string;
  }>[];
}>;

type InstalledPaths = Readonly<Record<'binary' | 'bash' | 'zsh' | 'fish', string>>;

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

const temporaryRoots: string[] = [];
afterAll(async () => {
  await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true })));
});

const hostTargetId = (): string => {
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
  if (id === null) throw new Error(`unsupported test host: ${process.platform}/${process.arch}`);
  return id;
};

const buildCandidate = async (
  version: string,
  fixtureBytes?: Uint8Array,
  allTargets = false,
  sourceRevision = HEX_40,
): Promise<BuiltCandidate> => {
  const api = await releaseApi();
  if (api.buildReleaseCandidate === undefined) throw new Error('release builder is absent');
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-g6-candidate-'));
  temporaryRoots.push(root);
  const stagingRoot = join(root, 'staging');
  await mkdir(stagingRoot, { recursive: true });
  const targetId = hostTargetId();
  return api.buildReleaseCandidate({
    repositoryRoot: ROOT,
    stagingRoot,
    outputRoot: join(stagingRoot, 'candidate'),
    version,
    sourceRevision,
    target: allTargets ? 'all' : 'host',
    compileFlags: [
      '--compile',
      '--bytecode',
      '--env=disable',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
    ],
    ...(fixtureBytes === undefined
      ? { canaries: ['P17_G6_SECRET_CANARY_DO_NOT_PACKAGE', ROOT] }
      : {
          fixture: true,
          binaryOverrides: Object.fromEntries(
            (allTargets ? EXPECTED_TARGETS.map(({ id }) => id) : [targetId]).map((id) => [
              id,
              fixtureBytes,
            ]),
          ),
          canaries: ['P17_G6_FIXTURE_CANARY_DO_NOT_PACKAGE', ROOT],
        }),
  });
};

let actualHostCandidate: Promise<BuiltCandidate> | undefined;
const getActualHostCandidate = async (): Promise<BuiltCandidate> => {
  if (actualHostCandidate === undefined) {
    const rootPackage = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    actualHostCandidate = buildCandidate(rootPackage.version);
  }
  return actualHostCandidate;
};

let actualAllCandidate: Promise<BuiltCandidate> | undefined;
const getActualAllCandidate = async (): Promise<BuiltCandidate> => {
  if (actualAllCandidate === undefined) {
    actualAllCandidate = (async () => {
      const rootPackage = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
        version: string;
      };
      const revision = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (revision.exitCode !== 0) throw new Error('source revision is unavailable');
      return buildCandidate(
        rootPackage.version,
        undefined,
        true,
        revision.stdout.toString().trim(),
      );
    })();
  }
  return actualAllCandidate;
};

let lifecycleCandidates: Promise<readonly BuiltCandidate[]> | undefined;
const getLifecycleCandidates = async (): Promise<readonly BuiltCandidate[]> => {
  if (lifecycleCandidates === undefined) {
    lifecycleCandidates = (async () => {
      const api = await releaseApi();
      const candidates: BuiltCandidate[] = [];
      for (const version of ['0.0.0-g6-fixture.1', '0.0.0-g6-fixture.2'] as const) {
        const fixture = api.FIXTURE_EXECUTABLES?.[version];
        if (fixture === undefined) throw new Error(`release fixture is absent: ${version}`);
        candidates.push(await buildCandidate(version, fixture.bytes, true));
      }
      return candidates;
    })();
  }
  return lifecycleCandidates;
};

const runInstalled = (binary: string, args: readonly string[]) =>
  Bun.spawnSync([binary, ...args], {
    cwd: dirname(binary),
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: dirname(dirname(binary)),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      NO_COLOR: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

type RegistryHarness = Readonly<{
  origin: string;
  requests: string[];
  unexpected: string[];
  stop: () => void;
}>;

type LoopbackServer = Readonly<{
  origin: string;
  requests: string[];
  stop: () => void;
}>;

const digest = (algorithm: 'sha1' | 'sha512', value: Uint8Array): Buffer =>
  createHash(algorithm).update(value).digest();

const startRegistry = async (
  candidates: readonly BuiltCandidate[],
  api: ReleaseArtifactsApi,
): Promise<RegistryHarness> => {
  if (api.renderLauncherPackageJson === undefined || api.renderPayloadPackageJson === undefined) {
    throw new Error('package metadata renderers are absent');
  }
  if (candidates.length === 0) throw new Error('registry candidate set is empty');
  const requests: string[] = [];
  const unexpected: string[] = [];
  const tarballs = new Map<string, Uint8Array>();
  for (const candidate of candidates) {
    if (candidate.launcherPath === null) throw new Error('candidate launcher is absent');
    const launcherFilename = candidate.launcherPath.split('/').at(-1);
    if (launcherFilename === undefined) throw new Error('launcher filename is absent');
    tarballs.set(launcherFilename, await readFile(candidate.launcherPath));
    for (const target of candidate.targets) {
      const filename = target.npmPath.split('/').at(-1);
      if (filename === undefined) throw new Error('payload filename is absent');
      tarballs.set(filename, await readFile(target.npmPath));
    }
  }

  let origin = '';
  const packageDocuments = new Map<string, unknown>();
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
        const bytes = tarballs.get(filename);
        if (bytes === undefined) {
          unexpected.push(`GET ${url.pathname}`);
          return new Response('unknown tarball', { status: 404 });
        }
        return new Response(bytes, {
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      const packageName = decodeURIComponent(url.pathname.slice(1));
      const document = packageDocuments.get(packageName);
      if (document === undefined) {
        unexpected.push(`GET ${url.pathname}`);
        return new Response('unknown package', { status: 404 });
      }
      return Response.json(document, {
        headers: { 'cache-control': 'no-store' },
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;

  const packageVersion = (
    metadata: Record<string, unknown>,
    filename: string | undefined,
  ): Record<string, unknown> => {
    const bytes = filename === undefined ? undefined : tarballs.get(filename);
    const placeholder = Buffer.alloc(64);
    return {
      ...metadata,
      dist: {
        tarball: `${origin}/tarballs/${filename ?? 'incompatible-platform-not-served.tgz'}`,
        shasum: (bytes === undefined
          ? placeholder.subarray(0, 20)
          : digest('sha1', bytes)
        ).toString('hex'),
        integrity: `sha512-${(bytes === undefined ? placeholder : digest('sha512', bytes)).toString('base64')}`,
      },
    };
  };
  const latest = candidates.at(-1);
  if (latest === undefined) throw new Error('registry latest candidate is absent');
  const launcherVersions = Object.fromEntries(
    candidates.map((candidate) => {
      if (candidate.launcherPath === null) throw new Error('candidate launcher is absent');
      const filename = candidate.launcherPath.split('/').at(-1);
      return [
        candidate.version,
        packageVersion(
          api.renderLauncherPackageJson?.(candidate.version) as Record<string, unknown>,
          filename,
        ),
      ];
    }),
  );
  packageDocuments.set('@smorinlabs/skillsmith', {
    name: '@smorinlabs/skillsmith',
    'dist-tags': { latest: latest.version },
    versions: launcherVersions,
  });
  for (const target of EXPECTED_TARGETS) {
    const packageName = `@smorinlabs/skillsmith-${target.id}`;
    const versions = Object.fromEntries(
      candidates.map((candidate) => {
        const built = candidate.targets.find((entry) => entry.target.id === target.id);
        const filename = built?.npmPath.split('/').at(-1);
        const metadata = api.renderPayloadPackageJson?.(target.id, candidate.version) as Record<
          string,
          unknown
        >;
        return [candidate.version, packageVersion(metadata, filename)];
      }),
    );
    packageDocuments.set(packageName, {
      name: packageName,
      'dist-tags': { latest: latest.version },
      versions,
    });
  }
  return {
    origin,
    requests,
    unexpected,
    stop: () => server.stop(true),
  };
};

const startArchiveServer = async (
  candidates: readonly BuiltCandidate[],
): Promise<LoopbackServer & Readonly<{ unexpected: string[] }>> => {
  const requests: string[] = [];
  const unexpected: string[] = [];
  const archives = new Map<string, Uint8Array>();
  for (const candidate of candidates) {
    for (const target of candidate.targets) {
      const filename = target.archivePath.split('/').at(-1);
      if (filename === undefined) throw new Error('archive filename is absent');
      archives.set(filename, await readFile(target.archivePath));
    }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const filename = decodeURIComponent(url.pathname.slice(1));
      const bytes = request.method === 'GET' ? archives.get(filename) : undefined;
      if (bytes === undefined) {
        unexpected.push(`${request.method} ${url.pathname}`);
        return new Response('unknown release archive', { status: 404 });
      }
      return new Response(bytes, { headers: { 'content-type': 'application/gzip' } });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    unexpected,
    stop: () => server.stop(true),
  };
};

const startDenyServer = (): LoopbackServer => {
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

const installedPackageNames = async (root: string): Promise<string[]> => {
  const names: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === 'package.json') {
        const metadata = JSON.parse(await readFile(path, 'utf8')) as { name?: string };
        if (metadata.name?.startsWith('@smorinlabs/skillsmith') === true) {
          names.push(metadata.name.slice('@smorinlabs/'.length));
        }
      }
    }
  };
  await visit(root);
  return names.sort();
};

const createLauncherPropagationFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-g6-launcher-propagation-'));
  temporaryRoots.push(root);
  const launcherPath = join(root, 'package', 'bin', 'skillsmith.cjs');
  const payloadRoot = join(
    root,
    'package',
    'node_modules',
    '@smorinlabs',
    `skillsmith-${hostTargetId()}`,
  );
  await Promise.all([
    mkdir(dirname(launcherPath), { recursive: true }),
    mkdir(join(payloadRoot, 'bin'), { recursive: true }),
  ]);
  await copyFile(LAUNCHER_SOURCE, launcherPath);
  await chmod(launcherPath, 0o755);
  await writeFile(
    join(payloadRoot, 'package.json'),
    `${JSON.stringify({ name: `@smorinlabs/skillsmith-${hostTargetId()}`, version: '0.0.0-propagation' })}\n`,
    { mode: 0o644 },
  );
  const binary = join(payloadRoot, 'bin', 'skillsmith');
  await writeFile(
    binary,
    `#!/bin/sh
case "\${1-}" in
  argv)
    shift
    for argument in "$@"; do printf 'argv<%s>\\n' "$argument"; done
    ;;
  stdio)
    IFS= read -r input
    printf 'stdout<%s>\\n' "$input"
    printf 'stderr<%s>\\n' "$input" >&2
    ;;
  exit)
    exit "\${2-1}"
    ;;
  signal)
    trap 'trap - TERM; kill -TERM $$' TERM
    printf 'ready\\n'
    while :; do IFS= read -r _; done
    ;;
esac
`,
    { mode: 0o755 },
  );
  await chmod(binary, 0o755);
  return launcherPath;
};

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

    expect(buildSource).toContain('--env=disable');
    expect(buildSource).toContain('--no-compile-autoload-dotenv');
    expect(buildSource).toContain('--no-compile-autoload-bunfig');
    if (api.installDirectArchive === undefined || api.uninstallDirectArchive === undefined) return;

    const candidate = await getActualHostCandidate();
    const built = candidate.targets[0];
    expect(candidate.targets).toHaveLength(1);
    expect(built?.target.id).toBe(hostTargetId());
    if (built === undefined) return;

    const prefix = await mkdtemp(join(tmpdir(), 'skillsmith-g6-direct-'));
    temporaryRoots.push(prefix);
    const installed = await api.installDirectArchive({
      archivePath: built.archivePath,
      prefix,
    });
    expect(sha256(await readFile(installed.binary))).toBe(built.binarySha256);
    expect((await stat(installed.binary)).mode & 0o777).toBe(0o755);
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const expected = EXPECTED_COMPLETIONS[shell];
      const bytes = await readFile(installed[shell]);
      expect((await stat(installed[shell])).mode & 0o777, shell).toBe(0o644);
      expect(bytes.byteLength, shell).toBe(expected.bytes);
      expect(sha256(bytes), shell).toBe(expected.sha256);
    }

    const version = runInstalled(installed.binary, ['version']);
    expect(version.exitCode).toBe(0);
    expect(version.stderr.toString()).toBe('');
    expect(version.stdout.toString().trim()).toBe(candidate.version);
    const help = runInstalled(installed.binary, ['--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stderr.toString()).toBe('');
    expect(help.stdout.toString()).toContain('SkillSmith');
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const completion = runInstalled(installed.binary, ['completion', shell]);
      expect(completion.exitCode, shell).toBe(0);
      expect(completion.stderr.toString(), shell).toBe('');
      expect(sha256(completion.stdout), shell).toBe(EXPECTED_COMPLETIONS[shell].sha256);
    }
    await api.uninstallDirectArchive({ prefix });
    for (const path of Object.values(installed)) await expect(access(path)).rejects.toThrow();

    const lifecyclePrefix = await mkdtemp(join(tmpdir(), 'skillsmith-g6-direct-lifecycle-'));
    temporaryRoots.push(lifecyclePrefix);
    let lifecyclePaths: InstalledPaths | undefined;
    for (const expectedVersion of ['0.0.0-g6-fixture.1', '0.0.0-g6-fixture.2'] as const) {
      const fixture = api.FIXTURE_EXECUTABLES?.[expectedVersion];
      expect(fixture).toBeDefined();
      if (fixture === undefined) return;
      const fixtureCandidate = await buildCandidate(expectedVersion, fixture.bytes);
      const fixtureTarget = fixtureCandidate.targets[0];
      expect(fixtureTarget).toBeDefined();
      if (fixtureTarget === undefined) return;
      lifecyclePaths = await api.installDirectArchive({
        archivePath: fixtureTarget.archivePath,
        prefix: lifecyclePrefix,
      });
      const observed = runInstalled(lifecyclePaths.binary, ['version']);
      expect(observed.exitCode, expectedVersion).toBe(0);
      expect(observed.stdout.toString().trim(), expectedVersion).toBe(expectedVersion);
      expect(sha256(await readFile(lifecyclePaths.binary)), expectedVersion).toBe(fixture.sha256);
    }
    expect(lifecyclePaths).toBeDefined();
    await api.uninstallDirectArchive({ prefix: lifecyclePrefix });
    if (lifecyclePaths !== undefined) {
      for (const path of Object.values(lifecyclePaths))
        await expect(access(path)).rejects.toThrow();
    }
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
      await chmod(probe, 0o755);
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
        expect(child.exitCode, runtime).toBe(1);
        expect(child.stderr.toString(), runtime).toContain(
          `skillsmith native payload @smorinlabs/skillsmith-${hostTargetId()} is missing; reinstall without --omit=optional`,
        );
      }
      const emptyPath = join(temporary, 'empty-path');
      await mkdir(emptyPath);
      const noRuntime = Bun.spawnSync([probe, 'version'], {
        cwd: temporary,
        env: { PATH: emptyPath },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(noRuntime.exitCode).toBe(1);
      expect(noRuntime.stdout.toString()).toBe('');
      expect(noRuntime.stderr.toString()).toBe('skillsmith requires Bun or Node.js\n');

      const node = Bun.which('node');
      if (node === null) throw new Error('Node is absent');
      const unsupported = Bun.spawnSync(
        [
          node,
          '-e',
          `Object.defineProperty(process, 'platform', { value: 'win32' }); Object.defineProperty(process, 'arch', { value: 'x64' }); require(${JSON.stringify(probe)});`,
        ],
        { cwd: temporary, stdout: 'pipe', stderr: 'pipe' },
      );
      expect(unsupported.exitCode).toBe(1);
      expect(unsupported.stderr.toString()).toBe(
        'skillsmith does not support win32/x64; supported platforms are macOS and glibc Linux on arm64 or x64\n',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }

    const propagationLauncher = await createLauncherPropagationFixture();
    for (const runtime of ['node', 'bun']) {
      const argv = await runAsync(
        [runtime, propagationLauncher, 'argv', 'plain', 'two words', '--flag=value', ''],
        {
          cwd: dirname(propagationLauncher),
          env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        },
      );
      expect(argv.exitCode, runtime).toBe(0);
      expect(argv.stdout.toString(), runtime).toBe(
        'argv<plain>\nargv<two words>\nargv<--flag=value>\nargv<>\n',
      );
      const stdio = Bun.spawnSync([runtime, propagationLauncher, 'stdio'], {
        cwd: dirname(propagationLauncher),
        env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        stdin: Buffer.from('round trip\n'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(stdio.exitCode, runtime).toBe(0);
      expect(stdio.stdout.toString(), runtime).toBe('stdout<round trip>\n');
      expect(stdio.stderr.toString(), runtime).toBe('stderr<round trip>\n');
      const numericExit = await runAsync([runtime, propagationLauncher, 'exit', '23'], {
        cwd: dirname(propagationLauncher),
        env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      });
      expect(numericExit.exitCode, runtime).toBe(23);

      const signaled = Bun.spawn([runtime, propagationLauncher, 'signal'], {
        cwd: dirname(propagationLauncher),
        env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const reader = signaled.stdout.getReader();
      const ready = await reader.read();
      expect(Buffer.from(ready.value ?? []).toString('utf8'), runtime).toContain('ready\n');
      reader.releaseLock();
      signaled.kill('SIGTERM');
      expect(await signaled.exited, runtime).toBe(143);
      expect(signaled.signalCode, runtime).toBe('SIGTERM');
    }

    const candidate = await getActualHostCandidate();
    const fixtureCandidates = await getLifecycleCandidates();
    expect(candidate.launcherPath).not.toBeNull();
    const registry = await startRegistry([candidate, ...fixtureCandidates], api);
    const deny = startDenyServer();
    try {
      for (const lane of ['npm', 'bun'] as const) {
        const root = await mkdtemp(join(tmpdir(), `skillsmith-g6-${lane}-`));
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
        const env = {
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
          NO_UPDATE_NOTIFIER: '1',
          npm_config_update_notifier: 'false',
          HTTP_PROXY: deny.origin,
          HTTPS_PROXY: deny.origin,
          http_proxy: deny.origin,
          https_proxy: deny.origin,
          ...(lane === 'bun' ? { BUN_INSTALL: prefix } : {}),
        };
        let executable: string;
        let packageRoot: string;
        let installVersion: (version: string) => Promise<Awaited<ReturnType<typeof runAsync>>>;
        let uninstall: () => Promise<Awaited<ReturnType<typeof runAsync>>>;
        if (lane === 'npm') {
          const userConfig = join(root, 'npmrc');
          await writeFile(userConfig, '', { mode: 0o600 });
          installVersion = (version) =>
            runAsync(
              [
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
                `@smorinlabs/skillsmith@${version}`,
              ],
              { cwd: work, env },
            );
          uninstall = () =>
            runAsync(
              [
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
              ],
              { cwd: work, env },
            );
          executable = join(prefix, 'bin', 'skillsmith');
          packageRoot = join(prefix, 'lib', 'node_modules');
        } else {
          installVersion = (version) =>
            runAsync(
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
                `@smorinlabs/skillsmith@${version}`,
              ],
              { cwd: work, env },
            );
          uninstall = () =>
            runAsync(
              [
                join(toolPath, 'bun'),
                'remove',
                '--global',
                '--cache-dir',
                cache,
                '@smorinlabs/skillsmith',
                `@smorinlabs/skillsmith-${hostTargetId()}`,
              ],
              { cwd: work, env },
            );
          executable = join(prefix, 'bin', 'skillsmith');
          packageRoot = join(prefix, 'install', 'global', 'node_modules');
        }
        const install = await installVersion(candidate.version);
        expect(install.exitCode, `${lane}: ${install.stderr.toString()}`).toBe(0);
        expect(
          await installedPackageNames(packageRoot),
          `${lane}: registry requests ${JSON.stringify(registry.requests)}; unexpected ${JSON.stringify(registry.unexpected)}`,
        ).toEqual(['skillsmith', `skillsmith-${hostTargetId()}`]);
        const version = await runAsync([executable, 'version'], { cwd: work, env });
        expect(version.exitCode, `${lane}: ${version.stderr.toString()}`).toBe(0);
        expect(version.stdout.toString().trim(), lane).toBe(candidate.version);
        const help = await runAsync([executable, '--help'], { cwd: work, env });
        expect(help.exitCode, `${lane}: ${help.stderr.toString()}`).toBe(0);
        expect(help.stdout.toString(), lane).toContain('SkillSmith');
        for (const shell of ['bash', 'zsh', 'fish'] as const) {
          const completion = await runAsync([executable, 'completion', shell], { cwd: work, env });
          expect(completion.exitCode, `${lane}/${shell}`).toBe(0);
          expect(sha256(completion.stdout), `${lane}/${shell}`).toBe(
            EXPECTED_COMPLETIONS[shell].sha256,
          );
        }
        if (lane === 'npm') {
          expect(Bun.which('bun', { PATH: toolPath })).toBeNull();
        } else {
          expect(Bun.which('node', { PATH: toolPath })).toBeNull();
        }
        for (const fixtureCandidate of fixtureCandidates) {
          const upgrade = await installVersion(fixtureCandidate.version);
          expect(upgrade.exitCode, `${lane}: ${upgrade.stderr.toString()}`).toBe(0);
          expect(await installedPackageNames(packageRoot), lane).toEqual([
            'skillsmith',
            `skillsmith-${hostTargetId()}`,
          ]);
          const fixtureVersion = await runAsync([executable, 'version'], { cwd: work, env });
          expect(fixtureVersion.exitCode, `${lane}: ${fixtureVersion.stderr.toString()}`).toBe(0);
          expect(fixtureVersion.stdout.toString().trim(), lane).toBe(fixtureCandidate.version);
        }
        const removed = await uninstall();
        expect(removed.exitCode, `${lane}: ${removed.stderr.toString()}`).toBe(0);
        await expect(access(executable)).rejects.toThrow();
        expect(await installedPackageNames(packageRoot)).toEqual([]);
      }

      expect(registry.requests.length).toBeGreaterThan(0);
      expect(registry.unexpected).toEqual([]);
      expect(deny.requests).toEqual([]);
    } finally {
      registry.stop();
      deny.stop();
    }
  });

  test('family 6: omit-optional installs only the actionable launcher failure', async () => {
    const api = await releaseApi();
    const candidate = (await getLifecycleCandidates())[0];
    if (candidate === undefined) throw new Error('omit-optional fixture candidate is absent');
    const registry = await startRegistry([candidate], api);
    const deny = startDenyServer();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-g6-omit-optional-'));
    temporaryRoots.push(root);
    const prefix = join(root, 'prefix');
    const home = join(root, 'home');
    const cache = join(root, 'cache');
    const work = join(root, 'work');
    const temp = join(root, 'tmp');
    await Promise.all(
      [prefix, home, cache, work, temp].map((path) => mkdir(path, { recursive: true })),
    );
    const tools = await createPrivateToolPath(['sh', 'bun']);
    const env = {
      PATH: tools,
      HOME: home,
      TMPDIR: temp,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_DATA_HOME: join(home, 'data'),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      NO_COLOR: '1',
      BUN_INSTALL: prefix,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      HTTP_PROXY: deny.origin,
      HTTPS_PROXY: deny.origin,
    };
    try {
      const install = await runAsync(
        [
          join(tools, 'bun'),
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
        { cwd: work, env },
      );
      expect(install.exitCode, install.stderr.toString()).toBe(0);
      expect(
        await installedPackageNames(join(prefix, 'install', 'global', 'node_modules')),
      ).toEqual(['skillsmith']);
      const execution = await runAsync([join(prefix, 'bin', 'skillsmith'), 'version'], {
        cwd: work,
        env,
      });
      expect(execution.exitCode).toBe(1);
      expect(execution.stderr.toString()).toContain(
        `skillsmith native payload @smorinlabs/skillsmith-${hostTargetId()} is missing; reinstall without --omit=optional`,
      );
      expect(registry.unexpected).toEqual([]);
      expect(deny.requests).toEqual([]);
    } finally {
      registry.stop();
      deny.stop();
    }
  });

  test('family 7: Homebrew formula model owns four branches and a prefix lifecycle', async () => {
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

    if (
      api.renderHomebrewFormula === undefined ||
      api.installDirectArchive === undefined ||
      api.uninstallDirectArchive === undefined
    ) {
      return;
    }
    const candidates = await getLifecycleCandidates();
    const prefix = await mkdtemp(join(tmpdir(), 'skillsmith-g6-formula-prefix-'));
    temporaryRoots.push(prefix);
    let installed: InstalledPaths | undefined;
    for (const candidate of candidates) {
      expect(candidate.formulaPath).not.toBeNull();
      if (candidate.formulaPath === null) return;
      const hashes = Object.fromEntries(
        candidate.targets.map((target) => [target.target.id, target.archiveSha256]),
      );
      const publicFormula = await readFile(candidate.formulaPath, 'utf8');
      expect(publicFormula).toBe(
        api.renderHomebrewFormula({ version: candidate.version, archiveSha256: hashes }),
      );
      const loopbackOrigin = 'http://127.0.0.1:43117/releases';
      const fixtureFormula = api.renderHomebrewFormula({
        version: candidate.version,
        archiveSha256: hashes,
        origin: loopbackOrigin,
      });
      expect(fixtureFormula).toBe(
        publicFormula.replaceAll(
          `https://github.com/smorinlabs/skillsmith/releases/download/v${candidate.version}`,
          loopbackOrigin,
        ),
      );
      for (const target of candidate.targets) {
        expect(publicFormula, target.target.id).toContain(
          `skillsmith-v${candidate.version}-${target.target.id}.tar.gz`,
        );
        expect(publicFormula, target.target.id).toContain(`sha256 "${target.archiveSha256}"`);
      }
      const host = candidate.targets.find((target) => target.target.id === hostTargetId());
      expect(host).toBeDefined();
      if (host === undefined) return;
      installed = await api.installDirectArchive({ archivePath: host.archivePath, prefix });
      const observed = runInstalled(installed.binary, ['version']);
      expect(observed.exitCode, candidate.version).toBe(0);
      expect(observed.stdout.toString().trim(), candidate.version).toBe(candidate.version);
      for (const shell of ['bash', 'zsh', 'fish'] as const) {
        expect(sha256(await readFile(installed[shell])), shell).toBe(
          EXPECTED_COMPLETIONS[shell].sha256,
        );
      }
    }
    expect(installed).toBeDefined();
    await api.uninstallDirectArchive({ prefix });
    if (installed !== undefined) {
      for (const path of Object.values(installed)) await expect(access(path)).rejects.toThrow();
    }
  });

  test('family 7: Homebrew supported-platform receipt', async () => {
    if (process.env.P17_G6_01_HOMEBREW_RECEIPT !== '1') return;
    expect(process.env.RUNNER_OS).toBe('macOS');
    expect(process.platform).toBe('darwin');
    expect(process.arch).toBe('arm64');
    expect(process.env.RUNNER_ARCH).toBe('ARM64');
    expect(process.env.ImageOS).toBeTruthy();
    expect(process.env.ImageVersion).toBeTruthy();

    const brew = Bun.which('brew');
    const ruby = Bun.which('ruby');
    const tar = Bun.which('tar');
    if (brew === null || ruby === null || tar === null) {
      throw new Error('supported Homebrew receipt requires brew, Ruby, and tar');
    }
    expect(Bun.version).toBe('1.3.14');
    const receiptRoot = await mkdtemp(join(tmpdir(), 'skillsmith-g6-homebrew-receipt-'));
    temporaryRoots.push(receiptRoot);
    const home = join(receiptRoot, 'home');
    const cache = join(receiptRoot, 'cache');
    const temp = join(receiptRoot, 'tmp');
    await Promise.all([home, cache, temp].map((path) => mkdir(path, { recursive: true })));
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
    const commands: Array<Readonly<{ argv: readonly string[]; exit: number }>> = [];
    const runReceipt = async (argv: readonly string[], cwd = receiptRoot): Promise<string> => {
      const result = await runAsync(argv, { cwd, env: environment });
      commands.push({ argv, exit: result.exitCode });
      if (result.exitCode !== 0) {
        throw new Error(
          `Homebrew receipt command failed (${result.exitCode}): ${argv.join(' ')}: ${result.stderr.toString().slice(0, 2000)}`,
        );
      }
      return result.stdout.toString().trim();
    };

    const architecture = await runReceipt(['/usr/bin/uname', '-m']);
    expect(architecture).toBe('arm64');
    const macosVersion = await runReceipt(['/usr/bin/sw_vers', '-productVersion']);
    expect(Number.parseInt(macosVersion.split('.')[0] ?? '', 10)).toBeGreaterThanOrEqual(15);
    const brewVersion = await runReceipt([brew, '--version']);
    const brewMajor = Number.parseInt(/Homebrew (\d+)/u.exec(brewVersion)?.[1] ?? '', 10);
    expect(brewMajor).toBeGreaterThanOrEqual(5);
    const rubyVersion = await runReceipt([ruby, '--version']);
    const tarVersion = await runReceipt([tar, '--version']);
    const bunVersion = await runReceipt([process.execPath, '--version']);
    expect(bunVersion).toBe('1.3.14');

    const api = await releaseApi();
    if (api.renderHomebrewFormula === undefined) throw new Error('formula renderer is absent');
    const [actual, ...fixtures] = [
      await getActualAllCandidate(),
      ...(await getLifecycleCandidates()),
    ];
    expect(fixtures).toHaveLength(2);
    if (actual.manifestPath === null || actual.formulaPath === null) {
      throw new Error('actual all-target candidate is incomplete');
    }
    const server = await startArchiveServer([actual, ...fixtures]);
    const tapName = 'p17/g6-receipt';
    const qualifiedFormula = `${tapName}/skillsmith`;
    let tapped = false;
    let installed = false;
    try {
      await runReceipt([brew, 'tap-new', tapName]);
      tapped = true;
      const tapRoot = await runReceipt([brew, '--repository', tapName]);
      const localFormulaPath = join(tapRoot, 'Formula', 'skillsmith.rb');
      const brewPrefix = await runReceipt([brew, '--prefix']);
      const publicFormula = await readFile(actual.formulaPath, 'utf8');
      await writeFile(localFormulaPath, publicFormula, { mode: 0o644 });
      await chmod(localFormulaPath, 0o644);
      await runReceipt([ruby, '-c', localFormulaPath]);
      await runReceipt([brew, 'audit', '--strict', '--formula', qualifiedFormula]);

      const renderLocalFormula = (candidate: BuiltCandidate): string => {
        const hashes = Object.fromEntries(
          candidate.targets.map((target) => [target.target.id, target.archiveSha256]),
        );
        return api.renderHomebrewFormula?.({
          version: candidate.version,
          archiveSha256: hashes,
          origin: server.origin,
        }) as string;
      };
      const verifyInstall = async (candidate: BuiltCandidate) => {
        const formulaPrefix = await runReceipt([brew, '--prefix', qualifiedFormula]);
        const version = await runReceipt([join(formulaPrefix, 'bin', 'skillsmith'), 'version']);
        expect(version).toBe(candidate.version);
        const selected = candidate.targets.find(({ target }) => target.id === 'darwin-arm64');
        if (selected === undefined) throw new Error('Darwin arm64 candidate is absent');
        expect(sha256(await readFile(join(formulaPrefix, 'bin', 'skillsmith')))).toBe(
          selected.binarySha256,
        );
        const completionPaths = {
          bash: join(brewPrefix, 'etc', 'bash_completion.d', 'skillsmith'),
          zsh: join(brewPrefix, 'share', 'zsh', 'site-functions', '_skillsmith'),
          fish: join(brewPrefix, 'share', 'fish', 'vendor_completions.d', 'skillsmith.fish'),
        } as const;
        const completionHashes = {} as Record<'bash' | 'zsh' | 'fish', string>;
        for (const shell of ['bash', 'zsh', 'fish'] as const) {
          completionHashes[shell] = sha256(await readFile(completionPaths[shell]));
          expect(completionHashes[shell], shell).toBe(EXPECTED_COMPLETIONS[shell].sha256);
        }
        return completionHashes;
      };

      const firstFixture = fixtures[0];
      const secondFixture = fixtures[1];
      if (firstFixture === undefined || secondFixture === undefined) {
        throw new Error('Homebrew lifecycle fixtures are absent');
      }
      await writeFile(localFormulaPath, renderLocalFormula(firstFixture), { mode: 0o644 });
      await chmod(localFormulaPath, 0o644);
      await runReceipt([brew, 'install', '--formula', qualifiedFormula]);
      installed = true;
      await runReceipt([brew, 'test', qualifiedFormula]);
      await verifyInstall(firstFixture);

      await writeFile(localFormulaPath, renderLocalFormula(secondFixture), { mode: 0o644 });
      await chmod(localFormulaPath, 0o644);
      await runReceipt([brew, 'upgrade', '--formula', qualifiedFormula]);
      await runReceipt([brew, 'test', qualifiedFormula]);
      await verifyInstall(secondFixture);
      await runReceipt([brew, 'uninstall', '--formula', qualifiedFormula]);
      installed = false;

      const actualLocalFormula = renderLocalFormula(actual);
      expect(actualLocalFormula).toBe(
        publicFormula.replaceAll(
          `https://github.com/smorinlabs/skillsmith/releases/download/v${actual.version}`,
          server.origin,
        ),
      );
      await writeFile(localFormulaPath, actualLocalFormula, { mode: 0o644 });
      await chmod(localFormulaPath, 0o644);
      await runReceipt([brew, 'install', '--formula', qualifiedFormula]);
      installed = true;
      await runReceipt([brew, 'test', qualifiedFormula]);
      const completionHashes = await verifyInstall(actual);
      await runReceipt([brew, 'uninstall', '--formula', qualifiedFormula]);
      installed = false;
      await runReceipt([brew, 'untap', tapName]);
      tapped = false;

      expect(server.unexpected).toEqual([]);
      expect(server.requests.length).toBeGreaterThanOrEqual(3);
      expect(deny.requests).toEqual([]);
      const clean = await runReceipt(
        ['git', 'status', '--porcelain', '--untracked-files=no'],
        ROOT,
      );
      expect(clean).toBe('');
      const selected = actual.targets.find(({ target }) => target.id === 'darwin-arm64');
      if (selected === undefined) throw new Error('actual Darwin arm64 archive is absent');
      const receipt = {
        schemaVersion: 1,
        sourceRevision: actual.sourceRevision,
        jobUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
        runner: {
          imageOS: process.env.ImageOS,
          imageVersion: process.env.ImageVersion,
          macosVersion,
          architecture,
        },
        tools: {
          homebrew: brewVersion.split('\n')[0],
          bun: bunVersion,
          ruby: rubyVersion,
          tar: tarVersion.split('\n')[0],
        },
        manifestSha256: sha256(await readFile(actual.manifestPath)),
        formulaSha256: sha256(await readFile(actual.formulaPath)),
        selectedArchiveSha256: selected.archiveSha256,
        completions: completionHashes,
        commands,
        lifecycle: {
          installed: firstFixture.version,
          upgraded: secondFixture.version,
          actual: actual.version,
          uninstalled: true,
        },
        skippedTests: 0,
        cleanDiff: true,
      };
      process.stdout.write(`P17-G6-01-HOMEBREW-RECEIPT ${JSON.stringify(receipt)}\n`);
    } finally {
      if (installed) {
        await runAsync([brew, 'uninstall', '--force', qualifiedFormula], {
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
      server.stop();
      deny.stop();
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
