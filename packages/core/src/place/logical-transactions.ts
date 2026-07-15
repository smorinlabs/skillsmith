import { dirname, join } from 'node:path';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
  LedgerSkillsV2Dto,
  LegacyPairBeforeV1Dto,
  LegacyPairJournalV1Dto,
} from '../artifacts/ledger-types.ts';
import { validateJournalV1DtoShape } from '../artifacts/registry.ts';
import { type Result, err, ok } from '../result.ts';

export interface LogicalTransactionError {
  readonly code: 'logical-transaction' | 'cancelled';
  readonly reason:
    | 'invalid-model'
    | 'invalid-journal'
    | 'identity-conflict'
    | 'phase-conflict'
    | 'shadow-conflict'
    | 'retention-conflict'
    | 'cancelled';
  readonly message: string;
  readonly durableModel?: LedgerModel;
}

export interface AbortPendingLogicalTransactionRequest {
  readonly transactionId: string;
  readonly pairId: string | null;
  readonly command: string;
  readonly workflow: string;
  readonly updatedAt: string;
  readonly retainedResources?: readonly Readonly<{
    resourceId: string | undefined;
    path: string | undefined;
    repositoryRevision: unknown;
    contentHash: string | undefined;
    state: 'present' | 'absent';
    owned: boolean;
    linkCount: number;
  }>[];
  readonly signal?: AbortSignal;
  readonly cancelAt?: 'after-durable-boundary';
}

export interface LogicalShadowCollapse {
  readonly model: LedgerModel;
  readonly transactionIds: readonly string[];
  readonly duplicateCount: number;
}

type PairLocation = Readonly<{
  projectRoot: string | null;
  skill: string;
  tool: string;
}>;

const PHASES = ['prepared', 'staged', 'backed-up', 'live', 'committed'] as const;

const failure = (
  reason: LogicalTransactionError['reason'],
  message: string,
  durableModel?: LedgerModel,
): LogicalTransactionError =>
  Object.freeze({
    code: reason === 'cancelled' ? ('cancelled' as const) : ('logical-transaction' as const),
    reason,
    message,
    ...(durableModel === undefined ? {} : { durableModel }),
  });

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
};

const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

const validJournal = (journal: LogicalJournalV1Dto): boolean =>
  validateJournalV1DtoShape(journal).ok;

const modelIdentityValid = (model: LedgerModel): boolean => {
  const pendingIds = new Set<string>();
  for (const [key, journal] of Object.entries(model.transactions)) {
    if (
      key !== journal.transactionId ||
      journal.phase === 'committed' ||
      pendingIds.has(journal.transactionId) ||
      !validJournal(journal)
    ) {
      return false;
    }
    pendingIds.add(journal.transactionId);
  }
  const historyIds = new Set<string>();
  for (const journal of model.history) {
    if (
      journal.phase !== 'committed' ||
      pendingIds.has(journal.transactionId) ||
      historyIds.has(journal.transactionId) ||
      !validJournal(journal)
    ) {
      return false;
    }
    historyIds.add(journal.transactionId);
  }
  return true;
};

const rootFromJournal = (journal: LogicalJournalV1Dto): string | null | undefined => {
  const roots = new Set<string | null>();
  for (const image of [journal.intent.before, journal.intent.after]) {
    if ((image.kind === 'placement' || image.kind === 'absent') && image.resource.kind === 'live') {
      const root = image.resource.projectRoot;
      if (root !== null && root.kind !== 'machine-bound') return undefined;
      roots.add(root === null ? null : root.path);
    }
  }
  if (roots.size !== 1) return undefined;
  return [...roots][0];
};

const pairLocation = (journal: LogicalJournalV1Dto): PairLocation | null => {
  if (
    journal.intent.pairId === null ||
    journal.intent.skill === null ||
    journal.intent.tool === null ||
    journal.intent.scope === null
  ) {
    return null;
  }
  const projectRoot = rootFromJournal(journal);
  if (projectRoot === undefined) return null;
  if (journal.intent.scope === 'user' && projectRoot !== null) return null;
  if (journal.intent.scope === 'project' && projectRoot === null) return null;
  return { projectRoot, skill: journal.intent.skill, tool: journal.intent.tool };
};

const getPair = (model: LedgerModel, location: PairLocation): LedgerPairV1Dto | null => {
  const skills =
    location.projectRoot === null ? model.skills : model.projects[location.projectRoot]?.skills;
  return skills?.[location.skill]?.tools[location.tool] ?? null;
};

