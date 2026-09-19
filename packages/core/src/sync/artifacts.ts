import {
  type ArtifactPairExecutionActionV1,
  artifactLockImageFromBytesV1,
  artifactManifestImageFromBytesV1,
} from '../artifacts/execution.ts';
import { hashCanonicalInput, hashManifestSemantics } from '../artifacts/hash.ts';
import {
  correlatePortableLock,
  hashPortableLock,
  serializePortableLock,
} from '../artifacts/lock.ts';
import { type ManifestEdit, editManifestBytes } from '../artifacts/manifest-edit.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import { artifactContractRegistry } from '../artifacts/registry.ts';
import {
  type ArtifactReadPorts,
  readLockArtifact,
  readManifestArtifact,
} from '../artifacts/repository.ts';
import {
  type SkillSmithError,
  cancelledError,
  flipRefusedError,
  genericError,
  invalidArgumentError,
  permissionDeniedError,
  toolUnavailableError,
} from '../errors.ts';
import type { ExecutionPrecondition } from '../execution/types.ts';
import { type PreparedExportArtifacts, prepareExportArtifacts } from '../export/merge.ts';
import type { ExportObservation } from '../export/observe.ts';
import {
  createExportArtifactPrecondition,
  exportArtifactPreconditionFacts,
} from '../export/plan.ts';
import type { ExportRequest, PortableExportCandidate } from '../export/types.ts';
import { createOperationId } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { ExecutableOperation, OperationImage, OperationPlan } from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { SyncFleetResourceSelectionV1, SyncFleetSelectedPairV1 } from './plan.ts';
import type { SyncFleetObservation } from './types.ts';

type ManifestImage = Extract<OperationImage, { readonly kind: 'manifest' }>;
type LockImage = Extract<OperationImage, { readonly kind: 'lock' }>;

export interface PreparedSyncArtifactOperationV1 {
  readonly operation: ExecutableOperation;
  readonly action: ArtifactPairExecutionActionV1;
}

export interface PreparedSyncArtifactsV1 {
  readonly pair: ResolvedArtifactPair;
  readonly operations: readonly PreparedSyncArtifactOperationV1[];
  readonly preconditions: readonly ExecutionPrecondition[];
  readonly prefixOperationIdsByPair: Readonly<Record<string, readonly string[]>>;
}

const artifactFailure = (
  failure: Readonly<{
    readonly message: string;
    readonly exitClass: 'failure' | 'usage' | 'state' | 'capability' | 'permission' | 'cancelled';
  }>,
): SkillSmithError => {
  switch (failure.exitClass) {
    case 'usage':
      return invalidArgumentError(failure.message);
    case 'permission':
      return permissionDeniedError(failure.message);
    case 'state':
      return flipRefusedError(failure.message);
    case 'capability':
      return toolUnavailableError(failure.message);
    case 'cancelled':
      return cancelledError(failure.message);
    case 'failure':
      return genericError(failure.message);
  }
};

const pairOperation = (
  plan: OperationPlan<'sync'>,
  pair: SyncFleetSelectedPairV1,
): ExecutableOperation | null =>
  plan.operations.find(
    (operation) => operation.skill === pair.pair.skill && operation.tool === pair.pair.tool,
  ) ?? null;

const pairGroupId = (plan: OperationPlan<'sync'>, pair: SyncFleetSelectedPairV1): string | null => {
  const operation = pairOperation(plan, pair);
  if (operation !== null) return operation.groupId;
  return (
    plan.diagnostics.find(
      ({ affected }) => affected.skill === pair.pair.skill && affected.tool === pair.pair.tool,
    )?.correlation.groupId ?? null
  );
};

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

const absentArtifactImage = (role: 'manifest' | 'lock', path: string): OperationImage => ({
  kind: 'absent',
  resource:
    role === 'manifest'
      ? { kind: 'manifest-bytes', location: { kind: 'machine-bound', path } }
      : { kind: 'lock', location: { kind: 'machine-bound', path } },
});

