import { describe, expect, test } from 'bun:test';
import { type UndoReportV1Dto, toUndoV1Dto, undoV1Codec } from '../../src/contracts/v1/undo.ts';
import { createPlanningDiagnosticId } from '../../src/planning/create.ts';
import type { UndoReport } from '../../src/undo/types.ts';

const emptySummary = (): UndoReportV1Dto['summary'] => ({
  selected: 0,
  actionable: 0,
  alreadyReversed: 0,
  planned: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  skipped: 0,
  notRun: 0,
  effects: 0,
  refusals: 0,
});

const emptyReport = (): UndoReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.undo',
  command: 'undo',
  mode: 'dry-run',
  state: 'ready',
  project: { effectiveCwd: '/fixture', root: '/fixture', identity: 'fixture-project' },
  selection: {
    source: 'explicit-all',
    outcome: 'filter-zero',
    targets: [],
    all: true,
    tools: ['claude-code'],
    scopes: ['project'],
    groupIds: [],
    batchPolicy: 'fail-fast',
  },
  approval: { required: false, outcome: 'not-required' },
  groups: [],
  operations: [],
  checks: [],
  results: [],
  effects: [],
  diagnostics: [],
  summary: emptySummary(),
});

const operation = (): UndoReportV1Dto['operations'][number] => {
  const resource = {
    kind: 'live' as const,
    skill: 'review',
    tool: 'claude-code' as const,
    scope: 'project' as const,
    projectRoot: { kind: 'machine-bound' as const, path: '/fixture' },
    location: { kind: 'machine-bound' as const, path: '/fixture/.claude/skills/review' },
  };
  return {
    operationId: 'operation:v1:undo-review',
    groupId: 'group:v1:undo-review',
    pairId: 'pair:v1:undo-review',
    kind: 'link-dev',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: 'review',
    source: {
      kind: 'local-dev',
      path: '/fixture/source/review',
      contentHash: `sha256:${'a'.repeat(64)}`,
    },
    tool: 'claude-code',
    scope: 'project',
    before: {
      kind: 'placement',
      resource,
      classification: 'pinned',
      representation: 'copy',
      linkTarget: null,
      dangling: false,
      source: null,
      contentHash: `sha256:${'b'.repeat(64)}`,
    },
    after: {
      kind: 'placement',
      resource,
      classification: 'dev',
      representation: 'symlink',
      linkTarget: { kind: 'machine-bound', path: '/fixture/source/review' },
      dangling: false,
      source: {
        kind: 'local-dev',
        path: '/fixture/source/review',
        contentHash: `sha256:${'a'.repeat(64)}`,
      },
      contentHash: `sha256:${'a'.repeat(64)}`,
    },
    reason: { code: 'undo-promote', message: 'Restore the retained development placement.' },
    selectionSource: 'explicit-targets',
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'conditional', retentionResourceIds: ['store:v1:review'] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const actionableReport = (mode: 'dry-run' | 'execute'): UndoReportV1Dto => {
  const planned = operation();
  const execute = mode === 'execute';
  return {
    ...emptyReport(),
    mode,
    state: execute ? 'completed' : 'ready',
    selection: {
      source: 'explicit-targets',
      outcome: 'selected',
      targets: ['review'],
      all: false,
      tools: ['claude-code'],
      scopes: ['project'],
      groupIds: [planned.groupId],
      batchPolicy: 'fail-fast',
    },
    approval: execute
      ? { required: true, outcome: 'approved' }
      : { required: false, outcome: 'not-required' },
    groups: [
      {
        groupId: planned.groupId,
        skill: 'review',
        scope: 'project',
        pairs: [
          {
            pairId: 'pair:v1:undo-review',
            tool: 'claude-code',
            path: '/fixture/.claude/skills/review',
            action: 'reverse-committed',
            operationFamily: 'promote',
            disposition: 'rollback',
            phase: 'committed',
            executionMode: 'convert-to-rollback',
            sourceTransactionId: 'transaction:v1:source',
            activeTransactionId: 'transaction:v1:undo',
            sourceOperationId: 'operation:v1:source',
            activeOperationId: planned.operationId,
            parentOperationId: 'operation:v1:source',
            beforeState: 'pinned',
            eligibility: 'eligible',
            retention: { required: true, resourceIds: ['store:v1:review'] },
            operations: [planned.operationId],
            outcome: execute ? 'succeeded' : 'planned',
            failure: null,
          },
        ],
        operations: [planned.operationId],
        outcome: execute ? 'succeeded' : 'planned',
        failure: null,
      },
    ],
    operations: [planned],
    results: execute
      ? [{ operationId: planned.operationId, outcome: 'succeeded', error: null }]
      : [],
    effects: [
      {
        role: 'ledger',
        action: planned.kind,
        operationId: planned.operationId,
        groupId: planned.groupId,
        outcome: execute ? 'succeeded' : 'planned',
      },
      {
        role: 'live',
        action: planned.kind,
        operationId: planned.operationId,
        groupId: planned.groupId,
        outcome: execute ? 'succeeded' : 'planned',
      },
    ],
    summary: {
      ...emptySummary(),
      selected: 1,
      actionable: 1,
      [execute ? 'succeeded' : 'planned']: 1,
      effects: 2,
    },
  };
};

describe('undo@1 report codec', () => {
  test('round-trips the strict targetless all filter-zero projection', () => {
    expect(undoV1Codec.descriptor).toMatchObject({
      id: 'undo',
      version: 1,
      wireKind: 'skillsmith.undo',
      unknownFields: 'reject-recursive',
    });
    const encoded = undoV1Codec.encode(emptyReport());
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(encoded.value.endsWith('\n')).toBeTrue();
    expect(undoV1Codec.decode(encoded.value)).toEqual({ ok: true, value: emptyReport() });
  });

  test('accepts exact planned and executed reversal products', () => {
    expect(undoV1Codec.validate(actionableReport('dry-run'))).toMatchObject({ ok: true });
    expect(undoV1Codec.validate(actionableReport('execute'))).toMatchObject({ ok: true });
  });

  test('preserves a group-level artifact failure while the live pair remains not-run', () => {
    const report = actionableReport('execute');
    const live = report.operations[0];
    const group = report.groups[0];
    const pair = group?.pairs[0];
    if (live === undefined || group === undefined || pair === undefined) {
      throw new Error('actionable undo fixture omitted its canonical operation');
    }
    const lockLocation = { kind: 'machine-bound' as const, path: '/fixture/skillsmith.lock' };
    const lockValue = {
      version: 1 as const,
      hashSchemaVersion: 1 as const,
      manifestHash: `sha256:${'c'.repeat(64)}` as const,
      skills: [],
    };
    const artifact: UndoReportV1Dto['operations'][number] = {
      ...live,
      operationId: 'operation:v1:undo-review-lock',
      pairId: null,
      kind: 'write-lock',
      skill: null,
      source: null,
      tool: null,
      scope: null,
      before: {
        kind: 'lock',
        location: lockLocation,
        version: 1,
        canonicalHash: `sha256:${'d'.repeat(64)}`,
        value: lockValue,
      },
      after: {
        kind: 'lock',
        location: lockLocation,
        version: 1,
        canonicalHash: `sha256:${'e'.repeat(64)}`,
        value: lockValue,
      },
      reason: { code: 'rollback-artifact-inverse', message: 'Restore the retained lock.' },
      reversibility: {
        kind: 'conditional',
        retentionResourceIds: ['update-artifact-retention:v1:fixture'],
      },
      mutates: { live: false, manifest: false, lock: true, ledger: true },
    };
    const failed = {
      operationId: artifact.operationId,
      outcome: 'failed' as const,
      error: {
        code: 'undo-artifact-restore-failed',
        message: 'retained lock restore failed',
        remediation: 'retry',
      },
    };
    const skipped = {
      operationId: live.operationId,
      outcome: 'skipped-after-failure' as const,
      error: null,
    };
    const artifactFailure: UndoReportV1Dto = {
      ...report,
      state: 'partial',
      groups: [
        {
          ...group,
          operations: [artifact.operationId, live.operationId],
          outcome: 'failed',
          failure: { code: failed.error.code, message: failed.error.message },
          pairs: [{ ...pair, outcome: 'not-run', failure: null }],
        },
      ],
      operations: [artifact, live],
      results: [failed, skipped],
      effects: [
        {
          role: 'ledger',
          action: artifact.kind,
          operationId: artifact.operationId,
          groupId: artifact.groupId,
          outcome: 'failed',
        },
        ...report.effects.map((effect) => ({ ...effect, outcome: 'not-run' as const })),
      ],
      summary: {
        ...emptySummary(),
        selected: 1,
        actionable: 1,
        failed: 1,
        effects: 3,
      },
    };

    expect(undoV1Codec.validate(artifactFailure)).toMatchObject({ ok: true });
    expect(
      undoV1Codec.validate({
        ...artifactFailure,
        groups: [{ ...artifactFailure.groups[0], outcome: 'not-run', failure: null }],
      }),
    ).toMatchObject({ ok: false });
  });

  test('rejects every non-canonical effect omission, duplication, order, and field drift', () => {
    const report = actionableReport('dry-run');
    const ledger = report.effects[0];
    const live = report.effects[1];
    if (ledger === undefined || live === undefined) {
      throw new Error('actionable undo fixture omitted its canonical ledger/live effects');
    }
    expect(report.effects.map(({ role, action }) => [role, action])).toEqual([
      ['ledger', 'link-dev'],
      ['live', 'link-dev'],
    ]);
    const reject = (effects: UndoReportV1Dto['effects']): void => {
      expect(undoV1Codec.validate({ ...report, effects })).toMatchObject({ ok: false });
    };

    reject([ledger]);
    reject([...report.effects, ledger]);
    reject([live, ledger]);
    reject([{ ...ledger, role: 'live' }, live]);
    reject([{ ...ledger, action: 'remove' }, live]);
    reject([{ ...ledger, operationId: 'operation:v1:wrong' }, live]);
    reject([{ ...ledger, groupId: 'group:v1:wrong' }, live]);
    reject([{ ...ledger, outcome: 'succeeded' }, live]);

    const executed = actionableReport('execute');
    expect(
      undoV1Codec.validate({
        ...executed,
        effects: executed.effects.map((effect) => ({ ...effect, outcome: 'failed' as const })),
      }),
    ).toMatchObject({ ok: false });
  });

  test('enforces canonical nested-pair order, identity, coverage, and reduction facts', () => {
    const report = actionableReport('dry-run');
    const firstOperation = report.operations[0];
    const firstGroup = report.groups[0];
    const firstPair = firstGroup?.pairs[0];
    const firstEffect = report.effects[0];
    if (
      firstOperation === undefined ||
      firstGroup === undefined ||
      firstPair === undefined ||
      firstEffect === undefined
    ) {
      throw new Error('actionable undo fixture omitted its canonical pair');
    }
    if (firstOperation.before.kind !== 'placement' || firstOperation.after.kind !== 'placement') {
      throw new Error('actionable undo fixture omitted its placement images');
    }
    const codexResource = {
      ...firstOperation.before.resource,
      tool: 'codex' as const,
      location: {
        kind: 'machine-bound' as const,
        path: '/fixture/.codex/skills/review',
      },
    };
    const codexOperation: UndoReportV1Dto['operations'][number] = {
      ...firstOperation,
      operationId: 'operation:v1:undo-review-codex',
      pairId: 'pair:v1:undo-review-codex',
      tool: 'codex',
      before: { ...firstOperation.before, resource: codexResource },
      after: { ...firstOperation.after, resource: codexResource },
    };
    const codexPair: typeof firstPair = {
      ...firstPair,
      pairId: 'pair:v1:undo-review-codex',
      tool: 'codex',
      path: '/fixture/.codex/skills/review',
      activeOperationId: codexOperation.operationId,
      operations: [codexOperation.operationId],
    };
    const paired: UndoReportV1Dto = {
      ...report,
      selection: { ...report.selection, tools: ['claude-code', 'codex'] },
      groups: [
        {
          ...firstGroup,
          pairs: [firstPair, codexPair],
          operations: [firstOperation.operationId, codexOperation.operationId],
        },
      ],
      operations: [firstOperation, codexOperation],
      effects: [
        ...report.effects,
        ...report.effects.map((effect) => ({
          ...effect,
          operationId: codexOperation.operationId,
        })),
      ],
      summary: { ...report.summary, effects: 4 },
    };
    const pairedGroup = paired.groups[0];
    if (pairedGroup === undefined) throw new Error('paired fixture omitted its group');

    expect(undoV1Codec.validate(paired)).toMatchObject({ ok: true });
    const reject = (groups: UndoReportV1Dto['groups']): void => {
      expect(undoV1Codec.validate({ ...paired, groups })).toMatchObject({ ok: false });
    };
    reject([{ ...firstGroup, pairs: [codexPair, firstPair], operations: pairedGroup.operations }]);
    reject([
      {
        ...firstGroup,
        pairs: [firstPair, { ...codexPair, pairId: firstPair.pairId }],
        operations: pairedGroup.operations,
      },
    ]);
    reject([{ ...pairedGroup, operations: [firstOperation.operationId] }]);
    reject([{ ...pairedGroup, outcome: 'succeeded' }]);
    reject([
      {
        ...pairedGroup,
        failure: { code: 'fabricated', message: 'not sourced from a failed pair' },
      },
    ]);

    const executed = actionableReport('execute');
    expect(
      undoV1Codec.validate({
        ...executed,
        results: executed.results.map((result) => ({
          ...result,
          outcome: 'cancelled' as const,
          error: null,
        })),
      }),
    ).toMatchObject({ ok: false });
  });

  test('keeps approval refusal explicit without fabricating execution results', () => {
    const refused: UndoReportV1Dto = {
      ...actionableReport('dry-run'),
      mode: 'execute',
      state: 'refused',
      approval: { required: true, outcome: 'refused' },
      effects: actionableReport('dry-run').effects.map((effect) => ({
        ...effect,
        outcome: 'not-run',
      })),
    };
    expect(refused.operations).not.toHaveLength(0);
    expect(refused.results).toEqual([]);
    expect(undoV1Codec.validate(refused)).toMatchObject({ ok: true });
  });

  test('uses one exact cleanup diagnostic as zero-operation execute approval authority', () => {
    const actionable = actionableReport('dry-run');
    const sourceGroup = actionable.groups[0];
    const sourcePair = sourceGroup?.pairs[0];
    if (sourceGroup === undefined || sourcePair === undefined) {
      throw new Error('actionable fixture omitted its group pair');
    }
    const cleanupGroupId = `group:v1:${'1'.repeat(64)}`;
    const cleanupPairId = `pair:v1:${'2'.repeat(64)}`;
    const pair = {
      ...sourcePair,
      pairId: cleanupPairId,
      eligibility: 'already-reversed' as const,
      operations: [],
      outcome: 'already-reversed' as const,
    };
    const group = {
      ...sourceGroup,
      groupId: cleanupGroupId,
      pairs: [pair],
      operations: [],
      outcome: 'already-reversed' as const,
    };
    const affected = {
      skill: group.skill,
      source: null,
      tool: pair.tool,
      scope: group.scope,
      path: { kind: 'machine-bound' as const, path: pair.path },
    };
    const correlation = { groupId: group.groupId, pairId: pair.pairId, operationId: null };
    const diagnostic = {
      diagnosticId: createPlanningDiagnosticId({
        domain: 'skillsmith.planning-diagnostic-identity',
        schemaVersion: 1,
        kind: 'warning',
        severity: 'warning',
        refusalClass: null,
        affected,
        correlation,
        reasonCode: 'undo-cleanup-pending',
        selectionSource: 'explicit-targets',
      }),
      kind: 'warning' as const,
      severity: 'warning' as const,
      refusalClass: null,
      affected,
      correlation,
      reason: {
        code: 'undo-cleanup-pending',
        message: "Committed undo cleanup remains pending for 'review' on claude-code.",
      },
      selectionSource: 'explicit-targets' as const,
    };
    const cleanup: UndoReportV1Dto = {
      ...emptyReport(),
      selection: {
        ...actionable.selection,
        groupIds: [group.groupId],
      },
      groups: [group],
      diagnostics: [diagnostic],
      summary: { ...emptySummary(), selected: 1, alreadyReversed: 1 },
    };

    expect(undoV1Codec.validate(cleanup)).toMatchObject({ ok: true });
    expect(
      undoV1Codec.validate({
        ...cleanup,
        mode: 'execute',
        approval: { required: true, outcome: 'pending' },
      }),
    ).toMatchObject({ ok: true });
    expect(
      undoV1Codec.validate({
        ...cleanup,
        mode: 'execute',
        state: 'completed',
        approval: { required: true, outcome: 'approved' },
      }),
    ).toMatchObject({ ok: true });
    expect(
      undoV1Codec.validate({
        ...cleanup,
        mode: 'execute',
        state: 'completed',
        approval: { required: false, outcome: 'not-required' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      undoV1Codec.validate({
        ...cleanup,
        diagnostics: [{ ...diagnostic, correlation: { ...correlation, pairId: 'pair:v1:wrong' } }],
      }),
    ).toMatchObject({ ok: false });
  });

  test('mechanically maps the closed domain report without leaking private group fields', () => {
    const expected = actionableReport('dry-run');
    const domain: UndoReport = {
      ...expected,
      selection: {
        ...expected.selection,
        tools: expected.selection.tools as UndoReport['selection']['tools'],
      },
      groups: expected.groups.map(({ skill, operations, pairs, ...group }) => ({
        ...group,
        name: skill,
        pairs: pairs.map((pair) => ({
          ...pair,
          operationIds: pair.operations,
          operations: expected.operations.filter(({ operationId }) =>
            pair.operations.includes(operationId),
          ) as UndoReport['operations'],
        })),
        operationIds: operations,
        operations: expected.operations as unknown as UndoReport['operations'],
      })),
      operations: expected.operations as unknown as UndoReport['operations'],
      checks: expected.checks as unknown as UndoReport['checks'],
      results: expected.results as unknown as UndoReport['results'],
      diagnostics: expected.diagnostics as unknown as UndoReport['diagnostics'],
    };

    const mapped = toUndoV1Dto(domain);
    expect(mapped).toEqual(expected);
    expect(mapped.groups[0]).not.toHaveProperty('path');
    expect(mapped.groups[0]?.pairs[0]).toHaveProperty('path', '/fixture/.claude/skills/review');
  });

  test('admits an exact legacy-ledger migration prefix without fabricating a target group', () => {
    const report = actionableReport('dry-run');
    const target = report.operations[0];
    if (target === undefined) throw new Error('actionable undo fixture omitted its operation');
    const projectRoot = { kind: 'machine-bound' as const, path: '/fixture' };
    const migration: UndoReportV1Dto['operations'][number] = {
      operationId: 'operation:v1:migrate-ledger',
      groupId: 'group:v1:migrate-ledger',
      pairId: null,
      kind: 'migrate-ledger',
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
      skill: null,
      source: null,
      tool: null,
      scope: null,
      before: {
        kind: 'ledger',
        projectRoot,
        schemaVersion: 1,
        byteHash: `sha256:${'c'.repeat(64)}`,
        semanticHash: `sha256:${'d'.repeat(64)}`,
      },
      after: {
        kind: 'ledger',
        projectRoot,
        schemaVersion: 2,
        byteHash: `sha256:${'e'.repeat(64)}`,
        semanticHash: `sha256:${'f'.repeat(64)}`,
      },
      reason: { code: 'migrate-ledger', message: 'Migrate the selected legacy ledger.' },
      selectionSource: 'explicit-targets',
      preconditionIds: [],
      requiredCheckIds: [],
      reversibility: { kind: 'none', retentionResourceIds: [] },
      mutates: { live: false, manifest: false, lock: false, ledger: true },
      conflict: null,
    };
    const prefixed: UndoReportV1Dto = {
      ...report,
      operations: [
        migration,
        {
          ...target,
          dependencyMetadata: {
            ...target.dependencyMetadata,
            operationIds: [migration.operationId],
          },
        },
      ],
      effects: [
        {
          role: 'ledger',
          action: migration.kind,
          operationId: migration.operationId,
          groupId: migration.groupId,
          outcome: 'planned',
        },
        ...report.effects,
      ],
      summary: { ...report.summary, effects: 3 },
    };

    expect(prefixed.selection.groupIds).toEqual(['group:v1:undo-review']);
    expect(prefixed.groups[0]?.operations).toEqual([target.operationId]);
    expect(undoV1Codec.validate(prefixed)).toMatchObject({ ok: true });
  });

  test('accepts an explicit already-reversed no-op without older-history fallback', () => {
    const actionableGroup = actionableReport('dry-run').groups[0];
    if (actionableGroup === undefined) throw new Error('actionable undo fixture omitted its group');
    const report: UndoReportV1Dto = {
      ...emptyReport(),
      selection: {
        ...emptyReport().selection,
        outcome: 'selected',
        groupIds: ['group:v1:undo-review'],
      },
      groups: [
        {
          ...actionableGroup,
          pairs: actionableGroup.pairs.map((pair) => ({
            ...pair,
            eligibility: 'already-reversed',
            operations: [],
            outcome: 'already-reversed',
          })),
          operations: [],
          outcome: 'already-reversed',
        },
      ],
      summary: { ...emptySummary(), selected: 1, alreadyReversed: 1 },
    };
    expect(undoV1Codec.validate(report)).toMatchObject({ ok: true });
    expect(
      undoV1Codec.validate({
        ...report,
        groups: [
          {
            ...report.groups[0],
            pairs: report.groups[0]?.pairs.map((pair) => ({
              ...pair,
              operations: ['operation:v1:older-history'],
            })),
            operations: ['operation:v1:older-history'],
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  test('rejects recursive unknown fields, credential material, and identity drift', () => {
    expect(
      undoV1Codec.validate({
        ...emptyReport(),
        approval: { ...emptyReport().approval, internalJournal: true },
      }),
    ).toMatchObject({ ok: false });
    expect(
      undoV1Codec.validate({
        ...actionableReport('dry-run'),
        operations: actionableReport('dry-run').operations.map((operation) => ({
          ...operation,
          dependsOn: operation.dependencyMetadata.operationIds,
        })),
      }),
    ).toMatchObject({ ok: false });
    expect(
      undoV1Codec.validate({
        ...emptyReport(),
        project: { ...emptyReport().project, root: '/tmp?access_token=undo-canary' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      undoV1Codec.validate({
        ...actionableReport('execute'),
        selection: { ...actionableReport('execute').selection, groupIds: ['group:v1:wrong'] },
      }),
    ).toMatchObject({ ok: false });
    expect(
      undoV1Codec.validate({
        ...actionableReport('execute'),
        summary: { ...actionableReport('execute').summary, failed: 1 },
      }),
    ).toMatchObject({ ok: false });
  });
});
