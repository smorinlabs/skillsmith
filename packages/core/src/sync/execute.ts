import { basename, dirname, join, resolve } from 'node:path';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import type { SyncReportV1Dto } from '../contracts/v1/sync.ts';
import { flipRefusedError } from '../errors.ts';
import type { ObservationBundle } from '../observation/index.ts';
import {
  type PlacementStoreResource,
  createPlacementExecutionInput,
  executePlacementPlanWithObservation,
  executeRecordOnlyPlacementPlanWithObservation,
  placementSnapshotResourceId,
} from '../place/execute.ts';
import { getLedgerPairAt, withLedgerPairAt } from '../place/ledger.ts';
import { clampStoreNs } from '../place/store.ts';
import { FLIP_TOOLS, type FlipTool, type OriginRecord, type Provenance } from '../place/types.ts';
import type {
  FlipDeps,
  FlipOptions,
  PairRecord,
  PinnedRecord,
  PlacementPorts,
  SwapExecutionResult,
  SwapOutcome,
  SwapPlan,
} from '../place/types.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { ExecutableOperation } from '../planning/types.ts';
import type {
  SyncFleetResourceSelectionV1,
  SyncFleetSelectedPairV1,
  SyncFleetStoreBindingsV1,
} from './plan.ts';

export interface PreparedSyncStoreV1 {
  readonly bindingKey: string;
  readonly sourcePath: string;
  readonly skill: string;
  readonly provenance: Provenance;
  readonly storePath: string;
  readonly rev: string;
  readonly contentHash: `sha256:${string}`;
}

export interface PreparedSyncStoreResourcesV1 {
  readonly stores: ReadonlyMap<string, PreparedSyncStoreV1>;
  readonly resources: readonly PlacementStoreResource[];
  readonly bindings: SyncFleetStoreBindingsV1;
}

const syncStoreProvenanceV1 = (pair: SyncFleetSelectedPairV1): Provenance => {
  const source = pair.operationSource;
  if (source?.kind === 'portable') {
    const clamped = clampStoreNs(source.identity.repository);
    return Object.freeze({
      kind: 'git-clean',
      repoRoot: null,
      sourceRelPath: source.sourcePath,
      remote: source.identity.repository,
      gitSha: source.resolvedSha,
      ns: clamped.ns,
      name: clamped.name,
      dirtySummary: null,
    });
  }
  return Object.freeze({
    kind: 'non-git',
    repoRoot: null,
    sourceRelPath: null,
    remote: null,
    gitSha: null,
    ns: 'local',
    name: basename(pair.store?.sourcePath ?? pair.pair.skill),
    dirtySummary: null,
  });
};

/** Project selected sync stores to their exact durable paths and snapshot resource identities. */
export const prepareSyncStoreResourcesV1 = (
  selection: SyncFleetResourceSelectionV1,
  storeRoot: string,
): Readonly<PreparedSyncStoreResourcesV1> => {
  const stores = new Map<string, PreparedSyncStoreV1>();
  const resources = new Map<string, PlacementStoreResource>();
  const storeResourceIdsByPair: Record<string, string> = {};
  for (const descriptor of selection.stores) {
    const pair = selection.pairs.find(({ bindingKey }) => bindingKey === descriptor.bindingKey);
    if (pair === undefined) throw new Error('selected sync store has no exact pair');
    const provenance = syncStoreProvenanceV1(pair);
    const hash12 = descriptor.contentHash.slice('sha256:'.length, 'sha256:'.length + 12);
    const rev =
      provenance.kind === 'git-clean'
        ? (provenance.gitSha?.slice(0, 12) ?? '')
        : provenance.kind === 'git-dirty'
          ? `dirty-${hash12}`
          : `content-${hash12}`;
    if (rev.length === 0) throw new Error('selected sync store revision is unavailable');
    const storePath = join(storeRoot, provenance.ns, `${provenance.name}@${rev}`, descriptor.skill);
    const resourceId = placementSnapshotResourceId('store', resolve(storePath));
    const prepared = Object.freeze({
      bindingKey: descriptor.bindingKey,
      sourcePath: descriptor.sourcePath,
      skill: descriptor.skill,
      provenance,
      storePath,
      rev,
      contentHash: descriptor.contentHash,
    });
    stores.set(descriptor.bindingKey, prepared);
    storeResourceIdsByPair[descriptor.bindingKey] = resourceId;
    const existing = resources.get(resourceId);
    if (existing !== undefined && existing.contentHash !== descriptor.contentHash) {
      throw new Error('selected sync stores collide with different content');
    }
    resources.set(
      resourceId,
      Object.freeze({ resourceId, storePath, contentHash: descriptor.contentHash }),
    );
  }
  return Object.freeze({
    stores,
    resources: Object.freeze([...resources.values()]),
    bindings: Object.freeze({ storeResourceIdsByPair: Object.freeze(storeResourceIdsByPair) }),
  });
};

