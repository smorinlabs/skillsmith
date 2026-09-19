import { describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import {
  createRemoteApplyFixture,
  destroyRemoteApplyFixture,
  jsonApplyReport,
  runApplyCli,
} from '../fixtures/p4b-apply/cases.ts';
import {
  SUPPORTED_REPRODUCTION_PLATFORMS,
  contentHashAt,
  createIncompleteWholePairFixture,
  destroyIncompleteWholePairFixture,
  provisionDetectedCodex,
  runBoundedLockedPreview,
} from '../fixtures/p4b-lock-policy/cases.ts';

describe('EWP-WF03', () => {
  test('reproducible bootstrap requires one complete frozen pair on supported platforms', async () => {
    expect(SUPPORTED_REPRODUCTION_PLATFORMS).toEqual(['darwin', 'linux']);
    const clone = await createIncompleteWholePairFixture();
    try {
      const product = await runBoundedLockedPreview(clone, 'apply');
      expect(product.exitCode, product.stdout).toBe(3);
      expect(JSON.parse(product.stdout)).toMatchObject({
        code: 'plan-locked-state',
        exitCode: 3,
      });
    } finally {
      await destroyIncompleteWholePairFixture(clone);
    }
  });

  test('doctor, init, pinned install, locked apply, and clean-clone hashes form one reproducible chain', async () => {
    const selected = await provisionDetectedCodex(await createRemoteApplyFixture());
    try {
      await Promise.all([rm(selected.manifest), rm(selected.lock)]);
      const doctor = jsonApplyReport(
        await runApplyCli(selected, ['doctor', '--fix', '--dry-run', '--json']),
        0,
        'doctor fix preview',
      );
      expect(doctor).toMatchObject({ schemaVersion: 2, repair: { mode: 'preview' } });
      expect(await Bun.file(selected.manifest).exists()).toBeFalse();

      const initArgs = ['init', '--file', selected.manifest, '--tool', 'codex', '--json'] as const;
      jsonApplyReport(
        await runApplyCli(selected, [...initArgs.slice(0, -1), '--dry-run', '--json']),
        0,
        'init preview',
      );
      expect(await Bun.file(selected.manifest).exists()).toBeFalse();
      jsonApplyReport(await runApplyCli(selected, initArgs), 0, 'init execution');

      const install = jsonApplyReport(
        await runApplyCli(selected, [
          'install',
          selected.skill.source,
          '--tool',
          'codex',
          '--user',
          '--file',
          selected.manifest,
          '--lockfile',
          selected.lock,
          '--pin',
          '--direct',
          '--no-verify',
          '--json',
        ]),
        0,
        'pinned install',
      );
      expect(install).toMatchObject({ kind: 'skillsmith.install' });
      expect(await readFile(selected.manifest, 'utf8')).toContain('name = "lint"');

      const plan = jsonApplyReport(
        await runApplyCli(selected, [
          'plan',
          '--file',
          selected.manifest,
          '--lockfile',
          selected.lock,
          '--locked',
          '--json',
        ]),
        0,
        'locked bootstrap plan',
      );
      expect(plan).toMatchObject({ options: { locked: true } });
      const apply = jsonApplyReport(
        await runApplyCli(selected, [
          'apply',
          '--file',
          selected.manifest,
          '--lockfile',
          selected.lock,
          '--locked',
          '--yes',
          '--json',
        ]),
        0,
        'locked bootstrap apply',
      );
      expect(apply).toMatchObject({ state: 'completed', options: { locked: true } });

      for (const platform of SUPPORTED_REPRODUCTION_PLATFORMS) {
        const hash = await contentHashAt(selected.skill.livePath, platform);
        expect(hash, platform).toMatch(/^sha256:[0-9a-f]{64}$/u);
      }
    } finally {
      await destroyRemoteApplyFixture(selected);
    }
  }, 60_000);
});
