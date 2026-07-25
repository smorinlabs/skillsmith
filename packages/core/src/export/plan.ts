import type { CurrentApplicationContext } from '../application/types.ts';
import { hashManifestBytes, hashManifestSemantics } from '../artifacts/hash.ts';
import type { LedgerReadState } from '../artifacts/ledger-types.ts';
import { hashPortableLock } from '../artifacts/lock.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import { createExecutionPrecondition } from '../execution/index.ts';
import type { ExecutionPrecondition } from '../execution/types.ts';
import { type PreparedLedgerMigration, prepareLedgerMigration } from '../place/ledger-migration.ts';
import {
  createOperationGroupId,
  createOperationId,
  createOperationPlan,
} from '../planning/create.ts';
import type {
  ExecutableOperation,
  OperationDigest,
  OperationId,
  OperationImage,
  OperationManifestSnapshot,
  OperationPlan,
  OperationResourceIdentity,
} from '../planning/types.ts';
import type { PreparedExportArtifacts } from './merge.ts';
import type { ExportObservation } from './observe.ts';

export { prepareExportArtifacts } from './merge.ts';
export { previewExportEffects } from './run.ts';

const encoder = new TextEncoder();

const ledgerStateOf = (observation: ExportObservation): LedgerReadState => {
  const ledger = observation.ledger;
  if (ledger.state === 'absent') {
    return Object.freeze({
      state: 'absent',
      sourceVersion: null,
      bytes: null,
      byteRevision: null,
      semanticRevision: null,
      model: null,
    });
  }
  if (
    (ledger.sourceVersion !== 1 && ledger.sourceVersion !== 2) ||
    ledger.semanticRevision === null
  ) {
    throw new TypeError('observed export ledger is not a supported placement ledger');
  }
  return Object.freeze({
    state: 'present',
    sourceVersion: ledger.sourceVersion,
    bytes: encoder.encode(ledger.source),
    byteRevision: ledger.byteRevision,
    semanticRevision: ledger.semanticRevision,
    model: ledger.model,
  });
};

export const prepareExportLedgerMigration = (
  context: CurrentApplicationContext,
  observation: ExportObservation,
  artifacts: PreparedExportArtifacts,
): PreparedLedgerMigration | null => {
  if (!artifacts.manifestChanged && !artifacts.lockChanged) return null;
  return prepareLedgerMigration(
    context.ports,
    'export',
    'bounded-default',
    observation.ledgerPath,
    ledgerStateOf(observation),
  );
};

const location = (path: string) => Object.freeze({ kind: 'machine-bound' as const, path });

const resource = (
  role: 'manifest' | 'lock',
  path: string,
): Extract<OperationResourceIdentity, { kind: 'manifest-bytes' | 'lock' }> =>
  role === 'manifest'
    ? Object.freeze({ kind: 'manifest-bytes' as const, location: location(path) })
    : Object.freeze({ kind: 'lock' as const, location: location(path) });

const manifestSnapshot = (value: NormalizedManifestV1): OperationManifestSnapshot =>
  Object.freeze({
    version: 1,
    defaults:
      value.defaults === undefined
        ? null
        : Object.freeze({
            tools: value.defaults.tools ?? null,
            scope: value.defaults.scope ?? null,
            path: value.defaults.path ?? null,
          }),
    registry:
      value.registry === undefined
        ? null
        : Object.freeze({ default: value.registry.default ?? null }),
    skills: value.skills,
  });

const manifestImage = (
  path: string,
  bytes: Uint8Array,
  model: NormalizedManifestV1,
  shape: 'canonical' | 'legacy',
): Extract<OperationImage, { kind: 'manifest' }> =>
  Object.freeze({
    kind: 'manifest',
    location: location(path),
    shape,
    version: 1,
    byteHash: hashManifestBytes(bytes) as OperationDigest,
    semanticHash: hashManifestSemantics(model) as OperationDigest,
    value: manifestSnapshot(model),
  });

const lockImage = (
  path: string,
  lock: PreparedExportArtifacts['lock'],
): Extract<OperationImage, { kind: 'lock' }> => {
  const digest = hashPortableLock(lock);
  if (!digest.ok) throw new TypeError('export lock could not be hashed');
  return Object.freeze({
    kind: 'lock',
    location: location(path),
    version: 1,
    canonicalHash: digest.value as OperationDigest,
    value: Object.freeze({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: lock.manifestHash as OperationDigest,
      skills: Object.freeze(
        lock.skills.map((entry) =>
          Object.freeze({ ...entry, contentHash: entry.contentHash as OperationDigest }),
        ),
      ),
    }),
  });
};

