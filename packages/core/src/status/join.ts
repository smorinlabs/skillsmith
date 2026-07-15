import { resolve } from 'node:path';
import { SUPPORTED_TOOLS } from '../agents/types.ts';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
  LegacyPairJournalV1Dto,
} from '../artifacts/ledger-types.ts';
import { type PortableLockV1, correlatePortableLock } from '../artifacts/lock.ts';
import type { ArtifactReadResult } from '../artifacts/repository.ts';
import type { NormalizedManifestDeclaration, NormalizedManifestV1 } from '../artifacts/types.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import { type Result, err, ok } from '../result.ts';
import type {
  StatusArtifactRelationship,
  StatusBrokenReason,
  StatusDesiredState,
  StatusEntry,
  StatusFact,
  StatusFactCode,
  StatusJournalState,
  StatusLedgerObservation,
  StatusLedgerSummary,
  StatusLegacyObservedNode,
  StatusLegacyRetentionRequirement,
  StatusLiveClass,
  StatusLiveObservation,
  StatusLockSummary,
  StatusLockedState,
  StatusLogicalRetentionRequirement,
  StatusManifestSummary,
  StatusPlacement,
  StatusReadRequest,
  StatusRecordedRevisionCheck,
  StatusReport,
  StatusShadow,
  StatusSourceIdentity,
  StatusUnmatchedJournal,
  StatusVerification,
} from './types.ts';

export interface StatusLiveInput {
  readonly name: string;
  readonly tool: string;
  readonly scope: Scope;
  readonly projectIdentity: string | null;
  readonly path: string;
  readonly observation: StatusLiveObservation;
  readonly physicalClass: 'dev' | 'store-linked' | 'directory' | 'broken';
  readonly brokenReason: Exclude<
    StatusBrokenReason,
    'ledger-recorded-absence' | 'ledger-mode-contradiction'
  > | null;
}

export interface StatusJoinInput {
  readonly homeDir: string;
  readonly request: Readonly<StatusReadRequest>;
  readonly manifest: ArtifactReadResult<NormalizedManifestV1> | null;
  readonly lock: ArtifactReadResult<PortableLockV1> | null;
  readonly ledger: ArtifactReadResult<LedgerModel>;
  readonly ledgerPath: string;
  readonly live: readonly StatusLiveInput[];
  readonly retention: readonly StatusRetentionProbeInput[];
}

export interface StatusRetentionProbeInput {
  readonly transactionId: string;
  readonly resourceId: string | null;
  readonly path: string;
  readonly pathState: 'satisfied' | 'missing' | 'unverified';
  readonly repositoryRevision:
    | Readonly<{ readonly state: 'observed'; readonly digest: string }>
    | Readonly<{ readonly state: 'missing' | 'unverified'; readonly digest: null }>;
  readonly contentHash:
    | Readonly<{ readonly state: 'observed'; readonly digest: string }>
    | Readonly<{ readonly state: 'missing' | 'unverified'; readonly digest: null }>;
  readonly node:
    | Readonly<{
        readonly state: 'observed';
        readonly kind: 'absent' | 'directory' | 'symlink' | 'file' | 'other';
        readonly linkTarget: string | null;
      }>
    | Readonly<{ readonly state: 'unverified'; readonly kind: null; readonly linkTarget: null }>;
}

export interface StatusJoinSelectionError {
  readonly reason: 'unmatched-target';
}

interface LedgerCandidate {
  readonly name: string;
  readonly tool: string;
  readonly scope: 'user' | 'project';
  readonly projectIdentity: string | null;
  readonly pair: LedgerPairV1Dto;
}

interface DesiredCandidate {
  readonly declaration: NormalizedManifestDeclaration;
  readonly path: string | null;
  readonly tools: readonly string[];
}

interface MutableRow {
  name: string;
  tool: string;
  scope: Scope;
  projectIdentity: string | null;
  path: string | null;
  desired: StatusDesiredState | null;
  ledger: LedgerPairV1Dto | null;
  live: StatusLiveInput | null;
  journal: StatusJournalState;
  shadow: StatusShadow;
}

interface MutableEntry {
  name: string;
  desired: StatusDesiredState | null;
  locked: StatusLockedState | null;
  rows: MutableRow[];
  facts: StatusFact[];
}

const FILTER_NOOP_REASON = 'valid selection was reduced to zero by active filters' as const;
const TOOL_ORDER = new Map<string, number>(SUPPORTED_TOOLS.map((tool, index) => [tool, index]));
const SCOPE_ORDER = new Map<string, number>(SCOPES.map((scope, index) => [scope, index]));
const FACT_ORDER = [
  'manifest-only',
  'lock-only',
  'ledger-only',
  'live-only',
  'lock-missing-entry',
  'lock-extra-entry',
  'lock-manifest-hash',
  'lock-source',
  'lock-ref',
  'lock-source-path',
  'live-missing',
  'live-undeclared',
  'ledger-missing',
  'source-drift',
  'revision-drift',
  'content-drift',
  'placement-drift',
  'broken-live',
  'shadowed',
  'duplicate-live',
  'journal-pending',
  'journal-committed',
  'retention-missing',
  'retention-mismatch',
  'retention-unverified',
  'retention-incomplete',
  'ledger-migration-pending',
  'verify-passed',
  'verify-warned',
  'verify-skipped',
  'verify-unrecorded',
] as const satisfies readonly StatusFactCode[];
const FACT_RANK = new Map<StatusFactCode, number>(FACT_ORDER.map((code, index) => [code, index]));

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const uniqueSorted = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort(compare));

const factContract = (code: StatusFactCode): Pick<StatusFact, 'subject' | 'impact'> => {
  if (code === 'manifest-only') return { subject: 'manifest', impact: 'drift' };
  if (code === 'lock-only' || code.startsWith('lock-')) return { subject: 'lock', impact: 'drift' };
  if (
    code === 'ledger-only' ||
    code === 'ledger-missing' ||
    code === 'source-drift' ||
    code === 'revision-drift' ||
    code === 'content-drift'
  ) {
    return { subject: 'ledger', impact: 'drift' };
  }
  if (code === 'ledger-migration-pending') return { subject: 'ledger', impact: 'info' };
  if (code.startsWith('verify-')) return { subject: 'verification', impact: 'info' };
  if (code === 'shadowed' || code === 'duplicate-live')
    return { subject: 'shadow', impact: 'drift' };
  if (code === 'journal-committed') return { subject: 'journal', impact: 'info' };
  if (code.startsWith('journal-') || code.startsWith('retention-')) {
    return { subject: 'journal', impact: 'drift' };
  }
  return { subject: 'live', impact: 'drift' };
};

const makeFact = (
  code: StatusFactCode,
  expected: string | null,
  actual: string | null,
): StatusFact => ({ code, ...factContract(code), expected, actual });

