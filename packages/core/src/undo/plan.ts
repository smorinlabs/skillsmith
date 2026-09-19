import { toolRegistry } from '../agents/registry.ts';
import { createOperationPairId, createPlanningDiagnosticId } from '../planning/create.ts';
import type { OperationExecutionResult, OperationPlan } from '../planning/types.ts';
import type {
  UndoCandidate,
  UndoObservation,
  UndoPlanGroup,
  UndoPlanOutcome,
  UndoPlanPair,
  UndoReport,
  UndoSelectionReport,
  UndoTool,
} from './types.ts';

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const toolOrder = (tool: UndoTool): number => {
  const index = toolRegistry.ids.indexOf(tool);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
};

const orderedCandidates = (candidates: readonly UndoCandidate[]): readonly UndoCandidate[] =>
  [...candidates].sort(
    (left, right) =>
      (left.scope === right.scope ? 0 : left.scope === 'user' ? -1 : 1) ||
      left.name.localeCompare(right.name) ||
      left.sourceGroupId.localeCompare(right.sourceGroupId) ||
      toolOrder(left.tool) - toolOrder(right.tool) ||
      left.path.localeCompare(right.path),
  );

const pairOperations = (
  plan: OperationPlan<'undo'>,
  candidate: UndoCandidate,
): OperationPlan<'undo'>['operations'] => {
  const authoritativePairId =
    candidate.disposition === 'rollback' && candidate.authority.format === 'logical'
      ? candidate.authority.journal.intent.pairId
      : null;
  return Object.freeze(
    plan.operations.filter(
      (operation) =>
        operation.kind !== 'migrate-ledger' &&
        operation.skill === candidate.name &&
        operation.tool === candidate.tool &&
        operation.scope === candidate.scope &&
        (authoritativePairId === null || operation.pairId === authoritativePairId),
    ),
  );
};

const candidatePairId = (
  candidate: UndoCandidate,
  operations: OperationPlan<'undo'>['operations'],
): string => {
  const planned = operations.find(({ pairId }) => pairId !== null)?.pairId;
  if (planned !== null && planned !== undefined) return planned;
  if (
    candidate.authority.format === 'logical' &&
    candidate.authority.source.intent.pairId !== null
  ) {
    return candidate.authority.source.intent.pairId;
  }
  return createOperationPairId({
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId: candidate.sourceGroupId,
    tool: candidate.tool,
    resource: {
      kind: 'live',
      skill: candidate.name,
      tool: candidate.tool,
      scope: candidate.scope,
      projectRoot:
        candidate.projectIdentity === null
          ? null
          : { kind: 'machine-bound', path: candidate.projectIdentity },
      location: { kind: 'machine-bound', path: candidate.path },
    },
  });
};

const planPair = (candidate: UndoCandidate, plan: OperationPlan<'undo'>): UndoPlanPair => {
  const operations = pairOperations(plan, candidate);
  const operation = operations[0];
  const activeOperationId =
    candidate.action === 'abort-pending' && candidate.authority.format === 'logical'
      ? candidate.activeOperationId
      : (operation?.operationId ?? candidate.activeOperationId);
  const retentionResourceIds = candidate.retention.map(
    (requirement, index) =>
      requirement.resourceId ?? `legacy-retention:${candidate.sourceTransactionId}:${index}`,
  );
  return {
    pairId: candidatePairId(candidate, operations),
    tool: candidate.tool,
    path: candidate.path,
    action: candidate.action,
    operationFamily: candidate.operationFamily,
    disposition: 'rollback',
    phase: candidate.phase,
    executionMode: candidate.executionMode,
    beforeState: candidate.before as 'dev' | 'pinned' | 'absent',
    eligibility: candidate.outcome === 'already-reversed' ? 'already-reversed' : 'eligible',
    retention: {
      required: retentionResourceIds.length > 0,
      resourceIds: retentionResourceIds,
    },
    sourceTransactionId: candidate.sourceTransactionId,
    activeTransactionId:
      candidate.outcome === 'already-reversed' || candidate.action === 'abort-pending'
        ? candidate.activeTransactionId
        : `transaction:${activeOperationId ?? candidate.activeTransactionId}`,
    sourceOperationId:
      candidate.sourceOperationId ?? `legacy-operation:${candidate.sourceTransactionId}`,
    activeOperationId: activeOperationId ?? `legacy-operation:${candidate.activeTransactionId}`,
    parentOperationId:
      candidate.parentOperationId ??
      (candidate.action === 'reverse-committed'
        ? (candidate.sourceOperationId ?? `legacy-operation:${candidate.sourceTransactionId}`)
        : null),
    operationIds: operations.map(({ operationId }) => operationId),
    operations,
    outcome: candidate.outcome === 'already-reversed' ? 'already-reversed' : 'planned',
    failure: null,
  };
};

