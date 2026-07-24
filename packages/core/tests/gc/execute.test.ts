import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGcPlan } from '../../src/gc/execute.ts';
import { inventoryGcStore } from '../../src/gc/inventory.ts';
import { buildGcPlan } from '../../src/gc/plan.ts';
import { observeGcRecovery } from '../../src/gc/recovery.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

describe('GC execution transaction', () => {
  test('publishes recovery before reclaim, preserves preview actions, and cleans recovery', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-execute-'));
    try {
      const dataDir = join(root, 'data');
      const storeRoot = join(dataDir, 'store');
      const objectPath = join(storeRoot, 'fixture', 'repo@0123456789ab', 'review');
      await mkdir(objectPath, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await chmod(dataDir, 0o700);
      await writeFile(join(objectPath, 'SKILL.md'), 'review');
      const inventory = await inventoryGcStore(ports, storeRoot);
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      const model = emptyLedgerModel('2026-07-23T00:00:00.000Z');
      const sourceLedger = {
        state: 'absent' as const,
        sourceVersion: null,
        bytes: null,
        byteRevision: null,
        semanticRevision: null,
        model: null,
      };
      const plan = buildGcPlan({
        sourceLedger,
        model,
        postForgetModel: model,
        inventory,
        classifications: [
          {
            object: inventory.objects[0],
            protection: [],
            ageEligible: true,
            outcome: 'eligible',
          },
        ],
        duration: null,
        nowMilliseconds: 1,
        projects: [],
        dataDir,
        storeRoot,
        ledgerPath: join(dataDir, 'placements.json'),
        project: { effectiveCwd: root, root, identity: root },
        retryArguments: ['gc', '--yes'],
      });
      const result = await executeGcPlan(ports, plan);
      expect(result.ok).toBeTrue();
      expect(result.report.actions).toEqual(plan.report.actions);
      expect(result.report.results).toMatchObject([
        { kind: 'reclaim-store', outcome: 'succeeded' },
      ]);
      expect(result.report.summary).toMatchObject({ reclaimedItems: 1 });
      expect(await ports.pathKind(objectPath)).toBe('absent');
      expect(await observeGcRecovery(ports, dataDir)).toMatchObject({ state: 'none' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