const sortFacts = (facts: readonly StatusFact[]): readonly StatusFact[] =>
  Object.freeze(
    [...facts].sort(
      (left, right) =>
        (FACT_RANK.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
          (FACT_RANK.get(right.code) ?? Number.MAX_SAFE_INTEGER) ||
        compare(left.expected ?? '', right.expected ?? '') ||
        compare(left.actual ?? '', right.actual ?? ''),
    ),
  );

const manifestSummary = (
  value: ArtifactReadResult<NormalizedManifestV1> | null,
): StatusManifestSummary => {
  if (value === null || value.state === 'absent') return { state: 'absent' };
  if (value.sourceVersion === 'legacy') {
    return {
      state: 'present',
      sourceVersion: 'legacy',
      currentVersion: 1,
      byteRevision: value.byteRevision,
      semanticRevision: value.semanticRevision as string,
      canonical: false,
      migrationPending: true,
    };
  }
  return {
    state: 'present',
    sourceVersion: 1,
    currentVersion: 1,
    byteRevision: value.byteRevision,
    semanticRevision: value.semanticRevision as string,
    canonical: value.canonical,
    migrationPending: false,
  };
};

const lockSummary = (value: ArtifactReadResult<PortableLockV1> | null): StatusLockSummary =>
  value === null || value.state === 'absent'
    ? { state: 'absent' }
    : {
        state: 'present',
        sourceVersion: 1,
        currentVersion: 1,
        byteRevision: value.byteRevision,
        semanticRevision: value.semanticRevision as string,
        canonical: true,
        migrationPending: false,
      };

const ledgerSummary = (
  value: ArtifactReadResult<LedgerModel>,
  path: string,
): StatusLedgerSummary => {
  if (value.state === 'absent') {
    return {
      state: 'absent',
      path,
      sourceVersion: null,
      currentVersion: 2,
      migrationPending: false,
    };
  }
  return value.sourceVersion === 1
    ? {
        state: 'present',
        path,
        sourceVersion: 1,
        currentVersion: 2,
        byteRevision: value.byteRevision,
        semanticRevision: value.semanticRevision as string,
        migrationPending: true,
      }
    : {
        state: 'present',
        path,
        sourceVersion: 2,
        currentVersion: 2,
        byteRevision: value.byteRevision,
        semanticRevision: value.semanticRevision as string,
        migrationPending: false,
      };
};

const statusDesired = (
  declaration: NormalizedManifestDeclaration,
  path: string | null,
): StatusDesiredState => ({
  name: declaration.name,
  source: {
    host: declaration.source.host,
    repository: declaration.source.repository,
    path: declaration.source.path,
  },
  ref: declaration.ref,
  tools: Object.freeze([...declaration.tools]),
  scope: declaration.scope,
  placement: declaration.placement,
  path,
});

const statusLocked = (value: PortableLockV1['skills'][number]): StatusLockedState => ({
  name: value.name,
  source: value.source,
  requestedRef: value.requestedRef,
  resolvedSha: value.resolvedSha,
  sourcePath: value.sourcePath,
  contentHash: value.contentHash,
});

const selectedTool = (tool: string, input: StatusJoinInput): boolean =>
  input.request.tools.includes(tool as (typeof input.request.tools)[number]);

const selectedScope = (scope: Scope, input: StatusJoinInput): boolean =>
  input.request.scopes.includes(scope);

const collectLedger = (input: StatusJoinInput): readonly LedgerCandidate[] => {
  if (input.ledger.state === 'absent') return [];
  const candidates: LedgerCandidate[] = [];
  const append = (
    skills: LedgerModel['skills'],
    scope: 'user' | 'project',
    projectIdentity: string | null,
  ): void => {
    if (!selectedScope(scope, input)) return;
    for (const [name, skill] of Object.entries(skills)) {
      for (const [tool, pair] of Object.entries(skill.tools)) {
        const known = TOOL_ORDER.has(tool);
        if (
          (known && !selectedTool(tool, input)) ||
          (!known && input.request.toolSelectionSource !== 'unbounded-default')
        ) {
          continue;
        }
        candidates.push({ name, tool, scope, projectIdentity, pair });
      }
    }
  };
  append(input.ledger.model.skills, 'user', null);
  if (input.request.projectPlacement.state === 'selected') {
    const project = input.ledger.model.projects[input.request.projectPlacement.identity];
    if (project !== undefined) {
      append(project.skills, 'project', input.request.projectPlacement.identity);
    }
  }
  return candidates;
};

const collectDesired = (
  input: StatusJoinInput,
): Readonly<{ selected: readonly DesiredCandidate[]; filtered: ReadonlySet<string> }> => {
  const filtered = new Set<string>();
  if (
    input.manifest === null ||
    input.manifest.state === 'absent' ||
    input.manifest.sourceVersion === 'legacy'
  ) {
    return { selected: [], filtered };
  }
  const selected: DesiredCandidate[] = [];
  for (const declaration of input.manifest.model.skills) {
    const contextAvailable =
      declaration.scope !== 'project' || input.request.projectPlacement.state === 'selected';
    const tools = declaration.tools.filter((tool) => selectedTool(tool, input));
    if (!contextAvailable || !selectedScope(declaration.scope, input) || tools.length === 0) {
      filtered.add(declaration.name);
      if (contextAvailable && declaration.path !== null) {
        filtered.add(
          declaration.scope === 'user'
            ? resolve(input.homeDir, declaration.path.slice(2))
            : resolve(
                input.request.projectPlacement.state === 'selected'
                  ? input.request.projectPlacement.root
                  : '',
                declaration.path.slice(2),
              ),
        );
      }
      continue;
    }
    const path =
      declaration.path === null
        ? null
        : declaration.scope === 'user'
          ? resolve(input.homeDir, declaration.path.slice(2))
          : resolve(
              input.request.projectPlacement.state === 'selected'
                ? input.request.projectPlacement.root
                : '',
              declaration.path.slice(2),
            );
    selected.push({ declaration, path, tools });
  }
  return { selected, filtered };
};

const rowGroupKey = (
  name: string,
  tool: string,
  scope: Scope,
  projectIdentity: string | null,
): string => JSON.stringify([name, tool, scope, projectIdentity]);

const newRow = (
  name: string,
  tool: string,
  scope: Scope,
  projectIdentity: string | null,
  path: string | null,
): MutableRow => ({
  name,
  tool,
  scope,
  projectIdentity,
  path,
  desired: null,
  ledger: null,
  live: null,
  journal: { state: 'none' },
  shadow: { state: 'none' },
});

const buildRows = (
  input: StatusJoinInput,
  desired: readonly DesiredCandidate[],
  ledger: readonly LedgerCandidate[],
): Map<string, MutableRow[]> => {
  const grouped = new Map<string, MutableRow[]>();
  const group = (
    name: string,
    tool: string,
    scope: Scope,
    identity: string | null,
  ): MutableRow[] => {
    const key = rowGroupKey(name, tool, scope, identity);
    let rows = grouped.get(key);
    if (rows === undefined) {
      rows = [];
      grouped.set(key, rows);
    }
    return rows;
  };

  const ledgerGroups = new Map<string, LedgerCandidate[]>();
  for (const candidate of ledger) {
    const key = rowGroupKey(
      candidate.name,
      candidate.tool,
      candidate.scope,
      candidate.projectIdentity,
    );
    const values = ledgerGroups.get(key) ?? [];
    values.push(candidate);
    ledgerGroups.set(key, values);
  }
  const liveGroups = new Map<string, StatusLiveInput[]>();
  for (const candidate of input.live) {
    const key = rowGroupKey(
      candidate.name,
      candidate.tool,
      candidate.scope,
      candidate.projectIdentity,
    );
    const values = liveGroups.get(key) ?? [];
    values.push(candidate);
    liveGroups.set(key, values);
  }

  for (const key of new Set([...ledgerGroups.keys(), ...liveGroups.keys()])) {
    const ledgers = [...(ledgerGroups.get(key) ?? [])];
    const lives = [...(liveGroups.get(key) ?? [])];
    const seed = ledgers[0] ?? lives[0];
    if (seed === undefined) continue;
    const rows = group(seed.name, seed.tool, seed.scope, seed.projectIdentity);
    for (let ledgerIndex = ledgers.length - 1; ledgerIndex >= 0; ledgerIndex--) {
      const ledgerCandidate = ledgers[ledgerIndex];
      if (ledgerCandidate === undefined) continue;
      const liveIndex = lives.findIndex((live) => live.path === ledgerCandidate.pair.placementPath);
      if (liveIndex < 0) continue;
      const live = lives.splice(liveIndex, 1)[0];
      ledgers.splice(ledgerIndex, 1);
      const row = newRow(
        seed.name,
        seed.tool,
        seed.scope,
        seed.projectIdentity,
        live?.path ?? null,
      );
      row.ledger = ledgerCandidate.pair;
      row.live = live ?? null;
      rows.push(row);
    }
    if (ledgers.length === 1 && lives.length === 1) {
      const ledgerCandidate = ledgers[0];
      const live = lives[0];
      if (ledgerCandidate !== undefined && live !== undefined) {
        const row = newRow(seed.name, seed.tool, seed.scope, seed.projectIdentity, live.path);
        row.ledger = ledgerCandidate.pair;
        row.live = live;
        rows.push(row);
        ledgers.length = 0;
        lives.length = 0;
      }
    }
    for (const candidate of ledgers) {
      const row = newRow(
        seed.name,
        seed.tool,
        seed.scope,
        seed.projectIdentity,
        candidate.pair.placementPath,
      );
      row.ledger = candidate.pair;
      rows.push(row);
    }
    for (const candidate of lives) {
      const row = newRow(seed.name, seed.tool, seed.scope, seed.projectIdentity, candidate.path);
      row.live = candidate;
      rows.push(row);
    }
  }

  for (const candidate of desired) {
    const value = statusDesired(candidate.declaration, candidate.path);
    for (const tool of candidate.tools) {
      const identity =
        candidate.declaration.scope === 'project' &&
        input.request.projectPlacement.state === 'selected'
          ? input.request.projectPlacement.identity
          : null;
      const rows = group(candidate.declaration.name, tool, candidate.declaration.scope, identity);
      if (candidate.path !== null) {
        let row = rows.find((value) => value.path === candidate.path);
        if (row === undefined) {
          row = newRow(
            candidate.declaration.name,
            tool,
            candidate.declaration.scope,
            identity,
            candidate.path,
          );
          rows.push(row);
        }
        row.desired = value;
      } else if (rows.length === 0) {
        const row = newRow(
          candidate.declaration.name,
          tool,
          candidate.declaration.scope,
          identity,
          null,
        );
        row.desired = value;
        rows.push(row);
      } else {
        for (const row of rows) row.desired = value;
      }
    }
  }
  return grouped;
};

const ledgerObservation = (pair: LedgerPairV1Dto): StatusLedgerObservation => ({
  placementPath: pair.placementPath,
  mode: pair.mode,
  source:
    pair.origin === undefined
      ? null
      : { host: pair.origin.host, repository: pair.origin.repo, path: pair.origin.skillPath },
  requestedRef: pair.origin?.refRequested ?? null,
  resolvedRevision: pair.origin?.refResolved ?? pair.pinned?.gitSha ?? pair.pinned?.rev ?? null,
  contentHash: pair.pinned?.contentHash ?? null,
  verification: pair.pinned?.verify ?? 'unrecorded',
  placement: pair.pinned?.placement ?? null,
});

const rowClass = (
  row: MutableRow,
): Readonly<{ classification: StatusLiveClass; brokenReason: StatusBrokenReason | null }> => {
  if (row.live === null) {
    return row.ledger === null
      ? { classification: 'absent', brokenReason: null }
      : { classification: 'broken', brokenReason: 'ledger-recorded-absence' };
  }
  if (row.live.physicalClass === 'broken') {
    return { classification: 'broken', brokenReason: row.live.brokenReason };
  }
  if (
    row.ledger !== null &&
    ((row.ledger.mode === 'dev' && row.live.physicalClass !== 'dev') ||
      (row.ledger.mode === 'pinned' && row.live.physicalClass === 'dev'))
  ) {
    return { classification: 'broken', brokenReason: 'ledger-mode-contradiction' };
  }
  if (row.live.physicalClass === 'dev') return { classification: 'dev', brokenReason: null };
  if (row.live.physicalClass === 'store-linked') {
    return { classification: 'store-linked', brokenReason: null };
  }
  return row.ledger === null
    ? { classification: 'unmanaged', brokenReason: null }
    : { classification: 'pinned', brokenReason: null };
};

const sourceTuple = (source: StatusSourceIdentity): string =>
  JSON.stringify([source.host, source.repository, source.path]);

const lockedSourceIdentity = (locked: StatusLockedState): StatusSourceIdentity | null => {
  const marker = locked.source.indexOf('//');
  const repositoryPart = marker < 0 ? locked.source : locked.source.slice(0, marker);
  const path = marker < 0 ? null : locked.source.slice(marker + 2);
  const slash = repositoryPart.indexOf('/');
  if (slash < 1) return null;
  return {
    host: repositoryPart.slice(0, slash),
    repository: repositoryPart.slice(slash + 1),
    path,
  };
};

const placementTuple = (
  row: MutableRow,
  classification: StatusLiveClass,
  expected: boolean,
): string => {
  if (expected) {
    const representation =
      row.desired?.placement ??
      row.ledger?.pinned?.placement ??
      (row.ledger?.mode === 'dev' ? 'symlink' : null);
    const mode = row.desired !== null ? 'pinned' : (row.ledger?.mode ?? null);
    const path = row.desired?.path ?? row.ledger?.placementPath ?? null;
    return JSON.stringify([representation, mode, path]);
  }
  const representation =
    row.live?.observation.nodeKind === 'symlink'
      ? 'symlink'
      : row.live?.observation.nodeKind === 'directory'
        ? 'copy'
        : row.live === null
          ? (row.ledger?.pinned?.placement ?? (row.ledger?.mode === 'dev' ? 'symlink' : null))
          : 'other';
  const mode =
    classification === 'dev'
      ? 'dev'
      : classification === 'pinned' || classification === 'store-linked'
        ? 'pinned'
        : classification;
  return JSON.stringify([
    representation,
    mode,
    row.live?.path ?? row.ledger?.placementPath ?? null,
  ]);
};

const factsForRow = (
  row: MutableRow,
  locked: StatusLockedState | null,
  classification: StatusLiveClass,
  brokenReason: StatusBrokenReason | null,
  verification: StatusVerification,
): readonly StatusFact[] => {
  const facts: StatusFact[] = [];
  const desired = row.desired !== null;
  const ledger = row.ledger !== null;
  const live = row.live !== null;
  if (!desired && !ledger && live) facts.push(makeFact('live-only', 'absent', 'present'));
  else if (!desired && ledger && !live) facts.push(makeFact('ledger-only', 'absent', 'present'));
  else if (!desired && ledger && live)
    facts.push(makeFact('live-undeclared', 'declared', 'undeclared'));
  else if (desired && !ledger && !live) {
    facts.push(makeFact('ledger-missing', 'present', 'absent'));
    facts.push(makeFact('live-missing', 'present', 'absent'));
  } else if (desired && !ledger && live)
    facts.push(makeFact('ledger-missing', 'present', 'absent'));
  else if (desired && ledger && !live) facts.push(makeFact('live-missing', 'present', 'absent'));

  if (classification === 'broken') {
    facts.push(makeFact('broken-live', 'valid', brokenReason));
  }
  if (locked !== null && row.ledger !== null) {
    const expectedSource = lockedSourceIdentity(locked);
    const actualSource = ledgerObservation(row.ledger).source;
    if (
      expectedSource !== null &&
      actualSource !== null &&
      sourceTuple(expectedSource) !== sourceTuple(actualSource)
    ) {
      facts.push(makeFact('source-drift', sourceTuple(expectedSource), sourceTuple(actualSource)));
    }
    const revision = ledgerObservation(row.ledger).resolvedRevision;
    if (revision !== null && revision !== locked.resolvedSha) {
      facts.push(makeFact('revision-drift', locked.resolvedSha, revision));
    }
    const content = ledgerObservation(row.ledger).contentHash;
    if (content !== null && content !== locked.contentHash) {
      facts.push(makeFact('content-drift', locked.contentHash, content));
    }
  }
  if (row.desired !== null || row.ledger !== null) {
    const expected = placementTuple(row, classification, true);
    const actual = placementTuple(row, classification, false);
    const expectedParts = JSON.parse(expected) as Array<string | null>;
    const actualParts = JSON.parse(actual) as Array<string | null>;
    const comparableMismatch = expectedParts.some(
      (value, index) =>
        value !== null &&
        actualParts[index] !== null &&
        (index !== 1 || ['dev', 'pinned', 'unmanaged'].includes(actualParts[index] as string)) &&
        value !== actualParts[index],
    );
    if (comparableMismatch) facts.push(makeFact('placement-drift', expected, actual));
  }
  if (row.shadow.state === 'shadowed') {
    facts.push(makeFact('shadowed', row.shadow.winner, row.path));
  } else if (row.shadow.state === 'duplicate') {
    facts.push(makeFact('duplicate-live', 'unique', 'duplicate'));
  }
  if (row.journal.state === 'pending') {
    facts.push(makeFact('journal-pending', 'committed', row.journal.phase));
  } else if (row.journal.state === 'committed') {
    facts.push(makeFact('journal-committed', 'committed', 'committed'));
  }
  if (row.journal.state !== 'none') {
    const eligibility =
      row.journal.state === 'pending'
        ? row.journal.abortEligibility
        : row.journal.reverseEligibility;
    if (eligibility === 'retention-incomplete') {
      facts.push(makeFact('retention-incomplete', 'complete', 'incomplete'));
    }
    for (const requirement of row.journal.retention) {
      if (requirement.state === 'satisfied') continue;
      facts.push(
        makeFact(
          `retention-${requirement.state}`,
          JSON.stringify([requirement.resourceId, requirement.path]),
          requirement.state,
        ),
      );
    }
  }
  facts.push(makeFact(`verify-${verification}`, 'recorded', verification));
  return sortFacts(facts);
};

const setShadows = (entries: Map<string, MutableEntry>): void => {
  for (const entry of entries.values()) {
    const byTool = new Map<string, MutableRow[]>();
    for (const row of entry.rows) {
      if (row.live === null) continue;
      const values = byTool.get(row.tool) ?? [];
      values.push(row);
      byTool.set(row.tool, values);
    }
    for (const rows of byTool.values()) {
      if (rows.length < 2) continue;
      const user = rows.filter((row) => row.scope === 'user');
      const project = rows.filter((row) => row.scope === 'project');
      if (rows.length === 2 && user.length === 1 && project.length === 1) {
        const userRow = user[0];
        const projectRow = project[0];
        if (userRow !== undefined && projectRow !== undefined && projectRow.path !== null) {
          userRow.shadow = { state: 'shadowed', winner: projectRow.path };
          projectRow.shadow = {
            state: 'winner',
            shadows: Object.freeze(userRow.path === null ? [] : [userRow.path]),
          };
        }
      } else {
        for (const row of rows) row.shadow = { state: 'duplicate', winner: null };
      }
    }
  }
};

const journalBefore = (pair: LedgerPairV1Dto): 'dev' | 'pinned' | 'absent' | 'multi-resource' =>
  pair.journal?.before.mode ?? 'multi-resource';

const legacyExpectedNode = (
  journal: LegacyPairJournalV1Dto,
  role: 'backup' | 'store',
  liveMatches: boolean,
): StatusLegacyRetentionRequirement['structural']['expected'] => {
  if (role === 'store') return { kind: 'directory', linkTarget: null };
  if (
    journal.before.mode === 'absent' ||
    journal.phase === 'prepared' ||
    journal.phase === 'staged' ||
    (journal.phase === 'backed-up' && liveMatches)
  ) {
    return { kind: 'absent', linkTarget: null };
  }
  if (journal.before.mode === 'dev') {
    return { kind: 'symlink', linkTarget: journal.before.symlinkTarget };
  }
  return journal.before.liveKind === 'symlink' && journal.before.symlinkTarget !== undefined
    ? { kind: 'symlink', linkTarget: journal.before.symlinkTarget }
    : { kind: 'directory', linkTarget: null };
};

const legacyRetention = (
  journal: LegacyPairJournalV1Dto,
  input: StatusJoinInput,
  row: MutableRow,
): readonly StatusLegacyRetentionRequirement[] => {
  const resources: Array<
    Readonly<{
      role: 'backup' | 'store';
      path: string;
      contentHash: string | null;
    }>
  > = [
    {
      role: 'backup',
      path: journal.backupPath,
      contentHash: journal.before.mode === 'pinned' ? journal.before.contentHash : null,
    },
  ];
  if (
    journal.phase === 'committed' &&
    journal.op === 'dev' &&
    journal.before.mode === 'pinned' &&
    journal.before.storePath !== null
  ) {
    resources.push({
      role: 'store',
      path: journal.before.storePath,
      contentHash: journal.before.contentHash,
    });
  }
  return resources.map((resource): StatusLegacyRetentionRequirement => {
    const expected = legacyExpectedNode(journal, resource.role, legacyLiveMatches(row, journal));
    const expectedContentHash = expected.kind === 'absent' ? null : resource.contentHash;
    const probe = input.retention.find(
      (candidate) =>
        candidate.transactionId === journal.txId &&
        candidate.resourceId === null &&
        candidate.path === resource.path,
    );
    const observedNode: StatusLegacyObservedNode | null =
      probe?.node.state !== 'observed'
        ? null
        : probe.node.kind === 'symlink'
          ? { kind: 'symlink', linkTarget: probe.node.linkTarget ?? '' }
          : probe.node.kind === 'directory'
            ? { kind: 'directory', linkTarget: null }
            : probe.node.kind === 'absent'
              ? { kind: 'absent', linkTarget: null }
              : { kind: probe.node.kind, linkTarget: null };
    const structural: StatusLegacyRetentionRequirement['structural'] =
      probe?.node.state !== 'observed'
        ? { state: 'unverified', expected, observed: null }
        : probe.node.kind === 'absent' && expected.kind !== 'absent'
          ? {
              state: 'missing',
              expected,
              observed: { kind: 'absent', linkTarget: null },
            }
          : {
              state:
                probe.node.kind === expected.kind && probe.node.linkTarget === expected.linkTarget
                  ? 'satisfied'
                  : 'mismatch',
              expected,
              observed: observedNode as StatusLegacyObservedNode,
            };
    const contentHash =
      expectedContentHash === null
        ? ({
            state: 'not-recorded',
            domain: null,
            expected: null,
            observed: null,
          } as const)
        : probe?.contentHash.state === 'observed'
          ? ({
              state: probe.contentHash.digest === expectedContentHash ? 'satisfied' : 'mismatch',
              domain: 'source-content',
              expected: expectedContentHash,
              observed: probe.contentHash.digest,
            } as const)
          : ({
              state: probe?.contentHash.state === 'missing' ? 'missing' : 'unverified',
              domain: 'source-content',
              expected: expectedContentHash,
              observed: null,
            } as const);
    const pathState =
      expected.kind === 'absent' && probe?.node.state === 'observed' && probe.node.kind === 'absent'
        ? ('satisfied' as const)
        : (probe?.pathState ?? 'unverified');
    const state =
      structural.state === 'missing' || contentHash.state === 'missing'
        ? ('missing' as const)
        : structural.state === 'mismatch' || contentHash.state === 'mismatch'
          ? ('mismatch' as const)
          : structural.state === 'unverified' || contentHash.state === 'unverified'
            ? ('unverified' as const)
            : ('satisfied' as const);
    return {
      format: 'legacy-pair',
      resourceId: null,
      retainUntil: null,
      structural,
      repositoryRevision: {
        state: 'not-recorded',
        domain: null,
        expected: null,
        observed: null,
      },
      contentHash,
      ...(resource.role === 'backup'
        ? { role: 'backup', sourceRole: 'live' }
        : { role: 'store', sourceRole: null }),
      path: resource.path,
      pathState,
      state,
    };
  });
};

const retentionEligibility = (
  retention: readonly StatusLegacyRetentionRequirement[],
): 'eligible' | 'retention-missing' | 'retention-mismatch' | 'retention-unverified' => {
  if (retention.some((requirement) => requirement.state === 'missing')) {
    return 'retention-missing';
  }
  if (retention.some((requirement) => requirement.state === 'mismatch')) {
    return 'retention-mismatch';
  }
  if (retention.some((requirement) => requirement.state === 'unverified')) {
    return 'retention-unverified';
  }
  return 'eligible';
};

const legacyLiveMatches = (row: MutableRow, journal: LegacyPairJournalV1Dto): boolean => {
  if (journal.before.mode === 'absent') return row.live === null;
  if (row.live === null) return false;
  const observed = row.live.observation;
  if (journal.before.mode === 'dev') {
    return observed.nodeKind === 'symlink' && observed.linkTarget === journal.before.symlinkTarget;
  }
  return journal.before.liveKind === 'symlink'
    ? observed.nodeKind === 'symlink' && observed.linkTarget === journal.before.symlinkTarget
    : observed.nodeKind === 'directory';
};

const legacyEligibility = (
  row: MutableRow,
  journal: LegacyPairJournalV1Dto,
  retention: readonly StatusLegacyRetentionRequirement[],
):
  | 'eligible'
  | 'not-reversible'
  | 'retention-missing'
  | 'retention-mismatch'
  | 'retention-unverified' => {
  const backup = retention[0];
  const store = retention.find((requirement) => requirement.role === 'store');
  if (journal.phase === 'prepared' || journal.phase === 'staged') {
    if (journal.before.mode !== 'absent' && !legacyLiveMatches(row, journal)) {
      return 'not-reversible';
    }
    return backup === undefined ? 'not-reversible' : retentionEligibility([backup]);
  }
  if (journal.phase === 'backed-up') {
    if (journal.before.mode === 'absent') return retentionEligibility(retention);
    return backup === undefined ? 'not-reversible' : retentionEligibility([backup]);
  }
  if (journal.phase === 'live') {
    return journal.before.mode === 'absent'
      ? retentionEligibility(retention)
      : backup === undefined
        ? 'not-reversible'
        : retentionEligibility([backup]);
  }
  if (journal.op === 'uninstall' && backup !== undefined) return retentionEligibility([backup]);
  if (journal.op === 'promote' && journal.before.mode === 'dev' && backup !== undefined) {
    return retentionEligibility([backup]);
  }
  if (journal.op === 'dev' && journal.before.mode === 'pinned' && store !== undefined) {
    return retentionEligibility([store]);
  }
  return 'not-reversible';
};

const attachLegacyJournals = (rows: Map<string, MutableRow[]>, input: StatusJoinInput): void => {
  for (const values of rows.values()) {
    for (const row of values) {
      const journal = row.ledger?.journal;
      if (journal === undefined || journal === null || row.path === null) continue;
      const argv = ['skillsmith', 'undo', row.path, '--tool', row.tool, '--scope', row.scope];
      const retention = legacyRetention(journal, input, row);
      const eligibility = legacyEligibility(row, journal, retention);
      row.journal =
        journal.phase === 'committed'
          ? {
              state: 'committed',
              format: 'legacy-pair',
              operation: journal.op,
              transactionId: journal.txId,
              phase: 'committed',
              before: journalBefore(row.ledger as LedgerPairV1Dto),
              retention,
              reverseEligibility: eligibility,
              remediation: { reverse: eligibility === 'eligible' ? Object.freeze(argv) : null },
            }
          : {
              state: 'pending',
              format: 'legacy-pair',
              operation: journal.op,
              transactionId: journal.txId,
              phase: journal.phase,
              before: journalBefore(row.ledger as LedgerPairV1Dto),
              retention,
              abortEligibility: eligibility,
              remediation: {
                resume: 'rerun the same operation',
                abort: eligibility === 'eligible' ? Object.freeze(argv) : null,
              },
            };
    }
  }
};

const logicalPath = (journal: LogicalJournalV1Dto): string | null => {
  const paths = new Set(
    [...journal.actual.before, ...journal.actual.after]
      .filter((resource) => resource.role === 'live')
      .map((resource) => resource.placementPath),
  );
  return paths.size === 1 ? ([...paths][0] ?? null) : null;
};

const logicalBefore = (
  journal: LogicalJournalV1Dto,
): 'dev' | 'pinned' | 'absent' | 'multi-resource' => {
  const lives = journal.actual.before.filter((resource) => resource.role === 'live');
  if (lives.length !== 1) return 'multi-resource';
  const live = lives[0];
  if (live === undefined) return 'multi-resource';
  if (live.state === 'absent') return 'absent';
  return live.mode === 'dev' || live.mode === 'pinned' ? live.mode : 'multi-resource';
};

const logicalLiveMatches = (row: MutableRow, journal: LogicalJournalV1Dto): boolean => {
  const lives = journal.actual.before.filter((resource) => resource.role === 'live');
  if (lives.length !== 1) return false;
  const before = lives[0];
  if (before === undefined || before.state === 'absent') return row.live === null;
  if (row.live === null) return false;
  const observed = row.live.observation;
  if (before.liveKind === 'symlink') {
    return observed.nodeKind === 'symlink' && observed.linkTarget === before.symlinkTarget;
  }
  if (before.liveKind === 'directory') return observed.nodeKind === 'directory';
  return observed.nodeKind === before.liveKind;
};

const logicalRetention = (
  journal: LogicalJournalV1Dto,
  input: StatusJoinInput,
): readonly StatusLogicalRetentionRequirement[] =>
  journal.actual.retained.map((retained) => {
    const probe = input.retention.find(
      (candidate) =>
        candidate.transactionId === journal.transactionId &&
        candidate.resourceId === retained.resourceId &&
        candidate.path === retained.path,
    );
    const pathState = probe?.pathState ?? 'unverified';
    const revisionState = probe?.repositoryRevision.state ?? 'unverified';
    const observedRevision =
      probe?.repositoryRevision.state === 'observed' ? probe.repositoryRevision.digest : null;
    const repositoryRevision: StatusRecordedRevisionCheck =
      retained.repositoryRevision.kind === 'artifact-bytes'
        ? observedRevision === null
          ? {
              state: revisionState === 'missing' ? 'missing' : 'unverified',
              expected: {
                kind: 'artifact-bytes',
                digest: retained.repositoryRevision.digest,
              },
              observed: null,
            }
          : {
              state:
                observedRevision === retained.repositoryRevision.digest ? 'satisfied' : 'mismatch',
              expected: {
                kind: 'artifact-bytes',
                digest: retained.repositoryRevision.digest,
              },
              observed: { kind: 'artifact-bytes', digest: observedRevision },
            }
        : observedRevision === null
          ? {
              state: revisionState === 'missing' ? 'missing' : 'unverified',
              expected: { kind: 'resource', digest: retained.repositoryRevision.digest },
              observed: null,
            }
          : {
              state:
                observedRevision === retained.repositoryRevision.digest ? 'satisfied' : 'mismatch',
              expected: { kind: 'resource', digest: retained.repositoryRevision.digest },
              observed: { kind: 'resource', digest: observedRevision },
            };
    const observedContent =
      probe?.contentHash.state === 'observed' ? probe.contentHash.digest : null;
    const contentState = probe?.contentHash.state ?? 'unverified';
    const contentDomain =
      retained.role === 'store' || retained.sourceRole === 'live'
        ? ('source-content' as const)
        : retained.sourceRole === 'manifest'
          ? ('manifest-bytes' as const)
          : retained.sourceRole === 'lock'
            ? ('lock-canonical' as const)
            : ('resource' as const);
    const contentHash =
      observedContent === null
        ? {
            state: contentState === 'missing' ? ('missing' as const) : ('unverified' as const),
            domain: contentDomain,
            expected: retained.contentHash,
            observed: null,
          }
        : {
            state:
              observedContent === retained.contentHash
                ? ('satisfied' as const)
                : ('mismatch' as const),
            domain: contentDomain,
            expected: retained.contentHash,
            observed: observedContent,
          };
    const state =
      pathState === 'missing' ||
      repositoryRevision.state === 'missing' ||
      contentHash.state === 'missing'
        ? ('missing' as const)
        : repositoryRevision.state === 'mismatch' || contentHash.state === 'mismatch'
          ? ('mismatch' as const)
          : pathState === 'unverified' ||
              repositoryRevision.state === 'unverified' ||
              contentHash.state === 'unverified'
            ? ('unverified' as const)
            : ('satisfied' as const);
    return {
      format: 'logical' as const,
      resourceId: retained.resourceId,
      retainUntil: retained.retainUntil,
      repositoryRevision,
      contentHash,
      ...(retained.role === 'store'
        ? { role: 'store' as const, sourceRole: null }
        : { role: 'backup' as const, sourceRole: retained.sourceRole }),
      path: retained.path,
      pathState,
      state,
    };
  });

const logicalEligibility = (
  journal: LogicalJournalV1Dto,
  before: ReturnType<typeof logicalBefore>,
  retention: readonly StatusLogicalRetentionRequirement[],
  row: MutableRow,
):
  | 'eligible'
  | 'not-reversible'
  | 'retention-incomplete'
  | 'retention-missing'
  | 'retention-mismatch'
  | 'retention-unverified' => {
  if (before === 'multi-resource') return 'not-reversible';
  if (before === 'absent' && journal.phase !== 'committed') return 'eligible';
  if (journal.phase === 'prepared' || journal.phase === 'staged') {
    return logicalLiveMatches(row, journal) ? 'eligible' : 'not-reversible';
  }
  if (journal.intent.reversibility.kind === 'none') return 'not-reversible';
  const required = new Set(journal.intent.reversibility.retentionResourceIds);
  const retained = new Set(journal.actual.retained.map((resource) => resource.resourceId));
  if (
    required.size !== retained.size ||
    [...required].some((resourceId) => !retained.has(resourceId))
  ) {
    return 'retention-incomplete';
  }
  if (retention.some((requirement) => requirement.state === 'missing')) {
    return 'retention-missing';
  }
  if (retention.some((requirement) => requirement.state === 'mismatch')) {
    return 'retention-mismatch';
  }
  if (retention.some((requirement) => requirement.state === 'unverified')) {
    return 'retention-unverified';
  }
  return 'eligible';
};

const logicalJournalState = (
  journal: LogicalJournalV1Dto,
  path: string,
  input: StatusJoinInput,
  row: MutableRow,
): StatusJournalState => {
  const before = logicalBefore(journal);
  const retention = logicalRetention(journal, input);
  const eligibility = logicalEligibility(journal, before, retention, row);
  const argv = Object.freeze([
    'skillsmith',
    'undo',
    path,
    '--tool',
    journal.intent.tool as string,
    '--scope',
    journal.intent.scope as string,
  ]);
  return journal.phase === 'committed'
    ? {
        state: 'committed',
        format: 'logical',
        operation: journal.intent.kind,
        transactionId: journal.transactionId,
        phase: 'committed',
        before,
        retention,
        reverseEligibility: eligibility,
        remediation: { reverse: eligibility === 'eligible' ? argv : null },
      }
    : {
        state: 'pending',
        format: 'logical',
        operation: journal.intent.kind,
        transactionId: journal.transactionId,
        phase: journal.phase,
        before,
        retention,
        abortEligibility: eligibility,
        remediation: {
          resume: 'rerun the same operation',
          abort: eligibility === 'eligible' ? argv : null,
        },
      };
};

interface LogicalJournalCandidate {
  readonly journal: LogicalJournalV1Dto;
  readonly pending: boolean;
  readonly name: string;
  readonly tool: string;
  readonly scope: 'user' | 'project';
  readonly projectIdentity: string | null;
  readonly path: string | null;
}

type RankedJournalCandidate =
  | Readonly<{
      format: 'logical';
      pending: boolean;
      timestamp: string;
      transactionId: string;
      candidate: LogicalJournalCandidate;
    }>
  | Readonly<{
      format: 'legacy-pair';
      pending: boolean;
      timestamp: string;
      transactionId: string;
      candidate: LegacyPairJournalV1Dto;
    }>;

const journalProjectRoot = (journal: LogicalJournalV1Dto): string | null | undefined => {
  const roots = new Set<string | null>();
  for (const image of [journal.intent.before, journal.intent.after]) {
    if ((image.kind === 'placement' || image.kind === 'absent') && image.resource.kind === 'live') {
      const root = image.resource.projectRoot;
      if (root !== null && root.kind !== 'machine-bound') return undefined;
      roots.add(root === null ? null : root.path);
    }
  }
  return roots.size === 1 ? [...roots][0] : undefined;
};

const collectLogicalJournals = (input: StatusJoinInput): readonly LogicalJournalCandidate[] => {
  if (input.ledger.state === 'absent') return [];
  const values = [
    ...Object.values(input.ledger.model.transactions).map((journal) => ({
      journal,
      pending: true,
    })),
    ...input.ledger.model.history.map((journal) => ({ journal, pending: false })),
  ];
  const candidates: LogicalJournalCandidate[] = [];
  for (const value of values) {
    const { journal } = value;
    if (
      journal.intent.skill === null ||
      journal.intent.tool === null ||
      journal.intent.scope === null ||
      !selectedTool(journal.intent.tool, input) ||
      !selectedScope(journal.intent.scope, input)
    ) {
      continue;
    }
    let projectIdentity: string | null = null;
    if (journal.intent.scope === 'project') {
      if (input.request.projectPlacement.state === 'unselected') continue;
      const root = journalProjectRoot(journal);
      if (root !== input.request.projectPlacement.identity) continue;
      projectIdentity = input.request.projectPlacement.identity;
    }
    const candidate: LogicalJournalCandidate = {
      journal,
      pending: value.pending && journal.phase !== 'committed',
      name: journal.intent.skill,
      tool: journal.intent.tool,
      scope: journal.intent.scope,
      projectIdentity,
      path: logicalPath(journal),
    };
    if (
      input.request.selectionSource === 'explicit-targets' &&
      !input.request.targets.includes(candidate.name) &&
      (candidate.path === null || !input.request.targets.includes(candidate.path))
    ) {
      continue;
    }
    candidates.push(candidate);
  }
  return candidates;
};

const attachLogicalJournals = (
  rows: Map<string, MutableRow[]>,
  input: StatusJoinInput,
): readonly StatusUnmatchedJournal[] => {
  const candidates = collectLogicalJournals(input);
  const unmatched: StatusUnmatchedJournal[] = [];
  const grouped = new Map<string, LogicalJournalCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.path === null) {
      unmatched.push({
        format: 'logical',
        operation: candidate.journal.intent.kind,
        transactionId: candidate.journal.transactionId,
        phase: candidate.journal.phase,
        reason: 'multi-resource',
      });
      continue;
    }
    const key = JSON.stringify([
      candidate.name,
      candidate.tool,
      candidate.scope,
      candidate.projectIdentity,
      candidate.path,
    ]);
    const values = grouped.get(key) ?? [];
    values.push(candidate);
    grouped.set(key, values);
  }
  for (const candidatesAtPath of grouped.values()) {
    const seed = candidatesAtPath[0];
    if (seed === undefined || seed.path === null) continue;
    const group = rowGroupKey(seed.name, seed.tool, seed.scope, seed.projectIdentity);
    let values = rows.get(group);
    if (values === undefined) {
      values = [];
      rows.set(group, values);
    }
    let row = values.find((candidate) => candidate.path === seed.path);
    if (row === undefined) {
      row = newRow(seed.name, seed.tool, seed.scope, seed.projectIdentity, seed.path);
      values.push(row);
    }
    const legacy = row.ledger?.journal;
    const ranked: RankedJournalCandidate[] = candidatesAtPath.map((candidate) => ({
      format: 'logical',
      pending: candidate.pending,
      timestamp: candidate.journal.updatedAt,
      transactionId: candidate.journal.transactionId,
      candidate,
    }));
    if (legacy !== undefined && legacy !== null) {
      ranked.push({
        format: 'legacy-pair',
        pending: legacy.phase !== 'committed',
        timestamp: legacy.startedAt,
        transactionId: legacy.txId,
        candidate: legacy,
      });
    }
    ranked.sort(
      (left, right) =>
        Number(right.pending) - Number(left.pending) ||
        compare(right.timestamp, left.timestamp) ||
        (left.format === right.format ? 0 : left.format === 'logical' ? -1 : 1) ||
        compare(left.transactionId, right.transactionId),
    );
    const winner = ranked[0];
    if (winner?.format === 'logical') {
      row.journal = logicalJournalState(winner.candidate.journal, seed.path, input, row);
    }
    for (const loser of ranked.slice(1)) {
      unmatched.push(
        loser.format === 'logical'
          ? {
              format: 'logical',
              operation: loser.candidate.journal.intent.kind,
              transactionId: loser.candidate.journal.transactionId,
              phase: loser.candidate.journal.phase,
              reason: 'superseded',
            }
          : {
              format: 'legacy-pair',
              operation: loser.candidate.op,
              transactionId: loser.candidate.txId,
              phase: loser.candidate.phase,
              reason: 'superseded',
            },
      );
    }
  }
  return unmatched.sort(
    (left, right) =>
      compare(left.transactionId, right.transactionId) || compare(left.reason, right.reason),
  );
};

