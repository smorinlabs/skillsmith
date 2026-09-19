import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/index.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../packages/core/src/application/current-services.ts';
import {
  type UndoCliProduct,
  type UndoFleet,
  createUndoFleet,
  destroyUndoFleet,
  runUndoCli,
  seedDev,
  seedInstall,
  seedPromote,
  seedUninstall,
} from '../fixtures/p5-undo/fleet.ts';

setDefaultTimeout(90_000);

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const requireUndoBoundary = (): void => {
  expect(
    {
      commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith undo'),
      applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'undo'),
    },
    'public undo CommandSpec/application service boundary is absent',
  ).toEqual({ commandSpec: true, applicationService: true });
};

const reportOf = (product: UndoCliProduct, expectedExit = 0): UnknownRecord => {
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  expect(product.stderr).toBe('');
  const parsed: unknown = JSON.parse(product.stdout);
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.undo',
    command: 'undo',
  });
  if (!isRecord(parsed)) throw new Error('undo report was not an object');
  return parsed;
};

describe('EWP-P5-TS03', () => {
  test('EWP-P5-TS03 — operation-family and user/project inference matrix', async () => {
    requireUndoBoundary();
    const fleets: UndoFleet[] = [];
    const fleet = async (): Promise<UndoFleet> => {
      const selected = await createUndoFleet();
      fleets.push(selected);
      return selected;
    };
    try {
      for (const scenario of [
        { family: 'dev', seed: seedDev },
        { family: 'promote', seed: seedPromote },
        { family: 'install', seed: seedInstall },
        { family: 'uninstall', seed: seedUninstall },
      ] as const) {
        const selected = await fleet();
        await scenario.seed(selected, { scope: 'project', tool: 'claude-code' });
        const report = reportOf(
          await runUndoCli(selected, ['undo', 'review', '--dry-run', '--json']),
        );
        expect(report).toMatchObject({
          selection: { source: 'explicit-targets', scopes: ['user', 'project'] },
          groups: [
            {
              skill: 'review',
              scope: 'project',
              pairs: [
                {
                  operationFamily: scenario.family,
                  action: 'reverse-committed',
                  tool: 'claude-code',
                },
              ],
            },
          ],
        });
      }

      const ambiguous = await fleet();
      await seedDev(ambiguous, { scope: 'user', tool: 'claude-code' });
      await seedDev(ambiguous, { scope: 'project', tool: 'claude-code' });
      expect(
        (await runUndoCli(ambiguous, ['undo', 'review', '--dry-run', '--json'])).exitCode,
      ).toBe(2);

      const user = reportOf(
        await runUndoCli(ambiguous, ['undo', 'review', '--user', '--dry-run', '--json']),
      );
      const project = reportOf(
        await runUndoCli(ambiguous, ['undo', 'review', '--project', '--dry-run', '--json']),
      );
      expect(records(user.groups).map((group) => group.scope)).toEqual(['user']);
      expect(records(project.groups).map((group) => group.scope)).toEqual(['project']);

      const exactPath = reportOf(
        await runUndoCli(ambiguous, ['undo', ambiguous.paths.projectClaude, '--dry-run', '--json']),
      );
      expect(exactPath).toMatchObject({ groups: [{ scope: 'project', skill: 'review' }] });

      const bulk = reportOf(await runUndoCli(ambiguous, ['undo', '--all', '--dry-run', '--json']));
      expect(bulk).toMatchObject({
        selection: { source: 'explicit-all', scopes: ['user', 'project'] },
      });
      expect(records(bulk.groups).map((group) => group.scope)).toEqual(['user', 'project']);
    } finally {
      await Promise.all(fleets.map(destroyUndoFleet));
    }
  });
});
