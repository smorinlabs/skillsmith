import { join } from 'node:path';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import { ledgerSemanticRevision, logicalJournalPairIdentity } from '../artifacts/registry.ts';
import type { GcReportV1Dto } from '../contracts/v1/gc.ts';
import { emptyLedgerModel, readLedgerState, withLedgerLock, writeLedger } from '../place/ledger.ts';
import type {
  ClockPort,
  EffectiveUserPort,
  ExclusiveCreatePort,
  FileMetadataReadPort,
  FileModeWritePort,
  FileReadPort,
  FileWritePort,
  IdPort,
  LockPort,
} from '../ports/types.ts';
import { inventoryGcStore } from './inventory.ts';
import { withoutLedgerProjectAt } from './plan.ts';
import { classifyGcReachability, observeGcLiveTargets } from './reachability.ts';
import {
  convergeGcRecovery,
  createGcRecoveryRecord,
  gcRecoveryRevision,
  observeGcRecovery,
  removeGcRecoveryRecord,
  removeIncompleteGcRecovery,
  replaceGcRecoveryRecord,
} from './recovery.ts';
import { finalizeGcStoreReclaim, reclaimGcStoreObject } from './repository.ts';
import type {
  GcRecoveryActionV1,
  GcRecoveryLedgerSourceV1,
  GcRecoveryObservation,
  GcRecoveryRecordV1,
  PreparedGcPlan,
} from './types.ts';

type ExecutePorts = EffectiveUserPort &
  ExclusiveCreatePort &
  FileMetadataReadPort &
  FileModeWritePort &
  FileReadPort &
  FileWritePort &
  ClockPort &
  IdPort &
  LockPort;

export type GcExecutionResult =
  | Readonly<{ readonly ok: true; readonly report: GcReportV1Dto }>
  | Readonly<{ readonly ok: false; readonly report: GcReportV1Dto; readonly reason: string }>;

const recordWithRevision = (value: Omit<GcRecoveryRecordV1, 'revision'>): GcRecoveryRecordV1 =>
  Object.freeze({ ...value, revision: gcRecoveryRevision(value) });

const withoutRevision = (value: GcRecoveryRecordV1): Omit<GcRecoveryRecordV1, 'revision'> => {
  const { revision: _revision, ...seed } = value;
  return seed;
};

const semanticRevision = (model: LedgerModel): ArtifactDigest => {
  const result = ledgerSemanticRevision(model);
  if (!result.ok) throw new TypeError('GC ledger semantic revision invariant failed');
  return result.value;
};

const atUpdatedTime = (model: LedgerModel, updatedAt: string): LedgerModel =>
  Object.freeze({ ...model, updatedAt });

const sourceLedgerRecord = (state: LedgerReadState): GcRecoveryLedgerSourceV1 =>
  state.state === 'absent'
    ? Object.freeze({
        state: 'absent',
        sourceVersion: null,
        byteRevision: null,
        semanticRevision: null,
      })
    : Object.freeze({
        state: 'present',
        sourceVersion: state.sourceVersion,
        byteRevision: state.byteRevision,
        semanticRevision: state.semanticRevision,
      });

const recoveryActions = (plan: PreparedGcPlan): readonly GcRecoveryActionV1[] =>
  plan.actions
    .filter((action) => action.kind === 'reclaim-store')
    .map((action) => {
      const containerPath = join(
        plan.storeRoot,
        '.gc-tombstones',
        'v1',
        plan.planId,
        action.actionId,
      );
      return Object.freeze({
        actionId: action.actionId,
        kind: 'reclaim-store' as const,
        path: action.object.path,
        contentHash: action.object.contentHash,
        modifiedAt: action.object.modifiedAt,
        logicalBytes: action.object.logicalBytes,
        object: action.object,
        ownershipToken: action.ownershipToken,
        containerPath,
        payloadPath: join(containerPath, 'payload'),
        containerIdentity: null,
        payloadIdentity: null,
        outcome: 'pending' as const,
      });
    });

