import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolRegistry } from '../../src/agents/registry.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import { ledgerV2Codec } from '../../src/artifacts/ledger-codec.ts';
import { resolveProjectContext } from '../../src/context/project.ts';
import {
  createPlacementExecutionInput,
  createPlacementSnapshotAuthority,
  createPlacementSwapRequest,
  executeRecordOnlyPlacementPlan,
  placementSnapshotResourceId,
} from '../../src/place/execute.ts';
import { emptyLedgerModel, readLedgerState, writeLedger } from '../../src/place/ledger.ts';
import type { PairRecord, PlacementPorts } from '../../src/place/types.ts';
import {
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
} from '../../src/planning/create.ts';
import type { ExecutableOperation } from '../../src/planning/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const NOW = '2026-07-16T12:34:56-07:00';

const env = {
  wallNowIso: () => NOW,
  nextId: () => 'placement-id',
} as unknown as PlacementPorts;

const V2_GOLDEN = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'ergonomics',
  'fixtures',
  'p2-ts08',
  'ledger-v2.golden.json',
);

const unwrap = <T, E>(value: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!value.ok) throw new Error(JSON.stringify(value.error));
  return value.value;
};

test('placement snapshot resource IDs bind the full private path identity', () => {
  const alpha = placementSnapshotResourceId('source', '/fixture/source/alpha');
  const beta = placementSnapshotResourceId('source', '/fixture/source/beta');
  expect(alpha).toMatch(/^placement-source:v1:[0-9a-f]{64}$/u);
  expect(beta).not.toBe(alpha);
  expect(alpha).not.toContain('/fixture/source/alpha');
});

