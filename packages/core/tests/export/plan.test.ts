import { describe, expect, test } from 'bun:test';
import type { CurrentApplicationContext } from '../../src/application/types.ts';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { artifactContractRegistry } from '../../src/artifacts/registry.ts';
import type { PreparedExportArtifacts } from '../../src/export/merge.ts';
import type { ExportObservation } from '../../src/export/observe.ts';
import { prepareExportLedgerMigration, prepareExportOperationPlan } from '../../src/export/plan.ts';
import { previewExportEffects } from '../../src/export/run.ts';

const unchanged = {
  manifestChanged: false,
  manifestAction: 'unchanged',
  lockChanged: false,
  lockAction: 'unchanged',
} as PreparedExportArtifacts;

describe('export operation planning', () => {
  test('unchanged artifacts plan no operations and never inspect ledger migration state', () => {
    const context = new Proxy({} as CurrentApplicationContext, {
      get: (_target, property) => {
        throw new Error(`unchanged planning unexpectedly read ${String(property)}`);
      },
    });
    expect(prepareExportLedgerMigration(context, {} as ExportObservation, unchanged)).toBeNull();
    expect(
      previewExportEffects(
        {
          pair: null,
          request: { tools: ['claude-code'], scope: 'user' },
        } as unknown as ExportObservation,
        unchanged,
      ),
    ).toEqual([
      {
        role: 'ledger',
        action: 'not-written',
        operationId: null,
        outcome: 'not-run',
      },
      {
        role: 'manifest',
        action: 'unchanged',
        operationId: null,
        outcome: 'not-run',
      },
      {
        role: 'lock',
        action: 'unchanged',
        operationId: null,
        outcome: 'not-run',
      },
    ]);
  });

  test('absent pair plans stable preconditioned manifest then lock operations', () => {
    const manifest = Object.freeze({
      version: 1 as const,
      skills: Object.freeze([
        Object.freeze({
          name: 'alpha',
          source: Object.freeze({ host: 'github.com', repository: 'acme/skills', path: 'alpha' }),
          ref: 'main',
          tools: Object.freeze(['claude-code'] as const),
          scope: 'user' as const,
          placement: 'symlink' as const,
          path: null,
        }),
      ]),
    });
    const manifestCodec = artifactContractRegistry.get('manifest', 1);
    if (manifestCodec === undefined) throw new Error('manifest codec fixture is unavailable');
    const encodedManifest = manifestCodec.encode(manifest);
    if (!encodedManifest.ok) throw new Error('manifest fixture could not be encoded');
    const lock = Object.freeze({
      version: 1 as const,
      hashSchemaVersion: 1 as const,
      manifestHash: hashManifestSemantics(manifest),
      skills: Object.freeze([
        Object.freeze({
          name: 'alpha',
          source: 'github.com/acme/skills//alpha',
          requestedRef: 'main',
          resolvedSha: 'a'.repeat(40),
          sourcePath: 'alpha',
          contentHash: `sha256:${'b'.repeat(64)}` as ArtifactDigest,
        }),
      ]),
    });
    const encodedLock = serializePortableLock(lock);
    if (!encodedLock.ok) throw new Error('lock fixture could not be encoded');
    const observation = {
      pair: {
        file: {
          path: '/portable/skillsmith.toml',
          token: null,
          portability: 'machine-bound',
          portableToken: null,
        },
        lockfile: {
          path: '/portable/skillsmith.lock',
          token: null,
          portability: 'machine-bound',
          portableToken: null,
        },
        lockfileSource: 'explicit',
      },
      manifest: { state: 'absent', artifact: 'manifest', migration: null },
      lock: { state: 'absent', artifact: 'lock', migration: null },
      request: { tools: ['claude-code'], scope: 'user' },
    } as unknown as ExportObservation;
    const prepared = {
      manifest,
      manifestBytes: encodedManifest.value,
      manifestChanged: true,
      manifestAction: 'create',
      manifestEdits: [],
      lock,
      lockBytes: new TextEncoder().encode(encodedLock.value),
      lockChanged: true,
      lockAction: 'create',
    } as unknown as PreparedExportArtifacts;

    const first = prepareExportOperationPlan(observation, prepared);
    const second = prepareExportOperationPlan(observation, prepared);

    expect(first).toEqual(second);
    expect(first.operations.map(({ kind }) => kind)).toEqual(['write-manifest', 'write-lock']);
    const [manifestOperation, lockOperation] = first.operations;
    if (manifestOperation === undefined || lockOperation === undefined) {
      throw new Error('export operation chain was incomplete');
    }
    expect(manifestOperation.preconditionIds).toHaveLength(1);
    expect(lockOperation.preconditionIds).toHaveLength(1);
    expect(lockOperation.dependencyMetadata.operationIds).toEqual([manifestOperation.operationId]);
    expect(manifestOperation.before).toMatchObject({
      kind: 'absent',
      resource: { kind: 'manifest-bytes' },
    });
    expect(lockOperation.before).toMatchObject({ kind: 'absent', resource: { kind: 'lock' } });
    expect(manifestOperation.after).toMatchObject({ kind: 'manifest', shape: 'canonical' });
    expect(lockOperation.after).toMatchObject({ kind: 'lock' });
  });
});
