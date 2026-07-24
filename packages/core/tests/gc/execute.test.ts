import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerModel, LedgerPairV1Dto } from '../../src/artifacts/ledger-types.ts';
import { executeGcPlan, resumeGcRecovery } from '../../src/gc/execute.ts';
import { inventoryGcStore } from '../../src/gc/inventory.ts';
import { buildGcPlan } from '../../src/gc/plan.ts';
import { observeGcRecovery } from '../../src/gc/recovery.ts';
import { emptyLedgerModel, readLedgerState, writeLedger } from '../../src/place/ledger.ts';
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
        normalizedForgetRoots: [],
      });
      const controller = new AbortController();
      controller.abort();
      const cancelled = await executeGcPlan(ports, plan, controller.signal);
      expect(cancelled).toMatchObject({ ok: false, reason: expect.stringContaining('cancelled') });
      expect(await ports.pathKind(objectPath)).toBe('dir');
      expect(await observeGcRecovery(ports, dataDir)).toMatchObject({ state: 'none' });
      const result = await executeGcPlan(ports, plan);
      expect(result.ok).toBeTrue();
      expect(result.report.actions).toEqual(plan.report.actions);
      expect(result.report.results).toMatchObject([
        { kind: 'reclaim-store', outcome: 'succeeded' },
      ]);
      expect(result.report.summary).toMatchObject({ reclaimedItems: 1 });
      expect(await ports.pathKind(objectPath)).toBe('absent');
      expect(await observeGcRecovery(ports, dataDir)).toMatchObject({ state: 'none' });
      const alreadyAbsent = await executeGcPlan(ports, plan);
      expect(alreadyAbsent.ok).toBeTrue();
      expect(alreadyAbsent.report.summary).toMatchObject({
        alreadyAbsentItems: 1,
        reclaimedItems: 0,
        reclaimedBytes: 0,
      });
      expect(alreadyAbsent.report.objects).toContainEqual(
        expect.objectContaining({ path: objectPath, outcome: 'already-absent' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('resumes the same immutable plan after a crash following atomic detach', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-resume-'));
    try {
      const dataDir = join(root, 'data');
      const storeRoot = join(dataDir, 'store');
      const objectPath = join(storeRoot, 'fixture', 'repo@0123456789ab', 'review');
      await mkdir(objectPath, { recursive: true });
      await chmod(dataDir, 0o700);
      await writeFile(join(objectPath, 'SKILL.md'), 'review');
      const inventory = await inventoryGcStore(ports, storeRoot);
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      const model = emptyLedgerModel('2026-07-23T00:00:00.000Z');
      const plan = buildGcPlan({
        sourceLedger: {
          state: 'absent',
          sourceVersion: null,
          bytes: null,
          byteRevision: null,
          semanticRevision: null,
          model: null,
        },
        model,
        postForgetModel: model,
        inventory,
        classifications: [
          { object: inventory.objects[0], protection: [], ageEligible: true, outcome: 'eligible' },
        ],
        duration: null,
        nowMilliseconds: 1,
        projects: [],
        dataDir,
        storeRoot,
        ledgerPath: join(dataDir, 'placements.json'),
        project: { effectiveCwd: root, root, identity: root },
        retryArguments: ['gc', '--yes'],
        normalizedForgetRoots: [],
      });
      let crashed = false;
      const crashPorts = Object.assign(Object.create(ports) as typeof ports, {
        rename: async (from: string, to: string) => {
          await ports.rename(from, to);
          if (!crashed && to.endsWith('/payload')) {
            crashed = true;
            throw new Error('simulated crash after detach');
          }
        },
      });
      const interrupted = await executeGcPlan(crashPorts, plan);
      expect(interrupted.ok).toBeFalse();
      const recovery = await observeGcRecovery(ports, dataDir);
      expect(recovery).toMatchObject({
        state: 'pending',
        record: { planId: plan.planId, phase: 'reclaiming', actions: [{ outcome: 'prepared' }] },
      });
      if (recovery.state !== 'pending') throw new Error('pending recovery not found');
      const resumed = await resumeGcRecovery(ports, {
        dataDir,
        storeRoot,
        ledgerPath: plan.ledgerPath,
        recovery,
      });
      expect(resumed.ok).toBeTrue();
      expect(resumed.report.planId).toBe(plan.planId);
      expect(resumed.report.summary.reclaimedItems).toBe(1);
      expect(await ports.pathKind(objectPath)).toBe('absent');
      expect(await observeGcRecovery(ports, dataDir)).toMatchObject({ state: 'none' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('protected-skips an approved reclaim when committed reachability protects it', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-revalidate-'));
    try {
      const dataDir = join(root, 'data');
      const storeRoot = join(dataDir, 'store');
      const ledgerPath = join(dataDir, 'placements.json');
      const objectPath = join(storeRoot, 'fixture', 'repo@0123456789ab', 'review');
      await mkdir(objectPath, { recursive: true });
      await chmod(dataDir, 0o700);
      await writeFile(join(objectPath, 'SKILL.md'), 'review');
      const inventory = await inventoryGcStore(ports, storeRoot);
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      const selected = inventory.objects[0];
      const pair: LedgerPairV1Dto = {
        placementPath: join(root, 'live', 'review'),
        mode: 'pinned',
        dev: null,
        pinned: {
          storePath: selected.path,
          rev: selected.revision,
          gitSha: null,
          dirty: false,
          contentHash: selected.contentHash,
          snapshotAt: '2026-07-23T00:00:00.000Z',
          verify: 'passed',
          placement: 'symlink',
        },
      };
      const base = emptyLedgerModel('2026-07-23T00:00:00.000Z');
      const protectedModel: LedgerModel = {
        ...base,
        skills: { review: { tools: { codex: pair } } },
      };
      expect((await writeLedger(ports, ledgerPath, protectedModel)).ok).toBeTrue();
      const source = await readLedgerState(ports, ledgerPath);
      if (!source.ok || source.value.state !== 'present') throw new Error('ledger fixture failed');
      const plan = buildGcPlan({
        sourceLedger: source.value,
        model: source.value.model,
        postForgetModel: source.value.model,
        inventory,
        classifications: [
          { object: selected, protection: [], ageEligible: true, outcome: 'eligible' },
        ],
        duration: null,
        nowMilliseconds: Date.parse('2026-07-23T01:00:00.000Z'),
        projects: [],
        dataDir,
        storeRoot,
        ledgerPath,
        project: { effectiveCwd: root, root, identity: root },
        retryArguments: ['gc', '--yes'],
        normalizedForgetRoots: [],
      });
      const result = await executeGcPlan(ports, plan);
      expect(result.ok).toBeTrue();
      expect(result.report.results).toContainEqual(
        expect.objectContaining({ kind: 'reclaim-store', outcome: 'protected-skip' }),
      );
      expect(result.report.summary).toMatchObject({ reclaimedItems: 0, protectedItems: 1 });
      expect(await ports.pathKind(objectPath)).toBe('dir');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('resumes owner-authorized cleanup after recursive payload removal was interrupted', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-cleanup-resume-'));
    try {
      const dataDir = join(root, 'data');
      const storeRoot = join(dataDir, 'store');
      const objectPath = join(storeRoot, 'fixture', 'repo@0123456789ab', 'review');
      await mkdir(objectPath, { recursive: true });
      await chmod(dataDir, 0o700);
      await writeFile(join(objectPath, 'SKILL.md'), 'review');
      await writeFile(join(objectPath, 'second'), 'second');
      const inventory = await inventoryGcStore(ports, storeRoot);
      if (inventory.state !== 'ok' || inventory.objects[0] === undefined) {
        throw new Error('fixture inventory failed');
      }
      const model = emptyLedgerModel('2026-07-23T00:00:00.000Z');
      const plan = buildGcPlan({
        sourceLedger: {
          state: 'absent',
          sourceVersion: null,
          bytes: null,
          byteRevision: null,
          semanticRevision: null,
          model: null,
        },
        model,
        postForgetModel: model,
        inventory,
        classifications: [
          { object: inventory.objects[0], protection: [], ageEligible: true, outcome: 'eligible' },
        ],
        duration: null,
        nowMilliseconds: 1,
        projects: [],
        dataDir,
        storeRoot,
        ledgerPath: join(dataDir, 'placements.json'),
        project: { effectiveCwd: root, root, identity: root },
        retryArguments: ['gc', '--yes'],
        normalizedForgetRoots: [],
      });
      let crashed = false;
      const crashPorts = Object.assign(Object.create(ports) as typeof ports, {
        removeTree: async (path: string) => {
          if (!crashed && path.endsWith('/payload')) {
            crashed = true;
            await ports.removeTree(join(path, 'SKILL.md'));
            throw new Error('simulated crash during recursive cleanup');
          }
          await ports.removeTree(path);
        },
      });
      expect((await executeGcPlan(crashPorts, plan)).ok).toBeFalse();
      const recovery = await observeGcRecovery(ports, dataDir);
      expect(recovery).toMatchObject({
        state: 'pending',
        record: { actions: [{ outcome: 'cleanup-started' }] },
      });
      if (recovery.state !== 'pending') throw new Error('cleanup recovery not found');
      const resumed = await resumeGcRecovery(ports, {
        dataDir,
        storeRoot,
        ledgerPath: plan.ledgerPath,
        recovery,
      });
      expect(resumed.ok).toBeTrue();
      expect(resumed.report.summary).toMatchObject({ reclaimedItems: 1, reclaimedBytes: 12 });
      expect(await ports.pathKind(objectPath)).toBe('absent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