const relationshipFor = (
  input: StatusJoinInput,
  selectedNames: ReadonlySet<string>,
): StatusArtifactRelationship => {
  if (input.manifest === null || input.lock === null) return { state: 'none' };
  const manifestPresent = input.manifest.state === 'present';
  const lockPresent = input.lock.state === 'present';
  if (!manifestPresent && !lockPresent) return { state: 'none' };
  if (manifestPresent && input.manifest.sourceVersion === 'legacy') {
    return lockPresent && selectedNames.size > 0 ? { state: 'lock-only' } : { state: 'none' };
  }
  if (selectedNames.size === 0) {
    return manifestPresent && input.manifest.model.skills.length === 0 && !lockPresent
      ? { state: 'missing-lock' }
      : { state: 'none' };
  }
  if (manifestPresent && !lockPresent) return { state: 'missing-lock' };
  if (!manifestPresent && lockPresent) return { state: 'lock-only' };
  if (!manifestPresent || !lockPresent) return { state: 'none' };
  const relationship = correlatePortableLock(input.manifest.model, input.lock.model);
  if (relationship.state === 'missing-lock' || relationship.state === 'current')
    return relationship;
  if (relationship.state === 'incomplete') {
    const facts = relationship.facts.filter((fact) => selectedNames.has(fact.name));
    if (facts.length === 0) return { state: 'none' };
    return {
      state: 'incomplete',
      missingNames: uniqueSorted(
        facts.filter((fact) => fact.reason === 'missing-entry').map((fact) => fact.name),
      ),
      facts,
    };
  }
  const completeUniverse =
    selectedNames.size ===
    new Set([
      ...input.manifest.model.skills.map((skill) => skill.name),
      ...input.lock.model.skills.map((skill) => skill.name),
    ]).size;
  const facts = relationship.facts.filter(
    (fact) =>
      (fact.reason === 'manifest-hash-mismatch' && completeUniverse) ||
      ('name' in fact && selectedNames.has(fact.name)),
  );
  return facts.length === 0 ? { state: 'current' } : { state: 'stale', facts };
};