const absentImage = (role: 'manifest' | 'lock', path: string): OperationImage =>
  Object.freeze({ kind: 'absent', resource: resource(role, path) });

export const exportArtifactPreconditionFacts = (
  observation: ExportObservation,
  role: 'manifest' | 'lock',
): unknown => {
  const observed = role === 'manifest' ? observation.manifest : observation.lock;
  return observed?.state === 'present'
    ? Object.freeze({
        state: 'present' as const,
        sourceVersion: observed.sourceVersion,
        byteRevision: observed.byteRevision,
        semanticRevision: observed.semanticRevision,
        canonical: observed.canonical,
      })
    : Object.freeze({ state: 'absent' as const });
};

export const createExportArtifactPrecondition = (
  observation: ExportObservation,
  role: 'manifest' | 'lock',
  operationIds: readonly OperationId[],
  observe: () => Promise<unknown>,
): ExecutionPrecondition => {
  if (observation.pair === null) {
    throw new TypeError('export artifact precondition requires a selected pair');
  }
  return createExecutionPrecondition({
    operationIds,
    resource: resource(
      role,
      role === 'manifest' ? observation.pair.file.path : observation.pair.lockfile.path,
    ),
    expected: exportArtifactPreconditionFacts(observation, role),
    observe,
  });
};

const operationFor = (input: {
  readonly groupId: string;
  readonly kind: 'migrate-project-config' | 'write-manifest' | 'write-lock';
  readonly before: OperationImage;
  readonly after: OperationImage;
  readonly dependencies: readonly string[];
  readonly preconditionIds: readonly string[];
}): ExecutableOperation => {
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
  const operationId = createOperationId(identity);
  return Object.freeze({
    operationId,
    groupId: input.groupId,
    pairId: null,
    kind: input.kind,
    dependencyMetadata: Object.freeze({
      domain: 'skillsmith.operation-dependency' as const,
      schemaVersion: 1 as const,
      operationIds: Object.freeze([...input.dependencies]),
    }),
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: input.before,
    after: input.after,
    reason: Object.freeze({
      code: `export-${input.kind}`,
      message: `${input.kind} is required for the selected portable pair.`,
    }),
    selectionSource: 'bounded-default' as const,
    preconditionIds: Object.freeze([...input.preconditionIds]),
    requiredCheckIds: Object.freeze([]),
    reversibility: Object.freeze({
      kind: 'none' as const,
      retentionResourceIds: [] as const,
    }),
    mutates: Object.freeze(
      input.kind === 'write-lock'
        ? { live: false, manifest: false, lock: true, ledger: false }
        : { live: false, manifest: true, lock: false, ledger: false },
    ),
    conflict: null,
  });
};

const projectMigrationBytes = (observation: ExportObservation): Uint8Array | null => {
  const migration = observation.manifest?.migration;
  return migration !== null && migration !== undefined && 'resultSource' in migration
    ? encoder.encode(migration.resultSource)
    : null;
};

