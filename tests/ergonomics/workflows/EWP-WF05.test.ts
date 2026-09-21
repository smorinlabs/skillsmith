import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/index.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../packages/core/src/application/current-services.ts';
import {
  type UndoCliProduct,
  createUndoFleet,
  destroyUndoFleet,
  runUndoCli,
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

const jsonReport = (product: UndoCliProduct, expectedExit = 0): UnknownRecord => {
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  expect(product.stderr).toBe('');
  const parsed: unknown = JSON.parse(product.stdout);
  if (!isRecord(parsed)) throw new Error('workflow command returned a non-object JSON report');
  return parsed;
};

describe('EWP-WF05', () => {
  test('EWP-WF05 — local development lifecycle returns to the recorded source without residue', async () => {
    requireUndoBoundary();
    const fleet = await createUndoFleet();
    try {
      for (const tool of ['claude-code', 'codex'] as const) {
        const dev = jsonReport(
          await runUndoCli(fleet, [
            'dev',
            'review',
            '--source',
            fleet.source,
            '--project',
            '--tool',
            tool,
            '--no-verify',
            '--json',
          ]),
        );
        expect(dev).toMatchObject({ kind: 'skillsmith.flip', op: 'dev' });
      }

      const verified = jsonReport(
        await runUndoCli(fleet, [
          'verify',
          fleet.source,
          '--deep',
          '--strict',
          '--tool',
          'claude-code',
          '--tool',
          'codex',
          '--json',
        ]),
      );
      expect(verified).toMatchObject({ kind: 'skillsmith.verify' });

      const status = jsonReport(await runUndoCli(fleet, ['status', 'review', '--json']));
      expect(status).toMatchObject({ kind: 'skillsmith.status' });
      expect(JSON.stringify(status)).toContain('claude-code');
      expect(JSON.stringify(status)).toContain('codex');

      const preview = jsonReport(
        await runUndoCli(fleet, ['promote', 'review', '--project', '--dry-run', '--json']),
      );
      expect(preview).toMatchObject({ kind: 'skillsmith.flip', op: 'promote', dryRun: true });
      const promoted = jsonReport(
        await runUndoCli(fleet, ['promote', 'review', '--project', '--strict', '--json']),
      );
      expect(promoted).toMatchObject({ kind: 'skillsmith.flip', op: 'promote' });

      const all = jsonReport(
        await runUndoCli(fleet, [
          'promote',
          '--all',
          '--project',
          '--continue-on-error',
          '--dry-run',
          '--json',
        ]),
      );
      expect(all).toMatchObject({ selection: { source: 'explicit-all' } });

      const undoPreview = jsonReport(
        await runUndoCli(fleet, ['undo', 'review', '--project', '--dry-run', '--json']),
      );
      expect(undoPreview).toMatchObject({
        schemaVersion: 1,
        kind: 'skillsmith.undo',
        command: 'undo',
        mode: 'dry-run',
        summary: { selected: 1, actionable: 1, planned: 1 },
        groups: [
          {
            skill: 'review',
            scope: 'project',
            outcome: 'planned',
            pairs: [
              { tool: 'claude-code', outcome: 'planned' },
              { tool: 'codex', outcome: 'planned' },
            ],
          },
        ],
      });
      const undone = jsonReport(
        await runUndoCli(fleet, ['undo', 'review', '--project', '--yes', '--json']),
      );
      expect(undone).toMatchObject({
        kind: 'skillsmith.undo',
        summary: { selected: 1, actionable: 1, succeeded: 1, failed: 0 },
        groups: [
          {
            skill: 'review',
            scope: 'project',
            outcome: 'succeeded',
            pairs: [
              { tool: 'claude-code', outcome: 'succeeded' },
              { tool: 'codex', outcome: 'succeeded' },
            ],
          },
        ],
      });

      const relinked = jsonReport(
        await runUndoCli(fleet, ['dev', 'review', '--project', '--no-verify', '--json']),
      );
      expect(relinked).toMatchObject({ kind: 'skillsmith.flip', op: 'dev' });
      expect(
        records(relinked.results).every(
          (result) => result.action === 'noop' || result.action === 'flipped',
        ),
      ).toBeTrue();

      const names = await readdir(fleet.root, { recursive: true, encoding: 'utf8' });
      expect(
        names.filter((name) =>
          /skillsmith-(staging|backup)|\.skillsmith-(stage|backup)/.test(name),
        ),
      ).toEqual([]);

      const help = await runUndoCli(fleet, ['help', 'dev']);
      expect(help.exitCode, help.stderr).toBe(0);
      expect(help.stdout).toMatch(/Development|promote|verify/i);
    } finally {
      await destroyUndoFleet(fleet);
    }
  });

  test('EWP-WF05 — muse user-scope lifecycle runs the stubbed static+deep gates', async () => {
    requireUndoBoundary();
    const fleet = await createUndoFleet();
    try {
      const agents = jsonReport(await runUndoCli(fleet, ['agents', '--json']));
      expect(JSON.stringify(agents)).toContain('muse');

      const dev = jsonReport(
        await runUndoCli(fleet, [
          'dev',
          'review',
          '--source',
          fleet.source,
          '--scope',
          'user',
          '--tool',
          'muse',
          '--no-verify',
          '--json',
        ]),
      );
      expect(dev).toMatchObject({ kind: 'skillsmith.flip', op: 'dev' });

      const verified = jsonReport(
        await runUndoCli(fleet, [
          'verify',
          fleet.source,
          '--deep',
          '--strict',
          '--tool',
          'muse',
          '--json',
        ]),
      );
      expect(verified).toMatchObject({
        kind: 'skillsmith.verify',
        summary: { verdict: 'pass' },
      });

      const status = jsonReport(
        await runUndoCli(fleet, ['status', 'review', '--scope', 'user', '--json']),
      );
      expect(status).toMatchObject({ kind: 'skillsmith.status' });
      expect(JSON.stringify(status)).toContain(fleet.paths.userMuse);

      const promoted = jsonReport(
        await runUndoCli(fleet, [
          'promote',
          'review',
          '--scope',
          'user',
          '--tool',
          'muse',
          '--strict',
          '--json',
        ]),
      );
      expect(promoted).toMatchObject({ kind: 'skillsmith.flip', op: 'promote' });

      const undoPreview = jsonReport(
        await runUndoCli(fleet, ['undo', 'review', '--scope', 'user', '--dry-run', '--json']),
      );
      expect(undoPreview).toMatchObject({
        schemaVersion: 1,
        kind: 'skillsmith.undo',
        command: 'undo',
        mode: 'dry-run',
        summary: { selected: 1, actionable: 1, planned: 1 },
        groups: [
          {
            skill: 'review',
            scope: 'user',
            outcome: 'planned',
            pairs: [{ tool: 'muse', outcome: 'planned' }],
          },
        ],
      });
      const undone = jsonReport(
        await runUndoCli(fleet, ['undo', 'review', '--scope', 'user', '--yes', '--json']),
      );
      expect(undone).toMatchObject({
        kind: 'skillsmith.undo',
        summary: { selected: 1, actionable: 1, succeeded: 1, failed: 0 },
        groups: [
          {
            skill: 'review',
            scope: 'user',
            outcome: 'succeeded',
            pairs: [{ tool: 'muse', outcome: 'succeeded' }],
          },
        ],
      });
    } finally {
      await destroyUndoFleet(fleet);
    }
  });
});