const syncArtifactOperation = (
  input: Readonly<{
    groupId: string;
    kind: 'migrate-project-config' | 'write-manifest' | 'write-lock';
    before: OperationImage;
    after: OperationImage;
    dependencies: readonly string[];
    selectionSource: 'bounded-default' | 'explicit-targets';
  }>,
): ExecutableOperation => {
  const identity = {
    domain: 'skillsmith.operation-identity' as const,
    schemaVersion: 1 as const,
    groupId: input.groupId,
    pairId: null,
    kind: input.kind,
    skill: null,
    source: null,
    tool: null,
    scope: null,
  };
  return Object.freeze({
    operationId: createOperationId(identity),
    groupId: input.groupId,
    pairId: null,
    kind: input.kind,
    dependencyMetadata: Object.freeze({
      domain: 'skillsmith.operation-dependency' as const,
      schemaVersion: 1 as const,
      operationIds: Object.freeze([...new Set(input.dependencies)]),
    }),
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: input.before,
    after: input.after,
    reason: Object.freeze({
      code: `sync-${input.kind}`,
      message: `${input.kind} is required for the selected sync group.`,
    }),
    selectionSource: input.selectionSource,
    preconditionIds: Object.freeze([]),
    requiredCheckIds: Object.freeze([]),
    reversibility: Object.freeze({ kind: 'none' as const, retentionResourceIds: [] as const }),
    mutates: Object.freeze(
      input.kind === 'write-lock'
        ? { live: false, manifest: false, lock: true, ledger: false }
        : { live: false, manifest: true, lock: false, ledger: false },
    ),
    conflict: null,
  });
};

const artifactObservationAfter = (
  observation: ExportObservation,
  prepared: PreparedExportArtifacts,
): ExportObservation => {
  const manifestSource = new TextDecoder().decode(prepared.manifestBytes);
  const lockSource = new TextDecoder().decode(prepared.lockBytes);
  const manifestByteRevision = hashCanonicalInput('resource', 1, prepared.manifestBytes);
  const lockByteRevision = hashCanonicalInput('resource', 1, prepared.lockBytes);
  const lockSemanticRevision = hashPortableLock(prepared.lock);
  if (!manifestByteRevision.ok || !lockByteRevision.ok || !lockSemanticRevision.ok) {
    throw new Error('sync artifact after-image could not be hashed');
  }
  return Object.freeze({
    ...observation,
    manifest: Object.freeze({
      state: 'present' as const,
      artifact: 'manifest' as const,
      sourceVersion: 1 as const,
      currentVersion: 1 as const,
      source: manifestSource,
      byteLength: prepared.manifestBytes.byteLength,
      byteRevision: manifestByteRevision.value,
      semanticRevision: hashManifestSemantics(prepared.manifest),
      model: prepared.manifest,
      canonical: true,
      migration: null,
    }),
    lock: Object.freeze({
      state: 'present' as const,
      artifact: 'lock' as const,
      sourceVersion: 1 as const,
      currentVersion: 1 as const,
      source: lockSource,
      byteLength: prepared.lockBytes.byteLength,
      byteRevision: lockByteRevision.value,
      semanticRevision: lockSemanticRevision.value,
      model: prepared.lock,
      canonical: true,
      migration: null,
    }),
  });
};

const equalArtifactBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => right[index] === value);

