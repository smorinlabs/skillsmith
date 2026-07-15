import type { SupportedTool } from '../agents/types.ts';
import type {
  ExecutableOperationKind,
  OperationExecutionOutcome,
  OperationSelectionSource,
  PlanningDiagnosticKind,
} from './vocabulary.ts';

export type OperationId = string;
export type OperationDigest = `sha256:${string}`;
export type CurrentMutatorCommand = 'install' | 'uninstall' | 'dev' | 'promote';
export type OperationScope = 'user' | 'project';

export type OperationLocation =
  | Readonly<{ kind: 'portable'; token: string }>
  | Readonly<{ kind: 'machine-bound'; path: string }>;

export type OperationSource =
  | Readonly<{
      kind: 'portable';
      identity: Readonly<{ host: string; repository: string; path: string | null }>;
      requestedRef: string | null;
      resolvedSha: string;
      sourcePath: string;
      contentHash: OperationDigest;
    }>
  | Readonly<{ kind: 'local-dev'; path: string; contentHash: OperationDigest }>;

export type OperationResourceIdentity =
  | Readonly<{ kind: 'manifest-bytes'; location: OperationLocation }>
  | Readonly<{ kind: 'lock'; location: OperationLocation }>
  | Readonly<{ kind: 'ledger'; projectRoot: OperationLocation | null }>
  | Readonly<{ kind: 'ledger-schema'; projectRoot: OperationLocation | null }>
  | Readonly<{
      kind: 'live';
      skill: string;
      tool: SupportedTool;
      scope: OperationScope;
      projectRoot: OperationLocation | null;
      location: OperationLocation;
    }>
  | Readonly<{ kind: 'store'; contentHash: OperationDigest }>
  | Readonly<{ kind: 'project-context'; root: OperationLocation }>;

export interface OperationManifestSnapshot {
  readonly version: 1;
  readonly defaults: Readonly<{
    readonly tools: readonly SupportedTool[] | null;
    readonly scope: OperationScope | null;
    readonly path: string | null;
  }> | null;
  readonly registry: Readonly<{ readonly default: string | null }> | null;
  readonly skills: readonly Readonly<{
    readonly name: string;
    readonly source: Readonly<{
      readonly host: string;
      readonly repository: string;
      readonly path: string | null;
    }>;
    readonly ref: string | null;
    readonly tools: readonly SupportedTool[];
    readonly scope: OperationScope;
    readonly placement: 'symlink' | 'copy';
    readonly path: string | null;
  }>[];
}

export interface OperationLockSnapshot {
  readonly version: 1;
  readonly hashSchemaVersion: 1;
  readonly manifestHash: OperationDigest;
  readonly skills: readonly Readonly<{
    readonly name: string;
    readonly source: string;
    readonly requestedRef: string | null;
    readonly resolvedSha: string;
    readonly sourcePath: string;
    readonly contentHash: OperationDigest;
  }>[];
}

export type OperationImage =
  | Readonly<{ kind: 'absent'; resource: OperationResourceIdentity }>
  | Readonly<{
      kind: 'placement';
      resource: Extract<OperationResourceIdentity, { kind: 'live' }>;
      classification: 'dev' | 'pinned' | 'store-linked' | 'unmanaged';
      representation: 'symlink' | 'copy' | 'other';
      linkTarget: OperationLocation | null;
      dangling: boolean;
      source: OperationSource | null;
      contentHash: OperationDigest | null;
    }>
  | Readonly<{
      kind: 'manifest';
      location: OperationLocation;
      shape: 'canonical' | 'legacy';
      version: 1;
      byteHash: OperationDigest;
      semanticHash: OperationDigest;
      value: OperationManifestSnapshot;
    }>
  | Readonly<{
      kind: 'lock';
      location: OperationLocation;
      version: 1;
      canonicalHash: OperationDigest;
      value: OperationLockSnapshot;
    }>
  | Readonly<{
      kind: 'ledger';
      projectRoot: OperationLocation | null;
      schemaVersion: 1 | 2;
      byteHash: OperationDigest;
      semanticHash: OperationDigest;
    }>;

export interface OperationDependencyMetadata {
  readonly domain: 'skillsmith.operation-dependency';
  readonly schemaVersion: 1;
  readonly operationIds: readonly OperationId[];
}

export interface OperationReason {
  readonly code: string;
  readonly message: string;
}

export interface MutationFlags {
  readonly live: boolean;
  readonly manifest: boolean;
  readonly lock: boolean;
  readonly ledger: boolean;
}

export type OperationReversibility =
  | Readonly<{ kind: 'none'; retentionResourceIds: readonly [] }>
  | Readonly<{
      kind: 'reversible' | 'conditional';
      retentionResourceIds: readonly [OperationId, ...OperationId[]];
    }>;

