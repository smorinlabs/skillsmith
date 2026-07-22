import type { SupportedTool } from '../agents/types.ts';
import type { LedgerReadState } from '../artifacts/ledger-types.ts';
import type { Scope } from '../config/types.ts';
import type { ProjectContext } from '../context/types.ts';
import type {
  FileMetadataReadPort,
  InventoryReadPorts,
  ResolvedRuntimeConfiguration,
} from '../ports/types.ts';

export type StatusReadPorts = InventoryReadPorts & FileMetadataReadPort;

export type StatusArtifactSelection =
  | Readonly<{
      readonly state: 'unselected';
      readonly reason: 'live-only-scope' | 'lifecycle-history';
    }>
  | Readonly<{
      readonly state: 'selected';
      readonly source: 'explicit' | 'discovered-project' | 'project-default' | 'user-default';
      readonly manifestPath: string;
      readonly lockPath: string;
      readonly lockSource: 'sibling' | 'explicit';
    }>;

export type StatusProjectPlacementContext =
  | Readonly<{ readonly state: 'unselected' }>
  | Readonly<{
      readonly state: 'selected';
      readonly source: 'shared-project' | 'explicit-non-git';
      readonly canonicalCwd: string;
      readonly root: string;
      readonly identity: string;
    }>;

export interface StatusReadRequest {
  readonly projectContext: ProjectContext;
  readonly projectPlacement: StatusProjectPlacementContext;
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly targets: readonly string[];
  readonly tools: readonly SupportedTool[];
  readonly toolSelectionSource: 'explicit' | 'effective-config' | 'unbounded-default';
  readonly scopes: readonly Scope[];
  readonly scopeSelectionSource: 'explicit' | 'unbounded-default';
  readonly selectionSource: 'explicit-targets' | 'bounded-default';
  readonly artifactSelection: StatusArtifactSelection;
  readonly signal?: AbortSignal;
}

/** Private request-only history observation; it does not widen the public status CLI grammar. */
export type StatusLifecycleHistoryReadRequest = Readonly<
  Omit<StatusReadRequest, 'artifactSelection'> & {
    readonly artifactSelection: Readonly<{
      readonly state: 'unselected';
      readonly reason: 'lifecycle-history';
    }>;
  }
>;

/** Status report and exact ledger authority produced by the same single observation. */
export interface StatusLifecycleHistoryReadResult {
  readonly report: StatusReport;
  readonly ledgerPath: string;
  readonly ledgerState: LedgerReadState;
}

export interface StatusReadError {
  readonly code: 'status-read';
  readonly reason:
    | 'invalid-request'
    | 'unmatched-target'
    | 'invalid-artifact'
    | 'read-capability-unavailable'
    | 'observation-failed'
    | 'source-failed'
    | 'permission-denied'
    | 'cancelled';
  readonly exitClass:
    | 'usage'
    | 'state'
    | 'capability'
    | 'failure'
    | 'source'
    | 'permission'
    | 'cancelled';
  readonly message: string;
}

export type StatusPresence<T> =
  | Readonly<{ readonly state: 'absent' }>
  | Readonly<{ readonly state: 'present'; readonly value: T }>;

export type StatusPortableLockFact =
  | Readonly<{
      readonly reason: 'missing-entry';
      readonly name: string;
      readonly field: 'skills.name';
    }>
  | Readonly<{
      readonly reason: 'extra-entry';
      readonly name: string;
      readonly field: 'skills.name';
    }>
  | Readonly<{ readonly reason: 'manifest-hash-mismatch'; readonly field: 'manifest_hash' }>
  | Readonly<{
      readonly reason: 'source-mismatch';
      readonly name: string;
      readonly field: 'source';
    }>
  | Readonly<{
      readonly reason: 'requested-ref-mismatch';
      readonly name: string;
      readonly field: 'requested_ref';
    }>
  | Readonly<{
      readonly reason: 'source-path-mismatch';
      readonly name: string;
      readonly field: 'source_path';
    }>;

export type StatusArtifactRelationship =
  | Readonly<{ readonly state: 'none' }>
  | Readonly<{ readonly state: 'missing-lock' }>
  | Readonly<{ readonly state: 'lock-only' }>
  | Readonly<{
      readonly state: 'incomplete';
      readonly missingNames: readonly string[];
      readonly facts: readonly Extract<
        StatusPortableLockFact,
        { readonly reason: 'missing-entry' | 'extra-entry' }
      >[];
    }>
  | Readonly<{
      readonly state: 'stale';
      readonly facts: readonly Exclude<
        StatusPortableLockFact,
        { readonly reason: 'missing-entry' }
      >[];
    }>
  | Readonly<{ readonly state: 'current' }>;

