import { isAbsolute, join, relative, sep } from 'node:path';
import type { PreparedExecutionBinding, ValidatedExecutionBinding } from '../execution/types.ts';
import { createOperationExecutionResult } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationDigest,
  OperationExecutionResult,
  OperationImage,
} from '../planning/types.ts';
import type { LockPort } from '../ports/types.ts';
import type {
  ArtifactCoordinatorPorts,
  ArtifactGroupLockLease,
  GeneratedLockAction,
  HumanManifestAction,
} from './coordinator-types.ts';
import {
  commitArtifactPairWithLease,
  prepareArtifactGroupLeaseScaffold,
  withArtifactGroupLock,
} from './coordinator.ts';
import { hashCanonicalInput, hashManifestSemantics } from './hash.ts';
import { hashPortableLock, readPortableLockSource, serializePortableLock } from './lock.ts';
import { editManifestBytes } from './manifest-edit.ts';
import { normalizeManifestDocument, readManifestSource } from './manifest.ts';
import type { ResolvedArtifactPair } from './pair.ts';
import type { NormalizedManifestV1 } from './types.ts';

export interface ArtifactPairExecutionAuthorityInput {
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly lockPort: LockPort;
  readonly pair: ResolvedArtifactPair;
  readonly ledgerPath: string;
  readonly signal?: AbortSignal;
}

const strictAncestor = (ancestor: string, target: string): boolean => {
  const displacement = relative(ancestor, target);
  return (
    displacement !== '' &&
    displacement !== '..' &&
    !displacement.startsWith(`..${sep}`) &&
    !isAbsolute(displacement)
  );
};

const assertSafeTopology = (input: ArtifactPairExecutionAuthorityInput): void => {
  const groupPath = join(input.artifactCoordinator.coordinationRoot, 'global');
  const members = [input.pair.file.path, input.pair.lockfile.path].sort();
  const paths = [groupPath, ...members, input.ledgerPath];
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) =>
      paths.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          (strictAncestor(path, other) ||
            `${path}.lock` === other ||
            strictAncestor(`${path}.lock`, other)),
      ),
    )
  ) {
    throw new TypeError('artifact pair execution lock topology is unsafe');
  }
};

/**
 * Hold the one signed cross-domain order: artifact group, exact compatibility members, then
 * placement ledger. The callback receives the authenticated lease needed for pair commits.
 */
export const withArtifactPairExecutionAuthority = async <T>(
  input: ArtifactPairExecutionAuthorityInput,
  operation: (lease: ArtifactGroupLockLease) => Promise<T>,
): Promise<T> => {
  assertSafeTopology(input);
  const members = [input.pair.file.path, input.pair.lockfile.path].sort();
  return withArtifactGroupLock(
    input.artifactCoordinator,
    input.pair,
    input.signal,
    async (lease) => {
      const scaffold = await prepareArtifactGroupLeaseScaffold(lease, members);
      if (!scaffold.ok) throw scaffold.error;
      await lease.acquireCompatibilityTargets(members);
      return input.lockPort.withFileLock(
        input.ledgerPath,
        () => operation(lease),
        input.signal === undefined ? undefined : { signal: input.signal },
      );
    },
  );
};

export type ArtifactPairExecutionActionV1 =
  | Readonly<{ readonly role: 'manifest'; readonly action: HumanManifestAction }>
  | Readonly<{ readonly role: 'lock'; readonly action: GeneratedLockAction }>;

export interface ArtifactPairOperationControllerV1 {
  bind(
    operation: ExecutableOperation,
    action: ArtifactPairExecutionActionV1,
  ): PreparedExecutionBinding;
}

const controllerFail = (message: string): never => {
  throw new TypeError(`artifact pair execution: ${message}`);
};

const location = (path: string) => Object.freeze({ kind: 'machine-bound' as const, path });

const resource = (role: 'manifest' | 'lock', path: string) =>
  role === 'manifest'
    ? Object.freeze({ kind: 'manifest-bytes' as const, location: location(path) })
    : Object.freeze({ kind: 'lock' as const, location: location(path) });