test('placement snapshots bind only the selected lifecycle and verification capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-place-capabilities-'));
  try {
    const ports = await defaultRuntimePorts();
    const project = await resolveProjectContext(ports, { invocationCwd: root });
    if (!project.ok) throw new Error(JSON.stringify(project.error));
    const queries = [
      {
        schemaVersion: 1,
        tool: 'codex',
        operation: 'promote',
        scope: 'user',
      },
      {
        schemaVersion: 1,
        tool: 'codex',
        operation: 'verify-static',
        scope: 'artifact',
      },
      {
        schemaVersion: 1,
        tool: 'codex',
        operation: 'verify-deep',
        scope: 'artifact',
      },
    ] as const;
    const authority = await createPlacementSnapshotAuthority(
      toolRegistry,
      queries,
      ports,
      project.value,
      join(root, 'placements.json'),
      join(root, 'store'),
      [],
      [],
    );
    if (!authority.ok) throw new Error(JSON.stringify(authority.error));
    const capabilityVersion = toolRegistry.get('codex')?.descriptor.capabilityVersion;
    if (capabilityVersion === undefined) throw new Error('codex capability descriptor is missing');

    expect(authority.value.snapshot.capabilities.value?.facts).toEqual([
      {
        schemaVersion: 1,
        tool: 'codex',
        capabilityVersion,
        operation: 'promote',
        scope: 'user',
        supported: true,
      },
      {
        schemaVersion: 1,
        tool: 'codex',
        capabilityVersion,
        operation: 'verify-static',
        scope: 'artifact',
        supported: true,
      },
      {
        schemaVersion: 1,
        tool: 'codex',
        capabilityVersion,
        operation: 'verify-deep',
        scope: 'artifact',
        supported: true,
      },
    ]);
    const resourceId = authority.value.snapshot.capabilities.revision.resourceId;
    expect(resourceId).toMatch(/^capabilities:relevant:[0-9a-f]{64}$/u);
    const reobserved = await authority.value.repositories.capabilities.observe(resourceId);
    expect(reobserved.ok).toBeTrue();
    if (reobserved.ok) {
      expect(reobserved.value.revision).toEqual(authority.value.snapshot.capabilities.revision);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const installOperation = (): ExecutableOperation => {
  const resource = {
    kind: 'live' as const,
    skill: 'alpha',
    tool: 'codex' as const,
    scope: 'user' as const,
    projectRoot: null,
    location: { kind: 'machine-bound' as const, path: '/fixture/skills/alpha' },
  };
  const source = {
    kind: 'portable' as const,
    identity: { host: 'example.test', repository: 'fixture/repo', path: 'skills/alpha' },
    requestedRef: null,
    resolvedSha: 'c'.repeat(40),
    sourcePath: 'skills/alpha',
    contentHash: `sha256:${'a'.repeat(64)}` as const,
  };
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'install',
    skill: 'alpha',
    source,
    scope: 'user',
    target: null,
  });
  const pairId = createOperationPairId({
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId,
    tool: 'codex',
    resource,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId,
    kind: 'install',
    skill: 'alpha',
    source,
    tool: 'codex',
    scope: 'user',
  });
  const placement = {
    kind: 'placement' as const,
    resource,
    classification: 'pinned' as const,
    representation: 'copy' as const,
    linkTarget: null,
    dangling: false,
    source,
    contentHash: source.contentHash,
  };
  return {
    operationId,
    groupId,
    pairId,
    kind: 'install',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: 'alpha',
    source,
    tool: 'codex',
    scope: 'user',
    before: { kind: 'absent', resource },
    after: placement,
    reason: { code: 'install-selected', message: 'Install the selected pair.' },
    selectionSource: 'explicit-targets',
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

describe('placement execution boundary', () => {
  test('binds immutable swap state and effect authorities outside SwapCtx', () => {
    const ledger = emptyLedgerModel(NOW);
    const input = createPlacementExecutionInput(env, '/tmp/placements.json', ledger, {}, {});
    const request = createPlacementSwapRequest(input);

    expect(input.journalNow()).toBe('2026-07-16T19:34:56.000Z');
    expect(input.newTransactionId(ledger)).toBe('placement-id');
    expect(request.state.ledger).toBe(ledger);
    expect(Object.isFrozen(request)).toBeTrue();
    expect(Object.isFrozen(request.context)).toBeTrue();
    expect(Object.isFrozen(request.state)).toBeTrue();
    expect(Object.isFrozen(request.effects)).toBeTrue();
    expect('ledger' in request.context).toBeFalse();
    expect('persist' in request.context).toBeFalse();
  });

  test('returns the acknowledged compacted ledger when the first candidate persist fails stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-swap-state-compaction-'));
    try {
      const ledgerPath = join(root, 'placements.json');
      const decoded = unwrap(ledgerV2Codec.decode(new Uint8Array(await readFile(V2_GOLDEN))));
      const seed = decoded.model.history[0];
      if (seed === undefined) throw new Error('missing committed history seed');
      const history = Array.from({ length: 257 }, (_, index): LogicalJournalV1Dto => {
        const transactionId = `tx:${index.toString().padStart(4, '0')}`;
        return {
          ...seed,
          transactionId,
          intent: {
            ...seed.intent,
            operationId: `operation:${index.toString().padStart(4, '0')}`,
          },
          actual: { ...seed.actual, retained: [] },
        };
      });
      const ledger = {
        ...emptyLedgerModel('2026-07-16T00:00:00.000Z'),
        history,
      };
      const ports = await defaultRuntimePorts();
      const seeded = await writeLedger(ports, ledgerPath, ledger);
      expect(seeded.ok).toBeTrue();
      if (!seeded.ok) return;
      const operation = installOperation();
      const pair: PairRecord = {
        placementPath: '/fixture/skills/alpha',
        mode: 'pinned',
        dev: null,
        pinned: {
          storePath: '/fixture/store/alpha',
          rev: 'fixture-revision',
          gitSha: null,
          dirty: false,
          contentHash: `sha256:${'a'.repeat(64)}`,
          snapshotAt: '2026-07-16T00:00:00.000Z',
          verify: 'passed',
          placement: 'copy',
        },
        origin: {
          source: 'example.test/fixture/repo/skills/alpha',
          host: 'example.test',
          repo: 'fixture/repo',
          skillPath: 'skills/alpha',
          refRequested: null,
          refResolved: 'c'.repeat(40),
          pin: false,
          installedAt: '2026-07-16T00:00:00.000Z',
        },
        journal: null,
      };
      const input = createPlacementExecutionInput(
        ports,
        ledgerPath,
        ledger,
        { newTxId: () => 'tx:repair' },
        {},
        operation,
      );

      const executed = await executeRecordOnlyPlacementPlan(input, operation, pair);
      const durable = await readLedgerState(ports, ledgerPath);

      expect(executed.ok).toBeFalse();
      if (executed.ok || !durable.ok || durable.value.state !== 'present') {
        throw new Error('expected stale execution and durable ledger');
      }
      expect(durable.value.model.history).toHaveLength(256);
      expect(executed.state.ledger).toEqual(durable.value.model);
      expect(executed.state.ledger.history).toHaveLength(256);
      expect(ledger.history).toHaveLength(257);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
