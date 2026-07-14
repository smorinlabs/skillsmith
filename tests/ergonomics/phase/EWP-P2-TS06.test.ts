import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { type Dirent, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dir, '../../..');
const FIXTURES = join(import.meta.dir, '../fixtures/p2-ts06');
const CORE_PATH = join(ROOT, 'packages/core/src/index.ts');
const ARTIFACTS_PATH = join(ROOT, 'packages/core/src/artifacts/index.ts');
const LEGACY_MIGRATION_PATH = join(ROOT, 'packages/core/src/artifacts/legacy-migration.ts');
const MIGRATION_EXECUTOR_PATH = join(ROOT, 'packages/core/src/artifacts/migration-executor.ts');
const REGISTRY_PATH = join(ROOT, 'packages/core/src/artifacts/registry.ts');
const CONTRACTS_V1_PATH = join(ROOT, 'packages/core/src/contracts/v1/index.ts');
const CONTRACTS_V2_PATH = join(ROOT, 'packages/core/src/contracts/v2/index.ts');
const LEDGER_FACADE_PATH = join(ROOT, 'packages/core/src/place/ledger.ts');
const CHILD_PATH = join(FIXTURES, 'migration-child.ts');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };

type ArtifactRepositoryReason =
  | 'invalid-request'
  | 'invalid-file-kind'
  | 'permission-denied'
  | 'read-failed'
  | 'malformed'
  | 'invalid-shape'
  | 'unsupported-version'
  | 'migration-failed'
  | 'noncanonical'
  | 'sensitive-content';

interface ExpectedRepositoryError {
  readonly artifactId: 'manifest' | 'plan';
  readonly requestedVersion: number | null;
  readonly reason: ArtifactRepositoryReason;
  readonly path: readonly (string | number)[];
  readonly exitCode: 2 | 3 | 6;
  readonly message: string;
}

interface ShapeCase {
  readonly id: string;
  readonly encoding: 'utf8' | 'base64';
  readonly source: string;
  readonly signedShape:
    | 'canonical'
    | 'legacy'
    | 'mixed'
    | 'empty'
    | 'malformed'
    | 'unknown'
    | 'future'
    | null;
  readonly expected:
    | {
        readonly state: 'present';
        readonly sourceVersion: 'legacy' | 1;
        readonly currentVersion: 1;
        readonly canonical: boolean;
        readonly migration: boolean;
      }
    | ExpectedRepositoryError;
}

interface ShapeFixture {
  readonly schemaVersion: number;
  readonly fixtureCanary: string;
  readonly cases: readonly ShapeCase[];
}

interface ProjectMigrationCase {
  readonly id: string;
  readonly before: string;
  readonly after: string;
  readonly mode: number;
  readonly sourceByteRevision: string;
  readonly resultByteRevision: string;
  readonly resultManifestByteHash: string;
  readonly semanticRevision: string;
}

interface EffectCase {
  readonly id: string;
  readonly migrationId: string;
  readonly interference:
    | 'none'
    | 'before-execute'
    | 'after-compatibility-lock'
    | 'sigint-after-central-lock';
  readonly expected: 'committed' | 'external-writer-conflict' | 'cancelled';
}

interface LedgerMigrationCase {
  readonly id: string;
  readonly before: string;
  readonly after: string;
  readonly sourceByteRevision: string;
  readonly targetByteRevision: string;
  readonly semanticRevision: string;
  readonly preservedLegacyJournals: readonly Readonly<Record<string, unknown>>[];
}

interface SavedMigrationOperationCase {
  readonly id: string;
  readonly operation: {
    readonly kind: 'migrate-project-config' | 'migrate-ledger';
    readonly preconditionIds: readonly string[];
    readonly before: Readonly<Record<string, unknown>>;
    readonly after: Readonly<Record<string, unknown>>;
    readonly mutates: Readonly<Record<string, boolean>>;
  };
  readonly resourcePreconditions: readonly {
    readonly preconditionId: string;
    readonly resource: Readonly<Record<string, unknown>>;
    readonly expectedHash: { readonly domain: string; readonly digest: string };
    readonly expectedRevision: { readonly kind: string; readonly digest: string };
  }[];
  readonly postMigrationObservation: {
    readonly byteRevision: string;
    readonly manifestByteHash?: string;
    readonly semanticRevision: string;
    readonly schemaVersion: number;
  };
}

interface RepositoryCase {
  readonly id: string;
  readonly presentation: 'canonical' | 'compact';
  readonly mutation: Readonly<{
    kind?: string;
    omitKind?: true;
    schemaVersion?: number | string;
    rootUnknown?: true;
    optionsUnknown?: true;
    skillsmithVersion?: string;
  }>;
  readonly expected: ExpectedRepositoryError;
}

interface MigrationFixture {
  readonly schemaVersion: number;
  readonly fixtureCanary: string;
  readonly signedDependencies: readonly {
    readonly group: string;
    readonly revision: string;
  }[];
  readonly projectMigrations: readonly ProjectMigrationCase[];
  readonly effectCases: readonly EffectCase[];
  readonly savedMigrationOperations: readonly SavedMigrationOperationCase[];
  readonly savedPlan: Readonly<Record<string, unknown>>;
  readonly repositoryCases: readonly RepositoryCase[];
  readonly ledgerMigrations: readonly LedgerMigrationCase[];
}

interface ArtifactEnvelope {
  readonly state: 'present';
  readonly artifact: string;
  readonly sourceVersion: 'legacy' | 1 | 2;
  readonly currentVersion: 1 | 2;
  readonly source: string;
  readonly byteLength: number;
  readonly byteRevision: string;
  readonly semanticRevision: string | null;
  readonly model: unknown;
  readonly canonical: boolean;
  readonly migration: Readonly<Record<string, unknown>> | null;
}

interface ReadPorts {
  pathKind(path: string): Promise<'absent' | 'file' | 'directory' | 'symlink' | 'other'>;
  readBytes(path: string): Promise<Uint8Array>;
}

interface RepositoryApi {
  readManifestArtifact(
    ports: ReadPorts,
    path: string,
  ): Promise<Result<ArtifactEnvelope | Readonly<Record<string, unknown>>>>;
  readLedgerArtifact(
    ports: ReadPorts,
    path: string,
  ): Promise<Result<ArtifactEnvelope | Readonly<Record<string, unknown>>>>;
  readSavedPlanArtifact(
    ports: ReadPorts,
    path: string,
  ): Promise<Result<ArtifactEnvelope | Readonly<Record<string, unknown>>>>;
  planProjectConfigMigration(source: string): Result<Readonly<Record<string, unknown>>>;
}

interface ConfigApi {
  loadConfig(
    ports: Readonly<Record<string, unknown>>,
    options: Readonly<Record<string, unknown>>,
  ): Promise<Result<Readonly<Record<string, unknown>>>>;
  resolveRuntimeConfiguration(
    environment: Readonly<Record<string, string | undefined>>,
  ): Readonly<Record<string, unknown>>;
}