export const prepareExportOperationPlan = (
  observation: ExportObservation,
  prepared: PreparedExportArtifacts,
  migration: PreparedLedgerMigration | null = null,
): OperationPlan<'export'> => {
  if (!prepared.manifestChanged && !prepared.lockChanged && migration === null) {
    return createOperationPlan({
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'export',
      selection: {
        source: 'bounded-default',
        tools: observation.request.tools,
        scopes:
          observation.request.scope === 'user' || observation.request.scope === 'project'
            ? [observation.request.scope]
            : [],
      },
      batchPolicy: 'fail-fast',
      operations: [],
      checks: [],
      diagnostics: [],
    });
  }
  if (observation.pair === null) {
    if (prepared.manifestChanged || prepared.lockChanged || migration !== null) {
      throw new TypeError('mutating export plan requires one selected artifact pair');
    }
    return createOperationPlan({
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'export',
      selection: {
        source: 'bounded-default',
        tools: observation.request.tools,
        scopes: [],
      },
      batchPolicy: 'fail-fast',
      operations: [],
      checks: [],
      diagnostics: [],
    });
  }

  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'export',
    skill: null,
    source: null,
    scope:
      observation.request.scope === 'user' || observation.request.scope === 'project'
        ? observation.request.scope
        : null,
    target:
      observation.pair.file.portableToken ??
      observation.pair.file.token ??
      observation.pair.file.path,
  });
  const manifestPath = observation.pair.file.path;
  const lockPath = observation.pair.lockfile.path;
  let currentManifest: OperationImage =
    observation.manifest?.state === 'present'
      ? manifestImage(
          manifestPath,
          encoder.encode(observation.manifest.source),
          observation.manifest.model,
          observation.manifest.sourceVersion === 'legacy' ? 'legacy' : 'canonical',
        )
      : absentImage('manifest', manifestPath);
  const currentLock: OperationImage =
    observation.lock?.state === 'present'
      ? lockImage(lockPath, observation.lock.model)
      : absentImage('lock', lockPath);
  const finalManifest = manifestImage(
    manifestPath,
    prepared.manifestBytes,
    prepared.manifest,
    'canonical',
  );
  const finalLock = lockImage(lockPath, prepared.lock);
  const operations: ExecutableOperation[] = [];
  let dependencies: readonly string[] = [];
  if (migration !== null) operations.push(migration.operation);
  const artifactPreconditions = Object.freeze([] as const);

  if (
    observation.manifest?.state === 'present' &&
    observation.manifest.sourceVersion === 'legacy'
  ) {
    const migratedBytes = projectMigrationBytes(observation);
    if (migratedBytes === null) throw new TypeError('legacy export manifest lacks migration bytes');
    const migrated = manifestImage(
      manifestPath,
      migratedBytes,
      observation.manifest.model,
      'canonical',
    );
    const operation = operationFor({
      groupId,
      kind: 'migrate-project-config',
      before: currentManifest,
      after: migrated,
      dependencies,
      preconditionIds: artifactPreconditions,
    });
    operations.push(operation);
    dependencies = [operation.operationId];
    currentManifest = migrated;
  }
  if (
    prepared.manifestChanged &&
    JSON.stringify(currentManifest) !== JSON.stringify(finalManifest)
  ) {
    const operation = operationFor({
      groupId,
      kind: 'write-manifest',
      before: currentManifest,
      after: finalManifest,
      dependencies,
      preconditionIds: artifactPreconditions,
    });
    operations.push(operation);
    dependencies = [operation.operationId];
  }
  if (prepared.lockChanged) {
    operations.push(
      operationFor({
        groupId,
        kind: 'write-lock',
        before: currentLock,
        after: finalLock,
        dependencies,
        preconditionIds: artifactPreconditions,
      }),
    );
  }

  const artifactOperations = operations.filter(({ kind }) => kind !== 'migrate-ledger');
  const manifestOperationIds = artifactOperations
    .filter(({ kind }) => kind === 'migrate-project-config' || kind === 'write-manifest')
    .map(({ operationId }) => operationId);
  const lockOperationIds = artifactOperations
    .filter(({ kind }) => kind === 'write-lock')
    .map(({ operationId }) => operationId);
  const preconditionIds = new Map<'manifest' | 'lock', string>();
  if (manifestOperationIds.length > 0) {
    preconditionIds.set(
      'manifest',
      createExportArtifactPrecondition(observation, 'manifest', manifestOperationIds, async () =>
        exportArtifactPreconditionFacts(observation, 'manifest'),
      ).preconditionId,
    );
  }
  if (lockOperationIds.length > 0) {
    preconditionIds.set(
      'lock',
      createExportArtifactPrecondition(observation, 'lock', lockOperationIds, async () =>
        exportArtifactPreconditionFacts(observation, 'lock'),
      ).preconditionId,
    );
  }
  const boundOperations = operations.map((operation) => {
    if (operation.kind === 'migrate-ledger') return operation;
    const role = operation.kind === 'write-lock' ? 'lock' : 'manifest';
    const preconditionId = preconditionIds.get(role);
    if (preconditionId === undefined)
      throw new TypeError('export artifact precondition is missing');
    return Object.freeze({ ...operation, preconditionIds: Object.freeze([preconditionId]) });
  });

  return createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'export',
    selection: {
      source: 'bounded-default',
      tools: observation.request.tools,
      scopes:
        observation.request.scope === 'user' || observation.request.scope === 'project'
          ? [observation.request.scope]
          : [],
      groupIds: [...new Set(boundOperations.map((operation) => operation.groupId))],
    },
    batchPolicy: 'fail-fast',
    operations: boundOperations,
    checks: [],
    diagnostics: [],
  });
};
