import { dirname, resolve } from 'node:path';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import { resolveFreshRollbackLineage } from '../artifacts/ledger-history.ts';
import type { LedgerModel, LedgerPairV1Dto, LedgerSkillsV2Dto } from '../artifacts/ledger-types.ts';
import type { FileReadPort } from '../ports/types.ts';
import type {
  GcLiveTargetObservation,
  GcObjectObservation,
  GcProtectionEdge,
  GcReachabilityInput,
  GcReachabilityResult,
} from './types.ts';

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const exactObject = (
  objects: readonly GcObjectObservation[],
  path: string,
  contentHash: string,
): GcObjectObservation | null =>
  objects.find((object) => object.path === path && object.contentHash === contentHash) ?? null;

const protect = (
  edges: Map<string, GcProtectionEdge[]>,
  object: GcObjectObservation | null,
  edge: GcProtectionEdge,
): void => {
  if (object === null) return;
  const selected = edges.get(object.id) ?? [];
  if (
    !selected.some(
      (candidate) =>
        candidate.kind === edge.kind &&
        candidate.sourceId === edge.sourceId &&
        candidate.path === edge.path &&
        candidate.contentHash === edge.contentHash,
    )
  ) {
    selected.push(Object.freeze(edge));
    edges.set(object.id, selected);
  }
};

const visitPairs = (
  skills: LedgerSkillsV2Dto,
  sourcePrefix: string,
  visit: (pair: LedgerPairV1Dto, sourceId: string) => void,
): void => {
  for (const [skill, entry] of Object.entries(skills).sort(([left], [right]) =>
    compare(left, right),
  )) {
    for (const [tool, pair] of Object.entries(entry.tools).sort(([left], [right]) =>
      compare(left, right),
    )) {
      visit(pair, `${sourcePrefix}:${skill}:${tool}`);
    }
  }
};

const retainedEligible = (retainUntil: string | null, nowMilliseconds: number): boolean | null => {
  if (retainUntil === null) return true;
  const cutoff = Date.parse(retainUntil);
  return Number.isFinite(cutoff) ? nowMilliseconds <= cutoff : null;
};

/** Observes exact, stable symlink targets for every bounded ledger/registration placement. */
export const observeGcLiveTargets = async (
  ports: Pick<FileReadPort, 'pathKind' | 'readLink' | 'realpath'>,
  model: LedgerModel,
  objects: readonly GcObjectObservation[],
): Promise<GcLiveTargetObservation> => {
  const placements = new Set<string>();
  const collectPair = (pair: LedgerPairV1Dto): void => {
    placements.add(pair.placementPath);
  };
  visitPairs(model.skills, 'user', collectPair);
  for (const project of Object.values(model.projects)) {
    visitPairs(project.skills, 'project', collectPair);
  }
  for (const registration of Object.values(model.projectRegistrations)) {
    for (const consumer of registration.consumers) placements.add(consumer.placementPath);
  }
  const byPath = new Map(objects.map((object) => [object.path, object]));
  const targets = [];
  for (const placementPath of [...placements].sort(compare)) {
    let kindA: Awaited<ReturnType<typeof ports.pathKind>>;
    let kindB: Awaited<ReturnType<typeof ports.pathKind>>;
    try {
      kindA = await ports.pathKind(placementPath);
      if (kindA !== 'symlink') {
        kindB = await ports.pathKind(placementPath);
        if (kindB !== kindA) throw new Error('unstable');
        continue;
      }
      const targetA = await ports.readLink(placementPath);
      const targetB = await ports.readLink(placementPath);
      kindB = await ports.pathKind(placementPath);
      if (kindB !== kindA || targetA !== targetB) throw new Error('unstable');
      const lexicalTarget = resolve(dirname(placementPath), targetA);
      const targetKindA = await ports.pathKind(lexicalTarget);
      if (targetKindA === 'absent') {
        const targetKindB = await ports.pathKind(lexicalTarget);
        const targetC = await ports.readLink(placementPath);
        const kindC = await ports.pathKind(placementPath);
        if (targetKindB !== 'absent' || targetC !== targetA || kindC !== 'symlink') {
          throw new Error('unstable');
        }
        continue;
      }
      const canonicalTarget = await ports.realpath(lexicalTarget);
      const targetC = await ports.readLink(placementPath);
      const kindC = await ports.pathKind(placementPath);
      if (targetC !== targetA || kindC !== 'symlink') throw new Error('unstable');
      const object = byPath.get(canonicalTarget);
      if (object === undefined) continue;
      targets.push(
        Object.freeze({
          sourceId: `live:${placementPath}`,
          path: object.path,
          contentHash: object.contentHash,
        }),
      );
    } catch {
      return deepFreeze({
        state: 'refused',
        reason: `GC live placement changed during observation: ${placementPath}`,
        targets: [],
      });
    }
  }
  return deepFreeze({ state: 'ok', targets });
};

