import type {
  PlanDigestV1,
  PlanIdV1,
  PlanLocationV1,
  PlanOperationIntentV1,
  RepositoryRevisionV1,
} from './plan-types.ts';

export type TimestampV1 = string;

export type JournalIntentV1Dto = PlanOperationIntentV1;

export interface JournalContextV1Dto {
  parentOperationId: PlanIdV1 | null;
  command: PlanIdV1;
  workflow: PlanIdV1;
  attempt: number;
  startedAt: TimestampV1;
}

export type LiveActualV1Dto =
  | {
      resourceId: PlanIdV1;
      role: 'live';
      state: 'absent';
      repositoryRevision: null;
      placementPath: string;
      liveKind: null;
      mode: null;
      symlinkTarget: null;
      contentHash: null;
    }
  | {
      resourceId: PlanIdV1;
      role: 'live';
      state: 'present';
      repositoryRevision: RepositoryRevisionV1;
      placementPath: string;
      liveKind: 'symlink' | 'directory' | 'file' | 'other';
      mode: 'dev' | 'pinned' | null;
      symlinkTarget: string | null;
      contentHash: PlanDigestV1 | null;
    };

export type ManifestActualV1Dto =
  | {
      resourceId: PlanIdV1;
      role: 'manifest';
      state: 'absent';
      repositoryRevision: null;
      location: PlanLocationV1;
      shape: null;
      version: null;
      byteHash: null;
      semanticHash: null;
    }
  | {
      resourceId: PlanIdV1;
      role: 'manifest';
      state: 'present';
      repositoryRevision: RepositoryRevisionV1;
      location: PlanLocationV1;
      shape: 'legacy';
      version: null;
      byteHash: PlanDigestV1;
      semanticHash: PlanDigestV1;
    }
  | {
      resourceId: PlanIdV1;
      role: 'manifest';
      state: 'present';
      repositoryRevision: RepositoryRevisionV1;
      location: PlanLocationV1;
      shape: 'canonical';
      version: 1;
      byteHash: PlanDigestV1;
      semanticHash: PlanDigestV1;
    };

export type LockActualV1Dto =
  | {
      resourceId: PlanIdV1;
      role: 'lock';
      state: 'absent';
      repositoryRevision: null;
      location: PlanLocationV1;
      version: null;
      canonicalHash: null;
    }
  | {
      resourceId: PlanIdV1;
      role: 'lock';
      state: 'present';
      repositoryRevision: RepositoryRevisionV1;
      location: PlanLocationV1;
      version: 1;
      canonicalHash: PlanDigestV1;
    };

export type LedgerActualV1Dto =
  | {
      resourceId: PlanIdV1;
      role: 'ledger';
      state: 'absent';
      repositoryRevision: null;
      schemaVersion: null;
      semanticHash: null;
    }
  | {
      resourceId: PlanIdV1;
      role: 'ledger';
      state: 'present';
      repositoryRevision: RepositoryRevisionV1;
      schemaVersion: 1 | 2;
      semanticHash: PlanDigestV1;
    };

export type JournalResourceActualV1Dto =
  | LiveActualV1Dto
  | ManifestActualV1Dto
  | LockActualV1Dto
  | LedgerActualV1Dto;

export type JournalRetainedV1Dto =
  | {
      resourceId: PlanIdV1;
      role: 'backup';
      sourceRole: 'live' | 'manifest' | 'lock' | 'ledger';
      path: string;
      repositoryRevision: RepositoryRevisionV1;
      contentHash: PlanDigestV1;
      retainUntil: TimestampV1 | null;
    }
  | {
      resourceId: PlanIdV1;
      role: 'store';
      path: string;
      repositoryRevision: RepositoryRevisionV1;
      contentHash: PlanDigestV1;
      retainUntil: TimestampV1 | null;
    };

export interface LogicalJournalV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.transaction-journal';
  transactionId: PlanIdV1;
  intent: JournalIntentV1Dto;
  context: JournalContextV1Dto;
  disposition: 'forward' | 'rollback';
  phase: 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
  actual: {
    before: readonly JournalResourceActualV1Dto[];
    after: readonly JournalResourceActualV1Dto[];
    retained: readonly JournalRetainedV1Dto[];
  };
  updatedAt: TimestampV1;
  completedAt: TimestampV1 | null;
}

export type JournalV1Dto = LogicalJournalV1Dto;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type LogicalJournalV1 = DeepReadonly<LogicalJournalV1Dto>;