export interface StatusSourceIdentity {
  readonly host: string;
  readonly repository: string;
  readonly path: string | null;
}

export interface StatusDesiredState {
  readonly name: string;
  readonly source: StatusSourceIdentity;
  readonly ref: string | null;
  readonly tools: readonly SupportedTool[];
  readonly scope: 'user' | 'project';
  readonly placement: 'symlink' | 'copy';
  readonly path: string | null;
}

export interface StatusLockedState {
  readonly name: string;
  readonly source: string;
  readonly requestedRef: string | null;
  readonly resolvedSha: string;
  readonly sourcePath: string;
  readonly contentHash: string;
}

export interface StatusLedgerObservation {
  readonly placementPath: string;
  readonly mode: 'dev' | 'pinned';
  readonly source: StatusSourceIdentity | null;
  readonly requestedRef: string | null;
  readonly resolvedRevision: string | null;
  readonly contentHash: string | null;
  readonly verification: StatusVerification;
  readonly placement: 'symlink' | 'copy' | null;
}

export type StatusManifestSummary =
  | Readonly<{ readonly state: 'absent' }>
  | Readonly<{
      readonly state: 'present';
      readonly sourceVersion: 'legacy';
      readonly currentVersion: 1;
      readonly byteRevision: string;
      readonly semanticRevision: string;
      readonly canonical: false;
      readonly migrationPending: true;
    }>
  | Readonly<{
      readonly state: 'present';
      readonly sourceVersion: 1;
      readonly currentVersion: 1;
      readonly byteRevision: string;
      readonly semanticRevision: string;
      readonly canonical: boolean;
      readonly migrationPending: false;
    }>;

export type StatusLockSummary =
  | Readonly<{ readonly state: 'absent' }>
  | Readonly<{
      readonly state: 'present';
      readonly sourceVersion: 1;
      readonly currentVersion: 1;
      readonly byteRevision: string;
      readonly semanticRevision: string;
      readonly canonical: true;
      readonly migrationPending: false;
    }>;

export type StatusLedgerSummary =
  | Readonly<{
      readonly state: 'absent';
      readonly path: string;
      readonly sourceVersion: null;
      readonly currentVersion: 2;
      readonly migrationPending: false;
    }>
  | Readonly<{
      readonly state: 'present';
      readonly path: string;
      readonly sourceVersion: 1;
      readonly currentVersion: 2;
      readonly byteRevision: string;
      readonly semanticRevision: string;
      readonly migrationPending: true;
    }>
  | Readonly<{
      readonly state: 'present';
      readonly path: string;
      readonly sourceVersion: 2;
      readonly currentVersion: 2;
      readonly byteRevision: string;
      readonly semanticRevision: string;
      readonly migrationPending: false;
    }>;

export interface StatusPlacementIdentity {
  readonly tool: string;
  readonly scope: Scope;
  readonly projectIdentity: string | null;
  readonly path: string | null;
}

export type StatusLiveClass = 'dev' | 'pinned' | 'store-linked' | 'unmanaged' | 'broken' | 'absent';

export type StatusBrokenReason =
  | 'ledger-recorded-absence'
  | 'dangling-link'
  | 'wrong-node-kind'
  | 'skill-file-missing'
  | 'skill-file-invalid'
  | 'ledger-mode-contradiction';

export type StatusVerification = 'passed' | 'warned' | 'skipped' | 'unrecorded';

export interface StatusLiveObservation {
  readonly path: string;
  readonly realpath: string | null;
  readonly nodeKind: 'directory' | 'symlink' | 'file' | 'other';
  readonly linkTarget: string | null;
  readonly skillFile: 'valid' | 'missing' | 'invalid';
}

export type StatusShadow =
  | Readonly<{ readonly state: 'none' }>
  | Readonly<{ readonly state: 'winner'; readonly shadows: readonly string[] }>
  | Readonly<{ readonly state: 'shadowed'; readonly winner: string }>
  | Readonly<{ readonly state: 'duplicate'; readonly winner: null }>;

export const STATUS_FACT_IMPACTS = ['drift', 'info'] as const;
export type StatusFactImpact = (typeof STATUS_FACT_IMPACTS)[number];