const resourceDigest = (bytes: Uint8Array): OperationDigest => {
  const digest = hashCanonicalInput('resource', 1, bytes);
  if (!digest.ok) return controllerFail('artifact byte digest could not be computed');
  return digest.value as OperationDigest;
};

const manifestValue = (value: NormalizedManifestV1) => ({
  version: 1 as const,
  defaults:
    value.defaults === undefined
      ? null
      : {
          tools: value.defaults.tools ?? null,
          scope: value.defaults.scope ?? null,
          path: value.defaults.path ?? null,
        },
  registry: value.registry === undefined ? null : { default: value.registry.default ?? null },
  skills: value.skills,
});

export const artifactManifestImageFromBytesV1 = (
  path: string,
  bytes: Uint8Array,
): Extract<OperationImage, { readonly kind: 'manifest' }> => {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return controllerFail('manifest bytes are not valid UTF-8');
  }
  const document = readManifestSource(source);
  if (!document.ok) return controllerFail('manifest bytes are not readable');
  const normalized = normalizeManifestDocument(document.value);
  if (!normalized.ok) return controllerFail('manifest bytes are not normalizable');
  return Object.freeze({
    kind: 'manifest',
    location: location(path),
    shape: document.value.shape,
    version: 1,
    byteHash: resourceDigest(bytes),
    semanticHash: hashManifestSemantics(normalized.value) as OperationDigest,
    value: manifestValue(normalized.value),
  });
};

export const artifactLockImageFromBytesV1 = (
  path: string,
  bytes: Uint8Array,
): Extract<OperationImage, { readonly kind: 'lock' }> => {
  const lock = readPortableLockSource(bytes);
  if (!lock.ok) return controllerFail('lock bytes are not canonical');
  const digest = hashPortableLock(lock.value);
  if (!digest.ok) return controllerFail('lock hash could not be computed');
  return Object.freeze({
    kind: 'lock',
    location: location(path),
    version: 1,
    canonicalHash: digest.value as OperationDigest,
    value: Object.freeze({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: lock.value.manifestHash as OperationDigest,
      skills: Object.freeze(
        lock.value.skills.map((entry) =>
          Object.freeze({ ...entry, contentHash: entry.contentHash as OperationDigest }),
        ),
      ),
    }),
  });
};

const sameImage = (left: OperationImage, right: OperationImage): boolean =>
  canonicalPlanningString(left) === canonicalPlanningString(right);

const imagePath = (image: OperationImage): string | null => {
  const value =
    image.kind === 'manifest' || image.kind === 'lock'
      ? image.location
      : image.kind === 'absent' &&
          (image.resource.kind === 'manifest-bytes' || image.resource.kind === 'lock')
        ? image.resource.location
        : null;
  return value?.kind === 'machine-bound' ? value.path : null;
};

const ownAction = (action: ArtifactPairExecutionActionV1): ArtifactPairExecutionActionV1 => {
  try {
    const owned = structuredClone(action);
    const freeze = (value: unknown, seen = new Set<object>()): void => {
      if (
        value === null ||
        typeof value !== 'object' ||
        ArrayBuffer.isView(value) ||
        seen.has(value)
      )
        return;
      seen.add(value);
      for (const child of Object.values(value)) freeze(child, seen);
      Object.freeze(value);
    };
    freeze(owned);
    return owned;
  } catch {
    return controllerFail('artifact action is not ownable data');
  }
};