export const createUndoPlanGroups = (
  observation: UndoObservation,
  plan: OperationPlan<'undo'>,
): readonly UndoPlanGroup[] => {
  const grouped = new Map<string, UndoPlanPair[]>();
  const facts = new Map<
    string,
    Readonly<{ groupId: string; name: string; scope: UndoCandidate['scope'] }>
  >();
  for (const candidate of orderedCandidates(observation.candidates)) {
    const key = JSON.stringify([candidate.sourceGroupId, candidate.name, candidate.scope]);
    const pairs = grouped.get(key) ?? [];
    pairs.push(planPair(candidate, plan));
    grouped.set(key, pairs);
    facts.set(key, {
      groupId: candidate.sourceGroupId,
      name: candidate.name,
      scope: candidate.scope,
    });
  }
  const operationGroupOrder = new Map<string, number>();
  for (const operation of plan.operations) {
    if (!operationGroupOrder.has(operation.groupId)) {
      operationGroupOrder.set(operation.groupId, operationGroupOrder.size);
    }
  }
  return deepFreeze(
    [...grouped.entries()]
      .map(([key, unorderedPairs]) => {
        const group = facts.get(key);
        if (group === undefined) throw new TypeError('undo group facts are missing');
        const pairs = [...unorderedPairs].sort(
          (left, right) =>
            toolOrder(left.tool) - toolOrder(right.tool) || left.path.localeCompare(right.path),
        );
        const pairGroupIds = new Set(
          pairs.flatMap((pair) => pair.operations.map(({ groupId }) => groupId)),
        );
        const operations = plan.operations.filter(
          (operation) => operation.kind !== 'migrate-ledger' && pairGroupIds.has(operation.groupId),
        );
        const operationGroupIds = [...new Set(operations.map(({ groupId }) => groupId))];
        if (operationGroupIds.length > 1) {
          throw new TypeError('undo canonical group operations have inconsistent identities');
        }
        return {
          groupId: operationGroupIds[0] ?? group.groupId,
          name: group.name,
          scope: group.scope,
          pairs,
          operationIds: operations.map(({ operationId }) => operationId),
          operations,
          outcome: pairs.every(({ outcome }) => outcome === 'already-reversed')
            ? ('already-reversed' as const)
            : ('planned' as const),
          failure: null,
        };
      })
      .sort(
        (left, right) =>
          (operationGroupOrder.get(left.groupId) ?? Number.MAX_SAFE_INTEGER) -
          (operationGroupOrder.get(right.groupId) ?? Number.MAX_SAFE_INTEGER),
      ),
  );
};

