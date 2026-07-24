import { basename, dirname, join } from 'node:path';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import { resolveFreshRollbackParent } from '../artifacts/ledger-history.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
  LedgerSkillsV2Dto,
  LegacyPairBeforeV1Dto,
  LegacyPairJournalV1Dto,
} from '../artifacts/ledger-types.ts';
import {
  legacyJournalMatchesLogicalShadow,
  legacyJournalOperationMatchesLogicalShadow,
  validateJournalV1DtoShape,
} from '../artifacts/registry.ts';
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
    kind: 'dir' | 'file' | 'symlink' | 'other' | 'absent';
    beforeIdentity: string | null;
    afterIdentity: string | null;
  }>[];
  readonly signal?: AbortSignal;
  readonly cancelAt?: 'after-durable-boundary';
}

export interface BeginTransactionRecoveryAttemptRequest {
  readonly transactionId: string;
  readonly command: string;
  readonly workflow: string;
  readonly updatedAt: string;
}

export interface BeginCommittedLogicalTransactionReversalRequest {
  readonly sourceTransactionId: string;
  readonly transactionId: string;
  readonly operationId: string;
  readonly groupId: string;
  readonly pairId: string | null;
  readonly command: string;
  readonly workflow: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export type LogicalRollbackExecutionMode = 'convert-forward' | 'resume-rollback' | 'fresh-reversal';

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

type CrossScopePairLocation = PairLocation & Readonly<{ placementPath: string }>;

interface CrossScopePairLocations {
  readonly source: CrossScopePairLocation;
  readonly destination: CrossScopePairLocation;
}

const crossScopeLocation = (
  journal: LogicalJournalV1Dto,
  image: LogicalJournalV1Dto['intent']['before'],
): CrossScopePairLocation | null => {
  if (
    image.kind !== 'placement' ||
    image.resource.kind !== 'live' ||
    image.resource.location.kind !== 'machine-bound' ||
    journal.intent.skill === null ||
    journal.intent.tool === null ||
    image.resource.skill !== journal.intent.skill ||
    image.resource.tool !== journal.intent.tool
  ) {
    return null;
  }
  const root = image.resource.projectRoot;
  if (root !== null && root.kind !== 'machine-bound') return null;
  if (image.resource.scope === 'user' && root !== null) return null;
  if (image.resource.scope === 'project' && (root === null || root.kind !== 'machine-bound')) {
    return null;
  }
  return {
    projectRoot: root === null ? null : root.path,
    skill: image.resource.skill,
    tool: image.resource.tool,
    placementPath: image.resource.location.path,
  };
};

/** A move-scope journal has two explicit pair locations and no legacy pair shadow. */
const crossScopePairLocations = (journal: LogicalJournalV1Dto): CrossScopePairLocations | null => {
  if (
    journal.intent.kind !== 'move-scope' ||
    journal.intent.pairId === null ||
    journal.intent.scope === null ||
    journal.intent.after.kind !== 'placement' ||
    journal.intent.after.resource.scope !== journal.intent.scope
  ) {
    return null;
  }
  const source = crossScopeLocation(journal, journal.intent.before);
  const destination = crossScopeLocation(journal, journal.intent.after);
  if (
    source === null ||
    destination === null ||
    (source.projectRoot === destination.projectRoot &&
      source.placementPath === destination.placementPath)
  ) {
    return null;
  }
  return Object.freeze({ source: Object.freeze(source), destination: Object.freeze(destination) });
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

const rollbackParent = (
  model: LedgerModel,
  journal: LogicalJournalV1Dto,
): LogicalJournalV1Dto | null => {
  const parent = resolveFreshRollbackParent(model.history, model.transactions, journal);
  return parent.ok ? parent.value : null;
};

const inverseLegacyOperation = (
  journal: LogicalJournalV1Dto,
  parent: LogicalJournalV1Dto | null,
): LegacyPairJournalV1Dto['op'] | null =>
  (['install', 'uninstall', 'dev', 'promote'] as const).find((operation) =>
    legacyJournalOperationMatchesLogicalShadow(journal, operation, parent),
  ) ?? null;

const derivedTransactionRoot = (path: string): string => dirname(dirname(path));

const physicalShadow = (
  model: LedgerModel,
  journal: LogicalJournalV1Dto,
  previous: LegacyPairJournalV1Dto | null = null,
): LegacyPairJournalV1Dto => {
  const path = placementPath(journal) ?? '/';
  const root = derivedTransactionRoot(path);
  const parent = rollbackParent(model, journal);
  const inverse = inverseLegacyOperation(journal, parent);
  return {
    op:
      previous !== null && legacyJournalOperationMatchesLogicalShadow(journal, previous.op, parent)
        ? previous.op
        : (inverse ?? legacyOperation(journal)),
    txId: journal.transactionId,
    phase: journal.phase,
    startedAt: journal.context.startedAt,
    completedAt: journal.completedAt,
    before: previous?.before ?? legacyBefore(journal),
    stagingPath: previous?.stagingPath ?? join(root, 'stage', journal.transactionId),
    backupPath: previous?.backupPath ?? join(root, 'backup', journal.transactionId),
  };
};

const sameTransactionCoreIdentity = (
  left: LogicalJournalV1Dto,
  right: LogicalJournalV1Dto,
): boolean =>
  left.transactionId === right.transactionId &&
  same(left.intent, right.intent) &&
  left.disposition === right.disposition &&
  left.context.attempt === right.context.attempt &&
  left.context.startedAt === right.context.startedAt &&
  same(left.actual.before, right.actual.before);

const exactPreparedArtifactRetentionEnrichment = (
  previous: LogicalJournalV1Dto,
  next: LogicalJournalV1Dto,
): boolean => {
  const role =
    previous.intent.kind === 'write-manifest'
      ? ('manifest' as const)
      : previous.intent.kind === 'write-lock'
        ? ('lock' as const)
        : null;
  if (
    role === null ||
    previous.phase !== 'prepared' ||
    next.phase !== 'staged' ||
    previous.disposition !== 'forward' ||
    previous.intent.pairId !== null ||
    previous.intent.skill !== null ||
    previous.intent.source !== null ||
    previous.intent.tool !== null ||
    previous.intent.scope !== null ||
    previous.context.command !== 'update' ||
    previous.context.workflow !== 'update-artifact-history' ||
    previous.context.parentOperationId !== previous.intent.operationId ||
    previous.intent.reversibility.kind !== 'conditional' ||
    previous.intent.reversibility.retentionResourceIds.length !== 1 ||
    previous.actual.retained.length !== 0 ||
    next.actual.retained.length !== 1
  ) {
    return false;
  }
  const retained = next.actual.retained[0];
  const before = previous.intent.before;
  const after = previous.intent.after;
  const location =
    role === 'manifest' && before.kind === 'manifest' && after.kind === 'manifest'
      ? before.location
      : role === 'lock' && before.kind === 'lock' && after.kind === 'lock'
        ? before.location
        : null;
  const afterLocation =
    role === 'manifest' && after.kind === 'manifest'
      ? after.location
      : role === 'lock' && after.kind === 'lock'
        ? after.location
        : null;
  const beforeDigest =
    role === 'manifest' && before.kind === 'manifest'
      ? before.byteHash
      : role === 'lock' && before.kind === 'lock'
        ? before.canonicalHash
        : null;
  return (
    location?.kind === 'machine-bound' &&
    afterLocation?.kind === 'machine-bound' &&
    location.path === afterLocation.path &&
    retained !== undefined &&
    retained.role === 'backup' &&
    retained.sourceRole === role &&
    retained.resourceId === previous.intent.reversibility.retentionResourceIds[0] &&
    retained.repositoryRevision.kind === 'resource' &&
    retained.repositoryRevision.digest !== retained.contentHash &&
    retained.contentHash === beforeDigest &&
    retained.retainUntil === null &&
    basename(dirname(retained.path)) === `.skillsmith-artifact-${previous.transactionId}` &&
    basename(retained.path) === `${role}.backup`
  );
};

const sameTransactionIdentity = (left: LogicalJournalV1Dto, right: LogicalJournalV1Dto): boolean =>
  sameTransactionCoreIdentity(left, right) &&
  (same(left.actual.retained, right.actual.retained) ||
    exactPreparedArtifactRetentionEnrichment(left, right));

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

const shadowMatches = (
  model: LedgerModel,
  journal: LogicalJournalV1Dto,
  shadow: LegacyPairJournalV1Dto,
): boolean => {
  const parent = rollbackParent(model, journal);
  const expected = physicalShadow(model, journal, shadow);
  return (
    legacyJournalOperationMatchesLogicalShadow(journal, shadow.op, parent) &&
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
  const crossScope = crossScopePairLocations(journal);
  if (journal.intent.kind === 'move-scope') {
    if (crossScope === null) {
      return err(failure('identity-conflict', 'move-scope pair locations are invalid'));
    }
    for (const candidate of scanPhysicalShadows(model)) {
      if (candidate.shadow.txId === journal.transactionId) {
        return err(
          failure('shadow-conflict', 'move-scope transaction cannot have a physical pair shadow'),
        );
      }
    }
    const sourcePair = getPair(model, crossScope.source);
    const sameMembership = same(crossScope.source, crossScope.destination);
    const destinationPair = sameMembership ? null : getPair(model, crossScope.destination);
    if (
      sourcePair === null ||
      sourcePair.placementPath !== crossScope.source.placementPath ||
      sourcePair.journal != null
    ) {
      return err(
        failure('identity-conflict', 'move-scope source pair membership is not authoritative'),
      );
    }
    if (destinationPair !== null) {
      return err(failure('identity-conflict', 'move-scope destination pair already exists'));
    }
    return ok(model);
  }
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
  if (previous !== null && (priorShadow === null || !shadowMatches(model, previous, priorShadow))) {
    return err(failure('shadow-conflict', 'physical shadow does not match pending logical state'));
  }
  if (previous === null && priorShadow !== null && !shadowMatches(model, journal, priorShadow)) {
    return err(failure('shadow-conflict', 'legacy physical shadow does not match logical attach'));
  }
  const shadow = physicalShadow(model, journal, priorShadow);
  const nextPair = pair === null ? pairFromJournal(journal, shadow) : { ...pair, journal: shadow };
  if (nextPair === null) return err(failure('shadow-conflict', 'pair image cannot be derived'));
  return ok(replacePair(model, location, nextPair));
};

const historyById = (model: LedgerModel, transactionId: string): LogicalJournalV1Dto | null =>
  model.history.find((journal) => journal.transactionId === transactionId) ?? null;

const sameForwardIntentOrientation = (
  source: LogicalJournalV1Dto,
  rollback: LogicalJournalV1Dto,
): boolean =>
  same(
    {
      ...source.intent,
      operationId: rollback.intent.operationId,
      groupId: rollback.intent.groupId,
      pairId: rollback.intent.pairId,
    },
    rollback.intent,
  );

/**
 * Classify the durable rollback direction without adding an origin field to the journal schema.
 * A converted pending abort points at its own operation. A fresh reversal points at one retained
 * committed forward operation and keeps that operation's intent orientation.
 */
export const logicalRollbackExecutionMode = (
  model: LedgerModel,
  journal: LogicalJournalV1Dto,
): Result<LogicalRollbackExecutionMode, LogicalTransactionError> => {
  if (!modelIdentityValid(model)) {
    return err(failure('invalid-model', 'logical transaction model is invalid'));
  }
  if (!validJournal(journal)) {
    return err(failure('invalid-journal', 'logical rollback journal is invalid'));
  }
  if (journal.disposition === 'forward') {
    return journal.phase === 'committed'
      ? err(failure('phase-conflict', 'committed forward transaction cannot be converted'))
      : ok('convert-forward');
  }
  if (journal.context.parentOperationId === journal.intent.operationId) {
    return ok('resume-rollback');
  }
  if (journal.context.parentOperationId === null) {
    return err(failure('identity-conflict', 'rollback origin operation is missing'));
  }
  const resolvedParent = resolveFreshRollbackParent(model.history, model.transactions, journal);
  const source = resolvedParent.ok ? resolvedParent.value : null;
  if (
    source === null ||
    source.phase !== 'committed' ||
    source.disposition !== 'forward' ||
    !sameForwardIntentOrientation(source, journal) ||
    !same(source.actual.after, journal.actual.before) ||
    !same(source.actual.retained, journal.actual.retained) ||
    (journal.intent.pairId !== null && inverseLegacyOperation(journal, source) === null) ||
    (journal.phase === 'live' || journal.phase === 'committed'
      ? !same(source.actual.before, journal.actual.after)
      : journal.actual.after.length !== 0)
  ) {
    return err(failure('identity-conflict', 'fresh rollback origin linkage is inconsistent'));
  }
  return ok('fresh-reversal');
};

/**
 * Resolve the truthful terminal after-image for a rollback. Converted pending aborts restore their
 * own before-image; fresh committed reversals restore the retained parent forward before-image.
 */
export const logicalRollbackTerminalActualAfter = (
  model: LedgerModel,
  journal: LogicalJournalV1Dto,
): Result<LogicalJournalV1Dto['actual']['after'], LogicalTransactionError> => {
  const mode = logicalRollbackExecutionMode(model, journal);
  if (!mode.ok) return mode;
  if (mode.value !== 'fresh-reversal') return ok(journal.actual.before);
  const resolvedParent = resolveFreshRollbackParent(model.history, model.transactions, journal);
  const source = resolvedParent.ok ? resolvedParent.value : null;
  return source === null
    ? err(failure('identity-conflict', 'fresh rollback origin operation is missing'))
    : ok(source.actual.before);
};

/**
 * Begin one history-preserving reversal of an eligible committed placement operation. The new
 * rollback transaction keeps the parent's forward before/after orientation; only its active
 * operation/group/transaction identities are fresh. Physical rollback owns the inversion.
 */
export const beginCommittedLogicalTransactionReversal = (
  model: LedgerModel,
  request: BeginCommittedLogicalTransactionReversalRequest,
): Result<LedgerModel, LogicalTransactionError> => {
  if (!modelIdentityValid(model)) {
    return err(failure('invalid-model', 'logical transaction model is invalid'));
  }
  const source = historyById(model, request.sourceTransactionId);
  if (
    source === null ||
    source.phase !== 'committed' ||
    source.disposition !== 'forward' ||
    !new Set([
      'install',
      'remove',
      'link-dev',
      'promote',
      'update',
      'repair',
      'write-manifest',
      'write-lock',
    ]).has(source.intent.kind)
  ) {
    return err(
      failure('identity-conflict', 'reversal has no eligible committed forward transaction'),
    );
  }
  if (
    request.transactionId.length === 0 ||
    request.operationId.length === 0 ||
    request.groupId.length === 0 ||
    (request.pairId !== null && request.pairId.length === 0) ||
    (source.intent.pairId === null) !== (request.pairId === null) ||
    request.command.length === 0 ||
    request.workflow.length === 0 ||
    request.startedAt.length === 0 ||
    request.updatedAt.length === 0 ||
    request.transactionId === source.transactionId ||
    request.operationId === source.intent.operationId ||
    Object.values(model.transactions).some(
      (journal) => journal.intent.operationId === request.operationId,
    )
  ) {
    return err(failure('identity-conflict', 'fresh reversal identities are invalid or reused'));
  }
  const rollback: LogicalJournalV1Dto = {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId: request.transactionId,
    intent: {
      ...source.intent,
      operationId: request.operationId,
      groupId: request.groupId,
      pairId: request.pairId,
    },
    context: {
      parentOperationId: source.intent.operationId,
      command: request.command,
      workflow: request.workflow,
      attempt: 1,
      startedAt: request.startedAt,
    },
    disposition: 'rollback',
    phase: 'prepared',
    actual: {
      before: source.actual.after,
      after: [],
      retained: source.actual.retained,
    },
    updatedAt: request.updatedAt,
    completedAt: null,
  };
  if (!validJournal(rollback)) {
    return err(failure('invalid-journal', 'fresh reversal journal is invalid'));
  }
  const resolvedOrigin = resolveFreshRollbackParent(model.history, model.transactions, rollback);
  if (!resolvedOrigin.ok || resolvedOrigin.value?.transactionId !== source.transactionId) {
    return err(failure('identity-conflict', 'fresh reversal did not resolve to its exact source'));
  }
  const origin = logicalRollbackExecutionMode(model, rollback);
  if (!origin.ok || origin.value !== 'fresh-reversal') {
    return origin.ok
      ? err(failure('identity-conflict', 'fresh reversal origin was not preserved'))
      : origin;
  }
  return advanceLogicalTransaction(model, rollback);
};

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
  const crossScope = crossScopePairLocations(committed);
  if (committed.intent.kind === 'move-scope') {
    if (crossScope === null) {
      return err(failure('identity-conflict', 'terminal move-scope pair locations are invalid'));
    }
    const sourcePair = getPair(model, crossScope.source);
    const sameMembership = same(crossScope.source, crossScope.destination);
    const destinationPair = sameMembership ? null : getPair(model, crossScope.destination);
    if (
      sourcePair === null ||
      sourcePair.placementPath !== crossScope.source.placementPath ||
      sourcePair.journal != null
    ) {
      return err(failure('identity-conflict', 'terminal move-scope source membership is missing'));
    }
    if (destinationPair !== null) {
      return err(
        failure('identity-conflict', 'terminal move-scope destination membership already exists'),
      );
    }
    if (committed.disposition === 'rollback') return ok(model);
    const withoutSource = sameMembership ? model : replacePair(model, crossScope.source, null);
    const placement =
      committed.intent.after.kind === 'placement' &&
      (committed.intent.after.representation === 'copy' ||
        committed.intent.after.representation === 'symlink')
        ? committed.intent.after.representation
        : undefined;
    return ok(
      replacePair(withoutSource, crossScope.destination, {
        ...sourcePair,
        placementPath: crossScope.destination.placementPath,
        ...(sourcePair.pinned == null || placement === undefined
          ? {}
          : { pinned: { ...sourcePair.pinned, placement } }),
        journal: null,
      }),
    );
  }
  const location = pairLocation(committed);
  if (committed.intent.pairId === null) return ok(model);
  if (location === null)
    return err(failure('identity-conflict', 'terminal pair membership is invalid'));
  const pair = getPair(model, location);
  if (
    pair === null ||
    pair.journal === null ||
    pair.journal === undefined ||
    !shadowMatches(model, pending, pair.journal)
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

/**
 * Commit a fresh reversal while retaining its exact committed compatibility shadow as durable
 * cleanup authority. The caller supplies terminal pair records because promote/install stage those
 * records before the logical journal reaches committed. No ordinary forward or converted rollback
 * transaction may use this two-write terminal protocol.
 */
export const commitLogicalTransactionRetainingShadow = (
  model: LedgerModel,
  journal: LogicalJournalV1Dto,
  terminalPair: LedgerPairV1Dto,
): Result<LedgerModel, LogicalTransactionError> => {
  if (!modelIdentityValid(model)) {
    return err(failure('invalid-model', 'logical transaction model is invalid'));
  }
  if (!validJournal(journal) || journal.phase !== 'committed') {
    return err(failure('invalid-journal', 'retained-shadow commit requires a committed journal'));
  }
  const location = pairLocation(journal);
  if (location === null || journal.intent.pairId === null) {
    return err(failure('identity-conflict', 'retained-shadow pair membership is invalid'));
  }
  const parent = rollbackParent(model, journal);
  const priorHistory = historyById(model, journal.transactionId);
  if (priorHistory !== null) {
    const pair = getPair(model, location);
    return same(priorHistory, journal) &&
      pair !== null &&
      pair.journal != null &&
      legacyJournalMatchesLogicalShadow(journal, location, pair, parent)
      ? ok(model)
      : err(failure('identity-conflict', 'committed cleanup carrier conflicts with history'));
  }
  const pending = model.transactions[journal.transactionId];
  if (
    pending === undefined ||
    !sameTransactionIdentity(pending, journal) ||
    pending.phase !== 'live'
  ) {
    return err(failure('phase-conflict', 'retained-shadow commit requires matching live state'));
  }
  const mode = logicalRollbackExecutionMode(model, pending);
  if (!mode.ok || mode.value !== 'fresh-reversal') {
    return err(failure('phase-conflict', 'only a fresh reversal may retain cleanup authority'));
  }
  const currentPair = getPair(model, location);
  if (
    currentPair === null ||
    currentPair.journal == null ||
    !legacyJournalMatchesLogicalShadow(pending, location, currentPair, parent)
  ) {
    return err(failure('shadow-conflict', 'pending cleanup shadow is not authoritative'));
  }
  if (
    terminalPair.placementPath !== currentPair.placementPath ||
    terminalPair.journal == null ||
    !legacyJournalMatchesLogicalShadow(journal, location, terminalPair, parent)
  ) {
    return err(failure('shadow-conflict', 'committed cleanup shadow is not authoritative'));
  }
  const withCarrier = replacePair(model, location, terminalPair);
  const transactions = { ...withCarrier.transactions };
  Reflect.deleteProperty(transactions, journal.transactionId);
  return ok({ ...withCarrier, transactions, history: [...withCarrier.history, journal] });
};

/**
 * Clear one exact committed fresh-reversal cleanup carrier after its backup decision and directory
 * fsync are durable. Repeating the finalizer is a no-op; it never changes logical history.
 */
export const finalizeCommittedLogicalTransactionShadow = (
  model: LedgerModel,
  transactionId: string,
): Result<LedgerModel, LogicalTransactionError> => {
  if (!modelIdentityValid(model)) {
    return err(failure('invalid-model', 'logical transaction model is invalid'));
  }
  const journal = historyById(model, transactionId);
  if (journal === null || journal.phase !== 'committed') {
    return err(failure('identity-conflict', 'committed cleanup history is missing'));
  }
  const mode = logicalRollbackExecutionMode(model, journal);
  const location = pairLocation(journal);
  const parent = rollbackParent(model, journal);
  const operation = inverseLegacyOperation(journal, parent);
  if (!mode.ok || mode.value !== 'fresh-reversal' || location === null || operation === null) {
    return err(failure('identity-conflict', 'committed cleanup linkage is inconsistent'));
  }
  const pair = getPair(model, location);
  if (pair === null) {
    return operation === 'uninstall'
      ? ok(model)
      : err(failure('shadow-conflict', 'committed cleanup pair is missing'));
  }
  if (pair.journal == null) {
    return operation === 'uninstall'
      ? err(failure('shadow-conflict', 'uninstall cleanup pair was not deleted'))
      : ok(model);
  }
  if (!legacyJournalMatchesLogicalShadow(journal, location, pair, parent)) {
    return err(failure('shadow-conflict', 'committed cleanup shadow does not match history'));
  }
  return ok(
    replacePair(model, location, operation === 'uninstall' ? null : { ...pair, journal: null }),
  );
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
      observation.kind === 'dir' &&
      observation.beforeIdentity !== null &&
      observation.beforeIdentity === observation.afterIdentity &&
      observation.path === resource.path &&
      same(observation.repositoryRevision, resource.repositoryRevision) &&
      observation.contentHash === resource.contentHash
    );
  });
};

/**
 * Source-only pure projection shared by recovery observation and the durable model reducer.
 */
export const projectTransactionRecoveryAttemptJournal = (
  pending: LogicalJournalV1Dto,
  request: Readonly<{
    command: string;
    workflow: string;
    updatedAt?: string;
  }>,
): LogicalJournalV1Dto => ({
  ...pending,
  context: {
    parentOperationId:
      pending.disposition === 'rollback'
        ? pending.context.parentOperationId
        : pending.intent.operationId,
    command: request.command,
    workflow: request.workflow,
    attempt: pending.context.attempt + 1,
    startedAt: pending.context.startedAt,
  },
  updatedAt: request.updatedAt ?? pending.updatedAt,
});

/**
 * Begin one recovery invocation by advancing the pending logical context and its matching legacy
 * physical shadow as one pure model rewrite. Durable persistence remains owned by the caller.
 */
export const beginTransactionRecoveryAttempt = (
  model: LedgerModel,
  request: BeginTransactionRecoveryAttemptRequest,
): Result<LedgerModel, LogicalTransactionError> => {
  if (!modelIdentityValid(model))
    return err(failure('invalid-model', 'logical transaction model is invalid'));
  const pending = model.transactions[request.transactionId];
  if (pending === undefined) {
    return err(failure('identity-conflict', 'recovery has no matching pending transaction'));
  }
  const attempted = projectTransactionRecoveryAttemptJournal(pending, {
    command: request.command,
    workflow: request.workflow,
    updatedAt: request.updatedAt,
  });
  if (!validJournal(attempted))
    return err(failure('invalid-journal', 'recovery attempt journal is invalid'));
  const shadowed = withPendingShadow(model, attempted, pending);
  if (!shadowed.ok) return shadowed;
  return ok({
    ...shadowed.value,
    transactions: {
      ...shadowed.value.transactions,
      [attempted.transactionId]: attempted,
    },
  });
};

const abortPendingLogicalTransactionInternal = (
  model: LedgerModel,
  request: AbortPendingLogicalTransactionRequest,
  attempt: 'increment' | 'preserve',
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
      attempt: attempt === 'preserve' ? pending.context.attempt : pending.context.attempt + 1,
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

export const abortPendingLogicalTransaction = (
  model: LedgerModel,
  request: AbortPendingLogicalTransactionRequest,
): Result<LedgerModel, LogicalTransactionError> =>
  abortPendingLogicalTransactionInternal(model, request, 'increment');

/** Source-only rollback transition after beginTransactionRecoveryAttempt is already durable. */
export const abortPendingLogicalTransactionAfterRecoveryAttempt = (
  model: LedgerModel,
  request: AbortPendingLogicalTransactionRequest,
): Result<LedgerModel, LogicalTransactionError> =>
  abortPendingLogicalTransactionInternal(model, request, 'preserve');

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
    if (committed === null || !shadowMatches(model, committed, candidate.shadow)) continue;
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
