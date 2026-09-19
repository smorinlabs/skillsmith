import { describe, expect, test } from 'bun:test';
import { type ApplyReportV1Dto, applyV1Codec } from '../../src/contracts/v1/index.ts';

const zeroOperationKinds = () => ({
  install: 0,
  update: 0,
  remove: 0,
  'link-dev': 0,
  promote: 0,
  'move-scope': 0,
  adapt: 0,
  repair: 0,
  'write-manifest': 0,
  'write-lock': 0,
  'migrate-project-config': 0,
  'migrate-ledger': 0,
});

const emptyApplyReport = (): ApplyReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.apply-report',
  command: 'apply',
  mode: 'fresh-execute',
  state: 'completed',
  artifactPair: {
    manifestPath: '/fixture/skillsmith.toml',
    lockPath: '/fixture/skillsmith.lock',
    lockSource: 'sibling',
    selectionSource: 'explicit',
  },
  savedPlan: null,
  project: { effectiveCwd: '/fixture', root: '/fixture', identity: 'fixture-project' },
  options: {
    locked: false,
    prune: false,
    check: false,
    dryRun: false,
    continueOnError: false,
  },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'selected',
    requestedTools: [],
    requestedScope: null,
    skills: [],
    tools: [],
    scopes: [],
  },
  operations: [],
  checks: [],
  diagnostics: [],
  approval: { required: false, outcome: 'not-required' },
  validation: { outcome: 'not-run', replanned: false },
  results: [],
  summary: {
    operations: 0,
    checks: 0,
    diagnostics: 0,
    drift: 0,
    refusals: 0,
    operationKinds: zeroOperationKinds(),
    checkKinds: {
      'source-resolution': 0,
      capability: 0,
      'content-integrity': 0,
      verification: 0,
      'precondition-validation': 0,
    },
    diagnosticKinds: { noop: 0, skip: 0, refuse: 0, conflict: 0, warning: 0 },
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    rolledBack: 0,
    skipped: 0,
  },
});

