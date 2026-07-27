#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type BuildReleaseCandidateInput, buildReleaseCandidate } from './release-artifacts.ts';

const ROOT = resolve(import.meta.dir, '..');
const COMPILE_FLAGS = [
  '--compile',
  '--bytecode',
  '--env=disable',
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
] as const;

const argument = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
};

const target = argument('--target') ?? 'all';
if (!['all', 'host', 'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(target)) {
  throw new Error(`unsupported --target ${JSON.stringify(target)}`);
}
const outputRoot = resolve(argument('--output') ?? resolve(ROOT, 'dist', 'release'));
const packagePaths = [
  resolve(ROOT, 'package.json'),
  resolve(ROOT, 'packages', 'cli', 'package.json'),
  resolve(ROOT, 'packages', 'core', 'package.json'),
];
const packageVersions = await Promise.all(
  packagePaths.map(async (path) => {
    const value = JSON.parse(await readFile(path, 'utf8')) as { version?: string };
    if (typeof value.version !== 'string') throw new Error(`package version is absent: ${path}`);
    return value.version;
  }),
);
if (new Set(packageVersions).size !== 1)
  throw new Error('release package versions are not lockstep');
const version = packageVersions[0];
if (version === undefined) throw new Error('root package version is absent');

const revisionResult = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], {
  cwd: ROOT,
  env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  stdout: 'pipe',
  stderr: 'pipe',
});
if (revisionResult.exitCode !== 0)
  throw new Error('could not resolve the explicit source revision');
const sourceRevision = revisionResult.stdout.toString().trim();
const secretCanary = `P17_G6_BUILD_SECRET_${randomUUID()}`;
const input: BuildReleaseCandidateInput = {
  repositoryRoot: ROOT,
  stagingRoot: resolve(ROOT, 'dist'),
  outputRoot,
  version,
  sourceRevision,
  target: target as BuildReleaseCandidateInput['target'],
  compileFlags: COMPILE_FLAGS,
  canaries: [secretCanary, ROOT],
};
const result = await buildReleaseCandidate(input);

if (target === 'all') {
  const leakScan = Bun.spawnSync(
    [
      'gitleaks',
      'dir',
      '--config',
      resolve(ROOT, '.gitleaks.toml'),
      '--redact',
      '--no-banner',
      outputRoot,
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  if (leakScan.exitCode !== 0) throw new Error('release candidate failed the redacted leak scan');
}

process.stdout.write(
  `${JSON.stringify({
    outputRoot: result.outputRoot,
    version: result.version,
    sourceRevision: result.sourceRevision,
    targets: result.targets.map(
      ({ target: builtTarget, binarySha256, archiveSha256, npmSha256 }) => ({
        id: builtTarget.id,
        binarySha256,
        archiveSha256,
        npmSha256,
      }),
    ),
    manifestPath: result.manifestPath,
    checksumsPath: result.checksumsPath,
  })}\n`,
);
