import { describe, expect, test } from 'bun:test';
import {
  type AcquisitionSnapshotAuthorityV1,
  createAcquisitionRepositoryLifecycleControllerV1,
  executeAcquirePlans,
} from '../../src/acquire/execute.ts';
import type { PlacementExecutionInput } from '../../src/place/execute.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import type { PlacementPorts } from '../../src/place/types.ts';
import { createOperationExecutionResult } from '../../src/planning/create.ts';
import type { ExecutableOperation, OperationExecutionResult } from '../../src/planning/types.ts';
import { err, ok } from '../../src/result.ts';
import { stageLogicalRepositoryEditV1 } from '../../src/state/repositories.ts';
import { type ExpectedRevisionV1, createExpectedRevisionV1 } from '../../src/state/types.ts';

const absentLedgerRevision = (resourceId: string, marker: string): ExpectedRevisionV1 => {
  const revision = createExpectedRevisionV1({
    schemaVersion: 1,
    domain: 'ledger',
    resourceId,
    state: 'absent',
    targetIdentity: `/fixture/${marker}/placements.json`,
    targetKind: 'absent',
    parentIdentity: `/fixture/${marker}`,
    parentKind: 'directory',
    parentMetadataIdentity: `metadata:v1:${marker.repeat(64).slice(0, 64)}`,
  });
  if (!revision.ok) throw new Error('fixture revision is invalid');
  return revision.value;
};

const operation = (marker: string): ExecutableOperation => {
  return {
    operationId: `operation:v1:${marker.repeat(64).slice(0, 64)}`,
    groupId: `group:v1:${marker.repeat(64).slice(0, 64)}`,
    pairId: null,
    kind: 'migrate-ledger',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 1,
      byteHash: `sha256:${'a'.repeat(64)}`,
      semanticHash: `sha256:${'b'.repeat(64)}`,
    },
    after: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 2,
      byteHash: `sha256:${'c'.repeat(64)}`,
      semanticHash: `sha256:${'d'.repeat(64)}`,
    },
    reason: { code: 'fixture', message: 'fixture' },
    selectionSource: 'explicit-targets',
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: false, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const resultFor = (
  operation: ExecutableOperation,
  outcome: 'succeeded' | 'failed',
): OperationExecutionResult =>
  createOperationExecutionResult({
    operationId: operation.operationId,
    outcome,
    actualBefore: operation.before,
    actualAfter: outcome === 'succeeded' ? operation.after : operation.before,
    force: null,
    error:
      outcome === 'succeeded'
        ? null
        : {
            code: 'fixture-failed',
            message: 'fixture failed',
            remediation: 'retry',
          },
  });

const lifecycleFixture = () => {
  const resourceId = 'ledger:fixture';
  const firstRevision = absentLedgerRevision(resourceId, 'a');
  const secondRevision = absentLedgerRevision(resourceId, 'b');
  let currentRevision = firstRevision;
  let observationFails = false;
  const stagedExpected: ExpectedRevisionV1[] = [];
  const repository = {
    observe: async () => err({ code: 'unused' }),
    observeRevision: async () =>
      observationFails
        ? err({
            code: 'state-repository' as const,
            domain: 'ledger' as const,
            reason: 'observation-failed' as const,
          })
        : ok(currentRevision),
    stage: async (request: Parameters<typeof stageLogicalRepositoryEditV1>[0]) => {
      stagedExpected.push(request.expectedRevision);
      return stageLogicalRepositoryEditV1({
        ...request,
        observedRevision: currentRevision,
      });
    },
  };
  const authority = {
    ledgerResourceId: resourceId,
    repositories: { ledger: repository, live: repository, store: repository },
  } as unknown as AcquisitionSnapshotAuthorityV1;
  const controller = createAcquisitionRepositoryLifecycleControllerV1({
    authority,
    snapshotId: `snapshot:v1:${'e'.repeat(64)}`,
    expectedRevisions: [firstRevision],
  });
  return {
    controller,
    resourceId,
    firstRevision,
    secondRevision,
    stagedExpected,
    setRevision: (revision: ExpectedRevisionV1) => {
      currentRevision = revision;
    },
    failObservation: () => {
      observationFails = true;
    },
  };
};

const executeLifecycleBinding = async (
  fixture: ReturnType<typeof lifecycleFixture>,
  planned: ExecutableOperation,
  execute: () => Promise<OperationExecutionResult>,
) => {
  const bound = fixture.controller.bind(
    planned,
    {
      operationId: planned.operationId,
      groupId: planned.groupId,
      pairId: planned.pairId,
      unstartedForce: null,
      observeActualBefore: async () => planned.before,
      execute: async () => execute(),
    },
    [fixture.resourceId],
  );
  return bound.execute({
    operationId: planned.operationId,
    groupId: planned.groupId,
    pairId: planned.pairId,
    actualBefore: planned.before,
    unstartedForce: null,
    execute: async () => {
      throw new Error('fixture validated binding cannot be re-entered');
    },
  });
};

describe('acquisition execution boundary', () => {
  test('preserves the approved ledger for an empty physical plan sequence', async () => {
    const ledger = emptyLedgerModel('2026-07-16T00:00:00.000Z');
    const input: PlacementExecutionInput = {
      env: {} as PlacementPorts,
      ledgerPath: '/tmp/placements.json',
      ledger,
      journalNow: () => '2026-07-16T00:00:00.000Z',
      newTransactionId: () => 'unused',
    };

    const executed = await executeAcquirePlans(input, []);
    expect(executed.ok).toBeTrue();
    if (executed.ok) expect(executed.value).toEqual([]);
    expect(executed.state.ledger).toBe(ledger);
  });

  test('advances the sequential cursor through committed lifecycle receipts', async () => {
    const fixture = lifecycleFixture();
    const first = operation('1');
    const second = operation('2');
    await executeLifecycleBinding(fixture, first, async () => {
      fixture.setRevision(fixture.secondRevision);
      return resultFor(first, 'succeeded');
    });
    await executeLifecycleBinding(fixture, second, async () => resultFor(second, 'succeeded'));

    expect(fixture.stagedExpected).toEqual([fixture.firstRevision, fixture.secondRevision]);
  });

  test('keeps the sequential cursor usable after a truthful rolled-back receipt', async () => {
    const fixture = lifecycleFixture();
    const first = operation('3');
    const second = operation('4');
    expect(
      (await executeLifecycleBinding(fixture, first, async () => resultFor(first, 'failed')))
        .outcome,
    ).toBe('failed');
    await executeLifecycleBinding(fixture, second, async () => resultFor(second, 'succeeded'));

    expect(fixture.stagedExpected).toEqual([fixture.firstRevision, fixture.firstRevision]);
  });

  test('blocks later physical work after an indeterminate lifecycle receipt', async () => {
    const fixture = lifecycleFixture();
    const first = operation('5');
    const second = operation('6');
    await executeLifecycleBinding(fixture, first, async () => {
      fixture.failObservation();
      return resultFor(first, 'failed');
    });
    let laterCalls = 0;
    const later = await executeLifecycleBinding(fixture, second, async () => {
      laterCalls += 1;
      return resultFor(second, 'succeeded');
    });

    expect(later.outcome).toBe('failed');
    expect(later.error?.code).toBe('repository-lifecycle-failed');
    expect(laterCalls).toBe(0);
    expect(fixture.stagedExpected).toHaveLength(1);
  });
});
