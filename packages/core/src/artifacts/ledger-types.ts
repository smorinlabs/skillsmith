import type { ArtifactDigest } from './hash.ts';
import type { LogicalJournalV1Dto } from './journal-types.ts';

export type LedgerV1ToolId = 'claude-code' | 'codex';

export interface LedgerDevV1Dto {
  readonly sourcePath: string;
  readonly resolvedPath: string;
  readonly repoRoot: string | null;
  readonly sourceRelPath: string | null;
  readonly remote: string | null;
  readonly recordedAt: string;
}

export interface LedgerPinnedV1Dto {
  readonly storePath: string;
  readonly rev: string;
  readonly gitSha: string | null;
  readonly dirty: boolean;
  readonly contentHash: string;
  readonly snapshotAt: string;
  readonly verify: 'passed' | 'warned' | 'skipped';
  readonly placement?: 'symlink' | 'copy';
}

export interface LedgerOriginV1Dto {
  readonly source: string;
  readonly host: string;
  readonly repo: string;
  readonly skillPath: string;
  readonly refRequested: string | null;
  readonly refResolved: string;
  readonly pin: boolean;
  readonly installedAt: string;
}

export type LegacyPairBeforeV1Dto =
  | Readonly<{ mode: 'dev'; symlinkTarget: string; liveKind?: 'symlink' | 'dir' }>
  | Readonly<{
      mode: 'pinned';
      storePath: string | null;
      contentHash: string | null;
      liveKind?: 'symlink' | 'dir';
      symlinkTarget?: string;
    }>
  | Readonly<{ mode: 'absent' }>;

export interface LegacyPairJournalV1Dto {
  readonly op: 'promote' | 'dev' | 'rollback' | 'install' | 'uninstall';
  readonly txId: string;
  readonly phase: 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly before: LegacyPairBeforeV1Dto;
  readonly stagingPath: string;
  readonly backupPath: string;
}

/**
 * Durable intent for an interrupted two-stage copy replacement (SC-I60-MO2).
 * A copy-over-copy update runs as two kind changes (dir→symlink, symlink→dir);
 * the marker records the requested build plus the last stage reached so an
 * identical retry completes stage 2 instead of nooping on the intermediate
 * symlink. Absent on every pair the replacement never touched; cleared when
 * the pair converges to the recorded build or is superseded. Additive and
 * optional: readers must be nullish-safe.
 */
export interface LedgerPendingReplacementV1Dto {
  readonly build: 'symlink' | 'copy';
  readonly stage: 1 | 2;
  readonly refResolved: string;
  readonly storePath: string;
  readonly contentHash: string;
  readonly backupPath: string | null;
  readonly recordedAt: string;
}

export interface LedgerPairV1Dto {
  readonly placementPath: string;
  readonly mode: 'dev' | 'pinned';
  readonly dev: LedgerDevV1Dto | null;
  readonly pinned?: LedgerPinnedV1Dto | null;
  readonly origin?: LedgerOriginV1Dto;
  readonly journal?: LegacyPairJournalV1Dto | null;
  readonly pendingReplacement?: LedgerPendingReplacementV1Dto | null;
}

export interface LedgerToolsV1Dto {
  readonly 'claude-code'?: LedgerPairV1Dto;
  readonly codex?: LedgerPairV1Dto;
}

export type LedgerSkillsV1Dto = Readonly<Record<string, Readonly<{ tools: LedgerToolsV1Dto }>>>;

export interface LedgerV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.placements';
  readonly updatedAt: string;
  readonly skills: LedgerSkillsV1Dto;
  readonly projects?: Readonly<Record<string, Readonly<{ readonly skills: LedgerSkillsV1Dto }>>>;
}

export type LedgerV2ToolId = string;
export type LedgerSkillsV2Dto = Readonly<
  Record<string, Readonly<{ readonly tools: Readonly<Record<LedgerV2ToolId, LedgerPairV1Dto>> }>>
>;

export interface LedgerConsumerV2Dto {
  readonly skill: string;
  readonly tool: LedgerV2ToolId;
  readonly placementPath: string;
  readonly store: null | Readonly<{ readonly path: string; readonly contentHash: string }>;
}

export interface ProjectRegistrationV2Dto {
  readonly consumers: readonly LedgerConsumerV2Dto[];
}

export interface LedgerV2Dto {
  readonly schemaVersion: 2;
  readonly kind: 'skillsmith.placements';
  readonly updatedAt: string;
  readonly skills: LedgerSkillsV2Dto;
  readonly projects: Readonly<Record<string, Readonly<{ readonly skills: LedgerSkillsV2Dto }>>>;
  readonly projectRegistrations: Readonly<Record<string, ProjectRegistrationV2Dto>>;
  readonly transactions: Readonly<Record<string, LogicalJournalV1Dto>>;
  readonly history: readonly LogicalJournalV1Dto[];
}

export interface LedgerSemanticProjectionV1 {
  readonly updatedAt: string;
  readonly skills: LedgerSkillsV2Dto;
  readonly projects: LedgerV2Dto['projects'];
  readonly projectRegistrations: LedgerV2Dto['projectRegistrations'];
  readonly transactions: LedgerV2Dto['transactions'];
  readonly history: LedgerV2Dto['history'];
}

export type LedgerModel = Readonly<LedgerSemanticProjectionV1>;

/** Canonical identity used by immutable pair transforms and logical/physical shadow validation. */
export interface LedgerPairIdentity {
  readonly projectRoot: string | null;
  readonly skill: string;
  readonly tool: LedgerV2ToolId;
}

/** Read-only ledger observation. Absence deliberately carries no fabricated timestamp/model. */
export type LedgerReadState =
  | Readonly<{
      readonly state: 'absent';
      readonly sourceVersion: null;
      readonly bytes: null;
      readonly byteRevision: null;
      readonly semanticRevision: null;
      readonly model: null;
    }>
  | Readonly<{
      readonly state: 'present';
      readonly sourceVersion: 1 | 2;
      readonly bytes: Uint8Array;
      readonly byteRevision: ArtifactDigest;
      readonly semanticRevision: ArtifactDigest;
      readonly model: LedgerModel;
    }>;

/**
 * The migration writer receives every journal image up front. Recovery therefore never allocates
 * a new timestamp, operation ID, or transaction ID after a crash.
 */
export interface LedgerMigrationJournalSequence {
  readonly prepared: LogicalJournalV1Dto;
  readonly staged: LogicalJournalV1Dto;
  readonly backedUp: LogicalJournalV1Dto;
  readonly live: LogicalJournalV1Dto;
  readonly committed: LogicalJournalV1Dto;
}

export interface PreservedLegacyJournalIdentityV1 {
  readonly scope:
    | Readonly<{ readonly kind: 'user' }>
    | Readonly<{ readonly kind: 'project'; readonly root: string }>;
  readonly skill: string;
  readonly tool: LedgerV1ToolId;
  readonly txId: string;
}

export interface LedgerMigrationV1ToV2 {
  readonly kind: 'ledger-v1-to-v2';
  readonly fromSchemaVersion: 1;
  readonly toSchemaVersion: 2;
  readonly sourceByteRevision: ArtifactDigest;
  readonly sourceSemanticRevision: ArtifactDigest;
  readonly targetSemanticRevision: ArtifactDigest;
  readonly targetByteRevision: ArtifactDigest;
  readonly targetCanonicalSource: string;
  readonly preservedLegacyJournals: readonly PreservedLegacyJournalIdentityV1[];
}
