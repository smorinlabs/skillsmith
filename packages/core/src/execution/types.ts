import type { LockRequest } from '../env/types.ts';
import type {
  BoundedForceEffect,
  CurrentMutatorOperationPlan,
  OperationExecutionResult,
  OperationId,
  OperationImage,
  OperationResourceIdentity,
} from '../planning/types.ts';
import type { LockPort } from '../ports/types.ts';

export interface ValidatedExecutionBinding {
  readonly operationId: OperationId;
  readonly groupId: OperationId;
  readonly pairId: OperationId;
  readonly actualBefore: OperationImage;
  readonly unstartedForce: BoundedForceEffect | null;
  readonly execute: () => Promise<OperationExecutionResult>;
}

/**
 * Coordinator input whose current image is observed only after the mutation lock and all declared
 * preconditions are held. The coordinator alone turns this into a ValidatedExecutionBinding.
 */
export interface PreparedExecutionBinding {
  readonly operationId: OperationId;
  readonly groupId: OperationId;
  readonly pairId: OperationId;
  readonly unstartedForce: BoundedForceEffect | null;
  readonly observeActualBefore: () => Promise<OperationImage>;
  readonly execute: (binding: ValidatedExecutionBinding) => Promise<OperationExecutionResult>;
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

export interface ExecutionCoordinatorRequest extends LockRequest {
  readonly plan: CurrentMutatorOperationPlan;
  readonly bindings: readonly PreparedExecutionBinding[];
  readonly preconditions: readonly ExecutionPrecondition[];
  readonly locks: readonly ExecutionLockDescriptor[];
  readonly lockPort: LockPort;
}