/** Project private cleanup markers into the one exact public planning diagnostic authority. */
export const withUndoCleanupDiagnostics = (
  observation: UndoObservation,
  plan: OperationPlan<'undo'>,
  groups: readonly UndoPlanGroup[],
): OperationPlan<'undo'> => {
  const diagnostics = groups.flatMap((group) =>
    group.pairs.flatMap((pair) => {
      const candidate = observation.candidates.find(
        (item) =>
          item.recoveryState === 'cleanup-pending' &&
          item.name === group.name &&
          item.scope === group.scope &&
          item.tool === pair.tool &&
          item.path === pair.path &&
          item.activeTransactionId === pair.activeTransactionId,
      );
      if (candidate === undefined) return [];
      const affected = {
        skill: group.name,
        source: null,
        tool: pair.tool,
        scope: group.scope,
        path: { kind: 'machine-bound' as const, path: pair.path },
      };
      const correlation = {
        groupId: group.groupId,
        pairId: pair.pairId,
        operationId: null,
      };
      const identity = {
        domain: 'skillsmith.planning-diagnostic-identity' as const,
        schemaVersion: 1 as const,
        kind: 'warning' as const,
        severity: 'warning' as const,
        refusalClass: null,
        affected,
        correlation,
        reasonCode: 'undo-cleanup-pending',
        selectionSource: observation.selection.source,
      };
      return [
        {
          diagnosticId: createPlanningDiagnosticId(identity),
          kind: identity.kind,
          severity: identity.severity,
          refusalClass: null,
          affected,
          correlation,
          reason: {
            code: identity.reasonCode,
            message: `Committed undo cleanup remains pending for '${group.name}' on ${pair.tool}.`,
          },
          selectionSource: identity.selectionSource,
        },
      ];
    }),
  );
  return deepFreeze({
    ...plan,
    selection: { ...plan.selection, groupIds: groups.map(({ groupId }) => groupId) },
    diagnostics: [...plan.diagnostics, ...diagnostics],
  });
};

const reducePair = (
  pair: UndoPlanPair,
  results: ReadonlyMap<string, OperationExecutionResult>,
): UndoPlanPair => {
  if (pair.outcome === 'already-reversed') return pair;
  const own = pair.operationIds.map((operationId) => results.get(operationId));
  const failure = own.find(
    (result): result is OperationExecutionResult => result?.outcome === 'failed',
  );
  if (failure !== undefined) {
    return {
      ...pair,
      outcome: 'failed',
      failure: {
        code: failure.error?.code ?? 'undo-execution-failed',
        message: failure.error?.message ?? 'undo execution failed',
      },
    };
  }
  if (own.some((result) => result?.outcome === 'cancelled')) {
    return { ...pair, outcome: 'cancelled', failure: null };
  }
  if (
    own.length === 0 ||
    own.some((result) => result === undefined || result.outcome === 'skipped-after-failure')
  ) {
    return { ...pair, outcome: 'not-run', failure: null };
  }
  return { ...pair, outcome: 'succeeded', failure: null };
};

const outcomePrecedence: Readonly<Record<UndoPlanOutcome, number>> = Object.freeze({
  failed: 6,
  cancelled: 5,
  'not-run': 4,
  succeeded: 3,
  planned: 2,
  'already-reversed': 1,
});

const aggregateOutcome = (pairs: readonly UndoPlanPair[]): UndoPlanOutcome =>
  pairs.reduce<UndoPlanOutcome>(
    (selected, pair) =>
      outcomePrecedence[pair.outcome] > outcomePrecedence[selected] ? pair.outcome : selected,
    'already-reversed',
  );

const reduceGroup = (
  group: UndoPlanGroup,
  pairs: readonly UndoPlanPair[],
  results: ReadonlyMap<string, OperationExecutionResult>,
): Pick<UndoPlanGroup, 'outcome' | 'failure'> => {
  const own = group.operationIds.map((operationId) => results.get(operationId));
  const failed = own.find(
    (result): result is OperationExecutionResult => result?.outcome === 'failed',
  );
  if (failed !== undefined) {
    return {
      outcome: 'failed',
      failure: {
        code: failed.error?.code ?? 'undo-execution-failed',
        message: failed.error?.message ?? 'undo execution failed',
      },
    };
  }
  if (own.some((result) => result?.outcome === 'cancelled')) {
    return { outcome: 'cancelled', failure: null };
  }
  if (
    own.length > 0 &&
    own.some((result) => result === undefined || result.outcome === 'skipped-after-failure')
  ) {
    return { outcome: 'not-run', failure: null };
  }
  return { outcome: aggregateOutcome(pairs), failure: null };
};

/** Exact deterministic pair/group reduction shared by direct undo and rollback aliases. */
export const reduceUndoPlanGroups = (
  groups: readonly UndoPlanGroup[],
  executionResults: readonly OperationExecutionResult[],
): readonly UndoPlanGroup[] => {
  const results = new Map(executionResults.map((result) => [result.operationId, result]));
  return deepFreeze(
    groups.map((group) => {
      const pairs = group.pairs.map((pair) => reducePair(pair, results));
      return { ...group, pairs, ...reduceGroup(group, pairs, results) };
    }),
  );
};

