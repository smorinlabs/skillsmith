import { describe, expect, test } from 'bun:test';
import { gcV1Codec } from '../../src/contracts/v1/gc.ts';
import type { GcReportV1Dto } from '../../src/contracts/v1/gc.ts';

const report = (): GcReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.gc',
  command: 'gc',
  mode: 'dry-run',
  state: 'no-op',
  planId: 'a'.repeat(64),
  selectionSource: 'bounded-default',
  project: { effectiveCwd: '/workspace', root: '/workspace', identity: 'workspace' },
  migration: { sourceVersion: 2, action: 'none', outcome: 'not-required' },
  olderThan: null,
  approval: { required: false, outcome: 'not-required' },
  recovery: { state: 'none', phase: null },
  projects: [],
  objects: [],
  actions: [],
  results: [],
  checks: [{ code: 'inventory-safe', outcome: 'passed', message: 'safe' }],
  diagnostics: [],
  summary: {
    observedItems: 0,
    protectedItems: 0,
    ageFilteredItems: 0,
    eligibleItems: 0,
    eligibleBytes: 0,
    forgottenProjects: 0,
    alreadyAbsentItems: 0,
    reclaimedItems: 0,
    reclaimedBytes: 0,
    refusedItems: 0,
    failedItems: 0,
  },
});

describe('gc@1 wire contract', () => {
  test('round-trips the strict canonical report', () => {
    const encoded = gcV1Codec.encode(report());
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(encoded.value).toEndWith('\n');
    const decoded = gcV1Codec.decode(encoded.value);
    expect(decoded).toEqual({ ok: true, value: report() });
  });

  test('rejects recursive unknown fields and invalid counts', () => {
    expect(gcV1Codec.validate({ ...report(), extra: true })).toMatchObject({ ok: false });
    expect(
      gcV1Codec.validate({
        ...report(),
        project: { ...report().project, extra: true },
      }),
    ).toMatchObject({ ok: false });
    expect(
      gcV1Codec.validate({
        ...report(),
        summary: { ...report().summary, observedItems: -1 },
      }),
    ).toMatchObject({ ok: false });
    expect(gcV1Codec.validate({ ...report(), planId: 'not-a-plan-id' })).toMatchObject({
      ok: false,
    });
    expect(
      gcV1Codec.validate({
        ...report(),
        recovery: { state: 'pending', phase: 'future-phase' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      gcV1Codec.validate({
        ...report(),
        objects: [
          {
            id: 'f'.repeat(64),
            kind: 'store',
            path: '/store/review',
            contentHash: 'not-a-digest',
            modifiedAt: 1,
            logicalBytes: 1,
            protection: [{ kind: 'future-protection', sourceId: 'source' }],
            ageEligible: true,
            outcome: 'eligible',
            reason: null,
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });
});
