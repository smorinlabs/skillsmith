import type { Placement } from '../agents/placement-shared.ts';
import type { Diagnostic, MutationSummary } from '../application/types.ts';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
  LedgerReadState,
  LegacyPairJournalV1Dto,
} from '../artifacts/ledger-types.ts';
import type { ProjectContext } from '../context/types.ts';
import type {
  ExecutableOperation,
  OperationExecutionResult,
  OperationPlan,
  PlanCheck,
  PlanningDiagnostic,
} from '../planning/types.ts';
import type { Result } from '../result.ts';
import type { SelectionSource, ValidatedSelectionRequest } from '../selection/types.ts';
import type { StatusRetentionEligibility, StatusRetentionRequirement } from '../status/types.ts';

export type UndoTool = 'claude-code' | 'codex';
export type UndoScope = 'user' | 'project';
export type UndoOperationFamily = 'dev' | 'promote' | 'install' | 'uninstall' | 'update';
export type UndoAction = 'abort-pending' | 'reverse-committed';
export type UndoExecutionMode = 'convert-to-rollback' | 'resume-rollback';
export type UndoRecoveryState = 'none' | 'cleanup-pending';
export type UndoPhase = 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
export type UndoPlanOutcome =
  | 'planned'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'not-run'
  | 'already-reversed';

export interface UndoError {
  readonly code: string;
  readonly message: string;
  readonly exitClass:
    | 'failure'
    | 'usage'
    | 'state'
    | 'capability'
    | 'source'
    | 'permission'
    | 'cancelled';
}

export interface UndoRequest {
  readonly targets: readonly string[];
  readonly all: boolean;
  readonly tools: readonly UndoTool[];
  readonly scopes: readonly UndoScope[];
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly continueOnError: boolean;
}

/** Private journal authority retained by the domain and never projected directly to undo@1. */
export type UndoJournalAuthority =
  | Readonly<{
      readonly format: 'logical';
      readonly journal: LogicalJournalV1Dto;
      readonly source: LogicalJournalV1Dto;
    }>
  | Readonly<{
      readonly format: 'legacy-pair';
      readonly journal: LegacyPairJournalV1Dto;
      readonly pair: LedgerPairV1Dto;
    }>;

export interface UndoCandidate {
  readonly name: string;
  readonly sourceGroupId: string;
  readonly tool: UndoTool;
  readonly scope: UndoScope;
  readonly projectIdentity: string | null;
  readonly path: string;
  readonly placement: Placement;
  readonly capabilities: readonly ['undo'];
  readonly exists: true;
  readonly action: UndoAction;
  readonly outcome: 'selected' | 'already-reversed';
  readonly operationFamily: UndoOperationFamily;
  readonly disposition: 'forward' | 'rollback';
  readonly phase: UndoPhase;
  readonly executionMode: UndoExecutionMode;
  /** Private recovery preflight; public undo@1 projects this through one exact diagnostic. */
  readonly recoveryState: UndoRecoveryState;
  readonly before: 'dev' | 'pinned' | 'absent' | 'multi-resource';
  readonly eligibility: StatusRetentionEligibility;
  readonly retention: readonly StatusRetentionRequirement[];
  readonly sourceTransactionId: string;
  readonly activeTransactionId: string;
  readonly sourceOperationId: string | null;
  readonly activeOperationId: string | null;
  readonly parentOperationId: string | null;
  readonly authority: UndoJournalAuthority;
}

export interface UndoObservation {
  readonly request: UndoRequest;
  readonly selection: Readonly<{
    readonly source: SelectionSource;
    readonly outcome: 'selected' | 'filter-noop';
    readonly reason: string | null;
    readonly targets: readonly string[];
    readonly tools: readonly UndoTool[];
    readonly scopes: readonly UndoScope[];
  }>;
  readonly projectContext: ProjectContext;
  readonly ledgerPath: string;
  readonly ledgerState: LedgerReadState;
  readonly ledger: LedgerModel;
  readonly migrationPending: boolean;
  readonly candidates: readonly UndoCandidate[];
}

