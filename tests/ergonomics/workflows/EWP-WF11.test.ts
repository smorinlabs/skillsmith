import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/index.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../packages/core/src/application/current-services.ts';
import {
  UNDO_SECRET_CANARIES,
  type UndoCliProduct,
  type UndoFleet,
  crashPublicCommandAt,
  createUndoFleet,
  destroyUndoFleet,
  runUndoCli,
  seedPromote,
  snapshotUndoState,
  writeLegacyPendingDev,
} from '../fixtures/p5-undo/fleet.ts';

setDefaultTimeout(120_000);

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

describe('EWP-WF11', () => {
  test('EWP-WF11 — crash recovery and undo remain resumable, scoped, and history preserving', async () => {
    requireUndoBoundary();
    const fleets: UndoFleet[] = [];
    const fleet = async (): Promise<UndoFleet> => {
      const selected = await createUndoFleet();
      fleets.push(selected);
      return selected;
    };
    try {
      const legacy = await fleet();
      const pending = await writeLegacyPendingDev(legacy);
      const v1Bytes = await readFile(legacy.ledger, 'utf8');
      expect(JSON.parse(v1Bytes)).toMatchObject({ schemaVersion: 1 });

      const doctor = jsonReport(await runUndoCli(legacy, ['doctor', '--json']));
      expect(doctor).toMatchObject({ schemaVersion: 2, experimental: true });
      expect(JSON.stringify(doctor)).toMatch(/migration/);
      expect(await readFile(legacy.ledger, 'utf8')).toBe(v1Bytes);

      const doctorDry = jsonReport(
        await runUndoCli(legacy, ['doctor', '--fix', '--dry-run', '--json']),
      );
      expect(JSON.stringify(doctorDry)).toMatch(/migrate-ledger/);
      expect(await readFile(legacy.ledger, 'utf8')).toBe(v1Bytes);

      const status = jsonReport(await runUndoCli(legacy, ['status', 'review', '--json']));
      expect(status).toMatchObject({ kind: 'skillsmith.status' });
      expect(JSON.stringify(status)).toMatch(/abort|undo/);
      expect(JSON.stringify(status)).toContain(pending.transactionId);

      const beforeTargetless = await snapshotUndoState(legacy);
      expect((await runUndoCli(legacy, ['undo', '--json'])).exitCode).toBe(2);
      expect(await snapshotUndoState(legacy)).toBe(beforeTargetless);

      const dry = jsonReport(
        await runUndoCli(legacy, ['undo', 'review', '--project', '--dry-run', '--json']),
      );
      expect(dry).toMatchObject({
        kind: 'skillsmith.undo',
        mode: 'dry-run',
        groups: [
          {
            pairs: [
              {
                action: 'abort-pending',
                sourceTransactionId: pending.transactionId,
              },
            ],
          },
        ],
      });
      expect(JSON.stringify(dry)).toMatch(/migrate-ledger/);
      expect(await readFile(legacy.ledger, 'utf8')).toBe(v1Bytes);

      const executed = jsonReport(
        await runUndoCli(legacy, ['undo', 'review', '--project', '--yes', '--json']),
      );
      expect(executed).toMatchObject({ kind: 'skillsmith.undo', summary: { failed: 0 } });
      expect(JSON.parse(await readFile(legacy.ledger, 'utf8'))).toMatchObject({ schemaVersion: 2 });

      for (const phase of ['prepared', 'staged', 'backed-up', 'live'] as const) {
        const interrupted = await fleet();
        await seedPromote(interrupted);
        await crashPublicCommandAt(
          interrupted,
          ['dev', 'review', '--project', '--tool', 'claude-code', '--no-verify', '--json'],
          phase,
        );
        const interruptedStatus = jsonReport(
          await runUndoCli(interrupted, ['status', 'review', '--json']),
        );
        expect(JSON.stringify(interruptedStatus)).toMatch(/resume|abort|undo/);
        const preview = jsonReport(
          await runUndoCli(interrupted, ['undo', 'review', '--project', '--dry-run', '--json']),
        );
        expect(preview).toMatchObject({
          kind: 'skillsmith.undo',
          groups: [{ pairs: [{ action: 'abort-pending', phase }] }],
        });
      }

      const all = await fleet();
      await seedPromote(all, { skill: 'review', scope: 'project', tool: 'claude-code' });
      await seedPromote(all, { skill: 'audit', scope: 'user', tool: 'codex' });
      const bulk = jsonReport(
        await runUndoCli(all, ['undo', '--all', '--continue-on-error', '--dry-run', '--json']),
      );
      expect(bulk).toMatchObject({
        kind: 'skillsmith.undo',
        selection: { source: 'explicit-all', batchPolicy: 'continue-on-error' },
      });

      for (const product of [doctor, doctorDry, status, dry, executed, bulk]) {
        const encoded = JSON.stringify(product);
        for (const canary of UNDO_SECRET_CANARIES) expect(encoded).not.toContain(canary);
      }
    } finally {
      await Promise.all(fleets.map(destroyUndoFleet));
    }
  });
});
