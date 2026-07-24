import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  createBatchFleet,
  createSyncBatchFleet,
  destroyBatchFleet,
  destroySyncBatchFleet,
  parseBatchJson,
  runBatchCli,
  runBatchCliWithSignal,
  runSyncBatchCli,
  snapshotBatchState,
  snapshotSyncBatchState,
} from '../fixtures/p5-batch/fleet.ts';

setDefaultTimeout(90_000);

describe('EWP-P5-TS05', () => {
  test('EWP-P5-TS05 — update and undo share bulk approval and scheduling truth', async () => {
    const sync = await createSyncBatchFleet();
    try {
      const beforeSync = await snapshotSyncBatchState(sync);
      const syncArgs = [
        'sync',
        '--from',
        sync.projects.a,
        '--to',
        sync.projects.c,
        '--tool',
        'codex',
      ] as const;
      const syncFailFast = parseBatchJson(
        await runSyncBatchCli(sync, [...syncArgs, '--dry-run', '--json']),
      );
      const syncContinued = parseBatchJson(
        await runSyncBatchCli(sync, [...syncArgs, '--continue-on-error', '--dry-run', '--json']),
      );
      expect(syncFailFast).toMatchObject({
        mode: 'dry-run',
        options: { continueOnError: false },
        approval: { required: false, outcome: 'not-required' },
      });
      expect(syncContinued).toMatchObject({
        mode: 'dry-run',
        options: { continueOnError: true },
        approval: { required: false, outcome: 'not-required' },
      });
      expect(syncContinued.operations).toEqual(syncFailFast.operations);
      expect(await snapshotSyncBatchState(sync)).toEqual(beforeSync);
    } finally {
      await destroySyncBatchFleet(sync);
    }

    const cancelled = await createBatchFleet({ reviewMoving: true });
    try {
      const beforeCancellation = await snapshotBatchState(cancelled);
      const interrupted = await runBatchCliWithSignal(cancelled, [
        'update',
        '--all',
        '--yes',
        '--json',
      ]);
      expect(interrupted).toEqual({ exitCode: 130, stdout: '', stderr: '' });
      expect(await snapshotBatchState(cancelled)).toEqual(beforeCancellation);
    } finally {
      await destroyBatchFleet(cancelled);
    }

    const fleet = await createBatchFleet({ reviewMoving: true });
    try {
      const before = await snapshotBatchState(fleet);
      const refused = parseBatchJson(
        await runBatchCli(fleet, ['update', '--all', '--no-prompt', '--json']),
        2,
      );
      expect(refused).toMatchObject({
        kind: 'error',
        code: 'update-approval-required',
        exitCode: 2,
      });
      const failFast = parseBatchJson(
        await runBatchCli(fleet, ['update', '--all', '--dry-run', '--json']),
      );
      const continued = parseBatchJson(
        await runBatchCli(fleet, ['update', '--all', '--continue-on-error', '--dry-run', '--json']),
      );
      expect(failFast).toMatchObject({
        options: { continueOnError: false },
        approval: { required: false, outcome: 'not-required' },
      });
      expect(continued).toMatchObject({
        options: { continueOnError: true },
        approval: { required: false, outcome: 'not-required' },
      });
      expect(await snapshotBatchState(fleet)).toEqual(before);

      const updated = parseBatchJson(
        await runBatchCli(fleet, ['update', '--all', '--yes', '--json']),
      );
      expect(updated).toMatchObject({
        mode: 'execute',
        approval: { required: true, outcome: 'approved' },
        groups: [{ outcome: 'succeeded' }, { outcome: 'succeeded' }],
      });
      expect(
        parseBatchJson(await runBatchCli(fleet, ['update', '--all', '--yes', '--json'])),
      ).toMatchObject({ state: 'current', summary: { available: 0, failed: 0 } });
      const undo = parseBatchJson(
        await runBatchCli(fleet, ['undo', '--all', '--project', '--dry-run', '--json']),
      );
      expect(undo).toMatchObject({
        kind: 'skillsmith.undo',
        mode: 'dry-run',
        selection: { batchPolicy: 'fail-fast' },
        approval: { required: false, outcome: 'not-required' },
        groups: [{ outcome: 'planned' }],
      });
    } finally {
      await destroyBatchFleet(fleet);
    }
  });
});