interface MigrationExecutorApi {
  executeProjectConfigMigration(
    ports: unknown,
    path: string,
    operation: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Result<Readonly<Record<string, unknown>>>>;
}

interface SignedApi {
  classifyManifestSource(source: string): ShapeCase['signedShape'];
  hashManifestBytes(source: string | Uint8Array): string;
  hashManifestSemantics(model: unknown): string;
  hashCanonicalInput(
    domain: string,
    schemaVersion: number,
    bytes: string | Uint8Array,
  ): Result<string>;
  readManifestSource(source: string): Result<unknown>;
  normalizeManifestDocument(document: unknown): Result<unknown>;
}

interface LegacyMigrationApi {
  migrateLegacyManifestBytes(bytes: Uint8Array): Result<Readonly<Record<string, unknown>>>;
}

const shapeSource = readFileSync(join(FIXTURES, 'shape-cases.json'), 'utf8');
const migrationSource = readFileSync(join(FIXTURES, 'migration-cases.json'), 'utf8');
const shapes = JSON.parse(shapeSource) as ShapeFixture;
const migrations = JSON.parse(migrationSource) as MigrationFixture;

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const digest = (domain: string, source: string | Uint8Array): string =>
  `sha256:${createHash('sha256')
    .update(`skillsmith:${domain}:v1`)
    .update(Uint8Array.of(0))
    .update(source)
    .digest('hex')}`;

type ModuleLoad =
  | { readonly ok: true; readonly module: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly reason: 'module-not-present' | 'module-load-failed';
      readonly message: string;
    };

const loadModule = async (path: string): Promise<ModuleLoad> => {
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: 'module-not-present',
      message: `${relative(ROOT, path)} is absent`,
    };
  }
  try {
    return {
      ok: true,
      module: (await import(pathToFileURL(path).href)) as Readonly<Record<string, unknown>>,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'module-load-failed',
      message: error instanceof Error ? error.message : 'unknown module load failure',
    };
  }
};

const requireFunctions = async <T>(
  path: string,
  names: readonly string[],
  label: string,
): Promise<T | null> => {
  const loaded = await loadModule(path);
  expect(loaded.ok, loaded.ok ? label : `${label}: ${loaded.reason}: ${loaded.message}`).toBeTrue();
  if (!loaded.ok) return null;
  const missing = names.filter((name) => typeof loaded.module[name] !== 'function');
  expect(missing, label).toEqual([]);
  return missing.length > 0 ? null : (loaded.module as unknown as T);
};

const unwrap = <T>(result: Result<T>, label: string): T => {
  expect(result.ok, result.ok ? label : `${label}: ${JSON.stringify(result.error)}`).toBeTrue();
  if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.value;
};

const recursivelyFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  if (ArrayBuffer.isView(value) && value.byteLength > 0) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) recursivelyFrozen(descriptor.value, seen);
  }
};

const runtimeCanary = (): string => ['P17', 'SECRET', 'CANARY'].join('_');

const bytesForShape = (fixture: ShapeCase): Uint8Array => {
  if (fixture.encoding === 'base64') return new Uint8Array(Buffer.from(fixture.source, 'base64'));
  const source = fixture.source.replace('__RUNTIME_CANARY__', `ghp_${runtimeCanary()}_123456789`);
  return encoder.encode(source);
};

const bytesForRepositoryCase = (fixture: RepositoryCase): Uint8Array => {
  let plan = JSON.parse(JSON.stringify(migrations.savedPlan)) as Record<string, unknown>;
  if (fixture.mutation.omitKind === true) {
    plan = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'kind'));
  }
  if (fixture.mutation.kind !== undefined) plan.kind = fixture.mutation.kind;
  if (fixture.mutation.schemaVersion !== undefined) {
    plan.schemaVersion = fixture.mutation.schemaVersion;
  }
  if (fixture.mutation.rootUnknown === true) plan.unexpected = true;
  if (fixture.mutation.optionsUnknown === true) {
    plan.options = {
      ...(plan.options as Readonly<Record<string, unknown>>),
      unexpected: true,
    };
  }
  if (fixture.mutation.skillsmithVersion !== undefined) {
    plan.skillsmithVersion = fixture.mutation.skillsmithVersion.replace(
      '__RUNTIME_CANARY__',
      `ghp_${runtimeCanary()}_123456789`,
    );
  }
  const source =
    fixture.presentation === 'canonical'
      ? `${JSON.stringify(plan, null, 2)}\n`
      : JSON.stringify(plan);
  return encoder.encode(source);
};

const makeReadPorts = (
  bytes: Uint8Array,
  counters: { pathKind: number; readBytes: number },
  kind: Awaited<ReturnType<ReadPorts['pathKind']>> = 'file',
): ReadPorts => ({
  pathKind: async () => {
    counters.pathKind += 1;
    return kind;
  },
  readBytes: async () => {
    counters.readBytes += 1;
    return bytes;
  },
});

const ARTIFACT_ERROR_MESSAGES = Object.freeze({
  'invalid-request': 'artifact read request is invalid',
  'invalid-file-kind': 'artifact path is not a regular file',
  'permission-denied': 'artifact read permission was denied',
  'read-failed': 'artifact could not be read',
  malformed: 'artifact source is malformed',
  'invalid-shape': 'artifact shape is invalid',
  'unsupported-version': 'artifact version is not supported',
  'migration-failed': 'artifact migration failed',
  noncanonical: 'artifact bytes are not canonical',
  'sensitive-content': 'artifact contains sensitive content',
} as const satisfies Readonly<Record<ArtifactRepositoryReason, string>>);

const guardExpectedArtifactError = (expected: ExpectedRepositoryError): void => {
  expect(Object.keys(expected)).toEqual([
    'artifactId',
    'requestedVersion',
    'reason',
    'path',
    'exitCode',
    'message',
  ]);
  expect(expected.message).toBe(ARTIFACT_ERROR_MESSAGES[expected.reason]);
  expect(expected.path.length).toBeLessThanOrEqual(16);
  for (const segment of expected.path) {
    if (typeof segment === 'string') {
      expect(segment.length).toBeGreaterThan(0);
      expect(segment.length).toBeLessThanOrEqual(64);
      expect(
        [...segment].every((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint > 0x1f && codePoint !== 0x7f;
        }),
      ).toBeTrue();
    } else {
      expect(Number.isSafeInteger(segment)).toBeTrue();
      expect(segment).toBeGreaterThanOrEqual(0);
    }
  }
};

const expectExactArtifactError = (
  result: Result<unknown>,
  expected: ExpectedRepositoryError,
): void => {
  expect(result.ok).toBeFalse();
  if (result.ok) return;
  expect(result.error).toEqual({
    code: 'artifact-repository',
    ...expected,
  });
  guardExpectedArtifactError(expected);
  expect(JSON.stringify(result.error)).not.toContain(runtimeCanary());
};

const expectExactRepositoryError = (
  result: Result<unknown>,
  expected: Readonly<{
    reason: Extract<
      ArtifactRepositoryReason,
      'invalid-request' | 'invalid-file-kind' | 'permission-denied' | 'read-failed'
    >;
    exitCode: 2 | 3 | 6;
    requestedVersion?: number | null;
    path?: readonly (string | number)[];
  }>,
): void => {
  expectExactArtifactError(result, {
    artifactId: 'manifest',
    requestedVersion: expected.requestedVersion ?? null,
    reason: expected.reason,
    path: expected.path ?? [],
    exitCode: expected.exitCode,
    message: ARTIFACT_ERROR_MESSAGES[expected.reason],
  });
};

const osError = (code: 'EACCES' | 'EPERM' | 'EIO'): Error & { readonly code: string } =>
  Object.assign(new Error('synthetic local filesystem failure'), { code });

const gitGuard = (revision: string): void => {
  const exists = Bun.spawnSync(['git', 'cat-file', '-e', `${revision}^{commit}`], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(exists.exitCode, exists.stderr.toString()).toBe(0);
  const ancestor = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', revision, 'HEAD'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(ancestor.exitCode, ancestor.stderr.toString()).toBe(0);
};

const makeRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const residue = async (root: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.lock') || entry.name.startsWith('.skillsmith-artifact-')) {
          found.push(relative(root, path));
        }
        await visit(path);
      } else if (
        entry.name.endsWith('.lock') ||
        entry.name.endsWith('.tmp') ||
        entry.name.endsWith('.json') ||
        entry.name.startsWith('.skillsmith-artifact-')
      ) {
        found.push(relative(root, path));
      }
    }
  };
  await visit(root);
  return found.sort();
};

