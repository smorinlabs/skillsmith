import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeProjectConfigMigration } from '../../src/artifacts/migration-executor.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import {
  type ArtifactReadPorts,
  type ArtifactRepositoryError,
  planProjectConfigMigration,
  readJournalArtifact,
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
  readSavedPlanArtifact,
} from '../../src/artifacts/repository.ts';

const TS08 = join(import.meta.dir, '../../../../tests/ergonomics/fixtures/p2-ts08');
const TS06_MIGRATIONS = join(
  import.meta.dir,
  '../../../../tests/ergonomics/fixtures/p2-ts06/migration-cases.json',
);
const encoder = new TextEncoder();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const readPorts = (bytes: Uint8Array): ArtifactReadPorts => ({
  pathKind: async () => 'file',
  readBytes: async () => new Uint8Array(bytes),
});

const unwrap = <T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false },
): T => {
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error('expected success');
  return result.value;
};

const expectError = (
  result: { readonly ok: boolean; readonly error?: ArtifactRepositoryError },
  reason: ArtifactRepositoryError['reason'],
  exitCode: ArtifactRepositoryError['exitCode'],
): void => {
  expect(result.ok).toBeFalse();
  expect(result.error).toMatchObject({
    code: 'artifact-repository',
    reason,
    exitCode,
    path: expect.any(Array),
  });
  expect(JSON.stringify(result.error)).not.toContain('P17_SECRET_CANARY');
};

