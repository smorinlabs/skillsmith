import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  APPLY_EQUIVALENCE_VIEWS,
  createApplyFixture,
  createRemoteApplyFixture,
  destroyApplyFixture,
  destroyRemoteApplyFixture,
  fileSnapshot,
  jsonApplyReport,
  runApplyCli,
  snapshotApplyState,
} from '../fixtures/p4b-apply/cases.ts';

setDefaultTimeout(60_000);

type UnknownRecord = Record<string, unknown>;

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is UnknownRecord =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

const exactPreparedView = (report: UnknownRecord) => ({
  artifactPair: report.artifactPair,
  operations: report.operations,
  checks: report.checks,
  diagnostics: report.diagnostics,
});

describe('EWP-P4B-TS02', () => {
  test('plan, check, apply dry-run, and apply check expose one immutable operation/report product', async () => {
    expect(APPLY_EQUIVALENCE_VIEWS).toEqual(['plan', 'plan-check', 'apply-dry-run', 'apply-check']);
    const fixture = await createApplyFixture([{ name: 'alpha' }]);
    try {
      const before = await snapshotApplyState(fixture);
      const shared = ['--file', fixture.manifest, '--locked', '--json'] as const;
      const plan = jsonApplyReport(await runApplyCli(fixture, ['plan', ...shared]), 0, 'plan view');
      const planCheck = jsonApplyReport(
        await runApplyCli(fixture, ['plan', '--check', ...shared]),
        7,
        'plan check view',
      );
      const applyDryRun = jsonApplyReport(
        await runApplyCli(fixture, ['apply', '--dry-run', ...shared]),
        0,
        'apply dry-run view',
      );
      const applyCheck = jsonApplyReport(
        await runApplyCli(fixture, ['apply', '--check', ...shared]),
        7,
        'apply check view',
      );

      const expected = exactPreparedView(plan);
      expect(records(expected.operations)).not.toHaveLength(0);
      expect(exactPreparedView(planCheck)).toEqual(expected);
      expect(exactPreparedView(applyDryRun)).toEqual(expected);
      expect(exactPreparedView(applyCheck)).toEqual(expected);
      expect(await snapshotApplyState(fixture)).toEqual(before);
    } finally {
      await destroyApplyFixture(fixture);
    }
  });

  test('a hermetic real apply executes the displayed IDs once and converges to an empty second plan', async () => {
    const fixture = await createRemoteApplyFixture();
    try {
      const portableBytes = await fileSnapshot([fixture.manifest, fixture.lock]);
      const preview = jsonApplyReport(
        await runApplyCli(fixture, ['plan', '--locked', '--json']),
        0,
        'pre-apply plan',
      );
      const previewIds = records(preview.operations).map((operation) => operation.operationId);
      expect(previewIds).not.toHaveLength(0);

      const first = jsonApplyReport(
        await runApplyCli(fixture, ['apply', '--locked', '--yes', '--json']),
        0,
        'first apply',
      );
      expect(records(first.operations).map((operation) => operation.operationId)).toEqual(
        previewIds,
      );
      expect(await readFile(`${fixture.skill.livePath}/SKILL.md`, 'utf8')).toContain('name: lint');

      const second = jsonApplyReport(
        await runApplyCli(fixture, ['apply', '--locked', '--yes', '--json']),
        0,
        'idempotent second apply',
      );
      expect(records(second.operations)).toEqual([]);
      const finalPlan = jsonApplyReport(
        await runApplyCli(fixture, ['plan', '--locked', '--check', '--json']),
        0,
        'post-apply empty plan',
      );
      expect(records(finalPlan.operations)).toEqual([]);
      expect(await fileSnapshot([fixture.manifest, fixture.lock])).toEqual(portableBytes);
    } finally {
      await destroyRemoteApplyFixture(fixture);
    }
  });
});