const validateOperation = (
  operation: ExecutableOperation,
  action: ArtifactPairExecutionActionV1,
  pair: ResolvedArtifactPair,
): 'manifest' | 'lock' => {
  if (
    operation.pairId !== null ||
    operation.skill !== null ||
    operation.source !== null ||
    operation.tool !== null ||
    operation.scope !== null
  ) {
    return controllerFail('artifact binding identity is invalid');
  }
  const role =
    operation.kind === 'migrate-project-config' || operation.kind === 'write-manifest'
      ? ('manifest' as const)
      : operation.kind === 'write-lock'
        ? ('lock' as const)
        : controllerFail('operation kind is not an artifact write');
  if (action.role !== role) return controllerFail('artifact action role is invalid');
  const path = role === 'manifest' ? pair.file.path : pair.lockfile.path;
  if (imagePath(operation.before) !== path || imagePath(operation.after) !== path) {
    return controllerFail('artifact operation path differs from selected authority');
  }
  if (role === 'manifest') {
    const manifestAction = action.role === 'manifest' ? action.action : controllerFail('role');
    if (operation.after.kind !== 'manifest' || operation.after.shape !== 'canonical') {
      return controllerFail('manifest operation after image is invalid');
    }
    if (operation.kind === 'migrate-project-config') {
      if (
        operation.before.kind !== 'manifest' ||
        operation.before.shape !== 'legacy' ||
        manifestAction.kind !== 'edit' ||
        manifestAction.request.edits.length !== 1 ||
        manifestAction.request.edits[0]?.kind !== 'migrate-legacy'
      ) {
        return controllerFail('manifest migration action is invalid');
      }
    } else {
      const absent =
        operation.before.kind === 'absent' && operation.before.resource.kind === 'manifest-bytes';
      const present =
        operation.before.kind === 'manifest' && operation.before.shape === 'canonical';
      if (
        (!absent && !present) ||
        (absent && manifestAction.kind !== 'replace') ||
        (present && manifestAction.kind !== 'edit') ||
        (manifestAction.kind === 'edit' &&
          manifestAction.request.edits.some(({ kind }) => kind === 'migrate-legacy'))
      ) {
        return controllerFail('manifest write action is invalid');
      }
    }
  } else if (
    action.role !== 'lock' ||
    action.action.kind !== 'replace' ||
    operation.after.kind !== 'lock' ||
    !(
      (operation.before.kind === 'absent' && operation.before.resource.kind === 'lock') ||
      operation.before.kind === 'lock'
    )
  ) {
    return controllerFail('lock write action is invalid');
  }
  return role;
};

const observeImage = async (
  ports: ArtifactCoordinatorPorts,
  role: 'manifest' | 'lock',
  path: string,
): Promise<Readonly<{ image: OperationImage; bytes: Uint8Array | null }>> => {
  const observed = await ports.observe(path);
  if (observed.kind === 'absent') {
    return Object.freeze({
      image: Object.freeze({ kind: 'absent' as const, resource: resource(role, path) }),
      bytes: null,
    });
  }
  if (observed.kind !== 'file') return controllerFail(`${role} path is not a regular file`);
  const bytes = await ports.readBytes(path);
  return Object.freeze({
    image:
      role === 'manifest'
        ? artifactManifestImageFromBytesV1(path, bytes)
        : artifactLockImageFromBytesV1(path, bytes),
    bytes: new Uint8Array(bytes),
  });
};

const resultFor = (
  operation: ExecutableOperation,
  binding: ValidatedExecutionBinding,
  outcome: 'succeeded' | 'failed' | 'cancelled',
  actualAfter: OperationImage,
  reason?: string,
): OperationExecutionResult =>
  createOperationExecutionResult({
    operationId: operation.operationId,
    outcome,
    actualBefore: binding.actualBefore,
    actualAfter,
    force: null,
    error:
      outcome === 'failed'
        ? {
            code: reason === undefined ? 'artifact-mutation-failed' : `artifact-mutation-${reason}`,
            message: `portable artifact mutation failed${reason === undefined ? '' : `: ${reason}`}`,
            remediation: 'Re-read portable state and retry the command.',
          }
        : null,
  });

