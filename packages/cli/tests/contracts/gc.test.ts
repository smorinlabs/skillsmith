import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GC_SECRET_CANARIES,
  type GcCliProduct,
  type GcFleet,
  type GcStoreObject,
  createGcFleet,
  createStoreObject,
  destroyGcFleet,
  makeUnsafeHardLink,
  pathExists,
  pinnedPair,
  projectLedgerFields,
  readLedgerText,
  removeRetiredProject,
  runGcCli,
  setObjectModifiedAt,
  snapshotGcState,
  writeEmptyLedgerV1,
  writeLedgerDocument,
  writeLedgerV2,
} from '../../../../tests/ergonomics/fixtures/p5-gc/fleet.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../core/src/application/current-services.ts';
import type { ArtifactDigest } from '../../../core/src/artifacts/hash.ts';
import { validateJournalV1DtoShape } from '../../../core/src/artifacts/journal-codec.ts';
import type { LogicalJournalV1Dto } from '../../../core/src/artifacts/journal-types.ts';
import { validateLedgerV2Dto } from '../../../core/src/artifacts/ledger-codec.ts';
import { executeGcPlan } from '../../../core/src/gc/execute.ts';
import { inventoryGcStore } from '../../../core/src/gc/inventory.ts';
import { buildGcPlan } from '../../../core/src/gc/plan.ts';
import { classifyGcReachability } from '../../../core/src/gc/reachability.ts';
import { observeGcRecovery } from '../../../core/src/gc/recovery.ts';
import type { GcObjectObservation } from '../../../core/src/gc/types.ts';
import { emptyLedgerModel, readLedgerState } from '../../../core/src/place/ledger.ts';
import { defaultRuntimePorts } from '../../../core/src/ports/default.ts';
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';

setDefaultTimeout(90_000);

type UnknownRecord = Record<string, unknown>;

const openFleets: GcFleet[] = [];

afterEach(async () => {
  await Promise.all(openFleets.splice(0).map(destroyGcFleet));
});

const fleet = async (): Promise<GcFleet> => {
  const selected = await createGcFleet();
  openFleets.push(selected);
  return selected;
};

const requireGcBoundary = (): void => {
  expect(
    {
      commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith gc'),
      applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'gc'),
    },
    'public gc CommandSpec/application service boundary is absent',
  ).toEqual({ commandSpec: true, applicationService: true });
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const retainedJournal = (
  transactionId: string,
  object: GcStoreObject,
  retainUntil: string | null,
  phase: LogicalJournalV1Dto['phase'] = 'committed',
): LogicalJournalV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.transaction-journal',
  transactionId,
  intent: {
    operationId: `operation:${transactionId}`,
    groupId: `group:${transactionId}`,
    pairId: null,
    kind: 'migrate-ledger',
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 1,
      byteHash: `sha256:${'1'.repeat(64)}` as ArtifactDigest,
      semanticHash: `sha256:${'2'.repeat(64)}` as ArtifactDigest,
    },
    after: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 2,
      byteHash: `sha256:${'3'.repeat(64)}` as ArtifactDigest,
      semanticHash: `sha256:${'2'.repeat(64)}` as ArtifactDigest,
    },
    mutates: { live: false, manifest: false, lock: false, ledger: true },
    reversibility: {
      kind: 'conditional',
      retentionResourceIds: [`resource:${transactionId}`],
    },
    conflict: null,
  },
  context: {
    parentOperationId: null,
    command: 'skillsmith:gc-selector',
    workflow: 'gc-selector',
    attempt: 1,
    startedAt: '2026-07-23T00:00:00.000Z',
  },
  disposition: 'forward',
  phase,
  actual: {
    before: [
      {
        resourceId: `resource:${transactionId}:ledger`,
        role: 'ledger',
        state: 'present',
        repositoryRevision: {
          kind: 'artifact-bytes',
          digest: `sha256:${'1'.repeat(64)}` as ArtifactDigest,
        },
        schemaVersion: 1,
        semanticHash: `sha256:${'2'.repeat(64)}` as ArtifactDigest,
      },
    ],
    after:
      phase === 'prepared' || phase === 'staged' || phase === 'backed-up'
        ? []
        : [
            {
              resourceId: `resource:${transactionId}:ledger`,
              role: 'ledger',
              state: 'present',
              repositoryRevision: {
                kind: 'artifact-bytes',
                digest: `sha256:${'3'.repeat(64)}` as ArtifactDigest,
              },
              schemaVersion: 2,
              semanticHash: `sha256:${'2'.repeat(64)}` as ArtifactDigest,
            },
          ],
    retained: [
      {
        resourceId: `resource:${transactionId}`,
        role: 'store',
        path: object.path,
        repositoryRevision: {
          kind: 'resource',
          digest: object.contentHash as ArtifactDigest,
        },
        contentHash: object.contentHash as ArtifactDigest,
        retainUntil,
      },
    ],
  },
  updatedAt: '2026-07-23T00:00:00.000Z',
  completedAt: phase === 'committed' ? '2026-07-23T00:00:00.000Z' : null,
});

