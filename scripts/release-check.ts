#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  RELEASE_TARGETS,
  deriveProductionCaskFixture,
  installDirectArchive,
  releaseArtifactNames,
  uninstallDirectArchive,
  validateGoreleaserInventory,
} from './release-artifacts.ts';
import { RELEASE_NATIVE_LANES, validateReleaseReceiptSet } from './release-gates.ts';
import { parseJUnitSummary } from './run-test-files-serial.ts';

const ROOT = resolve(import.meta.dir, '..');
const EXPECTED_BUN_VERSION = '1.3.14';
const LANES = ['common', ...RELEASE_NATIVE_LANES, 'aggregate'] as const;
type Lane = (typeof LANES)[number];
type UnknownRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) fail(`${name} is required`);
  return value;
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

type CommandResult = Readonly<{ exitCode: number; stderr: Buffer; stdout: Buffer }>;

async function run(
  command: readonly string[],
  options: { cwd: string; env?: Bun.Env },
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

async function runChecked(
  command: readonly string[],
  options: { cwd: string; env?: Bun.Env; label: string },
): Promise<CommandResult> {
  const result = await run(command, options);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.exitCode !== 0) {
    fail(`${options.label} exited ${result.exitCode}`);
  }
  return result;
}

function git(arguments_: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...arguments_], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) fail(`git ${arguments_.join(' ')} failed`);
  return result.stdout.toString().trim();
}

const hostTargetId = (): (typeof RELEASE_TARGETS)[number]['id'] => {
  const value = `${process.platform}-${process.arch}`;
  const target = RELEASE_TARGETS.find((candidate) => `${candidate.os}-${candidate.cpu}` === value);
  if (target === undefined) fail(`unsupported release-check host ${value}`);
  return target.id;
};

const expectedLaneForHost = (): Lane => `native-${hostTargetId()}` as Lane;

type CandidateContext = Readonly<{
  candidateArtifactId: string;
  candidateBundleSha256: string;
  candidateMetadataSha256: string;
  candidateRoot: string;
  caskPath: string;
  inventory: ReturnType<typeof validateGoreleaserInventory>;
  runId: string;
  sha: string;
  tag: 'v1.0.0';
  version: '1.0.0';
}>;

async function validateCandidate(): Promise<CandidateContext> {
  const candidateRoot = resolve(requiredEnvironment('SKILLSMITH_RELEASE_CANDIDATE_ROOT'));
  const bundlePath = resolve(requiredEnvironment('SKILLSMITH_RELEASE_CANDIDATE_BUNDLE'));
  const identityPath = resolve(requiredEnvironment('SKILLSMITH_CANDIDATE_IDENTITY'));
  const identity = record(
    JSON.parse(await readFile(identityPath, 'utf8')) as unknown,
    'candidate identity',
  );
  const sha = text(identity.sha, 'candidate SHA');
  const tag = text(identity.tag, 'candidate tag');
  const bundleSha256 = text(identity.candidateBundleSha256, 'candidate bundle SHA-256');
  const metadataSha256 = text(identity.candidateMetadataSha256, 'candidate metadata SHA-256');
  if (Bun.version !== EXPECTED_BUN_VERSION) fail(`Bun ${EXPECTED_BUN_VERSION} is required`);
  if (sha !== requiredEnvironment('GITHUB_SHA') || sha !== git(['rev-parse', 'HEAD'])) {
    fail('candidate/check-out SHA mismatch');
  }
  if (tag !== 'v1.0.0' || tag !== requiredEnvironment('GITHUB_REF_NAME')) {
    fail('candidate/check-out tag mismatch');
  }
  if ((await fileSha256(bundlePath)) !== bundleSha256) fail('candidate bundle SHA-256 mismatch');
  const artifactsPath = join(candidateRoot, 'artifacts.json');
  const inventory = validateGoreleaserInventory(
    JSON.parse(await readFile(artifactsPath, 'utf8')) as unknown,
    { workingDirectory: ROOT, outputRoot: candidateRoot },
  );
  const metadata = record(
    JSON.parse(await readFile(inventory.metadataPath, 'utf8')) as unknown,
    'candidate metadata',
  );
  if ((await fileSha256(inventory.metadataPath)) !== metadataSha256) {
    fail('candidate metadata SHA-256 mismatch');
  }
  if (metadata.version !== '1.0.0' || metadata.tag !== 'v1.0.0' || metadata.commit !== sha) {
    fail('candidate metadata identity mismatch');
  }
  return {
    candidateArtifactId: text(identity.candidateArtifactId, 'candidate artifact ID'),
    candidateBundleSha256: bundleSha256,
    candidateMetadataSha256: metadataSha256,
    candidateRoot,
    caskPath: inventory.caskPath,
    inventory,
    runId: text(identity.runId, 'candidate run ID'),
    sha,
    tag: 'v1.0.0',
    version: '1.0.0',
  };
}

