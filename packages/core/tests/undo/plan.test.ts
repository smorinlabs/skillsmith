import { describe, expect, test } from 'bun:test';
import type { OperationExecutionResult, OperationPlan } from '../../src/planning/types.ts';
import {
  createUndoPlanGroups,
  createUndoReport,
  reduceUndoPlanGroups,
  withUndoCleanupDiagnostics,
} from '../../src/undo/plan.ts';
import type {
  UndoCandidate,
  UndoObservation,
  UndoPlanOutcome,
  UndoTool,
} from '../../src/undo/types.ts';

const pairId = (name: string, tool: UndoTool): string => `pair:${name}:${tool}`;
const operationId = (name: string, tool: UndoTool): string => `operation:undo:${name}:${tool}`;
const toolDirectory = (tool: UndoTool): string => (tool === 'claude-code' ? '.claude' : '.codex');

const candidate = (
  name: string,
  tool: UndoTool = 'codex',
  outcome: UndoCandidate['outcome'] = 'selected',
  sourceGroupId = `group:${name}`,
  recoveryState: UndoCandidate['recoveryState'] = 'none',
): UndoCandidate =>
  ({
    name,
    sourceGroupId,
    tool,
    scope: 'user',
    projectIdentity: null,
    path: `/fixture/${toolDirectory(tool)}/skills/${name}`,
    placement: {
      skill: name,
      root: `/fixture/${toolDirectory(tool)}/skills`,
      path: `/fixture/${toolDirectory(tool)}/skills/${name}`,
      class: 'pinned',
      symlinkTarget: null,
      dangling: false,
    },
    capabilities: ['undo'],
    exists: true,
    action: 'reverse-committed',
    outcome,
    operationFamily: 'promote',
    disposition: 'forward',
    phase: 'committed',
    executionMode: 'resume-rollback',
    recoveryState,
    before: 'dev',
    eligibility: 'eligible',
    retention: [{ resourceId: `store:${name}:${tool}`, role: 'store', state: 'satisfied' }],
    sourceTransactionId: `transaction:source:${name}:${tool}`,
    activeTransactionId: `transaction:source:${name}:${tool}`,
    sourceOperationId: `operation:source:${name}:${tool}`,
    activeOperationId: `operation:source:${name}:${tool}`,
    parentOperationId: `operation:source:${name}:${tool}`,
    authority: {
      format: 'logical',
      journal: {
        intent: { groupId: sourceGroupId, pairId: pairId(name, tool) },
      },
      source: {
        intent: { groupId: sourceGroupId, pairId: pairId(name, tool) },
      },
    },
  }) as unknown as UndoCandidate;

const operation = (
  name: string,
  tool: UndoTool = 'codex',
  groupId = `group:${name}`,
): OperationPlan<'undo'>['operations'][number] =>
  ({
    operationId: operationId(name, tool),
    groupId,
    pairId: pairId(name, tool),
    kind: 'link-dev',
    skill: name,
    tool,
    scope: 'user',
    mutates: { ledger: true, live: true, manifest: false, lock: false },
  }) as OperationPlan<'undo'>['operations'][number];

const observation = (candidates: readonly UndoCandidate[]): UndoObservation => {
  const names = [...new Set(candidates.map(({ name }) => name))];
  const tools = [...new Set(candidates.map(({ tool }) => tool))];
  return {
    request: {
      targets: names,
      all: false,
      tools,
      scopes: ['user'],
      dryRun: true,
      yes: false,
      continueOnError: false,
    },
    selection: {
      source: 'explicit-targets',
      outcome: 'selected',
      reason: null,
      targets: names,
      tools,
      scopes: ['user'],
    },
    projectContext: {
      invocationCwd: '/fixture',
      effectiveCwd: '/fixture',
      projectRoot: null,
      projectIdentity: null,
      projectKind: 'non-git',
      discoveredConfigPath: null,
      explicitConfigPath: null,
    },
    candidates,
  } as unknown as UndoObservation;
};

const plan = (operations: OperationPlan<'undo'>['operations']): OperationPlan<'undo'> => ({
  domain: 'skillsmith.operation-plan',
  schemaVersion: 1,
  command: 'undo',
  selection: {
    source: 'explicit-targets',
    outcome: 'selected',
    targets: [...new Set(operations.flatMap(({ skill }) => (skill === null ? [] : [skill])))],
    all: false,
    tools: [...new Set(operations.flatMap(({ tool }) => (tool === null ? [] : [tool])))],
    scopes: ['user'],
    groupIds: [...new Set(operations.map(({ groupId }) => groupId))],
  },
  batchPolicy: 'fail-fast',
  operations,
  checks: [],
  diagnostics: [],
});

