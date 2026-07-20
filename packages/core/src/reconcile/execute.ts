import { types as utilTypes } from 'node:util';
import type {
  CapabilityPreconditionV1,
  ResourcePreconditionV1,
  SelectionPreconditionV1,
} from '../artifacts/plan-types.ts';
import { validatePlanExecutionGuardsV1 } from '../artifacts/registry.ts';
import {
  type ObservedExecutionCoordinatorRequest,
  executeOperationPlan,
  executeOperationPlanObserved,
} from '../execution/coordinator.ts';
import { validateExecutionPreconditions } from '../execution/preconditions.ts';
import { validateExecutionPlanShape } from '../execution/scheduler.ts';
import type {
  ExecutionLockDescriptor,
  ExecutionPrecondition,
  PreparedExecutionBinding,
  ValidatedExecutionBinding,
} from '../execution/types.ts';
import type { ObservationBundle } from '../observation/types.ts';
import { runMoveScopeTransaction, runMoveScopeTransactionObserved } from '../place/swap.ts';
import type { SwapRequest } from '../place/types.ts';
import {
  createBoundedForceEffect,
  createOperationExecutionResult,
  createOperationPlan,
} from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  BoundedForceEffectInput,
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
  OperationPlanInput,
  OperationResourceIdentity,
} from '../planning/types.ts';
import type { LockPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';

export type ReconcileExecutionBindingClassV1 =
  | 'placement'
  | 'artifact'
  | 'ledger-migration'
  | 'move-scope';

export type ReconcileExecutionBindingErrorCodeV1 =
  | 'reconcile-execution-plan-invalid'
  | 'reconcile-execution-guards-invalid'
  | 'reconcile-execution-operation-duplicate'
  | 'reconcile-execution-operation-shape'
  | 'reconcile-execution-operation-unsupported'
  | 'reconcile-execution-binding-factory'
  | 'reconcile-execution-binding-missing'
  | 'reconcile-execution-binding-shape'
  | 'reconcile-execution-binding-duplicate'
  | 'reconcile-execution-binding-identity'
  | 'reconcile-execution-stale'
  | 'reconcile-execution-cancelled'
  | 'reconcile-execution-permission'
  | 'reconcile-execution-failed'
  | 'reconcile-execution-cleanup-failed';

export interface ReconcileExecutionBindingErrorV1 {
  readonly code: ReconcileExecutionBindingErrorCodeV1;
  readonly message: string;
  readonly operationId: string | null;
  readonly operationKind: ExecutableOperation['kind'] | null;
  /** Completed scheduler results retained when only attempt-scoped source cleanup failed. */
  readonly results?: readonly OperationExecutionResult[];
}

type ReconcilePlacementOperationV1 = ExecutableOperation &
  Readonly<{ readonly kind: 'install' | 'update' | 'remove' | 'repair' }>;

type ReconcileArtifactOperationV1 = ExecutableOperation &
  Readonly<{ readonly kind: 'write-lock' | 'migrate-project-config' }>;

type ReconcileLedgerMigrationOperationV1 = ExecutableOperation &
  Readonly<{ readonly kind: 'migrate-ledger' }>;

type ReconcileMoveScopeOperationV1 = ExecutableOperation &
  Readonly<{ readonly kind: 'move-scope' }>;

export interface ReconcileExecutionBindingFactoriesV1 {
  readonly placement: (
    operation: ReconcilePlacementOperationV1,
  ) => PreparedExecutionBinding | null | undefined;
  readonly artifact: (
    operation: ReconcileArtifactOperationV1,
  ) => PreparedExecutionBinding | null | undefined;
  readonly ledgerMigration: (
    operation: ReconcileLedgerMigrationOperationV1,
  ) => PreparedExecutionBinding | null | undefined;
  readonly moveScope: (
    operation: ReconcileMoveScopeOperationV1,
  ) => PreparedExecutionBinding | null | undefined;
}

export type ReconcileExecutionGuardV1 =
  | ResourcePreconditionV1
  | SelectionPreconditionV1
  | CapabilityPreconditionV1;

export interface ReconcileExecutionGuardsV1 {
  readonly resourcePreconditions: readonly ResourcePreconditionV1[];
  readonly selectionPreconditions: readonly SelectionPreconditionV1[];
  readonly capabilityPreconditions: readonly CapabilityPreconditionV1[];
}

export interface ReconcileExecutionGuardAuthorityV1 {
  readonly observeResource: (guard: ResourcePreconditionV1, expected: unknown) => Promise<unknown>;
  readonly observeSelection: (
    guard: SelectionPreconditionV1,
    expected: unknown,
  ) => Promise<unknown>;
  readonly observeCapability: (
    guard: CapabilityPreconditionV1,
    expected: unknown,
  ) => Promise<unknown>;
  /** Reads the physical ledger bytes; it must not reuse a cached validation observation. */
  readonly observeLegacyLedgerBytes: (
    operation: ReconcileLedgerMigrationOperationV1,
    guard: ResourcePreconditionV1,
    expected: unknown,
  ) => Promise<unknown>;
  /** Starts a fresh validation pass; cached whole-plan validation must be cleared here. */
  readonly beginValidationCycle?: () => void;
}

export interface ReconcileMoveScopeExecutionAuthorityV1 {
  readonly observeActualBefore: (
    operation: ReconcileMoveScopeOperationV1,
  ) => Promise<OperationImage>;
  /** Creates an under-lock request from the current durable ledger. */
  readonly createRequest: (
    operation: ReconcileMoveScopeOperationV1,
  ) => Promise<SwapRequest> | SwapRequest;
}

export interface ReconcileRuntimeExecutionAuthoritiesV1 {
  readonly placement: Readonly<{
    bind(operation: ReconcilePlacementOperationV1): PreparedExecutionBinding | null | undefined;
  }>;
  readonly artifact: Readonly<{
    bind(operation: ReconcileArtifactOperationV1): PreparedExecutionBinding | null | undefined;
  }>;
  readonly ledgerMigration: Readonly<{
    bind(
      operation: ReconcileLedgerMigrationOperationV1,
    ): PreparedExecutionBinding | null | undefined;
  }>;
  readonly moveScope: Readonly<{
    bind(operation: ReconcileMoveScopeOperationV1): PreparedExecutionBinding | null | undefined;
  }>;
  readonly guards: ReconcileExecutionGuardAuthorityV1;
  readonly lockPort: LockPort;
  readonly locks: readonly ExecutionLockDescriptor[];
  /** Releases acquired source material and other attempt-scoped temporary resources. */
  readonly cleanupSources?: () => Promise<void>;
}

export interface ExecuteValidatedReconcilePlanV1Request {
  readonly plan: OperationPlan<'apply'>;
  readonly guards: ReconcileExecutionGuardsV1;
  readonly authorities: ReconcileRuntimeExecutionAuthoritiesV1;
  readonly signal?: AbortSignal;
  readonly observation?: ObservationBundle;
}

/**
 * Derive the fresh-only scheduler policy before preview and approval.
 *
 * Saved execution never calls this helper: saved schema v1 is unconditionally fail-fast. The
 * exactness check proves this derivation changes only the scheduler policy and cannot replan or
 * alter an operation identity, image, dependency, check, diagnostic, or selection fact.
 */
export const createFreshReconcileExecutionPlanV1 = (
  plan: OperationPlan<'apply'>,
  continueOnError: boolean,
): Result<OperationPlan<'apply'>, ReconcileExecutionBindingErrorV1> => {
  try {
    const snapshot = ownFrozenData(plan as unknown) as OperationPlanInput<'apply'>;
    const canonical = createOperationPlan(snapshot) as OperationPlan<'apply'>;
    if (
      canonical.command !== 'apply' ||
      canonicalPlanningString(canonical) !== canonicalPlanningString(snapshot)
    ) {
      throw new TypeError('fresh execution plan is not an exact canonical apply plan');
    }
    validateExecutionPlanShape(canonical);
    const selectedPolicy = continueOnError ? 'continue-on-error' : 'fail-fast';
    const derived = createOperationPlan({
      ...canonical,
      batchPolicy: selectedPolicy,
    }) as OperationPlan<'apply'>;
    const { batchPolicy: _beforePolicy, ...before } = canonical;
    const { batchPolicy: _afterPolicy, ...after } = derived;
    if (
      derived.batchPolicy !== selectedPolicy ||
      canonicalPlanningString(before) !== canonicalPlanningString(after)
    ) {
      throw new TypeError('fresh execution policy derivation changed approved plan facts');
    }
    return ok(derived);
  } catch {
    return err(
      failure(
        'reconcile-execution-plan-invalid',
        'fresh reconciliation execution plan failed the exact policy contract',
      ),
    );
  }
};

const preparedBindingKeys = Object.freeze([
  'execute',
  'groupId',
  'observeActualBefore',
  'operationId',
  'pairId',
  'unstartedForce',
]);

const placementKinds = new Set<ExecutableOperation['kind']>([
  'install',
  'update',
  'remove',
  'repair',
]);

const artifactKinds = new Set<ExecutableOperation['kind']>([
  'write-lock',
  'migrate-project-config',
]);

const failure = (
  code: ReconcileExecutionBindingErrorCodeV1,
  message: string,
  operation: ExecutableOperation | null = null,
  results?: readonly OperationExecutionResult[],
): ReconcileExecutionBindingErrorV1 =>
  Object.freeze({
    code,
    message,
    operationId: operation?.operationId ?? null,
    operationKind: operation?.kind ?? null,
    ...(results === undefined ? {} : { results: Object.freeze([...results]) }),
  });

const nullPairIdentity = (operation: ExecutableOperation): boolean =>
  operation.pairId === null &&
  operation.skill === null &&
  operation.source === null &&
  operation.tool === null &&
  operation.scope === null;

const classify = (
  operation: ExecutableOperation,
): Result<ReconcileExecutionBindingClassV1, ReconcileExecutionBindingErrorV1> => {
  if (operation.kind === 'move-scope') {
    if (
      operation.pairId === null ||
      operation.skill === null ||
      operation.source === null ||
      operation.tool === null ||
      operation.scope === null ||
      operation.before.kind !== 'placement' ||
      operation.after.kind !== 'placement' ||
      operation.before.resource.scope === operation.after.resource.scope ||
      operation.scope !== operation.after.resource.scope ||
      operation.tool !== operation.before.resource.tool ||
      operation.tool !== operation.after.resource.tool ||
      operation.skill !== operation.before.resource.skill ||
      operation.skill !== operation.after.resource.skill
    ) {
      return err(
        failure(
          'reconcile-execution-operation-shape',
          `move-scope operation ${operation.operationId} has an invalid execution identity`,
          operation,
        ),
      );
    }
    return ok('move-scope');
  }
  if (placementKinds.has(operation.kind)) {
    if (
      operation.pairId === null ||
      operation.skill === null ||
      operation.source === null ||
      operation.tool === null ||
      operation.scope === null
    ) {
      return err(
        failure(
          'reconcile-execution-operation-shape',
          `placement operation ${operation.operationId} has an invalid execution identity`,
          operation,
        ),
      );
    }
    return ok('placement');
  }
  if (artifactKinds.has(operation.kind)) {
    return nullPairIdentity(operation)
      ? ok('artifact')
      : err(
          failure(
            'reconcile-execution-operation-shape',
            `artifact operation ${operation.operationId} has an invalid execution identity`,
            operation,
          ),
        );
  }
  if (operation.kind === 'migrate-ledger') {
    return nullPairIdentity(operation)
      ? ok('ledger-migration')
      : err(
          failure(
            'reconcile-execution-operation-shape',
            `ledger migration ${operation.operationId} has an invalid execution identity`,
            operation,
          ),
        );
  }
  return err(
    failure(
      'reconcile-execution-operation-unsupported',
      `operation kind '${operation.kind}' is not supported by reconciliation executor v1`,
      operation,
    ),
  );
};

const exactBindingShape = (value: object): boolean => {
  const keys = Object.keys(value).sort();
  return (
    keys.length === preparedBindingKeys.length &&
    keys.every((key, index) => key === preparedBindingKeys[index])
  );
};

const ownedErrorCode = (error: unknown): string | null => {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
};

const exactDataKeys = (value: object, keys: readonly string[]): boolean => {
  if (
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]) &&
    keys.every((key) => {
      const descriptor = descriptors[key];
      return descriptor?.enumerable === true && 'value' in descriptor;
    })
  );
};