const sortText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const registrationsFor = (projects: LedgerModel['projects']): LedgerModel['projectRegistrations'] =>
  Object.fromEntries(
    Object.entries(projects)
      .sort(([left], [right]) => sortText(left, right))
      .map(([root, project]) => [
        root,
        {
          consumers: Object.entries(project.skills)
            .flatMap(([skill, entry]) =>
              Object.entries(entry.tools).map(([tool, pair]) => ({
                skill,
                tool,
                placementPath: pair.placementPath,
                store:
                  pair.pinned == null
                    ? null
                    : { path: pair.pinned.storePath, contentHash: pair.pinned.contentHash },
              })),
            )
            .sort(
              (left, right) =>
                sortText(left.skill, right.skill) ||
                sortText(left.tool, right.tool) ||
                sortText(left.placementPath, right.placementPath),
            ),
        },
      ]),
  );

const replaceInSkills = (
  skills: LedgerSkillsV2Dto,
  skill: string,
  tool: string,
  pair: LedgerPairV1Dto | null,
): LedgerSkillsV2Dto => {
  const current = skills[skill];
  const tools = { ...(current?.tools ?? {}) };
  if (pair === null) Reflect.deleteProperty(tools, tool);
  else tools[tool] = pair;
  const next = { ...skills };
  if (Object.keys(tools).length === 0) Reflect.deleteProperty(next, skill);
  else next[skill] = { tools };
  return next;
};

const replacePair = (
  model: LedgerModel,
  location: PairLocation,
  pair: LedgerPairV1Dto | null,
): LedgerModel => {
  if (location.projectRoot === null) {
    return { ...model, skills: replaceInSkills(model.skills, location.skill, location.tool, pair) };
  }
  const projects = { ...model.projects };
  const current = projects[location.projectRoot];
  const skills = replaceInSkills(current?.skills ?? {}, location.skill, location.tool, pair);
  if (Object.keys(skills).length === 0) Reflect.deleteProperty(projects, location.projectRoot);
  else projects[location.projectRoot] = { skills };
  return { ...model, projects, projectRegistrations: registrationsFor(projects) };
};

const placementPath = (journal: LogicalJournalV1Dto): string | null => {
  for (const image of [journal.intent.after, journal.intent.before]) {
    if ((image.kind === 'placement' || image.kind === 'absent') && image.resource.kind === 'live') {
      if (image.resource.location.kind === 'machine-bound') return image.resource.location.path;
    }
  }
  return (
    [...journal.actual.after, ...journal.actual.before].find((resource) => resource.role === 'live')
      ?.placementPath ?? null
  );
};

const legacyBefore = (journal: LogicalJournalV1Dto): LegacyPairBeforeV1Dto => {
  const image = journal.intent.before;
  if (image.kind === 'absent') return { mode: 'absent' };
  if (image.kind !== 'placement') return { mode: 'absent' };
  if (image.classification === 'dev') {
    return {
      mode: 'dev',
      symlinkTarget:
        image.linkTarget?.kind === 'machine-bound'
          ? image.linkTarget.path
          : (placementPath(journal) ?? ''),
      ...(image.representation === 'symlink' ? { liveKind: 'symlink' as const } : {}),
    };
  }
  const store = journal.actual.retained.find((resource) => resource.role === 'store');
  return {
    mode: 'pinned',
    storePath: store?.path ?? null,
    contentHash: image.contentHash,
    ...(image.representation === 'symlink' ? { liveKind: 'symlink' as const } : {}),
  };
};

const legacyOperation = (journal: LogicalJournalV1Dto): LegacyPairJournalV1Dto['op'] => {
  if (journal.disposition === 'rollback') return 'rollback';
  if (journal.intent.kind === 'remove') return 'uninstall';
  if (journal.intent.kind === 'link-dev') return 'dev';
  if (journal.intent.kind === 'promote') return 'promote';
  if (
    journal.intent.kind === 'update' &&
    journal.intent.after.kind === 'placement' &&
    journal.intent.after.source?.kind === 'local-dev'
  ) {
    return 'promote';
  }
  return 'install';
};

const legacyOperationCompatible = (
  journal: LogicalJournalV1Dto,
  operation: LegacyPairJournalV1Dto['op'],
): boolean => operation === legacyOperation(journal);

const derivedTransactionRoot = (path: string): string => dirname(dirname(path));

