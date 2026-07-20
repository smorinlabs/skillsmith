import { describe, expect, test } from 'bun:test';
import {
  collectResiduePaths,
  createIncompleteWholePairFixture,
  destroyCrossMachineFixture,
  destroyIncompleteWholePairFixture,
  destroyPoisonedNoSaveExport,
  runBoundedLockedPreview,
  runCrossMachineReproduction,
  runPoisonedNoSaveExport,
} from '../fixtures/p4b-lock-policy/cases.ts';

describe('EWP-WF04', () => {
  test('existing-fleet restore refuses an incomplete explicit pair even when a filter is satisfiable', async () => {
    const restored = await createIncompleteWholePairFixture();
    try {
      const product = await runBoundedLockedPreview(restored, 'plan');
      expect(product.exitCode, product.stdout).toBe(3);
      expect(JSON.parse(product.stdout)).toMatchObject({
        kind: 'error',
        code: 'plan-locked-state',
      });
    } finally {
      await destroyIncompleteWholePairFixture(restored);
    }
  });

  test('explicit non-sibling export restores without a ledger and omission selects the sibling lock', async () => {
    const reproduction = await runCrossMachineReproduction();
    try {
      const { fixture, reports } = reproduction;
      expect(fixture.exported.lock).not.toBe(
        fixture.exported.manifest.replace(/\.toml$/u, '.lock'),
      );
      expect(reproduction.exportPreviewWasNonMutating).toBeTrue();
      expect(reports.exportPreview).toMatchObject({
        kind: 'skillsmith.export',
        dryRun: true,
      });
      expect(reports.exportApply).toMatchObject({
        kind: 'skillsmith.export',
        dryRun: false,
      });
      expect(reports.machineBPlan).toMatchObject({
        artifactPair: {
          manifestPath: fixture.copied.manifest,
          lockPath: fixture.copied.lock,
          lockSource: 'explicit',
        },
      });
      expect(reports.machineBSiblingPlan).toMatchObject({
        artifactPair: {
          manifestPath: fixture.copied.manifest,
          lockPath: fixture.copied.siblingLock,
          lockSource: 'sibling',
        },
        summary: { operations: 0, drift: 0 },
      });
      expect(reports.machineBExport).toMatchObject({
        kind: 'skillsmith.export',
        results: [{ name: fixture.machineA.skill.name, action: 'add', reason: null }],
        summary: { portable: 1, skipped: 0, changed: 1 },
      });
      expect(reproduction.machineBLedgerWasAbsent).toBeTrue();
      expect(reproduction.contentHashes.machineB).toBe(reproduction.contentHashes.machineA);
      expect(await collectResiduePaths(fixture.machineA.root)).toEqual([]);
      expect(await collectResiduePaths(fixture.machineB.root)).toEqual([]);
    } finally {
      await destroyCrossMachineFixture(reproduction.fixture);
    }
  }, 60_000);

  test('managed export rejects a poisoned no-save store instead of signing its live bytes', async () => {
    const selected = await runPoisonedNoSaveExport();
    try {
      expect(selected.reports.install).toMatchObject({ kind: 'skillsmith.install' });
      expect(selected.reports.export).toMatchObject({
        kind: 'skillsmith.export',
        results: [{ name: 'lint', action: 'skipped', reason: 'invalid-content' }],
        summary: { portable: 0, skipped: 1, changed: 0 },
      });
      expect(await Bun.file(selected.paths.manifest).exists()).toBeFalse();
      expect(await Bun.file(selected.paths.lock).exists()).toBeFalse();
      expect(await collectResiduePaths(selected.fixture.root)).toEqual([]);
    } finally {
      await destroyPoisonedNoSaveExport(selected);
    }
  }, 60_000);
});
