import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runUninstall } from '../../../packages/core/src/acquire/run.ts';
import type {
  PlannedUninstallReport,
  UninstallDeps,
} from '../../../packages/core/src/acquire/types.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../packages/core/src/artifacts/node-coordinator.ts';
import { scheduleOperationPlan } from '../../../packages/core/src/execution/scheduler.ts';
import { createOperationExecutionResult } from '../../../packages/core/src/planning/create.ts';
import { orderExecutableOperationsTopologically } from '../../../packages/core/src/planning/order.ts';
import type { OperationExecutionResult } from '../../../packages/core/src/planning/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../packages/core/tests/fixtures/place/fleet.ts';
import {
  COLLISION_CASES,
  CRASH_POINTS,
  FEATURE_FAMILIES,
  FIXTURE_CANARY,
  LOCK_HANDOFF_CASES,
  REQUIRED_COMPATIBILITY_SELECTORS,
  collisionPlan,
  lockSourceFor,
  manifestSource,
} from '../fixtures/p4a-ts02/cases.ts';

setDefaultTimeout(30_000);

const CRASH_CHILD = join(import.meta.dir, '../fixtures/p4a-ts02/crash-child.ts');
const fleets: FixtureFleet[] = [];

afterEach(async () => {
  await Promise.all(fleets.splice(0).map((fleet) => destroyFixtureFleet(fleet)));
});

const fleet = async (): Promise<FixtureFleet> => {
  const value = await buildFixtureFleet();
  fleets.push(value);
  return value;
};

const reportOf = (value: unknown): PlannedUninstallReport => value as PlannedUninstallReport;

const depsFor = async (selected: FixtureFleet, label: string): Promise<UninstallDeps> => {
  const coordinator = await createTestNodeArtifactCoordinatorPorts(
    join(selected.base, `coordination-${label}`),
  );
  let index = 0;
  return {
    artifactCoordinator: coordinator,
    now: () => '2026-07-18T00:00:00.000Z',
    newTxId: () => (0x7000000000000000n + BigInt(index++)).toString(16),
  };
};

const readPair = async (root: string) =>
  Promise.all([
    readFile(join(root, 'skillsmith.toml'), 'utf8'),
    readFile(join(root, 'skillsmith.lock'), 'utf8'),
  ]);

const runDeclaredUninstall = async (
  selected: FixtureFleet,
  root: string,
  targets: readonly string[],
  options: Readonly<{ dryRun?: boolean; continueOnError?: boolean }> = {},
) => {
  const result = await runUninstall(
    selected.env,
    {
      targets,
      tools: ['claude-code'],
      scope: 'user',
      file: join(root, 'skillsmith.toml'),
      lockfile: join(root, 'skillsmith.lock'),
      cwd: selected.base,
      configuration: selected.configuration,
      ...options,
    },
    await depsFor(selected, `${targets.join('-')}-${options.dryRun ? 'preview' : 'run'}`),
  );
  if (!result.ok)
    throw new Error('message' in result.error ? result.error.message : result.error.code);
  return reportOf(result.value);
};

const bindingFor = (
  operation: ReturnType<typeof collisionPlan>['plan']['operations'][number],
  calls: string[],
  failedOperationId: string,
) => ({
  operationId: operation.operationId,
  groupId: operation.groupId,
  pairId: operation.pairId,
  actualBefore: operation.before,
  unstartedForce: null,
  execute: async (): Promise<OperationExecutionResult> => {
    calls.push(operation.operationId);
    const failed = operation.operationId === failedOperationId;
    return createOperationExecutionResult({
      operationId: operation.operationId,
      outcome: failed ? 'failed' : 'succeeded',
      actualBefore: operation.before,
      actualAfter: failed ? operation.before : operation.after,
      force: null,
      error: failed
        ? { code: 'fixture-failed', message: 'Injected TS02 failure.', remediation: 'Retry.' }
        : null,
    });
  },
});

const readReached = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Readonly<{ kind: string; barrier: string }>> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let source = '';
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('p4a-ts02 crash child barrier timed out')), 15_000);
  });
  const next = async (): Promise<Readonly<{ kind: string; barrier: string }>> => {
    while (!source.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('p4a-ts02 crash child exited before its barrier');
      source += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(source.slice(0, source.indexOf('\n'))) as {
      kind: string;
      barrier: string;
    };
  };
  return Promise.race([next(), timeout]);
};