const deferred = <T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const runInterruptedChild = async (root: string): Promise<Readonly<Record<string, unknown>>> => {
  const result = deferred<Readonly<Record<string, unknown>>>();
  const acknowledged = deferred<void>();
  let signalled = false;
  const child = Bun.spawn([process.execPath, CHILD_PATH], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'pipe',
    ipc(message, subprocess) {
      if (typeof message !== 'object' || message === null) return;
      const record = message as Readonly<Record<string, unknown>>;
      if (record.kind === 'fixture-ready') {
        subprocess.send({ kind: 'start' });
      } else if (record.kind === 'migration-armed' && !signalled) {
        signalled = true;
        subprocess.send({ kind: 'interrupt', signal: 'SIGINT' });
      } else if (record.kind === 'signal-ack') {
        acknowledged.resolve();
      } else if (record.kind === 'result') {
        result.resolve(record.result as Readonly<Record<string, unknown>>);
      } else if (record.kind === 'fixture-error') {
        result.reject(new Error(`migration fixture error: ${String(record.reason)}`));
      }
    },
  });
  const timeout = setTimeout(() => {
    result.reject(new Error('migration fixture timeout'));
    child.kill('SIGKILL');
  }, 30_000);
  try {
    const value = await result.promise;
    await acknowledged.promise;
    const exitCode = await child.exited;
    expect(exitCode, (await new Response(child.stderr).text()).trim()).toBe(0);
    expect(signalled).toBeTrue();
    return value;
  } finally {
    clearTimeout(timeout);
    child.unref();
  }
};

