import { describe, expect, test } from 'bun:test';
import { type UpdateReportV1Dto, updateV1Codec } from '@skillsmith/core/contracts/v1';
import { Command } from 'commander';
import { currentWireCodecs } from '../../src/contracts/wire-contracts.ts';
import { renderUpdateHuman } from '../../src/output/update-human.ts';
import { renderUpdateJson } from '../../src/output/update-json.ts';
import type { RuntimeOutcome } from '../../src/runtime/adapter.ts';
import { createCurrentRendererRegistry } from '../../src/runtime/current-renderers.ts';

const report: UpdateReportV1Dto = {
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
  options: { all: false, ref: null, pin: false, strict: true, continueOnError: false },
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
  summary: {
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
  },
};

describe('update output', () => {
  test('human and JSON expose the same exact update facts', () => {
    const human = renderUpdateHuman(report);
    expect(human).toContain('Update: check (current)');
    expect(human).toContain('all=false ref=(none) pin=false strict=true continue-on-error=false');
    expect(human).toContain('bounded-default/filter-noop');
    expect(human).toContain('/project/skillsmith.json + /project/skillsmith.lock');
    expect(JSON.parse(renderUpdateJson(report, updateV1Codec))).toEqual(report);
  });

  test('both renderers fail closed on unvalidated private material', () => {
    const unsafe = {
      ...report,
      artifactPair: {
        ...report.artifactPair,
        manifestPath: '/project/skillsmith.json?access_token=update-output-secret',
      },
    };
    expect(() => renderUpdateHuman(unsafe)).toThrow();
    expect(() => renderUpdateJson(unsafe, updateV1Codec)).toThrow();
  });

  test('current runtime binds update to the strict mapped codec', () => {
    expect(currentWireCodecs.update.descriptor).toEqual(updateV1Codec.descriptor);
    const renderer = createCurrentRendererRegistry(new Command()).update;
    if (renderer === undefined) throw new Error('missing current update renderer');
    const outcome: RuntimeOutcome = {
      report: { result: report },
      diagnostics: [],
      exitClass: 'success',
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
    expect(renderer.human(outcome)).toEqual({ stdout: renderUpdateHuman(report) });
    expect(renderer.json(outcome)).toEqual({
      stdout: renderUpdateJson(report, currentWireCodecs.update),
    });
  });
});