const retainedRollbackLineage = (
  object: GcStoreObject,
): readonly [LogicalJournalV1Dto, LogicalJournalV1Dto] => {
  const resource = {
    kind: 'live' as const,
    skill: 'lineage-retained',
    tool: 'codex' as const,
    scope: 'user' as const,
    projectRoot: null,
    location: { kind: 'machine-bound' as const, path: '/live/lineage-retained' },
  };
  const before = {
    resourceId: 'resource:lineage:live',
    role: 'live' as const,
    state: 'absent' as const,
    repositoryRevision: null,
    placementPath: '/live/lineage-retained',
    liveKind: null,
    mode: null,
    symlinkTarget: null,
    contentHash: null,
  };
  const after = {
    resourceId: 'resource:lineage:live',
    role: 'live' as const,
    state: 'present' as const,
    repositoryRevision: {
      kind: 'resource' as const,
      digest: object.contentHash as ArtifactDigest,
    },
    placementPath: '/live/lineage-retained',
    liveKind: 'directory' as const,
    mode: 'pinned' as const,
    symlinkTarget: null,
    contentHash: object.contentHash as ArtifactDigest,
  };
  const ledgerBefore = {
    resourceId: 'resource:lineage:ledger',
    role: 'ledger' as const,
    state: 'present' as const,
    repositoryRevision: {
      kind: 'artifact-bytes' as const,
      digest: `sha256:${'1'.repeat(64)}` as ArtifactDigest,
    },
    schemaVersion: 2 as const,
    semanticHash: `sha256:${'2'.repeat(64)}` as ArtifactDigest,
  };
  const ledgerAfter = {
    ...ledgerBefore,
    repositoryRevision: {
      kind: 'artifact-bytes' as const,
      digest: `sha256:${'3'.repeat(64)}` as ArtifactDigest,
    },
    semanticHash: `sha256:${'4'.repeat(64)}` as ArtifactDigest,
  };
  const retained = {
    resourceId: 'resource:lineage:store',
    role: 'store' as const,
    path: object.path,
    repositoryRevision: {
      kind: 'resource' as const,
      digest: object.contentHash as ArtifactDigest,
    },
    contentHash: object.contentHash as ArtifactDigest,
    retainUntil: null,
  };
  const intent: LogicalJournalV1Dto['intent'] = {
    operationId: 'operation:lineage-parent',
    groupId: 'group:lineage-parent',
    pairId: 'pair:lineage-retained:codex',
    kind: 'install',
    skill: 'lineage-retained',
    source: {
      kind: 'portable',
      identity: {
        host: 'github.com',
        repository: 'skillsmith/fixtures',
        path: 'lineage-retained',
      },
      requestedRef: null,
      resolvedSha: 'a'.repeat(40),
      sourcePath: 'lineage-retained',
      contentHash: object.contentHash as ArtifactDigest,
    },
    tool: 'codex',
    scope: 'user',
    before: { kind: 'absent', resource },
    after: {
      kind: 'placement',
      resource,
      classification: 'pinned',
      representation: 'copy',
      linkTarget: null,
      dangling: false,
      source: null,
      contentHash: object.contentHash as ArtifactDigest,
    },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    reversibility: {
      kind: 'conditional',
      retentionResourceIds: [retained.resourceId],
    },
    conflict: null,
  };
  const parent: LogicalJournalV1Dto = {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId: 'transaction:lineage-parent',
    intent,
    context: {
      parentOperationId: null,
      command: 'skillsmith:install',
      workflow: 'gc-selector-lineage',
      attempt: 1,
      startedAt: '2026-07-23T00:00:00.000Z',
    },
    disposition: 'forward',
    phase: 'committed',
    actual: {
      before: [ledgerBefore, before],
      after: [ledgerAfter, after],
      retained: [retained],
    },
    updatedAt: '2026-07-23T00:00:01.000Z',
    completedAt: '2026-07-23T00:00:01.000Z',
  };
  const child: LogicalJournalV1Dto = {
    ...parent,
    transactionId: 'transaction:lineage-child',
    intent: {
      ...intent,
      operationId: 'operation:lineage-child',
      groupId: 'group:lineage-child',
    },
    context: {
      ...parent.context,
      parentOperationId: intent.operationId,
      attempt: 2,
      startedAt: '2026-07-23T00:00:02.000Z',
    },
    disposition: 'rollback',
    actual: {
      before: [ledgerAfter, after],
      after: [ledgerBefore, before],
      retained: [retained],
    },
    updatedAt: '2026-07-23T00:00:03.000Z',
    completedAt: '2026-07-23T00:00:03.000Z',
  };
  return [parent, child];
};