describe('EWP-P2-TS06', () => {
  test('EWP-P2-TS06 fixture counts shapes canaries and signed dependency guards pass first', async () => {
    expect(shapes.schemaVersion).toBe(1);
    expect(migrations.schemaVersion).toBe(1);
    expect(shapes.fixtureCanary).toBe('p2-ts06-shape-contract-canary');
    expect(migrations.fixtureCanary).toBe('p2-ts06-migration-contract-canary');
    expect(shapes.cases).toHaveLength(15);
    expect(migrations.signedDependencies).toHaveLength(3);
    expect(migrations.projectMigrations).toHaveLength(5);
    expect(migrations.effectCases).toHaveLength(4);
    expect(migrations.savedMigrationOperations).toHaveLength(2);
    expect(migrations.repositoryCases).toHaveLength(8);
    expect(migrations.ledgerMigrations).toHaveLength(2);
    expect(shapeSource).not.toContain(runtimeCanary());
    expect(migrationSource).not.toContain(runtimeCanary());

    for (const family of [
      shapes.cases,
      migrations.projectMigrations,
      migrations.effectCases,
      migrations.savedMigrationOperations,
      migrations.repositoryCases,
      migrations.ledgerMigrations,
    ]) {
      const ids = family.map(({ id }) => id);
      expect(unique(ids)).toBeTrue();
      expect(ids.every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))).toBeTrue();
    }
    expect(new Set(shapes.cases.map(({ signedShape }) => signedShape))).toEqual(
      new Set(['canonical', 'legacy', 'mixed', 'empty', 'malformed', 'unknown', 'future', null]),
    );
    expect(new Set(migrations.projectMigrations.map(({ mode }) => mode))).toEqual(
      new Set([0o600, 0o640, 0o644]),
    );
    expect(new Set(migrations.effectCases.map(({ interference }) => interference))).toEqual(
      new Set(['none', 'before-execute', 'after-compatibility-lock', 'sigint-after-central-lock']),
    );
    expect(migrations.savedMigrationOperations.map(({ operation }) => operation.kind)).toEqual([
      'migrate-project-config',
      'migrate-ledger',
    ]);
    expect(migrations.savedPlan).toMatchObject({
      schemaVersion: 1,
      kind: 'skillsmith.plan',
      executorSchemaVersion: 1,
      hashSchemaVersion: 1,
    });
    expect(
      (migrations.savedPlan.operations as readonly Readonly<Record<string, unknown>>[]).map(
        ({ kind }) => kind,
      ),
    ).toEqual(['migrate-project-config', 'migrate-ledger']);
    expect(
      (
        migrations.savedPlan.resourcePreconditions as readonly Readonly<Record<string, unknown>>[]
      ).map(({ preconditionId }) => preconditionId),
    ).toEqual([
      'precondition:ledger-schema-v1',
      'precondition:manifest-bytes',
      'precondition:manifest-semantic',
    ]);

    const repositoryExpectations = [
      ...shapes.cases.flatMap(({ expected }) => ('state' in expected ? [] : [expected])),
      ...migrations.repositoryCases.map(({ expected }) => expected),
    ];
    for (const expected of repositoryExpectations) guardExpectedArtifactError(expected);
    expect(new Set(repositoryExpectations.map(({ reason }) => reason))).toEqual(
      new Set([
        'malformed',
        'invalid-shape',
        'unsupported-version',
        'migration-failed',
        'noncanonical',
        'sensitive-content',
      ]),
    );
    expect(
      migrations.repositoryCases.map(({ id, presentation, expected }) => ({
        id,
        presentation,
        reason: expected.reason,
      })),
    ).toEqual([
      {
        id: 'plan-wrong-kind-before-discriminator',
        presentation: 'canonical',
        reason: 'invalid-shape',
      },
      {
        id: 'plan-missing-kind-before-discriminator',
        presentation: 'canonical',
        reason: 'invalid-shape',
      },
      {
        id: 'plan-discriminator-before-unknown',
        presentation: 'canonical',
        reason: 'invalid-shape',
      },
      {
        id: 'plan-future-version-before-unknown',
        presentation: 'canonical',
        reason: 'unsupported-version',
      },
      {
        id: 'plan-recursive-shape-before-canonicality',
        presentation: 'compact',
        reason: 'invalid-shape',
      },
      { id: 'plan-noncanonical', presentation: 'compact', reason: 'noncanonical' },
      {
        id: 'plan-canonicality-before-sensitive',
        presentation: 'compact',
        reason: 'noncanonical',
      },
      {
        id: 'plan-sensitive-canonical',
        presentation: 'canonical',
        reason: 'sensitive-content',
      },
    ]);

    const childCheck = Bun.spawnSync([process.execPath, CHILD_PATH, '--self-check'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(childCheck.exitCode, childCheck.stderr.toString()).toBe(0);
    expect(childCheck.stderr.toString()).toBe('');
    expect(JSON.parse(childCheck.stdout.toString())).toEqual({
      kind: 'p2-ts06-migration-child-self-check',
      protocolVersion: 1,
      accepts: ['start', 'interrupt'],
      emits: ['fixture-ready', 'migration-armed', 'signal-ack', 'result', 'fixture-error'],
      signal: 'SIGINT',
      timeoutMs: 30_000,
    });

    for (const dependency of migrations.signedDependencies) gitGuard(dependency.revision);

    const signed = await requireFunctions<SignedApi>(
      ARTIFACTS_PATH,
      [
        'classifyManifestSource',
        'hashManifestBytes',
        'hashManifestSemantics',
        'hashCanonicalInput',
        'readManifestSource',
        'normalizeManifestDocument',
      ],
      'signed G2-02/G2-03 artifact authority drifted before G2-05',
    );
    const coordinator = await requireFunctions<{
      updateCoordinatedHumanFile(...args: readonly unknown[]): Promise<Result<unknown>>;
    }>(
      join(ROOT, 'packages/core/src/artifacts/coordinator.ts'),
      ['updateCoordinatedHumanFile'],
      'signed G2-03 coordinated-human-file seam drifted before G2-05',
    );
    const legacy = await requireFunctions<LegacyMigrationApi>(
      LEGACY_MIGRATION_PATH,
      ['migrateLegacyManifestBytes'],
      'signed G2-04 migration authority drifted before G2-05',
    );
    if (signed === null || coordinator === null || legacy === null) return;

    for (const fixture of shapes.cases) {
      if (fixture.signedShape === null || fixture.encoding !== 'utf8') continue;
      expect(signed.classifyManifestSource(fixture.source), fixture.id).toBe(fixture.signedShape);
    }
    for (const fixture of migrations.projectMigrations) {
      expect(digest('resource', fixture.before), fixture.id).toBe(fixture.sourceByteRevision);
      expect(digest('resource', fixture.after), fixture.id).toBe(fixture.resultByteRevision);
      expect(digest('manifest-bytes', fixture.after), fixture.id).toBe(
        fixture.resultManifestByteHash,
      );
      expect(signed.hashManifestBytes(fixture.after), fixture.id).toBe(
        fixture.resultManifestByteHash,
      );
      const migrated = unwrap(
        legacy.migrateLegacyManifestBytes(encoder.encode(fixture.before)),
        fixture.id,
      );
      expect(migrated.source, fixture.id).toBe(fixture.after);
      expect(migrated.beforeSemanticHash, fixture.id).toBe(fixture.semanticRevision);
      expect(migrated.afterSemanticHash, fixture.id).toBe(fixture.semanticRevision);
    }
    for (const fixture of migrations.ledgerMigrations) {
      expect(digest('resource', fixture.before), fixture.id).toBe(fixture.sourceByteRevision);
      expect(digest('resource', fixture.after), fixture.id).toBe(fixture.targetByteRevision);
      expect(fixture.before.endsWith('\n'), fixture.id).toBeFalse();
      expect(fixture.after.endsWith('\n'), fixture.id).toBeTrue();
      expect((JSON.parse(fixture.before) as { schemaVersion: number }).schemaVersion).toBe(1);
      expect((JSON.parse(fixture.after) as { schemaVersion: number }).schemaVersion).toBe(2);
    }

    const savedProject = migrations.savedMigrationOperations[0];
    const projectMigration = migrations.projectMigrations[0];
    if (savedProject === undefined || projectMigration === undefined) {
      throw new Error('missing saved project migration fixtures');
    }
    const projectBytePrecondition = savedProject.resourcePreconditions.find(
      ({ expectedHash }) => expectedHash.domain === 'manifest-bytes',
    );
    const projectSemanticPrecondition = savedProject.resourcePreconditions.find(
      ({ expectedHash }) => expectedHash.domain === 'manifest-semantic',
    );
    expect(projectBytePrecondition).toBeDefined();
    expect(projectSemanticPrecondition).toBeDefined();
    expect(savedProject.operation.preconditionIds).toEqual(
      savedProject.resourcePreconditions.map(({ preconditionId }) => preconditionId),
    );
    expect(projectBytePrecondition?.expectedHash.digest).toBe(
      digest('manifest-bytes', projectMigration.before),
    );
    expect(savedProject.postMigrationObservation.manifestByteHash).toBe(
      digest('manifest-bytes', projectMigration.after),
    );
    expect(savedProject.postMigrationObservation.manifestByteHash).not.toBe(
      projectBytePrecondition?.expectedHash.digest,
    );
    expect(savedProject.postMigrationObservation.semanticRevision).toBe(
      projectSemanticPrecondition?.expectedHash.digest,
    );
    expect(savedProject.postMigrationObservation.byteRevision).not.toBe(
      projectBytePrecondition?.expectedRevision.digest,
    );

    const savedLedger = migrations.savedMigrationOperations[1];
    const ledgerMigration = migrations.ledgerMigrations[0];
    if (savedLedger === undefined || ledgerMigration === undefined) {
      throw new Error('missing saved ledger migration fixtures');
    }
    const ledgerSchemaPrecondition = savedLedger.resourcePreconditions[0];
    expect(ledgerSchemaPrecondition?.resource.kind).toBe('ledger-schema');
    expect(savedLedger.operation.before.schemaVersion).toBe(1);
    expect(savedLedger.operation.after.schemaVersion).toBe(2);
    expect(savedLedger.postMigrationObservation.schemaVersion).toBe(2);
    expect(savedLedger.postMigrationObservation.byteRevision).not.toBe(
      ledgerSchemaPrecondition?.expectedRevision.digest,
    );
    expect(savedLedger.postMigrationObservation.semanticRevision).toBe(
      ledgerMigration.semanticRevision,
    );
    const savedPlanOperations = migrations.savedPlan.operations as readonly Readonly<
      Record<string, unknown>
    >[];
    const savedPlanPreconditions = migrations.savedPlan.resourcePreconditions as readonly Readonly<
      Record<string, unknown>
    >[];
    expect(savedPlanOperations).toEqual(
      migrations.savedMigrationOperations.map(({ operation }) => operation),
    );
    expect(savedPlanPreconditions).toEqual([
      ...savedLedger.resourcePreconditions,
      ...savedProject.resourcePreconditions,
    ]);
    expect(
      (migrations.savedPlan.checks as readonly Readonly<Record<string, unknown>>[]).map(
        ({ checkId }) => checkId,
      ),
    ).toEqual(['check:ledger-migration-preconditions', 'check:project-migration-preconditions']);
  });

  test('EWP-P2-TS06 exact legacy canonical mixed empty malformed unknown future matrix', async () => {
    const api = await requireFunctions<RepositoryApi>(
      CORE_PATH,
      ['readManifestArtifact', 'readSavedPlanArtifact'],
      'missing G2-05 manifest artifact repository after fixture and signed guards passed',
    );
    if (api === null) return;

    const migrationByBefore = new Map(
      migrations.projectMigrations.map((fixture) => [fixture.before, fixture]),
    );
    for (const fixture of shapes.cases) {
      const bytes = bytesForShape(fixture);
      const snapshot = new Uint8Array(bytes);
      const counters = { pathKind: 0, readBytes: 0 };
      const result = await api.readManifestArtifact(
        makeReadPorts(bytes, counters),
        '/fixture/skillsmith.toml',
      );
      expect(bytes, fixture.id).toEqual(snapshot);
      expect(counters, fixture.id).toEqual({ pathKind: 1, readBytes: 1 });
      if ('state' in fixture.expected) {
        const envelope = unwrap(result, fixture.id) as ArtifactEnvelope;
        expect(envelope).toMatchObject({
          state: 'present',
          artifact: 'manifest',
          sourceVersion: fixture.expected.sourceVersion,
          currentVersion: fixture.expected.currentVersion,
          canonical: fixture.expected.canonical,
          byteLength: bytes.byteLength,
          byteRevision: digest('resource', bytes),
        });
        expect(envelope.source, fixture.id).toBe(decoder.decode(bytes));
        expect(envelope.migration !== null, fixture.id).toBe(fixture.expected.migration);
        if (envelope.sourceVersion === 'legacy') {
          const golden = migrationByBefore.get(envelope.source);
          expect(golden, fixture.id).toBeDefined();
          expect(envelope.migration, fixture.id).toMatchObject({
            kind: 'migrate-project-config',
            from: 'legacy',
            toVersion: 1,
            expectedByteRevision: golden?.sourceByteRevision,
            resultByteRevision: golden?.resultByteRevision,
            expectedSemanticRevision: golden?.semanticRevision,
            resultSemanticRevision: golden?.semanticRevision,
            resultSource: golden?.after,
            createsLockfile: false,
          });
        }
        recursivelyFrozen(envelope);
      } else {
        expectExactArtifactError(result, fixture.expected);
      }
    }

    for (const fixture of migrations.repositoryCases) {
      const bytes = bytesForRepositoryCase(fixture);
      const snapshot = new Uint8Array(bytes);
      const counters = { pathKind: 0, readBytes: 0 };
      const result = await api.readSavedPlanArtifact(
        makeReadPorts(bytes, counters),
        '/fixture/migration-plan.json',
      );
      expect(bytes, fixture.id).toEqual(snapshot);
      expect(counters, fixture.id).toEqual({ pathKind: 1, readBytes: 1 });
      expectExactArtifactError(result, fixture.expected);
    }

    const absentCounters = { pathKind: 0, readBytes: 0 };
    const absent = unwrap(
      await api.readManifestArtifact(
        makeReadPorts(new Uint8Array(), absentCounters, 'absent'),
        '/fixture/missing.toml',
      ),
      'absent manifest',
    );
    expect(absent).toEqual({ state: 'absent', artifact: 'manifest', migration: null });
    expect(absentCounters).toEqual({ pathKind: 1, readBytes: 0 });

    for (const path of [
      '',
      ' ',
      '\t',
      '\n',
      '\u0000',
      `/fixture/ghp_${runtimeCanary()}_123456789.toml`,
    ]) {
      const counters = { pathKind: 0, readBytes: 0 };
      const result = await api.readManifestArtifact(
        {
          pathKind: async () => {
            counters.pathKind += 1;
            throw new Error('invalid request reached pathKind');
          },
          readBytes: async () => {
            counters.readBytes += 1;
            throw new Error('invalid request reached readBytes');
          },
        },
        path,
      );
      expectExactRepositoryError(result, { reason: 'invalid-request', exitCode: 2 });
      expect(counters, `invalid request ${JSON.stringify(path)}`).toEqual({
        pathKind: 0,
        readBytes: 0,
      });
    }

    for (const fixture of [
      { id: 'path-kind-eacces', code: 'EACCES' as const, reason: 'permission-denied' as const },
      { id: 'path-kind-eperm', code: 'EPERM' as const, reason: 'permission-denied' as const },
      { id: 'path-kind-generic', code: 'EIO' as const, reason: 'read-failed' as const },
    ]) {
      const counters = { pathKind: 0, readBytes: 0 };
      const result = await api.readManifestArtifact(
        {
          pathKind: async () => {
            counters.pathKind += 1;
            throw osError(fixture.code);
          },
          readBytes: async () => {
            counters.readBytes += 1;
            return new Uint8Array();
          },
        },
        '/fixture/skillsmith.toml',
      );
      expectExactRepositoryError(result, {
        reason: fixture.reason,
        exitCode: fixture.reason === 'permission-denied' ? 6 : 3,
      });
      expect(counters, fixture.id).toEqual({ pathKind: 1, readBytes: 0 });
    }

    for (const kind of ['directory', 'symlink', 'other'] as const) {
      const counters = { pathKind: 0, readBytes: 0 };
      const result = await api.readManifestArtifact(
        makeReadPorts(new Uint8Array(), counters, kind),
        `/fixture/${kind}`,
      );
      expectExactRepositoryError(result, { reason: 'invalid-file-kind', exitCode: 3 });
      expect(counters, kind).toEqual({ pathKind: 1, readBytes: 0 });
    }

    for (const fixture of [
      { id: 'read-bytes-eacces', code: 'EACCES' as const, reason: 'permission-denied' as const },
      { id: 'read-bytes-eperm', code: 'EPERM' as const, reason: 'permission-denied' as const },
      { id: 'read-bytes-generic', code: 'EIO' as const, reason: 'read-failed' as const },
    ]) {
      const counters = { pathKind: 0, readBytes: 0 };
      const result = await api.readManifestArtifact(
        {
          pathKind: async () => {
            counters.pathKind += 1;
            return 'file';
          },
          readBytes: async () => {
            counters.readBytes += 1;
            throw osError(fixture.code);
          },
        },
        '/fixture/skillsmith.toml',
      );
      expectExactRepositoryError(result, {
        reason: fixture.reason,
        exitCode: fixture.reason === 'permission-denied' ? 6 : 3,
      });
      expect(counters, fixture.id).toEqual({ pathKind: 1, readBytes: 1 });
    }

    const sharedBytes = new Uint8Array(new SharedArrayBuffer(16));
    for (const fixture of [
      { id: 'null-port-value', value: null },
      { id: 'data-view-port-value', value: new DataView(new ArrayBuffer(16)) },
      { id: 'shared-byte-view', value: sharedBytes },
    ]) {
      const counters = { pathKind: 0, readBytes: 0 };
      const ports = {
        pathKind: async () => {
          counters.pathKind += 1;
          return 'file' as const;
        },
        readBytes: async () => {
          counters.readBytes += 1;
          return fixture.value;
        },
      } as unknown as ReadPorts;
      const result = await api.readManifestArtifact(ports, '/fixture/skillsmith.toml');
      expectExactRepositoryError(result, { reason: 'read-failed', exitCode: 3 });
      expect(counters, fixture.id).toEqual({ pathKind: 1, readBytes: 1 });
    }
  });

  test('EWP-P2-TS06 read-only dry-run mapping portability and automatic-doctor equivalence', async () => {
    const api = await requireFunctions<RepositoryApi & ConfigApi>(
      CORE_PATH,
      [
        'readManifestArtifact',
        'planProjectConfigMigration',
        'loadConfig',
        'resolveRuntimeConfiguration',
      ],
      'missing G2-05 pure manifest migration API after fixture and signed guards passed',
    );
    const signed = await requireFunctions<SignedApi>(
      ARTIFACTS_PATH,
      ['classifyManifestSource'],
      'signed manifest classifier unavailable',
    );
    if (api === null || signed === null) return;

    const populated = shapes.cases.find(({ id }) => id === 'canonical-populated');
    if (populated === undefined) throw new Error('missing canonical populated role fixture');
    const normalizedManifest = {
      version: 1,
      defaults: {
        tools: ['claude-code', 'codex'],
        scope: 'project',
        path: './skills',
      },
      registry: { default: 'github.com/acme' },
      skills: [
        {
          name: 'review',
          source: {
            host: 'github.com',
            repository: 'acme/tools',
            path: 'skills/review',
          },
          ref: 'main',
          tools: ['codex', 'opencode'],
          scope: 'user',
          placement: 'copy',
          path: '~/review',
        },
      ],
    } as const;
    const populatedBytes = bytesForShape(populated);
    const populatedCounters = { pathKind: 0, readBytes: 0 };
    const populatedEnvelope = unwrap(
      await api.readManifestArtifact(
        makeReadPorts(populatedBytes, populatedCounters),
        '/fixture/project/skillsmith.toml',
      ),
      'canonical populated artifact role',
    ) as ArtifactEnvelope;
    expect(populatedEnvelope.model).toEqual(normalizedManifest);
    expect(populatedEnvelope).toMatchObject({
      sourceVersion: 1,
      currentVersion: 1,
      canonical: false,
      migration: null,
    });
    expect(populatedCounters).toEqual({ pathKind: 1, readBytes: 1 });
    recursivelyFrozen(populatedEnvelope);

    const explicitPath = '/fixture/project/populated.toml';
    const configReads: string[] = [];
    const loaded = unwrap(
      await api.loadConfig(
        {
          homeDir: '/fixture/home',
          executableSearchPath: [],
          platform: 'linux',
          xdg: {
            config: '/fixture/xdg/config',
            data: '/fixture/xdg/data',
            cache: '/fixture/xdg/cache',
          },
          systemConfigPath: '/fixture/system/config.toml',
          fileExists: async (path: string) => path === explicitPath,
        },
        {
          explicitFile: explicitPath,
          configuration: api.resolveRuntimeConfiguration({}),
          cwd: '/fixture/project',
          readFile: async (path: string) => {
            configReads.push(path);
            return populated.source;
          },
        },
      ),
      'canonical populated config role',
    );
    expect(loaded.value).toEqual({
      tools: normalizedManifest.defaults.tools,
      scope: normalizedManifest.defaults.scope,
      path: normalizedManifest.defaults.path,
      registry: normalizedManifest.registry,
    });
    expect(loaded.sources).toEqual({
      tool: 'explicit-file',
      scope: 'explicit-file',
      path: 'explicit-file',
      'registry.default': 'explicit-file',
    });
    expect(loaded.toolSelection).toEqual({
      tools: normalizedManifest.defaults.tools,
      source: 'explicit-file',
      cardinality: 'plural',
    });
    expect(configReads).toEqual([explicitPath]);

    for (const fixture of migrations.projectMigrations) {
      const bytes = encoder.encode(fixture.before);
      const snapshot = new Uint8Array(bytes);
      const counters = { pathKind: 0, readBytes: 0 };
      expect(signed.classifyManifestSource(fixture.before), fixture.id).toBe('legacy');
      const envelope = unwrap(
        await api.readManifestArtifact(makeReadPorts(bytes, counters), '/fixture/skillsmith.toml'),
        fixture.id,
      ) as ArtifactEnvelope;
      const automatic = unwrap(api.planProjectConfigMigration(fixture.before), fixture.id);
      const doctor = unwrap(api.planProjectConfigMigration(fixture.before), fixture.id);
      expect(automatic, fixture.id).toEqual(doctor);
      expect(automatic, fixture.id).toEqual(envelope.migration);
      expect(automatic, fixture.id).not.toHaveProperty('callerMode');
      expect(automatic, fixture.id).not.toHaveProperty('path');
      expect(automatic, fixture.id).not.toHaveProperty('lock');
      expect(automatic, fixture.id).toMatchObject({
        expectedByteRevision: fixture.sourceByteRevision,
        expectedSemanticRevision: fixture.semanticRevision,
        resultByteRevision: fixture.resultByteRevision,
        resultSemanticRevision: fixture.semanticRevision,
        resultSource: fixture.after,
        createsLockfile: false,
      });
      expect(bytes, fixture.id).toEqual(snapshot);
      expect(counters, fixture.id).toEqual({ pathKind: 1, readBytes: 1 });
      expect(envelope.source, fixture.id).toBe(fixture.before);
      expect(envelope.canonical, fixture.id).toBeFalse();
      expect(fixture.after.includes('\r'), fixture.id).toBe(fixture.before.includes('\r'));
    }

    const nonportable = 'scope = "project"\npath = "skills"\n';
    const refusal = api.planProjectConfigMigration(nonportable);
    expect(refusal.ok).toBeFalse();
    if (!refusal.ok) {
      expect(refusal.error).toMatchObject({
        code: 'artifact-repository',
        reason: 'migration-failed',
        exitCode: 3,
      });
    }
  });

  test('EWP-P2-TS06 CF029 coordinator seam is lossless stale-safe lockless and interruptible', async () => {
    const api = await requireFunctions<RepositoryApi>(
      CORE_PATH,
      ['planProjectConfigMigration'],
      'missing G2-05 project migration planner after fixture and signed guards passed',
    );
    const executor = await requireFunctions<MigrationExecutorApi>(
      MIGRATION_EXECUTOR_PATH,
      ['executeProjectConfigMigration'],
      'missing G2-05 internal migration executor after fixture and signed guards passed',
    );
    const nodeCoordinator = await requireFunctions<{
      createTestNodeArtifactCoordinatorPorts(
        root: string,
      ): Promise<Readonly<Record<string, unknown>>>;
    }>(
      join(ROOT, 'packages/core/src/artifacts/node-coordinator.ts'),
      ['createTestNodeArtifactCoordinatorPorts'],
      'signed G2-03 test coordinator unavailable',
    );
    if (api === null || executor === null || nodeCoordinator === null) return;

    const freshCase = migrations.projectMigrations[0];
    if (freshCase === undefined) throw new Error('missing fresh migration fixture');
    const freshRoot = await makeRoot('skillsmith-ts06-fresh-');
    const freshPath = join(freshRoot, 'manifest.toml');
    await writeFile(freshPath, freshCase.before);
    await chmod(freshPath, freshCase.mode);
    const freshOperation = unwrap(
      api.planProjectConfigMigration(freshCase.before),
      'fresh migration plan',
    );
    expect(Object.keys(freshOperation).sort()).toEqual([
      'createsLockfile',
      'expectedByteRevision',
      'expectedSemanticRevision',
      'from',
      'kind',
      'resultByteRevision',
      'resultSemanticRevision',
      'resultSource',
      'toVersion',
    ]);
    const freshPorts = await nodeCoordinator.createTestNodeArtifactCoordinatorPorts(
      join(freshRoot, 'coordination'),
    );
    const freshResult = unwrap(
      await executor.executeProjectConfigMigration(freshPorts, freshPath, freshOperation),
      'fresh migration execute',
    );
    expect(freshResult.outcome).toBe('committed');
    expect(await readFile(freshPath, 'utf8')).toBe(freshCase.after);
    expect((await stat(freshPath)).mode & 0o777).toBe(freshCase.mode);
    expect(existsSync(join(freshRoot, 'manifest.lock'))).toBeFalse();
    expect(await residue(freshRoot)).toEqual([]);
    const savedProject = migrations.savedMigrationOperations.find(
      ({ operation }) => operation.kind === 'migrate-project-config',
    );
    const savedProjectBytes = savedProject?.resourcePreconditions.find(
      ({ expectedHash }) => expectedHash.domain === 'manifest-bytes',
    );
    expect(savedProject).toBeDefined();
    expect(digest('manifest-bytes', await readFile(freshPath, 'utf8'))).not.toBe(
      savedProjectBytes?.expectedHash.digest,
    );
    expect((freshResult.revision as Readonly<Record<string, unknown>>).digest).not.toBe(
      savedProjectBytes?.expectedRevision.digest,
    );

    const staleRoot = await makeRoot('skillsmith-ts06-stale-');
    const stalePath = join(staleRoot, 'manifest.toml');
    await writeFile(stalePath, freshCase.before);
    const staleOperation = unwrap(
      api.planProjectConfigMigration(freshCase.before),
      'stale migration plan',
    );
    const replacement = 'version = 1\n';
    await writeFile(stalePath, replacement);
    const stalePorts = await nodeCoordinator.createTestNodeArtifactCoordinatorPorts(
      join(staleRoot, 'coordination'),
    );
    const stale = await executor.executeProjectConfigMigration(
      stalePorts,
      stalePath,
      staleOperation,
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'artifact-mutation', reason: 'external-writer-conflict' },
    });
    expect(await readFile(stalePath, 'utf8')).toBe(replacement);
    expect(await residue(staleRoot)).toEqual([]);

    const concurrentRoot = await makeRoot('skillsmith-ts06-concurrent-');
    const concurrentPath = join(concurrentRoot, 'manifest.toml');
    await writeFile(concurrentPath, freshCase.before);
    const concurrentOperation = unwrap(
      api.planProjectConfigMigration(freshCase.before),
      'concurrent migration plan',
    );
    const concurrentBase = await nodeCoordinator.createTestNodeArtifactCoordinatorPorts(
      join(concurrentRoot, 'coordination'),
    );
    let interfered = false;
    const concurrentPorts = Object.freeze({
      ...concurrentBase,
      afterBarrier: async (barrier: Readonly<Record<string, unknown>>) => {
        if (
          !interfered &&
          barrier.kind === 'lock-acquired' &&
          barrier.targetClass === 'compatibility'
        ) {
          interfered = true;
          await writeFile(concurrentPath, replacement);
        }
      },
    });
    const concurrent = await executor.executeProjectConfigMigration(
      concurrentPorts,
      concurrentPath,
      concurrentOperation,
    );
    expect(interfered).toBeTrue();
    expect(concurrent).toMatchObject({
      ok: false,
      error: { code: 'artifact-mutation', reason: 'external-writer-conflict' },
    });
    expect(await readFile(concurrentPath, 'utf8')).toBe(replacement);
    expect(await residue(concurrentRoot)).toEqual([]);

    const interruptedCase = migrations.projectMigrations[1];
    if (interruptedCase === undefined) throw new Error('missing interruption fixture');
    const interruptedRoot = await makeRoot('skillsmith-ts06-interrupted-');
    const interruptedPath = join(interruptedRoot, 'manifest.toml');
    await writeFile(interruptedPath, interruptedCase.before);
    await chmod(interruptedPath, interruptedCase.mode);
    const interrupted = await runInterruptedChild(interruptedRoot);
    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: 'artifact-mutation', reason: 'cancelled', exitCode: 130 },
    });
    expect(await readFile(interruptedPath, 'utf8')).toBe(interruptedCase.before);
    expect((await stat(interruptedPath)).mode & 0o777).toBe(interruptedCase.mode);
    expect(await residue(interruptedRoot)).toEqual([]);
  }, 45_000);

  test('EWP-P2-TS06 saved ledger migration staleness semantic equivalence and no downgrade', async () => {
    const api = await requireFunctions<RepositoryApi>(
      CORE_PATH,
      ['readLedgerArtifact', 'readSavedPlanArtifact'],
      'missing G2-05 ledger repository after fixture and signed guards passed',
    );
    const v2 = await requireFunctions<{
      migrateLedgerV1DtoToV2Dto(dto: unknown): Result<unknown>;
      readonly ledgerV2Codec: {
        encode(model: unknown): Result<Uint8Array>;
      };
    }>(
      CONTRACTS_V2_PATH,
      ['migrateLedgerV1DtoToV2Dto'],
      'missing G2-05 ledger v2 mapper after fixture and signed guards passed',
    );
    if (api === null || v2 === null) return;
    expect(typeof v2.ledgerV2Codec?.encode).toBe('function');

    const savedPlanSource = `${JSON.stringify(migrations.savedPlan, null, 2)}\n`;
    const savedPlanBytes = encoder.encode(savedPlanSource);
    const savedPlanSnapshot = new Uint8Array(savedPlanBytes);
    const savedPlanCounters = { pathKind: 0, readBytes: 0 };
    const savedPlanEnvelope = unwrap(
      await api.readSavedPlanArtifact(
        makeReadPorts(savedPlanBytes, savedPlanCounters),
        '/fixture/migration-plan.json',
      ),
      'literal saved migration plan',
    ) as ArtifactEnvelope;
    expect(savedPlanBytes).toEqual(savedPlanSnapshot);
    expect(savedPlanCounters).toEqual({ pathKind: 1, readBytes: 1 });
    expect(savedPlanEnvelope).toMatchObject({
      state: 'present',
      artifact: 'plan',
      sourceVersion: 1,
      currentVersion: 1,
      source: savedPlanSource,
      byteLength: savedPlanBytes.byteLength,
      byteRevision: digest('resource', savedPlanBytes),
      canonical: true,
      migration: null,
    });
    expect(savedPlanEnvelope.model).toEqual(migrations.savedPlan);
    recursivelyFrozen(savedPlanEnvelope);

    const decodedPlan = savedPlanEnvelope.model as Readonly<Record<string, unknown>>;
    const decodedOperations = decodedPlan.operations as readonly Readonly<
      Record<string, unknown>
    >[];
    const decodedPreconditions = decodedPlan.resourcePreconditions as readonly {
      readonly preconditionId: string;
      readonly resource: Readonly<Record<string, unknown>>;
      readonly expectedHash: Readonly<{ readonly domain: string; readonly digest: string }>;
      readonly expectedRevision: Readonly<{ readonly kind: string; readonly digest: string }>;
    }[];
    expect(decodedOperations.map(({ kind }) => kind)).toEqual([
      'migrate-project-config',
      'migrate-ledger',
    ]);
    expect(decodedPreconditions.map(({ preconditionId }) => preconditionId)).toEqual([
      'precondition:ledger-schema-v1',
      'precondition:manifest-bytes',
      'precondition:manifest-semantic',
    ]);

    const projectMigration = migrations.projectMigrations[0];
    const savedProject = migrations.savedMigrationOperations.find(
      ({ operation }) => operation.kind === 'migrate-project-config',
    );
    if (projectMigration === undefined || savedProject === undefined) {
      throw new Error('missing project post-migration observation');
    }
    const decodedManifestBytes = decodedPreconditions.find(
      ({ expectedHash }) => expectedHash.domain === 'manifest-bytes',
    );
    const decodedManifestSemantic = decodedPreconditions.find(
      ({ expectedHash }) => expectedHash.domain === 'manifest-semantic',
    );
    expect(decodedManifestBytes).toBeDefined();
    expect(decodedManifestSemantic).toBeDefined();
    expect(digest('manifest-bytes', projectMigration.after)).toBe(
      savedProject.postMigrationObservation.manifestByteHash,
    );
    expect(savedProject.postMigrationObservation.manifestByteHash).not.toBe(
      decodedManifestBytes?.expectedHash.digest,
    );
    expect(digest('resource', projectMigration.after)).toBe(
      savedProject.postMigrationObservation.byteRevision,
    );
    expect(savedProject.postMigrationObservation.byteRevision).not.toBe(
      decodedManifestBytes?.expectedRevision.digest,
    );
    expect(savedProject.postMigrationObservation.semanticRevision).toBe(
      decodedManifestSemantic?.expectedHash.digest,
    );

    const observed: ArtifactEnvelope[] = [];
    for (const fixture of migrations.ledgerMigrations) {
      const beforeBytes = encoder.encode(fixture.before);
      const beforeSnapshot = new Uint8Array(beforeBytes);
      const v1Envelope = unwrap(
        await api.readLedgerArtifact(
          makeReadPorts(beforeBytes, { pathKind: 0, readBytes: 0 }),
          '/fixture/placements.json',
        ),
        fixture.id,
      ) as ArtifactEnvelope;
      observed.push(v1Envelope);
      expect(beforeBytes, fixture.id).toEqual(beforeSnapshot);
      expect(v1Envelope).toMatchObject({
        state: 'present',
        artifact: 'ledger',
        sourceVersion: 1,
        currentVersion: 2,
        byteRevision: fixture.sourceByteRevision,
        semanticRevision: fixture.semanticRevision,
        canonical: true,
      });
      expect(v1Envelope.migration, fixture.id).toMatchObject({
        kind: 'ledger-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
        sourceByteRevision: fixture.sourceByteRevision,
        sourceSemanticRevision: fixture.semanticRevision,
        targetSemanticRevision: fixture.semanticRevision,
        targetByteRevision: fixture.targetByteRevision,
        targetCanonicalSource: fixture.after,
        preservedLegacyJournals: fixture.preservedLegacyJournals,
      });

      const mapped = unwrap(
        v2.migrateLedgerV1DtoToV2Dto(JSON.parse(fixture.before)),
        `${fixture.id} dto migration`,
      );
      expect(mapped, fixture.id).toEqual(JSON.parse(fixture.after));
      const encoded = unwrap(v2.ledgerV2Codec.encode(v1Envelope.model), `${fixture.id} encode`);
      expect(decoder.decode(encoded), fixture.id).toBe(fixture.after);

      const v2Envelope = unwrap(
        await api.readLedgerArtifact(
          makeReadPorts(encoded, { pathKind: 0, readBytes: 0 }),
          '/fixture/placements.json',
        ),
        `${fixture.id} reread`,
      ) as ArtifactEnvelope;
      expect(v2Envelope).toMatchObject({
        sourceVersion: 2,
        currentVersion: 2,
        byteRevision: fixture.targetByteRevision,
        semanticRevision: fixture.semanticRevision,
        migration: null,
      });
      expect(v2Envelope.model, fixture.id).toEqual(v1Envelope.model);
      if (fixture.id === 'empty-v1') {
        const savedLedger = migrations.savedMigrationOperations.find(
          ({ operation }) => operation.kind === 'migrate-ledger',
        );
        const ledgerSchemaPrecondition = decodedPreconditions.find(
          ({ resource }) => resource.kind === 'ledger-schema',
        );
        expect(savedLedger).toBeDefined();
        expect(savedLedger?.operation.before.schemaVersion).toBe(1);
        expect(ledgerSchemaPrecondition).toBeDefined();
        expect(v2Envelope.sourceVersion).toBe(2);
        expect(v2Envelope.byteRevision).not.toBe(ledgerSchemaPrecondition?.expectedRevision.digest);
        expect(v2Envelope.semanticRevision).toBe(
          savedLedger?.postMigrationObservation.semanticRevision,
        );
      }
      recursivelyFrozen(v1Envelope);
      recursivelyFrozen(v2Envelope);
    }
    expect(observed).toHaveLength(2);
    expect(observed[0]?.migration).not.toEqual(observed[1]?.migration);
    expect(observed[0]?.byteRevision).not.toBe(observed[1]?.byteRevision);
    expect(observed[0]?.semanticRevision).not.toBe(observed[1]?.semanticRevision);

    const facadeLoad = await loadModule(LEDGER_FACADE_PATH);
    expect(
      facadeLoad.ok,
      facadeLoad.ok
        ? 'ledger compatibility facade loaded'
        : `${facadeLoad.reason}: ${facadeLoad.message}`,
    ).toBeTrue();
    if (!facadeLoad.ok) return;
    const facade = facadeLoad.module;
    const v2Source = migrations.ledgerMigrations[0]?.after;
    if (v2Source === undefined) throw new Error('missing ledger v2 fixture');
    const legacyRead = facade.readLedger as (
      env: Readonly<Record<string, unknown>>,
      path: string,
    ) => Promise<Result<unknown>>;
    const readResult = await legacyRead(
      {
        pathKind: async () => 'file',
        readText: async () => v2Source,
        wallNowIso: () => 'never-used',
      },
      '/fixture/placements.json',
    );
    expect(readResult).toMatchObject({ ok: false, error: { code: 'ledger-error' } });

    let writes = 0;
    const legacyWrite = facade.writeLedger as (
      env: Readonly<Record<string, unknown>>,
      path: string,
      ledger: unknown,
    ) => Promise<Result<unknown>>;
    const writeResult = await legacyWrite(
      {
        wallNowIso: () => 'never-used',
        nextId: () => 'never-used',
        writeTextFile: async () => {
          writes += 1;
        },
        fsyncFile: async () => undefined,
        rename: async () => undefined,
        fsyncDir: async () => undefined,
        removeTree: async () => undefined,
      },
      '/fixture/placements.json',
      JSON.parse(v2Source),
    );
    expect(writeResult).toMatchObject({ ok: false, error: { code: 'ledger-error' } });
    expect(writes).toBe(0);
  });

  test('EWP-P2-TS06 closed public types static ownership and complete cross-family acceptance', async () => {
    const compiled = Bun.spawnSync(
      [join(ROOT, 'node_modules/.bin/tsc'), '-p', join(FIXTURES, 'tsconfig.json'), '--noEmit'],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const typeOutput = `${compiled.stdout.toString()}${compiled.stderr.toString()}`;
    expect(compiled.exitCode, typeOutput).toBe(0);

    const loads = await Promise.all([
      loadModule(CORE_PATH),
      loadModule(ARTIFACTS_PATH),
      loadModule(REGISTRY_PATH),
      loadModule(CONTRACTS_V1_PATH),
      loadModule(CONTRACTS_V2_PATH),
    ]);
    for (const loaded of loads) {
      expect(
        loaded.ok,
        loaded.ok ? 'module loaded' : `${loaded.reason}: ${loaded.message}`,
      ).toBeTrue();
    }
    if (loads.some((loaded) => !loaded.ok)) return;
    const [core, artifacts, registry, v1, v2] = loads.map((loaded) =>
      loaded.ok ? loaded.module : {},
    );

    const requiredRoot = [
      'artifactContractRegistry',
      'readManifestArtifact',
      'readLockArtifact',
      'readSavedPlanArtifact',
      'readLedgerArtifact',
      'readJournalArtifact',
      'planProjectConfigMigration',
    ];
    expect(requiredRoot.filter((name) => core[name] === undefined)).toEqual([]);
    expect(core.executeProjectConfigMigration).toBeUndefined();
    expect(core.artifactContractRegistry).toBe(artifacts.artifactContractRegistry);
    expect(core.artifactContractRegistry).toBe(registry.artifactContractRegistry);
    const contractRegistry = core.artifactContractRegistry as {
      readonly codecs: readonly {
        readonly descriptor: Readonly<Record<string, unknown>>;
      }[];
      get(id: string, version: number): unknown;
    };
    expect(Object.isFrozen(contractRegistry)).toBeTrue();
    expect(
      contractRegistry.codecs.map(
        ({ descriptor }) => `${String(descriptor.id)}@${String(descriptor.version)}`,
      ),
    ).toEqual(['manifest@1', 'lock@1', 'plan@1', 'ledger@1', 'ledger@2', 'journal@1']);
    expect(contractRegistry.get('manifest', 1)).toBe(v1.manifestV1Codec);
    expect(contractRegistry.get('lock', 1)).toBe(v1.lockV1Codec);
    expect(contractRegistry.get('plan', 1)).toBe(v1.savedPlanV1Codec);
    expect(contractRegistry.get('ledger', 1)).toBe(v1.ledgerV1Codec);
    expect(contractRegistry.get('ledger', 2)).toBe(v2.ledgerV2Codec);
    expect(contractRegistry.get('journal', 1)).toBe(v1.journalV1Codec);

    const legacyFacadeSource = readFileSync(LEDGER_FACADE_PATH, 'utf8');
    expect(legacyFacadeSource).not.toMatch(/JSON\.parse|JSON\.stringify|from ['"]zod['"]/u);
    const rootSource = readFileSync(CORE_PATH, 'utf8');
    const artifactIndexSource = readFileSync(ARTIFACTS_PATH, 'utf8');
    expect(rootSource).not.toContain('executeProjectConfigMigration');
    expect(artifactIndexSource).not.toContain('executeProjectConfigMigration');
    expect(basename(MIGRATION_EXECUTOR_PATH)).toBe('migration-executor.ts');
  }, 20_000);
});