async function runBinary(
  path: string,
  candidate: CandidateContext,
  environment: Bun.Env = process.env,
): Promise<void> {
  await chmod(path, 0o755);
  for (const arguments_ of [
    ['version'],
    ['agents', '--capabilities', '--format', 'json'],
    ['doctor', '--json'],
    ['completion', 'zsh'],
  ]) {
    const result = await runChecked([path, ...arguments_], {
      cwd: ROOT,
      env: {
        ...environment,
        PATH: environment.PATH ?? process.env.PATH ?? '',
        HOME: environment.HOME ?? requiredEnvironment('HOME'),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        NO_COLOR: '1',
      },
      label: `candidate ${arguments_.join(' ')}`,
    });
    if (arguments_[0] === 'version' && result.stdout.toString().trim() !== candidate.version) {
      fail('candidate executable version mismatch');
    }
    if (arguments_[0] === 'completion' && result.stdout.byteLength === 0) {
      fail('candidate zsh completion is empty');
    }
  }
}

async function directLifecycle(
  candidate: CandidateContext,
  targetId: keyof CandidateContext['inventory']['archives'],
): Promise<void> {
  const prefix = await mkdtemp(join(tmpdir(), 'skillsmith-release-direct-'));
  try {
    const installed = await installDirectArchive({
      archivePath: candidate.inventory.archives[targetId],
      prefix,
    });
    const home = join(prefix, 'isolated-home');
    await mkdir(home, { recursive: true });
    await runBinary(installed.binary, candidate, { ...process.env, HOME: home });
    await uninstallDirectArchive({ prefix });
    for (const path of Object.values(installed)) {
      if (await Bun.file(path).exists()) fail(`direct uninstall retained ${path}`);
    }
  } finally {
    await rm(prefix, { force: true, recursive: true });
  }
}

function tarEntry(archive: string, path: string): Uint8Array {
  const result = Bun.spawnSync(['tar', '-xOzf', archive, path], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) fail(`could not read ${path} from ${archive}`);
  return result.stdout;
}

type RegistryPackage = Readonly<{
  bytes: Uint8Array;
  filename: string;
  manifest: UnknownRecord;
}>;