const dataValue = (owner: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError('reconciliation execution authority property is invalid');
  }
  return descriptor.value;
};

const dataFunction = (owner: object, key: string): ((...args: never[]) => unknown) => {
  const value = dataValue(owner, key);
  if (typeof value !== 'function' || utilTypes.isProxy(value)) {
    throw new TypeError('reconciliation execution authority function is invalid');
  }
  return value as (...args: never[]) => unknown;
};

const ownFrozenData = <Value>(value: Value, ancestors = new Set<object>()): Value => {
  if (value === null || typeof value !== 'object') return value;
  if (utilTypes.isProxy(value) || ancestors.has(value)) {
    throw new TypeError('prepared binding data is not ownable');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const indexes = Object.keys(descriptors).filter((key) => key !== 'length');
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length > 0 ||
        indexes.length !== value.length ||
        indexes.some((key, index) => {
          const descriptor = descriptors[key];
          return (
            key !== String(index) ||
            descriptor === undefined ||
            !descriptor.enumerable ||
            !('value' in descriptor)
          );
        })
      ) {
        throw new TypeError('prepared binding array data is invalid');
      }
      return Object.freeze(
        indexes.map((key) => {
          const descriptor = descriptors[key];
          if (descriptor === undefined || !('value' in descriptor)) {
            throw new TypeError('prepared binding array data is invalid');
          }
          return ownFrozenData(descriptor.value, ancestors);
        }),
      ) as Value;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new TypeError('prepared binding object data is invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('prepared binding object data is invalid');
      }
      output[key] = ownFrozenData(descriptor.value, ancestors);
    }
    return Object.freeze(output) as Value;
  } finally {
    ancestors.delete(value);
  }
};

