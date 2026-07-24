import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';

export type GcObjectKind = 'store' | 'adapted-overlay';

export interface GcEntryIdentity {
  readonly path: string;
  readonly kind: 'file' | 'symlink';
  readonly identity: string;
  readonly linkCount: 1;
  readonly logicalBytes: number;
  readonly executable: boolean | null;
  readonly target: string | null;
}

export interface GcObjectObservation {
  readonly id: string;
  readonly kind: GcObjectKind;
  readonly path: string;
  readonly relativePath: string;
  readonly namespace: string;
  readonly repository: string;
  readonly revision: string;
  readonly skill: string;
  readonly contentHash: ArtifactDigest;
  readonly modifiedAt: number;
  readonly logicalBytes: number;
  readonly rootIdentity: string;
  readonly namespaceIdentity: string;
  readonly repositoryIdentity: string;
  readonly directoryIdentity: string;
  readonly directoryLinkCount: number;
  readonly entries: readonly GcEntryIdentity[];
}

export type GcInventoryIssueCode =
  | 'unsafe-root'
  | 'unsafe-layout'
  | 'unsafe-component'
  | 'unsafe-entry'
  | 'unsafe-symlink'
  | 'unsafe-hard-link'
  | 'unstable-observation'
  | 'unreadable'
  | 'byte-overflow';

export interface GcInventoryIssue {
  readonly code: GcInventoryIssueCode;
  readonly path: string;
  readonly reason: string;
}

export type GcInventory =
  | Readonly<{
      readonly state: 'ok';
      readonly root: string;
      readonly rootIdentity: string | null;
      readonly objects: readonly GcObjectObservation[];
      readonly issues: readonly [];
    }>
  | Readonly<{
      readonly state: 'refused';
      readonly root: string;
      readonly rootIdentity: string | null;
      readonly objects: readonly [];
      readonly issues: readonly GcInventoryIssue[];
    }>;

export type GcProtectionKind =
  | 'ledger'
  | 'project-registration'
  | 'live-placement'
  | 'logical-transaction'
  | 'legacy-journal'
  | 'history'
  | 'adapted-overlay';

export interface GcProtectionEdge {
  readonly kind: GcProtectionKind;
  readonly sourceId: string;
  readonly path: string;
  readonly contentHash: string;
}

export type GcObjectOutcome = 'protected' | 'age-filtered' | 'eligible';

export interface GcObjectClassification {
  readonly object: GcObjectObservation;
  readonly protection: readonly GcProtectionEdge[];
  readonly ageEligible: boolean;
  readonly outcome: GcObjectOutcome;
}

export interface GcLiveStoreTarget {
  readonly sourceId: string;
  readonly path: string;
  readonly contentHash: string;
}

export interface GcReachabilityInput {
  readonly model: LedgerModel;
  readonly objects: readonly GcObjectObservation[];
  readonly liveTargets?: readonly GcLiveStoreTarget[];
  readonly nowMilliseconds: number;
  readonly olderThanMilliseconds: number | null;
}

export type GcReachabilityResult =
  | Readonly<{
      readonly state: 'ok';
      readonly classifications: readonly GcObjectClassification[];
    }>
  | Readonly<{
      readonly state: 'refused';
      readonly reason: string;
      readonly classifications: readonly [];
    }>;

export interface GcForgetObservation {
  readonly root: string;
  readonly exists: boolean;
  readonly current: boolean;
  readonly hasPendingJournal: boolean;
  readonly registered: boolean;
}

export interface GcDuration {
  readonly input: string;
  readonly milliseconds: number;
}

export interface GcRequestError {
  readonly code: 'invalid-duration' | 'invalid-forget' | 'unsafe-forget';
  readonly message: string;
}

export interface GcPlanningInput {
  readonly cwd: string;
  readonly forgetProject: readonly string[];
  readonly olderThan: string | null;
  readonly currentProjectRoot: string;
  readonly forgetObservations: readonly GcForgetObservation[];
  readonly inventory: GcInventory;
  readonly ledger: LedgerReadState;
  readonly nowMilliseconds: number;
  readonly liveTargets?: readonly GcLiveStoreTarget[];
}

export type GcRecoveryPhase = 'approved' | 'forget-complete' | 'reclaiming' | 'complete';

export interface GcRecoveryActionV1 {
  readonly actionId: string;
  readonly kind: 'reclaim-store';
  readonly path: string;
  readonly contentHash: string;
  readonly modifiedAt: number;
  readonly logicalBytes: number;
  readonly ownershipToken: string;
  readonly containerPath: string;
  readonly payloadPath: string;
  readonly outcome: 'pending' | 'detached' | 'cleaned' | 'protected-skip';
}

export interface GcRecoveryRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.gc-recovery';
  readonly planId: string;
  readonly requestDigest: string;
  readonly revision: string;
  readonly phase: GcRecoveryPhase;
  readonly retryArguments: readonly string[];
  readonly actions: readonly GcRecoveryActionV1[];
}

export type GcRecoveryObservation =
  | Readonly<{ readonly state: 'none'; readonly record: null; readonly path: string }>
  | Readonly<{
      readonly state: 'pending';
      readonly record: GcRecoveryRecordV1;
      readonly path: string;
    }>
  | Readonly<{
      readonly state: 'refused';
      readonly record: null;
      readonly path: string;
      readonly reason: string;
    }>;

export interface GcReclaimRequest {
  readonly storeRoot: string;
  readonly planId: string;
  readonly actionId: string;
  readonly ownershipToken: string;
  readonly object: GcObjectObservation;
}

export type GcReclaimResult =
  | Readonly<{ readonly state: 'cleaned'; readonly logicalBytes: number }>
  | Readonly<{ readonly state: 'already-absent'; readonly logicalBytes: 0 }>
  | Readonly<{ readonly state: 'refused'; readonly logicalBytes: 0; readonly reason: string }>;
