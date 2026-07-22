import { describe, expect, test } from 'bun:test';
import { type UndoReportV1Dto, undoV1Codec } from '@skillsmith/core/contracts/v1';
import { Command } from 'commander';
import { currentWireCodecs } from '../../src/contracts/wire-contracts.ts';
import { renderUndoHuman } from '../../src/output/undo-human.ts';
import { renderUndoJson } from '../../src/output/undo-json.ts';
import type { RuntimeOutcome } from '../../src/runtime/adapter.ts';
import { createCurrentRendererRegistry } from '../../src/runtime/current-renderers.ts';

const report: UndoReportV1Dto = {
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
    tools: ['codex'],
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
  summary: {
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
  },
};

describe('undo output', () => {
  test('human and JSON expose the same exact selection and lifecycle facts', () => {
    const human = renderUndoHuman(report);
    expect(human).toContain('Undo: dry-run (ready)');
    expect(human).toContain('explicit-all/filter-zero');
    expect(human).toContain('all=true');
    expect(human).toContain('scopes=project');
    expect(JSON.parse(renderUndoJson(report, undoV1Codec))).toEqual(report);
  });

  test('both renderers fail closed on private or credential material', () => {
    const unsafe = {
      ...report,
      project: { ...report.project, root: '/fixture?access_token=undo-output-secret' },
    };
    expect(() => renderUndoHuman(unsafe)).toThrow();
    expect(() => renderUndoJson(unsafe, undoV1Codec)).toThrow();
  });

  test('binds the current command to strict undo@1 with terminal LF', () => {
    expect(currentWireCodecs.undo.descriptor).toEqual(undoV1Codec.descriptor);
    expect(renderUndoJson(report, currentWireCodecs.undo).endsWith('\n')).toBeTrue();
  });

  test('routes the current runtime through the same strict human and JSON boundary', () => {
    const renderer = createCurrentRendererRegistry(new Command()).undo;
    if (renderer === undefined) throw new Error('missing current undo renderer');
    const outcome: RuntimeOutcome = {
      report: { result: report },
      diagnostics: [],
      exitClass: 'success',
      mutation: { kind: 'preview', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
    expect(renderer.human(outcome)).toEqual({ stdout: renderUndoHuman(report) });
    expect(renderer.json(outcome)).toEqual({
      stdout: renderUndoJson(report, currentWireCodecs.undo),
    });
  });
});
