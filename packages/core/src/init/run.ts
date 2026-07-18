import type { CurrentApplicationContext } from '../application/types.ts';
import type { ArtifactFileRevision } from '../artifacts/coordinator-types.ts';
import { updateCoordinatedHumanFile } from '../artifacts/coordinator.ts';
import { artifactManifestImageFromBytesV1 } from '../artifacts/execution.ts';
import { artifactMutationError } from '../artifacts/file-state.ts';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import { editManifestBytes } from '../artifacts/manifest-edit.ts';
import { executeOperationPlanObserved } from '../execution/coordinator.ts';
import { createExecutionPrecondition } from '../execution/preconditions.ts';
import type { PreparedExecutionBinding, ValidatedExecutionBinding } from '../execution/types.ts';
import { createBoundedForceEffect, createOperationExecutionResult } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { BoundedConflict, OperationDigest, OperationImage } from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { hashInitResourceBytes, initObservationFacts } from './plan.ts';
import type { InitFailure, InitObservedManifest, PreparedInitPlan } from './types.ts';

const encoder = new TextEncoder();
const location = (path: string) => Object.freeze({ kind: 'machine-bound' as const, path });
const resource = (path: string) =>
  Object.freeze({ kind: 'manifest-bytes' as const, location: location(path) });

const operationManifestPath = (
  operation: PreparedInitPlan['plan']['operations'][number],
): string => {
  if (operation.after.kind !== 'manifest' || operation.after.location.kind !== 'machine-bound') {
    throw new TypeError('init operation after-image path is invalid');
  }
  return operation.after.location.path;
};

const forceEffect = (requested: boolean, conflict: BoundedConflict | null, applied: boolean) =>
  conflict === null
    ? createBoundedForceEffect({ supported: true, requested, applied: false, conflict: null })
    : createBoundedForceEffect({ supported: true, requested: true, applied, conflict });

export const observeInitManifest = async (
  context: Pick<CurrentApplicationContext, 'artifactCoordinator' | 'signal'>,
  path: string,
): Promise<Result<InitObservedManifest, InitFailure>> => {
  try {
    const metadata = await context.artifactCoordinator.observe(path);
    if (metadata.kind === 'absent') {
      return ok(Object.freeze({ state: 'absent' as const, parent: metadata.parent }));
    }
    if (
      metadata.kind !== 'file' ||
      metadata.mode === null ||
      metadata.identity === null ||
      metadata.linkCount !== 1
    ) {
      return err(
        Object.freeze({
          code: 'init-invalid-file-kind',
          message: 'selected init manifest is not an owned ordinary file',
          exitClass: 'state' as const,
        }),
      );
    }
    const bytes = await context.artifactCoordinator.readBytes(path);
    return ok(
      Object.freeze({
        state: 'file' as const,
        bytes: new Uint8Array(bytes),
        resourceDigest: hashInitResourceBytes(bytes),
        mode: metadata.mode,
        identity: metadata.identity,
        parent: metadata.parent,
      }),
    );
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const cancelled = context.signal?.aborted || code === 'ABORT_ERR';
    const permission = code === 'EACCES' || code === 'EPERM';
    const changed = code === 'ENOENT' || code === 'ESTALE';
    return err(
      Object.freeze({
        code: cancelled
          ? 'init-cancelled'
          : permission
            ? 'init-observation-permission'
            : changed
              ? 'init-observation-changed'
              : 'init-observation-failed',
        message: 'selected init manifest could not be observed',
        exitClass: cancelled
          ? ('cancelled' as const)
          : permission
            ? ('permission' as const)
            : changed
              ? ('state' as const)
              : ('failure' as const),
      }),
    );
  }
};

const imageForRevision = (
  operation: PreparedInitPlan['plan']['operations'][number],
  revision: ArtifactFileRevision,
): OperationImage => {
  const path = operationManifestPath(operation);
  if (revision.state === 'absent') {
    return Object.freeze({
      kind: 'absent' as const,
      resource: resource(path),
    });
  }
  if (operation.before.kind === 'opaque-manifest') {
    return Object.freeze({
      kind: 'opaque-manifest' as const,
      location: location(path),
      shape: operation.before.shape,
      byteHash: revision.digest as OperationDigest,
    });
  }
  return artifactManifestImageFromBytesV1(path, revision.bytes);
};