export interface UndoPlanPair {
  readonly pairId: string;
  readonly tool: UndoTool;
  readonly path: string;
  readonly action: UndoAction;
  readonly operationFamily: UndoOperationFamily;
  readonly disposition: 'rollback';
  readonly phase: UndoPhase;
  readonly executionMode: UndoExecutionMode;
  readonly beforeState: 'dev' | 'pinned' | 'absent';
  readonly eligibility: 'eligible' | 'already-reversed';
  readonly retention: Readonly<{
    readonly required: boolean;
    readonly resourceIds: readonly string[];
  }>;
  readonly sourceTransactionId: string;
  readonly activeTransactionId: string;
  readonly sourceOperationId: string;
  readonly activeOperationId: string;
  readonly parentOperationId: string | null;
  readonly operationIds: readonly string[];
  readonly operations: readonly ExecutableOperation[];
  readonly outcome: UndoPlanOutcome;
  readonly failure: Readonly<{ readonly code: string; readonly message: string }> | null;
}

export interface UndoPlanGroup {
  readonly groupId: string;
  readonly name: string;
  readonly scope: UndoScope;
  readonly pairs: readonly UndoPlanPair[];
  readonly operationIds: readonly string[];
  readonly operations: readonly ExecutableOperation[];
  readonly outcome: UndoPlanOutcome;
  readonly failure: Readonly<{ readonly code: string; readonly message: string }> | null;
}

export interface PreparedUndoPlan {
  readonly observation: UndoObservation;
  readonly plan: OperationPlan<'undo'>;
  readonly groups: readonly UndoPlanGroup[];
  readonly execute: () => Promise<Result<UndoExecutionProduct, UndoError>>;
}

export interface UndoCleanupWarning {
  readonly code: 'undo-cleanup-retained';
  readonly message: string;
}

export interface UndoExecutionProduct {
  readonly results: readonly OperationExecutionResult[];
  readonly warnings: readonly UndoCleanupWarning[];
}

export interface UndoSelectionReport {
  readonly source: 'explicit-targets' | 'explicit-all';
  readonly outcome: 'selected' | 'filter-zero';
  readonly targets: readonly string[];
  readonly all: boolean;
  readonly tools: readonly UndoTool[];
  readonly scopes: readonly UndoScope[];
  readonly groupIds: readonly string[];
  readonly batchPolicy: 'fail-fast' | 'continue-on-error';
}

export interface UndoEffect {
  readonly role: 'ledger' | 'store' | 'live' | 'backup';
  readonly action: string;
  readonly operationId: string | null;
  readonly groupId: string;
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
}

export interface UndoReport {
  readonly kind: 'skillsmith.undo';
  readonly schemaVersion: 1;
  readonly command: 'undo';
  readonly mode: 'dry-run' | 'execute';
  readonly state: 'ready' | 'refused' | 'completed' | 'partial';
  readonly project: Readonly<{
    readonly effectiveCwd: string;
    readonly root: string | null;
    readonly identity: string | null;
  }>;
  readonly approval: Readonly<{
    readonly required: boolean;
    readonly outcome: 'not-required' | 'pending' | 'approved' | 'refused' | 'cancelled';
  }>;
  readonly selection: UndoSelectionReport;
  readonly groups: readonly UndoPlanGroup[];
  readonly operations: readonly ExecutableOperation[];
  readonly checks: readonly PlanCheck[];
  readonly results: readonly OperationExecutionResult[];
  readonly effects: readonly UndoEffect[];
  readonly diagnostics: readonly PlanningDiagnostic[];
  readonly summary: Readonly<{
    readonly selected: number;
    readonly actionable: number;
    readonly alreadyReversed: number;
    readonly planned: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly skipped: number;
    readonly notRun: number;
    readonly effects: number;
    readonly refusals: number;
  }>;
}

export interface UndoPreparedProduct {
  readonly prepared: PreparedUndoPlan;
  readonly report: UndoReport;
}

export interface UndoApplicationComposition {
  readonly diagnostics: readonly Diagnostic[];
  readonly mutation: MutationSummary;
}

export type ValidatedUndoSelection = ValidatedSelectionRequest<UndoTool>;
