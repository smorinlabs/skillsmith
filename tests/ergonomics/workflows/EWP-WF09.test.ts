import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  createBatchFleet,
  destroyBatchFleet,
  parseBatchJson,
  runBatchCli,
  snapshotBatchState,
} from '../fixtures/p5-batch/fleet.ts';

setDefaultTimeout(90_000);

describe('EWP-WF09', () => {
  test('EWP-WF09 — moving update previews, executes, and undoes to exact prior artifacts', async () => {
    const selection = await createBatchFleet();
    try {
      expect(parseBatchJson(await runBatchCli(selection, ['update', '--json']), 2)).toMatchObject({
        kind: 'error',
        code: 'update-options',
        exitCode: 2,
      });
      const pinned = parseBatchJson(
        await runBatchCli(selection, [
          'update',
          'factor-scan',
          '--ref',
          'v1.0.0',
          '--pin',
          '--check',
          '--json',
        ]),
        7,
      );
      expect(pinned).toMatchObject({
        state: 'changes-available',
        candidates: [{ skill: 'factor-scan', outcome: 'available', transition: 'pin' }],
      });
      const bulk = parseBatchJson(
        await runBatchCli(selection, ['update', '--all', '--dry-run', '--json']),
      );
      expect(bulk).toMatchObject({
        candidates: [
          { skill: 'factor-scan', outcome: 'available' },
          { skill: 'review', outcome: 'skipped-fixed' },
        ],
        summary: { available: 1, skippedFixed: 1 },
      });
    } finally {
      await destroyBatchFleet(selection);
    }

    const unavailable = await createBatchFleet({
      reviewMoving: true,
      reviewSourceMissing: true,
    });
    try {
      expect(
        parseBatchJson(
          await runBatchCli(unavailable, ['update', 'review', '--check', '--json']),
          5,
        ),
      ).toMatchObject({ kind: 'error', code: 'update-source-resolution', exitCode: 5 });
    } finally {
      await destroyBatchFleet(unavailable);
    }

    const fleet = await createBatchFleet();
    try {
      const before = await snapshotBatchState(fleet);
      const checked = parseBatchJson(
        await runBatchCli(fleet, ['update', 'factor-scan', '--check', '--json']),
        7,
      );
      const preview = parseBatchJson(
        await runBatchCli(fleet, ['update', 'factor-scan', '--dry-run', '--json']),
      );
      expect({
        artifactPair: preview.artifactPair,
        operations: preview.operations,
        checks: preview.checks,
      }).toEqual({
        artifactPair: checked.artifactPair,
        operations: checked.operations,
        checks: checked.checks,
      });
      expect(await snapshotBatchState(fleet)).toEqual(before);

      expect(
        parseBatchJson(await runBatchCli(fleet, ['update', 'factor-scan', '--json'])),
      ).toMatchObject({ state: 'completed', groups: [{ outcome: 'succeeded' }] });
      expect(
        parseBatchJson(
          await runBatchCli(fleet, ['undo', 'factor-scan', '--project', '--yes', '--json']),
        ),
      ).toMatchObject({
        kind: 'skillsmith.undo',
        summary: { failed: 0, succeeded: 1 },
      });
      const restored = await snapshotBatchState(fleet);
      expect({ ...restored, ledger: null }).toEqual({ ...before, ledger: null });
    } finally {
      await destroyBatchFleet(fleet);
    }
  });
});