/** Canonical detached wire projection for one executable sync operation. */
export const toSyncReportOperationV1 = (
  operation: ExecutableOperation,
): SyncReportV1Dto['operations'][number] => {
  const { dependencyMetadata, ...value } = operation;
  return Object.freeze({
    ...value,
    dependsOn: Object.freeze([...dependencyMetadata.operationIds]),
    preconditionIds: Object.freeze([...value.preconditionIds]),
    requiredCheckIds: Object.freeze([...value.requiredCheckIds]),
    reversibility: Object.freeze({
      ...value.reversibility,
      retentionResourceIds: Object.freeze([...value.reversibility.retentionResourceIds]),
    }),
  }) as SyncReportV1Dto['operations'][number];
};

export interface SyncPlacementExecutionBindingV1 {
  readonly operationId: string;
  readonly placementPath: string;
  readonly scopeKey: string | null;
  readonly storePath: string | null;
  readonly pinned: PinnedRecord | null;
  /** Required for portable placement, forbidden for machine-bound placement. */
  readonly origin: OriginRecord | null;
}

export type SyncPlacementExecutionPlanV1 =
  | Readonly<{ readonly kind: 'swap'; readonly plan: SwapPlan }>
  | Readonly<{ readonly kind: 'record-only'; readonly pair: PairRecord }>;

const refused = (message: string): never => {
  throw flipRefusedError(message);
};

/** Translate one approved sync operation into the existing placement swap/record-only authority. */
export const createSyncPlacementExecutionPlanV1 = (
  operation: ExecutableOperation,
  binding: SyncPlacementExecutionBindingV1,
): SyncPlacementExecutionPlanV1 => {
  if (
    binding.operationId !== operation.operationId ||
    operation.skill === null ||
    operation.tool === null ||
    !(FLIP_TOOLS as readonly string[]).includes(operation.tool) ||
    operation.scope === null ||
    operation.pairId === null
  ) {
    return refused('sync placement execution binding is incomplete');
  }
  const resource =
    operation.after.kind === 'placement'
      ? operation.after.resource
      : operation.before.kind === 'placement'
        ? operation.before.resource
        : operation.before.kind === 'absent' && operation.before.resource.kind === 'live'
          ? operation.before.resource
          : null;
  if (
    resource === null ||
    resource.skill !== operation.skill ||
    resource.tool !== operation.tool ||
    resource.scope !== operation.scope ||
    resource.location.kind !== 'machine-bound' ||
    resource.location.path !== binding.placementPath ||
    (operation.scope === 'user' ? binding.scopeKey !== null : binding.scopeKey === null)
  ) {
    return refused('sync placement execution binding targets another destination');
  }

  if (operation.kind === 'remove') {
    if (operation.after.kind !== 'absent') {
      return refused('sync remove after-image is invalid');
    }
    return {
      kind: 'swap',
      plan: {
        op: 'uninstall',
        skill: operation.skill,
        tool: operation.tool as FlipTool,
        scopeKey: binding.scopeKey,
        skillsRoot: dirname(binding.placementPath),
        placementPath: binding.placementPath,
      },
    };
  }

  if (
    (operation.kind !== 'install' && operation.kind !== 'update' && operation.kind !== 'repair') ||
    operation.source === null ||
    operation.after.kind !== 'placement' ||
    operation.after.classification !== 'pinned' ||
    operation.after.dangling ||
    operation.after.source === null ||
    canonicalPlanningString(operation.after.source) !== canonicalPlanningString(operation.source) ||
    operation.after.contentHash !== operation.source.contentHash ||
    binding.storePath === null ||
    binding.pinned === null ||
    binding.pinned.storePath !== binding.storePath ||
    binding.pinned.contentHash !== operation.source.contentHash ||
    (binding.pinned.placement ?? 'copy') !== operation.after.representation
  ) {
    return refused('sync convergence execution binding is incoherent');
  }
  if (operation.source.kind === 'local-dev') {
    if (
      binding.origin !== null ||
      operation.after.representation !== 'copy' ||
      operation.after.linkTarget !== null ||
      binding.pinned.gitSha !== null
    ) {
      return refused('machine-bound sync cannot carry portable provenance or a live link');
    }
  } else if (
    binding.origin === null ||
    binding.origin.host !== operation.source.identity.host ||
    binding.origin.repo !== operation.source.identity.repository ||
    binding.origin.skillPath !== operation.source.sourcePath ||
    binding.origin.refRequested !== operation.source.requestedRef ||
    binding.origin.refResolved !== operation.source.resolvedSha
  ) {
    return refused('portable sync origin differs from its exact source');
  }

  const pair: PairRecord = {
    placementPath: binding.placementPath,
    mode: 'pinned',
    dev: null,
    pinned: binding.pinned,
    ...(binding.origin === null ? {} : { origin: binding.origin }),
    journal: null,
  };
  const recordOnly =
    operation.kind === 'repair' &&
    operation.before.kind === 'placement' &&
    operation.before.representation === operation.after.representation &&
    operation.before.contentHash === operation.after.contentHash &&
    operation.before.linkTarget === operation.after.linkTarget &&
    operation.conflict === null;
  if (recordOnly) return { kind: 'record-only', pair };
  return {
    kind: 'swap',
    plan: {
      op: 'install',
      skill: operation.skill,
      tool: operation.tool as FlipTool,
      scopeKey: binding.scopeKey,
      skillsRoot: dirname(binding.placementPath),
      placementPath: binding.placementPath,
      install: {
        build: operation.after.representation,
        storePath: binding.storePath,
        contentHash: operation.source.contentHash,
        pinned: binding.pinned,
        origin: binding.origin,
        adoptedDev: null,
      },
    },
  };
};

