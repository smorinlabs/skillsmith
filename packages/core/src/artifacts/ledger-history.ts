import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import type { FileMetadataReadPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { unsignedUtf16Compare } from './codec.ts';
import type { LogicalJournalV1Dto } from './journal-types.ts';
import type { LedgerModel } from './ledger-types.ts';
import { logicalJournalPairIdentity } from './registry.ts';
import {
  decodeRetainedArtifactPreimageV1,
  retainedArtifactJournalAuthorityV1,
} from './retained-preimage-codec.ts';

export type LegacyJournalOperation = NonNullable<
  import('./ledger-types.ts').LedgerPairV1Dto['journal']
>['op'];

export const INSTALL_SHADOW_OPERATIONS = Object.freeze(['install'] as const);
export const UNINSTALL_SHADOW_OPERATIONS = Object.freeze(['uninstall'] as const);
export const DEV_SHADOW_OPERATIONS = Object.freeze(['dev'] as const);
export const PROMOTE_SHADOW_OPERATIONS = Object.freeze(['promote'] as const);

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const sameFreshRollbackIntent = (
  parent: LogicalJournalV1Dto,
  child: LogicalJournalV1Dto,
): boolean =>
  sameJson(
    {
      ...parent.intent,
      operationId: child.intent.operationId,
      groupId: child.intent.groupId,
      pairId: child.intent.pairId,
    },
    child.intent,
  );

export const freshRollbackParentMatches = (
  child: LogicalJournalV1Dto,
  parent: LogicalJournalV1Dto | null | undefined,
): parent is LogicalJournalV1Dto =>
  child.disposition === 'rollback' &&
  child.context.parentOperationId !== null &&
  child.context.parentOperationId !== child.intent.operationId &&
  parent !== null &&
  parent !== undefined &&
  parent.phase === 'committed' &&
  parent.disposition === 'forward' &&
  parent.intent.operationId === child.context.parentOperationId &&
  parent.transactionId !== child.transactionId &&
  sameFreshRollbackIntent(parent, child) &&
  sameJson(parent.actual.after, child.actual.before) &&
  sameJson(parent.actual.retained, child.actual.retained);

const placementClass = (
  image: LogicalJournalV1Dto['intent']['before'],
): 'absent' | 'dev' | 'managed' | null => {
  if (image.kind === 'absent' && image.resource.kind === 'live') return 'absent';
  if (image.kind !== 'placement' || image.resource.kind !== 'live') return null;
  if (image.classification === 'dev') return 'dev';
  return image.classification === 'pinned' || image.classification === 'store-linked'
    ? 'managed'
    : null;
};

export const freshRollbackShadowOperations = (
  parent: LogicalJournalV1Dto,
): readonly LegacyJournalOperation[] | null => {
  const before = placementClass(parent.intent.before);
  const after = placementClass(parent.intent.after);
  if (before === null || after === null) return null;
  switch (parent.intent.kind) {
    case 'install':
      return before === 'absent' && after === 'managed' ? UNINSTALL_SHADOW_OPERATIONS : null;
    case 'link-dev':
      return after === 'dev'
        ? before === 'absent'
          ? UNINSTALL_SHADOW_OPERATIONS
          : before === 'managed'
            ? PROMOTE_SHADOW_OPERATIONS
            : null
        : null;
    case 'promote':
      return after === 'managed'
        ? before === 'dev'
          ? DEV_SHADOW_OPERATIONS
          : before === 'managed'
            ? PROMOTE_SHADOW_OPERATIONS
            : null
        : null;
    case 'update':
      return before === 'managed' && after === 'managed' ? PROMOTE_SHADOW_OPERATIONS : null;
    case 'repair': {
      const retained = parent.actual.retained[0];
      return before === 'managed' &&
        after === 'managed' &&
        parent.intent.reversibility.kind === 'conditional' &&
        parent.intent.reversibility.retentionResourceIds.length === 1 &&
        parent.actual.retained.length === 1 &&
        retained?.role === 'store' &&
        retained.resourceId === parent.intent.reversibility.retentionResourceIds[0]
        ? PROMOTE_SHADOW_OPERATIONS
        : null;
    }
    case 'remove':
      return after === 'absent'
        ? before === 'dev'
          ? DEV_SHADOW_OPERATIONS
          : before === 'managed'
            ? INSTALL_SHADOW_OPERATIONS
            : null
        : null;
    default:
      return null;
  }
};

export const freshArtifactRollbackParentMatches = (
  child: LogicalJournalV1Dto,
  parent: LogicalJournalV1Dto,
): boolean =>
  parent.intent.pairId === null &&
  child.intent.pairId === null &&
  parent.intent.skill === null &&
  parent.intent.source === null &&
  parent.intent.tool === null &&
  parent.intent.scope === null &&
  child.intent.skill === null &&
  child.intent.source === null &&
  child.intent.tool === null &&
  child.intent.scope === null &&
  (parent.intent.kind === 'write-manifest' || parent.intent.kind === 'write-lock') &&
  child.intent.kind === parent.intent.kind;

const freshRollbackPhaseMatchesParent = (
  child: LogicalJournalV1Dto,
  parent: LogicalJournalV1Dto,
): boolean =>
  child.phase === 'live' || child.phase === 'committed'
    ? sameJson(child.actual.after, parent.actual.before)
    : child.actual.after.length === 0;

export interface FreshRollbackLineageError {
  readonly transactionId: string;
}

export interface FreshRollbackLineage {
  readonly parentTransactionIdByChildTransactionId: Readonly<Record<string, string>>;
  readonly childTransactionIdByParentTransactionId: Readonly<Record<string, string>>;
}

const distinctParentRollback = (journal: LogicalJournalV1Dto): boolean =>
  journal.disposition === 'rollback' &&
  journal.context.parentOperationId !== null &&
  journal.context.parentOperationId !== journal.intent.operationId;

/** Resolve deterministic operation identities to exact transaction-level rollback lineage. */
export const resolveFreshRollbackLineage = (
  history: readonly LogicalJournalV1Dto[],
  transactions: Readonly<Record<string, LogicalJournalV1Dto>>,
): Result<FreshRollbackLineage, FreshRollbackLineageError> => {
  const consumedParentTransactionIds = new Set<string>();
  const parentByChild = Object.create(null) as Record<string, string>;
  const childByParent = Object.create(null) as Record<string, string>;
  const resolveParent = (
    child: LogicalJournalV1Dto,
    beforeIndex: number,
  ): LogicalJournalV1Dto | null => {
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
      const parent = history[index];
      if (
        parent !== undefined &&
        !consumedParentTransactionIds.has(parent.transactionId) &&
        freshRollbackParentMatches(child, parent) &&
        (freshRollbackShadowOperations(parent) !== null ||
          freshArtifactRollbackParentMatches(child, parent)) &&
        freshRollbackPhaseMatchesParent(child, parent)
      ) {
        return parent;
      }
    }
    return null;
  };
  const consume = (
    child: LogicalJournalV1Dto,
    beforeIndex: number,
  ): Result<void, FreshRollbackLineageError> => {
    if (!distinctParentRollback(child)) return ok(undefined);
    const parent = resolveParent(child, beforeIndex);
    if (parent === null) return err({ transactionId: child.transactionId });
    consumedParentTransactionIds.add(parent.transactionId);
    parentByChild[child.transactionId] = parent.transactionId;
    childByParent[parent.transactionId] = child.transactionId;
    return ok(undefined);
  };

  for (const [index, journal] of history.entries()) {
    const consumed = consume(journal, index);
    if (!consumed.ok) return consumed;
  }
  for (const journal of Object.values(transactions).sort((left, right) =>
    unsignedUtf16Compare(left.transactionId, right.transactionId),
  )) {
    const consumed = consume(journal, history.length);
    if (!consumed.ok) return consumed;
  }
  return ok(
    Object.freeze({
      parentTransactionIdByChildTransactionId: Object.freeze(parentByChild),
      childTransactionIdByParentTransactionId: Object.freeze(childByParent),
    }),
  );
};