export const STATUS_FACT_SUBJECTS = [
  'manifest',
  'lock',
  'ledger',
  'live',
  'verification',
  'shadow',
  'journal',
] as const;
export type StatusFactSubject = (typeof STATUS_FACT_SUBJECTS)[number];

export const STATUS_FACT_CODES = [
  'manifest-only',
  'lock-only',
  'ledger-only',
  'live-only',
  'lock-missing-entry',
  'lock-extra-entry',
  'lock-manifest-hash',
  'lock-source',
  'lock-ref',
  'lock-source-path',
  'live-missing',
  'live-undeclared',
  'ledger-missing',
  'source-drift',
  'revision-drift',
  'content-drift',
  'placement-drift',
  'broken-live',
  'shadowed',
  'duplicate-live',
  'journal-pending',
  'journal-committed',
  'retention-missing',
  'retention-mismatch',
  'retention-unverified',
  'retention-incomplete',
  'ledger-migration-pending',
  'verify-passed',
  'verify-warned',
  'verify-skipped',
  'verify-unrecorded',
] as const;
export type StatusFactCode = (typeof STATUS_FACT_CODES)[number];

export const STATUS_FACT_AUTHORITY = {
  'manifest-only': { subject: 'manifest', impact: 'drift' },
  'lock-only': { subject: 'lock', impact: 'drift' },
  'ledger-only': { subject: 'ledger', impact: 'drift' },
  'live-only': { subject: 'live', impact: 'drift' },
  'lock-missing-entry': { subject: 'lock', impact: 'drift' },
  'lock-extra-entry': { subject: 'lock', impact: 'drift' },
  'lock-manifest-hash': { subject: 'lock', impact: 'drift' },
  'lock-source': { subject: 'lock', impact: 'drift' },
  'lock-ref': { subject: 'lock', impact: 'drift' },
  'lock-source-path': { subject: 'lock', impact: 'drift' },
  'live-missing': { subject: 'live', impact: 'drift' },
  'live-undeclared': { subject: 'live', impact: 'drift' },
  'ledger-missing': { subject: 'ledger', impact: 'drift' },
  'source-drift': { subject: 'ledger', impact: 'drift' },
  'revision-drift': { subject: 'ledger', impact: 'drift' },
  'content-drift': { subject: 'ledger', impact: 'drift' },
  'placement-drift': { subject: 'live', impact: 'drift' },
  'broken-live': { subject: 'live', impact: 'drift' },
  shadowed: { subject: 'shadow', impact: 'drift' },
  'duplicate-live': { subject: 'shadow', impact: 'drift' },
  'journal-pending': { subject: 'journal', impact: 'drift' },
  'journal-committed': { subject: 'journal', impact: 'info' },
  'retention-missing': { subject: 'journal', impact: 'drift' },
  'retention-mismatch': { subject: 'journal', impact: 'drift' },
  'retention-unverified': { subject: 'journal', impact: 'drift' },
  'retention-incomplete': { subject: 'journal', impact: 'drift' },
  'ledger-migration-pending': { subject: 'ledger', impact: 'info' },
  'verify-passed': { subject: 'verification', impact: 'info' },
  'verify-warned': { subject: 'verification', impact: 'info' },
  'verify-skipped': { subject: 'verification', impact: 'info' },
  'verify-unrecorded': { subject: 'verification', impact: 'info' },
} as const satisfies Readonly<
  Record<
    StatusFactCode,
    Readonly<{ readonly subject: StatusFactSubject; readonly impact: StatusFactImpact }>
  >
>;

export interface StatusFact {
  readonly code: StatusFactCode;
  readonly impact: StatusFactImpact;
  readonly subject: StatusFactSubject;
  readonly expected: string | null;
  readonly actual: string | null;
}

export type StatusLogicalOperation =
  | 'install'
  | 'update'
  | 'remove'
  | 'link-dev'
  | 'promote'
  | 'move-scope'
  | 'adapt'
  | 'repair'
  | 'write-manifest'
  | 'write-lock'
  | 'migrate-project-config'
  | 'migrate-ledger';
export type StatusLegacyOperation = 'promote' | 'dev' | 'rollback' | 'install' | 'uninstall';
export type StatusJournalOrigin =
  | Readonly<{ readonly format: 'logical'; readonly operation: StatusLogicalOperation }>
  | Readonly<{ readonly format: 'legacy-pair'; readonly operation: StatusLegacyOperation }>;