export const undoSelectionReport = (
  observation: UndoObservation,
  groups: readonly UndoPlanGroup[],
): UndoSelectionReport =>
  deepFreeze({
    source:
      observation.selection.source === 'explicit-all'
        ? ('explicit-all' as const)
        : ('explicit-targets' as const),
    outcome:
      observation.selection.outcome === 'filter-noop'
        ? ('filter-zero' as const)
        : ('selected' as const),
    targets: [...observation.selection.targets],
    all: observation.request.all,
    tools: [...observation.selection.tools],
    scopes: [...observation.selection.scopes],
    groupIds: groups.map(({ groupId }) => groupId),
    batchPolicy: observation.request.continueOnError
      ? ('continue-on-error' as const)
      : ('fail-fast' as const),
  });

export const createUndoReport = (
  observation: UndoObservation,
  plan: OperationPlan<'undo'>,
  groups: readonly UndoPlanGroup[],
  mode: UndoReport['mode'],
  approval: UndoReport['approval'],
  results: readonly OperationExecutionResult[],
): UndoReport => {
  const groupResults =
    mode === 'dry-run' ||
    approval.outcome === 'pending' ||
    approval.outcome === 'refused' ||
    approval.outcome === 'cancelled'
      ? groups
      : reduceUndoPlanGroups(groups, results);
  const effects = plan.operations.flatMap((operation) => {
    const result = results.find(({ operationId }) => operationId === operation.operationId);
    const outcome =
      mode === 'dry-run'
        ? ('planned' as const)
        : result?.outcome === 'failed'
          ? ('failed' as const)
          : result?.outcome === 'cancelled'
            ? ('cancelled' as const)
            : result?.outcome === 'skipped-after-failure' || result === undefined
              ? ('not-run' as const)
              : ('succeeded' as const);
    const roles = [
      ...(operation.mutates.ledger ? (['ledger'] as const) : []),
      ...(operation.mutates.live ? (['live'] as const) : []),
    ];
    return roles.map((role) => ({
      role,
      action: operation.kind,
      operationId: operation.operationId,
      groupId: operation.groupId,
      outcome,
    }));
  });
  const count = (outcome: UndoPlanOutcome): number =>
    groupResults.filter((group) => group.outcome === outcome).length;
  const actionable = groupResults.filter((group) =>
    group.pairs.some(({ eligibility }) => eligibility === 'eligible'),
  ).length;
  const failed = count('failed');
  const cancelled = count('cancelled');
  const notRun = count('not-run');
  const lifecycleState: UndoReport['state'] =
    mode === 'dry-run' || approval.outcome === 'pending'
      ? 'ready'
      : approval.outcome === 'refused' || approval.outcome === 'cancelled'
        ? 'refused'
        : failed > 0 || cancelled > 0 || notRun > 0
          ? 'partial'
          : 'completed';
  return deepFreeze({
    kind: 'skillsmith.undo',
    schemaVersion: 1,
    command: 'undo',
    mode,
    state: lifecycleState,
    project: {
      effectiveCwd: observation.projectContext.effectiveCwd,
      root: observation.projectContext.projectRoot,
      identity: observation.projectContext.projectIdentity,
    },
    approval,
    selection: undoSelectionReport(observation, groups),
    groups: groupResults,
    operations: [...plan.operations],
    checks: [...plan.checks],
    results: [...results],
    effects,
    diagnostics: [...plan.diagnostics],
    summary: {
      selected: groups.length,
      actionable,
      alreadyReversed: count('already-reversed'),
      planned: count('planned'),
      succeeded: count('succeeded'),
      failed,
      cancelled,
      skipped: 0,
      notRun,
      effects: effects.length,
      refusals: plan.diagnostics.filter(({ kind }) => kind === 'refuse').length,
    },
  });
};

/** Rebind compatibility rollback planning to the public undo command without changing identities. */
export const asUndoPlan = (
  plan: OperationPlan<'dev' | 'promote' | 'undo'>,
): OperationPlan<'undo'> => deepFreeze({ ...plan, command: 'undo' as const });
