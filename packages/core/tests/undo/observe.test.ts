import { afterEach, describe, expect, test } from 'bun:test';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
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
  const source = {
    kind: 'local-dev' as const,
    path: '/fixture/source/review',
    contentHash: `sha256:${'a'.repeat(64)}` as ArtifactDigest,
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
      source,
      tool: 'codex',
      scope: 'user',
      before: { kind: 'absent', resource },
      after: {
        kind: 'placement',
        resource,
        classification: 'dev',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: source.path },
        dangling: false,
        source,
        contentHash: source.contentHash,
      },
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

  test('distinguishes committed cleanup shadows from terminal already-reversed history', () => {
    const parentBase = logicalJournal(
      'transaction:parent',
      'operation:parent',
      'forward',
      null,
      'committed',
    );
    if (
      parentBase.intent.before.kind !== 'absent' ||
      parentBase.intent.before.resource.kind !== 'live'
    ) {
      throw new Error('cleanup fixture requires an absent live resource');
    }
    const liveResource = parentBase.intent.before.resource;
    const contentDigest = `sha256:${'a'.repeat(64)}` as ArtifactDigest;
    const source = {
      kind: 'local-dev' as const,
      path: '/fixture/source/review',
      contentHash: contentDigest,
    };
    const absentActual = {
      resourceId: 'resource:live',
      role: 'live' as const,
      state: 'absent' as const,
      repositoryRevision: null,
      placementPath: '/fixture/skills/review',
      liveKind: null,
      mode: null,
      symlinkTarget: null,
      contentHash: null,
    };
    const devActual = {
      resourceId: 'resource:live',
      role: 'live' as const,
      state: 'present' as const,
      repositoryRevision: { kind: 'resource' as const, digest: source.contentHash },
      placementPath: '/fixture/skills/review',
      liveKind: 'symlink' as const,
      mode: 'dev' as const,
      symlinkTarget: source.path,
      contentHash: source.contentHash,
    };
    const ledgerDigest = `sha256:${'b'.repeat(64)}` as ArtifactDigest;
    const ledgerActual = {
      resourceId: 'resource:ledger',
      role: 'ledger' as const,
      state: 'present' as const,
      repositoryRevision: { kind: 'resource' as const, digest: ledgerDigest },
      schemaVersion: 2 as const,
      semanticHash: ledgerDigest,
    };
    const parent: LogicalJournalV1Dto = {
      ...parentBase,
      intent: {
        ...parentBase.intent,
        source,
        before: { kind: 'absent', resource: liveResource },
        after: {
          kind: 'placement',
          resource: liveResource,
          classification: 'dev',
          representation: 'symlink',
          linkTarget: { kind: 'machine-bound', path: source.path },
          dangling: false,
          source,
          contentHash: source.contentHash,
        },
      },
      actual: {
        before: [absentActual, ledgerActual],
        after: [devActual, ledgerActual],
        retained: [],
      },
    };
    const rollbackBase = logicalJournal(
      'transaction:rollback',
      'operation:rollback',
      'rollback',
      parent.intent.operationId,
      'committed',
    );
    const rollback: LogicalJournalV1Dto = {
      ...rollbackBase,
      intent: {
        ...parent.intent,
        operationId: rollbackBase.intent.operationId,
        groupId: rollbackBase.intent.groupId,
      },
      actual: { before: parent.actual.after, after: parent.actual.before, retained: [] },
    };
    const committedPlacement: StatusPlacement = {
      ...pendingPlacement(rollback.transactionId),
      journal: {
        state: 'committed',
        format: 'logical',
        operation: rollback.intent.kind,
        transactionId: rollback.transactionId,
        phase: 'committed',
        before: 'dev',
        retention: [],
        reverseEligibility: 'not-reversible',
        remediation: { reverse: null },
      },
    };
    const cleanupShadow = {
      placementPath: '/fixture/skills/review',
      mode: 'dev' as const,
      dev: {
        sourcePath: '/fixture/source/review',
        resolvedPath: '/fixture/source/review',
        repoRoot: null,
        sourceRelPath: null,
        remote: null,
        recordedAt: '2026-07-22T00:00:00.000Z',
      },
      journal: {
        op: 'uninstall' as const,
        txId: rollback.transactionId,
        phase: 'committed' as const,
        startedAt: '2026-07-22T00:00:00.000Z',
        completedAt: '2026-07-22T00:00:02.000Z',
        before: {
          mode: 'dev' as const,
          symlinkTarget: source.path,
          liveKind: 'symlink' as const,
        },
        stagingPath: '/fixture/staging/review',
        backupPath: '/fixture/backup/review',
      },
    };
    const ledger = {
      ...emptyLedgerModel('2026-07-22T00:00:00.000Z'),
      skills: { review: { tools: { codex: cleanupShadow } } },
      history: [parent, rollback],
    };

    const pendingCleanup = candidateForStatusPlacement(ledger, 'review', committedPlacement);
    expect(pendingCleanup).toMatchObject({
      ok: true,
      value: { outcome: 'already-reversed', recoveryState: 'cleanup-pending' },
    });

    const hostile = candidateForStatusPlacement(
      {
        ...ledger,
        skills: {
          review: {
            tools: {
              codex: {
                ...cleanupShadow,
                journal: { ...cleanupShadow.journal, op: 'install' },
              },
            },
          },
        },
      },
      'review',
      committedPlacement,
    );
    expect(hostile).toMatchObject({
      ok: false,
      error: { code: 'undo-cleanup-carrier', exitClass: 'state' },
    });

    const terminal = candidateForStatusPlacement(
      {
        ...ledger,
        skills: {
          review: { tools: { codex: { ...cleanupShadow, journal: null } } },
        },
      },
      'review',
      committedPlacement,
    );
    expect(terminal).toMatchObject({
      ok: true,
      value: { outcome: 'already-reversed', recoveryState: 'none' },
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
    expect(observed.value.request.tools).toEqual(['claude-code', 'codex', 'muse']);
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