export const classifyGcReachability = (input: GcReachabilityInput): GcReachabilityResult => {
  if (
    !Number.isSafeInteger(input.nowMilliseconds) ||
    (input.olderThanMilliseconds !== null &&
      (!Number.isSafeInteger(input.olderThanMilliseconds) || input.olderThanMilliseconds <= 0))
  ) {
    return deepFreeze({
      state: 'refused',
      reason: 'GC clock or age duration is invalid',
      classifications: [],
    });
  }
  const lineage = resolveFreshRollbackLineage(input.model.history, input.model.transactions);
  if (!lineage.ok) {
    return deepFreeze({
      state: 'refused',
      reason: `GC history lineage is invalid at ${lineage.error.transactionId}`,
      classifications: [],
    });
  }
  const edges = new Map<string, GcProtectionEdge[]>();
  const protectPair = (pair: LedgerPairV1Dto, sourceId: string): void => {
    if (pair.pinned != null) {
      protect(edges, exactObject(input.objects, pair.pinned.storePath, pair.pinned.contentHash), {
        kind: 'ledger',
        sourceId,
        path: pair.pinned.storePath,
        contentHash: pair.pinned.contentHash,
      });
    }
    const before = pair.journal?.before;
    if (before?.mode === 'pinned' && before.storePath !== null && before.contentHash !== null) {
      protect(edges, exactObject(input.objects, before.storePath, before.contentHash), {
        kind: 'legacy-journal',
        sourceId: `${sourceId}:${pair.journal?.txId ?? 'journal'}`,
        path: before.storePath,
        contentHash: before.contentHash,
      });
    }
  };
  visitPairs(input.model.skills, 'user', protectPair);
  for (const [root, project] of Object.entries(input.model.projects).sort(([left], [right]) =>
    compare(left, right),
  )) {
    visitPairs(project.skills, `project:${root}`, protectPair);
  }
  for (const [root, registration] of Object.entries(input.model.projectRegistrations).sort(
    ([left], [right]) => compare(left, right),
  )) {
    for (const consumer of registration.consumers) {
      if (consumer.store === null) continue;
      protect(edges, exactObject(input.objects, consumer.store.path, consumer.store.contentHash), {
        kind: 'project-registration',
        sourceId: `registration:${root}:${consumer.skill}:${consumer.tool}`,
        path: consumer.store.path,
        contentHash: consumer.store.contentHash,
      });
    }
  }
  for (const target of input.liveTargets ?? []) {
    protect(edges, exactObject(input.objects, target.path, target.contentHash), {
      kind: 'live-placement',
      sourceId: target.sourceId,
      path: target.path,
      contentHash: target.contentHash,
    });
  }
  const protectJournal = (
    journal: LogicalJournalV1Dto,
    kind: 'logical-transaction' | 'history',
  ): string | null => {
    for (const retained of journal.actual.retained) {
      if (retained.role !== 'store') continue;
      if (kind === 'history') {
        const eligible = retainedEligible(retained.retainUntil, input.nowMilliseconds);
        if (eligible === null) return journal.transactionId;
        if (!eligible) continue;
      }
      protect(edges, exactObject(input.objects, retained.path, retained.contentHash), {
        kind,
        sourceId: journal.transactionId,
        path: retained.path,
        contentHash: retained.contentHash,
      });
    }
    return null;
  };
  for (const journal of Object.values(input.model.transactions)) {
    protectJournal(journal, 'logical-transaction');
  }
  for (const journal of input.model.history) {
    const invalidTransaction = protectJournal(journal, 'history');
    if (invalidTransaction !== null) {
      return deepFreeze({
        state: 'refused',
        reason: `GC history retention timestamp is invalid at ${invalidTransaction}`,
        classifications: [],
      });
    }
  }

  const cutoff =
    input.olderThanMilliseconds === null
      ? null
      : input.nowMilliseconds - input.olderThanMilliseconds;
  if (cutoff !== null && !Number.isSafeInteger(cutoff)) {
    return deepFreeze({
      state: 'refused',
      reason: 'GC age cutoff is not a safe integer',
      classifications: [],
    });
  }
  const classifications = [...input.objects]
    .sort((left, right) => compare(left.path, right.path))
    .map((object) => {
      const protection = [...(edges.get(object.id) ?? [])].sort(
        (left, right) => compare(left.kind, right.kind) || compare(left.sourceId, right.sourceId),
      );
      const ageEligible = cutoff === null || object.modifiedAt < cutoff;
      return deepFreeze({
        object,
        protection,
        ageEligible,
        outcome: protection.length > 0 ? 'protected' : ageEligible ? 'eligible' : 'age-filtered',
      } as const);
    });
  return deepFreeze({ state: 'ok', classifications });
};