const prepareSyncRemovalArtifacts = (
  observation: ExportObservation,
  selectedPairs: readonly SyncFleetSelectedPairV1[],
): Result<PreparedExportArtifacts | null, SkillSmithError> => {
  const before = observation.manifest;
  if (before?.state !== 'present') return ok(null);
  const skill = selectedPairs[0]?.pair.skill;
  if (skill === undefined || selectedPairs.some(({ pair }) => pair.skill !== skill)) {
    return err(genericError('sync removal artifact group is incoherent'));
  }
  const declaration = before.model.skills.find(({ name }) => name === skill);
  const removedTools = new Set<string>(
    selectedPairs.filter(({ action }) => action === 'remove').map(({ pair }) => pair.tool),
  );
  const edits: ManifestEdit[] = [];
  if (declaration !== undefined) {
    const retainedTools = declaration.tools.filter((tool) => !removedTools.has(tool));
    if (retainedTools.length !== declaration.tools.length) {
      edits.push(
        retainedTools.length === 0
          ? { kind: 'remove-skill', name: skill }
          : { kind: 'set-skill-field', name: skill, field: 'tools', value: retainedTools },
      );
    }
  }
  const migrating = before.sourceVersion === 'legacy';
  if (edits.length === 0 && !migrating) return ok(null);
  const edited = editManifestBytes(new TextEncoder().encode(before.source), {
    edits: [...(migrating ? ([{ kind: 'migrate-legacy' }] as const) : []), ...edits],
  });
  if (!edited.ok) return err(flipRefusedError(edited.error.message));
  const manifestCodec = artifactContractRegistry.get('manifest', 1);
  if (manifestCodec === undefined) return err(genericError('sync manifest codec is unavailable'));
  const decoded = manifestCodec.decode(edited.value.bytes);
  if (!decoded.ok) return err(flipRefusedError('sync removal manifest is invalid'));
  const manifest = decoded.value.model as PreparedExportArtifacts['manifest'];
  const lockBefore = observation.lock;
  if (
    lockBefore?.state === 'present' &&
    correlatePortableLock(before.model, lockBefore.model).state !== 'current'
  ) {
    return err(flipRefusedError('existing portable lock is not current'));
  }
  const existingLockByName = new Map(
    lockBefore?.state === 'present'
      ? lockBefore.model.skills.map((entry) => [entry.name, entry] as const)
      : [],
  );
  const lockSkills: Array<PreparedExportArtifacts['lock']['skills'][number]> = [];
  for (const retained of manifest.skills) {
    const lockEntry = existingLockByName.get(retained.name);
    if (lockEntry === undefined) {
      return err(flipRefusedError(`exact lock facts are unavailable for ${retained.name}`));
    }
    lockSkills.push(lockEntry);
  }
  lockSkills.sort((left, right) => left.name.localeCompare(right.name));
  const lock: PreparedExportArtifacts['lock'] = Object.freeze({
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(manifest),
    skills: Object.freeze(lockSkills),
  });
  const serialized = serializePortableLock(lock);
  if (!serialized.ok) return err(genericError('sync removal lock serialization failed'));
  const lockBytes = new TextEncoder().encode(serialized.value);
  const beforeLockBytes =
    lockBefore?.state === 'present'
      ? new TextEncoder().encode(lockBefore.source)
      : new Uint8Array();
  const lockChanged =
    lockBefore?.state !== 'present' || !equalArtifactBytes(beforeLockBytes, lockBytes);
  return ok(
    Object.freeze({
      candidates: Object.freeze([]),
      candidateActions: Object.freeze({}),
      manifestEdits: Object.freeze(edits),
      manifest,
      manifestBytes: edited.value.bytes,
      manifestChanged: edited.value.changed || edited.value.migrated,
      manifestAction: migrating ? 'migrate' : 'update',
      lock,
      lockBytes,
      lockChanged,
      lockAction:
        lockBefore?.state !== 'present' ? 'create' : lockChanged ? 'refresh' : 'unchanged',
    }),
  );
};

