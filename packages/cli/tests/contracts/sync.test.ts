import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SYNC_SECRET_CANARIES,
  type SyncFleet,
  createSyncFleet,
  destroySyncFleet,
  readSkillBytes,
  runSyncCli,
} from '../../../../tests/ergonomics/fixtures/p5-sync/fleet.ts';
import type { RelevantCapabilityQueryV1 } from '../../../core/src/agents/capabilities.ts';
import { toolRegistry } from '../../../core/src/agents/registry.ts';
import { runSyncApplication } from '../../../core/src/application/sync-service.ts';
import type { CurrentApplicationContext } from '../../../core/src/application/types.ts';
import { hashManifestSemantics } from '../../../core/src/artifacts/hash.ts';
import type { LedgerModel } from '../../../core/src/artifacts/ledger-types.ts';
import type { PortableLockV1 } from '../../../core/src/artifacts/lock.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../core/src/artifacts/node-coordinator.ts';
import { resolveArtifactPair } from '../../../core/src/artifacts/pair.ts';
import {
  operationMatchesMatrix,
  validatePlanOperationIntentShapeV1,
  validatePlanOperationIntentV1,
} from '../../../core/src/artifacts/plan-codec.ts';
import type { PlanOperationV1 } from '../../../core/src/artifacts/plan-types.ts';
import { artifactContractRegistry } from '../../../core/src/artifacts/registry.ts';
import type { NormalizedManifestV1 } from '../../../core/src/artifacts/types.ts';
import { resolveRuntimeConfiguration } from '../../../core/src/config/runtime.ts';
import { resolveProjectContext } from '../../../core/src/context/project.ts';
import {
  type SyncPairResultV1Dto,
  type SyncReportV1Dto,
  syncV1Codec,
} from '../../../core/src/contracts/v1/sync.ts';
import { scheduleOperationPlan } from '../../../core/src/execution/scheduler.ts';
import {
  createExplicitPlacementProjectLocationV1,
  createPlacementSnapshotAuthority,
} from '../../../core/src/place/execute.ts';
import { emptyLedgerModel, getLedgerPairAt, writeLedger } from '../../../core/src/place/ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../../../core/src/place/paths.ts';
import {
  contentHashOf,
  resolveProvenance,
  snapshotToStore,
} from '../../../core/src/place/store.ts';
import { resumeSwap, runSwap } from '../../../core/src/place/swap.ts';
import type { SwapRequest } from '../../../core/src/place/types.ts';
import { createOperationExecutionResult } from '../../../core/src/planning/create.ts';
import type {
  ExecutableOperation,
  OperationDigest,
  OperationPlan,
} from '../../../core/src/planning/types.ts';
import { defaultRuntimePorts } from '../../../core/src/ports/default.ts';
import type { RuntimePorts } from '../../../core/src/ports/types.ts';
import { prepareSyncArtifactsV1 } from '../../../core/src/sync/artifacts.ts';
import { resolveSyncEndpoints } from '../../../core/src/sync/endpoints.ts';
import {
  prepareSyncStoreResourcesV1,
  toSyncReportOperationV1,
} from '../../../core/src/sync/internal-projections.ts';
import { observeSyncFleet } from '../../../core/src/sync/observe.ts';
import {
  createSyncPlan,
  projectSyncFleetPlanV1,
  selectSyncFleetResourcesV1,
} from '../../../core/src/sync/plan.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import {
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';
import { exitCodeForClass } from '../../src/runtime/adapter.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

const openFleets: SyncFleet[] = [];

afterEach(async () => {
  await Promise.all(openFleets.splice(0).map(destroySyncFleet));
});

const fleet = async (): Promise<SyncFleet> => {
  const selected = await createSyncFleet();
  openFleets.push(selected);
  return selected;
};

const syncApplicationContext = async (
  selected: SyncFleet,
  artifactCoordinator: Awaited<ReturnType<typeof createTestNodeArtifactCoordinatorPorts>>,
): Promise<CurrentApplicationContext> => {
  const base = await defaultRuntimePorts();
  const ports: RuntimePorts = {
    ...base,
    homeDir: selected.home,
    xdg: {
      config: selected.config,
      data: selected.data,
      cache: selected.cache,
    },
  };
  return {
    ports,
    artifactCoordinator,
    configuration: resolveRuntimeConfiguration(selected.env),
    invocationCwd: selected.cwd,
    globalOptions: {},
    interaction: {
      mode: 'noninteractive',
      choose: async () => ({ status: 'refused', reason: 'unused' }),
      confirm: async () => ({ status: 'resolved', value: true }),
    },
  } as unknown as CurrentApplicationContext;
};

const syncReport = async (
  selected: SyncFleet,
  args: readonly string[],
  expectedExit = 0,
): Promise<SyncReportV1Dto> => {
  expect((await readSkillBytes(selected.skills.userLint)).byteLength).toBeGreaterThan(0);
  const product = await runSyncCli(selected, [...args, '--json']);
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  const decoded = syncV1Codec.decode(product.stdout);
  expect(decoded.ok, product.stdout).toBeTrue();
  if (!decoded.ok) throw new Error(decoded.error.message);
  return decoded.value;
};

const syncError = async (
  selected: SyncFleet,
  args: readonly string[],
  expectedExit = 2,
): Promise<Readonly<Record<string, unknown>>> => {
  const product = await runSyncCli(selected, [...args, '--json']);
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  const parsed: unknown = JSON.parse(product.stdout);
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    kind: 'error',
    exitCode: expectedExit,
  });
  return parsed as Readonly<Record<string, unknown>>;
};

const pairs = (report: SyncReportV1Dto): readonly SyncPairResultV1Dto[] =>
  report.groups.flatMap(({ pairs: groupPairs }) => groupPairs);

const present = async (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

const readLedger = async (selected: SyncFleet): Promise<LedgerModel> =>
  JSON.parse(await readFile(selected.ledger, 'utf8')) as LedgerModel;

const waitForOpenTransaction = async (selected: SyncFleet): Promise<LedgerModel> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const ledger = await readLedger(selected);
      if (Object.keys(ledger.transactions).length > 0) return ledger;
    } catch {
      // The writer publishes atomically; retry if the observation races fixture setup.
    }
    await Bun.sleep(1);
  }
  throw new Error('sync runtime never exposed a prepared transaction');
};

const addSlowRuntimeSources = async (
  selected: SyncFleet,
): Promise<Readonly<Record<string, string>>> => {
  const roots: Record<string, string> = {
    lint: selected.skills.userLint,
    review: selected.skills.userReview,
    tail: join(selected.home, '.agents', 'skills', 'tail'),
  };
  await mkdir(roots.tail as string, { recursive: true });
  await writeFile(
    join(roots.tail as string, 'SKILL.md'),
    '---\nname: tail\ndescription: runtime tail fixture\n---\n\n# tail\n',
  );
  for (const root of Object.values(roots)) {
    const payload = join(root, 'payload');
    await mkdir(payload, { recursive: true });
    await Promise.all(
      Array.from({ length: 800 }, (_, index) =>
        writeFile(
          join(payload, `${String(index).padStart(4, '0')}.txt`),
          `${String(index).padStart(4, '0')}:${'x'.repeat(4096)}\n`,
        ),
      ),
    );
  }
  return Object.freeze(roots);
};

