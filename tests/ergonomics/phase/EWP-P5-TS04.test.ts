import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/index.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../packages/core/src/application/current-services.ts';
import {
  createGcFleet,
  createStoreObject,
  destroyGcFleet,
  makeUnsafeHardLink,
  pinnedPair,
  runGcCli,
  snapshotGcState,
  writeLedgerV2,
} from '../fixtures/p5-gc/fleet.ts';

setDefaultTimeout(90_000);

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const requireGcBoundary = (): void => {
  expect(
    {
      commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith gc'),
      applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'gc'),
    },
    'public gc CommandSpec/application service boundary is absent',
  ).toEqual({ commandSpec: true, applicationService: true });
};

describe('EWP-P5-TS04', () => {
  test('EWP-P5-TS04 — reachability, retention, age, and logical-byte policy matrix', async () => {
    requireGcBoundary();
    const fleet = await createGcFleet();
    try {
      const protectedObject = await createStoreObject(fleet, {
        revision: '121212121212',
        skill: 'protected',
        files: { 'payload.txt': 'protected-by-ledger' },
        modifiedAt: new Date(Date.now() - 300_000),
      });
      const oldObject = await createStoreObject(fleet, {
        revision: '131313131313',
        skill: 'old',
        files: { 'payload.txt': 'eligible-old-object' },
        symlinks: { alias: 'payload.txt' },
        modifiedAt: new Date(Date.now() - 300_000),
      });
      const recentObject = await createStoreObject(fleet, {
        revision: '141414141414',
        skill: 'recent',
        files: { 'payload.txt': 'age-filtered-object' },
        modifiedAt: new Date(),
      });
      const pair = pinnedPair(
        join(fleet.projects.current, '.agents', 'skills', 'protected'),
        protectedObject,
      );
      await writeLedgerV2(fleet, {
        skills: { protected: { tools: { codex: pair } } },
      });

      const product = await runGcCli(fleet, ['gc', '--older-than', '2m', '--dry-run', '--json']);
      expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(0);
      const parsed: unknown = JSON.parse(product.stdout);
      expect(isRecord(parsed)).toBeTrue();
      if (!isRecord(parsed)) throw new Error('GC matrix report was not an object');
      expect(records(parsed.objects)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: protectedObject.path, outcome: 'protected' }),
          expect.objectContaining({
            path: oldObject.path,
            logicalBytes: oldObject.logicalBytes,
            outcome: 'eligible',
          }),
          expect.objectContaining({ path: recentObject.path, outcome: 'age-filtered' }),
        ]),
      );
      expect(parsed.summary).toMatchObject({
        observedItems: 3,
        protectedItems: 1,
        ageFilteredItems: 1,
        eligibleItems: 1,
        eligibleBytes: oldObject.logicalBytes,
      });

      await makeUnsafeHardLink(recentObject);
      const before = await snapshotGcState(fleet);
      const refused = await runGcCli(fleet, ['gc', '--yes', '--json']);
      expect(refused.exitCode).toBe(3);
      const refusedReport: unknown = JSON.parse(refused.stdout);
      expect(refusedReport).toMatchObject({
        state: 'refused',
        actions: [],
        summary: { eligibleItems: null, eligibleBytes: null },
      });
      expect(await snapshotGcState(fleet)).toEqual(before);
    } finally {
      await destroyGcFleet(fleet);
    }
  });
});
