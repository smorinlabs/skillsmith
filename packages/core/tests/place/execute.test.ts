import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolRegistry } from '../../src/agents/registry.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import { ledgerV2Codec } from '../../src/artifacts/ledger-codec.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { validateJournalV1DtoShape } from '../../src/artifacts/registry.ts';
import { resolveProjectContext } from '../../src/context/project.ts';
import {
  type PlacementOperationExecutionBindingInput,
  createExplicitPlacementProjectLocationV1,
  createPlacementExecutionInput,
  createPlacementOperationExecutionBindingV1,
  createPlacementSnapshotAuthority,
  createPlacementSwapRequest,
  executeRecordOnlyPlacementPlan,
  placementSnapshotResourceId,
  rebindPlacementSnapshotAuthorityForLedgerBootstrapV1,
  withPlacementLedgerBootstrapAuthorityV1,
} from '../../src/place/execute.ts';
import { emptyLedgerModel, readLedgerState, writeLedger } from '../../src/place/ledger.ts';
import {
  beginCommittedLogicalTransactionReversal,
  beginTransactionRecoveryAttempt,
  logicalRollbackExecutionMode,
  logicalRollbackTerminalActualAfter,
} from '../../src/place/logical-transactions.ts';
import type { PairRecord, PlacementPorts } from '../../src/place/types.ts';
import {
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
} from '../../src/planning/create.ts';
import type { ExecutableOperation, OperationExecutionResult } from '../../src/planning/types.ts';
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

