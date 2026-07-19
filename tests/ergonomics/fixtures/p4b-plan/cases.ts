import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../../packages/cli/tests/fixtures/cli.ts';
import { hashManifestSemantics } from '../../../../packages/core/src/artifacts/hash.ts';
import {
  type PortableLockV1,
  serializePortableLock,
} from '../../../../packages/core/src/artifacts/lock.ts';
import {
  normalizeManifestDocument,
  readManifestSource,
} from '../../../../packages/core/src/artifacts/manifest.ts';
import { hermeticGitEnv } from '../../../../packages/core/tests/fixtures/git-env.ts';

export const PLAN_SELECTORS = Object.freeze([
  'EWP-CMD-PLAN-TS01',
  'EWP-CMD-PLAN-TS02',
  'EWP-CMD-PLAN-TS03',
  'EWP-CMD-PLAN-TS04',
  'EWP-CMD-PLAN-TS05',
  'EWP-CMD-PLAN-TS06',
  'EWP-CMD-PLAN-TS07',
  'EWP-CMD-PLAN-TS08',
  'EWP-CMD-PLAN-TS09',
  'EWP-CMD-PLAN-TS10',
  'EWP-CMD-PLAN-TS12',
] as const);

export const OPERATION_MATRIX = Object.freeze([
  'empty',
  'install',
  'update',
  'remove',
  'move-scope',
  'adapt',
  'migrate-project-config',
  'migrate-ledger',
  'noop',
] as const);

export const LOCK_MATRIX = Object.freeze([
  'current',
  'missing-default-resolution',
  'missing-locked-refusal',
  'stale-default-resolution',
  'stale-locked-refusal',
  'noncanonical-refusal',
  'semantic-correlation-refusal',
  'unknown-hash-domain-refusal',
] as const);

export const PRUNE_EXCLUSIONS = Object.freeze([
  'unmanaged',
  'undeclared',
  'unselected-tool',
  'unselected-scope',
  'other-project',
  'other-artifact-pair',
  'unknown-adapter',
  'custom-root',
  'filter-to-zero',
] as const);

export const EXIT_MATRIX = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 130] as const);

export interface CliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PlanFixture {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly cache: string;
  readonly manifest: string;
  readonly lock: string;
  readonly out: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface FixtureSkill {
  readonly name: string;
  readonly tool?: 'claude-code' | 'codex' | 'kilo-code' | 'opencode';
  readonly scope?: 'user' | 'project';
  readonly placement?: 'copy' | 'symlink';
}

const processEnvWithoutConfig = (): Record<string, string | undefined> => {
  const env = { ...process.env };
  env.SKILLSMITH_CONFIG = undefined;
  return env;
};

export const manifestSource = (skills: readonly FixtureSkill[]): string =>
  `${[
    '# P4B plan fixture',
    'version = 1',
    '',
    ...skills.flatMap((skill) => [
      '[[skills]]',
      `name = "${skill.name}"`,
      `source = "fixture.invalid/acme/skills//skills/${skill.name}"`,
      `tools = ["${skill.tool ?? 'codex'}"]`,
      `scope = "${skill.scope ?? 'user'}"`,
      `placement = "${skill.placement ?? 'copy'}"`,
      '',
    ]),
  ].join('\n')}\n`;

const normalizedManifest = (source: string) => {
  const document = readManifestSource(source);
  if (!document.ok) throw new Error(document.error.message);
  const normalized = normalizeManifestDocument(document.value);
  if (!normalized.ok) throw new Error(normalized.error.message);
  return normalized.value;
};

export const lockSource = (
  manifest: string,
  options: Readonly<{ manifestHash?: string; hashSchemaVersion?: number }> = {},
): string => {
  const model = normalizedManifest(manifest);
  const lock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: (options.hashSchemaVersion ?? 1) as 1,
    manifestHash: (options.manifestHash ??
      hashManifestSemantics(model)) as PortableLockV1['manifestHash'],
    skills: model.skills
      .map((skill) => ({
        name: skill.name,
        source: `${skill.source.host}/${skill.source.repository}//${skill.source.path}`,
        requestedRef: skill.ref,
        resolvedSha: 'a'.repeat(40),
        sourcePath: skill.source.path ?? '',
        contentHash: `sha256:${'b'.repeat(64)}` as PortableLockV1['skills'][number]['contentHash'],
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  const encoded = serializePortableLock(lock);
  if (!encoded.ok) throw new Error(`${encoded.error.message}: ${JSON.stringify(encoded.error)}`);
  return encoded.value;
};

export const createPlanFixture = async (
  skills: readonly FixtureSkill[] = [],
  options: Readonly<{ writeLock?: boolean }> = {},
): Promise<PlanFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-p4b-plan-'));
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  const config = join(root, 'xdg', 'config');
  const data = join(root, 'xdg', 'data');
  const cache = join(root, 'xdg', 'cache');
  const manifest = join(cwd, 'skillsmith.toml');
  const lock = join(cwd, 'skillsmith.lock');
  const out = join(cwd, 'review.skillsmith.plan');
  await Promise.all(
    [cwd, home, config, data, cache].map((path) => mkdir(path, { recursive: true })),
  );
  const source = manifestSource(skills);
  await writeFile(manifest, source);
  if (options.writeLock !== false) await writeFile(lock, lockSource(source));
  return {
    root,
    cwd,
    home,
    config,
    data,
    cache,
    manifest,
    lock,
    out,
    env: hermeticGitEnv({
      ...processEnvWithoutConfig(),
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      SKILLSMITH_HOME: join(data, 'skillsmith'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      CI: '1',
      NO_COLOR: '1',
    }),
  };
};

export const destroyPlanFixture = async (fixture: PlanFixture): Promise<void> => {
  await rm(fixture.root, { recursive: true, force: true });
};

export const runPlanCli = async (
  fixture: PlanFixture,
  args: readonly string[],
): Promise<CliProduct> => {
  const child = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd: fixture.cwd,
    env: fixture.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
};

export const jsonReport = (product: CliProduct, expectedExit: number, label: string) => {
  if (product.exitCode !== expectedExit) {
    throw new Error(
      `${label}: expected exit ${expectedExit}, received ${product.exitCode}\nstdout:\n${product.stdout}\nstderr:\n${product.stderr}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(product.stdout);
  } catch {
    throw new Error(`${label}: stdout was not one JSON document\n${product.stdout}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: JSON report was not an object`);
  }
  return parsed as Record<string, unknown>;
};

export const fileSnapshot = async (paths: readonly string[]) =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => {
        try {
          const metadata = await stat(path);
          return [
            path,
            { mode: metadata.mode & 0o777, bytes: await readFile(path, 'base64') },
          ] as const;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, null] as const;
          throw error;
        }
      }),
    ),
  );