const spawnedSyncProduct = async (
  selected: SyncFleet,
  args: readonly string[],
  afterPrepared: (child: ReturnType<typeof Bun.spawn>) => Promise<void>,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> => {
  const child = Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args], {
    cwd: selected.cwd,
    env: hermeticGitEnv(selected.env),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await waitForOpenTransaction(selected);
  await afterPrepared(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return Object.freeze({ exitCode, stdout, stderr });
};

const decodeSyncProduct = (
  product: Readonly<{ exitCode: number; stdout: string; stderr: string }>,
): SyncReportV1Dto => {
  const decoded = syncV1Codec.decode(product.stdout);
  expect(decoded.ok, `${product.stderr}\n${product.stdout}`).toBeTrue();
  if (!decoded.ok) throw new Error(decoded.error.message);
  return decoded.value;
};

const seedDestinationOnlyDeclaration = async (selected: SyncFleet): Promise<void> => {
  const manifestCodec = artifactContractRegistry.get('manifest', 1);
  const lockCodec = artifactContractRegistry.get('lock', 1);
  if (manifestCodec === undefined || lockCodec === undefined) {
    throw new Error('portable artifact codecs are unavailable');
  }
  const decodedManifest = manifestCodec.decode(
    new Uint8Array(await readFile(selected.artifacts.explicitManifest)),
  );
  const decodedLock = lockCodec.decode(
    new Uint8Array(await readFile(selected.artifacts.explicitLock)),
  );
  if (!decodedManifest.ok || !decodedLock.ok)
    throw new Error('portable artifact fixture is invalid');
  const beforeManifest = decodedManifest.value.model as NormalizedManifestV1;
  const beforeLock = decodedLock.value.model as PortableLockV1;
  const declaration = beforeManifest.skills.find(({ name }) => name === 'lint');
  const lockEntry = beforeLock.skills.find(({ name }) => name === 'lint');
  if (declaration === undefined || lockEntry === undefined) {
    throw new Error('portable artifact fixture lacks lint');
  }
  const manifest: NormalizedManifestV1 = Object.freeze({
    ...beforeManifest,
    skills: Object.freeze([
      ...beforeManifest.skills,
      Object.freeze({ ...declaration, name: 'extra' }),
    ]),
  });
  const lock: PortableLockV1 = Object.freeze({
    ...beforeLock,
    manifestHash: hashManifestSemantics(manifest),
    skills: Object.freeze([...beforeLock.skills, Object.freeze({ ...lockEntry, name: 'extra' })]),
  });
  const encodedManifest = manifestCodec.encode(manifest);
  const encodedLock = lockCodec.encode(lock);
  if (!encodedManifest.ok || !encodedLock.ok) throw new Error('portable fixture encoding failed');
  await Promise.all([
    writeFile(selected.artifacts.explicitManifest, encodedManifest.value),
    writeFile(selected.artifacts.explicitLock, encodedLock.value),
  ]);
};

describe('sync command contract', () => {
  test('EWP-CMD-SYNC-TS01 — mandatory endpoints and bounded selection', async () => {
    const selected = await fleet();
    const sourceBefore = await readSkillBytes(selected.skills.userLint);
    const ledgerBefore = await readFile(selected.ledger, 'utf8');
    const relative = await syncReport(selected, [
      'sync',
      '--from',
      'user',
      '--to',
      '../project-b',
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(relative).toMatchObject({
      mode: 'dry-run',
      endpoints: {
        from: { kind: 'user', scope: 'user', projectRoot: null },
        to: { scope: 'project', projectRoot: selected.projects.b },
      },
      selection: { selectionSource: 'bounded-default' },
    });

    const endpointMatrix = [
      {
        args: ['sync', '--from', 'project', '--to', 'user', '--tool', 'codex', '--dry-run'],
        from: { scope: 'project', projectRoot: selected.projects.current },
        to: { scope: 'user', projectRoot: null },
      },
      {
        args: [
          'sync',
          'lint',
          '--from',
          selected.projects.a,
          '--to',
          selected.projects.c,
          '--tool',
          'codex',
          '--dry-run',
        ],
        from: { scope: 'project', projectRoot: selected.projects.a },
        to: { scope: 'project', projectRoot: selected.projects.c },
      },
      {
        args: [
          'sync',
          'lint',
          '--from',
          selected.projects.a,
          '--to',
          'user',
          '--tool',
          'codex',
          '--dry-run',
        ],
        from: { scope: 'project', projectRoot: selected.projects.a },
        to: { scope: 'user', projectRoot: null },
      },
      {
        args: [
          'sync',
          '--from',
          'system',
          '--to',
          selected.projects.c,
          '--tool',
          'codex',
          '--dry-run',
        ],
        from: { scope: 'system', projectRoot: null },
        to: { scope: 'project', projectRoot: selected.projects.c },
      },
      {
        args: [
          'sync',
          'policy',
          '--from',
          'managed',
          '--to',
          selected.projects.c,
          '--tool',
          'claude-code',
          '--dry-run',
        ],
        from: { scope: 'managed', projectRoot: null },
        to: { scope: 'project', projectRoot: selected.projects.c },
      },
    ] as const;
    for (const row of endpointMatrix) {
      const report = await syncReport(selected, row.args);
      expect(report.endpoints).toMatchObject({ from: row.from, to: row.to });
    }

    const invalidMatrix = [
      ['sync', '--to', selected.projects.c, '--tool', 'codex', '--dry-run'],
      ['sync', '--from', 'user', '--tool', 'codex', '--dry-run'],
      ['sync', '--from', 'user', '--from', 'system', '--to', selected.projects.c, '--dry-run'],
      ['sync', '--from', 'user', '--to', selected.projects.c, '--to', 'user', '--dry-run'],
      ['sync', '--from', 'user', '--to', 'system', '--tool', 'codex', '--dry-run'],
      ['sync', '--from', 'user', '--to', 'managed', '--tool', 'codex', '--dry-run'],
      [
        'sync',
        '--from',
        selected.projects.b,
        '--to',
        selected.projects.bAlias,
        '--tool',
        'codex',
        '--dry-run',
      ],
      [
        'sync',
        '--from',
        'user',
        '--to',
        selected.projects.c,
        '--tool',
        'codex',
        '--yes',
        '--dry-run',
      ],
    ] as const;
    for (const args of invalidMatrix) await syncError(selected, args);
    expect(await readSkillBytes(selected.skills.userLint)).toEqual(sourceBefore);
    expect(await readFile(selected.ledger, 'utf8')).toBe(ledgerBefore);
  }, 25_000);

  test('EWP-CMD-SYNC-TS02 — user and project additions converge', async () => {
    const selected = await fleet();
    const userSource = await readSkillBytes(selected.skills.userLint);
    const projectSource = await readSkillBytes(selected.skills.projectAReview);
    const userToProject = [
      'sync',
      'lint',
      '--from',
      'user',
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
    ] as const;
    const addedToProject = await syncReport(selected, userToProject);
    expect(addedToProject).toMatchObject({
      state: 'completed',
      summary: { changed: 1, failed: 0, cancelled: 0 },
    });
    expect(pairs(addedToProject)).toEqual([
      expect.objectContaining({ action: 'install', outcome: 'succeeded' }),
    ]);
    expect(await readSkillBytes(join(selected.projects.c, '.agents', 'skills', 'lint'))).toEqual(
      userSource,
    );

    await rm(selected.skills.userReview, { recursive: true });
    const projectToUser = [
      'sync',
      'review',
      '--from',
      selected.projects.a,
      '--to',
      'user',
      '--tool',
      'codex',
    ] as const;
    const addedToUser = await syncReport(selected, projectToUser);
    expect(addedToUser).toMatchObject({
      state: 'completed',
      summary: { changed: 1 },
    });
    expect(await readSkillBytes(selected.skills.userReview)).toEqual(projectSource);

    const ledger = await readLedger(selected);
    const projectPair = ledger.projects[selected.projects.c]?.skills.lint?.tools.codex;
    const userPair = ledger.skills.review?.tools.codex;
    expect(projectPair).toMatchObject({ mode: 'pinned', journal: null });
    expect(userPair).toMatchObject({ mode: 'pinned', journal: null });
    expect(projectPair).not.toHaveProperty('origin');
    expect(userPair).not.toHaveProperty('origin');
    expect(await present(projectPair?.pinned?.storePath ?? '')).toBeTrue();
    expect(await present(userPair?.pinned?.storePath ?? '')).toBeTrue();
    expect(ledger.history.slice(-2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'committed',
          intent: expect.objectContaining({}),
        }),
      ]),
    );

    for (const args of [userToProject, projectToUser]) {
      const rerun = await syncReport(selected, args);
      expect(rerun).toMatchObject({
        state: 'completed',
        summary: { changed: 0, unchanged: 1, failed: 0 },
      });
      expect(pairs(rerun)).toEqual([
        expect.objectContaining({ action: 'noop', outcome: 'succeeded' }),
      ]);
    }
    expect(await readSkillBytes(selected.skills.userLint)).toEqual(userSource);
    expect(await readSkillBytes(selected.skills.projectAReview)).toEqual(projectSource);
  }, 25_000);

  test('EWP-CMD-SYNC-TS03 — project A, B, and C remain distinct', async () => {
    const selected = await fleet();
    const cwdBefore = process.cwd();
    const sourceBefore = await readSkillBytes(selected.skills.projectALint);
    const reports: SyncReportV1Dto[] = [];
    for (const destination of [selected.projects.b, selected.projects.c]) {
      reports.push(
        await syncReport(selected, [
          'sync',
          'lint',
          '--from',
          selected.projects.a,
          '--to',
          destination,
          '--tool',
          'codex',
          '--yes',
        ]),
      );
    }
    for (const [index, report] of reports.entries()) {
      const destination = [selected.projects.b, selected.projects.c][index];
      expect(report.endpoints).toMatchObject({
        from: { projectRoot: selected.projects.a },
        to: { projectRoot: destination },
      });
      expect(JSON.stringify(report.endpoints)).not.toContain(
        index === 0 ? selected.projects.c : selected.projects.b,
      );
    }
    expect(reports[0]?.operations.map(({ operationId }) => operationId)).not.toEqual(
      reports[1]?.operations.map(({ operationId }) => operationId),
    );
    expect(await readSkillBytes(join(selected.projects.b, '.agents', 'skills', 'lint'))).toEqual(
      sourceBefore,
    );
    expect(await readSkillBytes(join(selected.projects.c, '.agents', 'skills', 'lint'))).toEqual(
      sourceBefore,
    );
    const ledger = await readLedger(selected);
    expect(Object.keys(ledger.projects).sort()).toEqual(
      [selected.projects.a, selected.projects.b, selected.projects.c].sort(),
    );
    expect(ledger.projects).not.toHaveProperty(selected.projects.bAlias);
    expect(ledger.projects).not.toHaveProperty(selected.projects.current);
    await syncError(selected, [
      'sync',
      '--from',
      selected.projects.b,
      '--to',
      selected.projects.bAlias,
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(process.cwd()).toBe(cwdBefore);
    expect(await readSkillBytes(selected.skills.projectALint)).toEqual(sourceBefore);
  }, 20_000);

  test('EWP-CMD-SYNC-TS04 — filtering and capability refusal stay bounded', async () => {
    const selected = await fleet();
    const extraBefore = await readSkillBytes(selected.skills.projectBExtra);
    const selectedTools = await syncReport(selected, [
      'sync',
      'review',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--tool',
      'claude-code',
      '--dry-run',
    ]);
    expect(selectedTools.selection.tools).toEqual(['claude-code', 'codex']);
    expect(selectedTools.groups).toHaveLength(1);
    expect(selectedTools.groups[0]?.pairs.map(({ tool }) => tool)).toEqual([
      'claude-code',
      'codex',
    ]);
    const deduplicated = await syncReport(selected, [
      'sync',
      '--from',
      'user',
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(deduplicated.selection.tools).toEqual(['codex']);
    expect(deduplicated.groups.every(({ pairs }) => pairs.length === 1)).toBeTrue();

    const managed = await syncReport(selected, [
      'sync',
      'policy',
      '--from',
      'managed',
      '--to',
      selected.projects.c,
      '--tool',
      'claude-code',
      '--dry-run',
    ]);
    expect(managed.selection).toMatchObject({
      skills: ['policy'],
      tools: ['claude-code'],
    });
    const system = await syncReport(selected, [
      'sync',
      '--from',
      'system',
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(system.selection).toMatchObject({
      selectionOutcome: 'filter-noop',
      skills: [],
    });

    for (const tool of ['kilo-code', 'opencode'] as const) {
      const refused = await syncReport(
        selected,
        [
          'sync',
          'lint',
          '--from',
          'user',
          '--to',
          selected.projects.c,
          '--tool',
          tool,
          '--dry-run',
        ],
        4,
      );
      expect(refused).toMatchObject({
        state: 'refused',
        summary: { refusals: 1 },
      });
      expect(refused.selection.tools).toEqual([tool]);
      expect(refused.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'refuse',
            severity: 'error',
            refusalClass: 'capability',
            affected: expect.objectContaining({ tool }),
          }),
        ]),
      );
    }
    const unmatched = await syncReport(selected, [
      'sync',
      'absent',
      '--from',
      'user',
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--force',
      '--delete',
      '--dry-run',
    ]);
    expect(unmatched.selection).toMatchObject({
      selectionOutcome: 'filter-noop',
      skills: [],
    });
    expect(unmatched.groups).toHaveLength(0);
    expect(unmatched.operations).toHaveLength(0);
    expect(await readSkillBytes(selected.skills.projectBExtra)).toEqual(extraBefore);

    const human = await runSyncCli(selected, [
      'sync',
      'review',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--tool',
      'claude-code',
      '--dry-run',
    ]);
    expect(human.exitCode, human.stderr).toBe(0);
    expect(human.stdout).toContain('review');
    expect(human.stdout).toContain('claude-code');
    expect(human.stdout).toContain('codex');
  }, 25_000);

  test('EWP-CMD-SYNC-TS05 — force is a selected destination override', async () => {
    const selected = await fleet();
    const source = await readSkillBytes(selected.skills.userReview);
    const destination = await readSkillBytes(selected.skills.projectBReview);
    const conflictArgs = [
      'sync',
      'review',
      '--from',
      'user',
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
    ] as const;
    const refused = await syncReport(selected, [...conflictArgs, '--dry-run']);
    expect(refused).toMatchObject({
      state: 'refused',
      summary: { refusals: 1 },
    });
    expect(pairs(refused)).toEqual([
      expect.objectContaining({
        action: 'refuse',
        outcome: 'not-run',
        force: expect.objectContaining({
          requested: false,
          used: false,
          conflictType: 'unmanaged-target',
          normal: 'refuse',
          forced: 'backup-and-replace',
          required: true,
        }),
      }),
    ]);

    const forced = await syncReport(selected, [...conflictArgs, '--force', '--dry-run']);
    expect(forced).toMatchObject({
      state: 'ready',
      options: { force: true, delete: false },
    });
    expect(pairs(forced)[0]?.force).toMatchObject({
      requested: true,
      used: true,
      outcome: 'planned',
    });
    expect(forced.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'backup', outcome: 'planned' })]),
    );
    const forcedPair = pairs(forced)[0];
    const forcedOperation = forced.operations[0];
    if (forcedPair === undefined || forcedOperation === undefined) {
      throw new Error('forced sync preview omitted its selected pair or operation');
    }
    const humanForce = await runSyncCli(selected, [...conflictArgs, '--force', '--dry-run']);
    expect(humanForce.exitCode, humanForce.stderr).toBe(0);
    expect(humanForce.stdout).toContain(
      'Options: force=true delete=false save=false dry-run=true continue-on-error=false',
    );
    expect(humanForce.stdout).toContain(`group: ${forced.groups[0]?.groupId} (review)`);
    expect(humanForce.stdout).toContain(`${forcedOperation.operationId} update review / codex`);
    expect(humanForce.stdout).toContain("conflictType: 'unmanaged-target'");
    expect(humanForce.stdout).toContain("forced: 'backup-and-replace'");
    expect(humanForce.stdout).toContain('requested: true');
    expect(humanForce.stdout).toContain('used: true');
    for (const effect of forced.effects) {
      expect(humanForce.stdout).toContain(`action: '${effect.action}'`);
      expect(humanForce.stdout).toContain(`operationId: '${effect.operationId}'`);
      expect(humanForce.stdout).toContain(`outcome: '${effect.outcome}'`);
      expect(humanForce.stdout).toContain(`role: '${effect.role}'`);
    }
    expect(humanForce.stdout).toContain(
      `Summary exact: { cancelled: 0, changed: ${forced.summary.changed}, drift: ${forced.summary.drift}, effects: ${forced.summary.effects}`,
    );
    for (const canary of SYNC_SECRET_CANARIES) {
      expect(`${humanForce.stdout}${humanForce.stderr}`).not.toContain(canary);
    }
    const approval = await syncReport(selected, [...conflictArgs, '--force'], 2);
    expect(approval.approval).toEqual({ required: true, outcome: 'refused' });
    expect(await readSkillBytes(selected.skills.projectBReview)).toEqual(destination);
    const ledgerBefore = await readFile(selected.ledger, 'utf8');
    await syncError(selected, [...conflictArgs, '--force', '--yes', '--dry-run']);
    expect(await readFile(selected.ledger, 'utf8')).toBe(ledgerBefore);

    const unused = await syncReport(selected, [
      'sync',
      'lint',
      '--from',
      'user',
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--force',
      '--dry-run',
    ]);
    expect(pairs(unused)[0]?.force).toMatchObject({
      requested: true,
      used: false,
    });
    expect(unused.effects.some(({ role }) => role === 'backup')).toBeFalse();

    const applied = await syncReport(selected, [...conflictArgs, '--force', '--yes']);
    expect(applied.approval).toEqual({ required: true, outcome: 'approved' });
    expect(pairs(applied)[0]?.force).toMatchObject({
      used: true,
      outcome: 'succeeded',
    });
    expect(await readSkillBytes(selected.skills.projectBReview)).toEqual(source);
    await writeFile(join(selected.skills.projectBReview, 'SKILL.md'), 'locally edited\n');
    const edited = await syncReport(selected, [...conflictArgs, '--dry-run']);
    expect(pairs(edited)[0]?.force).toMatchObject({
      conflictType: 'modified-managed-target',
      normal: 'refuse',
    });
    await syncReport(selected, [...conflictArgs, '--force', '--yes']);
    expect(await readSkillBytes(selected.skills.projectBReview)).toEqual(source);
  }, 30_000);

  test('EWP-CMD-SYNC-TS06 — destination-only deletion is explicit', async () => {
    const selected = await fleet();
    const sourceBefore = await readSkillBytes(selected.skills.projectALint);
    const additive = await syncReport(selected, [
      'sync',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(additive.options).toMatchObject({ force: false, delete: false });
    expect(additive.groups.map(({ skill }) => skill)).not.toContain('extra');
    expect(await present(selected.skills.projectBExtra)).toBeTrue();

    const deletionRefused = await syncReport(selected, [
      'sync',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--delete',
      '--dry-run',
    ]);
    const extraRefusal = deletionRefused.groups.find(({ skill }) => skill === 'extra');
    expect(extraRefusal?.pairs[0]).toMatchObject({
      action: 'refuse',
      force: { required: true, conflictType: 'unmanaged-target' },
    });

    const forcedDeletion = await syncReport(selected, [
      'sync',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--delete',
      '--force',
      '--dry-run',
    ]);
    expect(forcedDeletion.options).toMatchObject({ force: true, delete: true });
    expect(forcedDeletion.groups.find(({ skill }) => skill === 'extra')?.pairs[0]).toMatchObject({
      action: 'remove',
      outcome: 'planned',
      force: { used: true },
    });
    expect(forcedDeletion.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'backup', outcome: 'planned' })]),
    );

    const explicit = await syncReport(selected, [
      'sync',
      'lint',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--delete',
      '--force',
      '--dry-run',
    ]);
    expect(explicit.groups.map(({ skill }) => skill)).toEqual(['lint']);
    const unmatched = await syncReport(selected, [
      'sync',
      'absent',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--delete',
      '--force',
      '--dry-run',
    ]);
    expect(unmatched).toMatchObject({
      selection: { selectionOutcome: 'filter-noop' },
      summary: { groups: 0, changed: 0 },
    });

    const deleted = await syncReport(selected, [
      'sync',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--delete',
      '--force',
      '--yes',
    ]);
    expect(deleted.groups.find(({ skill }) => skill === 'extra')?.pairs[0]).toMatchObject({
      action: 'remove',
      outcome: 'succeeded',
    });
    expect(await present(selected.skills.projectBExtra)).toBeFalse();
    expect(await readSkillBytes(selected.skills.projectALint)).toEqual(sourceBefore);
  }, 25_000);

  test('EWP-CMD-SYNC-TS07 — save selects one exact destination pair', async () => {
    const selected = await fleet();
    const sourceBefore = await readSkillBytes(selected.skills.projectALint);
    const grammarMatrix = [
      [
        'sync',
        'lint',
        '--from',
        selected.projects.a,
        '--to',
        selected.projects.c,
        '--tool',
        'codex',
        '--file',
        selected.artifacts.explicitManifest,
        '--dry-run',
      ],
      [
        'sync',
        'lint',
        '--from',
        selected.projects.a,
        '--to',
        selected.projects.c,
        '--tool',
        'codex',
        '--lockfile',
        selected.artifacts.explicitLock,
        '--dry-run',
      ],
      [
        'sync',
        'lint',
        '--from',
        selected.projects.a,
        '--to',
        selected.projects.c,
        '--tool',
        'codex',
        '--save',
        '--lockfile',
        selected.artifacts.explicitLock,
        '--dry-run',
      ],
      [
        'sync',
        'lint',
        '--from',
        selected.projects.a,
        '--to',
        selected.projects.c,
        '--tool',
        'codex',
        '--save',
        '--file',
        selected.artifacts.explicitManifest,
        '--file',
        selected.artifacts.legacyManifest,
        '--dry-run',
      ],
      [
        'sync',
        'lint',
        '--from',
        selected.projects.a,
        '--to',
        selected.projects.c,
        '--tool',
        'codex',
        '--save',
        '--file',
        selected.artifacts.explicitManifest,
        '--lockfile',
        selected.artifacts.explicitLock,
        '--lockfile',
        `${selected.root}/other.lock`,
        '--dry-run',
      ],
    ] as const;
    for (const args of grammarMatrix) await syncError(selected, args);
    expect(await present(selected.artifacts.explicitManifest)).toBeFalse();
    expect(await present(selected.artifacts.explicitLock)).toBeFalse();

    const report = await syncReport(selected, [
      'sync',
      'lint',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--save',
      '--file',
      selected.artifacts.explicitManifest,
      '--lockfile',
      selected.artifacts.explicitLock,
      '--dry-run',
    ]);
    expect(report).toMatchObject({
      options: { save: true },
      artifactPair: {
        manifestPath: selected.artifacts.explicitManifest,
        lockPath: selected.artifacts.explicitLock,
        lockSource: 'explicit',
        selectionSource: 'explicit',
      },
    });
    expect(report.effects.map(({ role }) => role)).toContain('manifest');
    expect(report.effects.map(({ role }) => role)).toContain('lock');

    await syncReport(selected, [
      'sync',
      'lint',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--save',
      '--file',
      selected.artifacts.explicitManifest,
      '--lockfile',
      selected.artifacts.explicitLock,
      '--yes',
    ]);
    const manifestCodec = artifactContractRegistry.get('manifest', 1);
    const lockCodec = artifactContractRegistry.get('lock', 1);
    if (manifestCodec === undefined || lockCodec === undefined) throw new Error('missing codecs');
    const createdManifest = manifestCodec.decode(
      new Uint8Array(await readFile(selected.artifacts.explicitManifest)),
    );
    const createdLock = lockCodec.decode(
      new Uint8Array(await readFile(selected.artifacts.explicitLock)),
    );
    expect(createdManifest.ok).toBeTrue();
    expect(createdLock.ok).toBeTrue();
    if (!createdManifest.ok || !createdLock.ok) throw new Error('created artifact did not decode');
    const createdDeclaration = (createdManifest.value.model as NormalizedManifestV1).skills[0];
    const createdEntry = (createdLock.value.model as PortableLockV1).skills[0];
    expect(createdDeclaration).toMatchObject({
      name: 'lint',
      source: {
        host: 'fixture.invalid',
        repository: 'acme/project-a',
        path: 'skill-sources/codex/lint',
      },
      tools: ['codex'],
      scope: 'project',
    });
    expect(createdDeclaration?.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(createdEntry).toMatchObject({
      name: 'lint',
      source: 'fixture.invalid/acme/project-a//skill-sources/codex/lint',
      requestedRef: createdDeclaration?.ref,
      resolvedSha: createdDeclaration?.ref,
      sourcePath: 'skill-sources/codex/lint',
    });

    const preservedComment = '# preserve-this-team-comment\n';
    await writeFile(
      selected.artifacts.explicitManifest,
      `${preservedComment}${await readFile(selected.artifacts.explicitManifest, 'utf8')}`,
    );
    await syncReport(selected, [
      'sync',
      'review',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--save',
      '--file',
      selected.artifacts.explicitManifest,
      '--lockfile',
      selected.artifacts.explicitLock,
      '--yes',
    ]);
    const mergedManifestBytes = await readFile(selected.artifacts.explicitManifest, 'utf8');
    expect(mergedManifestBytes).toContain(preservedComment.trim());
    expect(mergedManifestBytes).toContain('name = "lint"');
    expect(mergedManifestBytes).toContain('name = "review"');

    await seedDestinationOnlyDeclaration(selected);
    const deleted = await syncReport(selected, [
      'sync',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--force',
      '--delete',
      '--save',
      '--file',
      selected.artifacts.explicitManifest,
      '--lockfile',
      selected.artifacts.explicitLock,
      '--yes',
    ]);
    expect(deleted).toMatchObject({ options: { delete: true, save: true } });
    expect(
      new Set((deleted.effects as readonly Readonly<{ role: string }>[]).map(({ role }) => role)),
    ).toEqual(new Set(['manifest', 'lock', 'store', 'backup', 'live', 'ledger']));
    expect(await readFile(selected.artifacts.explicitManifest, 'utf8')).not.toContain(
      'name = "extra"',
    );
    expect(await readFile(selected.artifacts.explicitLock, 'utf8')).not.toContain(
      '"name": "extra"',
    );
    expect(
      await lstat(selected.skills.projectBExtra).then(
        () => 'present',
        () => 'absent',
      ),
    ).toBe('absent');

    const legacy = await fleet();
    const migrated = await syncReport(legacy, [
      'sync',
      'lint',
      '--from',
      legacy.projects.a,
      '--to',
      legacy.projects.c,
      '--tool',
      'codex',
      '--save',
      '--file',
      legacy.artifacts.legacyManifest,
      '--yes',
    ]);
    expect(migrated.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'migrate-project-config' })]),
    );
    expect(await readFile(legacy.artifacts.legacyManifest, 'utf8')).toStartWith('version = 1');

    const defaults = await fleet();
    const destinationPair = await syncReport(defaults, [
      'sync',
      'lint',
      '--from',
      defaults.projects.a,
      '--to',
      defaults.projects.c,
      '--tool',
      'codex',
      '--save',
      '--dry-run',
    ]);
    expect(destinationPair.artifactPair).toEqual({
      manifestPath: join(defaults.projects.c, 'skillsmith.toml'),
      lockPath: join(defaults.projects.c, 'skillsmith.lock'),
      lockSource: 'sibling',
      selectionSource: 'destination-project',
    });

    const portableConflict = await fleet();
    const malformed = 'version = [ definitely-not-portable\n';
    await writeFile(portableConflict.artifacts.explicitManifest, malformed);
    const portableSourceBefore = await readSkillBytes(portableConflict.skills.projectALint);
    await syncError(
      portableConflict,
      [
        'sync',
        'lint',
        '--from',
        portableConflict.projects.a,
        '--to',
        portableConflict.projects.c,
        '--tool',
        'codex',
        '--force',
        '--save',
        '--file',
        portableConflict.artifacts.explicitManifest,
        '--lockfile',
        portableConflict.artifacts.explicitLock,
        '--dry-run',
      ],
      3,
    );
    expect(await readFile(portableConflict.artifacts.explicitManifest, 'utf8')).toBe(malformed);
    expect(await readSkillBytes(portableConflict.skills.projectALint)).toEqual(
      portableSourceBefore,
    );
    expect(await readSkillBytes(selected.skills.projectALint)).toEqual(sourceBefore);
  }, 35_000);

  test('EWP-CMD-SYNC-TS08 — preview preserves source bytes and exact options', async () => {
    const selected = await fleet();
    const before = await readSkillBytes(selected.skills.userReview);
    const report = await syncReport(selected, [
      'sync',
      'review',
      '--from',
      'user',
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--force',
      '--delete',
      '--continue-on-error',
      '--dry-run',
    ]);
    expect(await readSkillBytes(selected.skills.userReview)).toEqual(before);
    expect(report).toMatchObject({
      mode: 'dry-run',
      options: { force: true, delete: true, continueOnError: true },
      approval: { required: false, outcome: 'not-required' },
    });
    expect(report.operations.length).toBeGreaterThan(0);
    expect(report.effects.length).toBeGreaterThan(0);
    expect(report.effects.every(({ outcome }) => outcome === 'planned')).toBeTrue();

    const parity = await fleet();
    const parityArgs = [
      'sync',
      'lint',
      '--from',
      parity.projects.a,
      '--to',
      parity.projects.c,
      '--tool',
      'codex',
      '--save',
      '--file',
      parity.artifacts.explicitManifest,
      '--lockfile',
      parity.artifacts.explicitLock,
    ] as const;
    const preview = await syncReport(parity, [...parityArgs, '--dry-run']);
    const execution = await syncReport(parity, [...parityArgs, '--yes']);
    expect(execution.operations).toEqual(preview.operations);
    const artifactPrefix = preview.operations.filter(({ pairId }) => pairId === null);
    const placementSuffix = preview.operations.filter(({ pairId }) => pairId !== null);
    expect(artifactPrefix.map(({ kind }) => kind)).toEqual(['write-manifest', 'write-lock']);
    expect(placementSuffix).toHaveLength(1);
    const manifestOperation = artifactPrefix[0];
    const lockOperation = artifactPrefix[1];
    const placementOperation = placementSuffix[0];
    if (
      manifestOperation === undefined ||
      lockOperation === undefined ||
      placementOperation === undefined
    ) {
      throw new Error('sync save plan omitted its artifact prefix or placement suffix');
    }
    expect(lockOperation.dependsOn).toEqual([manifestOperation.operationId]);
    expect(placementOperation.dependsOn).toEqual([lockOperation.operationId]);
    expect(execution.groups.map(({ groupId }) => groupId)).toEqual(
      preview.groups.map(({ groupId }) => groupId),
    );
    expect(
      execution.effects.map(({ role, action, operationId, groupId }) => ({
        role,
        action,
        operationId,
        groupId,
      })),
    ).toEqual(
      preview.effects.map(({ role, action, operationId, groupId }) => ({
        role,
        action,
        operationId,
        groupId,
      })),
    );

    const legacy = await fleet();
    const legacyBefore = await readFile(legacy.artifacts.legacyManifest, 'utf8');
    const migrationPreview = await syncReport(legacy, [
      'sync',
      'lint',
      '--from',
      legacy.projects.a,
      '--to',
      legacy.projects.c,
      '--tool',
      'codex',
      '--save',
      '--file',
      legacy.artifacts.legacyManifest,
      '--dry-run',
    ]);
    expect(migrationPreview.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'migrate-project-config' })]),
    );
    expect(await readFile(legacy.artifacts.legacyManifest, 'utf8')).toBe(legacyBefore);

    for (const nonportable of [
      [
        'sync',
        'lint',
        '--from',
        'user',
        '--to',
        selected.projects.c,
        '--tool',
        'codex',
        '--save',
        '--dry-run',
      ],
      [
        'sync',
        'review',
        '--from',
        'user',
        '--to',
        selected.projects.c,
        '--tool',
        'codex',
        '--tool',
        'claude-code',
        '--save',
        '--dry-run',
      ],
    ] as const) {
      const error = await syncError(selected, nonportable);
      expect(String(error.message)).toContain('portable');
    }
    const ledgerBefore = await readFile(selected.ledger, 'utf8');
    await syncError(selected, [
      'sync',
      'review',
      '--from',
      'user',
      '--to',
      selected.projects.b,
      '--tool',
      'codex',
      '--force',
      '--yes',
      '--dry-run',
    ]);
    expect(await readFile(selected.ledger, 'utf8')).toBe(ledgerBefore);
    for (const canary of SYNC_SECRET_CANARIES) {
      expect(JSON.stringify([report, preview, execution, migrationPreview])).not.toContain(canary);
    }
  }, 30_000);

  test('EWP-CMD-SYNC-TS09 — group failures and continuation remain truthful', async () => {
    const selected = await fleet();
    const previewArgs = [
      'sync',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--continue-on-error',
      '--dry-run',
    ] as const;
    const first = await syncReport(selected, previewArgs);
    const second = await syncReport(selected, previewArgs);
    expect(second.operations).toEqual(first.operations);
    expect(second.groups).toEqual(first.groups);
    expect(second.effects).toEqual(first.effects);
    expect(new Set(first.groups.map(({ skill }) => skill))).toEqual(new Set(['lint', 'review']));

    const schedulerOperations: readonly ExecutableOperation[] = first.operations.map(
      (operation) =>
        Object.freeze({
          ...operation,
          dependencyMetadata: Object.freeze({
            domain: 'skillsmith.operation-dependency' as const,
            schemaVersion: 1 as const,
            operationIds: operation.dependsOn,
          }),
        }) as unknown as ExecutableOperation,
    );
    const schedulerPlan = (
      batchPolicy: OperationPlan<'sync'>['batchPolicy'],
    ): OperationPlan<'sync'> =>
      Object.freeze({
        domain: 'skillsmith.operation-plan' as const,
        schemaVersion: 1 as const,
        command: 'sync' as const,
        selection: Object.freeze({
          source: first.selection.selectionSource,
          outcome: first.selection.selectionOutcome,
          targets: first.selection.targets,
          skills: first.selection.skills,
          tools: first.selection.tools,
          scopes: Object.freeze(
            [...new Set(schedulerOperations.map(({ scope }) => scope))].filter(
              (scope): scope is NonNullable<typeof scope> => scope !== null,
            ),
          ),
          groupIds: first.selection.groupIds,
        }),
        batchPolicy,
        operations: schedulerOperations,
        checks: [],
        diagnostics: [],
      });
    const binding = (
      operation: ExecutableOperation,
      outcome: 'succeeded' | 'failed',
      onExecute: () => void,
    ) => ({
      operationId: operation.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      actualBefore: operation.before,
      unstartedForce: null,
      execute: async () => {
        onExecute();
        return createOperationExecutionResult({
          operationId: operation.operationId,
          outcome,
          actualBefore: operation.before,
          actualAfter: outcome === 'succeeded' ? operation.after : operation.before,
          force: null,
          error:
            outcome === 'failed'
              ? {
                  code: 'injected-sync-failure',
                  message: 'deterministic scheduler fixture failure',
                  remediation: 'continue with the next selected sync group',
                }
              : null,
        });
      },
    });
    const schedulerCalls: string[] = [];
    const schedulerBindings = schedulerOperations.map((operation, index) =>
      binding(operation, index === 0 ? 'failed' : 'succeeded', () => {
        schedulerCalls.push(operation.operationId);
      }),
    );
    const failFast = await scheduleOperationPlan(schedulerPlan('fail-fast'), schedulerBindings);
    expect(failFast.map(({ outcome }) => outcome)).toEqual(['failed', 'skipped-after-failure']);
    const firstScheduledOperation = schedulerOperations[0];
    if (firstScheduledOperation === undefined) throw new Error('sync scheduler fixture is empty');
    expect(schedulerCalls).toEqual([firstScheduledOperation.operationId]);
    schedulerCalls.splice(0);
    const continued = await scheduleOperationPlan(
      schedulerPlan('continue-on-error'),
      schedulerBindings,
    );
    expect(continued.map(({ outcome }) => outcome)).toEqual(['failed', 'succeeded']);
    expect(schedulerCalls).toEqual(schedulerOperations.map(({ operationId }) => operationId));
    const cancelledController = new AbortController();
    cancelledController.abort();
    const cancelled = await scheduleOperationPlan(
      schedulerPlan('continue-on-error'),
      schedulerBindings,
      {
        signal: cancelledController.signal,
      },
    );
    expect(cancelled.map(({ outcome }) => outcome)).toEqual(['cancelled', 'cancelled']);

    const prefixFleet = await fleet();
    const prefixArgs = [
      'sync',
      '--from',
      prefixFleet.projects.a,
      '--to',
      prefixFleet.projects.c,
      '--tool',
      'codex',
      '--save',
      '--file',
      prefixFleet.artifacts.explicitManifest,
      '--lockfile',
      prefixFleet.artifacts.explicitLock,
    ] as const;
    const prefixPreview = await syncReport(prefixFleet, [...prefixArgs, '--dry-run']);
    const prefixLock = prefixPreview.operations.find(({ kind }) => kind === 'write-lock');
    const prefixedPairs = prefixPreview.operations.filter(({ pairId }) => pairId !== null);
    if (prefixLock === undefined) throw new Error('sync artifact prefix lacks its lock operation');
    expect(prefixedPairs).toHaveLength(2);
    expect(
      prefixedPairs.every(({ dependsOn }) => dependsOn.includes(prefixLock.operationId)),
    ).toBeTrue();
    expect(new Set(prefixedPairs.map(({ groupId }) => groupId)).size).toBe(2);

    let artifactStageFaults = 0;
    const faultingCoordinator = await createTestNodeArtifactCoordinatorPorts(
      join(prefixFleet.root, 'faulting-artifact-coordination'),
      {
        afterPhysicalStep: async (step) => {
          if (artifactStageFaults === 0 && step.area === 'stage' && step.step === 'file-opened') {
            artifactStageFaults++;
            throw Object.assign(new Error('deterministic sync artifact stage failure'), {
              code: 'EIO',
            });
          }
        },
      },
    );
    const prefixContext = await syncApplicationContext(prefixFleet, faultingCoordinator);
    const prefixRequest = {
      arguments: [[]],
      options: {
        from: prefixFleet.projects.a,
        to: prefixFleet.projects.c,
        tool: ['codex'],
        save: true,
        file: prefixFleet.artifacts.explicitManifest,
        lockfile: prefixFleet.artifacts.explicitLock,
      },
    } as const;
    const applicationPreview = await runSyncApplication(
      {
        ...prefixRequest,
        options: { ...prefixRequest.options, dryRun: true },
      },
      prefixContext,
    );
    expect(applicationPreview.exitClass).toBe('success');
    expect(applicationPreview.report.result?.operations).toEqual(prefixPreview.operations);
    expect(artifactStageFaults).toBe(0);
    const prefixLedgerBefore = await readFile(prefixFleet.ledger, 'utf8');
    const prefixFailure = await runSyncApplication(prefixRequest, prefixContext);
    expect(prefixFailure.exitClass).toBe('failure');
    expect(exitCodeForClass(prefixFailure.exitClass)).toBe(1);
    expect(artifactStageFaults).toBe(1);
    const failedPrefixReport = prefixFailure.report.result;
    if (failedPrefixReport === null) throw new Error('sync artifact failure report is missing');
    expect(failedPrefixReport.operations).toEqual(prefixPreview.operations);
    expect(failedPrefixReport).toMatchObject({
      mode: 'execute',
      state: 'partial',
      summary: { succeeded: 0, failed: 1, skipped: 1 },
    });
    const prefixOutcomeBySkill = new Map(
      failedPrefixReport.groups.map((group) => [group.skill, group.pairs[0]] as const),
    );
    const prefixPairOutcomes = [...prefixOutcomeBySkill.values()].filter(
      (pair): pair is SyncPairResultV1Dto => pair !== undefined,
    );
    const failedPrefixPairs = prefixPairOutcomes.filter(({ outcome }) => outcome === 'failed');
    expect(failedPrefixPairs).toHaveLength(1);
    expect(failedPrefixPairs[0]).toMatchObject({
      failure: { code: 'artifact-mutation-filesystem-failure' },
    });
    const skippedPrefixPairs = prefixPairOutcomes.filter(({ outcome }) => outcome === 'skipped');
    expect(skippedPrefixPairs).toHaveLength(1);
    expect(skippedPrefixPairs[0]).toMatchObject({ skipReason: 'skipped-after-failure' });
    const artifactOperationIds = new Set(
      failedPrefixReport.operations
        .filter(({ pairId }) => pairId === null)
        .map(({ operationId }) => operationId),
    );
    expect(
      failedPrefixReport.effects
        .filter(({ operationId }) =>
          operationId === null ? false : artifactOperationIds.has(operationId),
        )
        .map(({ outcome }) => outcome),
    ).toEqual(expect.arrayContaining(['failed', 'not-run']));
    expect(await present(prefixFleet.artifacts.explicitManifest)).toBeFalse();
    expect(await present(prefixFleet.artifacts.explicitLock)).toBeFalse();
    for (const skill of failedPrefixReport.selection.skills) {
      expect(await present(join(prefixFleet.projects.c, '.agents', 'skills', skill))).toBeFalse();
    }
    expect(await readFile(prefixFleet.ledger, 'utf8')).toBe(prefixLedgerBefore);

    const recoveryFleet = await buildFixtureFleet();
    try {
      const recoverySkill = 'sync-recovery';
      const recoveryRoot = join(recoveryFleet.home, '.claude', 'skills');
      const recoveryPlacement = join(recoveryRoot, recoverySkill);
      const provenance = await resolveProvenance(recoveryFleet.env, recoveryFleet.alphaSrc);
      if (!provenance.ok) throw new Error(provenance.error.code);
      const snapshot = await snapshotToStore(recoveryFleet.env, {
        sourceDir: recoveryFleet.alphaSrc,
        skill: recoverySkill,
        storeRoot: storeRootOf(recoveryFleet.data),
        provenance: provenance.value,
        txId: 'sync-recovery-snapshot',
      });
      if (!snapshot.ok) throw new Error(snapshot.error.code);
      const source = Object.freeze({
        kind: 'local-dev' as const,
        path: recoveryFleet.alphaSrc,
        contentHash: snapshot.value.contentHash as OperationDigest,
      });
      const liveResource = Object.freeze({
        kind: 'live' as const,
        skill: recoverySkill,
        tool: 'claude-code' as const,
        scope: 'user' as const,
        projectRoot: null,
        location: Object.freeze({ kind: 'machine-bound' as const, path: recoveryPlacement }),
      });
      const logicalOperation: ExecutableOperation = Object.freeze({
        operationId: 'operation:sync-recovery-install',
        groupId: 'group:sync-recovery-install',
        pairId: 'pair:sync-recovery-install',
        kind: 'install',
        dependencyMetadata: Object.freeze({
          domain: 'skillsmith.operation-dependency' as const,
          schemaVersion: 1 as const,
          operationIds: [],
        }),
        skill: recoverySkill,
        source,
        tool: 'claude-code',
        scope: 'user',
        before: Object.freeze({ kind: 'absent' as const, resource: liveResource }),
        after: Object.freeze({
          kind: 'placement' as const,
          resource: liveResource,
          classification: 'pinned' as const,
          representation: 'copy' as const,
          linkTarget: null,
          dangling: false,
          source,
          contentHash: source.contentHash,
        }),
        reason: Object.freeze({
          code: 'sync-install-selected',
          message: 'Install a machine-bound sync source.',
        }),
        selectionSource: 'bounded-default',
        preconditionIds: [],
        requiredCheckIds: [],
        reversibility: Object.freeze({ kind: 'none' as const, retentionResourceIds: [] as const }),
        mutates: Object.freeze({ live: true, manifest: false, lock: false, ledger: true }),
        conflict: null,
      });
      const pinned = Object.freeze({
        storePath: snapshot.value.storePath,
        rev: snapshot.value.rev,
        gitSha: null,
        dirty: false,
        contentHash: snapshot.value.contentHash,
        snapshotAt: '2026-07-21T00:00:00.000Z',
        verify: 'passed' as const,
      });
      const recoveryPlan = Object.freeze({
        op: 'install' as const,
        skill: recoverySkill,
        tool: 'claude-code' as const,
        skillsRoot: recoveryRoot,
        placementPath: recoveryPlacement,
        install: Object.freeze({
          build: 'copy' as const,
          storePath: snapshot.value.storePath,
          contentHash: snapshot.value.contentHash,
          pinned,
          origin: null,
          adoptedDev: null,
        }),
      });
      const recoveryLedgerPath = join(recoveryFleet.data, 'placements.json');
      const request = (
        model: LedgerModel,
        signal?: AbortSignal,
        includeOperation = false,
      ): SwapRequest => {
        let durable = model;
        return {
          context: {
            env: recoveryFleet.env,
            ...(includeOperation ? { logicalOperation } : {}),
            ...(signal === undefined ? {} : { signal }),
          },
          state: { ledger: model },
          effects: {
            persistLedger: async (candidate) => {
              const written = await writeLedger(recoveryFleet.env, recoveryLedgerPath, candidate);
              if (!written.ok) return { ok: false, error: written.error, ledger: durable };
              durable = candidate;
              return { ok: true, ledger: candidate };
            },
            journalNow: () => '2026-07-21T00:00:00.000Z',
            newTransactionId: () => 'transaction:sync-recovery-install',
          },
        };
      };
      const crash = new AbortController();
      crash.abort();
      const interrupted = await runSwap(
        request(emptyLedgerModel('2026-07-21T00:00:00.000Z'), crash.signal, true),
        recoveryPlan,
      );
      expect(interrupted.ok).toBeFalse();
      if (interrupted.ok) throw new Error('expected interrupted sync install');
      expect(interrupted.error.code).toBe('flip-failed');
      expect(Object.values(interrupted.state.ledger.transactions)).toEqual([
        expect.objectContaining({
          phase: 'prepared',
          intent: expect.objectContaining({
            operationId: logicalOperation.operationId,
            kind: 'install',
            source: expect.objectContaining({ kind: 'local-dev' }),
          }),
        }),
      ]);
      const resumed = await resumeSwap(
        request(interrupted.state.ledger),
        recoverySkill,
        'claude-code',
      );
      expect(resumed.ok).toBeTrue();
      if (!resumed.ok) throw new Error(resumed.error.code);
      const installedHash = await contentHashOf(recoveryFleet.env, recoveryPlacement);
      expect(installedHash).toMatchObject({ ok: true, value: snapshot.value.contentHash });
      const recoveredPair = getLedgerPairAt(
        resumed.state.ledger,
        null,
        recoverySkill,
        'claude-code',
      );
      expect(recoveredPair).toMatchObject({ mode: 'pinned', journal: null });
      expect(recoveredPair).not.toHaveProperty('origin');
      expect(Object.keys(resumed.state.ledger.transactions)).toHaveLength(0);
      expect(resumed.state.ledger.history.at(-1)).toMatchObject({
        phase: 'committed',
        intent: { operationId: logicalOperation.operationId },
      });
    } finally {
      await destroyFixtureFleet(recoveryFleet);
    }

    const exerciseRuntimeFailure = async (
      continueOnError: boolean,
    ): Promise<Readonly<{ report: SyncReportV1Dto; order: readonly string[] }>> => {
      const runtimeFleet = await fleet();
      const sourceRoots = await addSlowRuntimeSources(runtimeFleet);
      const runtimeArgs = [
        'sync',
        '--from',
        'user',
        '--to',
        runtimeFleet.projects.c,
        '--tool',
        'codex',
        ...(continueOnError ? ['--continue-on-error'] : []),
      ] as const;
      const runtimePreview = await syncReport(runtimeFleet, [...runtimeArgs, '--dry-run']);
      const order = runtimePreview.operations
        .filter(({ pairId, skill }) => pairId !== null && skill !== null)
        .map(({ skill }) => skill as string);
      expect(order).toHaveLength(3);
      const secondSkill = order[1];
      if (secondSkill === undefined || sourceRoots[secondSkill] === undefined) {
        throw new Error('runtime failure fixture lacks its second scheduled source');
      }
      const product = await spawnedSyncProduct(
        runtimeFleet,
        [...runtimeArgs, '--yes', '--json'],
        async () => {
          await rm(sourceRoots[secondSkill] as string, { recursive: true });
        },
      );
      expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(1);
      const runtimeReport = decodeSyncProduct(product);
      const outcomeBySkill = new Map(
        runtimeReport.groups.map((group) => [group.skill, group.pairs[0]] as const),
      );
      const firstSkill = order[0];
      const thirdSkill = order[2];
      if (firstSkill === undefined || thirdSkill === undefined) {
        throw new Error('runtime failure fixture operation order is incomplete');
      }
      expect(runtimeReport).toMatchObject({
        state: 'partial',
        options: { continueOnError },
        summary: {
          succeeded: continueOnError ? 2 : 1,
          failed: 1,
          skipped: continueOnError ? 0 : 1,
        },
      });
      expect(outcomeBySkill.get(firstSkill)).toMatchObject({ outcome: 'succeeded' });
      expect(outcomeBySkill.get(secondSkill)).toMatchObject({
        outcome: 'failed',
        failure: { code: 'generic' },
      });
      expect(outcomeBySkill.get(thirdSkill)).toMatchObject(
        continueOnError
          ? { outcome: 'succeeded', skipReason: null }
          : { outcome: 'skipped', skipReason: 'skipped-after-failure' },
      );
      expect(
        await present(join(runtimeFleet.projects.c, '.agents', 'skills', firstSkill)),
      ).toBeTrue();
      expect(
        await present(join(runtimeFleet.projects.c, '.agents', 'skills', secondSkill)),
      ).toBeFalse();
      expect(await present(join(runtimeFleet.projects.c, '.agents', 'skills', thirdSkill))).toBe(
        continueOnError,
      );
      const runtimeLedger = await readLedger(runtimeFleet);
      expect(Object.keys(runtimeLedger.transactions)).toHaveLength(0);
      expect(runtimeLedger.projects[runtimeFleet.projects.c]?.skills).toHaveProperty(firstSkill);
      if (continueOnError) {
        expect(runtimeLedger.projects[runtimeFleet.projects.c]?.skills).toHaveProperty(thirdSkill);
      } else {
        expect(runtimeLedger.projects[runtimeFleet.projects.c]?.skills).not.toHaveProperty(
          thirdSkill,
        );
      }
      expect(runtimeLedger.projects[runtimeFleet.projects.c]?.skills).not.toHaveProperty(
        secondSkill,
      );
      expect(runtimeLedger.history.some(({ intent }) => intent.skill === firstSkill)).toBeTrue();
      expect(runtimeLedger.history.some(({ intent }) => intent.skill === secondSkill)).toBeFalse();
      return Object.freeze({ report: runtimeReport, order: Object.freeze(order) });
    };

    const failFastRuntime = await exerciseRuntimeFailure(false);
    const continuedRuntime = await exerciseRuntimeFailure(true);
    expect(failFastRuntime.order).toHaveLength(continuedRuntime.order.length);

    const cancellationFleet = await fleet();
    await addSlowRuntimeSources(cancellationFleet);
    const cancellationArgs = [
      'sync',
      '--from',
      'user',
      '--to',
      cancellationFleet.projects.c,
      '--tool',
      'codex',
      '--yes',
      '--json',
    ] as const;
    const cancelledProduct = await spawnedSyncProduct(
      cancellationFleet,
      cancellationArgs,
      async (child) => {
        child.kill('SIGINT');
      },
    );
    expect(cancelledProduct.exitCode, cancelledProduct.stderr).toBe(130);
    const cancelledReport = decodeSyncProduct(cancelledProduct);
    expect(cancelledReport).toMatchObject({
      state: 'partial',
      summary: { failed: 0, cancelled: 3, succeeded: 0 },
    });
    expect(pairs(cancelledReport).every(({ outcome }) => outcome === 'cancelled')).toBeTrue();
    const cancellationLedger = await readLedger(cancellationFleet);
    expect(Object.keys(cancellationLedger.transactions).length).toBeGreaterThan(0);
    expect(cancellationLedger.history).toHaveLength(0);
    for (const skill of cancelledReport.selection.skills) {
      expect(
        await present(join(cancellationFleet.projects.c, '.agents', 'skills', skill)),
      ).toBeFalse();
    }
    const report = await syncReport(selected, [
      'sync',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--continue-on-error',
      '--yes',
    ]);
    expect(report).toMatchObject({
      state: 'completed',
      options: { continueOnError: true },
      summary: { failed: 0, cancelled: 0, skipped: 0, notRun: 0 },
    });
    expect(pairs(report).every(({ outcome }) => outcome === 'succeeded')).toBeTrue();
    const ledger = await readLedger(selected);
    expect(Object.keys(ledger.transactions)).toHaveLength(0);
    expect(ledger.history.length).toBeGreaterThan(0);
    expect(
      ledger.history.every(
        ({ phase, completedAt }) => phase === 'committed' && completedAt !== null,
      ),
    ).toBeTrue();
    expect(ledger.history.map(({ transactionId }) => transactionId).length).toBe(
      new Set(ledger.history.map(({ transactionId }) => transactionId)).size,
    );

    const approvalFleet = await fleet();
    const liveBefore = await readSkillBytes(approvalFleet.skills.projectBReview);
    const aborted = await syncReport(
      approvalFleet,
      [
        'sync',
        'review',
        '--from',
        'user',
        '--to',
        approvalFleet.projects.b,
        '--tool',
        'codex',
        '--force',
      ],
      2,
    );
    expect(aborted).toMatchObject({
      state: 'refused',
      approval: { required: true, outcome: 'refused' },
      summary: { succeeded: 0, failed: 0, planned: 1 },
    });
    expect(await readSkillBytes(approvalFleet.skills.projectBReview)).toEqual(liveBefore);
    expect((await readLedger(approvalFleet)).transactions).toEqual({});
  }, 60_000);

  test('EWP-CMD-SYNC-TS10 — output exposes shared planner operations', async () => {
    const selected = await fleet();
    const args = [
      'sync',
      'lint',
      '--from',
      'user',
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--dry-run',
    ] as const;
    const report = await syncReport(selected, args);
    const rerun = await syncReport(selected, args);
    expect(report.operations).toEqual(rerun.operations);
    expect(report.checks).toEqual(rerun.checks);
    expect(report.diagnostics).toEqual(rerun.diagnostics);
    expect(report.operations).toHaveLength(1);
    expect(report.operations[0]).toMatchObject({
      kind: 'install',
      skill: 'lint',
      tool: 'codex',
      selectionSource: 'explicit-targets',
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      dependsOn: [],
    });
    expect(report.operations[0]).not.toHaveProperty('syncKind');
    const runtimeIntentFor = (operation: NonNullable<(typeof report.operations)[number]>) => {
      const {
        dependsOn: _dependsOn,
        preconditionIds: _preconditionIds,
        reason: _reason,
        requiredCheckIds: _requiredCheckIds,
        selectionSource: _selectionSource,
        ...runtimeJournalIntent
      } = operation;
      return runtimeJournalIntent;
    };
    const installOperation = report.operations[0];
    if (installOperation === undefined) throw new Error('sync install operation is missing');
    const installIntent = runtimeIntentFor(installOperation);
    expect(operationMatchesMatrix(installOperation as unknown as PlanOperationV1)).toBeFalse();
    expect(validatePlanOperationIntentShapeV1(installIntent).ok).toBeTrue();
    expect(validatePlanOperationIntentV1(installIntent).ok).toBeTrue();
    expect(validatePlanOperationIntentV1(installOperation).ok).toBeFalse();
    expect(pairs(report)[0]).toMatchObject({
      action: report.operations[0]?.kind,
      outcome: 'planned',
    });
    expect(
      report.effects
        .map(({ operationId }) => operationId)
        .every((operationId) => operationId === report.operations[0]?.operationId),
    ).toBeTrue();

    const plannedFleet = await fleet();
    const saveArgs = [
      'sync',
      'lint',
      '--from',
      plannedFleet.projects.a,
      '--to',
      plannedFleet.projects.c,
      '--tool',
      'codex',
      '--save',
      '--file',
      plannedFleet.artifacts.explicitManifest,
      '--lockfile',
      plannedFleet.artifacts.explicitLock,
    ] as const;
    const savePreview = await syncReport(plannedFleet, [...saveArgs, '--dry-run']);
    const plannerCoordinator = await createTestNodeArtifactCoordinatorPorts(
      join(plannedFleet.root, 'ts10-planner-coordination'),
    );
    const plannerContext = await syncApplicationContext(plannedFleet, plannerCoordinator);
    const topProject = await resolveProjectContext(plannerContext.ports, {
      invocationCwd: plannedFleet.cwd,
    });
    if (!topProject.ok) throw new Error('TS10 project context could not be resolved');
    const endpoints = await resolveSyncEndpoints(plannerContext, topProject.value, {
      from: plannedFleet.projects.a,
      to: plannedFleet.projects.c,
      tools: ['codex'],
    });
    if (!endpoints.ok) throw new Error(endpoints.error.message);
    const observedFleet = await observeSyncFleet(plannerContext, endpoints.value, {
      portableProof: 'exact',
    });
    if (!observedFleet.ok) throw new Error(observedFleet.error.message);
    const selectedResources = selectSyncFleetResourcesV1(observedFleet.value, {
      targets: ['lint'],
      delete: false,
      continueOnError: false,
      save: true,
      force: false,
    });
    if (!selectedResources.ok) throw new Error(selectedResources.error.message);
    expect(selectedResources.value).toMatchObject({
      options: { save: true, targets: ['lint'] },
      pairs: [{ action: 'converge', source: { portable: { outcome: 'portable' } } }],
    });
    const artifactPair = await resolveArtifactPair(plannerContext.ports, topProject.value, {
      file: plannedFleet.artifacts.explicitManifest,
      lockfile: plannedFleet.artifacts.explicitLock,
    });
    if (!artifactPair.ok) throw new Error(artifactPair.error.message);
    const dataDir = resolveDataDir(plannerContext.ports, plannerContext.configuration);
    const plannerStoreRoot = storeRootOf(dataDir);
    const preparedStores = prepareSyncStoreResourcesV1(selectedResources.value, plannerStoreRoot);
    const destinationBase = endpoints.value.to.canonicalBase;
    if (destinationBase === null) throw new Error('TS10 project destination has no exact base');
    const explicitLocation = await createExplicitPlacementProjectLocationV1(
      plannerContext.ports,
      endpoints.value.to.project,
      destinationBase,
    );
    if (!explicitLocation.ok)
      throw new Error(`TS10 explicit location: ${explicitLocation.error.code}`);
    const capabilityQueries: RelevantCapabilityQueryV1[] = selectedResources.value.pairs.map(
      ({ pair }) => ({
        schemaVersion: 1,
        tool: pair.tool,
        operation: 'sync',
        scope: pair.scope,
      }),
    );
    const authority = await createPlacementSnapshotAuthority(
      toolRegistry,
      capabilityQueries,
      plannerContext.ports,
      endpoints.value.to.project,
      ledgerPathOf(dataDir),
      plannerStoreRoot,
      selectedResources.value.pairs.map(({ pair }) => pair),
      preparedStores.resources,
      {
        manifestPath: artifactPair.value.file.path,
        lockPath: artifactPair.value.lockfile.path,
      },
      explicitLocation.value,
    );
    if (!authority.ok) throw new Error(`TS10 placement authority: ${authority.error.code}`);
    const initialProjection = projectSyncFleetPlanV1(
      selectedResources.value,
      authority.value,
      preparedStores.bindings,
    );
    if (!initialProjection.ok) throw new Error(initialProjection.error.message);
    const initialPlan = createSyncPlan(initialProjection.value.request, authority.value.snapshot, {
      registry: toolRegistry,
      toolOrder: toolRegistry.ids,
    });
    if (!initialPlan.ok) throw new Error(initialPlan.error.message);
    const preparedArtifacts = await prepareSyncArtifactsV1({
      ports: plannerContext.ports,
      homeDir: plannerContext.ports.homeDir,
      fleet: observedFleet.value,
      selection: selectedResources.value,
      livePlan: initialPlan.value.plan,
      pair: artifactPair.value,
    });
    if (!preparedArtifacts.ok) throw new Error(preparedArtifacts.error.code);
    const projection = projectSyncFleetPlanV1(selectedResources.value, authority.value, {
      ...preparedStores.bindings,
      artifactPrefixOperationIdsByPair: preparedArtifacts.value.prefixOperationIdsByPair,
      compatibilityOperations: preparedArtifacts.value.operations.map(({ operation }) => operation),
    });
    if (!projection.ok) throw new Error(projection.error.message);
    const directSyncPlan = createSyncPlan(projection.value.request, authority.value.snapshot, {
      registry: toolRegistry,
      toolOrder: toolRegistry.ids,
    });
    if (!directSyncPlan.ok) throw new Error(directSyncPlan.error.message);
    const directOperations = directSyncPlan.value.plan.operations;
    const manifestOperation = directOperations.find(({ kind }) => kind === 'write-manifest');
    const lockOperation = directOperations.find(({ kind }) => kind === 'write-lock');
    const placementOperation = directOperations.find(({ pairId }) => pairId !== null);
    if (
      manifestOperation === undefined ||
      lockOperation === undefined ||
      placementOperation === undefined
    ) {
      throw new Error('TS10 save plan lacks its manifest, lock, or placement operation');
    }
    expect(directOperations).toHaveLength(3);
    expect(
      preparedArtifacts.value.operations.map(({ operation }) => {
        const { preconditionIds: _preconditionIds, ...body } = operation;
        return body;
      }),
    ).toEqual(
      [manifestOperation, lockOperation].map((operation) => {
        const { preconditionIds: _preconditionIds, ...body } = operation;
        return body;
      }),
    );
    for (const { operation } of preparedArtifacts.value.operations) {
      const finalOperation = directOperations.find(
        ({ operationId }) => operationId === operation.operationId,
      );
      expect(finalOperation).toBeDefined();
      expect(
        operation.preconditionIds.every((preconditionId) =>
          finalOperation?.preconditionIds.includes(preconditionId),
        ),
      ).toBeTrue();
    }
    expect(manifestOperation.dependencyMetadata.operationIds).toEqual([]);
    expect(lockOperation.dependencyMetadata.operationIds).toEqual([manifestOperation.operationId]);
    expect(placementOperation.dependencyMetadata.operationIds).toEqual([lockOperation.operationId]);
    expect(
      new Set(
        preparedArtifacts.value.operations.flatMap(({ operation }) => operation.preconditionIds),
      ),
    ).toEqual(
      new Set(preparedArtifacts.value.preconditions.map(({ preconditionId }) => preconditionId)),
    );
    expect(directOperations.every(({ preconditionIds }) => preconditionIds.length > 0)).toBeTrue();
    expect(directOperations.map(toSyncReportOperationV1)).toEqual([...savePreview.operations]);
    expect(
      directOperations.map(({ operationId, dependencyMetadata, preconditionIds }) => ({
        operationId,
        dependsOn: dependencyMetadata.operationIds,
        preconditionIds,
      })),
    ).toEqual(
      savePreview.operations.map(({ operationId, dependsOn, preconditionIds }) => ({
        operationId,
        dependsOn,
        preconditionIds,
      })),
    );

    const saveExecution = await syncReport(plannedFleet, [...saveArgs, '--yes']);
    expect(saveExecution.operations).toEqual(savePreview.operations);
    expect(saveExecution.operations).toEqual(directOperations.map(toSyncReportOperationV1));
    expect(saveExecution.groups).toMatchObject([
      { skill: 'lint', pairs: [{ action: 'install', outcome: 'succeeded' }] },
    ]);
    for (const operation of directOperations) {
      const operationEffects = saveExecution.effects.filter(
        ({ operationId }) => operationId === operation.operationId,
      );
      expect(operationEffects.length).toBeGreaterThan(0);
      expect(operationEffects.every(({ outcome }) => outcome === 'succeeded')).toBeTrue();
    }

    const installExecution = await syncReport(
      selected,
      args.filter((argument) => argument !== '--dry-run'),
    );
    expect(installExecution.operations).toEqual(report.operations);
    const exactResultProjection = (sync: SyncReportV1Dto) =>
      sync.groups.flatMap((group) =>
        group.pairs.map((pair) => ({
          groupId: group.groupId,
          skill: group.skill,
          tool: pair.tool,
          action: pair.action,
          outcome: pair.outcome,
        })),
      );
    expect(exactResultProjection(installExecution)).toEqual(
      installExecution.operations.flatMap((operation) =>
        operation.pairId !== null &&
        operation.skill !== null &&
        operation.tool !== null &&
        (operation.kind === 'install' || operation.kind === 'update' || operation.kind === 'remove')
          ? [
              {
                groupId: operation.groupId,
                skill: operation.skill,
                tool: operation.tool,
                action: operation.kind,
                outcome: 'succeeded',
              },
            ]
          : [],
      ),
    );
    expect(
      installExecution.effects.every(
        ({ operationId, outcome }) =>
          operationId === installOperation.operationId && outcome === 'succeeded',
      ),
    ).toBeTrue();

    const changedSource = `${await readFile(join(selected.skills.userLint, 'SKILL.md'), 'utf8')}\nchanged\n`;
    await writeFile(join(selected.skills.userLint, 'SKILL.md'), changedSource);
    const updateArgs = [
      'sync',
      'lint',
      '--from',
      'user',
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--force',
    ] as const;
    const updatePreview = await syncReport(selected, [...updateArgs, '--dry-run']);
    const updateOperation = updatePreview.operations[0];
    if (updateOperation === undefined) throw new Error('sync update operation is missing');
    expect(updateOperation).toMatchObject({ kind: 'update', source: { kind: 'local-dev' } });
    const updateIntent = runtimeIntentFor(updateOperation);
    expect(operationMatchesMatrix(updateOperation as unknown as PlanOperationV1)).toBeFalse();
    expect(validatePlanOperationIntentShapeV1(updateIntent).ok).toBeTrue();
    expect(validatePlanOperationIntentV1(updateIntent).ok).toBeTrue();
    const updateExecution = await syncReport(selected, [...updateArgs, '--yes']);
    expect(updateExecution.operations).toEqual(updatePreview.operations);
    expect(exactResultProjection(updateExecution)).toEqual([
      {
        groupId: updateOperation.groupId,
        skill: 'lint',
        tool: 'codex',
        action: 'update',
        outcome: 'succeeded',
      },
    ]);
    expect(
      await readFile(join(selected.projects.c, '.agents', 'skills', 'lint', 'SKILL.md'), 'utf8'),
    ).toBe(changedSource);
  }, 30_000);
});
