import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/index.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../packages/core/src/application/current-services.ts';
import {
  createGcFleet,
  createStoreObject,
  destroyGcFleet,
  pathExists,
  pinnedPair,
  projectLedgerFields,
  readLedgerText,
  removeRetiredProject,
  runGcCli,
  snapshotGcState,
  writeLedgerV2,
} from '../fixtures/p5-gc/fleet.ts';

setDefaultTimeout(90_000);

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireGcBoundary = (): void => {
  expect(
    {
      commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith gc'),
      applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'gc'),
    },
    'public gc CommandSpec/application service boundary is absent',
  ).toEqual({ commandSpec: true, applicationService: true });
};

describe('EWP-WF12', () => {
  test('EWP-WF12 — retired project forget, reclaim, and repeated convergence workflow', async () => {
    requireGcBoundary();
    const fleet = await createGcFleet();
    try {
      const retiredObject = await createStoreObject(fleet, {
        namespace: 'local',
        repository: 'retired project',
        revision: 'content-151515151515',
        skill: 'review',
      });
      const stillReachable = await createStoreObject(fleet, {
        namespace: 'acme',
        repository: 'shared@skills',
        revision: '161616161616',
        skill: 'policy',
      });
      const retiredPair = pinnedPair(
        join(fleet.projects.retired, '.agents', 'skills', 'review'),
        retiredObject,
      );
      const retiredFields = projectLedgerFields(
        fleet.projects.retired,
        'review',
        'codex',
        retiredPair,
        retiredObject,
      );
      const livePair = pinnedPair(
        join(fleet.projects.current, '.claude', 'skills', 'policy'),
        stillReachable,
      );
      await writeLedgerV2(fleet, {
        skills: { policy: { tools: { 'claude-code': livePair } } },
        projects: retiredFields.projects,
        projectRegistrations: retiredFields.projectRegistrations,
      });

      await removeRetiredProject(fleet);
      const preview = await runGcCli(fleet, [
        'gc',
        '--forget-project',
        fleet.projects.retired,
        '--dry-run',
        '--json',
      ]);
      expect(preview.exitCode, `${preview.stderr}\n${preview.stdout}`).toBe(0);
      const previewReport: unknown = JSON.parse(preview.stdout);
      expect(previewReport).toMatchObject({
        mode: 'dry-run',
        projects: [
          expect.objectContaining({
            root: fleet.projects.retired,
            existing: false,
            action: 'forget-project',
          }),
        ],
        objects: expect.arrayContaining([
          expect.objectContaining({ path: retiredObject.path, outcome: 'eligible' }),
          expect.objectContaining({ path: stillReachable.path, outcome: 'protected' }),
        ]),
      });

      const execution = await runGcCli(fleet, [
        'gc',
        '--forget-project',
        fleet.projects.retired,
        '--yes',
        '--json',
      ]);
      expect(execution.exitCode, `${execution.stderr}\n${execution.stdout}`).toBe(0);
      const executionReport: unknown = JSON.parse(execution.stdout);
      expect(isRecord(executionReport)).toBeTrue();
      expect(executionReport).toMatchObject({
        mode: 'execute',
        state: 'completed',
        summary: { forgottenProjects: 1, reclaimedItems: 1 },
      });
      expect(await pathExists(retiredObject.path)).toBeFalse();
      expect(await pathExists(stillReachable.path)).toBeTrue();
      expect(JSON.parse(await readLedgerText(fleet))).toMatchObject({
        projects: {},
        projectRegistrations: {},
      });

      const convergedBefore = await snapshotGcState(fleet);
      const repeated = await runGcCli(fleet, ['gc', '--json']);
      expect(repeated.exitCode, `${repeated.stderr}\n${repeated.stdout}`).toBe(0);
      expect(JSON.parse(repeated.stdout)).toMatchObject({
        state: 'no-op',
        summary: { reclaimedItems: 0, eligibleItems: 0 },
      });
      expect(await snapshotGcState(fleet)).toEqual(convergedBefore);
    } finally {
      await destroyGcFleet(fleet);
    }
  });
});
