import { describe, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { createTestNodeArtifactCoordinatorPorts } from '../../../packages/core/src/artifacts/node-coordinator.ts';
import {
  createApplyFixture,
  createRemoteApplyFixture,
  destroyApplyFixture,
  destroyRemoteApplyFixture,
  runApplyCli,
} from '../fixtures/p4b-apply/cases.ts';
import {
  POLICY_SECRET_CANARIES,
  STRICT_WHOLE_PAIR_CASES,
  collectResiduePaths,
  collectStrings,
  createIncompleteWholePairFixture,
  destroyIncompleteWholePairFixture,
  expireApplyCrashLocks,
  recoverApplyArtifactCrash,
  replacePendingApplyOperationId,
  runApplyCrashChild,
  runBoundedLockedPreview,
} from '../fixtures/p4b-lock-policy/cases.ts';

type JsonRecord = Record<string, unknown>;

const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is JsonRecord =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

const report = async (
  fixture: Parameters<typeof runApplyCli>[0],
  args: readonly string[],
): Promise<JsonRecord> => {
  const product = await runApplyCli(fixture, args);
  if (product.exitCode !== 0) {
    throw new Error(
      `G4B-03 preview failed ${product.exitCode}\n${product.stderr}\n${product.stdout}`,
    );
  }
  return JSON.parse(product.stdout) as JsonRecord;
};

const assertCanarySafe = (value: unknown): void => {
  const source = JSON.stringify(value);
  for (const canary of POLICY_SECRET_CANARIES) expect(source).not.toContain(canary);
};

describe('EWP-P4B-TS05', () => {
  test('locked apply refuses an incomplete whole pair before any commit boundary', async () => {
    expect(STRICT_WHOLE_PAIR_CASES).toContain('bounded-tool');
    const selected = await createIncompleteWholePairFixture();
    try {
      const product = await runBoundedLockedPreview(selected, 'apply');
      expect(product.exitCode, product.stdout).toBe(3);
      expect(JSON.parse(product.stdout)).toMatchObject({
        kind: 'error',
        code: 'plan-locked-state',
        exitCode: 3,
      });
    } finally {
      await destroyIncompleteWholePairFixture(selected);
    }
  });

  test('manifest and lock artifact interruptions recover one legal pair and rerun idempotently', async () => {
    for (const target of ['artifact-manifest', 'artifact-lock'] as const) {
      const fixture = await createApplyFixture([], { writeLock: false });
      try {
        await writeFile(fixture.manifest, 'tool = "codex"\nscope = "user"\n');
        const preview = await report(fixture, [
          'apply',
          '--file',
          fixture.manifest,
          '--lockfile',
          fixture.lock,
          '--dry-run',
          '--json',
        ]);
        const operations = records(preview.operations);
        expect(
          operations.map(({ kind }) => kind),
          target,
        ).toEqual(['migrate-project-config', 'write-lock']);
        const targetKind = target === 'artifact-manifest' ? 'migrate-project-config' : 'write-lock';
        const targetId = operations.find(({ kind }) => kind === targetKind)?.operationId;
        expect(typeof targetId, target).toBe('string');

        const crashed = await runApplyCrashChild(fixture, target);
        expect(crashed.message, target).toMatchObject({ kind: 'reached', target });
        expect(await recoverApplyArtifactCrash(crashed), target).toBe('rolled-back');

        const recovered = await runApplyCrashChild(fixture, 'none', crashed.coordinationRoot);
        expect(recovered.message, target).toMatchObject({ kind: 'result', exitClass: 'success' });
        const recoveredReport = recovered.message.report as JsonRecord;
        expect(
          records(recoveredReport.results).some(
            ({ operationId, outcome }) => operationId === targetId && outcome === 'succeeded',
          ),
          target,
        ).toBeTrue();

        const rerun = await runApplyCrashChild(fixture, 'none', crashed.coordinationRoot);
        expect(rerun.message, target).toMatchObject({
          kind: 'result',
          exitClass: 'success',
          report: { state: 'completed', operations: [], results: [] },
        });
        const coordinator = await createTestNodeArtifactCoordinatorPorts(crashed.coordinationRoot);
        expect(await coordinator.recovery.discover(), target).toEqual([]);
        expect(await collectResiduePaths(fixture.root), target).toEqual([]);
        assertCanarySafe([crashed.message, recovered.message, rerun.message]);
      } finally {
        await destroyApplyFixture(fixture);
      }
    }
  }, 60_000);

  test('lock-prefix ordering survives ledger and live journal interruption and same-apply recovery', async () => {
    for (const target of ['ledger', 'live'] as const) {
      const fixture = await createRemoteApplyFixture();
      try {
        await rm(fixture.lock, { force: true });
        const preview = await report(fixture, [
          'apply',
          '--file',
          fixture.manifest,
          '--lockfile',
          fixture.lock,
          '--dry-run',
          '--json',
        ]);
        const operations = records(preview.operations);
        expect(
          operations.map(({ kind }) => kind),
          target,
        ).toEqual(['write-lock', 'install']);
        const lockOperation = operations.find(({ kind }) => kind === 'write-lock');
        const installOperation = operations.find(({ kind }) => kind === 'install');
        expect(installOperation?.dependsOn, target).toEqual([lockOperation?.operationId]);

        const crashed = await runApplyCrashChild(fixture, target);
        expect(crashed.message, target).toMatchObject({
          kind: 'reached',
          target,
          barrier: { operationId: installOperation?.operationId },
        });
        const {
          dependsOn: _dependsOn,
          reason: _reason,
          selectionSource: _selectionSource,
          preconditionIds: _preconditionIds,
          requiredCheckIds: _requiredCheckIds,
          ...approvedIntent
        } = installOperation ?? {};
        expect((crashed.message.barrier as JsonRecord).intent, target).toEqual({
          ...approvedIntent,
          reversibility: { kind: 'none', retentionResourceIds: [] },
          conflict: null,
        });
        await expireApplyCrashLocks(crashed);
        const recovered = await runApplyCrashChild(fixture, 'none', crashed.coordinationRoot);
        expect(recovered.message, target).toMatchObject({ kind: 'result', exitClass: 'success' });
        const rerun = await runApplyCrashChild(fixture, 'none', crashed.coordinationRoot);
        expect(rerun.message, target).toMatchObject({
          kind: 'result',
          exitClass: 'success',
          report: { state: 'completed', operations: [], results: [] },
        });
        expect(await collectResiduePaths(fixture.root), target).toEqual([]);
        expect(
          collectStrings([crashed.message, recovered.message, rerun.message]),
          target,
        ).not.toContain(POLICY_SECRET_CANARIES[0]);
      } finally {
        await destroyRemoteApplyFixture(fixture);
      }
    }
  }, 60_000);

  test('nonmatching pending placement intent remains a stale-state refusal', async () => {
    const fixture = await createRemoteApplyFixture();
    try {
      await rm(fixture.lock, { force: true });
      const crashed = await runApplyCrashChild(fixture, 'ledger');
      const replacement = await replacePendingApplyOperationId(crashed);
      await expireApplyCrashLocks(crashed);

      const refused = await runApplyCrashChild(fixture, 'none', crashed.coordinationRoot);
      expect(refused.message).toMatchObject({
        kind: 'result',
        exitClass: 'state',
        report: { state: 'refused', validation: { outcome: 'stale' }, results: [] },
      });
      expect(JSON.stringify(refused.message)).not.toContain(POLICY_SECRET_CANARIES[0]);
      expect(JSON.stringify(refused.message)).not.toContain(replacement);
    } finally {
      await destroyRemoteApplyFixture(fixture);
    }
  }, 30_000);
});