const ownUnstartedForce = (value: unknown): PreparedExecutionBinding['unstartedForce'] => {
  if (value === null) return null;
  const owned = ownFrozenData(value);
  if (owned === null || typeof owned !== 'object' || Array.isArray(owned)) {
    throw new TypeError('prepared binding force data is invalid');
  }
  const force = owned as Readonly<Record<string, unknown>>;
  const input =
    force.requested === false
      ? { supported: false, requested: false, conflict: null }
      : {
          supported: true,
          requested: true,
          applied: false,
          conflict: {
            class: force.conflictType,
            target: force.target,
            normal: force.normalBehavior,
            forced: force.forcedBehavior,
            backup: force.backup,
          },
        };
  const canonical = createBoundedForceEffect(input as BoundedForceEffectInput);
  if (canonicalPlanningString(canonical) !== canonicalPlanningString(owned)) {
    throw new TypeError('prepared binding force data is not canonical');
  }
  return canonical;
};

const validateBinding = (
  operation: ExecutableOperation,
  candidate: PreparedExecutionBinding | null | undefined,
  boundOperationIds: Set<string>,
): Result<PreparedExecutionBinding, ReconcileExecutionBindingErrorV1> => {
  if (candidate === null || candidate === undefined) {
    return err(
      failure(
        'reconcile-execution-binding-missing',
        `operation ${operation.operationId} has no execution binding`,
        operation,
      ),
    );
  }
  if (
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    utilTypes.isProxy(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    Object.getOwnPropertySymbols(candidate).length > 0 ||
    !exactBindingShape(candidate)
  ) {
    return err(
      failure(
        'reconcile-execution-binding-shape',
        `operation ${operation.operationId} returned an invalid binding shape`,
        operation,
      ),
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  if (
    preparedBindingKeys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !('value' in descriptor);
    })
  ) {
    return err(
      failure(
        'reconcile-execution-binding-shape',
        `operation ${operation.operationId} returned an invalid binding shape`,
        operation,
      ),
    );
  }
  const valueFor = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('prepared binding property is not readable data');
    }
    return descriptor.value;
  };
  const operationId = valueFor('operationId');
  const groupId = valueFor('groupId');
  const pairId = valueFor('pairId');
  const observeActualBefore = valueFor('observeActualBefore');
  const execute = valueFor('execute');
  const unstartedForce = ownUnstartedForce(valueFor('unstartedForce'));
  if (
    typeof observeActualBefore !== 'function' ||
    utilTypes.isProxy(observeActualBefore) ||
    typeof execute !== 'function' ||
    utilTypes.isProxy(execute) ||
    unstartedForce?.applied === true
  ) {
    return err(
      failure(
        'reconcile-execution-binding-shape',
        `operation ${operation.operationId} returned an invalid prepared binding`,
        operation,
      ),
    );
  }
  if (typeof operationId !== 'string') {
    return err(
      failure(
        'reconcile-execution-binding-shape',
        `operation ${operation.operationId} returned an invalid prepared binding`,
        operation,
      ),
    );
  }
  if (boundOperationIds.has(operationId)) {
    return err(
      failure(
        'reconcile-execution-binding-duplicate',
        `operation ${operation.operationId} returned a duplicate execution binding`,
        operation,
      ),
    );
  }
  if (
    operationId !== operation.operationId ||
    groupId !== operation.groupId ||
    pairId !== operation.pairId
  ) {
    return err(
      failure(
        'reconcile-execution-binding-identity',
        `operation ${operation.operationId} returned a mismatched execution binding`,
        operation,
      ),
    );
  }
  const observedExecute = execute as (
    binding: ValidatedExecutionBinding,
    observation?: ObservationBundle,
  ) => Promise<OperationExecutionResult>;
  const owned = Object.freeze({
    operationId,
    groupId: groupId as string,
    pairId: pairId as string | null,
    unstartedForce,
    observeActualBefore: () =>
      (observeActualBefore as PreparedExecutionBinding['observeActualBefore'])(),
    execute: (binding: ValidatedExecutionBinding, observation?: ObservationBundle) =>
      observedExecute(binding, observation),
  });
  boundOperationIds.add(operationId);
  return ok(owned);
};

/**
 * Classify and bind one already-approved reconciliation plan without replanning or executing it.
 *
 * Physical authorities are injected through four closed factories. The returned binding vector
 * has exact one-to-one coverage and the same order as the approved operation vector, ready for the
 * shared coordinator. Cross-root movement is a distinct factory so it cannot be decomposed into
 * two independently durable placement operations.
 */