const result = (
  name: string,
  tool: UndoTool,
  outcome: OperationExecutionResult['outcome'],
  message = 'boom',
): OperationExecutionResult =>
  ({
    operationId: operationId(name, tool),
    outcome,
    error:
      outcome === 'failed' ? { code: `undo-failed-${tool}`, message, remediation: 'retry' } : null,
  }) as OperationExecutionResult;

describe('undo planning projection', () => {
  test('forms canonical source groups and registry-ordered pairs deterministically', () => {
    const claude = candidate('review', 'claude-code');
    const codex = candidate('review', 'codex');
    const operations = [operation('review', 'claude-code'), operation('review', 'codex')];
    const forward = createUndoPlanGroups(observation([codex, claude]), plan(operations));
    const permuted = createUndoPlanGroups(observation([claude, codex]), plan(operations));

    expect(forward).toEqual(permuted);
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({
      groupId: 'group:review',
      name: 'review',
      scope: 'user',
      operationIds: operations.map(({ operationId }) => operationId),
      outcome: 'planned',
    });
    expect(forward[0]?.pairs.map(({ tool, pairId: id }) => [tool, id])).toEqual([
      ['claude-code', 'pair:review:claude-code'],
      ['codex', 'pair:review:codex'],
    ]);
    expect(Object.isFrozen(forward)).toBeTrue();
  });

  test('keeps an operation-free already pair inside an actionable canonical group', () => {
    const already = candidate('review', 'claude-code', 'already-reversed');
    const actionable = candidate('review', 'codex');
    const selectedPlan = plan([operation('review', 'codex')]);
    const selectedObservation = observation([already, actionable]);
    const groups = createUndoPlanGroups(selectedObservation, selectedPlan);

    expect(groups[0]).toMatchObject({
      operationIds: ['operation:undo:review:codex'],
      outcome: 'planned',
      pairs: [
        { tool: 'claude-code', operationIds: [], outcome: 'already-reversed' },
        { tool: 'codex', operationIds: ['operation:undo:review:codex'], outcome: 'planned' },
      ],
    });
    const report = createUndoReport(
      selectedObservation,
      selectedPlan,
      groups,
      'dry-run',
      { required: false, outcome: 'not-required' },
      [],
    );
    expect(report.summary).toMatchObject({ selected: 1, actionable: 1, alreadyReversed: 0 });
  });

  test('projects one exact cleanup diagnostic only for a cleanup-pending already pair', () => {
    const cleanupGroupId = `group:v1:${'1'.repeat(64)}`;
    const cleanupPairId = `pair:v1:${'2'.repeat(64)}`;
    const cleanup = candidate(
      'review',
      'codex',
      'already-reversed',
      cleanupGroupId,
      'cleanup-pending',
    );
    if (cleanup.authority.format !== 'logical') {
      throw new Error('cleanup fixture requires logical authority');
    }
    const correlatedCleanup = {
      ...cleanup,
      authority: {
        ...cleanup.authority,
        journal: {
          ...cleanup.authority.journal,
          intent: { ...cleanup.authority.journal.intent, pairId: cleanupPairId },
        },
        source: {
          ...cleanup.authority.source,
          intent: { ...cleanup.authority.source.intent, pairId: cleanupPairId },
        },
      },
    } as UndoCandidate;
    const cleanupObservation = observation([correlatedCleanup]);
    const cleanupPlan = plan([]);
    const groups = createUndoPlanGroups(cleanupObservation, cleanupPlan);
    const projected = withUndoCleanupDiagnostics(cleanupObservation, cleanupPlan, groups);

    expect(projected.operations).toEqual([]);
    expect(projected.selection.groupIds).toEqual([cleanupGroupId]);
    expect(projected.diagnostics).toHaveLength(1);
    expect(projected.diagnostics[0]).toMatchObject({
      kind: 'warning',
      severity: 'warning',
      refusalClass: null,
      affected: {
        skill: 'review',
        source: null,
        tool: 'codex',
        scope: 'user',
        path: { kind: 'machine-bound', path: '/fixture/.codex/skills/review' },
      },
      correlation: {
        groupId: cleanupGroupId,
        pairId: cleanupPairId,
        operationId: null,
      },
      reason: {
        code: 'undo-cleanup-pending',
        message: "Committed undo cleanup remains pending for 'review' on codex.",
      },
      selectionSource: 'explicit-targets',
    });
    expect(Object.isFrozen(projected)).toBeTrue();

    const terminal = candidate('review', 'codex', 'already-reversed');
    const terminalObservation = observation([terminal]);
    const terminalGroups = createUndoPlanGroups(terminalObservation, cleanupPlan);
    expect(
      withUndoCleanupDiagnostics(terminalObservation, cleanupPlan, terminalGroups).diagnostics,
    ).toEqual([]);
  });

  test.each([
    ['succeeded', [result('review', 'claude-code', 'succeeded')], 'succeeded'],
    ['cancelled', [result('review', 'claude-code', 'cancelled')], 'cancelled'],
    ['skipped', [result('review', 'claude-code', 'skipped-after-failure')], 'not-run'],
    ['missing', [], 'not-run'],
  ] as const)(
    '%s operation results produce the expected pair outcome',
    (_case, results, expected) => {
      const selected = candidate('review', 'claude-code');
      const groups = createUndoPlanGroups(
        observation([selected]),
        plan([operation('review', 'claude-code')]),
      );
      const reduced = reduceUndoPlanGroups(groups, results);
      expect(reduced[0]).toMatchObject({ outcome: expected, pairs: [{ outcome: expected }] });
    },
  );

  test('uses first failed operation and exact group precedence across ordered pairs', () => {
    const claude = candidate('review', 'claude-code');
    const codex = candidate('review', 'codex');
    const firstClaudeOperation = operation('review', 'claude-code');
    const secondClaudeOperation = {
      ...firstClaudeOperation,
      operationId: 'operation:undo:review:claude-code:second',
    };
    const selectedPlan = plan([
      firstClaudeOperation,
      secondClaudeOperation,
      operation('review', 'codex'),
    ]);
    const groups = createUndoPlanGroups(observation([claude, codex]), selectedPlan);
    const reduced = reduceUndoPlanGroups(groups, [
      result('review', 'claude-code', 'failed', 'first failure'),
      {
        ...result('review', 'claude-code', 'failed', 'second failure'),
        operationId: secondClaudeOperation.operationId,
        error: { code: 'undo-failed-second', message: 'second failure', remediation: 'retry' },
      } as OperationExecutionResult,
      result('review', 'codex', 'cancelled'),
    ]);

    expect(reduced[0]).toMatchObject({
      outcome: 'failed',
      failure: { code: 'undo-failed-claude-code', message: 'first failure' },
      pairs: [
        {
          outcome: 'failed',
          failure: { code: 'undo-failed-claude-code', message: 'first failure' },
        },
        { outcome: 'cancelled', failure: null },
      ],
    });
  });

  test('derives canonical group and effect summaries from exact execution identities', () => {
    const selected = candidate('review', 'codex');
    const selectedPlan = plan([operation('review', 'codex')]);
    const selectedObservation = observation([selected]);
    const groups = createUndoPlanGroups(selectedObservation, selectedPlan);
    const results = [result('review', 'codex', 'failed')];
    const report = createUndoReport(
      selectedObservation,
      selectedPlan,
      groups,
      'execute',
      { required: true, outcome: 'approved' },
      results,
    );

    expect(report).toMatchObject({
      state: 'partial',
      groups: [
        {
          outcome: 'failed',
          failure: { code: 'undo-failed-codex', message: 'boom' },
          pairs: [{ outcome: 'failed' }],
        },
      ],
      summary: { selected: 1, actionable: 1, failed: 1, skipped: 0, effects: 2 },
    });
    expect(report.effects.map(({ role, outcome }) => [role, outcome])).toEqual([
      ['ledger', 'failed'],
      ['live', 'failed'],
    ]);
  });

  test('keeps pending abort linkage on its nested pair', () => {
    const pending = {
      ...candidate('pending'),
      action: 'abort-pending' as const,
      phase: 'staged' as const,
      disposition: 'rollback' as const,
      sourceTransactionId: 'transaction:pending',
      activeTransactionId: 'transaction:pending',
      sourceOperationId: 'operation:forward',
      activeOperationId: 'operation:forward',
      parentOperationId: 'operation:forward',
    } as UndoCandidate;
    const inverse = { ...operation('pending'), groupId: 'group:active:pending' };
    const hostileSibling = {
      ...inverse,
      operationId: 'operation:hostile:pending',
      pairId: 'pair:hostile:pending',
    };
    const groups = createUndoPlanGroups(observation([pending]), plan([inverse, hostileSibling]));

    expect(groups[0]?.groupId).toBe('group:active:pending');
    expect(groups[0]?.pairs[0]).toMatchObject({
      sourceTransactionId: 'transaction:pending',
      activeTransactionId: 'transaction:pending',
      sourceOperationId: 'operation:forward',
      activeOperationId: 'operation:forward',
      parentOperationId: 'operation:forward',
      operationIds: ['operation:undo:pending:codex'],
    });
  });

  test('documents every aggregate outcome in the closed public vocabulary', () => {
    const outcomes: readonly UndoPlanOutcome[] = [
      'planned',
      'succeeded',
      'failed',
      'cancelled',
      'not-run',
      'already-reversed',
    ];
    expect(outcomes).not.toContain('skipped');
  });
});