const requireGcReport = (product: GcCliProduct, expectedExit = 0): UnknownRecord => {
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  const parsed: unknown = JSON.parse(product.stdout);
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.gc',
    command: 'gc',
    selectionSource: 'bounded-default',
  });
  if (!isRecord(parsed)) throw new Error('GC report was not an object');
  return parsed;
};

describe('gc command contract', () => {
  test('EWP-CMD-GC-TS01 — fixed store inventory, publisher grammar, and exact reachability', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const reachable = await createStoreObject(selected, {
      namespace: 'local',
      repository: 'my repo',
      revision: 'content-111111111111',
      skill: 'review',
    });
    const extraAt = await createStoreObject(selected, {
      namespace: 'local',
      repository: 'acme@tools',
      revision: '222222222222',
      skill: 'lint',
    });
    const liveDrift = await createStoreObject(selected, {
      namespace: 'local',
      repository: 'live drift',
      revision: '333333333334',
      skill: 'drift',
    });
    await mkdir(join(selected.store, '.staging', 'ignored'), { recursive: true });
    const placementPath = join(selected.projects.current, '.agents', 'skills', 'review');
    await mkdir(join(selected.projects.current, '.agents', 'skills'), { recursive: true });
    await symlink(liveDrift.path, placementPath);
    const pair = pinnedPair(placementPath, reachable);
    const fields = projectLedgerFields(
      selected.projects.current,
      'review',
      'codex',
      pair,
      reachable,
    );
    await writeLedgerV2(selected, fields);

    const report = requireGcReport(await runGcCli(selected, ['gc', '--dry-run', '--json']));
    expect(report).toMatchObject({ mode: 'dry-run', state: 'planned' });
    const objects = records(report.objects);
    expect(objects).toHaveLength(3);
    expect(objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: reachable.path,
          contentHash: reachable.contentHash,
          outcome: 'protected',
        }),
        expect.objectContaining({ path: extraAt.path, outcome: 'eligible' }),
        expect.objectContaining({
          path: liveDrift.path,
          outcome: 'protected',
          protection: expect.arrayContaining([expect.objectContaining({ kind: 'live-placement' })]),
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('.staging/ignored');
    expect(JSON.stringify(report)).not.toContain(GC_SECRET_CANARIES[0]);
  });

  test('EWP-CMD-GC-TS02 — registrations, missing projects, v1 migration, and portable non-leases', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const object = await createStoreObject(selected, { revision: '333333333333' });
    await writeEmptyLedgerV1(selected);
    const v1Bytes = await readLedgerText(selected);
    const before = await snapshotGcState(selected);

    const preview = requireGcReport(
      await runGcCli(selected, ['gc', '--dry-run', '--older-than', '1s', '--json']),
    );
    expect(preview).toMatchObject({ migration: { sourceVersion: 1, action: 'migrate-ledger' } });
    expect(await readLedgerText(selected)).toBe(v1Bytes);
    expect(await snapshotGcState(selected)).toEqual(before);

    const result = requireGcReport(
      await runGcCli(selected, ['gc', '--older-than', '1s', '--yes', '--json']),
    );
    expect(result).toMatchObject({ mode: 'execute', state: 'completed' });
    expect(JSON.parse(await readLedgerText(selected))).toMatchObject({ schemaVersion: 2 });
    expect(await pathExists(object.path)).toBeFalse();

    await writeLedgerDocument(selected, { schemaVersion: 99, kind: 'skillsmith.placements' });
    expect((await runGcCli(selected, ['gc', '--dry-run', '--json'])).exitCode).toBe(3);
  });

  test('EWP-CMD-GC-TS03 — journal, history, undo-window, and lineage retention', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const protectedObject = await createStoreObject(selected, {
      revision: '444444444444',
      skill: 'policy',
    });
    const logicalObject = await createStoreObject(selected, {
      revision: '444444444445',
      skill: 'logical-retained',
    });
    const historyObject = await createStoreObject(selected, {
      revision: '444444444446',
      skill: 'history-retained',
    });
    const lineageObject = await createStoreObject(selected, {
      revision: '444444444447',
      skill: 'lineage-retained',
    });
    const placementPath = join(selected.projects.current, '.claude', 'skills', 'policy');
    const pair = {
      ...pinnedPair(placementPath, protectedObject),
      journal: {
        op: 'install',
        txId: 'legacy:policy',
        phase: 'live',
        startedAt: '2026-07-23T00:00:00.000Z',
        completedAt: null,
        before: {
          mode: 'pinned',
          storePath: protectedObject.path,
          contentHash: protectedObject.contentHash,
        },
        stagingPath: join(selected.cwd, '.legacy-staging-policy'),
        backupPath: join(selected.cwd, '.legacy-backup-policy'),
      },
    };
    const logical = retainedJournal('logical-retained', logicalObject, null, 'live');
    const historical = retainedJournal(
      'history-retained',
      historyObject,
      '2099-01-01T00:00:00.000Z',
    );
    const lineage = retainedRollbackLineage(lineageObject);
    for (const journal of lineage) {
      const validated = validateJournalV1DtoShape(journal);
      if (!validated.ok) {
        throw new Error(`${journal.transactionId}: ${JSON.stringify(validated.error)}`);
      }
    }
    await writeLedgerV2(selected, {
      skills: { policy: { tools: { 'claude-code': pair } } },
      transactions: { [logical.transactionId]: logical },
      history: [historical, ...lineage],
    });
    const plantedLedger = validateLedgerV2Dto(JSON.parse(await readLedgerText(selected)));
    if (!plantedLedger.ok) throw new Error(JSON.stringify(plantedLedger.error));

    const report = requireGcReport(
      await runGcCli(selected, ['gc', '--dry-run', '--older-than', '1s', '--json']),
    );
    expect(records(report.objects)).toContainEqual(
      expect.objectContaining({
        path: protectedObject.path,
        outcome: 'protected',
        protection: expect.arrayContaining([
          expect.objectContaining({ kind: 'ledger' }),
          expect.objectContaining({ kind: 'legacy-journal' }),
        ]),
      }),
    );
    expect(records(report.objects)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: logicalObject.path,
          outcome: 'protected',
          protection: expect.arrayContaining([
            expect.objectContaining({ kind: 'logical-transaction' }),
          ]),
        }),
        expect.objectContaining({
          path: historyObject.path,
          outcome: 'protected',
          protection: expect.arrayContaining([expect.objectContaining({ kind: 'history' })]),
        }),
        expect.objectContaining({
          path: lineageObject.path,
          outcome: 'protected',
          protection: expect.arrayContaining([expect.objectContaining({ kind: 'history' })]),
        }),
      ]),
    );
    expect(report.summary).toMatchObject({ eligibleItems: 0, eligibleBytes: 0 });
  });

  test('EWP-CMD-GC-TS04 — duration grammar and strict age cutoff boundaries', async () => {
    requireGcBoundary();
    const selected = await fleet();
    await writeLedgerV2(selected);
    const old = await createStoreObject(selected, {
      revision: '555555555555',
      skill: 'old',
      modifiedAt: new Date(Date.now() - 120_000),
    });
    const recent = await createStoreObject(selected, {
      revision: '666666666666',
      skill: 'recent',
    });
    await setObjectModifiedAt(recent, new Date());

    for (const duration of ['0s', '-1s', '+1s', '1.5h', ' 1h', '1', '1H', '999999999999999999w']) {
      const product = await runGcCli(selected, ['gc', '--older-than', duration, '--dry-run']);
      expect(product.exitCode, duration).toBe(2);
    }
    const report = requireGcReport(
      await runGcCli(selected, ['gc', '--older-than', '1m', '--dry-run', '--json']),
    );
    expect(report).toMatchObject({ olderThan: { input: '1m', milliseconds: 60_000 } });
    expect(records(report.objects)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: old.path, outcome: 'eligible' }),
        expect.objectContaining({ path: recent.path, outcome: 'age-filtered' }),
      ]),
    );
    const ports = await defaultRuntimePorts();
    const inventory = await inventoryGcStore(ports, selected.store);
    if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
      throw new Error('age boundary inventory failed');
    }
    const template = inventory.objects[0];
    const nowMilliseconds = Date.parse('2026-07-23T01:00:00.000Z');
    const cutoff = nowMilliseconds - 60_000;
    const ageObjects: readonly GcObjectObservation[] = [
      { ...template, id: '1'.repeat(64), path: '/synthetic/equality', modifiedAt: cutoff },
      { ...template, id: '2'.repeat(64), path: '/synthetic/minus-one', modifiedAt: cutoff - 1 },
      { ...template, id: '3'.repeat(64), path: '/synthetic/plus-one', modifiedAt: cutoff + 1 },
    ];
    const exact = classifyGcReachability({
      model: emptyLedgerModel('2026-07-23T00:00:00.000Z'),
      objects: ageObjects,
      nowMilliseconds,
      olderThanMilliseconds: 60_000,
    });
    expect(exact.state).toBe('ok');
    if (exact.state !== 'ok') throw new Error(exact.reason);
    expect(exact.classifications.map(({ object, outcome }) => [object.path, outcome])).toEqual([
      ['/synthetic/equality', 'age-filtered'],
      ['/synthetic/minus-one', 'eligible'],
      ['/synthetic/plus-one', 'age-filtered'],
    ]);
  });

  test('EWP-CMD-GC-TS05 — logical bytes and whole-invocation unsafe measurement refusal', async () => {
    requireGcBoundary();
    const selected = await fleet();
    await writeLedgerV2(selected);
    const safe = await createStoreObject(selected, {
      revision: '777777777777',
      files: { 'nested/payload.txt': 'abc' },
      symlinks: { alias: 'nested/payload.txt' },
    });
    const preview = requireGcReport(await runGcCli(selected, ['gc', '--dry-run', '--json']));
    expect(records(preview.objects)).toContainEqual(
      expect.objectContaining({ path: safe.path, logicalBytes: safe.logicalBytes }),
    );
    expect(preview.summary).toMatchObject({ eligibleBytes: safe.logicalBytes });

    const ports = await defaultRuntimePorts();
    const observed = await inventoryGcStore(ports, selected.store);
    if (observed.state !== 'ok' || observed.objects[0] === undefined) {
      throw new Error('measurement fixture inventory failed');
    }
    let modifiedReads = 0;
    const unstablePorts = Object.assign(Object.create(ports) as typeof ports, {
      modifiedAt: async (path: string) => {
        const value = await ports.modifiedAt(path);
        if (path !== safe.path) return value;
        modifiedReads += 1;
        return modifiedReads === 1 || value === null ? value : value + 1;
      },
    });
    expect(await inventoryGcStore(unstablePorts, selected.store)).toMatchObject({
      state: 'refused',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unstable-observation' })]),
    });

    const overlayTemplate = observed.objects[0];
    const retainedOverlay: GcObjectObservation = {
      ...overlayTemplate,
      id: '4'.repeat(64),
      kind: 'adapted-overlay',
      path: '/adapter/retained-overlay',
    };
    const disposableOverlay: GcObjectObservation = {
      ...overlayTemplate,
      id: '5'.repeat(64),
      kind: 'adapted-overlay',
      path: '/adapter/disposable-overlay',
    };
    const overlays = classifyGcReachability({
      model: emptyLedgerModel('2026-07-23T00:00:00.000Z'),
      objects: [retainedOverlay, disposableOverlay],
      liveTargets: [
        {
          sourceId: 'adapter:retained',
          path: retainedOverlay.path,
          contentHash: retainedOverlay.contentHash,
        },
      ],
      nowMilliseconds: Date.parse('2026-07-23T01:00:00.000Z'),
      olderThanMilliseconds: null,
    });
    expect(overlays.state).toBe('ok');
    if (overlays.state !== 'ok') throw new Error(overlays.reason);
    expect(overlays.classifications.map(({ object, outcome }) => [object.path, outcome])).toEqual([
      ['/adapter/disposable-overlay', 'eligible'],
      ['/adapter/retained-overlay', 'protected'],
    ]);

    await makeUnsafeHardLink(safe);
    const before = await snapshotGcState(selected);
    const refused = requireGcReport(await runGcCli(selected, ['gc', '--yes', '--json']), 3);
    expect(refused).toMatchObject({ state: 'refused' });
    expect(records(refused.actions)).toHaveLength(0);
    expect(refused.summary).toMatchObject({ eligibleItems: null, eligibleBytes: null });
    expect(await snapshotGcState(selected)).toEqual(before);
  });

  test('EWP-CMD-GC-TS06 — exact approval, dry-run identity, filter-zero, and recovery retry', async () => {
    requireGcBoundary();
    const selected = await fleet();
    await writeLedgerV2(selected);
    const object = await createStoreObject(selected, { revision: '888888888888' });
    expect((await runGcCli(selected, ['gc', '--dry-run', '--yes'])).exitCode).toBe(2);
    expect((await runGcCli(selected, ['gc', '--json'])).exitCode).toBe(2);

    const before = await snapshotGcState(selected);
    const preview = requireGcReport(await runGcCli(selected, ['gc', '--dry-run', '--json']));
    expect(await snapshotGcState(selected)).toEqual(before);
    expect(await pathExists(selected.recovery)).toBeFalse();

    const execution = requireGcReport(await runGcCli(selected, ['gc', '--yes', '--json']));
    expect(execution.planId).toBe(preview.planId);
    expect(execution.actions).toEqual(preview.actions);
    expect(await pathExists(object.path)).toBeFalse();
    expect(await pathExists(selected.recovery)).toBeTrue();

    const noOp = requireGcReport(await runGcCli(selected, ['gc', '--json']));
    expect(noOp).toMatchObject({ state: 'no-op', summary: { eligibleItems: 0 } });

    const retryObject = await createStoreObject(selected, {
      revision: '898989898988',
      skill: 'retry',
    });
    const ports = await defaultRuntimePorts();
    const inventory = await inventoryGcStore(ports, selected.store);
    const ledger = await readLedgerState(ports, selected.ledger);
    if (
      inventory.state !== 'ok' ||
      inventory.objects[0] === undefined ||
      !ledger.ok ||
      ledger.value.state !== 'present'
    ) {
      throw new Error('recovery fixture observation failed');
    }
    const retryPlan = buildGcPlan({
      sourceLedger: ledger.value,
      model: ledger.value.model,
      postForgetModel: ledger.value.model,
      inventory,
      classifications: inventory.objects.map((candidate) => ({
        object: candidate,
        protection: [],
        ageEligible: true,
        outcome: 'eligible' as const,
      })),
      duration: null,
      nowMilliseconds: Date.now(),
      projects: [],
      dataDir: selected.data,
      storeRoot: selected.store,
      ledgerPath: selected.ledger,
      project: {
        effectiveCwd: selected.cwd,
        root: selected.cwd,
        identity: selected.cwd,
      },
      retryArguments: ['gc', '--yes'],
      normalizedForgetRoots: [],
    });
    let interruptedDetach = false;
    const crashPorts = Object.assign(Object.create(ports) as typeof ports, {
      rename: async (from: string, to: string) => {
        await ports.rename(from, to);
        if (!interruptedDetach && to.endsWith('/payload')) {
          interruptedDetach = true;
          throw new Error('simulated process loss after detach');
        }
      },
    });
    expect((await executeGcPlan(crashPorts, retryPlan)).ok).toBeFalse();
    const retryState = await snapshotGcState(selected);
    const mismatch = await runGcCli(selected, ['gc', '--older-than', '1s', '--yes', '--json']);
    expect(mismatch.exitCode).toBe(3);
    expect(await snapshotGcState(selected)).toEqual(retryState);
    const pendingPreview = requireGcReport(await runGcCli(selected, ['gc', '--dry-run', '--json']));
    expect(pendingPreview).toMatchObject({
      mode: 'dry-run',
      state: 'partial',
      planId: retryPlan.planId,
      recovery: { state: 'pending' },
    });
    expect(await snapshotGcState(selected)).toEqual(retryState);
    const resumed = requireGcReport(await runGcCli(selected, ['gc', '--yes', '--json']));
    expect(resumed).toMatchObject({ state: 'completed', planId: retryPlan.planId });
    expect(await pathExists(retryObject.path)).toBeFalse();

    const interrupted = await createStoreObject(selected, {
      revision: '898989898989',
      skill: 'interrupted',
    });
    const recoveryParent = join(selected.data, '.gc-recovery');
    await mkdir(selected.recovery, { recursive: true, mode: 0o700 });
    await chmod(recoveryParent, 0o700);
    await chmod(selected.recovery, 0o700);
    const staging = join(
      selected.recovery,
      `.${'a'.repeat(64)}.create-${'b'.repeat(64)}-${'c'.repeat(16)}.tmp`,
    );
    await writeFile(staging, '', { mode: 0o600 });
    const stagingBefore = await snapshotGcState(selected);
    const pending = requireGcReport(await runGcCli(selected, ['gc', '--dry-run', '--json']), 3);
    expect(pending).toMatchObject({
      mode: 'dry-run',
      state: 'partial',
      recovery: { state: 'pending', phase: 'initial-staging' },
    });
    expect(await snapshotGcState(selected)).toEqual(stagingBefore);
    const converged = requireGcReport(await runGcCli(selected, ['gc', '--yes', '--json']));
    expect(converged).toMatchObject({ state: 'completed' });
    expect(await pathExists(staging)).toBeFalse();
    expect(await pathExists(interrupted.path)).toBeFalse();
  });

  test('EWP-CMD-GC-TS07 — exact missing-project forget and derived ledger mutation', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const object = await createStoreObject(selected, {
      revision: '999999999999',
      skill: 'retired',
    });
    const placementPath = join(selected.projects.retired, '.agents', 'skills', 'retired');
    const pair = pinnedPair(placementPath, object);
    const fields = projectLedgerFields(selected.projects.retired, 'retired', 'codex', pair, object);
    await writeLedgerV2(selected, fields);
    expect(
      (await runGcCli(selected, ['gc', '--forget-project', selected.projects.retired, '--yes']))
        .exitCode,
    ).toBe(2);
    expect(
      (await runGcCli(selected, ['gc', '--forget-project', selected.projects.missing, '--yes']))
        .exitCode,
    ).toBe(2);
    await symlink(selected.projects.retired, selected.projects.missing);
    expect(
      (await runGcCli(selected, ['gc', '--forget-project', selected.projects.missing, '--yes']))
        .exitCode,
    ).toBe(2);
    await rm(selected.projects.missing);
    await removeRetiredProject(selected);
    await Promise.all([
      writeFile(join(selected.cwd, 'skillsmith.toml'), 'version = 1\n'),
      writeFile(join(selected.cwd, 'skillsmith.lock'), '{"version":1}\n'),
    ]);
    const portableBefore = await Promise.all([
      readFile(join(selected.cwd, 'skillsmith.toml'), 'utf8'),
      readFile(join(selected.cwd, 'skillsmith.lock'), 'utf8'),
    ]);

    const report = requireGcReport(
      await runGcCli(selected, [
        'gc',
        '--forget-project',
        selected.projects.retired,
        '--forget-project',
        selected.projects.retired,
        '--yes',
        '--json',
      ]),
    );
    expect(records(report.projects)).toHaveLength(1);
    expect(records(report.projects)[0]).toMatchObject({
      root: selected.projects.retired,
      action: 'forget-project',
      outcome: 'forgotten',
    });
    const ledger = JSON.parse(await readLedgerText(selected)) as UnknownRecord;
    expect(ledger.projects).not.toHaveProperty(selected.projects.retired);
    expect(ledger.projectRegistrations).not.toHaveProperty(selected.projects.retired);
    expect(await pathExists(object.path)).toBeFalse();
    expect(
      await Promise.all([
        readFile(join(selected.cwd, 'skillsmith.toml'), 'utf8'),
        readFile(join(selected.cwd, 'skillsmith.lock'), 'utf8'),
      ]),
    ).toEqual(portableBefore);

    expect(
      (await runGcCli(selected, ['gc', '--forget-project', selected.projects.current, '--yes']))
        .exitCode,
    ).toBe(2);
  });

  test('EWP-CMD-GC-TS08 — owner-bound tombstones, crash convergence, and zero reachable deletion', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const reachable = await createStoreObject(selected, {
      revision: 'aaaaaaaaaaaa',
      skill: 'reachable',
    });
    const reclaimable = await createStoreObject(selected, {
      revision: 'bbbbbbbbbbbb',
      skill: 'reclaimable',
    });
    const pair = pinnedPair(
      join(selected.projects.current, '.agents', 'skills', 'reachable'),
      reachable,
    );
    await writeLedgerV2(selected, { skills: { reachable: { tools: { codex: pair } } } });

    const result = requireGcReport(await runGcCli(selected, ['gc', '--yes', '--json']));
    expect(result).toMatchObject({ state: 'completed' });
    expect(await pathExists(reachable.path)).toBeTrue();
    expect(await pathExists(reclaimable.path)).toBeFalse();

    const interruptedObject = await createStoreObject(selected, {
      revision: 'bbbbbbbbbbbc',
      skill: 'finalize-interrupted',
    });
    const ports = await defaultRuntimePorts();
    const inventory = await inventoryGcStore(ports, selected.store);
    const ledger = await readLedgerState(ports, selected.ledger);
    if (inventory.state !== 'ok' || !ledger.ok || ledger.value.state !== 'present') {
      throw new Error('finalize recovery fixture observation failed');
    }
    const interruptedPlan = buildGcPlan({
      sourceLedger: ledger.value,
      model: ledger.value.model,
      postForgetModel: ledger.value.model,
      inventory,
      classifications: inventory.objects.map((object) => ({
        object,
        protection:
          object.path === interruptedObject.path
            ? []
            : [
                {
                  kind: 'ledger' as const,
                  sourceId: 'selector:reachable',
                  path: object.path,
                  contentHash: object.contentHash,
                },
              ],
        ageEligible: true,
        outcome:
          object.path === interruptedObject.path ? ('eligible' as const) : ('protected' as const),
      })),
      duration: null,
      nowMilliseconds: Date.now(),
      projects: [],
      dataDir: selected.data,
      storeRoot: selected.store,
      ledgerPath: selected.ledger,
      project: { effectiveCwd: selected.cwd, root: selected.cwd, identity: selected.cwd },
      retryArguments: ['gc', '--yes'],
      normalizedForgetRoots: [],
    });
    const reclaim = interruptedPlan.actions.find((action) => action.kind === 'reclaim-store');
    if (reclaim?.kind !== 'reclaim-store') throw new Error('interrupted action missing');
    const actionContainer = join(
      selected.store,
      '.gc-tombstones',
      'v1',
      interruptedPlan.planId,
      reclaim.actionId,
    );
    let interruptedFinalize = false;
    const crashPorts = Object.assign(Object.create(ports) as typeof ports, {
      removeEmptyDirectory: async (path: string) => {
        if (!interruptedFinalize && path === actionContainer) {
          interruptedFinalize = true;
          throw Object.assign(new Error('simulated permission failure'), { code: 'EACCES' });
        }
        await ports.removeEmptyDirectory?.(path);
      },
    });
    expect(await executeGcPlan(crashPorts, interruptedPlan)).toMatchObject({
      ok: false,
      report: {
        state: 'partial',
        recovery: { state: 'pending', phase: 'reclaiming' },
        summary: { reclaimedItems: 1 },
      },
    });
    expect(await pathExists(interruptedObject.path)).toBeFalse();
    expect(await ports.listDir(actionContainer)).toEqual([]);

    const pendingRecovery = await observeGcRecovery(ports, selected.data);
    if (pendingRecovery.state !== 'pending') throw new Error('pending recovery fixture missing');
    const recoveryRoot = join(selected.data, '.gc-recovery', 'v1');
    const liveSource = await readFile(pendingRecovery.path, 'utf8');
    const expectPhysicalRefusal = async (): Promise<void> => {
      expect((await runGcCli(selected, ['gc', '--yes', '--json'])).exitCode).toBe(3);
      expect(await pathExists(interruptedObject.path)).toBeFalse();
      expect(await pathExists(reachable.path)).toBeTrue();
    };

    const competingLive = join(recoveryRoot, `${'f'.repeat(64)}.json`);
    await writeFile(competingLive, liveSource, { mode: 0o600 });
    await expectPhysicalRefusal();
    await rm(competingLive);

    await chmod(pendingRecovery.path, 0o644);
    await expectPhysicalRefusal();
    await chmod(pendingRecovery.path, 0o600);

    const malformedCas = join(
      recoveryRoot,
      `.${interruptedPlan.planId}.cas-${pendingRecovery.record.revision}-${'e'.repeat(64)}-${'1'.repeat(16)}.tmp`,
    );
    await writeFile(malformedCas, '{}\n', { mode: 0o600 });
    await expectPhysicalRefusal();
    await rm(malformedCas);

    const competingInitial = join(
      recoveryRoot,
      `.${interruptedPlan.planId}.create-${pendingRecovery.record.revision}-${'2'.repeat(16)}.tmp`,
    );
    await writeFile(competingInitial, liveSource, { mode: 0o600 });
    await expectPhysicalRefusal();
    await rm(competingInitial);

    await chmod(actionContainer, 0o755);
    await expectPhysicalRefusal();
    await chmod(actionContainer, 0o700);

    await writeFile(join(actionContainer, 'owner.json'), '{}\n', { mode: 0o600 });
    await expectPhysicalRefusal();
    await rm(join(actionContainer, 'owner.json'));

    const unsupportedTombstoneVersion = join(selected.store, '.gc-tombstones', 'v2');
    await mkdir(unsupportedTombstoneVersion, { mode: 0o700 });
    await expectPhysicalRefusal();
    await rm(unsupportedTombstoneVersion, { recursive: true });

    const resumed = requireGcReport(await runGcCli(selected, ['gc', '--yes', '--json']));
    expect(resumed).toMatchObject({
      state: 'completed',
      planId: interruptedPlan.planId,
      summary: { reclaimedItems: 1 },
    });
    expect(await pathExists(reachable.path)).toBeTrue();

    const planted = join(selected.store, '.gc-tombstones', 'v1', 'planted');
    await mkdir(planted, { recursive: true });
    await writeFile(join(planted, 'owner.json'), '{}\n');
    const before = await snapshotGcState(selected);
    expect((await runGcCli(selected, ['gc', '--yes', '--json'])).exitCode).toBe(3);
    expect(await snapshotGcState(selected)).toEqual(before);
    await rm(join(selected.store, '.gc-tombstones'), { recursive: true, force: true });
  });
});