const seedCrashBoundary = async (
  root: string,
  stopAfter: 'manifest' | 'lock',
  manifest: string,
  lock: string,
): Promise<void> => {
  const child = Bun.spawn([process.execPath, CRASH_CHILD], {
    cwd: root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({
      kind: 'start',
      root,
      stopAfter,
      manifestSource: manifest,
      lockSource: lock,
    })}\n`,
  );
  const reached = await readReached(child.stdout);
  expect(reached).toEqual({ kind: 'reached', barrier: `after-${stopAfter}` });
  child.kill('SIGKILL');
  await child.exited;
};

describe('EWP-P4A-TS02', () => {
  test('the bounded fixture owns all twelve feature families and exact compatibility replays', () => {
    expect(FIXTURE_CANARY).toBe('p4a-ts02-fixture-v1');
    expect(FEATURE_FAMILIES).toHaveLength(12);
    expect(new Set(FEATURE_FAMILIES).size).toBe(12);
    expect(REQUIRED_COMPATIBILITY_SELECTORS).toEqual([
      'EWP-CMD-INSTALL-TS08',
      'EWP-CMD-UNINSTALL-TS04',
      'EWP-CMD-UNINSTALL-TS07',
      'EWP-P3B-TS03',
      'EWP-P3B-TS05',
      'EWP-CMD-PROMOTE-TS04',
      'EWP-CMD-PROMOTE-TS06',
    ]);
    expect(COLLISION_CASES).toHaveLength(4);
    expect(LOCK_HANDOFF_CASES).toHaveLength(7);
    expect(CRASH_POINTS).toEqual(['after-manifest', 'after-lock', 'after-live-pair']);
  });

  test('admits only the exact artifact-prefix barrier and preserves fail-fast/continue truth', async () => {
    for (const item of COLLISION_CASES) {
      const fixture = collisionPlan(item.policy);
      expect(
        orderExecutableOperationsTopologically(fixture.plan.operations).map(
          ({ operationId }) => operationId,
        ),
        item.id,
      ).toEqual(fixture.plan.operations.map(({ operationId }) => operationId));

      const calls: string[] = [];
      const failedOperationId =
        item.failure === 'prefix-lock' ? fixture.alphaLockId : fixture.alphaLiveId;
      const results = await scheduleOperationPlan(
        fixture.plan,
        fixture.plan.operations.map((operation) => bindingFor(operation, calls, failedOperationId)),
      );
      const byId = new Map(results.map((result) => [result.operationId, result.outcome]));
      expect(byId.get(fixture.betaLiveId), item.id).toBe(item.expectedLater);
      expect(calls.includes(fixture.betaLiveId), item.id).toBe(item.expectedLater === 'succeeded');
      if (item.failure === 'prefix-lock') {
        expect(byId.get(fixture.alphaLiveId), item.id).toBe('skipped-after-failure');
      }
    }
  });

  test('plans two declared-only removals as cumulative exact images with one full-group barrier', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'multi-declaration');
    await mkdir(root, { recursive: true });
    const beforeManifest = manifestSource(['portable-beta', 'portable-alpha', 'retained-gamma']);
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), beforeManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);

    const preview = await runDeclaredUninstall(
      selected,
      root,
      ['portable-beta', 'portable-alpha'],
      { dryRun: true, continueOnError: true },
    );
    expect(preview.plan.operations.map(({ kind }) => kind)).toEqual([
      'write-manifest',
      'write-lock',
      'write-manifest',
      'write-lock',
    ]);
    expect(await readPair(root)).toEqual([beforeManifest, beforeLock]);

    const execution = await runDeclaredUninstall(
      selected,
      root,
      ['portable-beta', 'portable-alpha'],
      { continueOnError: true },
    );
    expect(execution.plan).toEqual(preview.plan);
    const groups = [...new Set(execution.plan.operations.map(({ groupId }) => groupId))];
    expect(groups).toHaveLength(2);
    const firstGroup = execution.plan.operations.filter(({ groupId }) => groupId === groups[0]);
    const secondGroup = execution.plan.operations.filter(({ groupId }) => groupId === groups[1]);
    const prefix = firstGroup.find(({ kind }) => kind === 'write-lock');
    if (prefix === undefined) throw new Error('missing first declaration lock terminal');
    expect(
      secondGroup.every(({ dependencyMetadata }) =>
        dependencyMetadata.operationIds.includes(prefix.operationId),
      ),
    ).toBeTrue();

    const [afterManifest, afterLock] = await readPair(root);
    expect(afterManifest).toContain('# retained top-level comment');
    expect(afterManifest).toContain('name = "retained-gamma"');
    expect(afterManifest).not.toContain('name = "portable-alpha"');
    expect(afterManifest).not.toContain('name = "portable-beta"');
    expect(afterLock).toBe(lockSourceFor(afterManifest, selected.headSha));

    const rerun = await runDeclaredUninstall(selected, root, ['portable-alpha', 'portable-beta']);
    expect(rerun.plan.operations).toEqual([]);
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);
  });

  test('repairs an exact manifest-terminal stale lock and refuses unrelated lock drift', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'manifest-terminal-handoff');
    await mkdir(root, { recursive: true });
    const beforeManifest = manifestSource(['portable-alpha', 'retained-gamma']);
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha);
    const afterManifest = manifestSource(['retained-gamma']);
    const afterLock = lockSourceFor(afterManifest, selected.headSha);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), beforeManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);

    await seedCrashBoundary(root, 'manifest', afterManifest, afterLock);
    expect(await readPair(root)).toEqual([afterManifest, beforeLock]);
    const repaired = await runDeclaredUninstall(selected, root, ['portable-alpha']);
    expect(repaired.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock']);
    expect(repaired.results.every(({ action }) => action === 'noop')).toBeTrue();
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);

    const second = await runDeclaredUninstall(selected, root, ['portable-alpha']);
    expect(second.plan.operations).toEqual([]);
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);

    const unrelatedRoot = join(selected.base, 'unrelated-lock-drift');
    await mkdir(unrelatedRoot, { recursive: true });
    const unrelatedLock = beforeLock.replace(
      /manifest_hash = "sha256:[0-9a-f]+"/u,
      `manifest_hash = "sha256:${'f'.repeat(64)}"`,
    );
    await Promise.all([
      writeFile(join(unrelatedRoot, 'skillsmith.toml'), afterManifest),
      writeFile(join(unrelatedRoot, 'skillsmith.lock'), unrelatedLock),
    ]);
    const refused = await runDeclaredUninstall(selected, unrelatedRoot, ['portable-alpha']);
    expect(refused.plan.operations).toEqual([]);
    expect(refused.results.every(({ action }) => action === 'refused')).toBeTrue();
    expect(await readPair(unrelatedRoot)).toEqual([afterManifest, unrelatedLock]);
  });

  test('a lock-terminal crash is already converged and pre-start cancellation is zero-write', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'lock-terminal-handoff');
    await mkdir(root, { recursive: true });
    const beforeManifest = manifestSource(['portable-alpha', 'retained-gamma']);
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha);
    const afterManifest = manifestSource(['retained-gamma']);
    const afterLock = lockSourceFor(afterManifest, selected.headSha);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), beforeManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);
    await seedCrashBoundary(root, 'lock', afterManifest, afterLock);
    expect(
      (await runDeclaredUninstall(selected, root, ['portable-alpha'])).plan.operations,
    ).toEqual([]);
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);

    const cancellationRoot = join(selected.base, 'cancelled-before-start');
    await mkdir(cancellationRoot, { recursive: true });
    await Promise.all([
      writeFile(join(cancellationRoot, 'skillsmith.toml'), beforeManifest),
      writeFile(join(cancellationRoot, 'skillsmith.lock'), beforeLock),
    ]);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runUninstall(
      selected.env,
      {
        targets: ['portable-alpha'],
        tools: ['claude-code'],
        file: join(cancellationRoot, 'skillsmith.toml'),
        lockfile: join(cancellationRoot, 'skillsmith.lock'),
        cwd: selected.base,
        configuration: selected.configuration,
        signal: controller.signal,
      },
      await depsFor(selected, 'cancelled-before-start'),
    );
    expect(cancelled.ok).toBeFalse();
    expect(await readPair(cancellationRoot)).toEqual([beforeManifest, beforeLock]);
  });
});
