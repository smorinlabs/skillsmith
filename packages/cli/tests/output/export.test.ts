import { describe, expect, test } from 'bun:test';
import type { ExportReport } from '@skillsmith/core';
import { exportV1Codec, toExportV1Dto } from '@skillsmith/core/contracts/v1';
import { renderExportHuman } from '../../src/output/export-human.ts';
import { ExportJsonSchema, renderExportJson } from '../../src/output/export-json.ts';

const report: ExportReport = Object.freeze({
  schemaVersion: 1,
  kind: 'skillsmith.export',
  reportVersion: 1,
  dryRun: true,
  requested: Object.freeze({
    tools: Object.freeze(['claude-code'] as const),
    explicitTools: true,
    scope: 'user',
    explicitScope: true,
    strict: false,
    force: false,
  }),
  artifactSelection: Object.freeze({
    outcome: 'selected',
    selectedBy: 'explicit-file',
    manifestPath: '/selected/skillsmith.toml',
    lockPath: '/selected/skillsmith.lock',
    lockSource: 'explicit',
  }),
  results: Object.freeze([
    Object.freeze({
      name: 'alpha',
      tools: Object.freeze(['claude-code'] as const),
      scope: 'user',
      classification: 'dirty-git',
      action: 'skipped',
      reason: 'dirty-git',
    }),
  ]),
  effects: Object.freeze([]),
  summary: Object.freeze({
    observed: 1,
    portable: 0,
    skipped: 1,
    conflicts: 0,
    changed: 0,
    unchanged: 0,
  }),
});

describe('export output', () => {
  test('JSON encodes once through the strict current export@1 codec', () => {
    const rendered = renderExportJson(report);
    expect(JSON.parse(rendered)).toEqual(toExportV1Dto(report));
    expect(ExportJsonSchema.parse(JSON.parse(rendered))).toEqual(toExportV1Dto(report));
    expect(exportV1Codec.validate({ ...JSON.parse(rendered), extra: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid-shape', path: ['extra'] },
    });
  });

  test('human output shows selected pair and every skipped result', () => {
    expect(renderExportHuman(report)).toBe(
      'would export /selected/skillsmith.toml + /selected/skillsmith.lock\n' +
        'skip alpha: dirty-git\n',
    );
  });

  test('refused reports print no success heading and keep every result visible', () => {
    expect(
      renderExportHuman({
        ...report,
        artifactSelection: { outcome: 'refused', reason: 'export-existing-conflict' },
      }),
    ).toBe('export refused: export-existing-conflict\nskip alpha: dirty-git\n');
  });
});
