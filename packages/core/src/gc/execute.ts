import { join } from 'node:path';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import { ledgerSemanticRevision, logicalJournalPairIdentity } from '../artifacts/registry.ts';
import type { GcReportV1Dto } from '../contracts/v1/gc.ts';
import { type SkillSmithError, safeErrorCode } from '../errors.ts';
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
  type GcRecoveryCleanupResult,
  convergeGcRecovery,
  createGcRecoveryRecord,
  gcRecoveryRevision,
  observeGcRecovery,
  removeGcRecoveryRecord,
  removeIncompleteGcRecovery,
  replaceGcRecoveryRecord,
} from './recovery.ts';
import { finalizeGcStoreReclaim, observeGcTombstones, reclaimGcStoreObject } from './repository.ts';
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
  recovery:
    report.recovery.state === 'pending' ? report.recovery : { state: 'none' as const, phase: null },
  diagnostics: [{ code: 'gc-execution', message: reason, path: null }],
  summary: { ...report.summary, failedItems: 1 },
});

const forgetCommitted = (record: GcRecoveryRecordV1): boolean =>
  record.phase === 'forget-complete' ||
  record.phase === 'reclaiming' ||
  record.phase === 'complete';

const migrationCommitted = (record: GcRecoveryRecordV1): boolean => record.phase !== 'approved';

const reportFromRecord = (
  record: GcRecoveryRecordV1,
  input: Readonly<{
    readonly mode: 'dry-run' | 'execute';
    readonly completed: boolean;
    readonly reason?: string;
    readonly migrationDone?: boolean;
    readonly forgetDone?: boolean;
    readonly recovery?: GcReportV1Dto['recovery'];
    readonly failureKind?: GcReportV1Dto['actions'][number]['kind'];
    readonly failureActionId?: string;
  }>,
): GcReportV1Dto => {
  const outcomes = new Map(record.actions.map((action) => [action.actionId, action.outcome]));
  const cleaned = new Set(
    record.actions.filter(({ outcome }) => outcome === 'cleaned').map(({ actionId }) => actionId),
  );
  const skipped = new Set(
    record.actions
      .filter(({ outcome }) => outcome === 'protected-skip')
      .map(({ actionId }) => actionId),
  );
  const alreadyAbsent = new Set(
    record.actions
      .filter(({ outcome }) => outcome === 'already-absent')
      .map(({ actionId }) => actionId),
  );
  const migrationDone = input.migrationDone ?? migrationCommitted(record);
  const forgetDone = input.forgetDone ?? forgetCommitted(record);
  const results = record.approvedReport.actions.map((action) => {
    const failed =
      input.reason !== undefined &&
      (action.actionId === input.failureActionId || action.kind === input.failureKind);
    if (action.kind === 'migrate-ledger') {
      return {
        ...action,
        outcome: migrationDone
          ? ('succeeded' as const)
          : failed
            ? ('failed' as const)
            : ('planned' as const),
        reason: failed ? (input.reason ?? null) : null,
      };
    }
    if (action.kind === 'forget-project') {
      return {
        ...action,
        outcome: forgetDone
          ? ('succeeded' as const)
          : failed
            ? ('failed' as const)
            : ('planned' as const),
        reason: failed ? (input.reason ?? null) : null,
      };
    }
    const outcome = outcomes.get(action.actionId);
    return {
      ...action,
      outcome:
        outcome === 'cleaned' || outcome === 'already-absent'
          ? ('succeeded' as const)
          : outcome === 'protected-skip'
            ? ('protected-skip' as const)
            : failed
              ? ('failed' as const)
              : ('planned' as const),
      reason:
        outcome === 'protected-skip'
          ? 'protection changed after ledger commit'
          : outcome === 'already-absent'
            ? 'already absent before detach'
            : failed
              ? input.reason
              : null,
    };
  });
  const reclaimedItems = cleaned.size;
  const reclaimedBytes = record.actions
    .filter(({ outcome }) => outcome === 'cleaned')
    .reduce((sum, { logicalBytes }) => sum + logicalBytes, 0);
  const forgottenProjects = forgetDone
    ? record.approvedReport.projects.filter(({ action }) => action === 'forget-project').length
    : 0;
  return Object.freeze({
    ...record.approvedReport,
    mode: input.mode,
    state: input.completed ? 'completed' : 'partial',
    migration: {
      ...record.approvedReport.migration,
      outcome:
        record.approvedReport.migration.action === 'migrate-ledger'
          ? migrationDone
            ? ('succeeded' as const)
            : ('planned' as const)
          : ('not-required' as const),
    },
    approval: {
      required: record.approvedReport.actions.length > 0,
      outcome:
        record.approvedReport.actions.length > 0
          ? ('approved' as const)
          : ('not-required' as const),
    },
    recovery:
      input.recovery ??
      (input.completed
        ? { state: 'completed' as const, phase: 'complete' as const }
        : { state: 'pending' as const, phase: record.phase }),
    projects: record.approvedReport.projects.map((project) =>
      project.action === 'forget-project' && forgetDone
        ? { ...project, outcome: 'forgotten' as const }
        : project,
    ),
    objects: record.approvedReport.objects.map((object) => {
      const action = record.approvedReport.actions.find(
        (candidate) => candidate.kind === 'reclaim-store' && candidate.target === object.path,
      );
      return action !== undefined && cleaned.has(action.actionId)
        ? { ...object, outcome: 'reclaimed' as const }
        : action !== undefined && alreadyAbsent.has(action.actionId)
          ? {
              ...object,
              outcome: 'already-absent' as const,
              reason: 'already absent before detach',
            }
          : action !== undefined && skipped.has(action.actionId)
            ? {
                ...object,
                outcome: 'protected' as const,
                reason: 'protection changed after ledger commit',
              }
            : object;
    }),
    results,
    diagnostics:
      input.reason === undefined
        ? record.approvedReport.diagnostics
        : [{ code: 'gc-execution', message: input.reason, path: null }],
    summary: {
      ...record.approvedReport.summary,
      protectedItems: record.approvedReport.summary.protectedItems + skipped.size,
      forgottenProjects,
      alreadyAbsentItems: alreadyAbsent.size,
      reclaimedItems,
      reclaimedBytes,
      failedItems: input.reason === undefined ? 0 : 1,
    },
  });
};