const physicalShadow = (
  journal: LogicalJournalV1Dto,
  previous: LegacyPairJournalV1Dto | null = null,
): LegacyPairJournalV1Dto => {
  const path = placementPath(journal) ?? '/';
  const root = derivedTransactionRoot(path);
  return {
    op: legacyOperation(journal),
    txId: journal.transactionId,
    phase: journal.phase,
    startedAt: journal.context.startedAt,
    completedAt: journal.completedAt,
    before: previous?.before ?? legacyBefore(journal),
    stagingPath: previous?.stagingPath ?? join(root, 'stage', journal.transactionId),
    backupPath: previous?.backupPath ?? join(root, 'backup', journal.transactionId),
  };
};

const sameTransactionIdentity = (left: LogicalJournalV1Dto, right: LogicalJournalV1Dto): boolean =>
  left.transactionId === right.transactionId &&
  same(left.intent, right.intent) &&
  left.disposition === right.disposition &&
  left.context.attempt === right.context.attempt &&
  left.context.startedAt === right.context.startedAt &&
  same(left.actual.before, right.actual.before) &&
  same(left.actual.retained, right.actual.retained);

const pairFromJournal = (
  journal: LogicalJournalV1Dto,
  shadow: LegacyPairJournalV1Dto,
): LedgerPairV1Dto | null => {
  const path = placementPath(journal);
  if (path === null) return null;
  const after = journal.intent.after;
  const classification = after.kind === 'placement' ? after.classification : 'pinned';
  if (classification === 'dev') {
    const source = journal.intent.source;
    const sourcePath =
      source?.kind === 'portable'
        ? source.sourcePath
        : source?.kind === 'local-dev'
          ? source.path
          : path;
    const resolvedPath = source?.kind === 'local-dev' ? source.path : sourcePath;
    return {
      placementPath: path,
      mode: 'dev',
      dev: {
        sourcePath,
        resolvedPath,
        repoRoot: null,
        sourceRelPath: null,
        remote: null,
        recordedAt: journal.context.startedAt,
      },
      pinned: null,
      journal: shadow,
    };
  }
  const retainedStore = journal.actual.retained.find((resource) => resource.role === 'store');
  const source = journal.intent.source;
  const resolvedSha = source?.kind === 'portable' ? source.resolvedSha : null;
  return {
    placementPath: path,
    mode: 'pinned',
    dev: null,
    pinned: {
      storePath:
        retainedStore?.path ??
        join(derivedTransactionRoot(path), 'store', journal.intent.skill ?? 'skill'),
      rev: resolvedSha ?? source?.contentHash ?? 'logical-transaction',
      gitSha: resolvedSha,
      dirty: false,
      contentHash:
        after.kind === 'placement' && after.contentHash !== null
          ? after.contentHash
          : (source?.contentHash ?? retainedStore?.contentHash ?? ''),
      snapshotAt: journal.context.startedAt,
      verify: 'passed',
    },
    journal: shadow,
  };
};

const shadowMatches = (journal: LogicalJournalV1Dto, shadow: LegacyPairJournalV1Dto): boolean => {
  const expected = physicalShadow(journal, shadow);
  return (
    legacyOperationCompatible(journal, shadow.op) &&
    shadow.op === expected.op &&
    shadow.txId === expected.txId &&
    shadow.phase === expected.phase &&
    shadow.startedAt === expected.startedAt &&
    shadow.completedAt === expected.completedAt &&
    same(shadow.before, expected.before)
  );
};

const scanPhysicalShadows = (
  model: LedgerModel,
): readonly Readonly<{
  location: PairLocation;
  pair: LedgerPairV1Dto;
  shadow: LegacyPairJournalV1Dto;
}>[] => {
  const values: Array<{
    location: PairLocation;
    pair: LedgerPairV1Dto;
    shadow: LegacyPairJournalV1Dto;
  }> = [];
  const scan = (skills: LedgerSkillsV2Dto, projectRoot: string | null): void => {
    for (const [skill, entry] of Object.entries(skills)) {
      for (const [tool, pair] of Object.entries(entry.tools)) {
        if (pair.journal != null)
          values.push({ location: { projectRoot, skill, tool }, pair, shadow: pair.journal });
      }
    }
  };
  scan(model.skills, null);
  for (const [root, project] of Object.entries(model.projects)) scan(project.skills, root);
  return values;
};

