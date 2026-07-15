import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import { logicalJournalPairIdentity } from '../artifacts/registry.ts';
import { type Result, err, ok } from '../result.ts';

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

const journalAnchors = (
  journal: LogicalJournalV1Dto,
): Result<readonly LedgerHistoryAnchor[], LedgerHistoryError> => {
  if (JSON.stringify(journal.actual.before) === JSON.stringify(journal.actual.after)) {
    return err({ code: 'invalid-history', transactionId: journal.transactionId });
  }
  const anchors = new Map<string, LedgerHistoryAnchor>();
  const pair = logicalJournalPairIdentity(journal);
  if (pair !== null) {
    for (const actual of [...journal.actual.before, ...journal.actual.after]) {
      if (actual.role !== 'live') continue;
      const key = JSON.stringify([
        'ledger-history-anchor',
        1,
        'placement',
        'live',
        journal.intent.scope,
        pair.projectRoot === null ? ['user'] : ['project', pair.projectRoot],
        pair.skill,
        pair.tool,
        actual.placementPath,
      ]);
      anchors.set(key, { key, kind: 'placement' });
    }
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

  const effectiveCapacity = Math.max(LEDGER_HISTORY_LIMIT, protectedIndexes.size);
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
  const representedAnchors = new Set<string>();
  for (const index of retained) {
    for (const anchor of anchorsByIndex[index] ?? []) representedAnchors.add(anchor.key);
  }
  const breadthCandidates = new Set<number>();
  for (const [key, values] of buckets) {
    if (representedAnchors.has(key)) continue;
    const index = values[0];
    if (index !== undefined) breadthCandidates.add(index);
  }
  for (const index of [...breadthCandidates].sort((left, right) => right - left)) {
    if (retained.size >= effectiveCapacity) break;
    retained.add(index);
  }
  for (
    let index = history.length - 1;
    index >= 0 && retained.size < effectiveCapacity;
    index -= 1
  ) {
    retained.add(index);
  }

  const excluded = history
    .map((_, index) => index)
    .filter((index) => !retained.has(index))
    .sort((left, right) => right - left);
  const victimIndex = excluded.find((index) =>
    history[index]?.actual.retained.some((resource) => resource.role === 'backup'),
  );
  const victimJournal = victimIndex === undefined ? undefined : history[victimIndex];
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
  if (victimIndex !== undefined && !cleanupDeleted) {
    // Keep the frontier tombstone and every older excluded candidate until it converges.
    for (const index of excluded) if (index <= victimIndex) visibleIndexes.add(index);
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

export interface LedgerHistoryCleanupPorts {
  readonly pathKind: (path: string) => Promise<'absent' | 'file' | 'dir' | 'symlink'>;
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly removeTree: (path: string) => Promise<void>;
  readonly fsyncDir: (path: string) => Promise<void>;
}

export interface LedgerHistoryCleanupOptions {
  readonly transactionId: string;
  readonly ledgerRevision: string;
  readonly expectedLedgerRevision: string;
  readonly recognizedMissingBackup?: boolean;
  readonly observation?: Readonly<{
    readonly path?: string;
    readonly owned?: boolean;
    readonly linkCount?: number;
    readonly repositoryRevision?: Readonly<{ readonly kind: string; readonly digest: string }>;
    readonly contentHash?: string;
    readonly referencedByPending?: boolean;
    readonly referencedByKeptHistory?: boolean;
    readonly referencedByLegacyJournal?: boolean;
    readonly referencedByLive?: boolean;
  }>;
}

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
  const backups = journal.actual.retained.filter((resource) => resource.role === 'backup');
  const observation = options.observation;
  if (
    backups.length === 0 ||
    observation?.owned === false ||
    (observation?.linkCount !== undefined && observation.linkCount !== 1) ||
    observation?.referencedByPending === true ||
    observation?.referencedByKeptHistory === true ||
    observation?.referencedByLegacyJournal === true ||
    observation?.referencedByLive === true
  ) {
    return err({ code: 'victim-mismatch', transactionId: options.transactionId });
  }

  const present: string[] = [];
  for (const backup of backups) {
    const directory = dirname(backup.path);
    if (
      basename(directory) !== `.skillsmith-transaction-${options.transactionId}` ||
      dirname(backup.path) === backup.path ||
      (observation?.path !== undefined && observation.path !== backup.path) ||
      (observation?.repositoryRevision !== undefined &&
        (observation.repositoryRevision.kind !== backup.repositoryRevision.kind ||
          observation.repositoryRevision.digest !== backup.repositoryRevision.digest)) ||
      (observation?.contentHash !== undefined && observation.contentHash !== backup.contentHash)
    ) {
      return err({ code: 'victim-mismatch', transactionId: options.transactionId });
    }
    const kind = await ports.pathKind(backup.path);
    if (kind === 'absent') {
      if (options.recognizedMissingBackup !== true) {
        return err({ code: 'victim-mismatch', transactionId: options.transactionId });
      }
      continue;
    }
    if (kind !== 'file') {
      return err({ code: 'victim-mismatch', transactionId: options.transactionId });
    }
    const bytes = await ports.readBytes(backup.path);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== backup.repositoryRevision.digest || digest !== backup.contentHash) {
      return err({ code: 'victim-mismatch', transactionId: options.transactionId });
    }
    present.push(backup.path);
  }

  for (const path of present) {
    await ports.removeTree(path);
    await ports.fsyncDir(dirname(path));
  }
  return selectBoundedHistory(model, {
    ledgerRevision: options.ledgerRevision,
    cleanup: { transactionId: options.transactionId, outcome: 'deleted' },
  });
};