export type BoundedConflict =
  | Readonly<{
      class: 'unmanaged-target' | 'modified-managed-target' | 'destination-exists';
      normal: 'refuse';
      forced: 'backup-and-replace';
      target: OperationResourceIdentity;
      backup: 'required';
    }>
  | Readonly<{
      class: 'source-changed';
      normal: 'refuse';
      forced: 'replace';
      target: OperationResourceIdentity;
      backup: 'none';
    }>;

export interface ExecutableOperation {
  readonly operationId: OperationId;
  readonly groupId: OperationId;
  readonly pairId: OperationId | null;
  readonly kind: ExecutableOperationKind;
  readonly dependencyMetadata: OperationDependencyMetadata;
  readonly skill: string | null;
  readonly source: OperationSource | null;
  readonly tool: SupportedTool | null;
  readonly scope: OperationScope | null;
  readonly before: OperationImage;
  readonly after: OperationImage;
  readonly reason: OperationReason;
  readonly selectionSource: OperationSelectionSource;
  readonly preconditionIds: readonly OperationId[];
  readonly requiredCheckIds: readonly OperationId[];
  readonly reversibility: OperationReversibility;
  readonly mutates: MutationFlags;
  readonly conflict: BoundedConflict | null;
}

interface CheckCommon {
  readonly checkId: OperationId;
  readonly blocking: true;
  readonly operationIds: readonly [OperationId, ...OperationId[]];
}

export type PlanCheck =
  | (CheckCommon &
      Readonly<{
        kind: 'source-resolution';
        source: Extract<OperationSource, { kind: 'portable' }>;
      }>)
  | (CheckCommon & Readonly<{ kind: 'capability'; capabilityPreconditionId: OperationId }>)
  | (CheckCommon &
      Readonly<{
        kind: 'content-integrity';
        source: OperationSource;
        expectedContentHash: OperationDigest;
      }>)
  | (CheckCommon &
      Readonly<{
        kind: 'verification';
        tool: SupportedTool;
        mode: 'static' | 'static+deep';
        expectedContentHash: OperationDigest;
      }>)
  | (CheckCommon &
      Readonly<{
        kind: 'precondition-validation';
        preconditionIds: readonly [OperationId, ...OperationId[]];
      }>);

export type RefusalClass = 'usage' | 'state' | 'capability' | 'source' | 'permission';

export interface PlanningDiagnostic {
  readonly diagnosticId: OperationId;
  readonly kind: PlanningDiagnosticKind;
  readonly severity: 'info' | 'warning' | 'error';
  readonly refusalClass: RefusalClass | null;
  readonly affected: Readonly<{
    skill: string | null;
    source: OperationSource | null;
    tool: SupportedTool | null;
    scope: OperationScope | null;
    path: OperationLocation | null;
  }>;
  readonly correlation: Readonly<{
    groupId: OperationId | null;
    pairId: OperationId | null;
    operationId: OperationId | null;
  }>;
  readonly reason: OperationReason;
  readonly selectionSource: OperationSelectionSource;
}

export interface OperationSelection {
  readonly source: OperationSelectionSource;
  readonly outcome?: 'selected' | 'filter-noop';
  readonly targets?: readonly string[];
  readonly all?: boolean;
  readonly skills?: readonly string[];
  readonly tools: readonly SupportedTool[];
  readonly scopes: readonly OperationScope[];
  readonly groupIds?: readonly OperationId[];
}

export interface OperationPlan<Command extends CurrentMutatorCommand = CurrentMutatorCommand> {
  readonly domain: 'skillsmith.operation-plan';
  readonly schemaVersion: 1;
  readonly command: Command;
  readonly selection: OperationSelection;
  readonly batchPolicy: 'fail-fast' | 'continue-on-error';
  readonly operations: readonly ExecutableOperation[];
  readonly checks: readonly PlanCheck[];
  readonly diagnostics: readonly PlanningDiagnostic[];
}

export type CurrentMutatorOperationPlan = OperationPlan<CurrentMutatorCommand>;
export type OperationPlanInput<Command extends CurrentMutatorCommand = CurrentMutatorCommand> =
  OperationPlan<Command>;

