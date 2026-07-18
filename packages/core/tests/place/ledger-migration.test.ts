import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcquisitionLedgerMigrationBinding } from '../../src/acquire/execute.ts';
import {
  createLedgerMigrationExecutionBinding,
  prepareLedgerMigration,
} from '../../src/place/ledger-migration.ts';
import { readLedgerState } from '../../src/place/ledger.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

describe('shared ledger migration binding', () => {
  test('prepares export as a generic v1-to-v2 mutator and retains the acquisition alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-migration-export-'));
    try {
      const path = join(root, 'placements.json');
      const fixture = join(
        import.meta.dir,
        '../../../../tests/ergonomics/fixtures/p2-ts08/ledger-v1.golden.json',
      );
      await writeFile(path, await readFile(fixture));
      const ports = await defaultRuntimePorts();
      const state = await readLedgerState(ports, path);
      expect(state.ok).toBeTrue();
      if (!state.ok) throw new Error('ledger fixture was invalid');
      const prepared = prepareLedgerMigration(
        ports,
        'export',
        'bounded-default',
        path,
        state.value,
      );
      expect(prepared).not.toBeNull();
      if (prepared === null) throw new Error('export migration was not prepared');
      expect(prepared.operation).toMatchObject({
        kind: 'migrate-ledger',
        selectionSource: 'bounded-default',
        before: { kind: 'ledger', schemaVersion: 1 },
        after: { kind: 'ledger', schemaVersion: 2 },
        mutates: { live: false, manifest: false, lock: false, ledger: true },
      });
      const args = {
        env: ports,
        ledgerPath: path,
        operation: prepared.operation,
        expectedState: prepared.expectedState,
        startedAt: '2026-07-18T00:00:00.000Z',
        onMigrated: () => undefined,
      };
      const generic = createLedgerMigrationExecutionBinding(args);
      const compatibility = createAcquisitionLedgerMigrationBinding(args);
      expect(Object.keys(generic).sort()).toEqual(Object.keys(compatibility).sort());
      expect(generic).toMatchObject({
        operationId: prepared.operation.operationId,
        groupId: prepared.operation.groupId,
        pairId: null,
        unstartedForce: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
