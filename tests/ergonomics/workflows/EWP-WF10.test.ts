import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import {
  type SyncPairResultV1Dto,
  type SyncReportV1Dto,
  syncV1Codec,
} from '../../../packages/core/src/contracts/v1/sync.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';
import {
  SYNC_SECRET_CANARIES,
  type SyncFleet,
  createSyncFleet,
  destroySyncFleet,
  readSkillBytes,
  runSyncCli,
} from '../fixtures/p5-sync/fleet.ts';

const syncReport = async (
  fleet: SyncFleet,
  args: readonly string[],
  expectedExit = 0,
): Promise<SyncReportV1Dto> => {
  const product = await runSyncCli(fleet, [...args, '--json']);
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  const decoded = syncV1Codec.decode(product.stdout);
  expect(decoded.ok, product.stdout).toBeTrue();
  if (!decoded.ok) throw new Error(decoded.error.message);
  for (const canary of SYNC_SECRET_CANARIES) {
    expect(`${product.stdout}${product.stderr}`).not.toContain(canary);
  }
  return decoded.value;
};

const pairs = (report: SyncReportV1Dto): readonly SyncPairResultV1Dto[] =>
  report.groups.flatMap(({ pairs: groupPairs }) => groupPairs);

const pairIdentity = (report: SyncReportV1Dto): readonly Readonly<Record<string, unknown>>[] =>
  pairs(report).map(({ pairId, operationId, skill, source, tool }) => ({
    pairId,
    operationId,
    skill,
    source,
    tool,
  }));

const addSlowRuntimeSources = async (
  fleet: SyncFleet,
): Promise<Readonly<Record<string, string>>> => {
  const roots: Record<string, string> = {
    lint: fleet.skills.userLint,
    review: fleet.skills.userReview,
    tail: join(fleet.home, '.agents', 'skills', 'tail'),
  };
  await mkdir(roots.tail as string, { recursive: true });
  await writeFile(
    join(roots.tail as string, 'SKILL.md'),
    '---\nname: tail\ndescription: workflow tail fixture\n---\n\n# tail\n',
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

const waitForPreparedTransaction = async (fleet: SyncFleet): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const ledger = JSON.parse(await readFile(fleet.ledger, 'utf8')) as {
        readonly transactions?: Readonly<Record<string, unknown>>;
      };
      if (Object.keys(ledger.transactions ?? {}).length > 0) return;
    } catch {
      // The ledger is replaced atomically; retry if observation races the writer.
    }
    await Bun.sleep(1);
  }
  throw new Error('workflow execution never exposed its prepared transaction');
};