export const createReconcileExecutionBindingsV1 = (
  plan: OperationPlan<'apply'>,
  factories: ReconcileExecutionBindingFactoriesV1,
): Result<readonly PreparedExecutionBinding[], ReconcileExecutionBindingErrorV1> => {
  let ownedPlan: OperationPlan<'apply'>;
  try {
    const snapshot = ownFrozenData(plan as unknown) as OperationPlanInput<'apply'>;
    if (!Array.isArray(snapshot.operations)) {
      throw new TypeError('reconciliation execution plan has an invalid operation vector');
    }
    const operationIds = new Set<string>();
    for (const candidate of snapshot.operations as readonly unknown[]) {
      if (
        candidate !== null &&
        typeof candidate === 'object' &&
        'operationId' in candidate &&
        typeof candidate.operationId === 'string'
      ) {
        if (operationIds.has(candidate.operationId)) {
          return err(
            failure(
              'reconcile-execution-operation-duplicate',
              'reconciliation plan repeats an operation identity',
            ),
          );
        }
        operationIds.add(candidate.operationId);
      }
    }
    const canonical = createOperationPlan(snapshot);
    if (
      canonical.command !== 'apply' ||
      canonicalPlanningString(canonical) !== canonicalPlanningString(snapshot)
    ) {
      throw new TypeError('reconciliation execution requires an exact canonical apply plan');
    }
    validateExecutionPlanShape(canonical);
    ownedPlan = canonical as OperationPlan<'apply'>;
  } catch {
    return err(
      failure(
        'reconcile-execution-plan-invalid',
        'reconciliation execution plan failed the exact apply-plan contract',
      ),
    );
  }

  const classifiedOperations: Array<
    Readonly<{
      operation: ExecutableOperation;
      bindingClass: ReconcileExecutionBindingClassV1;
    }>
  > = [];
  for (const operation of ownedPlan.operations) {
    const classified = classify(operation);
    if (!classified.ok) return classified;
    classifiedOperations.push(Object.freeze({ operation, bindingClass: classified.value }));
  }

  const bindings: PreparedExecutionBinding[] = [];
  const boundOperationIds = new Set<string>();
  for (const { operation, bindingClass } of classifiedOperations) {
    let candidate: PreparedExecutionBinding | null | undefined;
    try {
      if (bindingClass === 'placement') {
        candidate = factories.placement(operation as ReconcilePlacementOperationV1);
      } else if (bindingClass === 'artifact') {
        candidate = factories.artifact(operation as ReconcileArtifactOperationV1);
      } else if (bindingClass === 'ledger-migration') {
        candidate = factories.ledgerMigration(operation as ReconcileLedgerMigrationOperationV1);
      } else {
        candidate = factories.moveScope(operation as ReconcileMoveScopeOperationV1);
      }
    } catch {
      return err(
        failure(
          'reconcile-execution-binding-factory',
          `operation ${operation.operationId} binding factory failed`,
          operation,
        ),
      );
    }
    let bound: Result<PreparedExecutionBinding, ReconcileExecutionBindingErrorV1>;
    try {
      bound = validateBinding(operation, candidate, boundOperationIds);
    } catch {
      return err(
        failure(
          'reconcile-execution-binding-shape',
          `operation ${operation.operationId} returned an unreadable binding`,
          operation,
        ),
      );
    }
    if (!bound.ok) return bound;
    bindings.push(bound.value);
  }
  if (bindings.length !== ownedPlan.operations.length) {
    return err(
      failure(
        'reconcile-execution-binding-missing',
        'reconciliation execution binding coverage is incomplete',
      ),
    );
  }
  return ok(Object.freeze(bindings));
};

const imageResource = (image: OperationImage): OperationResourceIdentity => {
  if (image.kind === 'absent' || image.kind === 'placement') return image.resource;
  if (image.kind === 'manifest' || image.kind === 'opaque-manifest') {
    return { kind: 'manifest-bytes', location: image.location };
  }
  if (image.kind === 'lock') return { kind: 'lock', location: image.location };
  return { kind: 'ledger', projectRoot: image.projectRoot };
};

const hasPortableLocation = (resource: ResourcePreconditionV1['resource']): boolean => {
  if (resource.kind === 'manifest-bytes' || resource.kind === 'lock') {
    return resource.location.kind !== 'machine-bound';
  }
  if (resource.kind === 'ledger' || resource.kind === 'ledger-schema') {
    return resource.projectRoot !== null && resource.projectRoot.kind !== 'machine-bound';
  }
  if (resource.kind === 'live') {
    return (
      resource.location.kind !== 'machine-bound' ||
      (resource.projectRoot !== null && resource.projectRoot.kind !== 'machine-bound')
    );
  }
  if (resource.kind === 'project-context') return resource.root.kind !== 'machine-bound';
  return false;
};

const resourceGuardExpected = (guard: ResourcePreconditionV1): unknown =>
  Object.freeze({
    expectedState: guard.expectedState,
    expectedHash: guard.expectedHash,
    expectedRevision: guard.expectedRevision,
  });

const selectionGuardExpected = (guard: SelectionPreconditionV1): unknown => {
  const { preconditionId: _preconditionId, ...expected } = guard;
  return Object.freeze(expected);
};

const capabilityGuardExpected = (guard: CapabilityPreconditionV1): unknown => {
  const { preconditionId: _preconditionId, ...expected } = guard;
  return Object.freeze(expected);
};

const sameLocation = (
  left:
    | { readonly kind: 'machine-bound'; readonly path: string }
    | { readonly kind: 'portable'; readonly token: string }
    | null,
  right:
    | { readonly kind: 'machine-bound'; readonly path: string }
    | { readonly kind: 'portable'; readonly token: string }
    | null,
): boolean => canonicalPlanningString(left) === canonicalPlanningString(right);

const exactLedgerByteGuard = (
  operation: ReconcileLedgerMigrationOperationV1,
  guard: ResourcePreconditionV1,
  kind: 'ledger' | 'ledger-schema',
): boolean =>
  operation.before.kind === 'ledger' &&
  guard.resource.kind === kind &&
  sameLocation(guard.resource.projectRoot, operation.before.projectRoot) &&
  guard.expectedState === 'present' &&
  guard.expectedHash.domain === 'resource' &&
  guard.expectedHash.hashSchemaVersion === 1 &&
  guard.expectedHash.digest === operation.before.byteHash &&
  guard.expectedRevision?.kind === 'artifact-bytes' &&
  guard.expectedRevision.digest === operation.before.byteHash;

const resourceGuardKeys = Object.freeze([
  'expectedHash',
  'expectedRevision',
  'expectedState',
  'preconditionId',
  'resource',
]);
const selectionGuardKeys = Object.freeze([
  'domain',
  'expectedHash',
  'hashSchemaVersion',
  'members',
  'preconditionId',
  'scopes',
  'selectionSource',
  'skills',
  'tools',
]);
const capabilityGuardKeys = Object.freeze([
  'capabilityVersion',
  'domain',
  'expectedHash',
  'hashSchemaVersion',
  'operation',
  'preconditionId',
  'scopes',
  'supported',
  'tool',
]);

