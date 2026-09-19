import type { SupportedTool } from '../agents/types.ts';
import type { LockRequest } from '../env/types.ts';
import type {
  BoundedForceEffect,
  CurrentMutatorCommand,
  OperationExecutionResult,
  OperationId,
  OperationImage,
  OperationPlan,
  OperationResourceIdentity,
} from '../planning/types.ts';
import type { LockPort } from '../ports/types.ts';

export interface ValidatedExecutionBinding<ToolId extends string = SupportedTool> {
  readonly operationId: OperationId;
  readonly groupId: OperationId;
  readonly pairId: OperationId | null;
  readonly actualBefore: OperationImage<ToolId>;
  readonly unstartedForce: BoundedForceEffect<ToolId> | null;
  readonly execute: () => Promise<OperationExecutionResult<ToolId>>;
}

/**
 * Coordinator input whose current image is observed only after the mutation lock and all declared
 * preconditions are held. The coordinator alone turns this into a ValidatedExecutionBinding.
 */
export interface PreparedExecutionBinding<ToolId extends string = SupportedTool> {
  readonly operationId: OperationId;
  readonly groupId: OperationId;
  readonly pairId: OperationId | null;
  readonly unstartedForce: BoundedForceEffect<ToolId> | null;
  readonly observeActualBefore: () => Promise<OperationImage<ToolId>>;
  readonly execute: (
    binding: ValidatedExecutionBinding<ToolId>,
  ) => Promise<OperationExecutionResult<ToolId>>;
}

export interface ExecutionScheduleOptions extends LockRequest {}

export type ExecutionLockRank = 'artifact-group' | 'artifact-member' | 'ledger' | 'live';

export interface ExecutionLockDescriptor {
  readonly rank: ExecutionLockRank;
  readonly key: string;
  readonly path: string;
}

export interface ExecutionLockHierarchyOptions extends LockRequest {
  /** Guard against introducing a new lock after operation scheduling has begun. */
  readonly schedulingStarted?: boolean;
}

export interface ExecutionPreconditionInput {
  readonly operationIds: readonly OperationId[];
  readonly resource: OperationResourceIdentity;
  readonly expected: unknown;
  readonly observe: () => Promise<unknown>;
}

export interface ExecutionPrecondition {
  readonly preconditionId: OperationId;
  readonly operationIds: readonly OperationId[];
  readonly resource: OperationResourceIdentity;
  readonly expected: unknown;
  readonly observe: () => Promise<unknown>;
}

export interface ExecutionPreconditionStateError {
  readonly code: 'precondition-state-changed' | 'precondition-observation-failed';
  readonly message: string;
}

export interface ExecutionCoordinatorRequest<ToolId extends string = SupportedTool>
  extends LockRequest {
  readonly plan: OperationPlan<CurrentMutatorCommand, ToolId>;
  readonly bindings: readonly PreparedExecutionBinding<ToolId>[];
  readonly preconditions: readonly ExecutionPrecondition[];
  readonly locks: readonly ExecutionLockDescriptor[];
  readonly lockPort: LockPort;
  /** Runs exactly once under every lock after precondition validation and binding. */
  readonly beforeSchedule?: (
    bindings: readonly ValidatedExecutionBinding<ToolId>[],
  ) => Promise<void>;
}