describe('artifact repository', () => {
  test('enforces request, port, absent, kind, permission, and byte ownership precedence', async () => {
    const counters = { pathKind: 0, readBytes: 0 };
    const invalid = await readManifestArtifact(
      {
        pathKind: async () => {
          counters.pathKind += 1;
          return 'file';
        },
        readBytes: async () => {
          counters.readBytes += 1;
          return new Uint8Array();
        },
      },
      '/fixture/ghp_P17_SECRET_CANARY_123456789.toml',
    );
    expectError(invalid, 'invalid-request', 2);
    expect(counters).toEqual({ pathKind: 0, readBytes: 0 });

    let absentReads = 0;
    const absent = unwrap(
      await readManifestArtifact(
        {
          pathKind: async () => 'absent',
          readBytes: async () => {
            absentReads += 1;
            return new Uint8Array();
          },
        },
        '/fixture/missing.toml',
      ),
    );
    expect(absent).toEqual({ state: 'absent', artifact: 'manifest', migration: null });
    expect(absentReads).toBe(0);

    const wrongKind = await readManifestArtifact(
      {
        pathKind: async () => 'dir',
        readBytes: async () => new Uint8Array(),
      },
      '/fixture/directory',
    );
    expectError(wrongKind, 'invalid-file-kind', 3);

    const permission = await readManifestArtifact(
      {
        pathKind: async () => {
          throw Object.assign(new Error('not retained'), { code: 'EACCES' });
        },
        readBytes: async () => new Uint8Array(),
      },
      '/fixture/manifest.toml',
    );
    expectError(permission, 'permission-denied', 6);

    const shared = await readManifestArtifact(
      {
        pathKind: async () => 'file',
        readBytes: async () => new Uint8Array(new SharedArrayBuffer(16)),
      },
      '/fixture/manifest.toml',
    );
    expectError(shared, 'read-failed', 3);
  });

  test('reads all five artifact families through the registry with immutable revisions', async () => {
    const cases = [
      [readManifestArtifact, 'manifest-v1.golden.toml', 1, 1, null],
      [readLockArtifact, 'lock-v1.golden.toml', 1, 1, null],
      [readSavedPlanArtifact, 'plan-v1.golden.json', 1, 1, null],
      [readLedgerArtifact, 'ledger-v1.golden.json', 1, 2, 'ledger-v1-to-v2'],
      [readLedgerArtifact, 'ledger-v2.golden.json', 2, 2, null],
      [readJournalArtifact, 'journal-v1.golden.json', 1, 1, null],
    ] as const;
    for (const [read, file, sourceVersion, currentVersion, migrationKind] of cases) {
      const bytes = new Uint8Array(await Bun.file(join(TS08, file)).arrayBuffer());
      const envelope = unwrap(
        await (read as typeof readManifestArtifact)(readPorts(bytes), `/fixture/${file}`),
      );
      expect(envelope.state, file).toBe('present');
      if (envelope.state !== 'present') continue;
      expect(envelope, file).toMatchObject({
        sourceVersion,
        currentVersion,
        byteLength: bytes.byteLength,
        canonical: true,
      });
      expect(envelope.migration?.kind ?? null, file).toBe(migrationKind);
      expect(envelope.source, file).toBe(new TextDecoder().decode(bytes));
      expect(Object.isFrozen(envelope), file).toBeTrue();
      expect(Object.isFrozen(envelope.model as object), file).toBeTrue();
      expect(envelope).not.toHaveProperty('bytes');
    }
  });

  test('plans the exact lossless manifest migration and exposes it on legacy reads', async () => {
    const fixtures = await Bun.file(TS06_MIGRATIONS).json();
    for (const fixture of fixtures.projectMigrations as readonly {
      readonly before: string;
      readonly after: string;
      readonly sourceByteRevision: string;
      readonly resultByteRevision: string;
      readonly semanticRevision: string;
    }[]) {
      const operation = unwrap(planProjectConfigMigration(fixture.before));
      expect(operation.kind).toBe('migrate-project-config');
      expect(operation.from).toBe('legacy');
      expect(operation.toVersion).toBe(1);
      expect(operation.expectedByteRevision as string).toBe(fixture.sourceByteRevision);
      expect(operation.expectedSemanticRevision as string).toBe(fixture.semanticRevision);
      expect(operation.resultByteRevision as string).toBe(fixture.resultByteRevision);
      expect(operation.resultSemanticRevision as string).toBe(fixture.semanticRevision);
      expect(operation.resultSource).toBe(fixture.after);
      expect(operation.createsLockfile).toBeFalse();
      const envelope = unwrap(
        await readManifestArtifact(
          readPorts(encoder.encode(fixture.before)),
          '/fixture/manifest.toml',
        ),
      );
      expect(envelope.state).toBe('present');
      if (envelope.state === 'present') expect(envelope.migration).toEqual(operation);
    }
  });

  test('normalizes canonical presentation before sensitive content at the repository boundary', async () => {
    const plan = await Bun.file(join(TS08, 'plan-v1.golden.json')).json();
    plan.skillsmithVersion = 'ghp_P17_SECRET_CANARY_123456789';
    const compact = await readSavedPlanArtifact(
      readPorts(encoder.encode(JSON.stringify(plan))),
      '/fixture/plan.json',
    );
    expectError(compact, 'noncanonical', 3);
    const canonical = await readSavedPlanArtifact(
      readPorts(encoder.encode(`${JSON.stringify(plan, null, 2)}\n`)),
      '/fixture/plan.json',
    );
    expectError(canonical, 'sensitive-content', 3);
  });

  test('executes only an exact fresh migration through the single-file coordinator', async () => {
    const fixtures = await Bun.file(TS06_MIGRATIONS).json();
    const fixture = fixtures.projectMigrations[0] as {
      readonly before: string;
      readonly after: string;
      readonly mode: number;
    };
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-repository-'));
    roots.push(root);
    const path = join(root, 'manifest.toml');
    await writeFile(path, fixture.before);
    await chmod(path, fixture.mode);
    const operation = unwrap(planProjectConfigMigration(fixture.before));
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const result = unwrap(await executeProjectConfigMigration(ports, path, operation));
    expect(result.outcome).toBe('committed');
    expect(await readFile(path, 'utf8')).toBe(fixture.after);
    expect((await stat(path)).mode & 0o777).toBe(fixture.mode);
    expect(existsSync(join(root, 'manifest.lock'))).toBeFalse();

    await writeFile(path, 'version = 1\n');
    const stale = await executeProjectConfigMigration(ports, path, operation);
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'artifact-mutation', reason: 'external-writer-conflict' },
    });
    expect(await readFile(path, 'utf8')).toBe('version = 1\n');
  });
});