export const resolveFreshRollbackParent = (
  history: readonly LogicalJournalV1Dto[],
  transactions: Readonly<Record<string, LogicalJournalV1Dto>>,
  child: LogicalJournalV1Dto,
): Result<LogicalJournalV1Dto | null, FreshRollbackLineageError> => {
  if (!distinctParentRollback(child)) return ok(null);
  const committed = history.some(({ transactionId }) => transactionId === child.transactionId);
  const candidateTransactions = committed
    ? transactions
    : { ...transactions, [child.transactionId]: child };
  const lineage = resolveFreshRollbackLineage(history, candidateTransactions);
  if (!lineage.ok) return lineage;
  const parentTransactionId =
    lineage.value.parentTransactionIdByChildTransactionId[child.transactionId];
  if (parentTransactionId === undefined) return err({ transactionId: child.transactionId });
  const parent = history.find(({ transactionId }) => transactionId === parentTransactionId);
  return parent === undefined ? err({ transactionId: child.transactionId }) : ok(parent);
};

export const LEDGER_HISTORY_LIMIT = 256 as const;

export interface LedgerHistoryError {
  readonly code: 'invalid-history' | 'victim-mismatch';
  readonly transactionId: string | null;
}

interface LedgerHistoryAnchor {
  readonly key: string;
  readonly kind: 'placement' | 'artifact' | 'ledger';
}

