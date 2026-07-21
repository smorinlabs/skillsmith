import { describe, expect, test } from 'bun:test';
import type { ExecutableOperation, OperationSource } from '../../src/planning/types.ts';
import { createSyncPlacementExecutionPlanV1 } from '../../src/sync/execute.ts';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const OLD_HASH = `sha256:${'b'.repeat(64)}` as const;
const localSource: OperationSource = {
  kind: 'local-dev',
  path: '/fixture/source/alpha',
  contentHash: HASH,
};
const portableSource: OperationSource = {
  kind: 'portable',
  identity: { host: 'fixture.invalid', repository: 'acme/skills', path: 'skills/alpha' },
  requestedRef: 'main',
  resolvedSha: 'c'.repeat(40),
  sourcePath: 'skills/alpha',
  contentHash: HASH,
};
const resource = {
  kind: 'live' as const,
  skill: 'alpha',
  tool: 'codex' as const,
  scope: 'user' as const,
  projectRoot: null,
  location: { kind: 'machine-bound' as const, path: '/fixture/live/alpha' },
};
const operation = (source: OperationSource = localSource): ExecutableOperation => ({
  operationId: 'operation:sync-alpha',
  groupId: 'group:sync-alpha',
  pairId: 'pair:sync-alpha-codex',
  kind: 'update',
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: [],
  },
  skill: 'alpha',
  source,
  tool: 'codex',
  scope: 'user',
  before: {
    kind: 'placement',
    resource,
    classification: 'unmanaged',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source: null,
    contentHash: OLD_HASH,
  },
  after: {
    kind: 'placement',
    resource,
    classification: 'pinned',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source,
    contentHash: HASH,
  },
  reason: { code: 'sync-update-selected', message: 'Update alpha.' },
  selectionSource: 'bounded-default',
  preconditionIds: [],
  requiredCheckIds: [],
  reversibility: { kind: 'conditional', retentionResourceIds: ['pair:sync-alpha-codex'] },
  mutates: { live: true, manifest: false, lock: false, ledger: true },
  conflict: null,
});
const pinned = {
  storePath: '/fixture/store/alpha',
  rev: 'local-alpha',
  gitSha: null,
  dirty: false,
  contentHash: HASH,
  snapshotAt: '2026-07-21T00:00:00.000Z',
  verify: 'passed' as const,
  placement: 'copy' as const,
};

describe('sync placement execution projection', () => {
  test('binds local update to the existing install swap without synthetic origin', () => {
    const result = createSyncPlacementExecutionPlanV1(operation(), {
      operationId: 'operation:sync-alpha',
      placementPath: '/fixture/live/alpha',
      scopeKey: null,
      storePath: '/fixture/store/alpha',
      pinned,
      origin: null,
    });
    expect(result).toMatchObject({
      kind: 'swap',
      plan: {
        op: 'install',
        install: { build: 'copy', origin: null, contentHash: HASH },
      },
    });
  });

  test('requires exact portable provenance and preserves it', () => {
    const origin = {
      source: 'fixture.invalid/acme/skills//skills/alpha',
      host: 'fixture.invalid',
      repo: 'acme/skills',
      skillPath: 'skills/alpha',
      refRequested: 'main',
      refResolved: 'c'.repeat(40),
      pin: true,
      installedAt: '2026-07-21T00:00:00.000Z',
    };
    const result = createSyncPlacementExecutionPlanV1(operation(portableSource), {
      operationId: 'operation:sync-alpha',
      placementPath: '/fixture/live/alpha',
      scopeKey: null,
      storePath: '/fixture/store/alpha',
      pinned: { ...pinned, gitSha: 'c'.repeat(40) },
      origin,
    });
    expect(result).toMatchObject({ kind: 'swap', plan: { install: { origin } } });
  });

  test('refuses provenance fabrication and mismatched pair-to-store bindings', () => {
    const fakeOrigin = {
      source: 'fixture.invalid/fake/repo',
      host: 'fixture.invalid',
      repo: 'fake/repo',
      skillPath: 'skills/alpha',
      refRequested: null,
      refResolved: 'd'.repeat(40),
      pin: true,
      installedAt: '2026-07-21T00:00:00.000Z',
    };
    expect(() =>
      createSyncPlacementExecutionPlanV1(operation(), {
        operationId: 'operation:sync-alpha',
        placementPath: '/fixture/live/alpha',
        scopeKey: null,
        storePath: '/fixture/store/alpha',
        pinned,
        origin: fakeOrigin,
      }),
    ).toThrow('machine-bound sync cannot carry portable provenance');
    expect(() =>
      createSyncPlacementExecutionPlanV1(operation(), {
        operationId: 'operation:sync-alpha',
        placementPath: '/fixture/live/alpha',
        scopeKey: null,
        storePath: '/fixture/store/beta',
        pinned,
        origin: null,
      }),
    ).toThrow('execution binding is incoherent');
  });
});