export interface SanitizedExecutionError {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

type ReplacementConflictClass = Exclude<BoundedConflict['class'], 'source-changed'>;

export type BoundedForceEffect =
  | Readonly<{
      requested: boolean;
      applied: false;
      conflictType: null;
      target: null;
      normalBehavior: null;
      forcedBehavior: null;
      backup: null;
    }>
  | Readonly<{
      requested: true;
      applied: boolean;
      conflictType: ReplacementConflictClass;
      target: OperationResourceIdentity;
      normalBehavior: 'refuse';
      forcedBehavior: 'backup-and-replace';
      backup: 'required';
    }>
  | Readonly<{
      requested: true;
      applied: boolean;
      conflictType: 'source-changed';
      target: OperationResourceIdentity;
      normalBehavior: 'refuse';
      forcedBehavior: 'replace';
      backup: 'none';
    }>;

export type BoundedForceEffectInput =
  | Readonly<{
      supported: false;
      requested: false;
      applied?: false;
      conflict: null;
    }>
  | Readonly<{
      supported: true;
      requested: boolean;
      applied?: false;
      conflict: null;
    }>
  | Readonly<{
      supported: true;
      requested: true;
      applied?: boolean;
      conflict: BoundedConflict;
    }>;

interface OperationExecutionResultCommon {
  readonly operationId: OperationId;
  readonly actualBefore: OperationImage;
  readonly actualAfter: OperationImage;
  readonly force: BoundedForceEffect | null;
}

export type OperationExecutionResult =
  | (OperationExecutionResultCommon &
      Readonly<{
        outcome: Exclude<OperationExecutionOutcome, 'failed'>;
        error: null;
      }>)
  | (OperationExecutionResultCommon &
      Readonly<{
        outcome: 'failed';
        error: SanitizedExecutionError;
      }>);

export interface OperationExecutionResultInput extends OperationExecutionResultCommon {
  readonly outcome: OperationExecutionOutcome;
  readonly error: SanitizedExecutionError | null;
}

export interface OperationIdentity {
  readonly domain: 'skillsmith.operation-identity';
  readonly schemaVersion: 1;
  readonly groupId: OperationId;
  readonly pairId: OperationId | null;
  readonly kind: ExecutableOperationKind;
  readonly skill: string | null;
  readonly source: OperationSource | null;
  readonly tool: SupportedTool | null;
  readonly scope: OperationScope | null;
}

export interface OperationGroupIdentity {
  readonly domain: 'skillsmith.operation-group-identity';
  readonly schemaVersion: 1;
  readonly command: CurrentMutatorCommand;
  readonly skill: string | null;
  readonly source: OperationSource | null;
  readonly scope: OperationScope | null;
  /** A normalized selector or other stable source fact when a resolved source is unavailable. */
  readonly target: string | null;
}

export interface OperationPairIdentity {
  readonly domain: 'skillsmith.operation-pair-identity';
  readonly schemaVersion: 1;
  readonly groupId: OperationId;
  readonly tool: SupportedTool;
  readonly resource: OperationResourceIdentity;
}

interface PlanCheckIdentityCommon {
  readonly domain: 'skillsmith.plan-check-identity';
  readonly schemaVersion: 1;
  readonly operationIds: readonly [OperationId, ...OperationId[]];
}

export type PlanCheckIdentity =
  | (PlanCheckIdentityCommon &
      Readonly<{
        kind: 'source-resolution';
        source: Extract<OperationSource, { kind: 'portable' }>;
      }>)
  | (PlanCheckIdentityCommon &
      Readonly<{ kind: 'capability'; capabilityPreconditionId: OperationId }>)
  | (PlanCheckIdentityCommon &
      Readonly<{
        kind: 'content-integrity';
        source: OperationSource;
        expectedContentHash: OperationDigest;
      }>)
  | (PlanCheckIdentityCommon &
      Readonly<{
        kind: 'verification';
        tool: SupportedTool;
        mode: 'static' | 'static+deep';
        expectedContentHash: OperationDigest;
      }>)
  | (PlanCheckIdentityCommon &
      Readonly<{
        kind: 'precondition-validation';
        preconditionIds: readonly [OperationId, ...OperationId[]];
      }>);

export interface PlanningDiagnosticIdentity {
  readonly domain: 'skillsmith.planning-diagnostic-identity';
  readonly schemaVersion: 1;
  readonly kind: PlanningDiagnosticKind;
  readonly severity: PlanningDiagnostic['severity'];
  readonly refusalClass: RefusalClass | null;
  readonly affected: PlanningDiagnostic['affected'];
  readonly correlation: PlanningDiagnostic['correlation'];
  readonly reasonCode: string;
  readonly selectionSource: OperationSelectionSource;
}

export type CurrentCompatibilityFamily = 'install' | 'uninstall' | 'flip';

export interface CurrentCompatibilityProjection {
  readonly family: CurrentCompatibilityFamily;
  readonly operation: ExecutableOperation | null;
  readonly diagnostic: PlanningDiagnostic | null;
  readonly result: OperationExecutionResult | null;
}

/** G4 may supply a persistence DTO without coupling this runtime domain to that DTO today. */
export interface OperationPlanPersistenceMapper<TPersistentPlan> {
  readonly toPersistence: (plan: CurrentMutatorOperationPlan) => TPersistentPlan;
}