const executePartialWorkflow = async (): Promise<void> => {
  const fleet = await createSyncFleet();
  try {
    const sourceRoots = await addSlowRuntimeSources(fleet);
    const args = [
      'sync',
      '--from',
      'user',
      '--to',
      fleet.projects.c,
      '--tool',
      'codex',
      '--continue-on-error',
    ] as const;
    const preview = await syncReport(fleet, [...args, '--dry-run']);
    const order = preview.operations
      .filter(({ pairId, skill }) => pairId !== null && skill !== null)
      .map(({ skill }) => skill as string);
    expect(order).toHaveLength(3);
    const secondSkill = order[1];
    if (secondSkill === undefined || sourceRoots[secondSkill] === undefined) {
      throw new Error('workflow partial fixture lacks its second scheduled source');
    }

    const child = Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args, '--yes', '--json'], {
      cwd: fleet.cwd,
      env: hermeticGitEnv(fleet.env),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForPreparedTransaction(fleet);
    await rm(sourceRoots[secondSkill] as string, { recursive: true });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stderr}\n${stdout}`).toBe(1);
    const decoded = syncV1Codec.decode(stdout);
    expect(decoded.ok, stdout).toBeTrue();
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.value).toMatchObject({
      state: 'partial',
      options: { continueOnError: true },
      summary: { succeeded: 2, failed: 1, skipped: 0 },
    });
    const outcomeBySkill = new Map(
      decoded.value.groups.map((group) => [group.skill, group.pairs[0]] as const),
    );
    expect(outcomeBySkill.get(order[0] as string)?.outcome).toBe('succeeded');
    expect(outcomeBySkill.get(secondSkill)).toMatchObject({
      outcome: 'failed',
      failure: { code: 'generic' },
    });
    expect(outcomeBySkill.get(order[2] as string)?.outcome).toBe('succeeded');
    for (const canary of SYNC_SECRET_CANARIES) {
      expect(`${stdout}${stderr}`).not.toContain(canary);
    }
  } finally {
    await destroySyncFleet(fleet);
  }
};

describe('EWP-WF10', () => {
  test('EWP-WF10 — direct sync workflow preserves one plan through all observable surfaces', async () => {
    const fleet = await createSyncFleet();
    try {
      const userLintBefore = await readSkillBytes(fleet.skills.userLint);
      const userReviewBefore = await readSkillBytes(fleet.skills.userReview);
      const projectLintBefore = await readSkillBytes(fleet.skills.projectALint);

      const directArgs = [
        'sync',
        'lint',
        '--from',
        'user',
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
      ] as const;
      const preview = await syncReport(fleet, [...directArgs, '--dry-run']);
      const execution = await syncReport(fleet, directArgs);
      expect(preview).toMatchObject({
        mode: 'dry-run',
        state: 'ready',
        selection: { selectionSource: 'explicit-targets' },
      });
      expect(execution.operations).toEqual(preview.operations);
      expect(pairIdentity(execution)).toEqual(pairIdentity(preview));
      expect(pairs(execution).map(({ outcome }) => outcome)).toEqual(['succeeded']);

      const conflictArgs = [
        'sync',
        'review',
        '--from',
        'user',
        '--to',
        fleet.projects.b,
        '--tool',
        'codex',
        '--force',
      ] as const;
      const forcedPreview = await syncReport(fleet, [...conflictArgs, '--dry-run']);
      expect(pairs(forcedPreview)[0]?.force).toMatchObject({
        requested: true,
        used: true,
        conflictType: 'unmanaged-target',
        forced: 'backup-and-replace',
      });
      const human = await runSyncCli(fleet, [...conflictArgs, '--dry-run']);
      expect(human.exitCode, human.stderr).toBe(0);
      for (const operation of forcedPreview.operations) {
        expect(human.stdout).toContain(operation.operationId);
      }
      for (const effect of forcedPreview.effects) {
        expect(human.stdout).toContain(`action: '${effect.action}'`);
        expect(human.stdout).toContain(`operationId: '${effect.operationId}'`);
        expect(human.stdout).toContain(`role: '${effect.role}'`);
      }
      expect(human.stdout).toContain(
        `Summary exact: { cancelled: 0, changed: ${forcedPreview.summary.changed}`,
      );
      for (const canary of SYNC_SECRET_CANARIES) {
        expect(`${human.stdout}${human.stderr}`).not.toContain(canary);
      }

      const forced = await syncReport(fleet, [...conflictArgs, '--yes']);
      expect(forced.operations).toEqual(forcedPreview.operations);
      expect(pairIdentity(forced)).toEqual(pairIdentity(forcedPreview));
      expect(forced.approval).toEqual({ required: true, outcome: 'approved' });
      expect(pairs(forced)[0]?.force).toMatchObject({ used: true, outcome: 'succeeded' });
      expect(forced.effects).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'backup', outcome: 'succeeded' })]),
      );
      expect(await readSkillBytes(fleet.skills.projectBReview)).toEqual(userReviewBefore);

      const saveArgs = [
        'sync',
        '--from',
        fleet.projects.a,
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
        '--save',
        '--file',
        fleet.artifacts.explicitManifest,
        '--lockfile',
        fleet.artifacts.explicitLock,
      ] as const;
      const savePreview = await syncReport(fleet, [...saveArgs, '--dry-run']);
      expect(savePreview.selection.selectionSource).toBe('bounded-default');
      const saved = await syncReport(fleet, [...saveArgs, '--yes']);
      expect(saved.operations).toEqual(savePreview.operations);
      expect(pairIdentity(saved)).toEqual(pairIdentity(savePreview));
      const manifestOperation = saved.operations.find(({ kind }) => kind === 'write-manifest');
      const lockOperation = saved.operations.find(({ kind }) => kind === 'write-lock');
      expect(manifestOperation).toBeDefined();
      expect(lockOperation?.dependsOn).toEqual([manifestOperation?.operationId]);
      for (const pairOperation of saved.operations.filter(({ pairId }) => pairId !== null)) {
        expect(pairOperation.dependsOn).toContain(lockOperation?.operationId as string);
      }
      expect((await readFile(fleet.artifacts.explicitManifest)).byteLength).toBeGreaterThan(0);
      expect((await readFile(fleet.artifacts.explicitLock)).byteLength).toBeGreaterThan(0);

      const rerun = await syncReport(fleet, [...saveArgs, '--dry-run']);
      expect(rerun).toMatchObject({ summary: { changed: 0 } });
      expect(await readSkillBytes(fleet.skills.userLint)).toEqual(userLintBefore);
      expect(await readSkillBytes(fleet.skills.userReview)).toEqual(userReviewBefore);
      expect(await readSkillBytes(fleet.skills.projectALint)).toEqual(projectLintBefore);
    } finally {
      await destroySyncFleet(fleet);
    }

    const deletionFleet = await createSyncFleet();
    try {
      const deletionLintBefore = await readSkillBytes(deletionFleet.skills.projectALint);
      const deletionReviewBefore = await readSkillBytes(deletionFleet.skills.projectAReview);
      const deleteArgs = [
        'sync',
        '--from',
        deletionFleet.projects.a,
        '--to',
        deletionFleet.projects.b,
        '--tool',
        'codex',
        '--delete',
        '--force',
      ] as const;
      const deletePreview = await syncReport(deletionFleet, [...deleteArgs, '--dry-run']);
      expect(deletePreview.groups.find(({ skill }) => skill === 'extra')?.pairs[0]).toMatchObject({
        action: 'remove',
        outcome: 'planned',
      });
      const deleted = await syncReport(deletionFleet, [...deleteArgs, '--yes']);
      expect(deleted.operations).toEqual(deletePreview.operations);
      expect(deleted.groups.find(({ skill }) => skill === 'extra')?.pairs[0]).toMatchObject({
        action: 'remove',
        outcome: 'succeeded',
      });
      expect(
        await readSkillBytes(deletionFleet.skills.projectBExtra).then(
          () => true,
          () => false,
        ),
      ).toBeFalse();
      expect(await readSkillBytes(deletionFleet.skills.projectALint)).toEqual(deletionLintBefore);
      expect(await readSkillBytes(deletionFleet.skills.projectAReview)).toEqual(
        deletionReviewBefore,
      );
    } finally {
      await destroySyncFleet(deletionFleet);
    }

    const legacy = await createSyncFleet();
    try {
      const legacyBefore = await readFile(legacy.artifacts.legacyManifest, 'utf8');
      expect(legacyBefore).not.toStartWith('version = 1');
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
    } finally {
      await destroySyncFleet(legacy);
    }

    await executePartialWorkflow();
  }, 60_000);
});