const portableEntryFacts = (
  input: StatusJoinInput,
  name: string,
  desired: StatusDesiredState | null,
  locked: StatusLockedState | null,
): readonly StatusFact[] => {
  if (desired !== null && (input.lock === null || input.lock.state === 'absent')) {
    return Object.freeze([makeFact('manifest-only', 'absent', 'present')]);
  }
  if (locked !== null && desired === null) {
    return Object.freeze([makeFact('lock-only', 'absent', 'present')]);
  }
  if (
    input.manifest === null ||
    input.manifest.state === 'absent' ||
    input.manifest.sourceVersion === 'legacy' ||
    input.lock === null ||
    input.lock.state === 'absent'
  ) {
    return Object.freeze([]);
  }
  const relationship = correlatePortableLock(input.manifest.model, input.lock.model);
  if (relationship.state === 'current' || relationship.state === 'missing-lock') return [];
  const facts = relationship.facts.flatMap((item): StatusFact[] => {
    if (!('name' in item) || item.name !== name) return [];
    const mapping: Partial<Record<typeof item.reason, StatusFactCode>> = {
      'missing-entry': 'lock-missing-entry',
      'extra-entry': 'lock-extra-entry',
      'source-mismatch': 'lock-source',
      'requested-ref-mismatch': 'lock-ref',
      'source-path-mismatch': 'lock-source-path',
    };
    const code = mapping[item.reason];
    return code === undefined ? [] : [makeFact(code, 'current', 'mismatch')];
  });
  return sortFacts(facts);
};

