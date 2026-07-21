import { describe, expect, test } from 'bun:test';
import {
  SYNC_SECRET_CANARIES,
  type SyncFleet,
  createSyncFleet,
  destroySyncFleet,
  readSkillBytes,
  runSyncCli,
} from '../fixtures/p5-sync/fleet.ts';

const successfulSync = async (
  fleet: SyncFleet,
  args: readonly string[],
): Promise<Record<string, unknown>> => {
  const product = await runSyncCli(fleet, [...args, '--json']);
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(0);
  const report: unknown = JSON.parse(product.stdout);
  expect(report).toMatchObject({ schemaVersion: 1, kind: 'skillsmith.sync', command: 'sync' });
  for (const canary of SYNC_SECRET_CANARIES) {
    expect(`${product.stdout}${product.stderr}`).not.toContain(canary);
  }
  return report as Record<string, unknown>;
};

describe('EWP-WF10', () => {
  test('EWP-WF10 — direct sync preview, execution, save, force, delete, and rerun', async () => {
    const fleet = await createSyncFleet();
    try {
      const userLintBefore = await readSkillBytes(fleet.skills.userLint);
      const userReviewBefore = await readSkillBytes(fleet.skills.userReview);

      const preview = await successfulSync(fleet, [
        'sync',
        '--from',
        'user',
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
        '--dry-run',
      ]);
      expect(preview).toMatchObject({
        mode: 'dry-run',
        selection: { selectionSource: 'bounded-default' },
      });

      await successfulSync(fleet, [
        'sync',
        'lint',
        '--from',
        'user',
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
      ]);
      await successfulSync(fleet, [
        'sync',
        '--from',
        fleet.projects.a,
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
        '--save',
        '--file',
        fleet.artifacts.explicitManifest,
        '--lockfile',
        fleet.artifacts.explicitLock,
        '--yes',
      ]);
      await successfulSync(fleet, [
        'sync',
        'review',
        '--from',
        'user',
        '--to',
        fleet.projects.b,
        '--tool',
        'codex',
        '--force',
        '--delete',
        '--dry-run',
      ]);
      await successfulSync(fleet, [
        'sync',
        '--from',
        fleet.projects.a,
        '--to',
        fleet.projects.b,
        '--tool',
        'codex',
        '--delete',
        '--continue-on-error',
        '--dry-run',
      ]);
      const rerun = await successfulSync(fleet, [
        'sync',
        'lint',
        '--from',
        'user',
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
        '--dry-run',
      ]);
      expect(rerun).toMatchObject({ summary: { changed: 0 } });

      expect(await readSkillBytes(fleet.skills.userLint)).toEqual(userLintBefore);
      expect(await readSkillBytes(fleet.skills.userReview)).toEqual(userReviewBefore);
    } finally {
      await destroySyncFleet(fleet);
    }
  });
});
