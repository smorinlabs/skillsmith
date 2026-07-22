import type { Placement } from '../agents/placement-shared.ts';
import type { SupportedTool } from '../agents/types.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import type { LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import type { PortableLockRelationship, PortableLockSkillV1 } from '../artifacts/lock.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import type { CapabilityPreconditionV1, ResourcePreconditionV1 } from '../artifacts/plan-types.ts';
import type { ArtifactReadEnvelope, ArtifactReadResult } from '../artifacts/repository.ts';
import type { NormalizedManifestDeclaration, NormalizedManifestV1 } from '../artifacts/types.ts';
import type { ProjectContext } from '../context/types.ts';
import type { OperationDigest, OperationPlan, RefusalClass } from '../planning/types.ts';

export type ReconcileExecutionCommandV1 = 'apply' | 'update';

export interface PlanSelectionRequest {
  readonly tools: readonly SupportedTool[];
  /** Optional declaration-name membership used by fresh update reconciliation. */
  readonly skills?: readonly string[];
  readonly scope: 'user' | 'project' | null;
  readonly locked: boolean;
  readonly prune: boolean;
  readonly check: boolean;
}

export interface ObservedPlanArtifacts {
  readonly project: ProjectContext;
  readonly pair: ResolvedArtifactPair;
  readonly manifest: ArtifactReadEnvelope<NormalizedManifestV1>;
  readonly lock: ArtifactReadResult<PortableLockV1>;
  readonly relationship: PortableLockRelationship;
  readonly ledgerPath?: string;
  readonly ledger?: ArtifactReadResult<LedgerModel>;
  readonly artifactPortableTokens?: Readonly<{
    readonly manifest: string;
    readonly lock: string;
  }>;
}

export interface ResolvedPlanDeclaration {
  readonly declaration: NormalizedManifestDeclaration;
  readonly tool: SupportedTool;
  readonly lock: PortableLockSkillV1;
}

export interface ResolvedPlanInput {
  readonly observed: ObservedPlanArtifacts;
  readonly request: PlanSelectionRequest;
  readonly declarations: readonly ResolvedPlanDeclaration[];
  readonly selectedSkills: readonly string[];
  readonly selectedTools: readonly SupportedTool[];
  readonly selectedScopes: readonly ('user' | 'project')[];
  readonly selectionOutcome: 'selected' | 'filter-noop';
  readonly replacementLock: PortableLockV1 | null;
}

export interface ObservedPlacementEvidence {
  readonly scope: 'user' | 'project';
  readonly binding: 'standard' | 'custom';
  readonly placement: Placement;
  readonly contentHash: OperationDigest | null;
  readonly ledgerPair: LedgerPairV1Dto | null;
}

export interface ObservedStoreEvidence {
  readonly path: string;
  readonly state: 'absent' | 'present' | 'invalid';
  readonly contentHash: OperationDigest | null;
}

export type ObservedDesiredPlacement =
  | Readonly<{
      readonly state: 'observed';
      readonly row: ResolvedPlanDeclaration;
      readonly binding: 'standard' | 'custom';
      readonly placement: Placement;
      readonly contentHash: OperationDigest | null;
      readonly ledgerPair: LedgerPairV1Dto | null;
      readonly store: Readonly<ObservedStoreEvidence>;
      /** Exact prior ledger-owned store bytes, distinct from the currently desired lock store. */
      readonly ledgerStore: Readonly<ObservedStoreEvidence> | null;
      readonly opposite: Readonly<{
        readonly scope: 'user' | 'project';
        readonly binding: 'standard' | 'custom';
        readonly placement: Placement;
        readonly contentHash: OperationDigest | null;
        readonly ledgerPair: LedgerPairV1Dto;
      }> | null;
    }>
  | Readonly<{
      readonly state: 'refused';
      readonly row: ResolvedPlanDeclaration;
      readonly refusalClass: RefusalClass;
      readonly reasonCode: string;
      readonly path: string | null;
      readonly remediation: string;
      /** Immutable live/ledger facts that caused the refusal, when a resource was observed. */
      readonly evidence: readonly ObservedPlacementEvidence[];
    }>;

export interface ObservedPrunePlacement {
  readonly pin: PortableLockSkillV1;
  readonly tool: SupportedTool;
  readonly scope: 'user' | 'project';
  readonly placement: Placement;
  readonly duplicateReason: string | null;
  readonly contentHash: OperationDigest | null;
  readonly ledgerPair: LedgerPairV1Dto | null;
}

/** A live placement outside desired state, observed for review without implying removal authority. */
export interface ObservedUndeclaredPlacement {
  readonly tool: SupportedTool;
  readonly scope: 'user' | 'project';
  readonly placement: Placement;
  readonly ledgerPair: LedgerPairV1Dto | null;
}

/** Complete immutable environment snapshot consumed by the pure reconciler. */
export interface ObservedReconcileInput {
  readonly resolved: ResolvedPlanInput;
  readonly storeRoot: string;
  readonly desiredPlacements: readonly ObservedDesiredPlacement[];
  readonly undeclaredPlacements: readonly ObservedUndeclaredPlacement[];
  readonly prunePlacements: readonly ObservedPrunePlacement[];
  readonly capabilityPreconditions: readonly CapabilityPreconditionV1[];
}

export interface ReconcilePlanProduct {
  readonly input: ResolvedPlanInput;
  readonly plan: OperationPlan<'plan'>;
  /** Exact immutable observation facts bound by operation precondition IDs. */
  readonly resourcePreconditions: readonly ResourcePreconditionV1[];
  readonly capabilityPreconditions: readonly CapabilityPreconditionV1[];
  /** Live paths whose manifest-selected custom roots must remain machine-bound when saved. */
  readonly machineBoundLivePaths: readonly string[];
}

export interface PlanReconcileError {
  readonly code: string;
  readonly message: string;
  readonly exitClass:
    | 'usage'
    | 'state'
    | 'capability'
    | 'source'
    | 'permission'
    | 'failure'
    | 'cancelled';
}