export const prepareSyncArtifactsV1 = async (input: {
  readonly ports: ArtifactReadPorts;
  readonly homeDir: string;
  readonly fleet: SyncFleetObservation;
  readonly selection: SyncFleetResourceSelectionV1;
  readonly livePlan: OperationPlan<'sync'>;
  readonly pair: ResolvedArtifactPair;
}): Promise<Result<PreparedSyncArtifactsV1, SkillSmithError>> => {
  const { ports, fleet, selection, livePlan, pair } = input;
  const [manifest, lock] = await Promise.all([
    readManifestArtifact(ports, pair.file.path),
    readLockArtifact(ports, pair.lockfile.path),
  ]);
  if (!manifest.ok) {
    return err(
      manifest.error.reason === 'permission-denied'
        ? permissionDeniedError(manifest.error.message)
        : flipRefusedError(manifest.error.message),
    );
  }
  if (!lock.ok) {
    return err(
      lock.error.reason === 'permission-denied'
        ? permissionDeniedError(lock.error.message)
        : flipRefusedError(lock.error.message),
    );
  }
  const request: ExportRequest = Object.freeze({
    tools: selection.tools,
    explicitTools: true,
    scope: selection.scope,
    explicitScope: true,
    strict: true,
    force: false,
    dryRun: true,
  });
  const initialObservation = Object.freeze({
    project: fleet.endpoints.to.project,
    sourceProjectRoot: selection.scope === 'project' ? fleet.endpoints.to.canonicalBase : null,
    homeDir: input.homeDir,
    request,
    pair,
    inventory: fleet.source.inventory,
    entries: Object.freeze([]),
    ledger: fleet.destination.ledger,
    ledgerPath: fleet.destination.ledgerPath,
    manifest: manifest.value,
    lock: lock.value,
  }) as ExportObservation;
  let observation = initialObservation;
  let manifestImage: OperationImage =
    manifest.value.state === 'present'
      ? artifactManifestImageFromBytesV1(
          pair.file.path,
          new TextEncoder().encode(manifest.value.source),
        )
      : absentArtifactImage('manifest', pair.file.path);
  let lockImage: OperationImage =
    lock.value.state === 'present'
      ? artifactLockImageFromBytesV1(
          pair.lockfile.path,
          new TextEncoder().encode(lock.value.source),
        )
      : absentArtifactImage('lock', pair.lockfile.path);
  const selectionSource =
    selection.options.targets.length === 0 ? 'bounded-default' : 'explicit-targets';
  const preparedOperations: PreparedSyncArtifactOperationV1[] = [];
  const prefixOperationIdsByPair: Record<string, readonly string[]> = {};
  let previousArtifactOperationId: string | null = null;
  for (const groupId of livePlan.selection.groupIds ?? []) {
    const incomingArtifactPrefix: string | null = previousArtifactOperationId;
    const selectedPairs = selection.pairs.filter(
      (selected) => pairGroupId(livePlan, selected) === groupId,
    );
    const skill = selectedPairs[0]?.pair.skill;
    if (skill === undefined) return err(genericError('sync artifact group has no selected skill'));
    const convergences = selectedPairs.filter(
      (
        selected,
      ): selected is SyncFleetSelectedPairV1 & {
        readonly source: NonNullable<SyncFleetSelectedPairV1['source']>;
      } => selected.action === 'converge' && selected.source !== null,
    );
    const removals = selectedPairs.filter(({ action }) => action === 'remove');
    let prepared: Result<PreparedExportArtifacts | null, SkillSmithError>;
    if (convergences.length > 0) {
      const firstProof = convergences[0]?.source.portable;
      if (firstProof?.outcome !== 'portable') {
        return err(invalidArgumentError('sync save requires portable selected source groups'));
      }
      const candidate: PortableExportCandidate = Object.freeze({
        ...firstProof.candidate,
        tools: Object.freeze(convergences.map(({ pair: selectedPair }) => selectedPair.tool)),
        scope: selection.scope,
      });
      const exported = prepareExportArtifacts(observation, [candidate]);
      prepared = exported.ok ? ok(exported.value) : err(artifactFailure(exported.error));
    } else {
      prepared = prepareSyncRemovalArtifacts(observation, removals);
    }
    if (!prepared.ok) return prepared;
    const preparedArtifacts = prepared.value;
    const liveOperationIds = livePlan.operations
      .filter((operation) => operation.groupId === groupId && operation.pairId !== null)
      .map(({ operationId }) => operationId);
    if (preparedArtifacts === null) {
      if (incomingArtifactPrefix !== null) {
        for (const selected of selectedPairs) {
          prefixOperationIdsByPair[selected.bindingKey] = Object.freeze([incomingArtifactPrefix]);
        }
      }
      continue;
    }
    let migrationOperation: ExecutableOperation | null = null;
    if (
      observation.manifest?.state === 'present' &&
      observation.manifest.sourceVersion === 'legacy'
    ) {
      const migration = observation.manifest.migration;
      if (migration === null || !('resultSource' in migration)) {
        return err(flipRefusedError('legacy sync manifest lacks exact migration bytes'));
      }
      const migratedBytes = new TextEncoder().encode(migration.resultSource);
      const after = artifactManifestImageFromBytesV1(pair.file.path, migratedBytes);
      migrationOperation = syncArtifactOperation({
        groupId,
        kind: 'migrate-project-config',
        before: manifestImage,
        after,
        dependencies: incomingArtifactPrefix === null ? [] : [incomingArtifactPrefix],
        selectionSource,
      });
      preparedOperations.push({
        operation: migrationOperation,
        action: {
          role: 'manifest',
          action: { kind: 'edit', request: { edits: [{ kind: 'migrate-legacy' }] } },
        },
      });
      manifestImage = after;
    }
    const preLiveArtifactIds = Object.freeze([
      ...new Set([
        ...(incomingArtifactPrefix === null ? [] : [incomingArtifactPrefix]),
        ...(migrationOperation === null ? [] : [migrationOperation.operationId]),
      ]),
    ]);
    const removalOnly = convergences.length === 0 && removals.length > 0;
    if (removalOnly && preLiveArtifactIds.length > 0) {
      for (const selected of selectedPairs) {
        prefixOperationIdsByPair[selected.bindingKey] = preLiveArtifactIds;
      }
    }
    let manifestOperation: ExecutableOperation | null = null;
    const finalManifest = artifactManifestImageFromBytesV1(
      pair.file.path,
      preparedArtifacts.manifestBytes,
    );
    if (
      preparedArtifacts.manifestChanged &&
      canonicalPlanningString(manifestImage) !== canonicalPlanningString(finalManifest)
    ) {
      manifestOperation = syncArtifactOperation({
        groupId,
        kind: 'write-manifest',
        before: manifestImage,
        after: finalManifest,
        dependencies: [...preLiveArtifactIds, ...(removalOnly ? liveOperationIds : [])],
        selectionSource,
      });
      preparedOperations.push({
        operation: manifestOperation,
        action:
          manifestImage.kind === 'absent'
            ? {
                role: 'manifest',
                action: { kind: 'replace', bytes: preparedArtifacts.manifestBytes },
              }
            : {
                role: 'manifest',
                action: { kind: 'edit', request: { edits: preparedArtifacts.manifestEdits } },
              },
      });
      manifestImage = finalManifest;
    }
    let terminalArtifactOperationId =
      manifestOperation?.operationId ?? migrationOperation?.operationId ?? null;
    if (preparedArtifacts.lockChanged) {
      const after = artifactLockImageFromBytesV1(pair.lockfile.path, preparedArtifacts.lockBytes);
      const lockOperation = syncArtifactOperation({
        groupId,
        kind: 'write-lock',
        before: lockImage,
        after,
        dependencies: [
          ...preLiveArtifactIds,
          ...(removalOnly ? liveOperationIds : []),
          ...(manifestOperation === null ? [] : [manifestOperation.operationId]),
        ],
        selectionSource,
      });
      preparedOperations.push({
        operation: lockOperation,
        action: { role: 'lock', action: { kind: 'replace', lock: preparedArtifacts.lock } },
      });
      lockImage = after;
      terminalArtifactOperationId = lockOperation.operationId;
    }
    previousArtifactOperationId = terminalArtifactOperationId ?? incomingArtifactPrefix;
    if (!removalOnly && terminalArtifactOperationId !== null) {
      for (const selected of selectedPairs) {
        prefixOperationIdsByPair[selected.bindingKey] = Object.freeze([
          ...new Set([
            ...(incomingArtifactPrefix === null ? [] : [incomingArtifactPrefix]),
            terminalArtifactOperationId,
          ]),
        ]);
      }
    }
    observation = artifactObservationAfter(observation, preparedArtifacts);
  }
  const manifestOperationIds = preparedOperations
    .filter(
      ({ operation }) =>
        operation.kind === 'migrate-project-config' || operation.kind === 'write-manifest',
    )
    .map(({ operation }) => operation.operationId);
  const lockOperationIds = preparedOperations
    .filter(({ operation }) => operation.kind === 'write-lock')
    .map(({ operation }) => operation.operationId);
  const preconditions: ExecutionPrecondition[] = [];
  const roleIds = new Map<'manifest' | 'lock', readonly string[]>([
    ['manifest', manifestOperationIds],
    ['lock', lockOperationIds],
  ]);
  const preconditionIds = new Map<'manifest' | 'lock', string>();
  for (const role of ['manifest', 'lock'] as const) {
    const operationIds = roleIds.get(role) ?? [];
    if (operationIds.length === 0) continue;
    const observeFacts =
      role === 'manifest'
        ? async () => {
            const observed = await readManifestArtifact(ports, pair.file.path);
            if (!observed.ok) throw observed.error;
            return exportArtifactPreconditionFacts(
              { ...initialObservation, manifest: observed.value },
              role,
            );
          }
        : async () => {
            const observed = await readLockArtifact(ports, pair.lockfile.path);
            if (!observed.ok) throw observed.error;
            return exportArtifactPreconditionFacts(
              { ...initialObservation, lock: observed.value },
              role,
            );
          };
    const precondition = createExportArtifactPrecondition(
      initialObservation,
      role,
      operationIds,
      observeFacts,
    );
    preconditions.push(precondition);
    preconditionIds.set(role, precondition.preconditionId);
  }
  const operations = preparedOperations.map(({ operation, action }) => {
    const role = operation.kind === 'write-lock' ? 'lock' : 'manifest';
    const preconditionId = preconditionIds.get(role);
    if (preconditionId === undefined) throw new Error('sync artifact precondition is missing');
    return Object.freeze({
      operation: Object.freeze({
        ...operation,
        preconditionIds: Object.freeze([preconditionId]),
      }),
      action,
    });
  });
  return ok(
    Object.freeze({
      pair,
      operations: Object.freeze(operations),
      preconditions: Object.freeze(preconditions),
      prefixOperationIdsByPair: Object.freeze(prefixOperationIdsByPair),
    }),
  );
};