const failureReport = (report: GcReportV1Dto, reason: string): GcReportV1Dto => ({
  ...report,
  mode: 'execute',
  state: 'partial',
  approval: { required: true, outcome: 'approved' },
  recovery: { state: 'pending', phase: report.recovery.phase },
  diagnostics: [{ code: 'gc-execution', message: reason, path: null }],
  summary: { ...report.summary, failedItems: 1 },
});

const fail = (record: GcRecoveryRecordV1, reason: string): GcExecutionResult =>
  Object.freeze({
    ok: false,
    reason,
    report: failureReport(
      { ...record.approvedReport, recovery: { state: 'pending', phase: record.phase } },
      reason,
    ),
  });

const sameSource = (expected: GcRecoveryLedgerSourceV1, actual: LedgerReadState): boolean =>
  expected.state === actual.state &&
  (expected.state === 'absent' ||
    (actual.state === 'present' &&
      expected.sourceVersion === actual.sourceVersion &&
      expected.byteRevision === actual.byteRevision &&
      expected.semanticRevision === actual.semanticRevision));

const hasSemantic = (state: LedgerReadState, expected: ArtifactDigest | null): boolean =>
  state.state === 'present' && expected !== null && state.semanticRevision === expected;

const replace = async (
  ports: ExecutePorts,
  recovery: Extract<GcRecoveryObservation, { readonly state: 'pending' }>,
  patch: Partial<Omit<GcRecoveryRecordV1, 'revision'>>,
): Promise<Extract<GcRecoveryObservation, { readonly state: 'pending' }> | null> => {
  const next = recordWithRevision({ ...withoutRevision(recovery.record), ...patch });
  const result = await replaceGcRecoveryRecord(ports, recovery, next);
  return result.state === 'pending' ? result : null;
};

const writeExactLedger = async (
  ports: ExecutePorts,
  ledgerPath: string,
  model: LedgerModel,
  updatedAt: string,
  expected: ArtifactDigest,
): Promise<boolean> => {
  const exact = atUpdatedTime(model, updatedAt);
  if (semanticRevision(exact) !== expected) return false;
  const written = await writeLedger(
    Object.assign(Object.create(ports), { wallNowIso: () => updatedAt }),
    ledgerPath,
    exact,
  );
  if (!written.ok) return false;
  const reread = await readLedgerState(ports, ledgerPath);
  return reread.ok && hasSemantic(reread.value, expected);
};

const forgetPreconditionsHold = async (
  ports: ExecutePorts,
  model: LedgerModel,
  record: GcRecoveryRecordV1,
): Promise<boolean> => {
  for (const root of record.normalizedForgetRoots) {
    if (
      root === record.approvedReport.project.root ||
      (await ports.pathKind(root)) !== 'absent' ||
      !Object.hasOwn(model.projects, root) ||
      !Object.hasOwn(model.projectRegistrations, root)
    ) {
      return false;
    }
    const pendingLegacy = Object.values(model.projects[root]?.skills ?? {}).some(({ tools }) =>
      Object.values(tools).some(({ journal }) => journal != null),
    );
    const pendingLogical = Object.values(model.transactions).some(
      (journal) => logicalJournalPairIdentity(journal)?.projectRoot === root,
    );
    if (pendingLegacy || pendingLogical) return false;
  }
  return true;
};

const commitLedgerBoundaries = async (
  ports: ExecutePorts,
  ledgerPath: string,
  recoveryInput: Extract<GcRecoveryObservation, { readonly state: 'pending' }>,
): Promise<
  | Readonly<{
      readonly ok: true;
      readonly recovery: Extract<GcRecoveryObservation, { readonly state: 'pending' }>;
      readonly model: LedgerModel;
    }>
  | Readonly<{ readonly ok: false; readonly result: GcExecutionResult }>
