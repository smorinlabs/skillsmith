import { describe, expect, test } from 'bun:test';
import { type SyncReportV1Dto, syncV1Codec } from '@skillsmith/core/contracts/v1';
import { Command } from 'commander';
import { currentWireCodecs } from '../../src/contracts/wire-contracts.ts';
import { renderSyncHuman } from '../../src/output/sync-human.ts';
import { renderSyncJson } from '../../src/output/sync-json.ts';
import type { RuntimeOutcome } from '../../src/runtime/adapter.ts';
import { createCurrentRendererRegistry } from '../../src/runtime/current-renderers.ts';

const report: SyncReportV1Dto = {
  schemaVersion: 1,
  kind: 'skillsmith.sync',
  command: 'sync',
  mode: 'dry-run',
  state: 'ready',
  endpoints: {
    from: { kind: 'user', scope: 'user', selectedInput: 'user', projectRoot: null },
    to: { kind: 'path', scope: 'project', selectedInput: './b', projectRoot: '/b' },
  },
  artifactPair: null,
  options: { force: true, delete: true, save: false, dryRun: true, continueOnError: true },
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
};

describe('sync output', () => {
  test('human and JSON expose the same exact option and selection facts', () => {
    const human = renderSyncHuman(report);
    expect(human).toContain(
      'force=true delete=true save=false dry-run=true continue-on-error=true',
    );
    expect(human).toContain('bounded-default/filter-noop');
    expect(JSON.parse(renderSyncJson(report, syncV1Codec))).toEqual(report);
  });

  test('current runtime binds sync to the strict mapped codec', () => {
    expect(currentWireCodecs.sync.descriptor).toEqual(syncV1Codec.descriptor);
    const renderer = createCurrentRendererRegistry(new Command()).sync;
    if (renderer === undefined) throw new Error('missing current sync renderer');
    const outcome: RuntimeOutcome = {
      report: { result: report },
      diagnostics: [],
      exitClass: 'success',
      mutation: { kind: 'preview', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
    expect(renderer.human(outcome)).toEqual({ stdout: renderSyncHuman(report) });
    expect(renderer.json(outcome)).toBe(renderSyncJson(report, currentWireCodecs.sync));
  });
});