const revisionFacts = (revision: ArtifactFileRevision): unknown =>
  revision.state === 'absent'
    ? Object.freeze({ state: 'absent' as const, parent: revision.parent })
    : Object.freeze({
        state: 'file' as const,
        resourceDigest: revision.digest,
        mode: revision.mode,
        identity: revision.identity,
        parent: revision.parent,
      });

const revisionMatchesObserved = (
  revision: ArtifactFileRevision,
  observed: InitObservedManifest,
  allowProvisionedParent: boolean,
): boolean =>
  canonicalPlanningString(revisionFacts(revision)) ===
    canonicalPlanningString(initObservationFacts(observed)) ||
  (observed.state === 'absent' &&
    revision.state === 'absent' &&
    observed.parent.state === 'missing' &&
    revision.parent.state === 'present' &&
    allowProvisionedParent);

const failure = (
  code: string,
  exitClass: InitFailure['exitClass'],
  durableState?: InitFailure['durableState'],
): InitFailure =>
  Object.freeze({
    code,
    message: 'init manifest execution failed',
    exitClass,
    ...(durableState === undefined ? {} : { durableState }),
  });

export const executePreparedInit = async (
  context: CurrentApplicationContext,
  prepared: PreparedInitPlan,
): Promise<Result<'succeeded', InitFailure>> => {
  const operation = prepared.plan.operations[0];
  if (operation === undefined) return ok('succeeded');
  const afterBytes = encoder.encode(prepared.classification.after?.source ?? '');
  const executionObservation: { failure: InitFailure | null } = { failure: null };
  const observeForExecution = async (): Promise<InitObservedManifest> => {
    const observed = await observeInitManifest(context, prepared.selection.manifestPath);
    if (observed.ok) return observed.value;
    executionObservation.failure = observed.error;
    throw new Error(observed.error.code);
  };
  const observeFacts = async () => {
    return initObservationFacts(await observeForExecution());
  };
  const precondition = createExecutionPrecondition({
    operationIds: [operation.operationId],
    resource: resource(prepared.selection.manifestPath),
    expected: initObservationFacts(prepared.observed),
    observe: observeFacts,
  });
  if (precondition.preconditionId !== operation.preconditionIds[0]) {
    throw new TypeError('init precondition identity drift');
  }

  const observeActualBefore = async (): Promise<OperationImage> => {
    const observed = await observeForExecution();
    if (
      canonicalPlanningString(initObservationFacts(observed)) !==
      canonicalPlanningString(initObservationFacts(prepared.observed))
    ) {
      throw Object.freeze({
        code: 'precondition-state-changed',
        message: 'init manifest identity changed before execution binding',
      });
    }
    if (observed.state === 'absent') {
      return Object.freeze({
        kind: 'absent' as const,
        resource: resource(prepared.selection.manifestPath),
      });
    }
    if (operation.before.kind === 'opaque-manifest') {
      return Object.freeze({
        kind: 'opaque-manifest' as const,
        location: location(prepared.selection.manifestPath),
        shape: operation.before.shape,
        byteHash: observed.resourceDigest as OperationDigest,
      });
    }
    return artifactManifestImageFromBytesV1(prepared.selection.manifestPath, observed.bytes);
  };

  const conflict = operation.conflict;
  const unstartedForce = forceEffect(prepared.request.force, conflict, false);
  let cancellationDurableState: InitFailure['durableState'];
  let editInvocations = 0;
  const binding: PreparedExecutionBinding = Object.freeze({
    operationId: operation.operationId,
    groupId: operation.groupId,
    pairId: null,
    unstartedForce,
    observeActualBefore,
    execute: async (validated: ValidatedExecutionBinding) => {
      const committed = await updateCoordinatedHumanFile(context.artifactCoordinator, {
        path: prepared.selection.manifestPath,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(conflict !== null && prepared.observed.state === 'file'
          ? {
              opaqueManifestBackup: {
                expectedResourceDigest: prepared.observed.resourceDigest as ArtifactDigest,
              },
            }
          : {}),
        edit: (revision) => {
          const allowProvisionedParent = editInvocations > 0;
          editInvocations += 1;
          if (!revisionMatchesObserved(revision, prepared.observed, allowProvisionedParent)) {
            return err(artifactMutationError('external-writer-conflict'));
          }
          let actual: OperationImage;
          try {
            actual = imageForRevision(operation, revision);
          } catch {
            return err(artifactMutationError('external-writer-conflict'));
          }
          if (canonicalPlanningString(actual) !== canonicalPlanningString(operation.before)) {
            return err(artifactMutationError('external-writer-conflict'));
          }
          let bytes = afterBytes;
          if (operation.kind === 'migrate-project-config') {
            if (revision.state !== 'file')
              return err(artifactMutationError('external-writer-conflict'));
            const edited = editManifestBytes(revision.bytes, {
              edits: [{ kind: 'migrate-legacy' }],
            });
            if (!edited.ok) return err(artifactMutationError(edited.error.reason));
            bytes = new Uint8Array(edited.value.bytes);
            const candidate = artifactManifestImageFromBytesV1(
              prepared.selection.manifestPath,
              bytes,
            );
            if (canonicalPlanningString(candidate) !== canonicalPlanningString(operation.after)) {
              return err(artifactMutationError('external-writer-conflict'));
            }
          }
          return ok(
            Object.freeze({
              bytes,
              changed: true,
              mode: revision.state === 'file' ? revision.mode : 0o600,
            }),
          );
        },
      });
      if (!committed.ok) {
        const cancelled = committed.error.reason === 'cancelled';
        const permission = committed.error.reason === 'permission-denied';
        const durableAfter = cancelled && committed.error.durableState === 'after';
        if (cancelled) cancellationDurableState = durableAfter ? 'after' : 'before';
        return createOperationExecutionResult({
          operationId: operation.operationId,
          outcome: cancelled ? 'cancelled' : 'failed',
          actualBefore: validated.actualBefore,
          actualAfter: durableAfter ? operation.after : validated.actualBefore,
          force: durableAfter
            ? forceEffect(prepared.request.force, conflict, conflict !== null)
            : unstartedForce,
          error: cancelled
            ? null
            : {
                code: `init-${committed.error.reason}`,
                message: 'init manifest execution failed',
                remediation: permission
                  ? 'Check manifest directory permissions and retry.'
                  : 'Re-read the selected manifest and retry.',
              },
        });
      }
      return createOperationExecutionResult({
        operationId: operation.operationId,
        outcome: 'succeeded',
        actualBefore: validated.actualBefore,
        actualAfter: operation.after,
        force: forceEffect(prepared.request.force, conflict, conflict !== null),
        error: null,
      });
    },
  });

  try {
    const results = await executeOperationPlanObserved(
      {
        plan: prepared.plan,
        bindings: [binding],
        preconditions: [precondition],
        locks: [],
        lockPort: context.ports,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      context.observation,
    );
    const result = results[0];
    if (result?.outcome === 'succeeded') return ok('succeeded');
    if (result?.outcome === 'cancelled') {
      return err(failure('init-cancelled', 'cancelled', cancellationDurableState ?? 'before'));
    }
    const code = result?.error?.code ?? 'init-execution';
    return err(
      failure(
        code,
        code.includes('permission')
          ? 'permission'
          : code.includes('precondition') || code.includes('writer') || code.includes('contention')
            ? 'state'
            : 'failure',
      ),
    );
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const observationFailure = executionObservation.failure;
    if (code !== 'cancelled' && !context.signal?.aborted && observationFailure !== null) {
      return err(failure(observationFailure.code, observationFailure.exitClass));
    }
    return err(
      failure(
        code === 'cancelled' || context.signal?.aborted
          ? 'init-cancelled'
          : 'init-precondition-changed',
        code === 'cancelled' || context.signal?.aborted ? 'cancelled' : 'state',
        code === 'cancelled' || context.signal?.aborted ? 'before' : undefined,
      ),
    );
  }
};
