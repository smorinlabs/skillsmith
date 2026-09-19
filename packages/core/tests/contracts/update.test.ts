import { describe, expect, test } from 'bun:test';
import { type UpdateReportV1Dto, updateV1Codec } from '../../src/contracts/v1/update.ts';

const emptySummary = (): UpdateReportV1Dto['summary'] => ({
  groups: 0,
  candidates: 0,
  current: 0,
  available: 0,
  skippedFixed: 0,
  candidateFailed: 0,
  planned: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  skipped: 0,
  notRun: 0,
  effects: 0,
  artifactDrift: 0,
  liveDrift: 0,
  refusals: 0,
});

const report = (): UpdateReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.update',
  command: 'update',
  mode: 'check',
  state: 'current',
  artifactPair: {
    manifestPath: '/project/skillsmith.json',
    lockPath: '/project/skillsmith.lock',
    lockSource: 'sibling',
    selectionSource: 'discovered-project',
  },
  options: { all: false, ref: null, pin: false, strict: false, continueOnError: false },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'filter-noop',
    targets: [],
    skills: [],
    tools: [],
    groupIds: [],
  },
  candidates: [],
  operations: [],
  checks: [],
  diagnostics: [],
  approval: { required: false, outcome: 'not-required' },
  groups: [],
  effects: [],
  summary: emptySummary(),
});

describe('update@1 report codec', () => {
  test('round-trips the strict filter-noop projection', () => {
    expect(updateV1Codec.descriptor).toMatchObject({
      id: 'update',
      version: 1,
      wireKind: 'skillsmith.update',
      unknownFields: 'reject-recursive',
    });
    const encoded = updateV1Codec.encode(report());
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(encoded.value.endsWith('\n')).toBeTrue();
    expect(updateV1Codec.decode(encoded.value)).toEqual({ ok: true, value: report() });
  });

  test('rejects recursive unknown fields, unsafe strings, and inconsistent summaries', () => {
    expect(
      updateV1Codec.validate({ ...report(), sourceUrl: 'https://example.test/repo' }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      updateV1Codec.validate({
        ...report(),
        approval: { ...report().approval, internal: true },
      }),
    ).toMatchObject({ ok: false });
    expect(
      updateV1Codec.validate({
        ...report(),
        artifactPair: {
          ...report().artifactPair,
          manifestPath: '/project/skillsmith.json?access_token=update-secret-canary',
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      updateV1Codec.validate({
        ...report(),
        summary: { ...report().summary, available: 1 },
      }),
    ).toMatchObject({ ok: false });
  });

  test('enforces exact selection, candidate, group, and approval identity', () => {
    const groupId = 'group:v1:factor-scan';
    const changing: UpdateReportV1Dto = {
      ...report(),
      mode: 'dry-run',
      state: 'ready',
      selection: {
        selectionSource: 'explicit-targets',
        selectionOutcome: 'selected',
        targets: ['factor-scan'],
        skills: ['factor-scan'],
        tools: ['codex'],
        groupIds: [groupId],
      },
      candidates: [
        {
          groupId,
          skill: 'factor-scan',
          current: {
            requestedRef: null,
            kind: 'default',
            resolvedSha: 'a'.repeat(40),
            contentHash: `sha256:${'b'.repeat(64)}`,
          },
          proposed: {
            requestedRef: null,
            kind: 'default',
            resolvedSha: 'c'.repeat(40),
            contentHash: `sha256:${'d'.repeat(64)}`,
          },
          transition: 'preserve',
          outcome: 'available',
          failure: null,
        },
      ],
      groups: [
        {
          groupId,
          skill: 'factor-scan',
          tools: ['codex'],
          verification: [{ tool: 'codex', mode: 'static+deep', gate: 'passed' }],
          action: 'update',
          outcome: 'planned',
          skipReason: null,
          failure: null,
          drift: { artifact: true, live: true },
        },
      ],
      summary: {
        ...emptySummary(),
        groups: 1,
        candidates: 1,
        available: 1,
        planned: 1,
        artifactDrift: 1,
        liveDrift: 1,
      },
    };
    expect(updateV1Codec.validate(changing)).toMatchObject({ ok: true });
    expect(
      updateV1Codec.validate({
        ...changing,
        selection: { ...changing.selection, groupIds: ['group:v1:wrong'] },
      }),
    ).toMatchObject({ ok: false });
    expect(
      updateV1Codec.validate({
        ...changing,
        mode: 'execute',
        approval: { required: false, outcome: 'approved' },
      }),
    ).toMatchObject({ ok: true });
    expect(
      updateV1Codec.validate({
        ...changing,
        mode: 'execute',
        approval: { required: false, outcome: 'pending' },
      }),
    ).toMatchObject({ ok: false });
  });
});