const exactGuardShape = (guard: ReconcileExecutionGuardV1): boolean => {
  if (!/^precondition:v1:[0-9a-f]{64}$/u.test(guard.preconditionId)) return false;
  if ('resource' in guard) {
    return (
      exactDataKeys(guard, resourceGuardKeys) &&
      (guard.expectedState === 'absent' || guard.expectedState === 'present') &&
      exactDataKeys(guard.expectedHash, ['digest', 'domain', 'hashSchemaVersion']) &&
      guard.expectedHash.hashSchemaVersion === 1 &&
      /^sha256:[0-9a-f]{64}$/u.test(guard.expectedHash.digest) &&
      (guard.expectedRevision === null ||
        (exactDataKeys(guard.expectedRevision, ['digest', 'kind']) &&
          (guard.expectedRevision.kind === 'artifact-bytes' ||
            guard.expectedRevision.kind === 'resource') &&
          /^sha256:[0-9a-f]{64}$/u.test(guard.expectedRevision.digest)))
    );
  }
  if (guard.domain === 'selection-set') {
    return (
      exactDataKeys(guard, selectionGuardKeys) &&
      guard.hashSchemaVersion === 1 &&
      /^sha256:[0-9a-f]{64}$/u.test(guard.expectedHash)
    );
  }
  return (
    guard.domain === 'capability' &&
    exactDataKeys(guard, capabilityGuardKeys) &&
    guard.hashSchemaVersion === 1 &&
    guard.supported === true &&
    Number.isSafeInteger(guard.capabilityVersion) &&
    guard.capabilityVersion >= 1 &&
    /^sha256:[0-9a-f]{64}$/u.test(guard.expectedHash)
  );
};

const guardExpectedFactMatchesBefore = (
  guard: ResourcePreconditionV1,
  before: OperationImage,
): boolean => {
  if (before.kind === 'absent') {
    return guard.expectedState === 'absent' && guard.expectedRevision === null;
  }
  if (guard.expectedState !== 'present') return false;
  if (before.kind === 'placement') {
    return (
      guard.expectedHash.domain === 'resource' &&
      guard.expectedRevision?.kind === 'resource' &&
      guard.expectedRevision.digest === guard.expectedHash.digest
    );
  }
  if (before.kind === 'manifest') {
    return (
      (guard.expectedHash.domain === 'manifest-bytes' &&
        guard.expectedHash.digest === before.byteHash) ||
      (guard.expectedHash.domain === 'manifest-semantic' &&
        guard.expectedHash.digest === before.semanticHash)
    );
  }
  if (before.kind === 'opaque-manifest') {
    return (
      guard.expectedHash.domain === 'manifest-bytes' &&
      guard.expectedHash.digest === before.byteHash
    );
  }
  if (before.kind === 'lock') {
    return (
      guard.expectedHash.domain === 'lock-canonical' &&
      guard.expectedHash.digest === before.canonicalHash
    );
  }
  return (
    guard.expectedHash.domain === 'resource' &&
    guard.expectedHash.digest === before.byteHash &&
    guard.expectedRevision?.kind === 'artifact-bytes' &&
    guard.expectedRevision.digest === before.byteHash
  );
};

/**
 * Convert the validated saved/fresh guard graph into the coordinator's exact observer registry.
 *
 * A legacy v1 saved plan may contain only the signed `ledger-schema` byte guard for a
 * `migrate-ledger` operation. In that one shape, the returned execution precondition retains the
 * signed ID, expected byte fact, and inverse operation coverage but routes its resource to the
 * physical ledger and requires the dedicated real-byte observer. New projections contain an
 * additive physical-ledger guard and never take this compatibility path.
 */