const rowSort = (left: MutableRow, right: MutableRow): number =>
  (TOOL_ORDER.get(left.tool) ?? Number.MAX_SAFE_INTEGER) -
    (TOOL_ORDER.get(right.tool) ?? Number.MAX_SAFE_INTEGER) ||
  (TOOL_ORDER.has(left.tool) && TOOL_ORDER.has(right.tool) ? 0 : compare(left.tool, right.tool)) ||
  (SCOPE_ORDER.get(left.scope) ?? Number.MAX_SAFE_INTEGER) -
    (SCOPE_ORDER.get(right.scope) ?? Number.MAX_SAFE_INTEGER) ||
  compare(left.projectIdentity ?? '', right.projectIdentity ?? '') ||
  compare(left.path ?? '', right.path ?? '');

export const joinStatus = (
  input: StatusJoinInput,
): Result<StatusReport, StatusJoinSelectionError> => {
  const desiredCollection = collectDesired(input);
  const ledgers = collectLedger(input);
  const selectedDesiredNames = new Set(
    desiredCollection.selected.map((item) => item.declaration.name),
  );
  const ledgerNames = new Set(ledgers.map((item) => item.name));
  const lockSkills =
    input.lock !== null && input.lock.state === 'present' ? input.lock.model.skills : [];
  const legacyDefaults =
    input.manifest !== null &&
    input.manifest.state === 'present' &&
    input.manifest.sourceVersion === 'legacy'
      ? input.manifest.model.defaults
      : undefined;
  const legacyQualified =
    legacyDefaults?.tools !== undefined && legacyDefaults.scope !== undefined
      ? legacyDefaults.tools.some((tool) => selectedTool(tool, input)) &&
        selectedScope(legacyDefaults.scope, input) &&
        (legacyDefaults.scope !== 'project' || input.request.projectPlacement.state === 'selected')
      : null;
  const visibleLocks = lockSkills.filter((skill) => {
    if (selectedDesiredNames.has(skill.name) || ledgerNames.has(skill.name)) return true;
    if (legacyQualified !== null) return legacyQualified;
    return (
      input.request.toolSelectionSource === 'unbounded-default' &&
      input.request.scopeSelectionSource === 'unbounded-default'
    );
  });
  const filteredNames = new Set(desiredCollection.filtered);
  for (const skill of lockSkills) if (!visibleLocks.includes(skill)) filteredNames.add(skill.name);

  const rows = buildRows(input, desiredCollection.selected, ledgers);
  attachLegacyJournals(rows, input);
  const unmatchedJournals = attachLogicalJournals(rows, input);
  const entries = new Map<string, MutableEntry>();
  const entry = (name: string): MutableEntry => {
    let value = entries.get(name);
    if (value === undefined) {
      value = { name, desired: null, locked: null, rows: [], facts: [] };
      entries.set(name, value);
    }
    return value;
  };
  for (const candidate of desiredCollection.selected) {
    entry(candidate.declaration.name).desired = statusDesired(
      candidate.declaration,
      candidate.path,
    );
  }
  for (const skill of visibleLocks) entry(skill.name).locked = statusLocked(skill);
  for (const values of rows.values()) {
    for (const row of values) entry(row.name).rows.push(row);
  }
  setShadows(entries);

  for (const value of entries.values()) {
    value.facts = [...portableEntryFacts(input, value.name, value.desired, value.locked)];
  }

  let selectedEntries = [...entries.values()];
  if (input.request.selectionSource === 'explicit-targets') {
    const selected = new Set<MutableEntry>();
    const unmatched: string[] = [];
    let filtered = false;
    for (const target of input.request.targets) {
      const matches = selectedEntries.filter(
        (candidate) =>
          candidate.name === target || candidate.rows.some((row) => row.path === target),
      );
      if (matches.length === 0) {
        if (filteredNames.has(target)) filtered = true;
        else unmatched.push(target);
      }
      for (const match of matches) selected.add(match);
    }
    if (unmatched.length > 0) return err({ reason: 'unmatched-target' });
    selectedEntries = [...selected];
    if (selectedEntries.length === 0 && !filtered) return err({ reason: 'unmatched-target' });
  }

  selectedEntries.sort((left, right) => compare(left.name, right.name));
  const selectedNameSet = new Set(selectedEntries.map((value) => value.name));
  const projectedEntries: StatusEntry[] = selectedEntries.map((value) => {
    value.rows.sort(rowSort);
    const placements: StatusPlacement[] = value.rows.map((row) => {
      const classified = rowClass(row);
      const verification = row.ledger?.pinned?.verify ?? 'unrecorded';
      return {
        identity: {
          tool: row.tool,
          scope: row.scope,
          projectIdentity: row.projectIdentity,
          path: row.path,
        },
        ledger:
          row.ledger === null
            ? { state: 'absent' }
            : { state: 'present', value: ledgerObservation(row.ledger) },
        live:
          row.live === null
            ? { state: 'absent' }
            : { state: 'present', value: row.live.observation },
        classification: classified.classification,
        brokenReason: classified.brokenReason,
        verification,
        shadow: row.shadow,
        journal: row.journal,
        facts: factsForRow(
          row,
          value.locked,
          classified.classification,
          classified.brokenReason,
          verification,
        ),
      };
    });
    const entryFacts = sortFacts(value.facts);
    const convergence = [...entryFacts, ...placements.flatMap((placement) => placement.facts)].some(
      (fact) => fact.impact === 'drift',
    )
      ? 'drift'
      : 'converged';
    return {
      name: value.name,
      desired:
        value.desired === null ? { state: 'absent' } : { state: 'present', value: value.desired },
      locked:
        value.locked === null ? { state: 'absent' } : { state: 'present', value: value.locked },
      placements,
      facts: entryFacts,
      convergence,
    };
  });

  const relationship = relationshipFor(input, selectedNameSet);
  const summaryMigration =
    (input.manifest !== null &&
      input.manifest.state === 'present' &&
      input.manifest.sourceVersion === 'legacy') ||
    (input.ledger.state === 'present' && input.ledger.sourceVersion === 1);
  const reportFacts: StatusFact[] = [];
  if (
    input.manifest !== null &&
    input.manifest.state === 'present' &&
    input.manifest.sourceVersion !== 'legacy' &&
    input.manifest.model.skills.length === 0 &&
    (input.lock === null || input.lock.state === 'absent')
  ) {
    reportFacts.push(makeFact('manifest-only', 'absent', 'present'));
  }
  if (input.ledger.state === 'present' && input.ledger.sourceVersion === 1) {
    reportFacts.push(makeFact('ledger-migration-pending', 'current-v2', 'source-v1'));
  }
  if (relationship.state === 'stale') {
    for (const portable of relationship.facts) {
      if (portable.reason === 'manifest-hash-mismatch') {
        reportFacts.push(makeFact('lock-manifest-hash', 'current', 'mismatch'));
      }
    }
  }
  for (const journal of unmatchedJournals) {
    if (journal.phase !== 'committed') {
      reportFacts.push(makeFact('journal-pending', 'committed', journal.phase));
    }
  }
  const filterNoop =
    projectedEntries.length === 0 &&
    (input.request.selectionSource === 'explicit-targets'
      ? input.request.targets.some((target) => filteredNames.has(target))
      : filteredNames.size > 0);
  const drifting = projectedEntries.filter((value) => value.convergence === 'drift').length;
  return ok(
    deepFreeze({
      selection: {
        source: input.request.selectionSource,
        targets: [...input.request.targets],
        tools: [...input.request.tools],
        toolSource: input.request.toolSelectionSource,
        scopes: [...input.request.scopes],
        scopeSource: input.request.scopeSelectionSource,
        ...(filterNoop
          ? { outcome: 'filter-noop' as const, reason: FILTER_NOOP_REASON }
          : { outcome: 'selected' as const, reason: null }),
      },
      context: {
        effectiveCwd: input.request.projectContext.effectiveCwd,
        projectRoot:
          input.request.projectPlacement.state === 'selected'
            ? input.request.projectPlacement.root
            : null,
        projectIdentity:
          input.request.projectPlacement.state === 'selected'
            ? input.request.projectPlacement.identity
            : null,
        projectSource:
          input.request.projectPlacement.state === 'selected'
            ? input.request.projectPlacement.source
            : null,
      },
      artifacts:
        input.request.artifactSelection.state === 'unselected'
          ? { state: 'unselected' as const, reason: 'live-only-scope' as const }
          : {
              state: 'selected' as const,
              source: input.request.artifactSelection.source,
              manifestPath: input.request.artifactSelection.manifestPath,
              lockPath: input.request.artifactSelection.lockPath,
              lockSource: input.request.artifactSelection.lockSource,
              manifest: manifestSummary(input.manifest),
              lock: lockSummary(input.lock),
              relationship,
            },
      ledger: ledgerSummary(input.ledger, input.ledgerPath),
      journals: unmatchedJournals,
      facts: sortFacts(reportFacts),
      entries: projectedEntries,
      summary: {
        entries: projectedEntries.length,
        converged: projectedEntries.length - drifting,
        drifting,
        migrationPending: summaryMigration,
      },
    } satisfies StatusReport),
  );
};
