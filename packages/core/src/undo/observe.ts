import { dirname } from 'node:path';
import { toolRegistry } from '../agents/registry.ts';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import {
  resolveFreshRollbackLineage,
  resolveFreshRollbackParent,
} from '../artifacts/ledger-history.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import { committedPlacementCleanupTransactionForTarget } from '../place/swap.ts';
import { createOperationGroupId } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { ResolvedRuntimeConfiguration } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { resolveTargetSelection } from '../selection/resolve.ts';
import type { TargetSelection, TargetSelectionError } from '../selection/types.ts';
import { readLifecycleHistoryStatus } from '../status/read.ts';
import type { StatusJournalState, StatusPlacement } from '../status/types.ts';
import type {
  UndoArtifactCandidate,
  UndoCandidate,
  UndoError,
  UndoJournalAuthority,
  UndoObservation,
  UndoOperationFamily,
  UndoRequest,
  UndoScope,
  UndoTool,
  ValidatedUndoSelection,
} from './types.ts';

export interface ObserveUndoRuntime {
  readonly ports: Parameters<typeof readLifecycleHistoryStatus>[0];
  readonly projectContext: UndoObservation['projectContext'];
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly signal?: AbortSignal;
}

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  // Typed-array indices cannot be frozen in JavaScript. Ledger bytes are already an owned copy;
  // treat that byte view as an opaque observation value while freezing its containing envelope.
  if (ArrayBuffer.isView(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const failure = (code: string, message: string, exitClass: UndoError['exitClass']): UndoError =>
  Object.freeze({ code, message, exitClass });

const undoTools = Object.freeze(toolRegistry.toolsFor('undo')) as readonly UndoTool[];
const undoToolSet: ReadonlySet<string> = new Set(undoTools);
const undoToolOrder = new Map(undoTools.map((tool, index) => [tool, index] as const));
const isUndoTool = (tool: string): tool is UndoTool => undoToolSet.has(tool);
const toolOrder = (tool: UndoTool): number => undoToolOrder.get(tool) ?? Number.MAX_SAFE_INTEGER;

const familyFor = (operation: string): UndoOperationFamily | null => {
  switch (operation) {
    case 'dev':
    case 'link-dev':
      return 'dev';
    case 'promote':
      return 'promote';
    case 'install':
      return 'install';
    case 'uninstall':
    case 'remove':
      return 'uninstall';
    case 'update':
      return 'update';
    default:
      return null;
  }
};

const updateRepairCarrier = (
  ledger: LedgerModel,
  source: LogicalJournalV1Dto,
): LogicalJournalV1Dto | null => {
  if (
    source.intent.kind !== 'repair' ||
    source.phase !== 'committed' ||
    source.disposition !== 'forward' ||
    source.context.command !== 'skillsmith-place' ||
    source.context.workflow !== 'placement-swap' ||
    source.intent.reversibility.kind !== 'conditional' ||
    source.intent.reversibility.retentionResourceIds.length !== 1 ||
    source.actual.retained.length !== 1 ||
    source.actual.retained[0]?.role !== 'store'
  ) {
    return null;
  }
  const sourceIndex = ledger.history.findIndex(
    ({ transactionId }) => transactionId === source.transactionId,
  );
  if (sourceIndex < 0) return null;
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    const candidate = ledger.history[index];
    if (
      candidate !== undefined &&
      candidate.phase === 'committed' &&
      candidate.disposition === 'forward' &&
      candidate.intent.groupId === source.intent.groupId &&
      candidate.intent.pairId === null &&
      (candidate.intent.kind === 'write-manifest' || candidate.intent.kind === 'write-lock') &&
      candidate.context.command === 'update' &&
      candidate.context.workflow === 'update-artifact-history'
    ) {
      return candidate;
    }
  }
  return null;
};

const logicalAuthority = (
  ledger: LedgerModel,
  state: Extract<StatusJournalState, { readonly format: 'logical' }>,
): Result<Extract<UndoJournalAuthority, { readonly format: 'logical' }>, UndoError> => {
  const journal =
    ledger.transactions[state.transactionId] ??
    ledger.history.find((candidate) => candidate.transactionId === state.transactionId);
  if (journal === undefined) {
    return err(failure('undo-journal-correlation', 'selected logical journal is missing', 'state'));
  }
  const resolvedParent = resolveFreshRollbackParent(ledger.history, ledger.transactions, journal);
  if (!resolvedParent.ok) {
    return err(
      failure(
        'undo-journal-linkage',
        'selected rollback journal has inconsistent forward lineage',
        'state',
      ),
    );
  }
  const source = journal.disposition === 'rollback' ? resolvedParent.value : journal;
  if (journal.disposition === 'rollback' && source === null) {
    // A converted pending abort points back to its own operation and has no committed parent row.
    if (
      journal.phase !== 'committed' &&
      journal.context.parentOperationId === journal.intent.operationId
    ) {
      return ok(Object.freeze({ format: 'logical', journal, source: journal }));
    }
    return err(
      failure(
        'undo-journal-linkage',
        'selected rollback journal has no valid forward origin',
        'state',
      ),
    );
  }
  return ok(Object.freeze({ format: 'logical', journal, source: source ?? journal }));
};

const liveMatchesCommittedRollback = (
  placement: StatusPlacement,
  journal: LogicalJournalV1Dto,
): boolean => {
  const live = journal.actual.after.find((resource) => resource.role === 'live');
  if (live === undefined) return false;
  if (live.state === 'absent') return placement.live.state === 'absent';
  if (placement.live.state === 'absent') return false;
  return (
    placement.identity.path === live.placementPath &&
    (live.liveKind === 'directory'
      ? placement.live.value.nodeKind === 'directory'
      : live.liveKind === 'symlink'
        ? placement.live.value.nodeKind === 'symlink' &&
          placement.live.value.linkTarget === live.symlinkTarget
        : placement.live.value.nodeKind === live.liveKind)
  );
};

/** Internal status-to-undo projection, exported for focused lifecycle identity regression coverage. */
export const candidateForStatusPlacement = (
  ledger: LedgerModel,
  name: string,
  placement: StatusPlacement,
): Result<UndoCandidate | null, UndoError> => {
  const journalState = placement.journal;
  if (journalState.state === 'none' || placement.identity.path === null) return ok(null);
  const tool = placement.identity.tool;
  if (!isUndoTool(tool)) return ok(null);
  const scope = placement.identity.scope;
  if (scope !== 'user' && scope !== 'project') return ok(null);
  const projectRoot = scope === 'project' ? placement.identity.projectIdentity : null;
  const ledgerPair = (
    projectRoot === null ? ledger.skills : ledger.projects[projectRoot]?.skills
  )?.[name]?.tools[tool];

  let authority: UndoJournalAuthority;
  let disposition: 'forward' | 'rollback';
  let operationFamily: UndoOperationFamily | null;
  let sourceTransactionId: string;
  let sourceOperationId: string | null;
  let activeOperationId: string | null;
  let parentOperationId: string | null;
  if (journalState.format === 'logical') {
    const correlated = logicalAuthority(ledger, journalState);
    if (!correlated.ok) return correlated;
    authority = correlated.value;
    const journal = authority.journal;
    disposition = journal.disposition;
    operationFamily =
      familyFor(authority.source.intent.kind) ??
      (updateRepairCarrier(ledger, authority.source) === null ? null : 'update');
    sourceTransactionId = authority.source.transactionId;
    sourceOperationId = authority.source.intent.operationId;
    activeOperationId = journal.intent.operationId;
    parentOperationId = journal.context.parentOperationId;
  } else {
    const pair = ledgerPair;
    if (pair === undefined || pair.journal?.txId !== journalState.transactionId) {
      return err(
        failure('undo-journal-correlation', 'selected legacy pair journal is missing', 'state'),
      );
    }
    authority = Object.freeze({ format: 'legacy-pair', journal: pair.journal, pair });
    disposition = pair.journal.op === 'rollback' ? 'rollback' : 'forward';
    operationFamily = familyFor(pair.journal.op);
    sourceTransactionId = pair.journal.txId;
    sourceOperationId = null;
    activeOperationId = null;
    parentOperationId = null;
  }
  if (operationFamily === null) {
    return err(
      failure(
        'undo-operation-family',
        `the newest retained operation for '${name}' is not reversible by this release`,
        'state',
      ),
    );
  }
  const eligibility =
    journalState.state === 'pending'
      ? journalState.abortEligibility
      : journalState.reverseEligibility;
  const alreadyReversed =
    journalState.state === 'committed' &&
    disposition === 'rollback' &&
    authority.format === 'logical' &&
    liveMatchesCommittedRollback(placement, authority.journal);
  const live = placement.live.state === 'present' ? placement.live.value : null;
  const classification = placement.classification;
  const sourceGroupId =
    authority.format === 'logical'
      ? authority.source.intent.groupId
      : createOperationGroupId({
          domain: 'skillsmith.operation-group-identity',
          schemaVersion: 1,
          command: 'undo',
          skill: name,
          source: null,
          scope,
          target: placement.identity.path,
        });
  const cleanupTransaction = alreadyReversed
    ? committedPlacementCleanupTransactionForTarget(ledger, name, tool, projectRoot)
    : ok(null);
  if (!cleanupTransaction.ok) {
    return err(
      failure(
        'undo-cleanup-carrier',
        'selected committed cleanup carrier is inconsistent',
        'state',
      ),
    );
  }
  const recoveryState =
    authority.format === 'logical' && cleanupTransaction.value === authority.journal.transactionId
      ? ('cleanup-pending' as const)
      : ('none' as const);
  return ok(
    deepFreeze({
      name,
      sourceGroupId,
      tool,
      scope,
      projectIdentity: placement.identity.projectIdentity,
      path: placement.identity.path,
      placement: {
        skill: name,
        root: dirname(placement.identity.path),
        path: placement.identity.path,
        class:
          classification === 'dev' ||
          classification === 'pinned' ||
          classification === 'store-linked'
            ? classification
            : 'absent',
        symlinkTarget: live?.nodeKind === 'symlink' ? live.linkTarget : null,
        dangling: placement.brokenReason === 'dangling-link',
      },
      capabilities: ['undo'] as const,
      exists: true as const,
      action: journalState.state === 'pending' ? 'abort-pending' : 'reverse-committed',
      outcome: alreadyReversed ? ('already-reversed' as const) : ('selected' as const),
      operationFamily,
      disposition,
      phase: journalState.phase,
      executionMode:
        journalState.state === 'pending' && disposition === 'forward'
          ? ('convert-to-rollback' as const)
          : ('resume-rollback' as const),
      recoveryState,
      before: journalState.before,
      eligibility,
      retention: journalState.retention,
      sourceTransactionId,
      activeTransactionId: journalState.transactionId,
      sourceOperationId,
      activeOperationId,
      parentOperationId,
      authority,
    }),
  );
};

const selectedScopes = (
  selection: ValidatedUndoSelection,
  projectContext: ObserveUndoRuntime['projectContext'],
): readonly UndoScope[] => {
  if (selection.scopes.length > 0) {
    return selection.scopes.filter(
      (scope): scope is UndoScope => scope === 'user' || scope === 'project',
    );
  }
  return projectContext.projectRoot === null ? ['user'] : ['user', 'project'];
};

const selectedTools = (selection: ValidatedUndoSelection): readonly UndoTool[] =>
  selection.tools.length > 0 ? selection.tools : undoTools;

const immutableRequest = (
  request: UndoRequest,
  tools: readonly UndoTool[],
  scopes: readonly UndoScope[],
): UndoRequest => deepFreeze({ ...request, tools: [...tools], scopes: [...scopes] });

const wildcardTarget = (target: string): boolean => target.includes('*') || target.includes('?');

const candidateAnchor = (candidate: UndoCandidate): string =>
  JSON.stringify([candidate.scope, candidate.projectIdentity, candidate.tool, candidate.path]);

const recoverSameSourceGroupAmbiguity = (
  target: string,
  candidates: readonly UndoCandidate[],
  selectedTools: readonly UndoTool[],
): readonly UndoCandidate[] | null => {
  if (
    wildcardTarget(target) ||
    candidates.length < 2 ||
    candidates.some(
      (candidate) => candidate.name !== target || !selectedTools.includes(candidate.tool),
    )
  ) {
    return null;
  }
  const scopes = new Set(candidates.map(({ scope }) => scope));
  const tools = new Set(candidates.map(({ tool }) => tool));
  const groupIds = new Set(candidates.map(({ sourceGroupId }) => sourceGroupId));
  if (scopes.size !== 1 || tools.size !== candidates.length || groupIds.size !== 1) return null;
  return [...candidates].sort(
    (left, right) =>
      toolOrder(left.tool) - toolOrder(right.tool) || left.path.localeCompare(right.path),
  );
};

export const resolveUndoTargetSelection = (
  candidates: readonly UndoCandidate[],
  selection: ValidatedUndoSelection,
  tools: readonly UndoTool[],
  scopes: readonly UndoScope[],
): Result<TargetSelection<UndoCandidate>, TargetSelectionError<UndoCandidate>> => {
  const request = { ...selection, tools, scopes };
  const resolved = resolveTargetSelection(candidates, request);
  if (resolved.ok || resolved.error.code !== 'ambiguous') return resolved;

  const selected: UndoCandidate[] = [];
  const selectedAnchors = new Set<string>();
  const unmatched: string[] = [];
  let filteredMatch = false;
  for (const target of selection.targets) {
    const one = resolveTargetSelection(candidates, { ...request, targets: [target] });
    if (one.ok) {
      filteredMatch ||= one.value.outcome === 'filter-noop';
      for (const candidate of one.value.selected) {
        const anchor = candidateAnchor(candidate);
        if (!selectedAnchors.has(anchor)) {
          selectedAnchors.add(anchor);
          selected.push(candidate);
        }
      }
      continue;
    }
    if (one.error.code === 'unmatched') {
      unmatched.push(target);
      continue;
    }
    const recovered = recoverSameSourceGroupAmbiguity(target, one.error.candidates, tools);
    if (recovered === null) return one;
    for (const candidate of recovered) {
      const anchor = candidateAnchor(candidate);
      if (!selectedAnchors.has(anchor)) {
        selectedAnchors.add(anchor);
        selected.push(candidate);
      }
    }
  }
  if (unmatched.length > 0) {
    return err({
      code: 'unmatched',
      exitCode: 2,
      targets: unmatched,
      message: `no target matched: ${unmatched.join(', ')}`,
    });
  }
  if (selected.length === 0 && !filteredMatch) {
    return err({
      code: 'unmatched',
      exitCode: 2,
      targets: selection.targets,
      message: `no target matched: ${selection.targets.join(', ')}`,
    });
  }
  return ok(
    selected.length > 0
      ? { selected, selectionSource: 'explicit-targets', outcome: 'selected' }
      : {
          selected,
          selectionSource: 'explicit-targets',
          outcome: 'filter-noop',
          reason: 'valid selection was reduced to zero by active filters',
        },
  );
};

/**
 * Observe bounded user/current-project history through status, then apply the shared exact target
 * resolver. Status owns pending-before-history and retention eligibility; undo never recomputes it.
 */
export const observeUndo = async (
  request: UndoRequest,
  selection: ValidatedUndoSelection,
  runtime: ObserveUndoRuntime,
): Promise<Result<UndoObservation, UndoError>> => {
  if (runtime.signal?.aborted) {
    return err(failure('undo-cancelled', 'undo observation was cancelled', 'cancelled'));
  }
  const scopes = selectedScopes(selection, runtime.projectContext);
  if (scopes.includes('project') && runtime.projectContext.projectRoot === null) {
    return err(
      failure(
        'undo-project-context',
        'project scope requires an explicit valid project context',
        'usage',
      ),
    );
  }
  const tools = selectedTools(selection);
  let canonicalCwd: string;
  let canonicalRoot: string | null = null;
  try {
    canonicalCwd = await runtime.ports.realpath(runtime.projectContext.effectiveCwd);
    if (runtime.projectContext.projectRoot !== null) {
      canonicalRoot = await runtime.ports.realpath(runtime.projectContext.projectRoot);
    }
  } catch {
    return err(failure('undo-project-context', 'project context could not be observed', 'failure'));
  }
  const status = await readLifecycleHistoryStatus(runtime.ports, {
    projectContext: runtime.projectContext,
    projectPlacement:
      canonicalRoot === null
        ? { state: 'unselected' }
        : {
            state: 'selected',
            source: 'shared-project',
            canonicalCwd,
            root: canonicalRoot,
            identity: runtime.projectContext.projectIdentity ?? canonicalRoot,
          },
    configuration: runtime.configuration,
    targets: [],
    tools,
    toolSelectionSource: selection.tools.length > 0 ? 'explicit' : 'unbounded-default',
    scopes,
    scopeSelectionSource: selection.scopes.length > 0 ? 'explicit' : 'unbounded-default',
    selectionSource: 'bounded-default',
    artifactSelection: { state: 'unselected', reason: 'lifecycle-history' },
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (!status.ok) {
    return err(
      failure(`undo-${status.error.reason}`, status.error.message, status.error.exitClass),
    );
  }
  const { report, ledgerPath, ledgerState, artifactRetention } = status.value;
  const ledger: LedgerModel =
    ledgerState.state === 'present'
      ? ledgerState.model
      : {
          updatedAt: '',
          skills: {},
          projects: {},
          projectRegistrations: {},
          transactions: {},
          history: [],
        };
  const immutableLedgerState: LedgerReadState =
    ledgerState.state === 'present'
      ? { ...ledgerState, bytes: new Uint8Array(ledgerState.bytes) }
      : ledgerState;
  const candidates: UndoCandidate[] = [];
  for (const entry of report.entries) {
    for (const placement of entry.placements) {
      const candidate = candidateForStatusPlacement(ledger, entry.name, placement);
      if (!candidate.ok) return candidate;
      if (candidate.value !== null) candidates.push(candidate.value);
    }
  }
  const resolved = resolveUndoTargetSelection(candidates, selection, tools, scopes);
  if (!resolved.ok) {
    return err(failure(`undo-${resolved.error.code}`, resolved.error.message, 'usage'));
  }
  const ordered = [...resolved.value.selected].sort(
    (left, right) =>
      (left.scope === right.scope ? 0 : left.scope === 'user' ? -1 : 1) ||
      left.name.localeCompare(right.name) ||
      left.sourceGroupId.localeCompare(right.sourceGroupId) ||
      toolOrder(left.tool) - toolOrder(right.tool) ||
      left.path.localeCompare(right.path),
  );
  const pairAnchors = new Set<string>();
  for (const candidate of ordered) {
    const anchor = JSON.stringify([candidate.name, candidate.scope, candidate.tool]);
    if (pairAnchors.has(anchor)) {
      return err(
        failure(
          'undo-ambiguous',
          `target '${candidate.name}' is ambiguous; select an exact path or tool`,
          'usage',
        ),
      );
    }
    pairAnchors.add(anchor);
  }
  const artifacts: UndoArtifactCandidate[] = [];
  const updateGroups = new Set(
    ordered
      .filter(
        ({ operationFamily, outcome }) =>
          operationFamily === 'update' && outcome !== 'already-reversed',
      )
      .map(({ sourceGroupId }) => sourceGroupId),
  );
  const historyIndex = new Map(
    ledger.history.map((journal, index) => [journal.transactionId, index] as const),
  );
  const freshLineage = resolveFreshRollbackLineage(ledger.history, ledger.transactions);
  if (!freshLineage.ok) {
    return err(
      failure(
        'undo-artifact-lineage',
        'retained update rollback lineage is ambiguous or incomplete',
        'state',
      ),
    );
  }
  const journalByTransactionId = new Map(
    [...ledger.history, ...Object.values(ledger.transactions)].map(
      (journal) => [journal.transactionId, journal] as const,
    ),
  );
  for (const sourceGroupId of updateGroups) {
    const selectedIndexes = ordered
      .filter(
        (candidate) =>
          candidate.sourceGroupId === sourceGroupId &&
          candidate.operationFamily === 'update' &&
          candidate.outcome !== 'already-reversed',
      )
      .map(({ sourceTransactionId }) => historyIndex.get(sourceTransactionId))
      .filter((index): index is number => index !== undefined);
    if (selectedIndexes.length === 0) {
      return err(
        failure(
          'undo-artifact-lineage',
          'selected update history has no commit-order anchor',
          'state',
        ),
      );
    }
    const beforeIndex = Math.min(...selectedIndexes);
    const nearestByRole = new Map<'manifest' | 'lock', (typeof artifactRetention)[number]>();
    for (const retained of artifactRetention) {
      const index = historyIndex.get(retained.transactionId);
      if (retained.groupId !== sourceGroupId || index === undefined || index >= beforeIndex)
        continue;
      const previous = nearestByRole.get(retained.role);
      const previousIndex =
        previous === undefined ? -1 : (historyIndex.get(previous.transactionId) ?? -1);
      if (index > previousIndex) nearestByRole.set(retained.role, retained);
    }
    if (nearestByRole.size === 0) {
      return err(
        failure(
          'undo-artifact-lineage',
          'selected update predates exact retained artifact history and cannot be reversed safely',
          'state',
        ),
      );
    }
    for (const retained of [...nearestByRole.values()].sort((left, right) =>
      left.role === right.role ? 0 : left.role === 'manifest' ? -1 : 1,
    )) {
      const journal = ledger.history[historyIndex.get(retained.transactionId) ?? -1];
      if (journal === undefined || retained.state !== 'satisfied' || retained.envelope === null) {
        return err(
          failure(
            'undo-artifact-retention',
            `retained ${retained.role} preimage is ${retained.state} and cannot be restored`,
            'state',
          ),
        );
      }
      const childTransactionId =
        freshLineage.value.childTransactionIdByParentTransactionId[journal.transactionId];
      const rollbackJournal =
        childTransactionId === undefined
          ? null
          : (journalByTransactionId.get(childTransactionId) ?? null);
      if (childTransactionId !== undefined && rollbackJournal === null) {
        return err(
          failure(
            'undo-artifact-lineage',
            `retained ${retained.role} rollback child is missing from history`,
            'state',
          ),
        );
      }
      artifacts.push(
        deepFreeze({
          physicalHead: false,
          action:
            rollbackJournal === null
              ? 'restore'
              : rollbackJournal.phase === 'committed'
                ? 'already-restored'
                : 'resume',
          role: retained.role,
          artifactPath: retained.artifactPath,
          retainedPath: retained.retainedPath,
          sourceTransactionId: retained.transactionId,
          sourceOperationId: retained.operationId,
          sourceGroupId,
          journal,
          rollbackJournal,
          envelope: retained.envelope,
        }),
      );
    }
  }
  const selectedArtifactTransactions = new Set(
    artifacts.map(({ sourceTransactionId }) => sourceTransactionId),
  );
  const activeArtifactRetention = artifactRetention.filter((retained) => {
    const childTransactionId =
      freshLineage.value.childTransactionIdByParentTransactionId[retained.transactionId];
    if (childTransactionId === undefined) return true;
    return journalByTransactionId.get(childTransactionId)?.phase !== 'committed';
  });
  for (const artifact of artifacts) {
    const artifactIndex = historyIndex.get(artifact.sourceTransactionId);
    if (artifactIndex === undefined) continue;
    const omittedNewer = activeArtifactRetention.find((retained) => {
      const retainedIndex = historyIndex.get(retained.transactionId);
      return (
        retained.role === artifact.role &&
        retained.artifactPath === artifact.artifactPath &&
        retainedIndex !== undefined &&
        retainedIndex > artifactIndex &&
        !selectedArtifactTransactions.has(retained.transactionId)
      );
    });
    if (omittedNewer !== undefined) {
      return err(
        failure(
          'undo-artifact-suffix',
          `selected ${artifact.role} history omits a newer update on '${artifact.artifactPath}'`,
          'state',
        ),
      );
    }
  }
  const groupHistoryRank = new Map<string, number>();
  for (const artifact of artifacts) {
    groupHistoryRank.set(
      artifact.sourceGroupId,
      Math.max(
        groupHistoryRank.get(artifact.sourceGroupId) ?? -1,
        historyIndex.get(artifact.sourceTransactionId) ?? -1,
      ),
    );
  }
  const orderedArtifacts = [...artifacts].sort((left, right) => {
    const groupOrder =
      (groupHistoryRank.get(right.sourceGroupId) ?? -1) -
      (groupHistoryRank.get(left.sourceGroupId) ?? -1);
    if (groupOrder !== 0) return groupOrder;
    return left.role === right.role ? 0 : left.role === 'manifest' ? -1 : 1;
  });
  const priorByArtifact = new Map<string, UndoArtifactCandidate>();
  for (const artifact of orderedArtifacts) {
    const key = JSON.stringify([artifact.role, artifact.artifactPath]);
    const newer = priorByArtifact.get(key);
    if (
      newer !== undefined &&
      canonicalPlanningString(newer.journal.intent.before) !==
        canonicalPlanningString(artifact.journal.intent.after)
    ) {
      return err(
        failure(
          'undo-artifact-suffix',
          `selected ${artifact.role} history is not one contiguous update suffix`,
          'state',
        ),
      );
    }
    priorByArtifact.set(key, artifact);
  }
  const physicalHeads = new Set<string>();
  const artifactsWithHeads = orderedArtifacts.map((artifact) => {
    const key = JSON.stringify([artifact.role, artifact.artifactPath]);
    const physicalHead = !physicalHeads.has(key);
    physicalHeads.add(key);
    return deepFreeze({ ...artifact, physicalHead });
  });
  const ineligible = ordered.find(
    ({ outcome, eligibility }) => outcome !== 'already-reversed' && eligibility !== 'eligible',
  );
  if (ineligible !== undefined) {
    return err(
      failure(
        'undo-not-reversible',
        `the newest retained operation for '${ineligible.name}' is ${ineligible.eligibility}; older history will not be selected`,
        'state',
      ),
    );
  }
  const multiResource = ordered.find(({ before }) => before === 'multi-resource');
  if (multiResource !== undefined) {
    return err(
      failure(
        'undo-multi-resource',
        `the newest operation for '${multiResource.name}' is not a placement-scoped undo candidate`,
        'state',
      ),
    );
  }
  return ok(
    deepFreeze({
      request: immutableRequest(request, tools, scopes),
      selection: {
        source: resolved.value.selectionSource,
        outcome: resolved.value.outcome,
        reason: resolved.value.reason ?? null,
        targets: [...selection.targets],
        tools: [...tools],
        scopes: [...scopes],
      },
      projectContext: runtime.projectContext,
      ledgerPath,
      ledgerState: immutableLedgerState,
      ledger,
      migrationPending: ledgerState.state === 'present' && ledgerState.sourceVersion === 1,
      candidates: ordered,
      artifacts: artifactsWithHeads,
    }),
  );
};

export const undoCandidateRoot = (candidate: UndoCandidate): string => dirname(candidate.path);
