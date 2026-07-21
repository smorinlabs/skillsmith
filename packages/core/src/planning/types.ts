import type { SupportedTool } from '../agents/types.ts';
import type {
  ExecutableOperationKind,
  OperationExecutionOutcome,
  OperationSelectionSource,
  PlanningDiagnosticKind,
} from './vocabulary.ts';

export type OperationId = string;
export type OperationDigest = `sha256:${string}`;
export type CurrentMutatorCommand =
  | 'install'
  | 'uninstall'
  | 'dev'
  | 'promote'
  | 'doctor'
  | 'export'
  | 'sync'
  | 'init'
  | 'apply';
export type CurrentPlanningCommand = CurrentMutatorCommand | 'plan';
export type OperationScope = 'user' | 'project';

export interface PlanningToolRegistry<ToolId extends string = SupportedTool> {
  get(id: string): Readonly<{ readonly descriptor: Readonly<{ readonly id: ToolId }> }> | undefined;
}

export interface PlanningToolContext<ToolId extends string = SupportedTool> {
  readonly registry: PlanningToolRegistry<ToolId>;
  readonly toolOrder: readonly ToolId[];
}

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

export type OperationResourceIdentity<ToolId extends string = SupportedTool> =
  | Readonly<{ kind: 'manifest-bytes'; location: OperationLocation }>
  | Readonly<{ kind: 'lock'; location: OperationLocation }>
  | Readonly<{ kind: 'ledger'; projectRoot: OperationLocation | null }>
  | Readonly<{ kind: 'ledger-schema'; projectRoot: OperationLocation | null }>
  | Readonly<{
      kind: 'live';
      skill: string;
      tool: ToolId;
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

export type OperationImage<ToolId extends string = SupportedTool> =
  | Readonly<{ kind: 'absent'; resource: OperationResourceIdentity<ToolId> }>
  | Readonly<{
      kind: 'placement';
      resource: Extract<OperationResourceIdentity<ToolId>, { kind: 'live' }>;
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
      /** Runtime-only init before-image. Persisted saved-plan v1 deliberately excludes it. */
      kind: 'opaque-manifest';
      location: Extract<OperationLocation, { kind: 'machine-bound' }>;
      shape: 'canonical' | 'mixed' | 'empty' | 'malformed' | 'unknown';
      byteHash: OperationDigest;
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

export type BoundedConflict<ToolId extends string = SupportedTool> =
  | Readonly<{
      class: 'unmanaged-target' | 'modified-managed-target' | 'destination-exists';
      normal: 'refuse';
      forced: 'backup-and-replace';
      target: OperationResourceIdentity<ToolId>;
      backup: 'required';
    }>
  | Readonly<{
      class: 'source-changed';
      normal: 'refuse';
      forced: 'replace';
      target: OperationResourceIdentity<ToolId>;
      backup: 'none';
    }>;

export interface ExecutableOperation<ToolId extends string = SupportedTool> {
  readonly operationId: OperationId;
  readonly groupId: OperationId;
  readonly pairId: OperationId | null;
  readonly kind: ExecutableOperationKind;
  readonly dependencyMetadata: OperationDependencyMetadata;
  readonly skill: string | null;
  readonly source: OperationSource | null;
  readonly tool: ToolId | null;
  readonly scope: OperationScope | null;
  readonly before: OperationImage<ToolId>;
  readonly after: OperationImage<ToolId>;
  readonly reason: OperationReason;
  readonly selectionSource: OperationSelectionSource;
  readonly preconditionIds: readonly OperationId[];
  readonly requiredCheckIds: readonly OperationId[];
  readonly reversibility: OperationReversibility;
  readonly mutates: MutationFlags;
  readonly conflict: BoundedConflict<ToolId> | null;
}

interface CheckCommon {
  readonly checkId: OperationId;
  readonly blocking: true;
  readonly operationIds: readonly [OperationId, ...OperationId[]];
}

export type PlanCheck<ToolId extends string = SupportedTool> =
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
        tool: ToolId;
        mode: 'static' | 'static+deep';
        expectedContentHash: OperationDigest;
      }>)
  | (CheckCommon &
      Readonly<{
        kind: 'precondition-validation';
        preconditionIds: readonly [OperationId, ...OperationId[]];
      }>);

export type RefusalClass = 'usage' | 'state' | 'capability' | 'source' | 'permission';

