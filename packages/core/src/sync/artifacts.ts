import { canonicalPlanningString } from '../planning/order.ts';
import type { ExecutableOperation, OperationImage } from '../planning/types.ts';

type ManifestImage = Extract<OperationImage, { readonly kind: 'manifest' }>;
type LockImage = Extract<OperationImage, { readonly kind: 'lock' }>;

export interface SyncArtifactAfterImageGroupV1 {
  readonly groupId: string;
  readonly manifestOperation: ExecutableOperation &
    Readonly<{ readonly kind: 'write-manifest'; readonly after: ManifestImage }>;
  readonly lockOperation: ExecutableOperation &
    Readonly<{ readonly kind: 'write-lock'; readonly after: LockImage }>;
  readonly placementOperations: readonly ExecutableOperation[];
}

const appendDependency = (
  operation: ExecutableOperation,
  operationId: string,
): ExecutableOperation => ({
  ...operation,
  dependencyMetadata: {
    ...operation.dependencyMetadata,
    operationIds: [...new Set([...operation.dependencyMetadata.operationIds, operationId])],
  },
});

/**
 * Bind colliding save groups to the exact latest durable artifact after-image. This is a pure
 * projection: it never rereads, rebases, or replans artifact bytes at execution time.
 */
export const chainSyncArtifactAfterImagesV1 = (
  groups: readonly SyncArtifactAfterImageGroupV1[],
): readonly SyncArtifactAfterImageGroupV1[] => {
  let previous: SyncArtifactAfterImageGroupV1 | null = null;
  return Object.freeze(
    groups.map((group) => {
      if (
        group.manifestOperation.groupId !== group.groupId ||
        group.lockOperation.groupId !== group.groupId ||
        group.lockOperation.dependencyMetadata.operationIds.indexOf(
          group.manifestOperation.operationId,
        ) === -1 ||
        group.placementOperations.some((operation) => operation.groupId !== group.groupId)
      ) {
        throw new TypeError('sync artifact group is incoherent');
      }
      if (previous === null) {
        previous = group;
        return Object.freeze({
          ...group,
          placementOperations: Object.freeze([...group.placementOperations]),
        });
      }
      if (
        group.manifestOperation.before.kind !== 'manifest' ||
        group.lockOperation.before.kind !== 'lock' ||
        canonicalPlanningString(group.manifestOperation.before) !==
          canonicalPlanningString(previous.manifestOperation.after) ||
        canonicalPlanningString(group.lockOperation.before) !==
          canonicalPlanningString(previous.lockOperation.after)
      ) {
        throw new TypeError('sync artifact group does not consume the latest exact after-image');
      }
      const prefix = previous.lockOperation.operationId;
      const chained = Object.freeze({
        ...group,
        manifestOperation: appendDependency(
          group.manifestOperation,
          prefix,
        ) as typeof group.manifestOperation,
        lockOperation: appendDependency(group.lockOperation, prefix) as typeof group.lockOperation,
        placementOperations: Object.freeze(
          group.placementOperations.map((operation) => appendDependency(operation, prefix)),
        ),
      });
      previous = chained;
      return chained;
    }),
  );
};