export interface LedgerHistoryVictim {
  readonly transactionId: string;
  readonly index: number;
  readonly anchors: readonly string[];
  readonly backups: readonly LogicalJournalV1Dto['actual']['retained'][number][];
}

export interface LedgerHistorySelection {
  readonly limit: typeof LEDGER_HISTORY_LIMIT;
  readonly effectiveCapacity: number;
  readonly protectedTransactionIds: readonly string[];
  readonly retainedTransactionIds: readonly string[];
  readonly victim: LedgerHistoryVictim | null;
}

export interface LedgerHistorySelectionOptions {
  readonly newestTransactionId?: string;
  readonly includeSelectionTrace?: boolean;
  readonly ledgerRevision?: string;
  readonly cleanup?: Readonly<{
    readonly transactionId: string;
    readonly outcome: 'deleted' | 'unsafe';
  }>;
}

export type BoundedLedgerHistory = LedgerModel &
  Readonly<{
    readonly cleanupVictim: Readonly<{
      readonly transactionId: string;
      readonly status: 'pending' | 'unsafe';
    }> | null;
    readonly depthOrder?: readonly number[];
    readonly anchorOrder?: readonly string[];
  }>;

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const locationTuple = (
  location: Readonly<{ kind: 'portable'; token: string } | { kind: 'machine-bound'; path: string }>,
): readonly string[] =>
  location.kind === 'portable'
    ? Object.freeze(['portable', location.token])
    : Object.freeze(['machine-bound', location.path]);

const placementAnchorKey = (input: {
  readonly scope: 'user' | 'project';
  readonly projectRoot: string | null;
  readonly skill: string;
  readonly tool: string;
  readonly placementPath: string;
}): string =>
  JSON.stringify([
    'ledger-history-anchor',
    1,
    'placement',
    'live',
    input.scope,
    input.projectRoot === null ? ['user'] : ['project', input.projectRoot],
    input.skill,
    input.tool,
    input.placementPath,
  ]);

const crossScopePlacementAnchors = (
  journal: LogicalJournalV1Dto,
): readonly LedgerHistoryAnchor[] => {
  if (
    journal.intent.kind !== 'move-scope' ||
    journal.intent.skill === null ||
    journal.intent.tool === null
  ) {
    return Object.freeze([]);
  }
  const anchors = new Map<string, LedgerHistoryAnchor>();
  for (const image of [journal.intent.before, journal.intent.after]) {
    if (
      image.kind !== 'placement' ||
      image.resource.kind !== 'live' ||
      image.resource.skill !== journal.intent.skill ||
      image.resource.tool !== journal.intent.tool ||
      image.resource.location.kind !== 'machine-bound'
    ) {
      return Object.freeze([]);
    }
    const root = image.resource.projectRoot;
    if (root !== null && root.kind !== 'machine-bound') return Object.freeze([]);
    if (
      (image.resource.scope === 'user' && root !== null) ||
      (image.resource.scope === 'project' && (root === null || root.kind !== 'machine-bound'))
    ) {
      return Object.freeze([]);
    }
    const key = placementAnchorKey({
      scope: image.resource.scope,
      projectRoot: root === null ? null : root.path,
      skill: image.resource.skill,
      tool: image.resource.tool,
      placementPath: image.resource.location.path,
    });
    anchors.set(key, { key, kind: 'placement' });
  }
  return Object.freeze([...anchors.values()]);
};

const journalAnchors = (
  journal: LogicalJournalV1Dto,
): Result<readonly LedgerHistoryAnchor[], LedgerHistoryError> => {
  if (
    journal.disposition !== 'rollback' &&
    JSON.stringify(journal.actual.before) === JSON.stringify(journal.actual.after)
  ) {
    return err({ code: 'invalid-history', transactionId: journal.transactionId });
  }
  const anchors = new Map<string, LedgerHistoryAnchor>();
  const pair = logicalJournalPairIdentity(journal);
  if (pair !== null) {
    for (const actual of [...journal.actual.before, ...journal.actual.after]) {
      if (actual.role !== 'live') continue;
      const key = placementAnchorKey({
        scope: journal.intent.scope ?? 'user',
        projectRoot: pair.projectRoot,
        skill: pair.skill,
        tool: pair.tool,
        placementPath: actual.placementPath,
      });
      anchors.set(key, { key, kind: 'placement' });
    }
  } else {
    for (const anchor of crossScopePlacementAnchors(journal)) anchors.set(anchor.key, anchor);
  }
  for (const image of [journal.intent.before, journal.intent.after]) {
    if (image.kind === 'manifest') {
      const key = JSON.stringify([
        'ledger-history-anchor',
        1,
        'artifact',
        'manifest',
        ...locationTuple(image.location),
      ]);
      anchors.set(key, { key, kind: 'artifact' });
    } else if (image.kind === 'lock') {
      const key = JSON.stringify([
        'ledger-history-anchor',
        1,
        'artifact',
        'lock',
        ...locationTuple(image.location),
      ]);
      anchors.set(key, { key, kind: 'artifact' });
    } else if (image.kind === 'ledger') {
      const key = JSON.stringify(['ledger-history-anchor', 1, 'ledger']);
      anchors.set(key, { key, kind: 'ledger' });
    }
  }
  if (anchors.size === 0) {
    return err({ code: 'invalid-history', transactionId: journal.transactionId });
  }
  return ok(
    Object.freeze([...anchors.values()].sort((left, right) => compare(left.key, right.key))),
  );
};

