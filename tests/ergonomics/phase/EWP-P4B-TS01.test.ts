import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  OPERATION_MATRIX,
  createPlanFixture,
  destroyPlanFixture,
  jsonReport,
  runPlanCli,
} from '../fixtures/p4b-plan/cases.ts';
import { SYNTHETIC_OPERATION_ROWS } from '../fixtures/p4b-plan/goldens.ts';

setDefaultTimeout(60_000);

type UnknownRecord = Record<string, unknown>;

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is UnknownRecord =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

describe('EWP-P4B-TS01', () => {
  test('planner operation matrix and deterministic byte snapshots share one report model', async () => {
    expect(OPERATION_MATRIX).toHaveLength(9);
    expect(SYNTHETIC_OPERATION_ROWS.map((row) => row.kind)).toEqual([
      'install',
      'update',
      'remove',
      'move-scope',
      'adapt',
      'migrate-project-config',
      'migrate-ledger',
    ]);

    const fixture = await createPlanFixture([
      { name: 'zulu', tool: 'codex' },
      { name: 'alpha', tool: 'claude-code' },
    ]);
    try {
      const args = ['plan', '--file', fixture.manifest, '--locked', '--json'] as const;
      const first = await runPlanCli(fixture, args);
      const second = await runPlanCli(fixture, args);
      expect(first.exitCode).toBe(0);
      expect(second).toEqual(first);
      const report = jsonReport(first, 0, 'phase planner matrix');
      const operations = records(report.operations);
      expect(operations.map((row) => row.kind)).toEqual(['install', 'install']);
      expect(operations.map((row) => row.skill)).toEqual(['alpha', 'zulu']);
      expect(operations.map((row) => row.operationId)).toEqual(
        operations.map((row) => row.operationId).toSorted(),
      );

      const renderer = await import('../../../packages/cli/src/output/plan-human.ts').catch(
        () => null,
      );
      expect(
        renderer,
        'plan renderer must accept canonical synthetic operation fixtures',
      ).not.toBeNull();
      if (renderer === null) return;
      expect(typeof renderer.renderPlanOperationHuman).toBe('function');
      for (const row of SYNTHETIC_OPERATION_ROWS) {
        expect(renderer.renderPlanOperationHuman(row as never)).toContain(row.kind);
      }
    } finally {
      await destroyPlanFixture(fixture);
    }
  });
});
