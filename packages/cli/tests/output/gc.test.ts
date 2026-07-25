import { describe, expect, test } from 'bun:test';
import { type GcReportV1Dto, gcV1Codec } from '@skillsmith/core/contracts/v1';
import { Command } from 'commander';
import { currentWireCodecs } from '../../src/contracts/wire-contracts.ts';
import { renderGcHuman } from '../../src/output/gc-human.ts';
import { renderGcJson } from '../../src/output/gc-json.ts';
import type { RuntimeOutcome } from '../../src/runtime/adapter.ts';
import { createCurrentRendererRegistry } from '../../src/runtime/current-renderers.ts';

const PLAN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OBJECT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ACTION_ID = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const report: GcReportV1Dto = {
  schemaVersion: 1,
  kind: 'skillsmith.gc',
  command: 'gc',
  mode: 'execute',
  state: 'completed',
  planId: PLAN_ID,
  selectionSource: 'bounded-default',
  project: {
    effectiveCwd: '/fixture/project',
    root: '/fixture/project',
    identity: '/fixture/project',
  },
  migration: { sourceVersion: 2, action: 'none', outcome: 'not-required' },
  olderThan: { input: '30d', milliseconds: 2_592_000_000, cutoff: 1_750_000_000_000 },
  approval: { required: true, outcome: 'approved' },
  recovery: { state: 'completed', phase: 'complete' },
  projects: [
    {
      root: '/fixture/stale-project',
      current: false,
      existing: false,
      registered: true,
      requested: true,
      action: 'forget-project',
      outcome: 'forgotten',
      reason: null,
    },
  ],
  objects: [
    {
      id: OBJECT_ID,
      kind: 'store',
      path: '/fixture/store/objects/bb/object',
      contentHash: `sha256:${OBJECT_ID}`,
      modifiedAt: 1_740_000_000_000,
      logicalBytes: 128,
      protection: [],
      ageEligible: true,
      outcome: 'reclaimed',
      reason: null,
    },
  ],
  actions: [
    {
      actionId: ACTION_ID,
      kind: 'reclaim-store',
      target: '/fixture/store/objects/bb/object',
      logicalBytes: 128,
      dependencyIds: [],
      outcome: 'planned',
      reason: null,
    },
  ],
  results: [
    {
      actionId: ACTION_ID,
      kind: 'reclaim-store',
      target: '/fixture/store/objects/bb/object',
      logicalBytes: 128,
      dependencyIds: [],
      outcome: 'succeeded',
      reason: null,
    },
  ],
  checks: [{ code: 'inventory-safe', outcome: 'passed', message: 'inventory is owner-safe' }],
  diagnostics: [
    { code: 'gc-reclaimed', message: 'one unreachable object was reclaimed', path: null },
  ],
  summary: {
    observedItems: 1,
    protectedItems: 0,
    ageFilteredItems: 0,
    eligibleItems: 1,
    eligibleBytes: 128,
    forgottenProjects: 1,
    alreadyAbsentItems: 0,
    reclaimedItems: 1,
    reclaimedBytes: 128,
    refusedItems: 0,
    failedItems: 0,
  },
};

describe('gc output', () => {
  test('human and JSON render the same strict public GC facts', () => {
    const human = renderGcHuman(report);
    expect(human).toContain('GC: execute (completed)');
    expect(human).toContain(
      'Project: cwd=/fixture/project; root=/fixture/project; identity=/fixture/project',
    );
    expect(human).toContain(`Plan: ${PLAN_ID}; approval=approved; recovery=completed`);
    expect(human).toContain("project: { action: 'forget-project'");
    expect(human).toContain(`object: { ageEligible: true, contentHash: 'sha256:${OBJECT_ID}'`);
    expect(human).toContain(`action: { actionId: '${ACTION_ID}'`);
    expect(human).toContain(`result: { actionId: '${ACTION_ID}'`);
    expect(human).toContain("diagnostic: { code: 'gc-reclaimed'");
    expect(human).toContain('1 observed, 0 protected, 0 age-filtered, 1 eligible');

    const json = renderGcJson(report, gcV1Codec);
    expect(json.endsWith('\n')).toBeTrue();
    expect(JSON.parse(json)).toEqual(report);
  });

  test('both renderers fail closed on invalid or credential-bearing material', () => {
    const invalid = { ...report, state: 'private' };
    const credentialBearing = {
      ...report,
      project: { ...report.project, root: '/fixture/project?access_token=gc-output-secret' },
    };
    expect(() => renderGcHuman(invalid as GcReportV1Dto)).toThrow();
    expect(() => renderGcJson(invalid as GcReportV1Dto, gcV1Codec)).toThrow();
    expect(() => renderGcHuman(credentialBearing)).toThrow();
    expect(() => renderGcJson(credentialBearing, gcV1Codec)).toThrow();
  });

  test('current runtime binds GC to the canonical strict codec and renderers', () => {
    expect(currentWireCodecs.gc.descriptor).toEqual(gcV1Codec.descriptor);
    const renderer = createCurrentRendererRegistry(new Command()).gc;
    if (renderer === undefined) throw new Error('missing current GC renderer');
    const outcome: RuntimeOutcome = {
      report: { result: report },
      diagnostics: [],
      exitClass: 'success',
      mutation: { kind: 'applied', planned: 1, changed: 2, unchanged: 0, failed: 0 },
      deprecations: [],
    };
    expect(renderer.human(outcome)).toEqual({ stdout: renderGcHuman(report) });
    expect(renderer.json(outcome)).toEqual({
      stdout: renderGcJson(report, currentWireCodecs.gc),
    });
  });
});