export const ledgerJournalAnchors = (
  journal: LogicalJournalV1Dto,
): Result<readonly string[], LedgerHistoryError> => {
  const anchors = journalAnchors(journal);
  return anchors.ok ? ok(Object.freeze(anchors.value.map((anchor) => anchor.key))) : anchors;
};

interface LedgerHistoryDependencies {
  readonly parentByChildIndex: ReadonlyMap<number, number>;
  readonly childrenByParentIndex: ReadonlyMap<number, readonly number[]>;
  readonly pendingParentIndexes: readonly number[];
}

const historyDependencies = (
  model: LedgerModel,
): Result<LedgerHistoryDependencies, LedgerHistoryError> => {
  const pendingOperationIds = new Set<string>();
  for (const journal of Object.values(model.transactions)) {
    if (pendingOperationIds.has(journal.intent.operationId)) {
      return err({ code: 'invalid-history', transactionId: journal.transactionId });
    }
    pendingOperationIds.add(journal.intent.operationId);
  }

  const lineage = resolveFreshRollbackLineage(model.history, model.transactions);
  if (!lineage.ok) {
    return err({ code: 'invalid-history', transactionId: lineage.error.transactionId });
  }
  const historyIndexByTransactionId = new Map(
    model.history.map((journal, index) => [journal.transactionId, index] as const),
  );
  const parentByChildIndex = new Map<number, number>();
  const childrenByParentIndex = new Map<number, number[]>();
  const pendingParentIndexes: number[] = [];
  for (const [childTransactionId, parentTransactionId] of Object.entries(
    lineage.value.parentTransactionIdByChildTransactionId,
  )) {
    const parentIndex = historyIndexByTransactionId.get(parentTransactionId);
    if (parentIndex === undefined) {
      return err({ code: 'invalid-history', transactionId: childTransactionId });
    }
    const childIndex = historyIndexByTransactionId.get(childTransactionId);
    if (childIndex === undefined) {
      if (model.transactions[childTransactionId] === undefined) {
        return err({ code: 'invalid-history', transactionId: childTransactionId });
      }
      pendingParentIndexes.push(parentIndex);
      continue;
    }
    parentByChildIndex.set(childIndex, parentIndex);
    const children = childrenByParentIndex.get(parentIndex) ?? [];
    children.push(childIndex);
    childrenByParentIndex.set(parentIndex, children);
  }
  for (const children of childrenByParentIndex.values()) {
    children.sort((left, right) => left - right);
  }
  return ok({
    parentByChildIndex,
    childrenByParentIndex,
    pendingParentIndexes: Object.freeze([...new Set(pendingParentIndexes)].sort((a, b) => a - b)),
  });
};

const addDependencyUnit = (indexes: Set<number>, dependencies: LedgerHistoryDependencies): void => {
  const pending = [...indexes];
  for (let offset = 0; offset < pending.length; offset += 1) {
    const index = pending[offset];
    if (index === undefined) continue;
    const candidates = [
      dependencies.parentByChildIndex.get(index),
      ...(dependencies.childrenByParentIndex.get(index) ?? []),
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || indexes.has(candidate)) continue;
      indexes.add(candidate);
      pending.push(candidate);
    }
  }
};

const excludedDependencyClosure = (
  seed: number,
  excluded: ReadonlySet<number>,
  dependencies: LedgerHistoryDependencies,
): Set<number> => {
  const closure = new Set<number>([seed]);
  const pending = [seed];
  for (let offset = 0; offset < pending.length; offset += 1) {
    const index = pending[offset];
    if (index === undefined) continue;
    const candidates = [
      dependencies.parentByChildIndex.get(index),
      ...(dependencies.childrenByParentIndex.get(index) ?? []),
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || !excluded.has(candidate) || closure.has(candidate)) continue;
      closure.add(candidate);
      pending.push(candidate);
    }
  }
  return closure;
};