export const createReconcileExecutionPreconditionsV1 = (
  plan: OperationPlan<'apply'>,
  guards: ReconcileExecutionGuardsV1,
  authority: ReconcileExecutionGuardAuthorityV1,
): Result<readonly ExecutionPrecondition[], ReconcileExecutionBindingErrorV1> => {
  try {
    const planSnapshot = ownFrozenData(plan as unknown) as OperationPlanInput<'apply'>;
    const ownedPlan = createOperationPlan(planSnapshot) as OperationPlan<'apply'>;
    if (
      ownedPlan.command !== 'apply' ||
      canonicalPlanningString(ownedPlan) !== canonicalPlanningString(planSnapshot)
    ) {
      throw new TypeError('reconciliation execution guard plan is not exact');
    }
    validateExecutionPlanShape(ownedPlan);
    const decodedGuards = validatePlanExecutionGuardsV1(guards);
    if (!decodedGuards.ok) throw new TypeError('reconciliation execution guard graph is invalid');
    const ownedGuards = decodedGuards.value;
    const allGuards: ReconcileExecutionGuardV1[] = [
      ...ownedGuards.resourcePreconditions,
      ...ownedGuards.selectionPreconditions,
      ...ownedGuards.capabilityPreconditions,
    ];
    const byId = new Map<string, ReconcileExecutionGuardV1>();
    for (const guard of allGuards) {
      if (
        guard === null ||
        typeof guard !== 'object' ||
        typeof guard.preconditionId !== 'string' ||
        !exactGuardShape(guard) ||
        byId.has(guard.preconditionId)
      ) {
        throw new TypeError('reconciliation execution guard identity is invalid');
      }
      byId.set(guard.preconditionId, guard);
    }

    const operationById = new Map(
      ownedPlan.operations.map((operation) => [operation.operationId, operation]),
    );
    const operationIdsByGuard = new Map<string, string[]>();
    for (const operation of ownedPlan.operations) {
      for (const preconditionId of operation.preconditionIds) {
        if (!byId.has(preconditionId)) {
          throw new TypeError('reconciliation operation guard coverage is incomplete');
        }
        const covered = operationIdsByGuard.get(preconditionId) ?? [];
        if (covered.includes(operation.operationId)) {
          throw new TypeError('reconciliation operation guard coverage is duplicated');
        }
        covered.push(operation.operationId);
        operationIdsByGuard.set(preconditionId, covered);
      }
    }
    const unreferencedGuards = allGuards.filter(
      ({ preconditionId }) => (operationIdsByGuard.get(preconditionId)?.length ?? 0) === 0,
    );
    if (unreferencedGuards.length > 0) {
      throw new TypeError('reconciliation execution registry contains an unreferenced guard');
    }

    const legacyAliasIds = new Set<string>();
    for (const operation of ownedPlan.operations) {
      if (operation.kind !== 'migrate-ledger') continue;
      const migration = operation as ReconcileLedgerMigrationOperationV1;
      const referenced = operation.preconditionIds.flatMap((preconditionId) => {
        const guard = byId.get(preconditionId);
        return guard !== undefined && 'resource' in guard && guard.resource !== undefined
          ? [guard as ResourcePreconditionV1]
          : [];
      });
      if (referenced.some((guard) => exactLedgerByteGuard(migration, guard, 'ledger'))) {
        continue;
      }
      const schemas = referenced.filter((guard) =>
        exactLedgerByteGuard(migration, guard, 'ledger-schema'),
      );
      const schema = schemas[0];
      if (
        schemas.length !== 1 ||
        schema === undefined ||
        operationIdsByGuard.get(schema.preconditionId)?.length !== 1
      ) {
        throw new TypeError('legacy ledger execution alias is ambiguous or incomplete');
      }
      legacyAliasIds.add(schema.preconditionId);
    }

    for (const operation of ownedPlan.operations) {
      const expectedResource = imageResource(operation.before);
      const referencedResourceGuards = operation.preconditionIds.flatMap((preconditionId) => {
        const guard = byId.get(preconditionId);
        return guard !== undefined && 'resource' in guard ? [guard as ResourcePreconditionV1] : [];
      });
      const hasExactResource = referencedResourceGuards.some(
        (guard) =>
          canonicalPlanningString(guard.resource) === canonicalPlanningString(expectedResource) &&
          guardExpectedFactMatchesBefore(guard, operation.before),
      );
      const hasExactLegacyAlias =
        operation.kind === 'migrate-ledger' &&
        referencedResourceGuards.some(({ preconditionId }) => legacyAliasIds.has(preconditionId));
      if (!hasExactResource && !hasExactLegacyAlias) {
        throw new TypeError('operation lacks an exact same-resource execution guard');
      }
    }

    const observeResource = authority.observeResource;
    const observeSelection = authority.observeSelection;
    const observeCapability = authority.observeCapability;
    const observeLegacyLedgerBytes = authority.observeLegacyLedgerBytes;
    if (
      typeof observeResource !== 'function' ||
      typeof observeSelection !== 'function' ||
      typeof observeCapability !== 'function' ||
      typeof observeLegacyLedgerBytes !== 'function'
    ) {
      throw new TypeError('reconciliation execution guard authority is incomplete');
    }

    const registry = allGuards.map((guard): ExecutionPrecondition => {
      const operationIds = Object.freeze(
        [...(operationIdsByGuard.get(guard.preconditionId) ?? [])].sort(),
      );
      const firstOperation = operationById.get(operationIds[0] ?? '');
      if (firstOperation === undefined) {
        throw new TypeError('reconciliation execution guard has no routed operation');
      }
      if ('resource' in guard) {
        if (hasPortableLocation(guard.resource)) {
          throw new TypeError('reconciliation execution guard retains a portable location');
        }
        const expected = ownFrozenData(resourceGuardExpected(guard));
        const legacyAlias = legacyAliasIds.has(guard.preconditionId);
        const resource = legacyAlias
          ? Object.freeze({
              kind: 'ledger' as const,
              projectRoot:
                guard.resource.kind === 'ledger-schema' ? guard.resource.projectRoot : null,
            })
          : guard.resource;
        return Object.freeze({
          preconditionId: guard.preconditionId,
          operationIds,
          resource: resource as ExecutionPrecondition['resource'],
          expected,
          observe: legacyAlias
            ? () =>
                observeLegacyLedgerBytes(
                  firstOperation as ReconcileLedgerMigrationOperationV1,
                  guard,
                  expected,
                )
            : () => observeResource(guard, expected),
        });
      }
      const selection = guard.domain === 'selection-set';
      const expected = ownFrozenData(
        selection
          ? selectionGuardExpected(guard as SelectionPreconditionV1)
          : capabilityGuardExpected(guard as CapabilityPreconditionV1),
      );
      return Object.freeze({
        preconditionId: guard.preconditionId,
        operationIds,
        resource: imageResource(firstOperation.before),
        expected,
        observe: selection
          ? () => observeSelection(guard as SelectionPreconditionV1, expected)
          : () => observeCapability(guard as CapabilityPreconditionV1, expected),
      });
    });
    return ok(Object.freeze(registry));
  } catch {
    return err(
      failure(
        'reconcile-execution-guards-invalid',
        'reconciliation execution guards failed the exact inverse-coverage contract',
      ),
    );
  }
};

const moveScopeExecutionResult = (
  operation: ReconcileMoveScopeOperationV1,
  binding: ValidatedExecutionBinding,
  result: Awaited<ReturnType<typeof runMoveScopeTransaction>> | null,
  cancelled: boolean,
  permissionDenied: boolean,
  committedAfterFailure: boolean,
): OperationExecutionResult => {
  if (cancelled && !committedAfterFailure) {
    return createOperationExecutionResult({
      operationId: operation.operationId,
      outcome: 'cancelled',
      actualBefore: binding.actualBefore,
      actualAfter: binding.actualBefore,
      force: null,
      error: null,
    });
  }
  if (result?.ok === true && result.value.committed) {
    return createOperationExecutionResult({
      operationId: operation.operationId,
      outcome: 'succeeded',
      actualBefore: binding.actualBefore,
      actualAfter: operation.after,
      force: null,
      error: null,
    });
  }
  if (committedAfterFailure) {
    return createOperationExecutionResult({
      operationId: operation.operationId,
      outcome: 'failed',
      actualBefore: binding.actualBefore,
      actualAfter: operation.after,
      force: null,
      error: {
        code: permissionDenied ? 'permission-denied' : 'reconcile-move-scope-cleanup-failed',
        message: 'cross-scope placement committed but post-commit cleanup did not complete',
        remediation: 'Re-run apply so recovery can reclaim the retained transaction residue.',
      },
    });
  }
  return createOperationExecutionResult({
    operationId: operation.operationId,
    outcome: 'failed',
    actualBefore: binding.actualBefore,
    actualAfter: binding.actualBefore,
    force: null,
    error: {
      code: permissionDenied ? 'permission-denied' : 'reconcile-move-scope-failed',
      message: 'cross-scope placement transaction did not reach a committed state',
      remediation: 'Re-run apply to resume or safely recover the reviewed operation.',
    },
  });
};

const committedMoveScopeTransactionIds = (
  operation: ReconcileMoveScopeOperationV1,
  ledger: SwapRequest['state']['ledger'],
): ReadonlySet<string> =>
  new Set(
    ledger.history.flatMap((journal) =>
      journal.intent.operationId === operation.operationId &&
      journal.intent.kind === 'move-scope' &&
      journal.disposition === 'forward' &&
      journal.phase === 'committed' &&
      !Object.hasOwn(ledger.transactions, journal.transactionId)
        ? [journal.transactionId]
        : [],
    ),
  );

