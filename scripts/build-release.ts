#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildReleaseCandidate } from './release-artifacts.ts';

const ROOT = resolve(import.meta.dir, '..');
const SNAPSHOT_INVOCATION = ['goreleaser', 'release', '--snapshot', '--clean'] as const;
const RELEASE_INVOCATION = ['goreleaser', 'release', '--clean', '--skip=publish,announce'] as const;
const REQUIRED_COMPILE_FLAGS = [
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
if (target !== 'all') {
  throw new Error('the standard release candidate must build all four targets');
}
const mode = argument('--mode') ?? 'snapshot';
if (mode !== 'snapshot' && mode !== 'release') {
  throw new Error('release build mode must be snapshot or release');
}
const outputRoot = resolve(argument('--output') ?? resolve(ROOT, 'dist', 'release'));
const packagePaths = [
  resolve(ROOT, 'package.json'),
  resolve(ROOT, 'packages', 'cli', 'package.json'),
  resolve(ROOT, 'packages', 'core', 'package.json'),
];
const packageVersions = await Promise.all(
  packagePaths.map(async (path) => {
    const value = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown };
    if (typeof value.version !== 'string') throw new Error(`package version is absent: ${path}`);
    return value.version;
  }),
);
if (new Set(packageVersions).size !== 1) {
  throw new Error('release package versions are not lockstep');
}
const version = packageVersions[0];
if (version === undefined) throw new Error('root package version is absent');

const config = await readFile(resolve(ROOT, '.goreleaser.yaml'), 'utf8');
if (!config.includes('builder: bun')) {
  throw new Error(
    `${(mode === 'release' ? RELEASE_INVOCATION : SNAPSHOT_INVOCATION).join(' ')} requires the configured Bun builder`,
  );
}
for (const flag of REQUIRED_COMPILE_FLAGS) {
  if (!config.includes(flag)) throw new Error(`GoReleaser compile flag is absent: ${flag}`);
}
const revisionResult = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], {
  cwd: ROOT,
  env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  stdout: 'pipe',
  stderr: 'pipe',
});
if (revisionResult.exitCode !== 0) {
  throw new Error('could not resolve the explicit source revision');
}
const sourceRevision = revisionResult.stdout.toString().trim();
const credentialCanary = `P17_G6_CREDENTIAL_${randomUUID()}`;
const releaseSecretNames = [
  'MACOS_SIGN_P12',
  'MACOS_SIGN_PASSWORD',
  'MACOS_NOTARY_KEY',
  'MACOS_NOTARY_KEY_ID',
  'MACOS_NOTARY_ISSUER_ID',
] as const;
const releaseSecrets =
  mode === 'release'
    ? Object.fromEntries(
        releaseSecretNames.map((name) => {
          const value = process.env[name];
          if (value === undefined || value.length === 0) {
            throw new Error(`release mode requires ${name}`);
          }
          return [name, value];
        }),
      )
    : undefined;
if (mode === 'release') {
  const tagResult = Bun.spawnSync(['git', 'describe', '--tags', '--exact-match', sourceRevision], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (tagResult.exitCode !== 0 || tagResult.stdout.toString().trim() !== `v${version}`) {
    throw new Error('release mode requires the exact version tag at HEAD');
  }
}
const result = await buildReleaseCandidate({
  repositoryRoot: ROOT,
  stagingRoot: resolve(ROOT, 'dist'),
  outputRoot,
  version,
  sourceRevision,
  target: 'all',
  mode,
  releaseSecrets: releaseSecrets as Parameters<typeof buildReleaseCandidate>[0]['releaseSecrets'],
  canaries: [credentialCanary],
});

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
if (leakScan.exitCode !== 0) {
  throw new Error('release candidate failed the redacted leak scan');
}

process.stdout.write(`${JSON.stringify(result)}\n`);