> => {
  let recovery = recoveryInput;
  let current = await readLedgerState(ports, ledgerPath);
  if (!current.ok) return { ok: false, result: fail(recovery.record, 'GC ledger is unreadable') };

  if (recovery.record.phase === 'approved') {
    const expected = recovery.record.expectedMigrationSemanticRevision;
    if (expected !== null && hasSemantic(current.value, expected)) {
      const advanced = await replace(ports, recovery, { phase: 'migration-complete' });
      if (advanced === null)
        return { ok: false, result: fail(recovery.record, 'GC migration recovery CAS failed') };
      recovery = advanced;
    } else if (expected !== null && sameSource(recovery.record.sourceLedger, current.value)) {
      if (
        current.value.state !== 'present' ||
        recovery.record.migrationUpdatedAt === null ||
        !(await writeExactLedger(
          ports,
          ledgerPath,
          current.value.model,
          recovery.record.migrationUpdatedAt,
          expected,
        ))
      ) {
        return { ok: false, result: fail(recovery.record, 'GC ledger migration failed') };
      }
      const advanced = await replace(ports, recovery, { phase: 'migration-complete' });
      if (advanced === null)
        return { ok: false, result: fail(recovery.record, 'GC migration recovery CAS failed') };
      recovery = advanced;
      current = await readLedgerState(ports, ledgerPath);
      if (!current.ok)
        return { ok: false, result: fail(recovery.record, 'GC migrated ledger is unreadable') };
    } else if (expected === null && sameSource(recovery.record.sourceLedger, current.value)) {
      const advanced = await replace(ports, recovery, { phase: 'migration-complete' });
      if (advanced === null)
        return { ok: false, result: fail(recovery.record, 'GC migration skip CAS failed') };
      recovery = advanced;
    } else if (hasSemantic(current.value, recovery.record.expectedPostForgetSemanticRevision)) {
      const advanced = await replace(ports, recovery, { phase: 'forget-complete' });
      if (advanced === null)
        return { ok: false, result: fail(recovery.record, 'GC committed ledger adoption failed') };
      recovery = advanced;
    } else {
      return { ok: false, result: fail(recovery.record, 'GC ledger drifted before migration') };
    }
  }

  if (recovery.record.phase === 'migration-complete') {
    current = await readLedgerState(ports, ledgerPath);
    if (!current.ok) return { ok: false, result: fail(recovery.record, 'GC ledger is unreadable') };
    const expected = recovery.record.expectedPostForgetSemanticRevision;
    if (hasSemantic(current.value, expected)) {
      const advanced = await replace(ports, recovery, { phase: 'forget-complete' });
      if (advanced === null)
        return { ok: false, result: fail(recovery.record, 'GC forget adoption CAS failed') };
      recovery = advanced;
    } else if (recovery.record.normalizedForgetRoots.length === 0) {
      const unchanged =
        recovery.record.expectedMigrationSemanticRevision === null
          ? sameSource(recovery.record.sourceLedger, current.value)
          : hasSemantic(current.value, recovery.record.expectedMigrationSemanticRevision);
      if (!unchanged)
        return { ok: false, result: fail(recovery.record, 'GC ledger drifted before reclaim') };
      const advanced = await replace(ports, recovery, { phase: 'forget-complete' });
      if (advanced === null)
        return { ok: false, result: fail(recovery.record, 'GC forget skip CAS failed') };
      recovery = advanced;
    } else {
      if (
        current.value.state !== 'present' ||
        recovery.record.forgetUpdatedAt === null ||
        expected === null ||
        !(await forgetPreconditionsHold(ports, current.value.model, recovery.record))
      ) {
        return { ok: false, result: fail(recovery.record, 'GC forget source is unavailable') };
      }
      const forgotten = withoutLedgerProjectAt(
        current.value.model,
        recovery.record.normalizedForgetRoots,
      );
      if (
        !forgotten.ok ||
        !(await writeExactLedger(
          ports,
          ledgerPath,
          forgotten.value,
          recovery.record.forgetUpdatedAt,
          expected,
        ))
      ) {
        return { ok: false, result: fail(recovery.record, 'GC ledger forget commit failed') };
      }
      const advanced = await replace(ports, recovery, { phase: 'forget-complete' });
      if (advanced === null)
        return { ok: false, result: fail(recovery.record, 'GC forget recovery CAS failed') };
      recovery = advanced;
    }
  }

  current = await readLedgerState(ports, ledgerPath);
  if (!current.ok) return { ok: false, result: fail(recovery.record, 'GC ledger is unreadable') };
  const expected = recovery.record.expectedPostForgetSemanticRevision;
  const unchangedAbsent =
    expected === null &&
    recovery.record.sourceLedger.state === 'absent' &&
    current.value.state === 'absent';
  if (!unchangedAbsent && !hasSemantic(current.value, expected)) {
    return {
      ok: false,
      result: fail(recovery.record, 'GC committed ledger semantic digest drifted'),
    };
  }
  return {
    ok: true,
    recovery,
    model:
      current.value.state === 'present'
        ? current.value.model
        : emptyLedgerModel(new Date(recovery.record.nowMilliseconds).toISOString()),
  };
};