export const createReconcileMoveScopeExecutionBindingV1 = (
  operation: ReconcileMoveScopeOperationV1,
  authority: ReconcileMoveScopeExecutionAuthorityV1,
): PreparedExecutionBinding => {
  const observeActualBefore = authority.observeActualBefore;
  const createRequest = authority.createRequest;
  if (typeof observeActualBefore !== 'function' || typeof createRequest !== 'function') {
    throw new TypeError('reconciliation move-scope authority is incomplete');
  }
  return Object.freeze({
    operationId: operation.operationId,
    groupId: operation.groupId,
    pairId: operation.pairId,
    unstartedForce: null,
    observeActualBefore: () => observeActualBefore(operation),
    execute: async (
      binding: ValidatedExecutionBinding,
      observation?: ObservationBundle,
    ): Promise<OperationExecutionResult> => {
      if (
        binding.operationId !== operation.operationId ||
        binding.groupId !== operation.groupId ||
        binding.pairId !== operation.pairId ||
        binding.unstartedForce !== null ||
        canonicalPlanningString(binding.actualBefore) !== canonicalPlanningString(operation.before)
      ) {
        throw new TypeError('validated move-scope binding is mismatched');
      }
      try {
        const request = await createRequest(operation);
        const committedBefore = committedMoveScopeTransactionIds(operation, request.state.ledger);
        const executed =
          observation === undefined
            ? await runMoveScopeTransaction(request, operation)
            : await runMoveScopeTransactionObserved(request, operation, observation);
        const code = executed.ok ? null : executed.error.code;
        const committedAfterFailure =
          !executed.ok &&
          [...committedMoveScopeTransactionIds(operation, executed.state.ledger)].some(
            (transactionId) => !committedBefore.has(transactionId),
          );
        return moveScopeExecutionResult(
          operation,
          binding,
          executed,
          code === 'cancelled',
          code === 'permission-denied',
          committedAfterFailure,
        );
      } catch (error) {
        const code = ownedErrorCode(error);
        return moveScopeExecutionResult(
          operation,
          binding,
          null,
          code === 'cancelled',
          code === 'permission' ||
            code === 'permission-denied' ||
            code === 'EACCES' ||
            code === 'EPERM',
          false,
        );
      }
    },
  });
};

type OwnedRuntimeAuthoritiesV1 = Readonly<{
  placement: ReconcileRuntimeExecutionAuthoritiesV1['placement'];
  artifact: ReconcileRuntimeExecutionAuthoritiesV1['artifact'];
  ledgerMigration: ReconcileRuntimeExecutionAuthoritiesV1['ledgerMigration'];
  moveScope: ReconcileRuntimeExecutionAuthoritiesV1['moveScope'];
  guards: ReconcileExecutionGuardAuthorityV1;
  lockPort: LockPort;
  locks: readonly ExecutionLockDescriptor[];
  cleanupSources: (() => Promise<void>) | undefined;
}>;

const snapshotRuntimeAuthorities = (
  input: ReconcileRuntimeExecutionAuthoritiesV1,
): OwnedRuntimeAuthoritiesV1 => {
  if (input === null || typeof input !== 'object' || utilTypes.isProxy(input)) {
    throw new TypeError('reconciliation runtime authorities are invalid');
  }
  const hasCleanup = Object.hasOwn(input, 'cleanupSources');
  if (
    !exactDataKeys(
      input,
      [
        'artifact',
        ...(hasCleanup ? ['cleanupSources'] : []),
        'guards',
        'ledgerMigration',
        'lockPort',
        'locks',
        'moveScope',
        'placement',
      ].sort(),
    )
  ) {
    throw new TypeError('reconciliation runtime authority shape is invalid');
  }
  const placement = dataValue(input, 'placement');
  const artifact = dataValue(input, 'artifact');
  const ledgerMigration = dataValue(input, 'ledgerMigration');
  const moveScope = dataValue(input, 'moveScope');
  const guards = dataValue(input, 'guards');
  const lockPort = dataValue(input, 'lockPort');
  for (const candidate of [placement, artifact, ledgerMigration]) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      !exactDataKeys(candidate, ['bind'])
    ) {
      throw new TypeError('reconciliation binding authority shape is invalid');
    }
  }
  if (moveScope === null || typeof moveScope !== 'object' || !exactDataKeys(moveScope, ['bind'])) {
    throw new TypeError('reconciliation move-scope binding authority shape is invalid');
  }
  if (guards === null || typeof guards !== 'object' || utilTypes.isProxy(guards)) {
    throw new TypeError('reconciliation guard authority shape is invalid');
  }
  const hasCycle = Object.hasOwn(guards, 'beginValidationCycle');
  if (
    !exactDataKeys(
      guards,
      [
        ...(hasCycle ? ['beginValidationCycle'] : []),
        'observeCapability',
        'observeLegacyLedgerBytes',
        'observeResource',
        'observeSelection',
      ].sort(),
    )
  ) {
    throw new TypeError('reconciliation guard authority shape is invalid');
  }
  if (lockPort === null || typeof lockPort !== 'object' || utilTypes.isProxy(lockPort)) {
    throw new TypeError('reconciliation lock authority shape is invalid');
  }

  const placementBind = dataFunction(
    placement as object,
    'bind',
  ) as unknown as ReconcileRuntimeExecutionAuthoritiesV1['placement']['bind'];
  const artifactBind = dataFunction(
    artifact as object,
    'bind',
  ) as unknown as ReconcileRuntimeExecutionAuthoritiesV1['artifact']['bind'];
  const ledgerMigrationBind = dataFunction(
    ledgerMigration as object,
    'bind',
  ) as unknown as ReconcileRuntimeExecutionAuthoritiesV1['ledgerMigration']['bind'];
  const moveScopeBind = dataFunction(
    moveScope,
    'bind',
  ) as unknown as ReconcileRuntimeExecutionAuthoritiesV1['moveScope']['bind'];
  const observeResource = dataFunction(
    guards,
    'observeResource',
  ) as unknown as ReconcileExecutionGuardAuthorityV1['observeResource'];
  const observeSelection = dataFunction(
    guards,
    'observeSelection',
  ) as unknown as ReconcileExecutionGuardAuthorityV1['observeSelection'];
  const observeCapability = dataFunction(
    guards,
    'observeCapability',
  ) as unknown as ReconcileExecutionGuardAuthorityV1['observeCapability'];
  const observeLegacy = dataFunction(
    guards,
    'observeLegacyLedgerBytes',
  ) as unknown as ReconcileExecutionGuardAuthorityV1['observeLegacyLedgerBytes'];
  const beginCycle = hasCycle
    ? (dataFunction(guards, 'beginValidationCycle') as unknown as NonNullable<
        ReconcileExecutionGuardAuthorityV1['beginValidationCycle']
      >)
    : undefined;
  const withFileLock = dataFunction(
    lockPort,
    'withFileLock',
  ) as unknown as LockPort['withFileLock'];
  const cleanup = hasCleanup
    ? (dataFunction(input, 'cleanupSources') as unknown as () => Promise<void>)
    : undefined;
  const locks = ownFrozenData(dataValue(input, 'locks')) as readonly ExecutionLockDescriptor[];
  if (!Array.isArray(locks)) throw new TypeError('reconciliation lock vector is invalid');

  return Object.freeze({
    placement: Object.freeze({
      bind: (operation: ReconcilePlacementOperationV1) => placementBind.call(placement, operation),
    }),
    artifact: Object.freeze({
      bind: (operation: ReconcileArtifactOperationV1) => artifactBind.call(artifact, operation),
    }),
    ledgerMigration: Object.freeze({
      bind: (operation: ReconcileLedgerMigrationOperationV1) =>
        ledgerMigrationBind.call(ledgerMigration, operation),
    }),
    moveScope: Object.freeze({
      bind: (operation: ReconcileMoveScopeOperationV1) => moveScopeBind.call(moveScope, operation),
    }),
    guards: Object.freeze({
      observeResource: (guard: ResourcePreconditionV1, expected: unknown) =>
        observeResource.call(guards, guard, expected),
      observeSelection: (guard: SelectionPreconditionV1, expected: unknown) =>
        observeSelection.call(guards, guard, expected),
      observeCapability: (guard: CapabilityPreconditionV1, expected: unknown) =>
        observeCapability.call(guards, guard, expected),
      observeLegacyLedgerBytes: (
        operation: ReconcileLedgerMigrationOperationV1,
        guard: ResourcePreconditionV1,
        expected: unknown,
      ) => observeLegacy.call(guards, operation, guard, expected),
      ...(beginCycle === undefined ? {} : { beginValidationCycle: () => beginCycle.call(guards) }),
    }),
    lockPort: Object.freeze({
      withFileLock: <T>(
        path: string,
        operation: () => Promise<T>,
        options?: Readonly<{ signal?: AbortSignal }>,
      ): Promise<T> => withFileLock.call(lockPort, path, operation, options) as Promise<T>,
    }),
    locks,
    cleanupSources: cleanup === undefined ? undefined : () => cleanup.call(input),
  });
};

