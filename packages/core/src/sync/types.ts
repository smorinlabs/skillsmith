import type { BuiltInToolId } from '../agents/registry.ts';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import type { ArtifactReadResult } from '../artifacts/repository.ts';
import type { ProjectContext } from '../context/types.ts';
import type { ExportResult, PortableExportCandidate } from '../export/types.ts';
import type { SkillInventory, SkillInventoryEntry } from '../inventory/types.ts';

export type SyncEndpointRole = 'source' | 'destination';
export type SyncEndpointScope = 'user' | 'project' | 'system' | 'managed';
export type SyncEndpointKind = SyncEndpointScope | 'path';

export interface SyncEndpointRootFact {
  readonly tool: BuiltInToolId;
  readonly scope: SyncEndpointScope;
  readonly path: string;
  readonly canonicalPath: string;
  readonly state: 'absent' | 'directory';
}

/** One invocation-frozen live endpoint. Selected spelling never participates in identity. */
export interface ResolvedSyncEndpoint {
  readonly role: SyncEndpointRole;
  readonly selectedInput: string;
  readonly kind: SyncEndpointKind;
  readonly scope: SyncEndpointScope;
  readonly canonicalBase: string | null;
  readonly project: ProjectContext;
  readonly roots: readonly SyncEndpointRootFact[];
  readonly identity: `sync-endpoint:v1:${string}`;
}

export interface ResolvedSyncEndpoints {
  readonly tools: readonly BuiltInToolId[];
  readonly from: ResolvedSyncEndpoint;
  readonly to: ResolvedSyncEndpoint;
}

export interface ResolveSyncEndpointsRequest {
  readonly from: string;
  readonly to: string;
  readonly tools: readonly string[];
}

export type SyncPortableProof = 'none' | 'exact';

export interface ObserveSyncFleetRequest {
  readonly portableProof: SyncPortableProof;
}

export type SyncPortableObservation =
  | Readonly<{ readonly outcome: 'not-requested' }>
  | Readonly<{
      readonly outcome: 'portable';
      readonly candidate: PortableExportCandidate;
    }>
  | Readonly<{
      readonly outcome: 'nonportable';
      readonly result: ExportResult;
    }>;

export interface SyncMemberObservation {
  readonly entry: SkillInventoryEntry;
  readonly ledgerPair: LedgerPairV1Dto | null;
  readonly liveContentHash: ArtifactDigest | null;
  readonly pendingJournal: boolean;
  readonly pendingTransactionIds: readonly string[];
  readonly defaultLocation: boolean;
  readonly portable: SyncPortableObservation;
}

export interface SyncEndpointObservation {
  readonly endpoint: ResolvedSyncEndpoint;
  readonly inventory: SkillInventory;
  readonly entries: readonly SyncMemberObservation[];
  readonly membershipHash: ArtifactDigest;
  readonly ledger: ArtifactReadResult<LedgerModel>;
  readonly ledgerPath: string;
}

export interface SyncFleetObservation {
  readonly endpoints: ResolvedSyncEndpoints;
  readonly portableProof: SyncPortableProof;
  readonly source: SyncEndpointObservation;
  readonly destination: SyncEndpointObservation;
}

export interface SyncObservationFailure {
  readonly code: string;
  readonly message: string;
  readonly exitClass: 'failure' | 'usage' | 'state' | 'capability' | 'permission' | 'cancelled';
}