export interface ExecuteSyncPlacementV1Input {
  readonly env: PlacementPorts;
  readonly ledgerPath: string;
  readonly ledger: LedgerModel;
  readonly operation: ExecutableOperation;
  readonly binding: SyncPlacementExecutionBindingV1;
  readonly force: boolean;
  readonly deps: Pick<FlipDeps, 'now' | 'newTxId'>;
  readonly options: Pick<FlipOptions, 'testPauseAt' | 'signal'>;
  readonly observation?: ObservationBundle;
}

export const executeSyncPlacementV1 = async (
  input: ExecuteSyncPlacementV1Input,
): Promise<SwapExecutionResult<SwapOutcome>> => {
  if (input.operation.conflict !== null && !input.force) {
    return {
      ok: false,
      error: flipRefusedError('sync destination conflict requires explicit force'),
      state: { ledger: input.ledger },
    };
  }
  let prepared: SyncPlacementExecutionPlanV1;
  try {
    prepared = createSyncPlacementExecutionPlanV1(input.operation, input.binding);
  } catch (error) {
    return {
      ok: false,
      error:
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as ReturnType<typeof flipRefusedError>)
          : flipRefusedError('sync placement execution binding is invalid'),
      state: { ledger: input.ledger },
    };
  }
  let executionLedger = input.ledger;
  if (
    input.operation.kind === 'remove' &&
    input.operation.conflict !== null &&
    input.force &&
    input.operation.skill !== null &&
    input.operation.tool !== null &&
    getLedgerPairAt(
      executionLedger,
      input.binding.scopeKey,
      input.operation.skill,
      input.operation.tool,
    ) === null
  ) {
    const staged = withLedgerPairAt(
      executionLedger,
      input.binding.scopeKey,
      input.operation.skill,
      input.operation.tool,
      {
        placementPath: input.binding.placementPath,
        mode: 'pinned',
        dev: null,
        pinned: null,
        journal: null,
      },
    );
    if (!staged.ok) return { ok: false, error: staged.error, state: { ledger: executionLedger } };
    executionLedger = staged.value;
  }
  const execution = createPlacementExecutionInput(
    input.env,
    input.ledgerPath,
    executionLedger,
    input.deps,
    input.options,
    input.operation,
  );
  if (prepared.kind === 'swap') {
    return executePlacementPlanWithObservation(execution, prepared.plan, input.observation);
  }
  const result = await executeRecordOnlyPlacementPlanWithObservation(
    execution,
    input.operation,
    prepared.pair,
    input.binding.scopeKey,
    input.observation,
  );
  return result.ok
    ? {
        ok: true,
        value: { committed: true, backupKept: null, warning: null },
        state: result.state,
      }
    : result;
};
