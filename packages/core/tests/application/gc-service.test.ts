import { afterEach, describe, expect, test } from 'bun:test';
import {
  type GcFleet,
  createGcFleet,
  destroyGcFleet,
} from '../../../../tests/ergonomics/fixtures/p5-gc/fleet.ts';
import {
  gcExecutionExitClass,
  gcMutationFor,
  runGcApplication,
} from '../../src/application/gc-service.ts';
import { type CurrentApplicationContext, NO_MUTATION } from '../../src/application/types.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import type { GcReportV1Dto } from '../../src/contracts/v1/gc.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const fleets: GcFleet[] = [];

afterEach(async () => {
  await Promise.all(fleets.splice(0).map(destroyGcFleet));
});

const id = (character: string): string => character.repeat(64);

const report = (input: {
  readonly reclaimedItems?: number;
  readonly forgottenProjects?: number;
  readonly alreadyAbsentItems?: number;
  readonly failedItems?: number;
  readonly migration?: 'not-required' | 'planned' | 'succeeded';
}): GcReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.gc',
  command: 'gc',
  mode: 'execute',
  state: input.failedItems === undefined ? 'completed' : 'partial',
  planId: id('a'),
  selectionSource: 'bounded-default',
  project: { effectiveCwd: '/workspace', root: '/workspace', identity: '/workspace' },
  migration: {
    sourceVersion: input.migration === undefined ? null : 1,
    action: input.migration === undefined ? 'none' : 'migrate-ledger',
    outcome: input.migration ?? 'not-required',
  },
  olderThan: null,
  approval: { required: true, outcome: 'approved' },
  recovery: {
    state: input.failedItems === undefined ? 'completed' : 'pending',
    phase: input.failedItems === undefined ? 'complete' : 'reclaiming',
  },
  projects: [],
  objects: [],
  actions: [
    {
      actionId: id('b'),
      kind: 'reclaim-store',
      target: '/store/fixture/repo@0123456789ab/review',
      logicalBytes: 10,
      dependencyIds: [],
      outcome: 'planned',
      reason: null,
    },
  ],
  results: [],
  checks: [],
  diagnostics: [],
  summary: {
    observedItems: 1,
    protectedItems: 0,
    ageFilteredItems: 0,
    eligibleItems: 1,
    eligibleBytes: 10,
    forgottenProjects: input.forgottenProjects ?? 0,
    alreadyAbsentItems: input.alreadyAbsentItems ?? 0,
    reclaimedItems: input.reclaimedItems ?? 0,
    reclaimedBytes: (input.reclaimedItems ?? 0) * 10,
    refusedItems: 0,
    failedItems: input.failedItems ?? 0,
  },
});

describe('GC application outcome accounting', () => {
  test('counts only durable migration, forget, and reclaim outcomes as changes', () => {
    expect(
      gcMutationFor(
        report({ reclaimedItems: 1, forgottenProjects: 1, migration: 'succeeded', failedItems: 1 }),
        false,
      ),
    ).toEqual({ kind: 'applied', planned: 1, changed: 3, unchanged: 0, failed: 1 });
    expect(gcMutationFor(report({ alreadyAbsentItems: 1 }), false)).toEqual({
      kind: 'none',
      planned: 1,
      changed: 0,
      unchanged: 1,
      failed: 0,
    });
    expect(gcMutationFor(report({ reclaimedItems: 1 }), true)).toMatchObject({
      kind: 'preview',
      changed: 0,
    });
  });

  test('keeps cancellation, permission, drift, and ordinary failure exit classes distinct', () => {
    const controller = new AbortController();
    controller.abort();
    expect(gcExecutionExitClass('GC execution was cancelled', controller.signal)).toBe('cancelled');
    expect(gcExecutionExitClass('GC permission denied during recovery publication')).toBe(
      'permission',
    );
    expect(gcExecutionExitClass('GC approved candidate changed after approval')).toBe('state');
    expect(gcExecutionExitClass('GC atomic cleanup failed')).toBe('failure');
  });

  test('rejects source URLs from dry-run and execute-no-op application reports', async () => {
    const selected = await createGcFleet();
    fleets.push(selected);
    const ports = await defaultRuntimePorts();
    const sourceUrl = 'git://fixture.invalid/org/project';
    const context: CurrentApplicationContext = {
      ports,
      artifactCoordinator: {} as CurrentApplicationContext['artifactCoordinator'],
      configuration: resolveRuntimeConfiguration(selected.env),
      invocationCwd: selected.cwd,
      globalOptions: {},
      projectContext: {
        invocationCwd: selected.cwd,
        effectiveCwd: selected.cwd,
        projectRoot: selected.cwd,
        projectIdentity: sourceUrl,
        projectKind: 'git',
        discoveredConfigPath: null,
        explicitConfigPath: null,
      },
      interaction: {
        mode: 'noninteractive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async () => ({ status: 'refused', reason: 'unused' }),
      },
      observation: {
        context: createOperationContext({
          command: 'skillsmith gc',
          workflow: 'gc-report-validation',
          clock: {
            wallNowIso: () => '2026-07-25T00:00:00.000Z',
            monotonicMilliseconds: () => 0,
          },
          id: { nextId: (purpose) => `gc-report-validation-${purpose}` },
        }),
        emitter: createObservationEmitter({
          observer: noopObserver,
          toolIds: ['claude-code', 'codex'],
        }),
      },
    };

    for (const dryRun of [true, false]) {
      const outcome = await runGcApplication(
        { arguments: [], options: { dryRun, yes: false, json: false, prompt: false } },
        context,
      );
      expect(outcome).toMatchObject({
        exitClass: 'failure',
        report: { result: null },
        diagnostics: [{ code: 'invalid-gc-report' }],
      });
      expect(outcome.mutation).toEqual(NO_MUTATION);
      expect(JSON.stringify(outcome)).not.toContain(sourceUrl);
    }
  });
});
