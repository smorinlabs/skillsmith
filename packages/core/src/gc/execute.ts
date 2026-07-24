import { join } from 'node:path';
import type { GcReportV1Dto } from '../contracts/v1/gc.ts';
import { readLedgerState, withLedgerLock, writeLedger } from '../place/ledger.ts';
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
import {
  createGcRecoveryRecord,
  gcRecoveryRevision,
  removeGcRecoveryRecord,
  replaceGcRecoveryRecord,
} from './recovery.ts';
import { reclaimGcStoreObject } from './repository.ts';
import type { GcRecoveryActionV1, GcRecoveryRecordV1, PreparedGcPlan } from './types.ts';

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
        ownershipToken: action.ownershipToken,
        containerPath,
        payloadPath: join(containerPath, 'payload'),
        outcome: 'pending' as const,
      });
    });

const failureReport = (plan: PreparedGcPlan, reason: string): GcReportV1Dto => ({
  ...plan.report,
  mode: 'execute',
  state: 'partial',
  approval: { required: true, outcome: 'approved' },
  diagnostics: [{ code: 'gc-execution', message: reason, path: null }],
  summary: { ...plan.report.summary, failedItems: 1 },
});

const sameLedger = (
  expected: PreparedGcPlan['sourceLedger'],
  actual: PreparedGcPlan['sourceLedger'],
): boolean =>
  expected.state === actual.state &&
  (expected.state === 'absent' ||
    (actual.state === 'present' &&
      expected.byteRevision === actual.byteRevision &&
      expected.semanticRevision === actual.semanticRevision));