const changingApplyReport = (): ApplyReportV1Dto => {
  const resource = {
    kind: 'live' as const,
    skill: 'alpha',
    tool: 'codex' as const,
    scope: 'project' as const,
    projectRoot: { kind: 'machine-bound' as const, path: '/fixture' },
    location: { kind: 'machine-bound' as const, path: '/fixture/.agents/skills/alpha' },
  };
  const operation: ApplyReportV1Dto['operations'][number] = {
    operationId: 'operation:v1:alpha-remove',
    groupId: 'group:v1:alpha-remove',
    pairId: 'pair:v1:alpha-remove',
    kind: 'remove',
    dependsOn: [],
    skill: 'alpha',
    source: null,
    tool: 'codex',
    scope: 'project',
    before: {
      kind: 'placement',
      resource,
      classification: 'pinned',
      representation: 'copy',
      linkTarget: null,
      dangling: false,
      source: null,
      contentHash: `sha256:${'a'.repeat(64)}`,
    },
    after: { kind: 'absent', resource },
    reason: { code: 'fixture-remove', message: 'Remove the fixture placement.' },
    selectionSource: 'bounded-default',
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
  const empty = emptyApplyReport();
  return {
    ...empty,
    selection: {
      ...empty.selection,
      skills: ['alpha'],
      tools: ['codex'],
      scopes: ['project'],
    },
    operations: [operation],
    approval: { required: true, outcome: 'approved' },
    validation: { outcome: 'valid', replanned: false },
    results: [
      {
        operationId: operation.operationId,
        outcome: 'succeeded',
        reason: null,
        error: null,
      },
    ],
    summary: {
      ...empty.summary,
      operations: 1,
      drift: 1,
      operationKinds: { ...empty.summary.operationKinds, remove: 1 },
      succeeded: 1,
    },
  };
};

describe('apply report v1 contract', () => {
  test('round-trips one strict empty fresh report', () => {
    const report = emptyApplyReport();
    const encoded = applyV1Codec.encode(report);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(encoded.value.endsWith('\n')).toBeTrue();
    const decoded = applyV1Codec.decode(encoded.value);
    expect(decoded).toEqual({ ok: true, value: report });
  });

  test('accepts the saved prior-authorization shape', () => {
    const report: ApplyReportV1Dto = {
      ...emptyApplyReport(),
      mode: 'saved-check',
      state: 'ready',
      artifactPair: null,
      savedPlan: {
        path: '/fixture/review.plan',
        portability: 'portable',
        executorSchemaVersion: 1,
        hashSchemaVersion: 1,
      },
      options: { ...emptyApplyReport().options, check: true },
      approval: { required: false, outcome: 'prior-authorization' },
      validation: { outcome: 'valid', replanned: false },
    };
    expect(applyV1Codec.validate(report)).toEqual({ ok: true, value: report });
  });

  test('accepts fresh validation refusals without claiming approval occurred', () => {
    const changing = changingApplyReport();
    const report: ApplyReportV1Dto = {
      ...changing,
      state: 'refused',
      approval: { required: false, outcome: 'not-required' },
      validation: { outcome: 'stale', replanned: false },
      results: [],
      summary: { ...changing.summary, succeeded: 0 },
    };
    expect(applyV1Codec.validate(report)).toEqual({ ok: true, value: report });
    expect(
      applyV1Codec.validate({
        ...report,
        validation: { outcome: 'valid', replanned: false },
      }).ok,
    ).toBeFalse();
    expect(
      applyV1Codec.validate({
        ...emptyApplyReport(),
        state: 'refused',
        validation: { outcome: 'stale', replanned: false },
      }).ok,
    ).toBeFalse();
  });

  test('closes every nonmutating and no-op lifecycle row', () => {
    const empty = emptyApplyReport();
    const rows: ApplyReportV1Dto[] = [
      {
        ...empty,
        mode: 'fresh-dry-run',
        state: 'ready',
        options: { ...empty.options, dryRun: true },
      },
      {
        ...empty,
        mode: 'fresh-check',
        state: 'ready',
        options: { ...empty.options, check: true },
      },
      { ...empty, state: 'refused' },
      {
        ...empty,
        mode: 'saved-dry-run',
        state: 'ready',
        artifactPair: null,
        savedPlan: {
          path: '/fixture/review.plan',
          portability: 'portable',
          executorSchemaVersion: 1,
          hashSchemaVersion: 1,
        },
        options: { ...empty.options, dryRun: true },
        approval: { required: false, outcome: 'prior-authorization' },
        validation: { outcome: 'valid', replanned: false },
      },
      {
        ...empty,
        mode: 'saved-check',
        state: 'refused',
        artifactPair: null,
        savedPlan: {
          path: '/fixture/review.plan',
          portability: 'machine-bound',
          executorSchemaVersion: 1,
          hashSchemaVersion: 1,
        },
        options: { ...empty.options, check: true },
        approval: { required: false, outcome: 'prior-authorization' },
        validation: { outcome: 'stale', replanned: false },
      },
      {
        ...empty,
        mode: 'saved-execute',
        artifactPair: null,
        savedPlan: {
          path: '/fixture/review.plan',
          portability: 'portable',
          executorSchemaVersion: 1,
          hashSchemaVersion: 1,
        },
        approval: { required: false, outcome: 'prior-authorization' },
        validation: { outcome: 'valid', replanned: false },
      },
    ];
    for (const row of rows)
      expect(applyV1Codec.validate(row), row.mode).toEqual({ ok: true, value: row });
  });

  test('closes changing success and partial execution rows', () => {
    const completed = changingApplyReport();
    expect(applyV1Codec.validate(completed)).toEqual({ ok: true, value: completed });

    const partial: ApplyReportV1Dto = {
      ...completed,
      state: 'partial',
      results: [
        {
          operationId: completed.operations[0]?.operationId ?? 'missing',
          outcome: 'failed',
          reason: 'fixture failure',
          error: {
            code: 'fixture-failure',
            message: 'fixture execution failed',
            remediation: 'retry the fixture',
          },
        },
      ],
      summary: { ...completed.summary, succeeded: 0, failed: 1 },
    };
    expect(applyV1Codec.validate(partial)).toEqual({ ok: true, value: partial });
    expect(applyV1Codec.validate({ ...partial, state: 'completed' }).ok).toBeFalse();
    expect(
      applyV1Codec.validate({
        ...completed,
        state: 'partial',
      }).ok,
    ).toBeFalse();
  });

  test('accepts refusal after exact fresh validation and before physical execution', () => {
    const completed = changingApplyReport();
    const refused: ApplyReportV1Dto = {
      ...completed,
      state: 'refused',
      approval: { required: true, outcome: 'refused' },
      validation: { outcome: 'valid', replanned: false },
      results: [],
      summary: { ...completed.summary, succeeded: 0 },
    };
    expect(applyV1Codec.validate(refused)).toEqual({ ok: true, value: refused });
    expect(
      applyV1Codec.validate({
        ...refused,
        validation: { outcome: 'not-run', replanned: false },
      }).ok,
    ).toBeFalse();
  });

  test('rejects impossible mode, approval, validation, state, and result combinations', () => {
    const empty = emptyApplyReport();
    const invalid = [
      {
        ...empty,
        approval: { required: true, outcome: 'approved' },
      },
      {
        ...empty,
        validation: { outcome: 'valid', replanned: false },
      },
      {
        ...empty,
        mode: 'fresh-dry-run',
        options: { ...empty.options, dryRun: false },
      },
      {
        ...empty,
        mode: 'fresh-dry-run',
        options: { ...empty.options, dryRun: true },
        state: 'completed',
      },
      {
        ...empty,
        validation: { outcome: 'incompatible', replanned: false },
      },
      {
        ...empty,
        mode: 'saved-execute',
        artifactPair: null,
        savedPlan: {
          path: '/fixture/review.plan',
          portability: 'portable',
          executorSchemaVersion: 1,
          hashSchemaVersion: 1,
        },
        approval: { required: false, outcome: 'prior-authorization' },
        validation: { outcome: 'not-run', replanned: false },
      },
      {
        ...empty,
        mode: 'saved-execute',
        artifactPair: null,
        savedPlan: {
          path: '/fixture/review.plan',
          portability: 'portable',
          executorSchemaVersion: 1,
          hashSchemaVersion: 1,
        },
        options: { ...empty.options, continueOnError: true },
        approval: { required: false, outcome: 'prior-authorization' },
        validation: { outcome: 'valid', replanned: false },
      },
    ] as const;
    for (const row of invalid) expect(applyV1Codec.validate(row).ok).toBeFalse();
  });

  test('rejects recursive unknown fields and inconsistent mode and summary facts', () => {
    const unknown = structuredClone(emptyApplyReport()) as ApplyReportV1Dto & {
      approval: ApplyReportV1Dto['approval'] & { secret: string };
    };
    unknown.approval.secret = 'must-not-pass';
    expect(applyV1Codec.validate(unknown)).toMatchObject({
      ok: false,
      error: { path: ['approval', 'secret'] },
    });

    const badMode = { ...emptyApplyReport(), mode: 'saved-execute' } as ApplyReportV1Dto;
    expect(applyV1Codec.validate(badMode).ok).toBeFalse();

    const badSummary = structuredClone(emptyApplyReport());
    badSummary.summary.operations = 1;
    expect(applyV1Codec.validate(badSummary).ok).toBeFalse();
  });
});