test('explicit project locations preserve exact non-Git identity without widening ordinary callers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-place-explicit-project-'));
  try {
    const ports = await defaultRuntimePorts();
    const discovered = await resolveProjectContext(ports, { invocationCwd: root });
    if (!discovered.ok) throw new Error(JSON.stringify(discovered.error));
    expect(discovered.value).toMatchObject({ projectRoot: null, projectIdentity: null });

    const endpointProject = Object.freeze({
      ...discovered.value,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    });
    const explicit = await createExplicitPlacementProjectLocationV1(ports, endpointProject, root);
    if (!explicit.ok) throw new Error(JSON.stringify(explicit.error));
    const authority = await createPlacementSnapshotAuthority(
      toolRegistry,
      [],
      ports,
      endpointProject,
      join(root, 'placements.json'),
      join(root, 'store'),
      [],
      [],
      undefined,
      explicit.value,
    );
    if (!authority.ok) throw new Error(JSON.stringify(authority.error));
    expect(authority.value.snapshot.project.value).toMatchObject({
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
      projectKind: 'non-git',
    });
    const reobserved = await authority.value.repositories.project.observe(
      authority.value.snapshot.project.revision.resourceId,
    );
    expect(reobserved.ok).toBeTrue();
    if (reobserved.ok) {
      expect(reobserved.value).toEqual(authority.value.snapshot.project);
    }

    const ordinary = await createPlacementSnapshotAuthority(
      toolRegistry,
      [],
      ports,
      discovered.value,
      join(root, 'ordinary-placements.json'),
      join(root, 'ordinary-store'),
      [],
      [],
    );
    if (!ordinary.ok) throw new Error(JSON.stringify(ordinary.error));
    expect(ordinary.value.snapshot.project.value).toMatchObject({
      projectRoot: null,
      projectIdentity: null,
    });

    const forged = Object.freeze({ ...explicit.value });
    const refused = await createPlacementSnapshotAuthority(
      toolRegistry,
      [],
      ports,
      endpointProject,
      join(root, 'forged-placements.json'),
      join(root, 'forged-store'),
      [],
      [],
      undefined,
      forged,
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'flip-refused', message: 'explicit project endpoint authority is invalid' },
    });

    await writeFile(join(root, 'skillsmith.toml'), 'version = 1\n');
    const changed = await authority.value.repositories.project.observe(
      authority.value.snapshot.project.revision.resourceId,
    );
    expect(changed.ok).toBeTrue();
    if (changed.ok) {
      expect(changed.value.value).toMatchObject({
        projectRoot: root,
        projectIdentity: root,
        discoveredConfigPath: join(root, 'skillsmith.toml'),
      });
      expect(changed.value.revision).not.toEqual(authority.value.snapshot.project.revision);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ledger bootstrap recapture authenticates only its exact callback-scoped self-change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-place-ledger-bootstrap-'));
  try {
    const ports = await defaultRuntimePorts();
    const coordinator = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const project = await resolveProjectContext(ports, { invocationCwd: root });
    if (!project.ok) throw new Error(JSON.stringify(project.error));
    const ledgerDirectory = join(root, 'data');
    const ledgerPath = join(ledgerDirectory, 'placements.json');
    const approved = await createPlacementSnapshotAuthority(
      toolRegistry,
      [],
      ports,
      project.value,
      ledgerPath,
      join(ledgerDirectory, 'store'),
      [],
      [],
    );
    if (!approved.ok) throw new Error(JSON.stringify(approved.error));
    expect(approved.value.snapshot.ledger.revision).toMatchObject({
      state: 'absent',
      parentKind: 'absent',
      parentIdentity: ledgerDirectory,
    });

    await withPlacementLedgerBootstrapAuthorityV1(
      { env: ports, artifactCoordinator: coordinator, ledgerPath },
      async (bootstrap) => {
        expect(bootstrap).toMatchObject({
          ledgerDirectory,
          ledgerPath,
          createdDirectory: true,
        });
        const rebound = await rebindPlacementSnapshotAuthorityForLedgerBootstrapV1(
          approved.value,
          bootstrap,
        );
        if (!rebound.ok) throw new Error(JSON.stringify(rebound.error));
        expect(rebound.value.snapshot.ledger.revision).toMatchObject({
          state: 'absent',
          parentKind: 'directory',
          parentIdentity: ledgerDirectory,
        });
        const staged = await rebound.value.repositories.ledger.stage({
          schemaVersion: 1,
          operationId: 'bootstrap-stage-test',
          domain: 'ledger',
          resourceId: rebound.value.ledgerResourceId,
          expectedRevision: rebound.value.snapshot.ledger.revision,
          editDigest: `sha256:${'a'.repeat(64)}`,
        });
        expect(staged.ok).toBeTrue();

        const forged = Object.freeze({ ...bootstrap });
        expect(
          await rebindPlacementSnapshotAuthorityForLedgerBootstrapV1(approved.value, forged),
        ).toMatchObject({
          ok: false,
          error: {
            code: 'flip-refused',
            message: 'placement ledger bootstrap authority is invalid',
          },
        });
      },
    );

    const externalDirectory = join(root, 'external-data');
    const externalLedger = join(externalDirectory, 'placements.json');
    const externallyChanged = await createPlacementSnapshotAuthority(
      toolRegistry,
      [],
      ports,
      project.value,
      externalLedger,
      join(externalDirectory, 'store'),
      [],
      [],
    );
    if (!externallyChanged.ok) throw new Error(JSON.stringify(externallyChanged.error));
    await mkdir(externalDirectory);
    await withPlacementLedgerBootstrapAuthorityV1(
      { env: ports, artifactCoordinator: coordinator, ledgerPath: externalLedger },
      async (bootstrap) => {
        expect(bootstrap.createdDirectory).toBeFalse();
        expect(
          await rebindPlacementSnapshotAuthorityForLedgerBootstrapV1(
            externallyChanged.value,
            bootstrap,
          ),
        ).toMatchObject({
          ok: false,
          error: {
            code: 'flip-refused',
            message: 'placement state changed under ledger bootstrap authority',
          },
        });
      },
    );
    expect(await ports.pathKind(externalDirectory)).toBe('dir');

    const rollbackDirectory = join(root, 'rollback-data');
    const rollbackLedger = join(rollbackDirectory, 'placements.json');
    expect(
      await withPlacementLedgerBootstrapAuthorityV1(
        {
          env: ports,
          artifactCoordinator: coordinator,
          ledgerPath: rollbackLedger,
          rollbackOnResult: (value: string) => value === 'failed',
        },
        async () => 'failed',
      ),
    ).toBe('failed');
    expect(await ports.pathKind(rollbackDirectory)).toBe('absent');

    const durableDirectory = join(root, 'durable-data');
    const durableLedger = join(durableDirectory, 'placements.json');
    expect(
      await withPlacementLedgerBootstrapAuthorityV1(
        {
          env: ports,
          artifactCoordinator: coordinator,
          ledgerPath: durableLedger,
          rollbackOnResult: (value: string) => value === 'failed',
        },
        async () => {
          await writeFile(durableLedger, '{}\n');
          return 'failed';
        },
      ),
    ).toBe('failed');
    expect(await ports.pathKind(durableLedger)).toBe('file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('live-only placement snapshots never read synthetic manifest or lock paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-place-live-only-'));
  try {
    const base = await defaultRuntimePorts();
    const project = await resolveProjectContext(base, { invocationCwd: root });
    if (!project.ok) throw new Error(JSON.stringify(project.error));
    const manifestPath = join(root, 'must-not-read.toml');
    const lockPath = join(root, 'must-not-read.lock');
    const selected = new Set([manifestPath, lockPath]);
    const reads: string[] = [];
    const ports = new Proxy(base, {
      get(target, property, receiver) {
        if (
          property === 'pathKind' ||
          property === 'readFileMetadata' ||
          property === 'readBytes'
        ) {
          const method = Reflect.get(target, property, receiver) as (path: string) => unknown;
          return (path: string) => {
            if (selected.has(path)) reads.push(`${String(property)}:${path}`);
            return method.call(target, path);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const authority = await createPlacementSnapshotAuthority(
      toolRegistry,
      [],
      ports,
      project.value,
      join(root, 'placements.json'),
      join(root, 'store'),
      [],
      [],
      { manifestPath, lockPath, observe: false },
    );
    if (!authority.ok) throw new Error(JSON.stringify(authority.error));
    await authority.value.repositories.manifest.observe(
      authority.value.snapshot.manifest.revision.resourceId,
    );
    await authority.value.repositories.lock.observe(
      authority.value.snapshot.lock.revision.resourceId,
    );
    expect(reads).toEqual([]);
    expect(authority.value.snapshot.manifest.revision).toMatchObject({ state: 'absent' });
    expect(authority.value.snapshot.lock.revision).toMatchObject({ state: 'absent' });
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
  test('begins a fresh history-preserving reversal with parent-oriented terminal facts', async () => {
    const reversalNow = '2026-07-16T19:34:56.000Z';
    const operation = installOperation();
    const liveActual = {
      resourceId: 'live:alpha',
      role: 'live' as const,
      state: 'present' as const,
      repositoryRevision: { kind: 'resource' as const, digest: `sha256:${'d'.repeat(64)}` },
      placementPath: '/fixture/skills/alpha',
      liveKind: 'directory' as const,
      mode: 'pinned' as const,
      symlinkTarget: null,
      contentHash: operation.source?.contentHash ?? null,
    };
    const absentActual = {
      resourceId: 'live:alpha',
      role: 'live' as const,
      state: 'absent' as const,
      repositoryRevision: null,
      placementPath: '/fixture/skills/alpha',
      liveKind: null,
      mode: null,
      symlinkTarget: null,
      contentHash: null,
    };
    const ledgerActual = {
      resourceId: 'ledger:user',
      role: 'ledger' as const,
      state: 'present' as const,
      repositoryRevision: { kind: 'resource' as const, digest: `sha256:${'e'.repeat(64)}` },
      schemaVersion: 2 as const,
      semanticHash: `sha256:${'f'.repeat(64)}` as const,
    };
    const sourceInput = {
      schemaVersion: 1,
      kind: 'skillsmith.transaction-journal',
      transactionId: 'tx:source-install',
      intent: {
        operationId: operation.operationId,
        groupId: operation.groupId,
        pairId: operation.pairId,
        kind: operation.kind,
        skill: operation.skill,
        source: operation.source,
        tool: operation.tool,
        scope: operation.scope,
        before: operation.before,
        after: operation.after,
        mutates: operation.mutates,
        reversibility: operation.reversibility,
        conflict: operation.conflict,
      },
      context: {
        parentOperationId: null,
        command: 'skillsmith-install',
        workflow: 'install',
        attempt: 1,
        startedAt: reversalNow,
      },
      disposition: 'forward',
      phase: 'committed',
      actual: {
        before: [absentActual, ledgerActual],
        after: [liveActual, ledgerActual],
        retained: [],
      },
      updatedAt: reversalNow,
      completedAt: reversalNow,
    };
    const sourceShape = validateJournalV1DtoShape(sourceInput);
    expect(sourceShape.ok, JSON.stringify(sourceShape)).toBeTrue();
    if (!sourceShape.ok) throw new Error(sourceShape.error.message);
    const source = sourceShape.value;
    const pair: PairRecord = {
      placementPath: '/fixture/skills/alpha',
      mode: 'pinned',
      dev: null,
      pinned: {
        storePath: '/fixture/store/alpha',
        rev: 'fixture-revision',
        gitSha: null,
        dirty: false,
        contentHash: operation.source?.contentHash ?? '',
        snapshotAt: reversalNow,
        verify: 'passed',
        placement: 'copy',
      },
      journal: null,
    };
    const model: ReturnType<typeof emptyLedgerModel> = {
      ...emptyLedgerModel(NOW),
      skills: { alpha: { tools: { codex: pair } } },
      history: [source],
    };
    const before = structuredClone(model);
    const begun = beginCommittedLogicalTransactionReversal(model, {
      sourceTransactionId: source.transactionId,
      transactionId: 'tx:fresh-reversal',
      operationId: 'operation:fresh-reversal',
      groupId: 'group:fresh-reversal',
      command: 'skillsmith-undo',
      workflow: 'undo',
      startedAt: reversalNow,
      updatedAt: reversalNow,
    });

    expect(begun.ok, JSON.stringify(begun)).toBeTrue();
    if (!begun.ok) throw new Error(begun.error.message);
    expect(model).toEqual(before);
    expect(begun.value.history).toEqual(model.history);
    const rollback = begun.value.transactions['tx:fresh-reversal'];
    if (rollback === undefined) throw new Error('fresh reversal transaction missing');
    expect(rollback).toMatchObject({
      disposition: 'rollback',
      phase: 'prepared',
      intent: {
        operationId: 'operation:fresh-reversal',
        groupId: 'group:fresh-reversal',
        before: source.intent.before,
        after: source.intent.after,
      },
      context: {
        parentOperationId: source.intent.operationId,
        command: 'skillsmith-undo',
        workflow: 'undo',
      },
      actual: { before: source.actual.after, after: [], retained: source.actual.retained },
    });
    expect(logicalRollbackExecutionMode(begun.value, rollback)).toEqual({
      ok: true,
      value: 'fresh-reversal',
    });
    expect(logicalRollbackTerminalActualAfter(begun.value, rollback)).toEqual({
      ok: true,
      value: source.actual.before,
    });

    const attempted = beginTransactionRecoveryAttempt(begun.value, {
      transactionId: rollback.transactionId,
      command: 'skillsmith-undo',
      workflow: 'undo',
      updatedAt: reversalNow,
    });
    expect(attempted.ok).toBeTrue();
    if (!attempted.ok) throw new Error(attempted.error.message);
    const retried = attempted.value.transactions[rollback.transactionId];
    if (retried === undefined) throw new Error('retried reversal transaction missing');
    expect(retried.context.parentOperationId).toBe(source.intent.operationId);
    expect(logicalRollbackExecutionMode(attempted.value, retried)).toEqual({
      ok: true,
      value: 'fresh-reversal',
    });
    expect(logicalRollbackTerminalActualAfter(attempted.value, retried)).toEqual({
      ok: true,
      value: source.actual.before,
    });

    const convertedPending = {
      ...source,
      disposition: 'rollback' as const,
      phase: 'prepared' as const,
      context: { ...source.context, parentOperationId: source.intent.operationId },
      actual: { ...source.actual, after: [] },
      completedAt: null,
    };
    expect(logicalRollbackExecutionMode(model, convertedPending)).toEqual({
      ok: true,
      value: 'resume-rollback',
    });
    expect(logicalRollbackTerminalActualAfter(model, convertedPending)).toEqual({
      ok: true,
      value: source.actual.before,
    });

    const inconsistent = {
      ...rollback,
      actual: { ...rollback.actual, before: source.actual.before },
    };
    expect(logicalRollbackExecutionMode(begun.value, inconsistent)).toMatchObject({
      ok: false,
      error: { reason: 'identity-conflict' },
    });
  });

  test('creates an exact pair binding that delegates through the placement lifecycle', async () => {
    const operation = installOperation();
    const stageResourceIds = ['live:alpha', 'store:alpha'];
    const calls: string[] = [];
    const observation = {} as Parameters<
      ReturnType<typeof createPlacementOperationExecutionBindingV1>['execute']
    >[1];
    const expected: OperationExecutionResult = {
      operationId: operation.operationId,
      outcome: 'succeeded',
      actualBefore: operation.before,
      actualAfter: operation.after,
      force: null,
      error: null,
    };
    const unstartedForce = {
      requested: false,
      applied: false,
      conflictType: null,
      target: null,
      normalBehavior: null,
      forcedBehavior: null,
      backup: null,
    } as const;
    const input: PlacementOperationExecutionBindingInput = {
      operation,
      stageResourceIds,
      unstartedForce,
      lifecycle: {
        execute: async (receivedOperation, receivedResourceIds, commit) => {
          expect(receivedOperation).toBe(operation);
          expect(receivedResourceIds).toEqual(stageResourceIds);
          expect(Object.isFrozen(receivedResourceIds)).toBeTrue();
          calls.push('lifecycle');
          return commit();
        },
      },
      observeActualBefore: async () => operation.before,
      execute: async (validated, receivedObservation) => {
        expect(validated.operationId).toBe(operation.operationId);
        expect(receivedObservation).toBe(observation);
        calls.push('execute');
        return expected;
      },
    };
    const binding = createPlacementOperationExecutionBindingV1(input);
    const validated = {
      operationId: operation.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      actualBefore: operation.before,
      unstartedForce: null,
      execute: async () => expected,
    };

    expect(binding.operationId).toBe(operation.operationId);
    expect(binding.groupId).toBe(operation.groupId);
    expect(binding.pairId).toBe(operation.pairId);
    expect(binding.unstartedForce).toBe(unstartedForce);
    expect(await binding.observeActualBefore()).toBe(operation.before);
    expect(await binding.execute(validated, observation)).toBe(expected);
    expect(calls).toEqual(['lifecycle', 'execute']);
    expect(Object.isFrozen(binding)).toBeTrue();
  });

  test('snapshots execution authorities so a retained input cannot retarget the binding', async () => {
    const operation = installOperation();
    const calls: string[] = [];
    const expected: OperationExecutionResult = {
      operationId: operation.operationId,
      outcome: 'succeeded',
      actualBefore: operation.before,
      actualAfter: operation.after,
      force: null,
      error: null,
    };
    const input: PlacementOperationExecutionBindingInput = {
      operation,
      stageResourceIds: ['live:alpha'],
      unstartedForce: null,
      lifecycle: {
        execute: async (_operation, _resourceIds, commit) => {
          calls.push('original-lifecycle');
          return commit();
        },
      },
      observeActualBefore: async () => operation.before,
      execute: async () => {
        calls.push('original-execute');
        return expected;
      },
    };
    const binding = createPlacementOperationExecutionBindingV1(input);
    const mutable = input as {
      operation: ExecutableOperation;
      lifecycle: PlacementOperationExecutionBindingInput['lifecycle'];
      observeActualBefore: PlacementOperationExecutionBindingInput['observeActualBefore'];
      execute: PlacementOperationExecutionBindingInput['execute'];
    };
    mutable.operation = { ...operation, operationId: 'retargeted-operation' };
    mutable.lifecycle = {
      execute: async (_operation, _resourceIds, commit) => {
        calls.push('retargeted-lifecycle');
        return commit();
      },
    };
    mutable.observeActualBefore = async () => operation.after;
    mutable.execute = async () => {
      calls.push('retargeted-execute');
      return expected;
    };

    expect(await binding.observeActualBefore()).toBe(operation.before);
    await binding.execute({
      operationId: operation.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      actualBefore: operation.before,
      unstartedForce: null,
      execute: async () => expected,
    });
    expect(calls).toEqual(['original-lifecycle', 'original-execute']);
  });

  test('rejects missing pair identity and invalid stage resource identities', () => {
    const operation = installOperation();
    const create = (candidate: ExecutableOperation, stageResourceIds: readonly string[]): unknown =>
      createPlacementOperationExecutionBindingV1({
        operation: candidate,
        stageResourceIds,
        unstartedForce: null,
        lifecycle: { execute: async (_operation, _resourceIds, commit) => commit() },
        observeActualBefore: async () => candidate.before,
        execute: async () => {
          throw new Error('not called');
        },
      });

    expect(() => create({ ...operation, pairId: null }, ['live:alpha'])).toThrow(
      'prepared operation pair identity is missing',
    );
    expect(() => create(operation, [''])).toThrow(
      'prepared placement stage resource identity is empty',
    );
    expect(() => create(operation, ['live:alpha', 'live:alpha'])).toThrow(
      'prepared placement stage resource identities must be unique',
    );
  });

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