async function startRegistry(paths: readonly string[]) {
  const packages = new Map<string, RegistryPackage>();
  for (const path of paths) {
    const manifest = record(
      JSON.parse(Buffer.from(tarEntry(path, 'package/package.json')).toString('utf8')) as unknown,
      'packed manifest',
    );
    const name = text(manifest.name, 'packed package name');
    packages.set(name, { bytes: await readFile(path), filename: basename(path), manifest });
  }
  let origin = '';
  const unexpected: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET') {
        unexpected.push(`${request.method} ${url.pathname}`);
        return new Response('method not allowed', { status: 405 });
      }
      if (url.pathname.startsWith('/tarballs/')) {
        const filename = decodeURIComponent(url.pathname.slice('/tarballs/'.length));
        const selected = [...packages.values()].find((entry) => entry.filename === filename);
        if (selected === undefined) {
          unexpected.push(`GET ${url.pathname}`);
          return new Response('not found', { status: 404 });
        }
        return new Response(selected.bytes);
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      const selected = packages.get(name);
      if (selected === undefined) {
        unexpected.push(`GET ${url.pathname}`);
        return new Response('not found', { status: 404 });
      }
      const version = text(selected.manifest.version, `${name} version`);
      return Response.json({
        name,
        'dist-tags': { latest: version },
        versions: {
          [version]: {
            ...selected.manifest,
            dist: {
              integrity: `sha512-${createHash('sha512').update(selected.bytes).digest('base64')}`,
              shasum: createHash('sha1').update(selected.bytes).digest('hex'),
              tarball: `${origin}/tarballs/${encodeURIComponent(selected.filename)}`,
            },
          },
        },
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return { origin, stop: () => server.stop(true), unexpected };
}

async function privateToolPath(names: readonly string[], root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  for (const name of names) {
    const path = Bun.which(name);
    if (path === null) fail(`${name} is unavailable`);
    await symlink(path, join(root, name));
  }
  return root;
}

async function packageLifecycle(
  candidate: CandidateContext,
  targetId: (typeof RELEASE_TARGETS)[number]['id'],
): Promise<void> {
  const names = releaseArtifactNames(candidate.version).npmTarballs;
  const launcher = join(candidate.candidateRoot, 'npm', names.launcher);
  const payload = join(candidate.candidateRoot, 'npm', names[targetId]);
  const registry = await startRegistry([launcher, payload]);
  try {
    for (const lane of ['npm', 'bun'] as const) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-release-${lane}-`));
      try {
        const prefix = join(root, 'prefix');
        const cache = join(root, 'cache');
        const home = join(root, 'home');
        const work = join(root, 'work');
        await Promise.all(
          [prefix, cache, home, work].map((path) => mkdir(path, { recursive: true })),
        );
        const toolPath = await privateToolPath(
          lane === 'npm' ? ['sh', 'node', 'npm'] : ['sh', 'bun'],
          join(root, 'tools'),
        );
        const environment = {
          PATH: toolPath,
          HOME: home,
          TMPDIR: join(root, 'tmp'),
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_CACHE_HOME: join(home, 'cache'),
          XDG_DATA_HOME: join(home, 'data'),
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          NO_COLOR: '1',
          NO_UPDATE_NOTIFIER: '1',
          npm_config_update_notifier: 'false',
          ...(lane === 'bun' ? { BUN_INSTALL: prefix } : {}),
        };
        await mkdir(environment.TMPDIR, { recursive: true });
        const packageName = `@smorinlabs/skillsmith@${candidate.version}`;
        const install =
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
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                packageName,
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
                packageName,
              ];
        await runChecked(install, {
          cwd: work,
          env: environment,
          label: `${lane} candidate install`,
        });
        await runBinary(join(prefix, 'bin', 'skillsmith'), candidate, environment);
        const uninstall =
          lane === 'npm'
            ? [
                join(toolPath, 'npm'),
                'uninstall',
                '--global',
                '--prefix',
                prefix,
                '--cache',
                cache,
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                '@smorinlabs/skillsmith',
                `@smorinlabs/skillsmith-${targetId}`,
              ]
            : [
                join(toolPath, 'bun'),
                'remove',
                '--global',
                '--cache-dir',
                cache,
                '@smorinlabs/skillsmith',
                `@smorinlabs/skillsmith-${targetId}`,
              ];
        await runChecked(uninstall, {
          cwd: work,
          env: environment,
          label: `${lane} candidate uninstall`,
        });
        if (await Bun.file(join(prefix, 'bin', 'skillsmith')).exists()) {
          fail(`${lane} uninstall retained the launcher`);
        }
        if (registry.unexpected.length > 0) fail(`${lane} requested unexpected registry routes`);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  } finally {
    registry.stop();
  }
}

async function macOSCandidate(
  candidate: CandidateContext,
  targetId: (typeof RELEASE_TARGETS)[number]['id'],
): Promise<void> {
  const binary = candidate.inventory.binaries[targetId];
  await runChecked(['codesign', '--verify', '--deep', '--strict', binary], {
    cwd: ROOT,
    label: 'codesign verification',
  });
  await runChecked(['spctl', '--assess', '--type', 'execute', '--verbose=2', binary], {
    cwd: ROOT,
    label: 'Gatekeeper assessment',
  });
  const archives = new Map<string, Uint8Array>();
  for (const path of Object.values(candidate.inventory.archives)) {
    archives.set(basename(path), await readFile(path));
  }
  let origin = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const bytes = archives.get(name);
      if (bytes === undefined || !['GET', 'HEAD'].includes(request.method)) {
        return new Response('not found', { status: 404 });
      }
      return new Response(request.method === 'HEAD' ? null : bytes, {
        headers: { 'content-length': String(bytes.byteLength) },
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-release-cask-'));
  try {
    const fixture = deriveProductionCaskFixture({
      cask: await readFile(candidate.caskPath, 'utf8'),
      origin,
    });
    const caskPath = join(root, 'skillsmith.rb');
    await writeFile(caskPath, fixture, { mode: 0o644 });
    const brewEnvironment = {
      ...process.env,
      HOMEBREW_NO_ANALYTICS: '1',
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_ENV_HINTS: '1',
    };
    await runChecked(['brew', 'install', '--cask', caskPath], {
      cwd: root,
      env: brewEnvironment,
      label: 'candidate cask install',
    });
    const brewPrefix = (
      await runChecked(['brew', '--prefix'], {
        cwd: root,
        env: brewEnvironment,
        label: 'Homebrew prefix discovery',
      })
    ).stdout
      .toString()
      .trim();
    if (brewPrefix.length === 0) fail('Homebrew prefix is empty');
    const installedBinary = join(brewPrefix, 'bin', 'skillsmith');
    const version = await runChecked([installedBinary, 'version'], {
      cwd: root,
      env: brewEnvironment,
      label: 'candidate cask execution',
    });
    if (version.stdout.toString().trim() !== candidate.version) {
      fail('candidate cask version mismatch');
    }
    await runChecked(['brew', 'uninstall', '--cask', 'skillsmith'], {
      cwd: root,
      env: brewEnvironment,
      label: 'candidate cask uninstall',
    });
    if (await Bun.file(installedBinary).exists()) fail('candidate cask uninstall retained binary');
  } finally {
    server.stop(true);
    await rm(root, { force: true, recursive: true });
  }
}

async function commonLane(candidate: CandidateContext): Promise<number> {
  await runChecked(['just', 'check'], { cwd: ROOT, label: 'canonical just check' });
  const targetId = hostTargetId();
  await runBinary(candidate.inventory.binaries[targetId], candidate);
  for (const [binary, expected] of [
    ['claude', '2.1.202'],
    ['codex', '0.142.5'],
  ] as const) {
    const result = await runChecked([binary, '--version'], {
      cwd: ROOT,
      label: `${binary} version`,
    });
    if (!result.stdout.toString().includes(expected))
      fail(`${binary} version drifted from ${expected}`);
  }
  const reportRoot = await mkdtemp(join(tmpdir(), 'skillsmith-release-live-'));
  try {
    const reportPath = join(reportRoot, 'live.xml');
    await runChecked(
      [
        'bun',
        'test',
        'packages/core/tests/verify/live-e2e.test.ts',
        '--max-concurrency=1',
        '--reporter=junit',
        `--reporter-outfile=${reportPath}`,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, SKILLSMITH_E2E: '1' },
        label: 'release-candidate compatibility',
      },
    );
    const summary = parseJUnitSummary(
      await readFile(reportPath, 'utf8'),
      'packages/core/tests/verify/live-e2e.test.ts',
    );
    if (summary.skipped !== 0 || summary.tests !== 8) fail('real-tool receipt is empty or skipped');
    return summary.tests;
  } finally {
    await rm(reportRoot, { force: true, recursive: true });
  }
}

async function nativeLane(candidate: CandidateContext, lane: Lane): Promise<number> {
  if (lane !== expectedLaneForHost()) fail(`${lane} does not match ${expectedLaneForHost()}`);
  const targetId = hostTargetId();
  await runBinary(candidate.inventory.binaries[targetId], candidate);
  await directLifecycle(candidate, targetId);
  await packageLifecycle(candidate, targetId);
  if (process.platform === 'darwin') await macOSCandidate(candidate, targetId);
  return process.platform === 'darwin' ? 4 : 3;
}

async function writeReceipt(candidate: CandidateContext, lane: Lane, tests: number): Promise<void> {
  const output = resolve(requiredEnvironment('SKILLSMITH_RELEASE_RECEIPT_PATH'));
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify({
      candidateArtifactId: candidate.candidateArtifactId,
      candidateBundleSha256: candidate.candidateBundleSha256,
      candidateMetadataSha256: candidate.candidateMetadataSha256,
      lane,
      receiptArtifactId: requiredEnvironment('SKILLSMITH_RECEIPT_ARTIFACT_ID'),
      requiredSkips: 0,
      runId: candidate.runId,
      sha: candidate.sha,
      status: 'passed',
      tag: candidate.tag,
      tests,
      version: candidate.version,
    })}\n`,
    { mode: 0o600 },
  );
}

async function aggregateLane(): Promise<void> {
  const root = resolve(requiredEnvironment('SKILLSMITH_RELEASE_RECEIPTS_ROOT'));
  const files = (await readdir(root)).filter((name) => name.endsWith('.json')).toSorted();
  if (files.length !== 5) fail('aggregate requires exactly five receipt files');
  const receipts = await Promise.all(
    files.map(async (name) => JSON.parse(await readFile(join(root, name), 'utf8')) as unknown),
  );
  const common = receipts.find((receipt) => record(receipt, 'receipt').lane === 'common');
  const native = receipts.filter((receipt) => record(receipt, 'receipt').lane !== 'common');
  const aggregate = validateReleaseReceiptSet({ common, native });
  const output = resolve(requiredEnvironment('SKILLSMITH_RELEASE_RECEIPT_PATH'));
  await writeFile(output, `${JSON.stringify({ ...aggregate, status: 'passed' })}\n`, {
    mode: 0o600,
  });
}

async function main(): Promise<void> {
  if (Bun.argv.length !== 4 || Bun.argv[2] !== '--lane') {
    fail('release-check accepts exactly --lane <closed-lane>');
  }
  const lane = Bun.argv[3] as Lane;
  if (!LANES.includes(lane)) fail(`unsupported release-check lane ${String(lane)}`);
  if (lane === 'aggregate') {
    await aggregateLane();
    return;
  }
  const candidate = await validateCandidate();
  const tests = lane === 'common' ? await commonLane(candidate) : await nativeLane(candidate, lane);
  await writeReceipt(candidate, lane, tests);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