const actionRequest = (storeRoot: string, planId: string, action: GcRecoveryActionV1) => ({
  storeRoot,
  planId,
  actionId: action.actionId,
  ownershipToken: action.ownershipToken,
  object: action.object,
  containerPath: action.containerPath,
  payloadPath: action.payloadPath,
  outcome: action.outcome,
  containerIdentity: action.containerIdentity,
  payloadIdentity: action.payloadIdentity,
});

const executionReport = (record: GcRecoveryRecordV1): GcReportV1Dto => {
  const outcomes = new Map(record.actions.map((action) => [action.actionId, action.outcome]));
  const results = record.approvedReport.actions.map((action) => {
    const outcome = outcomes.get(action.actionId);
    return {
      ...action,
      outcome: outcome === 'protected-skip' ? ('protected-skip' as const) : ('succeeded' as const),
      reason: outcome === 'protected-skip' ? 'protection changed after ledger commit' : null,
    };
  });
  const cleaned = new Set(
    record.actions.filter(({ outcome }) => outcome === 'cleaned').map(({ actionId }) => actionId),
  );
  const skipped = new Set(
    record.actions
      .filter(({ outcome }) => outcome === 'protected-skip')
      .map(({ actionId }) => actionId),
  );
  const reclaimedItems = record.actions.filter(({ outcome }) => outcome === 'cleaned').length;
  const reclaimedBytes = record.actions
    .filter(({ outcome }) => outcome === 'cleaned')
    .reduce((sum, { logicalBytes }) => sum + logicalBytes, 0);
  const forgottenProjects = record.approvedReport.projects.filter(
    ({ action }) => action === 'forget-project',
  ).length;
  return Object.freeze({
    ...record.approvedReport,
    mode: 'execute',
    state: 'completed',
    migration: {
      ...record.approvedReport.migration,
      outcome:
        record.approvedReport.migration.action === 'migrate-ledger'
          ? ('succeeded' as const)
          : ('not-required' as const),
    },
    approval: {
      required: record.approvedReport.actions.length > 0,
      outcome:
        record.approvedReport.actions.length > 0
          ? ('approved' as const)
          : ('not-required' as const),
    },
    recovery: { state: 'completed' as const, phase: 'complete' },
    projects: record.approvedReport.projects.map((project) =>
      project.action === 'forget-project' ? { ...project, outcome: 'forgotten' as const } : project,
    ),
    objects: record.approvedReport.objects.map((object) => {
      const action = record.approvedReport.actions.find(
        (candidate) => candidate.kind === 'reclaim-store' && candidate.target === object.path,
      );
      return action !== undefined && cleaned.has(action.actionId)
        ? { ...object, outcome: 'reclaimed' as const }
        : action !== undefined && skipped.has(action.actionId)
          ? {
              ...object,
              outcome: 'protected' as const,
              reason: 'protection changed after ledger commit',
            }
          : object;
    }),
    results,
    summary: {
      ...record.approvedReport.summary,
      protectedItems: record.approvedReport.summary.protectedItems + skipped.size,
      forgottenProjects,
      reclaimedItems,
      reclaimedBytes,
      failedItems: 0,
    },
  });
};