export type StatusRetentionEligibility =
  | 'eligible'
  | 'not-reversible'
  | 'retention-incomplete'
  | 'retention-missing'
  | 'retention-mismatch'
  | 'retention-unverified';
export type StatusRetentionState = 'satisfied' | 'missing' | 'mismatch' | 'unverified';

export type StatusRepositoryRevisionValue = Readonly<{
  readonly kind: 'artifact-bytes' | 'resource';
  readonly digest: string;
}>;
export type StatusRecordedRevisionCheckFor<K extends StatusRepositoryRevisionValue['kind']> =
  | Readonly<{
      readonly state: 'satisfied' | 'mismatch';
      readonly expected: Readonly<{ readonly kind: K; readonly digest: string }>;
      readonly observed: Readonly<{ readonly kind: K; readonly digest: string }>;
    }>
  | Readonly<{
      readonly state: 'missing' | 'unverified';
      readonly expected: Readonly<{ readonly kind: K; readonly digest: string }>;
      readonly observed: null;
    }>;
export type StatusRecordedRevisionCheck =
  | StatusRecordedRevisionCheckFor<'artifact-bytes'>
  | StatusRecordedRevisionCheckFor<'resource'>;

export type StatusRecordedContentCheck =
  | Readonly<{
      readonly state: 'satisfied' | 'mismatch';
      readonly domain: 'manifest-bytes' | 'lock-canonical' | 'source-content' | 'resource';
      readonly expected: string;
      readonly observed: string;
    }>
  | Readonly<{
      readonly state: 'missing' | 'unverified';
      readonly domain: 'manifest-bytes' | 'lock-canonical' | 'source-content' | 'resource';
      readonly expected: string;
      readonly observed: null;
    }>;
export type StatusUnrecordedCheck = Readonly<{
  readonly state: 'not-recorded';
  readonly domain: null;
  readonly expected: null;
  readonly observed: null;
}>;

export type StatusLegacyExpectedNode =
  | Readonly<{ readonly kind: 'absent'; readonly linkTarget: null }>
  | Readonly<{ readonly kind: 'directory'; readonly linkTarget: null }>
  | Readonly<{ readonly kind: 'symlink'; readonly linkTarget: string | null }>;
export type StatusLegacyObservedNode =
  | Readonly<{ readonly kind: 'absent'; readonly linkTarget: null }>
  | Readonly<{ readonly kind: 'directory'; readonly linkTarget: null }>
  | Readonly<{ readonly kind: 'symlink'; readonly linkTarget: string }>
  | Readonly<{ readonly kind: 'file' | 'other'; readonly linkTarget: null }>;
export type StatusLegacyStructuralCheck =
  | Readonly<{
      readonly state: 'satisfied' | 'mismatch';
      readonly expected: StatusLegacyExpectedNode;
      readonly observed: StatusLegacyObservedNode;
    }>
  | Readonly<{
      readonly state: 'missing';
      readonly expected: Exclude<StatusLegacyExpectedNode, { readonly kind: 'absent' }>;
      readonly observed: Readonly<{ readonly kind: 'absent'; readonly linkTarget: null }>;
    }>
  | Readonly<{
      readonly state: 'unverified';
      readonly expected: StatusLegacyExpectedNode;
      readonly observed: null;
    }>;

export interface StatusRetentionCommon {
  readonly path: string;
  readonly pathState: 'satisfied' | 'missing' | 'unverified';
  readonly state: StatusRetentionState;
}

export type StatusLogicalRetentionRequirement = Readonly<{
  readonly format: 'logical';
  readonly resourceId: string;
  readonly retainUntil: string | null;
  readonly repositoryRevision: StatusRecordedRevisionCheck;
  readonly contentHash: StatusRecordedContentCheck;
}> &
  (
    | Readonly<{
        readonly role: 'backup';
        readonly sourceRole: 'live' | 'manifest' | 'lock' | 'ledger';
      }>
    | Readonly<{ readonly role: 'store'; readonly sourceRole: null }>
  ) &
  StatusRetentionCommon;

export type StatusLegacyRetentionRequirement = Readonly<{
  readonly format: 'legacy-pair';
  readonly resourceId: null;
  readonly retainUntil: null;
  readonly structural: StatusLegacyStructuralCheck;
  readonly repositoryRevision: StatusUnrecordedCheck;
  readonly contentHash: StatusRecordedContentCheck | StatusUnrecordedCheck;
}> &
  (
    | Readonly<{ readonly role: 'backup'; readonly sourceRole: 'live' }>
    | Readonly<{ readonly role: 'store'; readonly sourceRole: null }>
  ) &
  StatusRetentionCommon;