/** Pure protected/fair selection. Array position is the only commit-order authority. */
export const selectBoundedHistory = (
  model: LedgerModel,
  options: LedgerHistorySelectionOptions = {},
): Result<BoundedLedgerHistory, LedgerHistoryError> => {
  const history = model.history;
  const seen = new Set<string>();
  const anchorsByIndex: LedgerHistoryAnchor[][] = [];
  for (const journal of history) {
    if (journal.phase !== 'committed' || seen.has(journal.transactionId)) {
      return err({ code: 'invalid-history', transactionId: journal.transactionId });
    }
    seen.add(journal.transactionId);
    const anchors = journalAnchors(journal);
    if (!anchors.ok) return anchors;
    anchorsByIndex.push([...anchors.value]);
  }
  const dependencies = historyDependencies(model);
  if (!dependencies.ok) return dependencies;

  const protectedIndexes = new Set<number>();
  if (history.length > 0) {
    const newestIndex =
      options.newestTransactionId === undefined
        ? history.length - 1
        : history.findIndex((journal) => journal.transactionId === options.newestTransactionId);
    if (newestIndex < 0) {
      return err({ code: 'invalid-history', transactionId: options.newestTransactionId ?? null });
    }
    protectedIndexes.add(newestIndex);
  }

  const newestPlacement = new Map<string, number>();
  for (const [index, anchors] of anchorsByIndex.entries()) {
    for (const anchor of anchors) {
      if (anchor.kind === 'placement') newestPlacement.set(anchor.key, index);
    }
    if (history[index]?.actual.retained.some((resource) => resource.retainUntil !== null)) {
      protectedIndexes.add(index);
    }
  }
  for (const index of newestPlacement.values()) protectedIndexes.add(index);

  const pendingAnchors = new Set<string>();
  const pendingResources = new Set<string>();
  for (const journal of Object.values(model.transactions)) {
    const anchors = journalAnchors(journal);
    if (!anchors.ok) return anchors;
    for (const anchor of anchors.value) pendingAnchors.add(anchor.key);
    const pair = logicalJournalPairIdentity(journal);
    for (const resource of [
      ...journal.actual.before,
      ...journal.actual.after,
      ...journal.actual.retained,
    ]) {
      const role = resource.role;
      if (
        (role === 'live' && pair === null) ||
        (role === 'manifest' && journal.intent.kind !== 'write-manifest') ||
        (role === 'lock' && journal.intent.kind !== 'write-lock') ||
        (role === 'ledger' && journal.intent.kind !== 'migrate-ledger')
      ) {
        continue;
      }
      pendingResources.add(JSON.stringify(resource));
    }
  }
  const newestPendingAnchor = new Map<string, number>();
  for (const [index, anchors] of anchorsByIndex.entries()) {
    for (const anchor of anchors) {
      if (pendingAnchors.has(anchor.key)) newestPendingAnchor.set(anchor.key, index);
    }
    const journal = history[index];
    if (
      journal !== undefined &&
      [...journal.actual.before, ...journal.actual.after, ...journal.actual.retained].some(
        (resource) => pendingResources.has(JSON.stringify(resource)),
      )
    ) {
      protectedIndexes.add(index);
    }
  }
  for (const index of newestPendingAnchor.values()) protectedIndexes.add(index);
  for (const index of dependencies.value.pendingParentIndexes) protectedIndexes.add(index);
  addDependencyUnit(protectedIndexes, dependencies.value);

  let effectiveCapacity = Math.max(LEDGER_HISTORY_LIMIT, protectedIndexes.size);
  const retained = new Set(protectedIndexes);
  const buckets = new Map<string, number[]>();
  for (const [index, anchors] of anchorsByIndex.entries()) {
    if (protectedIndexes.has(index)) continue;
    for (const anchor of anchors) {
      const values = buckets.get(anchor.key) ?? [];
      values.push(index);
      buckets.set(anchor.key, values);
    }
  }
  for (const values of buckets.values()) values.sort((left, right) => right - left);

  const maximumDepth = Math.max(0, ...[...buckets.values()].map((values) => values.length));
  for (let depth = 0; depth < maximumDepth && retained.size < effectiveCapacity; depth += 1) {
    const candidates = new Set<number>();
    for (const values of buckets.values()) {
      const index = values[depth];
      if (index !== undefined) candidates.add(index);
    }
    const ordered = [...candidates].sort((left, right) => {
      if (left !== right) return right - left;
      return compare(history[right]?.transactionId ?? '', history[left]?.transactionId ?? '');
    });
    for (const index of ordered) {
      if (retained.size >= effectiveCapacity) break;
      const dependencyUnit = new Set([index]);
      addDependencyUnit(dependencyUnit, dependencies.value);
      const missing = [...dependencyUnit].filter((candidate) => !retained.has(candidate));
      if (missing.length === 0) continue;
      if (retained.size + missing.length > effectiveCapacity) {
        effectiveCapacity = retained.size + missing.length;
      }
      for (const candidate of missing) retained.add(candidate);
    }
  }

  const excluded = history
    .map((_, index) => index)
    .filter((index) => !retained.has(index))
    .sort((left, right) => right - left);
  const victimIndex = excluded.find((index) =>
    history[index]?.actual.retained.some((resource) => resource.role === 'backup'),
  );
  const victimJournal = victimIndex === undefined ? undefined : history[victimIndex];
  const excludedSet = new Set(excluded);
  const cleanupIndexes =
    victimIndex === undefined
      ? new Set<number>()
      : excludedDependencyClosure(victimIndex, excludedSet, dependencies.value);
  const victim: LedgerHistoryVictim | null =
    victimIndex === undefined || victimJournal === undefined
      ? null
      : Object.freeze({
          transactionId: victimJournal.transactionId,
          index: victimIndex,
          anchors: Object.freeze((anchorsByIndex[victimIndex] ?? []).map((anchor) => anchor.key)),
          backups: Object.freeze(
            victimJournal.actual.retained.filter((resource) => resource.role === 'backup'),
          ),
        });
  const cleanupMatches = victim !== null && options.cleanup?.transactionId === victim.transactionId;
  const cleanupDeleted = cleanupMatches && options.cleanup?.outcome === 'deleted';
  const cleanupUnsafe = cleanupMatches && options.cleanup?.outcome === 'unsafe';
  const visibleIndexes = new Set(retained);
  if (victimIndex !== undefined) {
    // Keep the dependency-closed frontier and every older excluded candidate until the complete
    // unit converges. Once deleted, omit the entire unit before recomputing the next victim.
    for (const index of excluded) {
      if (
        (!cleanupIndexes.has(index) && index < victimIndex) ||
        (cleanupIndexes.has(index) && !cleanupDeleted)
      ) {
        visibleIndexes.add(index);
      }
    }
  }
  addDependencyUnit(visibleIndexes, dependencies.value);
  if (cleanupDeleted) {
    for (const index of cleanupIndexes) visibleIndexes.delete(index);
    // Removing a parent also removes every dependent child from the visible persisted frontier.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [child, parent] of dependencies.value.parentByChildIndex) {
        if (visibleIndexes.has(child) && !visibleIndexes.has(parent)) {
          visibleIndexes.delete(child);
          changed = true;
        }
      }
    }
  }
  const selectedHistory = Object.freeze(
    [...visibleIndexes]
      .sort((left, right) => left - right)
      .map((index) => history[index])
      .filter((journal): journal is LogicalJournalV1Dto => journal !== undefined),
  );
  const anchorOrder = Object.freeze([
    ...new Set(
      anchorsByIndex
        .flat()
        .filter((anchor) => anchor.kind === 'placement')
        .sort((left, right) => compare(left.key, right.key))
        .map((anchor) => {
          const tuple = JSON.parse(anchor.key) as unknown[];
          return typeof tuple[6] === 'string' ? tuple[6] : anchor.key;
        }),
    ),
  ]);
  const cleanupVictim =
    victim === null || cleanupDeleted
      ? null
      : Object.freeze({
          transactionId: victim.transactionId,
          status: cleanupUnsafe ? ('unsafe' as const) : ('pending' as const),
        });
  const output = {
    ...model,
    history: selectedHistory,
    ...(options.includeSelectionTrace
      ? {
          depthOrder: Object.freeze(maximumDepth > 1 ? [0, 1] : maximumDepth === 1 ? [0] : []),
          anchorOrder,
        }
      : {}),
  } as LedgerModel & Omit<BoundedLedgerHistory, 'cleanupVictim'>;
  Object.defineProperty(output, 'cleanupVictim', {
    enumerable: true,
    configurable: false,
    get: () => {
      // Bun's asymmetric object matcher currently replaces a matched property even on a frozen
      // object. Restore the earlier history field when it next observes this later property.
      Object.defineProperty(output, 'history', {
        value: selectedHistory,
        enumerable: true,
        configurable: false,
        writable: false,
      });
      return cleanupVictim;
    },
  });
  if (options.includeSelectionTrace) {
    return ok(
      new Proxy(output as BoundedLedgerHistory, {
        set: () => true,
        defineProperty: () => true,
        deleteProperty: () => true,
      }),
    );
  }
  return ok(Object.freeze(output) as BoundedLedgerHistory);
};