export interface PlanningDiagnostic<ToolId extends string = SupportedTool> {
  readonly diagnosticId: OperationId;
  readonly kind: PlanningDiagnosticKind;
  readonly severity: 'info' | 'warning' | 'error';
  readonly refusalClass: RefusalClass | null;
  readonly affected: Readonly<{
    skill: string | null;
    source: OperationSource | null;
    tool: ToolId | null;
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

export interface OperationSelection<ToolId extends string = SupportedTool> {
  readonly source: OperationSelectionSource;
  readonly outcome?: 'selected' | 'filter-noop';
  readonly targets?: readonly string[];
  readonly all?: boolean;
  readonly skills?: readonly string[];
  readonly tools: readonly ToolId[];
  readonly scopes: readonly OperationScope[];
  readonly groupIds?: readonly OperationId[];
}

export interface OperationPlan<
  Command extends CurrentPlanningCommand = CurrentMutatorCommand,
  ToolId extends string = SupportedTool,
> {
  readonly domain: 'skillsmith.operation-plan';
  readonly schemaVersion: 1;
  readonly command: Command;
  readonly selection: OperationSelection<ToolId>;
  readonly batchPolicy: 'fail-fast' | 'continue-on-error';
  readonly operations: readonly ExecutableOperation<ToolId>[];
  readonly checks: readonly PlanCheck<ToolId>[];
  readonly diagnostics: readonly PlanningDiagnostic<ToolId>[];
}

export type CurrentMutatorOperationPlan = OperationPlan<CurrentMutatorCommand>;
export type OperationPlanInput<
  Command extends CurrentPlanningCommand = CurrentMutatorCommand,
  ToolId extends string = SupportedTool,
> = OperationPlan<Command, ToolId>;

export interface SanitizedExecutionError {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

type ReplacementConflictClass = Exclude<BoundedConflict['class'], 'source-changed'>;

export type BoundedForceEffect<ToolId extends string = SupportedTool> =
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
      target: OperationResourceIdentity<ToolId>;
      normalBehavior: 'refuse';
      forcedBehavior: 'backup-and-replace';
      backup: 'required';
    }>
  | Readonly<{
      requested: true;
      applied: boolean;
      conflictType: 'source-changed';
      target: OperationResourceIdentity<ToolId>;
      normalBehavior: 'refuse';
      forcedBehavior: 'replace';
      backup: 'none';
    }>;

export type BoundedForceEffectInput<ToolId extends string = SupportedTool> =
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
      conflict: BoundedConflict<ToolId>;
    }>;

interface OperationExecutionResultCommon<ToolId extends string = SupportedTool> {
  readonly operationId: OperationId;
  readonly actualBefore: OperationImage<ToolId>;
  readonly actualAfter: OperationImage<ToolId>;
  readonly force: BoundedForceEffect<ToolId> | null;
}

export type OperationExecutionResult<ToolId extends string = SupportedTool> =
  | (OperationExecutionResultCommon<ToolId> &
      Readonly<{
        outcome: Exclude<OperationExecutionOutcome, 'failed'>;
        error: null;
      }>)
  | (OperationExecutionResultCommon<ToolId> &
      Readonly<{
        outcome: 'failed';
        error: SanitizedExecutionError;
      }>);

export interface OperationExecutionResultInput<ToolId extends string = SupportedTool>
  extends OperationExecutionResultCommon<ToolId> {
  readonly outcome: OperationExecutionOutcome;
  readonly error: SanitizedExecutionError | null;
}

export interface OperationIdentity<ToolId extends string = SupportedTool> {
  readonly domain: 'skillsmith.operation-identity';
  readonly schemaVersion: 1;
  readonly groupId: OperationId;
  readonly pairId: OperationId | null;
  readonly kind: ExecutableOperationKind;
  readonly skill: string | null;
  readonly source: OperationSource | null;
  readonly tool: ToolId | null;
  readonly scope: OperationScope | null;
}

export interface OperationGroupIdentity {
  readonly domain: 'skillsmith.operation-group-identity';
  readonly schemaVersion: 1;
  readonly command: CurrentPlanningCommand;
  readonly skill: string | null;
  readonly source: OperationSource | null;
  readonly scope: OperationScope | null;
  /** A normalized selector or other stable source fact when a resolved source is unavailable. */
  readonly target: string | null;
}

export interface OperationPairIdentity<ToolId extends string = SupportedTool> {
  readonly domain: 'skillsmith.operation-pair-identity';
  readonly schemaVersion: 1;
  readonly groupId: OperationId;
  readonly tool: ToolId;
  readonly resource: OperationResourceIdentity<ToolId>;
}

interface PlanCheckIdentityCommon {
  readonly domain: 'skillsmith.plan-check-identity';
  readonly schemaVersion: 1;
  readonly operationIds: readonly [OperationId, ...OperationId[]];
}

export type PlanCheckIdentity<ToolId extends string = SupportedTool> =
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
        tool: ToolId;
        mode: 'static' | 'static+deep';
        expectedContentHash: OperationDigest;
      }>)
  | (PlanCheckIdentityCommon &
      Readonly<{
        kind: 'precondition-validation';
        preconditionIds: readonly [OperationId, ...OperationId[]];
      }>);

export interface PlanningDiagnosticIdentity<ToolId extends string = SupportedTool> {
  readonly domain: 'skillsmith.planning-diagnostic-identity';
  readonly schemaVersion: 1;
  readonly kind: PlanningDiagnosticKind;
  readonly severity: PlanningDiagnostic<ToolId>['severity'];
  readonly refusalClass: RefusalClass | null;
  readonly affected: PlanningDiagnostic<ToolId>['affected'];
  readonly correlation: PlanningDiagnostic<ToolId>['correlation'];
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
