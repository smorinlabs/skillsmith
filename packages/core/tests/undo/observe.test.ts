import { afterEach, describe, expect, test } from 'bun:test';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import { emptyLedgerModel, writeLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import type { StatusPlacement } from '../../src/status/types.ts';
import {
  candidateForStatusPlacement,
  observeUndo,
  resolveUndoTargetSelection,
} from '../../src/undo/observe.ts';
import type {
  UndoCandidate,
  UndoRequest,
  UndoScope,
  UndoTool,
  ValidatedUndoSelection,
} from '../../src/undo/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const open: FixtureFleet[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map(destroyFixtureFleet));
});

const request: UndoRequest = {
  targets: [],
  all: true,
  tools: ['codex'],
  scopes: ['user'],
  dryRun: true,
  yes: false,
  continueOnError: false,
};

const selection: ValidatedUndoSelection = {
  targets: [],
  all: true,
  tools: ['codex'],
  scopes: ['user'],
  capability: 'undo',
  allowAbsentCreate: false,
  selectionSource: 'explicit-all',
};

const selectableCandidate = (
  name: string,
  tool: UndoTool,
  scope: UndoScope = 'project',
  sourceGroupId = `group:${scope}:${name}`,
  suffix = '',
): UndoCandidate =>
  ({
    name,
    sourceGroupId,
    tool,
    scope,
    projectIdentity: scope === 'project' ? '/fixture/project' : null,
    path: `/fixture/${scope}/${tool}/${name}${suffix}`,
    capabilities: ['undo'],
    exists: true,
  }) as unknown as UndoCandidate;

const targetSelection = (
  targets: readonly string[],
  tools: readonly UndoTool[] = ['claude-code', 'codex'],
  scopes: readonly UndoScope[] = ['project'],
): ValidatedUndoSelection => ({
  targets,
  all: false,
  tools,
  scopes,
  capability: 'undo',
  allowAbsentCreate: false,
  selectionSource: 'explicit-targets',
});

const logicalJournal = (
  transactionId: string,
  operationId: string,
  disposition: 'forward' | 'rollback',
  parentOperationId: string | null,
  phase: LogicalJournalV1Dto['phase'],
): LogicalJournalV1Dto => {
  const resource = {
    kind: 'live' as const,
    skill: 'review',
    tool: 'codex' as const,
    scope: 'user' as const,
    projectRoot: null,
    location: { kind: 'machine-bound' as const, path: '/fixture/skills/review' },
  };
  return {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId,
    intent: {
      operationId,
      groupId: `group:${operationId}`,
      pairId: 'pair:review:codex',
      kind: 'link-dev',
      skill: 'review',
      source: null,
      tool: 'codex',
      scope: 'user',
      before: { kind: 'absent', resource },
      after: { kind: 'absent', resource },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      reversibility: { kind: 'none', retentionResourceIds: [] },
      conflict: null,
    },
    context: {
      parentOperationId,
      command: 'skillsmith-undo',
      workflow: 'undo',
      attempt: 1,
      startedAt: '2026-07-22T00:00:00.000Z',
    },
    disposition,
    phase,
    actual: { before: [], after: [], retained: [] },
    updatedAt: '2026-07-22T00:00:01.000Z',
    completedAt: phase === 'committed' ? '2026-07-22T00:00:02.000Z' : null,
  };
};

const pendingPlacement = (transactionId: string): StatusPlacement => ({
  identity: {
    tool: 'codex',
    scope: 'user',
    projectIdentity: null,
    path: '/fixture/skills/review',
  },
  ledger: { state: 'absent' },
  live: { state: 'absent' },
  classification: 'absent',
  brokenReason: null,
  verification: 'unrecorded',
  shadow: { state: 'none' },
  journal: {
    state: 'pending',
    format: 'logical',
    operation: 'link-dev',
    transactionId,
    phase: 'prepared',
    before: 'absent',
    retention: [],
    abortEligibility: 'eligible',
    remediation: { resume: 'rerun the same operation', abort: ['skillsmith', 'undo', 'review'] },
  },
  facts: [],
});