const coordinatorFailure = (error: unknown): ReconcileExecutionBindingErrorV1 => {
  const code = ownedErrorCode(error);
  if (code === 'cancelled' || code === 'ABORT_ERR' || code === 'AbortError') {
    return failure('reconcile-execution-cancelled', 'reconciliation execution was cancelled');
  }
  if (code === 'precondition-state-changed' || code === 'precondition-observation-failed') {
    return failure(
      'reconcile-execution-stale',
      'reconciliation execution state changed before mutation',
    );
  }
  if (
    code === 'permission' ||
    code === 'permission-denied' ||
    code === 'EACCES' ||
    code === 'EPERM'
  ) {
    return failure(
      'reconcile-execution-permission',
      'reconciliation execution was denied by filesystem permissions',
    );
  }
  return failure(
    'reconcile-execution-failed',
    'reconciliation execution failed at the shared coordinator boundary',
  );
};

/** Execute one exact validated reconciliation plan through the shared coordinator. */
export const executeValidatedReconcilePlanV1 = async (
  request: ExecuteValidatedReconcilePlanV1Request,
): Promise<Result<readonly OperationExecutionResult[], ReconcileExecutionBindingErrorV1>> => {
  let outcome: Result<readonly OperationExecutionResult[], ReconcileExecutionBindingErrorV1>;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const snapshot = ownFrozenData(request.plan as unknown) as OperationPlanInput<'apply'>;
    const plan = createOperationPlan(snapshot) as OperationPlan<'apply'>;
    if (
      plan.command !== 'apply' ||
      canonicalPlanningString(plan) !== canonicalPlanningString(snapshot)
    ) {
      throw new TypeError('reconciliation execution requires an exact canonical apply plan');
    }
    validateExecutionPlanShape(plan);
    const authorities = snapshotRuntimeAuthorities(request.authorities);
    cleanup = authorities.cleanupSources;
    const preconditions = createReconcileExecutionPreconditionsV1(
      plan,
      request.guards,
      authorities.guards,
    );
    if (!preconditions.ok) {
      outcome = preconditions;
    } else {
      try {
        authorities.guards.beginValidationCycle?.();
        await validateExecutionPreconditions(
          plan,
          preconditions.value,
          request.signal === undefined ? {} : { signal: request.signal },
        );
        const bindings = createReconcileExecutionBindingsV1(plan, {
          placement: (operation) => authorities.placement.bind(operation),
          artifact: (operation) => authorities.artifact.bind(operation),
          ledgerMigration: (operation) => authorities.ledgerMigration.bind(operation),
          moveScope: (operation) => authorities.moveScope.bind(operation),
        });
        if (!bindings.ok) {
          outcome = bindings;
        } else {
          authorities.guards.beginValidationCycle?.();
          const coordinatorRequest = {
            plan,
            bindings: bindings.value,
            preconditions: preconditions.value,
            locks: authorities.locks,
            lockPort: authorities.lockPort,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          };
          const results =
            request.observation === undefined
              ? await executeOperationPlan(coordinatorRequest)
              : await executeOperationPlanObserved(
                  coordinatorRequest as ObservedExecutionCoordinatorRequest,
                  request.observation,
                );
          outcome = ok(results);
        }
      } catch (error) {
        outcome = err(coordinatorFailure(error));
      }
    }
  } catch {
    outcome = err(
      failure(
        'reconcile-execution-plan-invalid',
        'reconciliation execution plan failed the exact apply-plan contract',
      ),
    );
  }

  if (cleanup !== undefined) {
    try {
      await cleanup();
    } catch {
      if (outcome.ok) {
        return err(
          failure(
            'reconcile-execution-cleanup-failed',
            'reconciliation source cleanup did not complete',
            null,
            outcome.value,
          ),
        );
      }
    }
  }
  return outcome;
};
