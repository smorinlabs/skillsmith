import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  SYNC_SECRET_CANARIES,
  createSyncFleet,
  destroySyncFleet,
  readSkillBytes,
  runSyncCli,
} from '../fixtures/p5-sync/fleet.ts';

describe('EWP-P5-TS01', () => {
  test('EWP-P5-TS01 — direct endpoint matrix is bounded and source-read-only', async () => {
    const fleet = await createSyncFleet();
    try {
      const sourceBefore = await readSkillBytes(fleet.skills.projectALint);
      expect(
        await Bun.file(join(fleet.projects.c, '.agents', 'skills', 'lint')).exists(),
      ).toBeFalse();
      const product = await runSyncCli(fleet, [
        'sync',
        'lint',
        '--from',
        fleet.projects.a,
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
        '--dry-run',
        '--json',
      ]);
      expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(0);
      const report: unknown = JSON.parse(product.stdout);
      expect(report).toMatchObject({
        schemaVersion: 1,
        kind: 'skillsmith.sync',
        command: 'sync',
        mode: 'dry-run',
        selection: { selectionSource: 'explicit-targets' },
      });
      expect(await readSkillBytes(fleet.skills.projectALint)).toEqual(sourceBefore);
      for (const canary of SYNC_SECRET_CANARIES) {
        expect(`${product.stdout}${product.stderr}`).not.toContain(canary);
      }
    } finally {
      await destroySyncFleet(fleet);
    }
  });
});