describe('undo observation', () => {
  test('recovers only same-source exact-literal multi-tool ambiguity', () => {
    const claude = selectableCandidate('review', 'claude-code');
    const codex = selectableCandidate('review', 'codex');
    const recovered = resolveUndoTargetSelection(
      [codex, claude],
      targetSelection(['review']),
      ['claude-code', 'codex'],
      ['project'],
    );
    expect(recovered).toMatchObject({ ok: true });
    if (!recovered.ok) return;
    expect(recovered.value.selected.map(({ tool }) => tool)).toEqual(['claude-code', 'codex']);

    const hostile = [
      {
        label: 'glob',
        candidates: [claude, codex],
        selection: targetSelection(['rev*']),
      },
      {
        label: 'cross-scope',
        candidates: [claude, selectableCandidate('review', 'codex', 'user')],
        selection: targetSelection(['review'], ['claude-code', 'codex'], ['user', 'project']),
      },
      {
        label: 'different-source',
        candidates: [claude, selectableCandidate('review', 'codex', 'project', 'group:other')],
        selection: targetSelection(['review']),
      },
      {
        label: 'duplicate-tool',
        candidates: [
          claude,
          selectableCandidate('review', 'claude-code', 'project', undefined, '-2'),
        ],
        selection: targetSelection(['review']),
      },
    ];
    for (const item of hostile) {
      const result = resolveUndoTargetSelection(
        item.candidates,
        item.selection,
        item.selection.tools,
        item.selection.scopes as readonly UndoScope[],
      );
      expect(result, item.label).toMatchObject({ ok: false, error: { code: 'ambiguous' } });
    }
  });

  test('preserves exact path/tool narrowing and safely deduplicates multiple targets', () => {
    const claude = selectableCandidate('review', 'claude-code');
    const codex = selectableCandidate('review', 'codex');
    const audit = selectableCandidate('audit', 'codex');
    const byPath = resolveUndoTargetSelection(
      [claude, codex],
      targetSelection([codex.path]),
      ['claude-code', 'codex'],
      ['project'],
    );
    expect(byPath).toMatchObject({ ok: true, value: { selected: [{ tool: 'codex' }] } });

    const byTool = resolveUndoTargetSelection(
      [claude, codex],
      targetSelection(['review'], ['claude-code']),
      ['claude-code'],
      ['project'],
    );
    expect(byTool).toMatchObject({ ok: true, value: { selected: [{ tool: 'claude-code' }] } });

    const multiple = resolveUndoTargetSelection(
      [codex, audit, claude],
      targetSelection(['review', codex.path, 'audit']),
      ['claude-code', 'codex'],
      ['project'],
    );
    expect(multiple).toMatchObject({ ok: true });
    if (!multiple.ok) return;
    expect(multiple.value.selected.map(({ name, tool }) => `${name}:${tool}`)).toEqual([
      'review:claude-code',
      'review:codex',
      'audit:codex',
    ]);
  });

  test('classifies self-parent converted and distinct-parent fresh rollback journals as resume', () => {
    const convertedOperationId = 'operation:converted';
    const converted = logicalJournal(
      'transaction:converted',
      convertedOperationId,
      'rollback',
      convertedOperationId,
      'prepared',
    );
    const convertedCandidate = candidateForStatusPlacement(
      {
        ...emptyLedgerModel('2026-07-22T00:00:00.000Z'),
        transactions: { [converted.transactionId]: converted },
      },
      'review',
      pendingPlacement(converted.transactionId),
    );
    expect(convertedCandidate.ok).toBeTrue();
    if (!convertedCandidate.ok) return;
    expect(convertedCandidate.value).toMatchObject({
      disposition: 'rollback',
      executionMode: 'resume-rollback',
      sourceOperationId: convertedOperationId,
      activeOperationId: convertedOperationId,
      parentOperationId: convertedOperationId,
    });

    const parent = logicalJournal(
      'transaction:parent',
      'operation:parent',
      'forward',
      null,
      'committed',
    );
    const fresh = logicalJournal(
      'transaction:fresh',
      'operation:fresh',
      'rollback',
      parent.intent.operationId,
      'prepared',
    );
    const freshCandidate = candidateForStatusPlacement(
      {
        ...emptyLedgerModel('2026-07-22T00:00:00.000Z'),
        transactions: { [fresh.transactionId]: fresh },
        history: [parent],
      },
      'review',
      pendingPlacement(fresh.transactionId),
    );
    expect(freshCandidate.ok).toBeTrue();
    if (!freshCandidate.ok) return;
    expect(freshCandidate.value).toMatchObject({
      disposition: 'rollback',
      executionMode: 'resume-rollback',
      sourceTransactionId: parent.transactionId,
      activeTransactionId: fresh.transactionId,
      sourceOperationId: parent.intent.operationId,
      activeOperationId: fresh.intent.operationId,
      parentOperationId: parent.intent.operationId,
    });
  });

  test('observes a bounded explicit-all filter-zero without freezing ledger byte views', async () => {
    const fleet = await buildFixtureFleet();
    open.push(fleet);
    const written = await writeLedger(
      fleet.env,
      ledgerPathOf(fleet.data),
      emptyLedgerModel('2026-07-22T00:00:00.000Z'),
    );
    if (!written.ok) throw new Error('fixture ledger write failed');
    const byteReads: string[] = [];
    const observedPorts: typeof fleet.env = {
      ...fleet.env,
      readBytes: async (path) => {
        byteReads.push(path);
        return fleet.env.readBytes(path);
      },
    };
    const projectContext = {
      invocationCwd: fleet.home,
      effectiveCwd: fleet.home,
      projectRoot: null,
      projectIdentity: null,
      projectKind: 'non-git' as const,
      discoveredConfigPath: null,
      explicitConfigPath: null,
    };

    const observed = await observeUndo(request, selection, {
      ports: observedPorts,
      projectContext,
      configuration: fleet.configuration,
    });

    expect(observed.ok).toBeTrue();
    if (!observed.ok) return;
    expect(observed.value.selection).toMatchObject({
      source: 'explicit-all',
      outcome: 'filter-noop',
      tools: ['codex'],
      scopes: ['user'],
    });
    expect(observed.value.candidates).toEqual([]);
    expect(Object.isFrozen(observed.value)).toBeTrue();
    expect(Object.isFrozen(observed.value.ledgerState)).toBeTrue();
    expect(observed.value.ledgerState.state).toBe('present');
    expect(byteReads.filter((path) => path === ledgerPathOf(fleet.data))).toHaveLength(1);
    expect(byteReads.some((path) => /skillsmith\.(?:toml|lock)$/u.test(path))).toBeFalse();
  });

  test('labels command-default tools and the user-only non-project universe as unbounded', async () => {
    const fleet = await buildFixtureFleet();
    open.push(fleet);
    const defaultRequest: UndoRequest = { ...request, tools: [], scopes: [] };
    const defaultSelection: ValidatedUndoSelection = {
      ...selection,
      tools: [],
      scopes: [],
    };

    const observed = await observeUndo(defaultRequest, defaultSelection, {
      ports: fleet.env,
      projectContext: {
        invocationCwd: fleet.home,
        effectiveCwd: fleet.home,
        projectRoot: null,
        projectIdentity: null,
        projectKind: 'non-git',
        discoveredConfigPath: null,
        explicitConfigPath: null,
      },
      configuration: fleet.configuration,
    });

    expect(observed.ok).toBeTrue();
    if (!observed.ok) return;
    expect(observed.value.request.tools).toEqual(['claude-code', 'codex']);
    expect(observed.value.request.scopes).toEqual(['user']);
    expect(observed.value.selection.outcome).toBe('filter-noop');
  });

  test('refuses project scope without a valid project context before reading ports', async () => {
    const poisoned = new Proxy({} as Parameters<typeof observeUndo>[2]['ports'], {
      get: (_target, property) => {
        throw new Error(`unexpected port read: ${String(property)}`);
      },
    });
    const projectSelection: ValidatedUndoSelection = {
      ...selection,
      scopes: ['project'],
    };

    const observed = await observeUndo({ ...request, scopes: ['project'] }, projectSelection, {
      ports: poisoned,
      projectContext: {
        invocationCwd: '/fixture',
        effectiveCwd: '/fixture',
        projectRoot: null,
        projectIdentity: null,
        projectKind: 'non-git',
        discoveredConfigPath: null,
        explicitConfigPath: null,
      },
      configuration: {} as Parameters<typeof observeUndo>[2]['configuration'],
    });

    expect(observed).toEqual({
      ok: false,
      error: {
        code: 'undo-project-context',
        message: 'project scope requires an explicit valid project context',
        exitClass: 'usage',
      },
    });
  });
});