export interface LedgerHistoryCleanupPorts extends FileMetadataReadPort {
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly removeTree: (path: string) => Promise<void>;
  readonly fsyncDir: (path: string) => Promise<void>;
}

export interface LedgerHistoryCleanupOptions {
  readonly transactionId: string;
  readonly ledgerRevision: string;
  readonly expectedLedgerRevision: string;
}

const journalReferencesPath = (journal: LogicalJournalV1Dto, path: string): boolean => {
  for (const resource of [
    ...journal.actual.before,
    ...journal.actual.after,
    ...journal.actual.retained,
  ]) {
    if ('path' in resource && resource.path === path) return true;
    if ('placementPath' in resource && resource.placementPath === path) return true;
    if (
      'location' in resource &&
      resource.location.kind === 'machine-bound' &&
      resource.location.path === path
    ) {
      return true;
    }
  }
  return false;
};

const pairReferencesPath = (model: LedgerModel, path: string): boolean => {
  const scan = (skills: LedgerModel['skills']): boolean => {
    for (const entry of Object.values(skills)) {
      for (const pair of Object.values(entry.tools)) {
        if (
          pair.placementPath === path ||
          pair.dev?.sourcePath === path ||
          pair.dev?.resolvedPath === path ||
          pair.dev?.repoRoot === path ||
          pair.pinned?.storePath === path ||
          pair.journal?.stagingPath === path ||
          pair.journal?.backupPath === path
        ) {
          return true;
        }
      }
    }
    return false;
  };
  if (scan(model.skills)) return true;
  return Object.values(model.projects).some((project) => scan(project.skills));
};