const runPendingLocked = async (
  ports: ExecutePorts,
  dataDir: string,
  storeRoot: string,
  ledgerPath: string,
  approved: Extract<GcRecoveryObservation, { readonly state: 'pending' }>,
): Promise<GcExecutionResult> => {
  const observed = await observeGcRecovery(ports, dataDir);
  if (
    observed.state !== 'pending' ||
    observed.record.planId !== approved.record.planId ||
    observed.record.revision !== approved.record.revision
  ) {
    return fail(approved.record, 'GC recovery state changed before execution');
  }
  const converged = await convergeGcRecovery(ports, dataDir, observed);
  if (converged.state !== 'pending') {
    return fail(approved.record, 'GC recovery staging could not converge');
  }
  const boundaries = await commitLedgerBoundaries(ports, ledgerPath, converged);
  if (!boundaries.ok) return boundaries.result;
  let recovery = boundaries.recovery;

  const inventory = await inventoryGcStore(ports, storeRoot);
  if (inventory.state !== 'ok')
    return fail(recovery.record, 'GC committed store inventory is unsafe');
  const liveTargets = await observeGcLiveTargets(ports, boundaries.model, inventory.objects);
  if (liveTargets.state !== 'ok') return fail(recovery.record, liveTargets.reason);
  const classified = classifyGcReachability({
    model: boundaries.model,
    objects: inventory.objects,
    nowMilliseconds: recovery.record.nowMilliseconds,
    olderThanMilliseconds: recovery.record.olderThanMilliseconds,
    liveTargets: liveTargets.targets,
  });
  if (classified.state !== 'ok')
    return fail(recovery.record, 'GC committed reachability revalidation failed');
  const eligible = new Set(
    classified.classifications
      .filter(({ outcome }) => outcome === 'eligible')
      .map(({ object }) => object.id),
  );

  for (const initialAction of recovery.record.actions) {
    let action = recovery.record.actions.find(
      ({ actionId }) => actionId === initialAction.actionId,
    );
    if (action === undefined) return fail(recovery.record, 'GC recovery action disappeared');
    if (action.outcome === 'pending' && !eligible.has(action.object.id)) {
      const actions = recovery.record.actions.map((candidate) =>
        candidate.actionId === action?.actionId
          ? { ...candidate, outcome: 'protected-skip' as const }
          : candidate,
      );
      const advanced = await replace(ports, recovery, { phase: 'reclaiming', actions });
      if (advanced === null) return fail(recovery.record, 'GC protected-skip recovery CAS failed');
      recovery = advanced;
      continue;
    }
    while (
      action.outcome === 'pending' ||
      action.outcome === 'prepared' ||
      action.outcome === 'detached'
    ) {
      const advancedAction = await reclaimGcStoreObject(
        ports,
        actionRequest(storeRoot, recovery.record.planId, action),
      );
      if (advancedAction.state === 'refused') return fail(recovery.record, advancedAction.reason);
      const actions = recovery.record.actions.map((candidate) =>
        candidate.actionId === action?.actionId
          ? {
              ...candidate,
              outcome: advancedAction.state,
              containerIdentity: advancedAction.containerIdentity,
              payloadIdentity: advancedAction.payloadIdentity,
            }
          : candidate,
      );
      const advanced = await replace(ports, recovery, { phase: 'reclaiming', actions });
      if (advanced === null) return fail(recovery.record, 'GC reclaim recovery CAS failed');
      recovery = advanced;
      action = recovery.record.actions.find(({ actionId }) => actionId === initialAction.actionId);
      if (action === undefined) return fail(recovery.record, 'GC recovery action disappeared');
    }
    if (
      action.outcome === 'cleaned' &&
      !(await finalizeGcStoreReclaim(
        ports,
        actionRequest(storeRoot, recovery.record.planId, action),
      ))
    ) {
      return fail(recovery.record, 'GC tombstone metadata cleanup failed');
    }
  }

  const complete =
    recovery.record.phase === 'complete'
      ? recovery
      : await replace(ports, recovery, { phase: 'complete' });
  if (complete === null) return fail(recovery.record, 'GC recovery completion CAS failed');
  const report = executionReport(complete.record);
  if (!(await removeGcRecoveryRecord(ports, complete))) {
    return fail(complete.record, 'GC recovery completion cleanup failed');
  }
  return Object.freeze({ ok: true, report });
};