const withPendingShadow = (
  model: LedgerModel,
  journal: LogicalJournalV1Dto,
  previous: LogicalJournalV1Dto | null,
): Result<LedgerModel, LogicalTransactionError> => {
  const location = pairLocation(journal);
  if (journal.intent.pairId === null)
    return location === null
      ? ok(model)
      : err(failure('identity-conflict', 'artifact transaction has pair membership'));
  if (location === null)
    return err(failure('identity-conflict', 'pair transaction membership is invalid'));

  for (const candidate of scanPhysicalShadows(model)) {
    if (candidate.shadow.txId !== journal.transactionId) continue;
    if (!same(candidate.location, location)) {
      return err(failure('shadow-conflict', 'physical shadow belongs to a different pair'));
    }
  }
  const pair = getPair(model, location);
  const priorShadow = pair?.journal ?? null;
  if (previous !== null && (priorShadow === null || !shadowMatches(previous, priorShadow))) {
    return err(failure('shadow-conflict', 'physical shadow does not match pending logical state'));
  }
  if (previous === null && priorShadow !== null && !shadowMatches(journal, priorShadow)) {
    return err(failure('shadow-conflict', 'legacy physical shadow does not match logical attach'));
  }
  const shadow = physicalShadow(journal, priorShadow);
  const nextPair = pair === null ? pairFromJournal(journal, shadow) : { ...pair, journal: shadow };
  if (nextPair === null) return err(failure('shadow-conflict', 'pair image cannot be derived'));
  return ok(replacePair(model, location, nextPair));
};

const historyById = (model: LedgerModel, transactionId: string): LogicalJournalV1Dto | null =>
  model.history.find((journal) => journal.transactionId === transactionId) ?? null;

export const advanceLogicalTransaction = (
  model: LedgerModel,
  journal: LogicalJournalV1Dto,
): Result<LedgerModel, LogicalTransactionError> => {
  const cleanupVictim = (
    model as LedgerModel & {
      readonly cleanupVictim?: Readonly<{
        readonly transactionId: string;
        readonly status: 'pending' | 'unsafe';
      }> | null;
    }
  ).cleanupVictim;
  if (cleanupVictim != null) {
    return err(
      failure(
        'retention-conflict',
        `unresolved history cleanup victim blocks new logical transactions: ${cleanupVictim.transactionId}`,
      ),
    );
  }
  if (!modelIdentityValid(model))
    return err(failure('invalid-model', 'logical transaction model is invalid'));
  if (!validJournal(journal) || journal.phase === 'committed') {
    return err(failure('invalid-journal', 'advance requires a valid nonterminal journal'));
  }
  if (historyById(model, journal.transactionId) !== null) {
    return err(failure('identity-conflict', 'transaction ID already exists in history'));
  }
  const previous = model.transactions[journal.transactionId] ?? null;
  if (previous === null) {
    if (journal.phase !== 'prepared')
      return err(failure('phase-conflict', 'new transaction must begin prepared'));
  } else {
    if (!sameTransactionIdentity(previous, journal)) {
      return err(failure('identity-conflict', 'pending transaction identity changed'));
    }
    if (same(previous, journal)) return ok(model);
    const priorIndex = PHASES.indexOf(previous.phase);
    const nextIndex = PHASES.indexOf(journal.phase);
    if (nextIndex !== priorIndex + 1) {
      return err(failure('phase-conflict', 'logical transaction phase is not adjacent'));
    }
  }
  const shadowed = withPendingShadow(model, journal, previous);
  if (!shadowed.ok) return shadowed;
  return ok({
    ...shadowed.value,
    transactions: { ...shadowed.value.transactions, [journal.transactionId]: journal },
  });
};

const terminalPair = (
  model: LedgerModel,
  pending: LogicalJournalV1Dto,
  committed: LogicalJournalV1Dto,
): Result<LedgerModel, LogicalTransactionError> => {
  const location = pairLocation(committed);
  if (committed.intent.pairId === null) return ok(model);
  if (location === null)
    return err(failure('identity-conflict', 'terminal pair membership is invalid'));
  const pair = getPair(model, location);
  if (
    pair === null ||
    pair.journal === null ||
    pair.journal === undefined ||
    !shadowMatches(pending, pair.journal)
  ) {
    return err(failure('shadow-conflict', 'terminal physical shadow does not match pending state'));
  }
  const beforeAbsent = committed.intent.before.kind === 'absent';
  const deletePair =
    (committed.disposition === 'forward' && committed.intent.kind === 'remove') ||
    (committed.disposition === 'rollback' && beforeAbsent);
  return ok(replacePair(model, location, deletePair ? null : { ...pair, journal: null }));
};

