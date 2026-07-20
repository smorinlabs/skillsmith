import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  POLICY_SECRET_CANARIES,
  collectResiduePaths,
  createIncompleteWholePairFixture,
  destroyCrossMachineFixture,
  destroyIncompleteWholePairFixture,
  runBoundedLockedPreview,
  runCrossMachineReproduction,
} from '../fixtures/p4b-lock-policy/cases.ts';

describe('EWP-P4B-TS06', () => {
  test('a copied pair cannot claim locked reproduction when any manifest entry is absent', async () => {
    const machineB = await createIncompleteWholePairFixture();
    try {
      const product = await runBoundedLockedPreview(machineB, 'plan');
      expect(product.exitCode, product.stdout).toBe(3);
      expect(JSON.parse(product.stdout)).toMatchObject({
        kind: 'error',
        code: 'plan-locked-state',
        exitCode: 3,
      });
    } finally {
      await destroyIncompleteWholePairFixture(machineB);
    }
  });

  test('Machine A pair alone reproduces the same managed content on a clean Machine B', async () => {
    const reproduction = await runCrossMachineReproduction();
    try {
      const { fixture, reports } = reproduction;
      expect(fixture.machineA.root).not.toBe(fixture.machineB.root);
      expect(reproduction.machineBLedgerWasAbsent).toBeTrue();
      expect(reproduction.exportPreviewWasNonMutating).toBeTrue();
      expect(await readFile(fixture.copied.manifest)).toEqual(reproduction.pairBytes.manifest);
      expect(await readFile(fixture.copied.lock)).toEqual(reproduction.pairBytes.lock);
      expect(reproduction.contentHashes.machineB).toBe(reproduction.contentHashes.machineA);
      expect(reports.machineBPlan).toMatchObject({
        state: 'ready',
        options: { locked: true },
        summary: { operations: 1, operationKinds: { install: 1, 'write-lock': 0 } },
      });
      expect(reports.machineBApply).toMatchObject({
        state: 'completed',
        options: { locked: true },
        summary: { succeeded: 1, failed: 0 },
      });
      expect(reports.machineBConverged).toMatchObject({
        state: 'ready',
        summary: { operations: 0, drift: 0 },
      });
      expect(await Bun.file(fixture.machineB.ledger).exists()).toBeTrue();
      expect(await collectResiduePaths(fixture.machineB.root)).toEqual([]);

      const portable = `${new TextDecoder().decode(reproduction.pairBytes.manifest)}${new TextDecoder().decode(reproduction.pairBytes.lock)}`;
      expect(portable).not.toContain(fixture.machineA.root);
      expect(portable).not.toContain(fixture.machineB.root);
      const machineBOutput = JSON.stringify([
        reports.machineBPlan,
        reports.machineBApply,
        reports.machineBConverged,
      ]);
      expect(machineBOutput).not.toContain(fixture.machineA.root);
      for (const canary of POLICY_SECRET_CANARIES) {
        expect(`${portable}${machineBOutput}`).not.toContain(canary);
      }
    } finally {
      await destroyCrossMachineFixture(reproduction.fixture);
    }
  }, 60_000);
});