export const resumeGcRecovery = async (
  ports: ExecutePorts,
  input: Readonly<{
    readonly dataDir: string;
    readonly storeRoot: string;
    readonly ledgerPath: string;
    readonly recovery: Extract<GcRecoveryObservation, { readonly state: 'pending' }>;
  }>,
): Promise<GcExecutionResult> => {
  if (
    input.recovery.record.dataDir !== input.dataDir ||
    input.recovery.record.storeRoot !== input.storeRoot ||
    input.recovery.record.ledgerPath !== input.ledgerPath
  ) {
    return fail(
      input.recovery.record,
      'GC configured paths differ from pending recovery authority',
    );
  }
  const locked = await withLedgerLock(ports, input.ledgerPath, () =>
    runPendingLocked(ports, input.dataDir, input.storeRoot, input.ledgerPath, input.recovery),
  );
  if (!locked.ok)
    return fail(input.recovery.record, 'GC could not acquire the placement ledger lock');
  return locked.value;
};

export const clearIncompleteGcRecovery = async (
  ports: ExecutePorts,
  input: Readonly<{
    readonly dataDir: string;
    readonly ledgerPath: string;
    readonly recovery: Extract<GcRecoveryObservation, { readonly state: 'incomplete' }>;
  }>,
): Promise<boolean> => {
  const locked = await withLedgerLock(ports, input.ledgerPath, () =>
    removeIncompleteGcRecovery(ports, input.dataDir, input.recovery),
  );
  return locked.ok && locked.value;
};

export const executeGcPlan = async (
  ports: ExecutePorts,
  plan: PreparedGcPlan,
): Promise<GcExecutionResult> => {
  const locked = await withLedgerLock(ports, plan.ledgerPath, async () => {
    const currentLedger = await readLedgerState(ports, plan.ledgerPath);
    if (
      !currentLedger.ok ||
      !sameSource(sourceLedgerRecord(plan.sourceLedger), currentLedger.value)
    ) {
      const reason = 'GC ledger changed after approval';
      return Object.freeze({ ok: false, report: failureReport(plan.report, reason), reason });
    }
    const hasMigration = plan.actions.some(({ kind }) => kind === 'migrate-ledger');
    const hasForget = plan.normalizedForgetRoots.length > 0;
    const migrationUpdatedAt = hasMigration ? ports.wallNowIso() : null;
    const forgetUpdatedAt = hasForget ? ports.wallNowIso() : null;
    const migrationModel =
      migrationUpdatedAt === null ? plan.model : atUpdatedTime(plan.model, migrationUpdatedAt);
    const postForgetModel =
      forgetUpdatedAt === null
        ? migrationModel
        : atUpdatedTime(plan.postForgetModel, forgetUpdatedAt);
    const expectedMigrationSemanticRevision = hasMigration
      ? semanticRevision(migrationModel)
      : null;
    const expectedPostForgetSemanticRevision =
      currentLedger.value.state === 'absent' && !hasMigration && !hasForget
        ? null
        : semanticRevision(postForgetModel);
    const initial = recordWithRevision({
      schemaVersion: 1,
      kind: 'skillsmith.gc-recovery',
      planId: plan.planId,
      requestDigest: plan.requestDigest,
      phase: 'approved',
      dataDir: plan.dataDir,
      storeRoot: plan.storeRoot,
      ledgerPath: plan.ledgerPath,
      retryArguments: plan.retryArguments,
      sourceLedger: sourceLedgerRecord(plan.sourceLedger),
      normalizedForgetRoots: plan.normalizedForgetRoots,
      migrationUpdatedAt,
      expectedMigrationSemanticRevision,
      forgetUpdatedAt,
      expectedPostForgetSemanticRevision,
      nowMilliseconds: plan.nowMilliseconds,
      olderThanMilliseconds: plan.olderThanMilliseconds,
      approvedReport: plan.report,
      actions: recoveryActions(plan),
    });
    const recovery = await createGcRecoveryRecord(ports, plan.dataDir, initial);
    if (recovery.state !== 'pending') {
      const reason =
        recovery.state === 'refused' ? recovery.reason : 'GC recovery record was not published';
      return Object.freeze({ ok: false, report: failureReport(plan.report, reason), reason });
    }
    return runPendingLocked(ports, plan.dataDir, plan.storeRoot, plan.ledgerPath, recovery);
  });
  if (!locked.ok) {
    const reason = 'GC could not acquire the placement ledger lock';
    return Object.freeze({ ok: false, report: failureReport(plan.report, reason), reason });
  }
  return locked.value;
};
