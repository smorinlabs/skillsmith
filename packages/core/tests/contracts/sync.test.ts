import { describe, expect, test } from 'bun:test';
import { type SyncReportV1Dto, syncV1Codec } from '../../src/contracts/v1/sync.ts';

const report = (): SyncReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.sync',
  command: 'sync',
  mode: 'dry-run',
  state: 'ready',
  endpoints: {
    from: { kind: 'user', scope: 'user', selectedInput: 'user', projectRoot: null },
    to: { kind: 'path', scope: 'project', selectedInput: './target', projectRoot: '/target' },
  },
  artifactPair: null,
  options: { force: false, delete: false, save: false, dryRun: true, continueOnError: false },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'filter-noop',
    targets: [],
    skills: [],
    tools: [],
    groupIds: [],
    sourceMembers: 0,
    destinationMembers: 0,
  },
  operations: [],
  checks: [],
  diagnostics: [],
  approval: { required: false, outcome: 'not-required' },
  groups: [],
  effects: [],
  summary: {
    groups: 0,
    pairs: 0,
    planned: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    notRun: 0,
    changed: 0,
    unchanged: 0,
    effects: 0,
    drift: 0,
    refusals: 0,
  },
});

describe('sync@1 report codec', () => {
  test('round-trips the strict filter-noop projection', () => {
    const encoded = syncV1Codec.encode(report());
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(syncV1Codec.decode(encoded.value)).toEqual({ ok: true, value: report() });
  });

  test('rejects recursive unknown fields and inconsistent summary facts', () => {
    expect(syncV1Codec.validate({ ...report(), unexpected: true })).toMatchObject({ ok: false });
    expect(
      syncV1Codec.validate({
        ...report(),
        endpoints: { ...report().endpoints, from: { ...report().endpoints.from, secret: 'x' } },
      }),
    ).toMatchObject({ ok: false });
    expect(
      syncV1Codec.validate({ ...report(), summary: { ...report().summary, groups: 1 } }),
    ).toMatchObject({
      ok: false,
    });
    expect(syncV1Codec.validate({ ...report(), operations: [{}] })).toMatchObject({ ok: false });
    expect(
      syncV1Codec.validate({
        ...report(),
        mode: 'execute',
        options: { ...report().options, dryRun: false },
        state: 'partial',
      }),
    ).toMatchObject({ ok: false });
  });

  test('validates operation-free noop correlations against sync-selected groups', () => {
    const groupId = 'group:v1:noop';
    const value: SyncReportV1Dto = {
      ...report(),
      selection: {
        ...report().selection,
        selectionOutcome: 'selected',
        skills: ['lint'],
        tools: ['codex'],
        groupIds: [groupId],
        sourceMembers: 1,
        destinationMembers: 1,
      },
      diagnostics: [
        {
          diagnosticId: 'diagnostic:v1:noop',
          kind: 'noop',
          severity: 'info',
          refusalClass: null,
          affected: {
            skill: 'lint',
            source: null,
            tool: 'codex',
            scope: 'project',
            path: null,
          },
          correlation: { groupId, pairId: null, operationId: null },
          reason: { code: 'sync-destination-current', message: 'lint is current' },
          selectionSource: 'bounded-default',
        },
      ],
      groups: [
        {
          groupId,
          skill: 'lint',
          pairs: [
            {
              tool: 'codex',
              source: { scope: 'user', present: true },
              destination: { scope: 'project', present: true },
              action: 'noop',
              outcome: 'not-run',
              skipReason: null,
              failure: null,
              force: {
                requested: false,
                used: false,
                conflictType: null,
                destination: null,
                normal: 'apply',
                forced: 'not-applicable',
                required: false,
                outcome: 'not-required',
              },
              drift: { artifact: false, live: false },
            },
          ],
        },
      ],
      summary: { ...report().summary, groups: 1, pairs: 1, notRun: 1, unchanged: 1 },
    };
    expect(syncV1Codec.validate(value)).toMatchObject({ ok: true });
    expect(
      syncV1Codec.validate({
        ...value,
        diagnostics: [
          {
            ...value.diagnostics[0],
            correlation: { groupId: 'group:v1:unselected', pairId: null, operationId: null },
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });
});
