import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SYNC_SECRET_CANARIES,
  type SyncFleet,
  createSyncFleet,
  destroySyncFleet,
  readSkillBytes,
  runSyncCli,
} from '../../../../tests/ergonomics/fixtures/p5-sync/fleet.ts';
import { hashManifestSemantics } from '../../../core/src/artifacts/hash.ts';
import type { LedgerModel } from '../../../core/src/artifacts/ledger-types.ts';
import type { PortableLockV1 } from '../../../core/src/artifacts/lock.ts';
import { validatePlanOperationIntentV1 } from '../../../core/src/artifacts/plan-codec.ts';
import { artifactContractRegistry } from '../../../core/src/artifacts/registry.ts';
import type { NormalizedManifestV1 } from '../../../core/src/artifacts/types.ts';
import {
  type SyncPairResultV1Dto,
  type SyncReportV1Dto,
  syncV1Codec,
} from '../../../core/src/contracts/v1/sync.ts';
import { scheduleOperationPlan } from '../../../core/src/execution/scheduler.ts';
import { emptyLedgerModel, getLedgerPairAt, writeLedger } from '../../../core/src/place/ledger.ts';
import { storeRootOf } from '../../../core/src/place/paths.ts';
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
import {
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';

const openFleets: SyncFleet[] = [];

afterEach(async () => {
  await Promise.all(openFleets.splice(0).map(destroySyncFleet));
});

const fleet = async (): Promise<SyncFleet> => {
  const selected = await createSyncFleet();
  openFleets.push(selected);
  return selected;
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
  }, 25_000);

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
    const {
      dependsOn: _dependsOn,
      preconditionIds: _preconditionIds,
      reason: _reason,
      requiredCheckIds: _requiredCheckIds,
      selectionSource: _selectionSource,
      ...runtimeJournalIntent
    } = report.operations[0] as NonNullable<(typeof report.operations)[number]>;
    expect(validatePlanOperationIntentV1(runtimeJournalIntent).ok).toBeTrue();
    expect(validatePlanOperationIntentV1(report.operations[0]).ok).toBeFalse();
    expect(pairs(report)[0]).toMatchObject({
      action: report.operations[0]?.kind,
      outcome: 'planned',
    });
    expect(
      report.effects
        .map(({ operationId }) => operationId)
        .every((operationId) => operationId === report.operations[0]?.operationId),
    ).toBeTrue();

    const applicationSource = await readFile(
      join(import.meta.dir, '../../../core/src/application/sync-service.ts'),
      'utf8',
    );
    const executionSource = await readFile(
      join(import.meta.dir, '../../../core/src/place/execute.ts'),
      'utf8',
    );
    const recoverySource = await readFile(
      join(import.meta.dir, '../../../core/src/place/swap.ts'),
      'utf8',
    );
    expect(applicationSource).toContain('executePlacementOperationPlan');
    expect(applicationSource).not.toContain("kind: 'sync'");
    const prepareOffset = applicationSource.indexOf('sync.prepare(normalized.value, context)');
    const approvalOffset = applicationSource.indexOf('context.interaction.confirm({');
    const executeOffset = applicationSource.indexOf('sync.execute(preparedResult.value, context)');
    expect(prepareOffset).toBeGreaterThan(0);
    expect(approvalOffset).toBeGreaterThan(prepareOffset);
    expect(executeOffset).toBeGreaterThan(approvalOffset);
    expect(applicationSource.slice(approvalOffset, executeOffset)).not.toContain('sync.prepare(');
    expect(executionSource).toContain('executeOperationPlan');
    expect(executionSource).toContain('runSwap');
    expect(recoverySource).toContain('resumeSwap');
    expect(recoverySource).toContain('rollbackSwapAfterRecoveryAttempt');
    expect(executionSource).not.toContain("case 'sync'");
  }, 15_000);
});