/** Bind canonical manifest/lock operations to one already-authenticated artifact-group lease. */
export const createArtifactPairOperationControllerV1 = (input: {
  readonly lease: ArtifactGroupLockLease;
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly pair: ResolvedArtifactPair;
  readonly signal?: AbortSignal;
}): ArtifactPairOperationControllerV1 => {
  const pair = Object.freeze({
    file: Object.freeze({ ...input.pair.file }),
    lockfile: Object.freeze({ ...input.pair.lockfile }),
    lockfileSource: input.pair.lockfileSource,
  });
  const lastByRole = new Map<'manifest' | 'lock', ExecutableOperation>();
  const successful = new Set<string>();
  const bound = new Set<string>();
  let previous: ExecutableOperation | null = null;

  return Object.freeze({
    bind: (
      operation: ExecutableOperation,
      rawAction: ArtifactPairExecutionActionV1,
    ): PreparedExecutionBinding => {
      if (bound.has(operation.operationId)) return controllerFail('operation was bound twice');
      const action = ownAction(rawAction);
      const role = validateOperation(operation, action, pair);
      const rolePredecessor = lastByRole.get(role) ?? null;
      const directPredecessors = operation.dependencyMetadata.operationIds.filter((operationId) =>
        bound.has(operationId),
      );
      if (rolePredecessor !== null && !sameImage(rolePredecessor.after, operation.before)) {
        return controllerFail('artifact operation chain has a state gap');
      }
      if (
        previous !== null &&
        previous.groupId === operation.groupId &&
        !operation.dependencyMetadata.operationIds.includes(previous.operationId)
      ) {
        return controllerFail('artifact chain lacks a direct dependency');
      }
      bound.add(operation.operationId);
      lastByRole.set(role, operation);
      previous = operation;
      return Object.freeze({
        operationId: operation.operationId,
        groupId: operation.groupId,
        pairId: null,
        unstartedForce: null,
        observeActualBefore: async () => operation.before,
        execute: async (binding: ValidatedExecutionBinding): Promise<OperationExecutionResult> => {
          if (!sameImage(binding.actualBefore, operation.before)) {
            return controllerFail('validated binding differs from planned before image');
          }
          if (rolePredecessor !== null && !successful.has(rolePredecessor.operationId)) {
            return controllerFail('artifact predecessor did not complete successfully');
          }
          if (directPredecessors.some((operationId) => !successful.has(operationId))) {
            return controllerFail('artifact dependency did not complete successfully');
          }
          const path = role === 'manifest' ? pair.file.path : pair.lockfile.path;
          const before = await observeImage(input.artifactCoordinator, role, path);
          if (!sameImage(before.image, operation.before)) {
            return controllerFail('physical artifact state differs from planned before image');
          }
          let candidate: OperationImage;
          if (role === 'manifest') {
            if (action.role !== 'manifest') return controllerFail('manifest action role changed');
            const bytes =
              action.action.kind === 'replace'
                ? action.action.bytes
                : action.action.kind === 'edit' && before.bytes !== null
                  ? (() => {
                      const edited = editManifestBytes(before.bytes, action.action.request);
                      if (!edited.ok) return controllerFail('manifest action could not be applied');
                      return edited.value.bytes;
                    })()
                  : controllerFail('manifest action no longer matches physical state');
            candidate = artifactManifestImageFromBytesV1(path, bytes);
          } else {
            if (action.role !== 'lock' || action.action.kind !== 'replace') {
              return controllerFail('lock action role changed');
            }
            const serialized = serializePortableLock(action.action.lock);
            if (!serialized.ok) return controllerFail('lock action could not be serialized');
            candidate = artifactLockImageFromBytesV1(
              path,
              new TextEncoder().encode(serialized.value),
            );
          }
          if (!sameImage(candidate, operation.after)) {
            return controllerFail('artifact action differs from planned after image');
          }
          const manifestAction: HumanManifestAction =
            role === 'manifest'
              ? action.role === 'manifest'
                ? action.action
                : controllerFail('manifest action role changed')
              : { kind: 'keep' };
          const lockAction: GeneratedLockAction =
            role === 'lock'
              ? action.role === 'lock'
                ? action.action
                : controllerFail('lock action role changed')
              : { kind: 'keep' };
          const committed = await commitArtifactPairWithLease(input.lease, {
            pair,
            manifest: manifestAction,
            lock: lockAction,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          if (!committed.ok) {
            const durable = await observeImage(input.artifactCoordinator, role, path);
            const actualAfter = sameImage(durable.image, operation.after)
              ? operation.after
              : sameImage(durable.image, operation.before)
                ? operation.before
                : controllerFail('failed artifact commit left an unprovable image');
            return resultFor(
              operation,
              binding,
              committed.error.reason === 'cancelled' ? 'cancelled' : 'failed',
              actualAfter,
              committed.error.reason,
            );
          }
          successful.add(operation.operationId);
          return resultFor(operation, binding, 'succeeded', operation.after);
        },
      });
    },
  });
};