export const pendingGcRecoveryReport = (
  record: GcRecoveryRecordV1,
  mode: 'dry-run' | 'execute',
): GcReportV1Dto => reportFromRecord(record, { mode, completed: false });

const fail = (
  record: GcRecoveryRecordV1,
  reason: string,
  projection: Readonly<{
    readonly migrationDone?: boolean;
    readonly forgetDone?: boolean;
    readonly recovery?: GcReportV1Dto['recovery'];
    readonly failureKind?: GcReportV1Dto['actions'][number]['kind'];
    readonly failureActionId?: string;
  }> = {},
): GcExecutionResult =>
  Object.freeze({
    ok: false,
    reason,
    report: reportFromRecord(record, {
      mode: 'execute',
      completed: false,
      reason,
      ...projection,
    }),
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
  fallback: string,
  projection: Readonly<{
    readonly migrationDone?: boolean;
    readonly forgetDone?: boolean;
  }> = {},
): Promise<
  | Readonly<{
      readonly ok: true;
      readonly recovery: Extract<GcRecoveryObservation, { readonly state: 'pending' }>;
    }>
  | Readonly<{ readonly ok: false; readonly result: GcExecutionResult }>
> => {
  const next = recordWithRevision({ ...withoutRevision(recovery.record), ...patch });
  const result = await replaceGcRecoveryRecord(ports, recovery, next);
  if (result.state === 'pending' && result.publicationFailure === undefined) {
    return Object.freeze({ ok: true, recovery: result });
  }
  const reason =
    result.state === 'pending'
      ? (result.publicationFailure ?? fallback)
      : result.state === 'refused'
        ? result.reason
        : fallback;
  return Object.freeze({
    ok: false,
    result: fail(result.state === 'pending' ? result.record : recovery.record, reason, projection),
  });
};

const writeExactLedger = async (
  ports: ExecutePorts,
  ledgerPath: string,
  model: LedgerModel,
  updatedAt: string,
  expected: ArtifactDigest,
): Promise<string | null> => {
  const exact = atUpdatedTime(model, updatedAt);
  if (semanticRevision(exact) !== expected) return 'GC ledger semantic precondition failed';
  const written = await writeLedger(
    Object.assign(Object.create(ports), { wallNowIso: () => updatedAt }),
    ledgerPath,
    exact,
  );
  if (!written.ok) {
    return written.error.code === 'permission-denied'
      ? 'GC permission denied during ledger write'
      : 'GC ledger write failed';
  }
  const reread = await readLedgerState(ports, ledgerPath);
  if (!reread.ok) {
    return reread.error.code === 'permission-denied'
      ? 'GC permission denied while verifying the ledger write'
      : 'GC ledger write verification failed';
  }
  return hasSemantic(reread.value, expected) ? null : 'GC ledger semantic verification failed';
};

const forgetPreconditionsHold = async (
  ports: ExecutePorts,
  model: LedgerModel,
  currentProjectRoot: string,
  roots: readonly string[],
): Promise<boolean> => {
  for (const root of roots) {
    if (
      root === currentProjectRoot ||
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

const lockFailureReason = (error: SkillSmithError): string =>
  error.code === 'permission-denied'
    ? 'GC permission denied while acquiring the placement ledger lock'
    : error.code === 'cancelled'
      ? 'GC execution was cancelled'
      : 'GC could not acquire the placement ledger lock';

const ledgerReadFailureReason = (error: SkillSmithError, fallback: string): string =>
  error.code === 'permission-denied' ? 'GC permission denied while reading the ledger' : fallback;

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
  if (!current.ok) {
    return {
      ok: false,
      result: fail(
        recovery.record,
        ledgerReadFailureReason(current.error, 'GC ledger is unreadable'),
      ),
    };
  }

  if (recovery.record.phase === 'approved') {
    const expected = recovery.record.expectedMigrationSemanticRevision;
    if (expected !== null && hasSemantic(current.value, expected)) {
      const advanced = await replace(
        ports,
        recovery,
        { phase: 'migration-complete' },
        'GC migration recovery CAS failed',
        { migrationDone: true },
      );
      if (!advanced.ok) return { ok: false, result: advanced.result };
      recovery = advanced.recovery;
    } else if (expected !== null && sameSource(recovery.record.sourceLedger, current.value)) {
      if (current.value.state !== 'present' || recovery.record.migrationUpdatedAt === null) {
        return {
          ok: false,
          result: fail(recovery.record, 'GC ledger migration failed', {
            failureKind: 'migrate-ledger',
          }),
        };
      }
      const writeFailure = await writeExactLedger(
        ports,
        ledgerPath,
        current.value.model,
        recovery.record.migrationUpdatedAt,
        expected,
      );
      if (writeFailure !== null) {
        return {
          ok: false,
          result: fail(recovery.record, writeFailure, { failureKind: 'migrate-ledger' }),
        };
      }
      const advanced = await replace(
        ports,
        recovery,
        { phase: 'migration-complete' },
        'GC migration recovery CAS failed',
        { migrationDone: true },
      );
      if (!advanced.ok) return { ok: false, result: advanced.result };
      recovery = advanced.recovery;
      current = await readLedgerState(ports, ledgerPath);
      if (!current.ok) {
        return {
          ok: false,
          result: fail(
            recovery.record,
            ledgerReadFailureReason(current.error, 'GC migrated ledger is unreadable'),
          ),
        };
      }
    } else if (expected === null && sameSource(recovery.record.sourceLedger, current.value)) {
      const advanced = await replace(
        ports,
        recovery,
        { phase: 'migration-complete' },
        'GC migration skip CAS failed',
      );
      if (!advanced.ok) return { ok: false, result: advanced.result };
      recovery = advanced.recovery;
    } else if (hasSemantic(current.value, recovery.record.expectedPostForgetSemanticRevision)) {
      const advanced = await replace(
        ports,
        recovery,
        { phase: 'forget-complete' },
        'GC committed ledger adoption failed',
        { migrationDone: true, forgetDone: true },
      );
      if (!advanced.ok) return { ok: false, result: advanced.result };
      recovery = advanced.recovery;
    } else {
      return { ok: false, result: fail(recovery.record, 'GC ledger drifted before migration') };
    }
  }

  if (recovery.record.phase === 'migration-complete') {
    current = await readLedgerState(ports, ledgerPath);
    if (!current.ok) {
      return {
        ok: false,
        result: fail(
          recovery.record,
          ledgerReadFailureReason(current.error, 'GC ledger is unreadable'),
        ),
      };
    }
    const expected = recovery.record.expectedPostForgetSemanticRevision;
    if (hasSemantic(current.value, expected)) {
      const advanced = await replace(
        ports,
        recovery,
        { phase: 'forget-complete' },
        'GC forget adoption CAS failed',
        { forgetDone: true },
      );
      if (!advanced.ok) return { ok: false, result: advanced.result };
      recovery = advanced.recovery;
    } else if (recovery.record.normalizedForgetRoots.length === 0) {
      const unchanged =
        recovery.record.expectedMigrationSemanticRevision === null
          ? sameSource(recovery.record.sourceLedger, current.value)
          : hasSemantic(current.value, recovery.record.expectedMigrationSemanticRevision);
      if (!unchanged)
        return { ok: false, result: fail(recovery.record, 'GC ledger drifted before reclaim') };
      const advanced = await replace(
        ports,
        recovery,
        { phase: 'forget-complete' },
        'GC forget skip CAS failed',
      );
      if (!advanced.ok) return { ok: false, result: advanced.result };
      recovery = advanced.recovery;
    } else {
      if (
        current.value.state !== 'present' ||
        recovery.record.forgetUpdatedAt === null ||
        expected === null ||
        !(await forgetPreconditionsHold(
          ports,
          current.value.model,
          recovery.record.approvedReport.project.root,
          recovery.record.normalizedForgetRoots,
        ))
      ) {
        return {
          ok: false,
          result: fail(recovery.record, 'GC forget source is unavailable', {
            failureKind: 'forget-project',
          }),
        };
      }
      const forgotten = withoutLedgerProjectAt(
        current.value.model,
        recovery.record.normalizedForgetRoots,
      );
      if (!forgotten.ok) {
        return {
          ok: false,
          result: fail(recovery.record, 'GC ledger forget commit failed', {
            failureKind: 'forget-project',
          }),
        };
      }
      const writeFailure = await writeExactLedger(
        ports,
        ledgerPath,
        forgotten.value,
        recovery.record.forgetUpdatedAt,
        expected,
      );
      if (writeFailure !== null) {
        return {
          ok: false,
          result: fail(recovery.record, writeFailure, { failureKind: 'forget-project' }),
        };
      }
      const advanced = await replace(
        ports,
        recovery,
        { phase: 'forget-complete' },
        'GC forget recovery CAS failed',
        { forgetDone: true },
      );
      if (!advanced.ok) return { ok: false, result: advanced.result };
      recovery = advanced.recovery;
    }
  }

  current = await readLedgerState(ports, ledgerPath);
  if (!current.ok) {
    return {
      ok: false,
      result: fail(
        recovery.record,
        ledgerReadFailureReason(current.error, 'GC ledger is unreadable'),
      ),
    };
  }
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

const runPendingLocked = async (
  ports: ExecutePorts,
  dataDir: string,
  storeRoot: string,
  ledgerPath: string,
  approved: Extract<GcRecoveryObservation, { readonly state: 'pending' }>,
  signal?: AbortSignal,
): Promise<GcExecutionResult> => {
  if (signal?.aborted) return fail(approved.record, 'GC execution was cancelled');
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
    return fail(
      approved.record,
      converged.state === 'refused' ? converged.reason : 'GC recovery staging could not converge',
    );
  }
  if (converged.publicationFailure !== undefined) {
    return fail(converged.record, converged.publicationFailure);
  }
  const tombstones = await observeGcTombstones(ports, storeRoot, converged);
  if (tombstones.state === 'refused') return fail(converged.record, tombstones.reason);
  const boundaries = await commitLedgerBoundaries(ports, ledgerPath, converged);
  if (!boundaries.ok) return boundaries.result;
  let recovery = boundaries.recovery;
  if (signal?.aborted) return fail(recovery.record, 'GC execution was cancelled');

  for (const initialAction of recovery.record.actions) {
    if (signal?.aborted) return fail(recovery.record, 'GC execution was cancelled');
    let action = recovery.record.actions.find(
      ({ actionId }) => actionId === initialAction.actionId,
    );
    if (action === undefined) return fail(recovery.record, 'GC recovery action disappeared');
    if (action.outcome === 'pending') {
      const inventory = await inventoryGcStore(ports, storeRoot);
      if (inventory.state !== 'ok') {
        return fail(recovery.record, 'GC committed store inventory is unsafe', {
          failureActionId: action.actionId,
        });
      }
      const current = inventory.objects.find(({ path }) => path === action?.object.path);
      const sourceAbsent =
        current === undefined && (await ports.pathKind(action.object.path)) === 'absent';
      if (current !== undefined && current.id !== action.object.id) {
        return fail(recovery.record, 'GC approved candidate changed before reclaim', {
          failureActionId: action.actionId,
        });
      }
      if (current === undefined && !sourceAbsent) {
        return fail(recovery.record, 'GC approved candidate became unsafe before reclaim', {
          failureActionId: action.actionId,
        });
      }
      const liveTargets = await observeGcLiveTargets(ports, boundaries.model, inventory.objects);
      if (liveTargets.state !== 'ok') {
        return fail(recovery.record, liveTargets.reason, { failureActionId: action.actionId });
      }
      const classified = classifyGcReachability({
        model: boundaries.model,
        objects: inventory.objects,
        nowMilliseconds: recovery.record.nowMilliseconds,
        olderThanMilliseconds: recovery.record.olderThanMilliseconds,
        liveTargets: liveTargets.targets,
      });
      if (classified.state !== 'ok') {
        return fail(recovery.record, 'GC committed reachability revalidation failed', {
          failureActionId: action.actionId,
        });
      }
      const stillEligible =
        sourceAbsent ||
        classified.classifications.some(
          ({ object, outcome }) => object.id === action?.object.id && outcome === 'eligible',
        );
      if (stillEligible) {
        // Continue into the record-bound prepare/detach/cleanup state machine below.
      } else {
        const actions = recovery.record.actions.map((candidate) =>
          candidate.actionId === action?.actionId
            ? { ...candidate, outcome: 'protected-skip' as const }
            : candidate,
        );
        const advanced = await replace(
          ports,
          recovery,
          { phase: 'reclaiming', actions },
          'GC protected-skip recovery CAS failed',
        );
        if (!advanced.ok) return advanced.result;
        recovery = advanced.recovery;
        continue;
      }
    }
    while (
      action.outcome === 'pending' ||
      action.outcome === 'prepared' ||
      action.outcome === 'detached' ||
      action.outcome === 'cleanup-started'
    ) {
      const advancedAction = await reclaimGcStoreObject(
        ports,
        actionRequest(storeRoot, recovery.record.planId, action),
      );
      if (advancedAction.state === 'refused') {
        return fail(recovery.record, advancedAction.reason, {
          failureActionId: action.actionId,
        });
      }
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
      const advanced = await replace(
        ports,
        recovery,
        { phase: 'reclaiming', actions },
        'GC reclaim recovery CAS failed',
      );
      if (!advanced.ok) return advanced.result;
      recovery = advanced.recovery;
      action = recovery.record.actions.find(({ actionId }) => actionId === initialAction.actionId);
      if (action === undefined) return fail(recovery.record, 'GC recovery action disappeared');
      if (signal?.aborted) return fail(recovery.record, 'GC execution was cancelled');
    }
    if (action.outcome === 'cleaned') {
      const finalized = await finalizeGcStoreReclaim(
        ports,
        actionRequest(storeRoot, recovery.record.planId, action),
      );
      if (!finalized.ok) {
        return fail(recovery.record, finalized.reason, { failureActionId: action.actionId });
      }
    }
  }

  let complete = recovery;
  if (recovery.record.phase !== 'complete') {
    const advanced = await replace(
      ports,
      recovery,
      { phase: 'complete' },
      'GC recovery completion CAS failed',
    );
    if (!advanced.ok) return advanced.result;
    complete = advanced.recovery;
  }
  const report = reportFromRecord(complete.record, { mode: 'execute', completed: true });
  const removed = await removeGcRecoveryRecord(ports, complete);
  if (!removed.ok) {
    const recovery: GcReportV1Dto['recovery'] =
      removed.recoveryState === 'none'
        ? { state: 'none', phase: null }
        : removed.recoveryState === 'pending'
          ? { state: 'pending', phase: 'complete' }
          : { state: 'refused', phase: 'complete' };
    return fail(complete.record, removed.reason, { recovery });
  }
  return Object.freeze({ ok: true, report });
};

const unexpectedExecutionReason = (error: unknown, operation: string): string => {
  const code = safeErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return `GC permission denied during ${operation}`;
  }
  if (code === 'cancelled' || code === 'ABORT_ERR' || code === 'AbortError') {
    return 'GC execution was cancelled';
  }
  return `GC ${operation} failed`;
};

const runPendingSafely = async (
  ports: ExecutePorts,
  dataDir: string,
  storeRoot: string,
  ledgerPath: string,
  approved: Extract<GcRecoveryObservation, { readonly state: 'pending' }>,
  signal?: AbortSignal,
): Promise<GcExecutionResult> => {
  try {
    return await runPendingLocked(ports, dataDir, storeRoot, ledgerPath, approved, signal);
  } catch (error) {
    let record = approved.record;
    try {
      const observed = await observeGcRecovery(ports, dataDir);
      if (observed.state === 'pending' && observed.record.planId === record.planId) {
        record = observed.record;
      }
    } catch {
      // Preserve the last proven recovery authority when re-observation is itself unavailable.
    }
    return fail(record, unexpectedExecutionReason(error, 'recovery execution'));
  }
};

export const resumeGcRecovery = async (
  ports: ExecutePorts,
  input: Readonly<{
    readonly dataDir: string;
    readonly storeRoot: string;
    readonly ledgerPath: string;
    readonly recovery: Extract<GcRecoveryObservation, { readonly state: 'pending' }>;
    readonly signal?: AbortSignal;
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
  const locked = await withLedgerLock(
    ports,
    input.ledgerPath,
    () =>
      runPendingSafely(
        ports,
        input.dataDir,
        input.storeRoot,
        input.ledgerPath,
        input.recovery,
        input.signal,
      ),
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  if (!locked.ok) return fail(input.recovery.record, lockFailureReason(locked.error));
  return locked.value;
};

export const clearIncompleteGcRecovery = async (
  ports: ExecutePorts,
  input: Readonly<{
    readonly dataDir: string;
    readonly ledgerPath: string;
    readonly recovery: Extract<GcRecoveryObservation, { readonly state: 'incomplete' }>;
    readonly signal?: AbortSignal;
  }>,
): Promise<GcRecoveryCleanupResult> => {
  if (input.signal?.aborted) {
    return Object.freeze({
      ok: false,
      recoveryState: 'pending',
      reason: 'GC execution was cancelled',
    });
  }
  const locked = await withLedgerLock(
    ports,
    input.ledgerPath,
    () => removeIncompleteGcRecovery(ports, input.dataDir, input.recovery),
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  return locked.ok
    ? locked.value
    : Object.freeze({
        ok: false,
        recoveryState: 'pending' as const,
        reason: lockFailureReason(locked.error),
      });
};

const preRecordPlanFailure = async (
  ports: ExecutePorts,
  plan: PreparedGcPlan,
  ledger: LedgerReadState,
): Promise<string | null> => {
  if (plan.normalizedForgetRoots.length > 0) {
    if (
      ledger.state !== 'present' ||
      !(await forgetPreconditionsHold(
        ports,
        ledger.model,
        plan.report.project.root,
        plan.normalizedForgetRoots,
      ))
    ) {
      return 'GC forget preconditions changed after approval';
    }
  }
  const inventory = await inventoryGcStore(ports, plan.storeRoot);
  if (inventory.state !== 'ok') return 'GC store inventory became unsafe after approval';
  for (const action of plan.actions) {
    if (action.kind !== 'reclaim-store') continue;
    const current = inventory.objects.find(({ path }) => path === action.object.path);
    const alreadyAbsent =
      current === undefined && (await ports.pathKind(action.object.path)) === 'absent';
    if (!alreadyAbsent && JSON.stringify(current) !== JSON.stringify(action.object)) {
      return 'GC approved candidate changed after approval';
    }
  }
  for (const action of recoveryActions(plan)) {
    if (
      (await ports.pathKind(action.containerPath)) !== 'absent' ||
      (await ports.pathKind(action.payloadPath)) !== 'absent'
    ) {
      return 'GC tombstone action state was planted after approval';
    }
  }
  return null;
};

export const executeGcPlan = async (
  ports: ExecutePorts,
  plan: PreparedGcPlan,
  signal?: AbortSignal,
): Promise<GcExecutionResult> => {
  const locked = await withLedgerLock(
    ports,
    plan.ledgerPath,
    async () => {
      try {
        if (signal?.aborted) {
          const reason = 'GC execution was cancelled';
          return Object.freeze({ ok: false, report: failureReport(plan.report, reason), reason });
        }
        const currentRecovery = await observeGcRecovery(ports, plan.dataDir);
        if (currentRecovery.state === 'refused' || currentRecovery.state === 'incomplete') {
          const reason = currentRecovery.reason;
          return Object.freeze({ ok: false, report: failureReport(plan.report, reason), reason });
        }
        const tombstones = await observeGcTombstones(ports, plan.storeRoot, currentRecovery);
        if (tombstones.state === 'refused') {
          return Object.freeze({
            ok: false,
            report: failureReport(plan.report, tombstones.reason),
            reason: tombstones.reason,
          });
        }
        if (currentRecovery.state === 'pending') {
          if (currentRecovery.record.requestDigest !== plan.requestDigest) {
            const reason = 'GC recovery state belongs to a different approved request';
            return Object.freeze({ ok: false, report: failureReport(plan.report, reason), reason });
          }
          return runPendingSafely(
            ports,
            plan.dataDir,
            plan.storeRoot,
            plan.ledgerPath,
            currentRecovery,
            signal,
          );
        }
        const currentLedger = await readLedgerState(ports, plan.ledgerPath);
        if (
          !currentLedger.ok ||
          !sameSource(sourceLedgerRecord(plan.sourceLedger), currentLedger.value)
        ) {
          const reason = currentLedger.ok
            ? 'GC ledger changed after approval'
            : ledgerReadFailureReason(currentLedger.error, 'GC ledger changed after approval');
          return Object.freeze({ ok: false, report: failureReport(plan.report, reason), reason });
        }
        const preRecordFailure = await preRecordPlanFailure(ports, plan, currentLedger.value);
        if (preRecordFailure !== null) {
          return Object.freeze({
            ok: false,
            report: failureReport(plan.report, preRecordFailure),
            reason: preRecordFailure,
          });
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
        if (recovery.publicationFailure !== undefined) {
          return fail(recovery.record, recovery.publicationFailure);
        }
        return runPendingSafely(
          ports,
          plan.dataDir,
          plan.storeRoot,
          plan.ledgerPath,
          recovery,
          signal,
        );
      } catch (error) {
        const reason = unexpectedExecutionReason(error, 'approved-plan precondition check');
        return Object.freeze({ ok: false, report: failureReport(plan.report, reason), reason });
      }
    },
    signal === undefined ? undefined : { signal },
  );
  if (!locked.ok) {
    const reason = lockFailureReason(locked.error);
    return Object.freeze({ ok: false, report: failureReport(plan.report, reason), reason });
  }
  return locked.value;
};