export const executeGcPlan = async (
  ports: ExecutePorts,
  plan: PreparedGcPlan,
): Promise<GcExecutionResult> => {
  const locked = await withLedgerLock(
    ports,
    plan.ledgerPath,
    async (): Promise<GcExecutionResult> => {
      const currentLedger = await readLedgerState(ports, plan.ledgerPath);
      if (!currentLedger.ok || !sameLedger(plan.sourceLedger, currentLedger.value)) {
        const reason = 'GC ledger changed after approval';
        return Object.freeze({ ok: false, report: failureReport(plan, reason), reason });
      }
      const initial = recordWithRevision({
        schemaVersion: 1,
        kind: 'skillsmith.gc-recovery',
        planId: plan.planId,
        requestDigest: plan.requestDigest,
        phase: 'approved',
        retryArguments: plan.retryArguments,
        actions: recoveryActions(plan),
      });
      let recovery = await createGcRecoveryRecord(ports, plan.dataDir, initial);
      if (recovery.state !== 'pending') {
        const reason =
          recovery.state === 'refused' ? recovery.reason : 'GC recovery record was not published';
        return Object.freeze({ ok: false, report: failureReport(plan, reason), reason });
      }

      const ledgerActions = plan.actions.filter(
        ({ kind }) => kind === 'migrate-ledger' || kind === 'forget-project',
      );
      if (ledgerActions.length > 0) {
        const written = await writeLedger(ports, plan.ledgerPath, plan.postForgetModel);
        if (!written.ok) {
          const reason = 'GC ledger migration or forget commit failed';
          return Object.freeze({ ok: false, report: failureReport(plan, reason), reason });
        }
      }
      const forgetCompleteSeed = {
        ...withoutRevision(recovery.record),
        phase: 'forget-complete' as const,
      };
      const forgetComplete = recordWithRevision(forgetCompleteSeed);
      recovery = await replaceGcRecoveryRecord(ports, recovery, forgetComplete);
      if (recovery.state !== 'pending') {
        const reason = 'GC recovery record did not commit the ledger boundary';
        return Object.freeze({ ok: false, report: failureReport(plan, reason), reason });
      }

      const actionResults: GcReportV1Dto['results'][number][] = [];
      let reclaimedItems = 0;
      let reclaimedBytes = 0;
      for (const action of plan.actions) {
        if (action.kind !== 'reclaim-store') {
          actionResults.push({
            actionId: action.actionId,
            kind: action.kind,
            target: action.target,
            logicalBytes: 0,
            dependencyIds: [...action.dependencyIds],
            outcome: 'succeeded',
            reason: null,
          });
          continue;
        }
        const reclaimed = await reclaimGcStoreObject(ports, {
          storeRoot: plan.storeRoot,
          planId: plan.planId,
          actionId: action.actionId,
          ownershipToken: action.ownershipToken,
          object: action.object,
        });
        if (reclaimed.state === 'refused') {
          actionResults.push({
            actionId: action.actionId,
            kind: action.kind,
            target: action.target,
            logicalBytes: action.object.logicalBytes,
            dependencyIds: [...action.dependencyIds],
            outcome: 'failed',
            reason: reclaimed.reason,
          });
          const reason = reclaimed.reason;
          const report = failureReport(plan, reason);
          return Object.freeze({
            ok: false,
            reason,
            report: { ...report, results: actionResults },
          });
        }
        reclaimedItems += reclaimed.state === 'cleaned' ? 1 : 0;
        reclaimedBytes += reclaimed.logicalBytes;
        actionResults.push({
          actionId: action.actionId,
          kind: action.kind,
          target: action.target,
          logicalBytes: action.object.logicalBytes,
          dependencyIds: [...action.dependencyIds],
          outcome: 'succeeded',
          reason:
            reclaimed.state === 'already-absent' ? 'already absent under matching plan' : null,
        });
        const nextActions = recovery.record.actions.map((candidate) =>
          candidate.actionId === action.actionId
            ? { ...candidate, outcome: 'cleaned' as const }
            : candidate,
        );
        const reclaimingSeed = {
          ...withoutRevision(recovery.record),
          phase: 'reclaiming' as const,
          actions: nextActions,
        };
        const reclaiming = recordWithRevision(reclaimingSeed);
        const replaced = await replaceGcRecoveryRecord(ports, recovery, reclaiming);
        if (replaced.state !== 'pending') {
          const reason = 'GC recovery record did not commit reclaimed action state';
          return Object.freeze({ ok: false, report: failureReport(plan, reason), reason });
        }
        recovery = replaced;
      }

      const completeSeed = {
        ...withoutRevision(recovery.record),
        phase: 'complete' as const,
      };
      const complete = recordWithRevision(completeSeed);
      const completedRecovery = await replaceGcRecoveryRecord(ports, recovery, complete);
      if (completedRecovery.state !== 'pending') {
        const reason = 'GC recovery completion record failed';
        return Object.freeze({ ok: false, report: failureReport(plan, reason), reason });
      }
      if (!(await removeGcRecoveryRecord(ports, completedRecovery))) {
        const reason = 'GC recovery completion cleanup failed';
        return Object.freeze({ ok: false, report: failureReport(plan, reason), reason });
      }
      const forgottenProjects = plan.actions.filter(({ kind }) => kind === 'forget-project').length;
      const report: GcReportV1Dto = {
        ...plan.report,
        mode: 'execute',
        state: 'completed',
        migration: {
          ...plan.report.migration,
          outcome: plan.report.migration.action === 'migrate-ledger' ? 'succeeded' : 'not-required',
        },
        approval: {
          required: plan.actions.length > 0,
          outcome: plan.actions.length > 0 ? 'approved' : 'not-required',
        },
        recovery: { state: 'completed', phase: 'complete' },
        projects: plan.report.projects.map((project) =>
          project.action === 'forget-project'
            ? { ...project, outcome: 'forgotten' as const }
            : project,
        ),
        objects: plan.report.objects.map((object) =>
          actionResults.some(
            (result) => result.kind === 'reclaim-store' && result.target === object.path,
          )
            ? { ...object, outcome: 'reclaimed' as const }
            : object,
        ),
        actions: plan.report.actions,
        results: actionResults,
        summary: {
          ...plan.report.summary,
          forgottenProjects,
          reclaimedItems,
          reclaimedBytes,
          failedItems: 0,
        },
      };
      return Object.freeze({ ok: true, report: Object.freeze(report) });
    },
  );
  if (!locked.ok) {
    const reason = 'GC could not acquire the placement ledger lock';
    return Object.freeze({ ok: false, report: failureReport(plan, reason), reason });
  }
  return locked.value;
};
