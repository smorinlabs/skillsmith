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

const preparedPlan = async (
  ports: Awaited<ReturnType<typeof defaultRuntimePorts>>,
  root: string,
  skills: readonly string[],
  duration: Readonly<{ readonly input: string; readonly milliseconds: number }> | null = null,
) => {
  const dataDir = join(root, 'data');
  const storeRoot = join(dataDir, 'store');
  await mkdir(dataDir, { recursive: true });
  await chmod(dataDir, 0o700);
  for (const [index, skill] of skills.entries()) {
    const objectPath = join(storeRoot, 'fixture', 'repo@0123456789ab', skill);
    await mkdir(objectPath, { recursive: true });
    await writeFile(join(objectPath, 'SKILL.md'), `${skill}-${index}`);
  }
  const inventory = await inventoryGcStore(ports, storeRoot);
  if (inventory.state !== 'ok') throw new Error('fixture inventory failed');
  const model = emptyLedgerModel('2026-07-23T00:00:00.000Z');
  return buildGcPlan({
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
    classifications: inventory.objects.map((object) => ({
      object,
      protection: [],
      ageEligible: true,
      outcome: 'eligible' as const,
    })),
    duration,
    nowMilliseconds: Date.parse('2026-07-23T01:00:00.000Z'),
    projects: [],
    dataDir,
    storeRoot,
    ledgerPath: join(dataDir, 'placements.json'),
    project: { effectiveCwd: root, root, identity: root },
    retryArguments: ['gc', ...(duration === null ? [] : ['--older-than', duration.input]), '--yes'],
    normalizedForgetRoots: [],
  });
};

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

  test('resumes a cleaned record after owner removal but before empty-container removal', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-finalize-resume-'));
    try {
      const plan = await preparedPlan(ports, root, ['review']);
      const reclaim = plan.actions.find(({ kind }) => kind === 'reclaim-store');
      if (reclaim?.kind !== 'reclaim-store') throw new Error('reclaim action missing');
      const container = join(plan.storeRoot, '.gc-tombstones', 'v1', plan.planId, reclaim.actionId);
      let interrupted = false;
      const interruptedPorts = Object.assign(Object.create(ports) as typeof ports, {
        removeEmptyDirectory: async (path: string) => {
          if (!interrupted && path === container) {
            interrupted = true;
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          await ports.removeEmptyDirectory?.(path);
        },
      });
      const failed = await executeGcPlan(interruptedPorts, plan);
      expect(failed).toMatchObject({
        ok: false,
        reason: expect.stringContaining('permission denied'),
        report: { summary: { reclaimedItems: 1 } },
      });
      const recovery = await observeGcRecovery(ports, plan.dataDir);
      expect(recovery).toMatchObject({
        state: 'pending',
        record: { phase: 'reclaiming', actions: [{ outcome: 'cleaned' }] },
      });
      expect(await ports.listDir(container)).toEqual([]);
      if (recovery.state !== 'pending') throw new Error('cleaned recovery missing');
      const resumed = await resumeGcRecovery(ports, {
        dataDir: plan.dataDir,
        storeRoot: plan.storeRoot,
        ledgerPath: plan.ledgerPath,
        recovery,
      });
      expect(resumed.ok).toBeTrue();
      expect(await ports.pathKind(container)).toBe('absent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reobserves a live record when its post-rename publication fsync fails', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-publish-resume-'));
    try {
      const plan = await preparedPlan(ports, root, ['review']);
      const recoveryRoot = join(plan.dataDir, '.gc-recovery', 'v1');
      let liveRenamed = false;
      let interrupted = false;
      const interruptedPorts = Object.assign(Object.create(ports) as typeof ports, {
        rename: async (from: string, to: string) => {
          await ports.rename(from, to);
          if (from.includes('.create-') && to.endsWith(`${plan.planId}.json`)) liveRenamed = true;
        },
        fsyncDir: async (path: string) => {
          if (liveRenamed && !interrupted && path === recoveryRoot) {
            interrupted = true;
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          await ports.fsyncDir(path);
        },
      });
      const failed = await executeGcPlan(interruptedPorts, plan);
      expect(failed).toMatchObject({
        ok: false,
        reason: expect.stringContaining('permission denied'),
        report: { recovery: { state: 'pending', phase: 'approved' } },
      });
      const recovery = await observeGcRecovery(ports, plan.dataDir);
      if (recovery.state !== 'pending') throw new Error('published recovery missing');
      const resumed = await resumeGcRecovery(ports, {
        dataDir: plan.dataDir,
        storeRoot: plan.storeRoot,
        ledgerPath: plan.ledgerPath,
        recovery,
      });
      expect(resumed.ok).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a competing approved plan discovered only after entering the ledger lock', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-concurrent-record-'));
    try {
      const first = await preparedPlan(ports, root, ['review']);
      const firstReclaim = first.actions.find((action) => action.kind === 'reclaim-store');
      if (firstReclaim?.kind !== 'reclaim-store') throw new Error('reclaim action missing');
      const competing = buildGcPlan({
        sourceLedger: first.sourceLedger,
        model: first.model,
        postForgetModel: first.postForgetModel,
        inventory: {
          state: 'ok',
          root: first.storeRoot,
          rootIdentity: firstReclaim.object.rootIdentity,
          objects: first.actions
            .filter((action) => action.kind === 'reclaim-store')
            .map((action) => action.object),
          issues: [],
        },
        classifications: first.actions
          .filter((action) => action.kind === 'reclaim-store')
          .map((action) => ({
            object: action.object,
            protection: [],
            ageEligible: true,
            outcome: 'eligible' as const,
          })),
        duration: { input: '1s', milliseconds: 1_000 },
        nowMilliseconds: first.nowMilliseconds,
        projects: [],
        dataDir: first.dataDir,
        storeRoot: first.storeRoot,
        ledgerPath: first.ledgerPath,
        project: first.report.project,
        retryArguments: ['gc', '--older-than', '1s', '--yes'],
        normalizedForgetRoots: [],
      });
      const interruptedPorts = Object.assign(Object.create(ports) as typeof ports, {
        writeTextFileExclusive: async (path: string, contents: string, mode: number) => {
          if (path.includes('.cas-')) throw new Error('pause after publication');
          await ports.writeTextFileExclusive(path, contents, mode);
        },
      });
      expect((await executeGcPlan(interruptedPorts, first)).ok).toBeFalse();
      const before = await observeGcRecovery(ports, first.dataDir);
      expect(before).toMatchObject({ state: 'pending', record: { planId: first.planId } });
      const refused = await executeGcPlan(ports, competing);
      expect(refused).toMatchObject({
        ok: false,
        reason: expect.stringContaining('different approved request'),
      });
      expect(await observeGcRecovery(ports, first.dataDir)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports completed earlier actions when a later reclaim fails and resumes without recounting', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-partial-report-'));
    try {
      const plan = await preparedPlan(ports, root, ['alpha', 'zeta']);
      const reclaimActions = plan.actions.filter((action) => action.kind === 'reclaim-store');
      const second = reclaimActions[1];
      if (second?.kind !== 'reclaim-store') throw new Error('second reclaim action missing');
      const secondContainer = join(
        plan.storeRoot,
        '.gc-tombstones',
        'v1',
        plan.planId,
        second.actionId,
      );
      const interruptedPorts = Object.assign(Object.create(ports) as typeof ports, {
        makeDirExclusive: async (path: string, mode: number) => {
          if (path === secondContainer) {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          await ports.makeDirExclusive(path, mode);
        },
      });
      const partial = await executeGcPlan(interruptedPorts, plan);
      expect(partial).toMatchObject({
        ok: false,
        reason: expect.stringContaining('permission denied'),
        report: {
          state: 'partial',
          results: [
            { kind: 'reclaim-store', outcome: 'succeeded' },
            { kind: 'reclaim-store', outcome: 'failed' },
          ],
          summary: { reclaimedItems: 1, failedItems: 1 },
        },
      });
      const recovery = await observeGcRecovery(ports, plan.dataDir);
      if (recovery.state !== 'pending') throw new Error('partial recovery missing');
      const resumed = await resumeGcRecovery(ports, {
        dataDir: plan.dataDir,
        storeRoot: plan.storeRoot,
        ledgerPath: plan.ledgerPath,
        recovery,
      });
      expect(resumed).toMatchObject({
        ok: true,
        report: { summary: { reclaimedItems: 2, failedItems: 0 } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses planted action state before publishing a recovery record', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-pre-record-planted-'));
    try {
      const plan = await preparedPlan(ports, root, ['review']);
      const reclaim = plan.actions.find(({ kind }) => kind === 'reclaim-store');
      if (reclaim?.kind !== 'reclaim-store') throw new Error('reclaim action missing');
      const planted = join(plan.storeRoot, '.gc-tombstones', 'v1', plan.planId, reclaim.actionId);
      await mkdir(planted, { recursive: true, mode: 0o700 });
      await writeFile(join(planted, 'planted'), 'unsafe');
      const refused = await executeGcPlan(ports, plan);
      expect(refused).toMatchObject({ ok: false });
      expect(await observeGcRecovery(ports, plan.dataDir)).toMatchObject({ state: 'none' });
      expect(await ports.pathKind(reclaim.object.path)).toBe('dir');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('passes cancellation to a waiting ledger lock and returns promptly without GC writes', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-lock-cancel-'));
    try {
      const plan = await preparedPlan(ports, root, ['review']);
      const waitingPorts = Object.assign(Object.create(ports) as typeof ports, {
        withFileLock: async <T>(
          _target: string,
          _fn: () => Promise<T>,
          options?: Readonly<{ readonly signal?: AbortSignal }>,
        ): Promise<T> =>
          new Promise<T>((_resolve, reject) => {
            if (options?.signal?.aborted) {
              reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
              return;
            }
            options?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })),
              { once: true },
            );
          }),
      });
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = executeGcPlan(waitingPorts, plan, controller.signal);
      controller.abort();
      const cancelled = await pending;
      expect(cancelled).toMatchObject({ ok: false, reason: expect.stringContaining('cancelled') });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(await observeGcRecovery(ports, plan.dataDir)).toMatchObject({ state: 'none' });

      const deniedPorts = Object.assign(Object.create(ports) as typeof ports, {
        withFileLock: async (): Promise<never> => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      });
      const denied = await executeGcPlan(deniedPorts, plan);
      expect(denied).toMatchObject({
        ok: false,
        reason: expect.stringContaining('permission denied'),
      });
      expect(await observeGcRecovery(ports, plan.dataDir)).toMatchObject({ state: 'none' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
