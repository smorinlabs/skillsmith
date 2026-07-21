import { describe, expect, test } from 'bun:test';
import type { ExecutableOperation, OperationImage } from '../../src/planning/types.ts';
import {
  type SyncArtifactAfterImageGroupV1,
  chainSyncArtifactAfterImagesV1,
} from '../../src/sync/artifacts.ts';

const HASH = (value: string) => `sha256:${value.repeat(64)}` as `sha256:${string}`;
const manifest = (hash: `sha256:${string}`): Extract<OperationImage, { kind: 'manifest' }> => ({
  kind: 'manifest',
  location: { kind: 'machine-bound', path: '/fixture/skillsmith.toml' },
  shape: 'canonical',
  version: 1,
  byteHash: hash,
  semanticHash: hash,
  value: { version: 1, defaults: null, registry: null, skills: [] },
});
const lock = (hash: `sha256:${string}`): Extract<OperationImage, { kind: 'lock' }> => ({
  kind: 'lock',
  location: { kind: 'machine-bound', path: '/fixture/skillsmith.lock' },
  version: 1,
  canonicalHash: hash,
  value: {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hash,
    skills: [],
  },
});
const artifactOperation = (
  groupId: string,
  operationId: string,
  kind: 'write-manifest' | 'write-lock',
  before: OperationImage,
  after: OperationImage,
  dependencies: readonly string[] = [],
): ExecutableOperation => ({
  operationId,
  groupId,
  pairId: null,
  kind,
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: dependencies,
  },
  skill: null,
  source: null,
  tool: null,
  scope: null,
  before,
  after,
  reason: { code: `${kind}-selected`, message: `${kind} selected.` },
  selectionSource: 'bounded-default',
  preconditionIds: [],
  requiredCheckIds: [],
  reversibility: { kind: 'none', retentionResourceIds: [] },
  mutates: {
    live: false,
    manifest: kind === 'write-manifest',
    lock: kind === 'write-lock',
    ledger: false,
  },
  conflict: null,
});
const placementOperation = (groupId: string, operationId: string): ExecutableOperation => ({
  ...artifactOperation(groupId, operationId, 'write-lock', lock(HASH('a')), lock(HASH('b'))),
  pairId: 'pair:alpha',
  kind: 'remove',
  skill: 'alpha',
  tool: 'codex',
  scope: 'user',
  before: {
    kind: 'placement',
    resource: {
      kind: 'live',
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectRoot: null,
      location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
    },
    classification: 'pinned',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source: null,
    contentHash: null,
  },
  after: {
    kind: 'absent',
    resource: {
      kind: 'live',
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectRoot: null,
      location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
    },
  },
  mutates: { live: true, manifest: false, lock: false, ledger: true },
});

const group = (
  groupId: string,
  beforeManifest: Extract<OperationImage, { kind: 'manifest' }>,
  afterManifest: Extract<OperationImage, { kind: 'manifest' }>,
  beforeLock: Extract<OperationImage, { kind: 'lock' }>,
  afterLock: Extract<OperationImage, { kind: 'lock' }>,
): SyncArtifactAfterImageGroupV1 => {
  const manifestOperationId = `${groupId}:manifest`;
  const lockOperationId = `${groupId}:lock`;
  return {
    groupId,
    manifestOperation: artifactOperation(
      groupId,
      manifestOperationId,
      'write-manifest',
      beforeManifest,
      afterManifest,
    ) as SyncArtifactAfterImageGroupV1['manifestOperation'],
    lockOperation: artifactOperation(
      groupId,
      lockOperationId,
      'write-lock',
      beforeLock,
      afterLock,
      [manifestOperationId],
    ) as SyncArtifactAfterImageGroupV1['lockOperation'],
    placementOperations: [placementOperation(groupId, `${groupId}:live`)],
  };
};

describe('sync artifact after-image chain', () => {
  test('binds each later colliding group to the latest exact write-lock prefix', () => {
    const first = group(
      'group:first',
      manifest(HASH('a')),
      manifest(HASH('b')),
      lock(HASH('a')),
      lock(HASH('b')),
    );
    const second = group(
      'group:second',
      first.manifestOperation.after,
      manifest(HASH('c')),
      first.lockOperation.after,
      lock(HASH('c')),
    );
    const input = structuredClone([first, second]);
    const result = chainSyncArtifactAfterImagesV1(input);

    expect(input).toEqual([first, second]);
    expect(result[1]?.manifestOperation.dependencyMetadata.operationIds).toContain(
      first.lockOperation.operationId,
    );
    expect(result[1]?.lockOperation.dependencyMetadata.operationIds).toContain(
      first.lockOperation.operationId,
    );
    expect(result[1]?.placementOperations[0]?.dependencyMetadata.operationIds).toContain(
      first.lockOperation.operationId,
    );
    expect(Object.isFrozen(result)).toBeTrue();
  });

  test('refuses branch-dependent or stale artifact before-images', () => {
    const first = group(
      'group:first',
      manifest(HASH('a')),
      manifest(HASH('b')),
      lock(HASH('a')),
      lock(HASH('b')),
    );
    const stale = group(
      'group:stale',
      manifest(HASH('a')),
      manifest(HASH('c')),
      lock(HASH('a')),
      lock(HASH('c')),
    );
    expect(() => chainSyncArtifactAfterImagesV1([first, stale])).toThrow(
      'does not consume the latest exact after-image',
    );
  });
});