export const commitLogicalTransaction = (
  model: LedgerModel,
  journal: LogicalJournalV1Dto,
): Result<LedgerModel, LogicalTransactionError> => {
  if (!modelIdentityValid(model))
    return err(failure('invalid-model', 'logical transaction model is invalid'));
  if (!validJournal(journal) || journal.phase !== 'committed') {
    return err(failure('invalid-journal', 'commit requires a valid committed journal'));
  }
  const priorHistory = historyById(model, journal.transactionId);
  if (priorHistory !== null) {
    return same(priorHistory, journal)
      ? ok(model)
      : err(failure('identity-conflict', 'committed transaction ID conflicts with history'));
  }
  const pending = model.transactions[journal.transactionId];
  if (pending === undefined || !sameTransactionIdentity(pending, journal)) {
    return err(failure('identity-conflict', 'commit has no matching pending transaction'));
  }
  if (pending.disposition === 'forward' && pending.phase !== 'live') {
    return err(failure('phase-conflict', 'forward commit requires live pending state'));
  }
  const terminal = terminalPair(model, pending, journal);
  if (!terminal.ok) return terminal;
  const transactions = { ...terminal.value.transactions };
  Reflect.deleteProperty(transactions, journal.transactionId);
  return ok({ ...terminal.value, transactions, history: [...terminal.value.history, journal] });
};

const retainedResourcesValid = (
  journal: LogicalJournalV1Dto,
  observations: AbortPendingLogicalTransactionRequest['retainedResources'],
): boolean => {
  const expected = journal.actual.retained;
  const actual = observations ?? [];
  if (expected.length !== actual.length) return false;
  return expected.every((resource) => {
    const observation = actual.find((candidate) => candidate.resourceId === resource.resourceId);
    return (
      observation !== undefined &&
      observation.state === 'present' &&
      observation.owned &&
      observation.linkCount === 1 &&
      observation.path === resource.path &&
      same(observation.repositoryRevision, resource.repositoryRevision) &&
      observation.contentHash === resource.contentHash
    );
  });
};

export const abortPendingLogicalTransaction = (
  model: LedgerModel,
  request: AbortPendingLogicalTransactionRequest,
): Result<LedgerModel, LogicalTransactionError> => {
  if (request.signal?.aborted)
    return err(failure('cancelled', 'logical transaction abort cancelled'));
  if (!modelIdentityValid(model))
    return err(failure('invalid-model', 'logical transaction model is invalid'));
  const pending = model.transactions[request.transactionId];
  if (
    pending === undefined ||
    pending.intent.pairId !== request.pairId ||
    pending.disposition !== 'forward'
  ) {
    return err(failure('identity-conflict', 'abort has no matching forward pending transaction'));
  }
  if (!retainedResourcesValid(pending, request.retainedResources)) {
    return err(failure('retention-conflict', 'retained resource validation failed'));
  }
  const rollback: LogicalJournalV1Dto = {
    ...pending,
    context: {
      parentOperationId: pending.intent.operationId,
      command: request.command,
      workflow: request.workflow,
      attempt: pending.context.attempt + 1,
      startedAt: pending.context.startedAt,
    },
    disposition: 'rollback',
    phase: 'prepared',
    actual: { ...pending.actual, after: [] },
    updatedAt: request.updatedAt,
    completedAt: null,
  };
  if (!validJournal(rollback))
    return err(failure('invalid-journal', 'rollback journal is invalid'));
  const shadowed = withPendingShadow(model, rollback, pending);
  if (!shadowed.ok) return shadowed;
  const durableModel: LedgerModel = {
    ...shadowed.value,
    transactions: { ...shadowed.value.transactions, [rollback.transactionId]: rollback },
  };
  return request.cancelAt === 'after-durable-boundary'
    ? err(
        failure(
          'cancelled',
          'logical transaction abort cancelled after durable boundary',
          durableModel,
        ),
      )
    : ok(durableModel);
};

export const collapseLogicalTransactionShadows = (
  model: LedgerModel,
): Result<LogicalShadowCollapse, LogicalTransactionError> => {
  if (!modelIdentityValid(model))
    return err(failure('invalid-model', 'logical transaction model is invalid'));
  let next = model;
  const collapsed: string[] = [];
  const counts = new Map<string, number>();
  for (const candidate of scanPhysicalShadows(model)) {
    const committed = historyById(model, candidate.shadow.txId);
    if (committed === null || !shadowMatches(committed, candidate.shadow)) continue;
    const location = pairLocation(committed);
    if (location === null || !same(location, candidate.location)) continue;
    counts.set(committed.transactionId, (counts.get(committed.transactionId) ?? 0) + 1);
    if (!collapsed.includes(committed.transactionId)) collapsed.push(committed.transactionId);
    const remove = candidate.shadow.op === 'uninstall';
    next = replacePair(next, location, remove ? null : { ...candidate.pair, journal: null });
  }
  collapsed.sort(sortText);
  const duplicateCount = [...counts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  return ok({ model: next, transactionIds: collapsed, duplicateCount });
};