export type StatusRetentionRequirement =
  | StatusLogicalRetentionRequirement
  | StatusLegacyRetentionRequirement;

export type StatusJournalState =
  | Readonly<{ readonly state: 'none' }>
  | (Readonly<{
      readonly state: 'pending';
      readonly transactionId: string;
      readonly phase: 'prepared' | 'staged' | 'backed-up' | 'live';
      readonly before: 'dev' | 'pinned' | 'absent' | 'multi-resource';
      readonly retention: readonly StatusRetentionRequirement[];
      readonly abortEligibility: StatusRetentionEligibility;
      readonly remediation: Readonly<{
        readonly resume: 'rerun the same operation';
        readonly abort: readonly string[] | null;
      }>;
    }> &
      StatusJournalOrigin)
  | (Readonly<{
      readonly state: 'committed';
      readonly transactionId: string;
      readonly phase: 'committed';
      readonly before: 'dev' | 'pinned' | 'absent' | 'multi-resource';
      readonly retention: readonly StatusRetentionRequirement[];
      readonly reverseEligibility: StatusRetentionEligibility;
      readonly remediation: Readonly<{ readonly reverse: readonly string[] | null }>;
    }> &
      StatusJournalOrigin);

export interface StatusEntry {
  readonly name: string;
  readonly desired: StatusPresence<StatusDesiredState>;
  readonly locked: StatusPresence<StatusLockedState>;
  readonly placements: readonly StatusPlacement[];
  readonly facts: readonly StatusFact[];
  readonly convergence: 'converged' | 'drift';
}

export interface StatusPlacement {
  readonly identity: StatusPlacementIdentity;
  readonly ledger: StatusPresence<StatusLedgerObservation>;
  readonly live: StatusPresence<StatusLiveObservation>;
  readonly classification: StatusLiveClass;
  readonly brokenReason: StatusBrokenReason | null;
  readonly verification: StatusVerification;
  readonly shadow: StatusShadow;
  readonly journal: StatusJournalState;
  readonly facts: readonly StatusFact[];
}

export type StatusSelection = Readonly<{
  readonly source: 'explicit-targets' | 'bounded-default';
  readonly targets: readonly string[];
  readonly tools: readonly string[];
  readonly toolSource: 'explicit' | 'effective-config' | 'unbounded-default';
  readonly scopes: readonly Scope[];
  readonly scopeSource: 'explicit' | 'unbounded-default';
}> &
  (
    | Readonly<{ readonly outcome: 'selected'; readonly reason: null }>
    | Readonly<{
        readonly outcome: 'filter-noop';
        readonly reason: 'valid selection was reduced to zero by active filters';
      }>
  );

export interface StatusContext {
  readonly effectiveCwd: string;
  readonly projectRoot: string | null;
  readonly projectIdentity: string | null;
  readonly projectSource: 'shared-project' | 'explicit-non-git' | null;
}

export type StatusUnmatchedJournal = Readonly<{
  readonly transactionId: string;
  readonly phase: 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
  readonly reason: 'superseded' | 'unselected-placement' | 'multi-resource';
}> &
  StatusJournalOrigin;

export interface StatusReport {
  readonly selection: StatusSelection;
  readonly context: StatusContext;
  readonly artifacts:
    | Readonly<{ readonly state: 'unselected'; readonly reason: 'live-only-scope' }>
    | Readonly<{
        readonly state: 'selected';
        readonly source: 'explicit' | 'discovered-project' | 'project-default' | 'user-default';
        readonly manifestPath: string;
        readonly lockPath: string;
        readonly lockSource: 'sibling' | 'explicit';
        readonly manifest: StatusManifestSummary;
        readonly lock: StatusLockSummary;
        readonly relationship: StatusArtifactRelationship;
      }>;
  readonly ledger: StatusLedgerSummary;
  readonly journals: readonly StatusUnmatchedJournal[];
  readonly facts: readonly StatusFact[];
  readonly entries: readonly StatusEntry[];
  readonly summary: Readonly<{
    readonly entries: number;
    readonly converged: number;
    readonly drifting: number;
    readonly migrationPending: boolean;
  }>;
}