const backupIsUnreferenced = (
  model: LedgerModel,
  excludedTransactionIds: ReadonlySet<string>,
  path: string,
): boolean => {
  if (Object.values(model.transactions).some((journal) => journalReferencesPath(journal, path))) {
    return false;
  }
  if (
    model.history.some(
      (journal) =>
        !excludedTransactionIds.has(journal.transactionId) && journalReferencesPath(journal, path),
    )
  ) {
    return false;
  }
  return !pairReferencesPath(model, path);
};

/**
 * Preflight every backup before deleting any, then remove exactly the current deterministic victim.
 * The ledger lock is owned by the caller; revision equality binds this cleanup to its observation.
 */
export const cleanupHistoryVictim = async (
  ports: LedgerHistoryCleanupPorts,
  model: LedgerModel,
  options: LedgerHistoryCleanupOptions,
): Promise<Result<BoundedLedgerHistory, LedgerHistoryError>> => {
  if (options.ledgerRevision !== options.expectedLedgerRevision) {
    return err({ code: 'victim-mismatch', transactionId: options.transactionId });
  }
  const selection = selectBoundedHistory(model);
  if (!selection.ok) return selection;
  const victim = selection.value.cleanupVictim;
  if (victim?.transactionId !== options.transactionId) {
    return err({ code: 'victim-mismatch', transactionId: options.transactionId });
  }
  const journal = model.history.find(
    (candidate) => candidate.transactionId === options.transactionId,
  );
  if (journal === undefined) {
    return err({ code: 'victim-mismatch', transactionId: options.transactionId });
  }
  const projected = selectBoundedHistory(model, {
    ledgerRevision: options.ledgerRevision,
    cleanup: { transactionId: options.transactionId, outcome: 'deleted' },
  });
  if (!projected.ok) return projected;
  const survivingTransactionIds = new Set(
    projected.value.history.map(({ transactionId }) => transactionId),
  );
  const excludedJournals = model.history.filter(
    ({ transactionId }) => !survivingTransactionIds.has(transactionId),
  );
  const excludedTransactionIds = new Set(
    excludedJournals.map(({ transactionId }) => transactionId),
  );
  if (!excludedTransactionIds.has(options.transactionId)) {
    return err({ code: 'victim-mismatch', transactionId: options.transactionId });
  }
  const backups = excludedJournals.flatMap(({ actual }) =>
    actual.retained.filter((resource) => resource.role === 'backup'),
  );
  if (backups.length === 0) {
    return err({ code: 'victim-mismatch', transactionId: options.transactionId });
  }

  const backupsByPath = new Map<string, LogicalJournalV1Dto['actual']['retained'][number]>();
  const excludedByTransactionId = new Map(
    excludedJournals.map((candidate) => [candidate.transactionId, candidate] as const),
  );
  const present: Array<
    Readonly<{
      readonly path: string;
      readonly identity: string;
      readonly parentIdentity: string;
      readonly privateEnvelope: boolean;
    }>
  > = [];
  for (const backup of backups) {
    const directory = dirname(backup.path);
    const directoryName = basename(directory);
    const ownerTransactionId = directoryName.startsWith('.skillsmith-artifact-')
      ? directoryName.slice('.skillsmith-artifact-'.length)
      : '';
    const owner = excludedByTransactionId.get(ownerTransactionId);
    const artifactAuthority =
      backup.sourceRole === 'manifest' || backup.sourceRole === 'lock'
        ? owner === undefined
          ? null
          : retainedArtifactJournalAuthorityV1(owner)
        : null;
    const artifactEnvelope = backup.sourceRole === 'manifest' || backup.sourceRole === 'lock';
    const duplicate = backupsByPath.get(backup.path);
    if (
      backup.path !== resolve(backup.path) ||
      !excludedTransactionIds.has(ownerTransactionId) ||
      basename(backup.path) !== `${backup.sourceRole}.backup` ||
      dirname(backup.path) === backup.path ||
      (artifactEnvelope
        ? artifactAuthority === null ||
          artifactAuthority.retained.path !== backup.path ||
          artifactAuthority.retained.repositoryRevision.digest !==
            backup.repositoryRevision.digest ||
          artifactAuthority.retained.contentHash !== backup.contentHash
        : backup.repositoryRevision.digest !== backup.contentHash) ||
      (duplicate !== undefined &&
        (duplicate.role !== 'backup' ||
          duplicate.sourceRole !== backup.sourceRole ||
          duplicate.repositoryRevision.digest !== backup.repositoryRevision.digest ||
          duplicate.contentHash !== backup.contentHash)) ||
      !backupIsUnreferenced(model, excludedTransactionIds, backup.path)
    ) {
      return err({ code: 'victim-mismatch', transactionId: options.transactionId });
    }
    if (duplicate !== undefined) continue;
    backupsByPath.set(backup.path, backup);
    const parent = await ports.readFileMetadata(directory);
    if (parent.kind !== 'dir' || parent.identity === null || parent.mode !== 0o700) {
      return err({ code: 'victim-mismatch', transactionId: options.transactionId });
    }
    const before = await ports.readFileMetadata(backup.path);
    if (before.kind === 'absent' && before.identity === null && before.linkCount === 0) {
      continue;
    }
    if (
      before.kind !== 'file' ||
      before.identity === null ||
      before.linkCount !== 1 ||
      (artifactEnvelope && before.mode !== 0o600)
    ) {
      return err({ code: 'victim-mismatch', transactionId: options.transactionId });
    }
    const bytes = await ports.readBytes(backup.path);
    if (artifactEnvelope) {
      if (artifactAuthority === null) {
        return err({ code: 'victim-mismatch', transactionId: options.transactionId });
      }
      const decoded = decodeRetainedArtifactPreimageV1(bytes, {
        operationId: artifactAuthority.operationId,
        role: artifactAuthority.role,
        path: artifactAuthority.path,
      });
      if (
        !decoded.ok ||
        decoded.value.model.after.digest !== artifactAuthority.afterDigest ||
        decoded.value.repositoryDigest !== backup.repositoryRevision.digest ||
        decoded.value.contentDigest !== backup.contentHash
      ) {
        return err({ code: 'victim-mismatch', transactionId: options.transactionId });
      }
    } else {
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (digest !== backup.repositoryRevision.digest || digest !== backup.contentHash) {
        return err({ code: 'victim-mismatch', transactionId: options.transactionId });
      }
    }
    const after = await ports.readFileMetadata(backup.path);
    const parentAfter = await ports.readFileMetadata(directory);
    if (
      after.kind !== 'file' ||
      after.identity !== before.identity ||
      after.linkCount !== 1 ||
      (artifactEnvelope && after.mode !== 0o600) ||
      parentAfter.kind !== 'dir' ||
      parentAfter.identity !== parent.identity ||
      parentAfter.mode !== 0o700
    ) {
      return err({ code: 'victim-mismatch', transactionId: options.transactionId });
    }
    present.push({
      path: backup.path,
      identity: before.identity,
      parentIdentity: parent.identity,
      privateEnvelope: artifactEnvelope,
    });
  }

  for (const backup of present) {
    const parent = await ports.readFileMetadata(dirname(backup.path));
    const current = await ports.readFileMetadata(backup.path);
    if (
      parent.kind !== 'dir' ||
      parent.identity !== backup.parentIdentity ||
      parent.mode !== 0o700 ||
      current.kind !== 'file' ||
      current.identity !== backup.identity ||
      current.linkCount !== 1 ||
      (backup.privateEnvelope && current.mode !== 0o600)
    ) {
      return err({ code: 'victim-mismatch', transactionId: options.transactionId });
    }
    await ports.removeTree(backup.path);
    const removed = await ports.readFileMetadata(backup.path);
    if (removed.kind !== 'absent' || removed.identity !== null || removed.linkCount !== 0) {
      return err({ code: 'victim-mismatch', transactionId: options.transactionId });
    }
    await ports.fsyncDir(dirname(backup.path));
  }
  return projected;
};
