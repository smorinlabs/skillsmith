import { describe, expect, test } from 'bun:test';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/index.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../packages/core/src/application/current-services.ts';
import {
  UPDATE_SECRET_CANARIES,
  createUpdateFleet,
  destroyUpdateFleet,
  runUpdateCli,
  snapshotUpdateState,
} from '../fixtures/p5-update/fleet.ts';

describe('EWP-P5-TS02', () => {
  test('EWP-P5-TS02 — update check, dry-run, and execution share one matrix', async () => {
    const fleet = await createUpdateFleet();
    try {
      const before = await snapshotUpdateState(fleet);
      expect(
        {
          commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith update'),
          applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'update'),
        },
        'update CommandSpec/application service boundary is absent',
      ).toEqual({ commandSpec: true, applicationService: true });
      const product = await runUpdateCli(fleet, ['update', '--all', '--check', '--json']);
      expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(7);
      const report: unknown = JSON.parse(product.stdout);
      expect(report).toMatchObject({
        schemaVersion: 1,
        kind: 'skillsmith.update',
        command: 'update',
        mode: 'check',
        selection: { selectionSource: 'explicit-all' },
      });
      expect(await snapshotUpdateState(fleet)).toEqual(before);
      for (const canary of UPDATE_SECRET_CANARIES) {
        expect(`${product.stdout}${product.stderr}`).not.toContain(canary);
      }
    } finally {
      await destroyUpdateFleet(fleet);
    }
  });
});
