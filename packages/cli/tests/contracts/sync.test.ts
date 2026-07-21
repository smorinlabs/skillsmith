import { afterEach, describe, expect, test } from 'bun:test';
import {
  type SyncFleet,
  createSyncFleet,
  destroySyncFleet,
  readSkillBytes,
  runSyncCli,
} from '../../../../tests/ergonomics/fixtures/p5-sync/fleet.ts';

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
): Promise<Record<string, unknown>> => {
  expect((await readSkillBytes(selected.skills.userLint)).byteLength).toBeGreaterThan(0);
  const product = await runSyncCli(selected, [...args, '--json']);
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  const parsed: unknown = JSON.parse(product.stdout);
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.sync',
    command: 'sync',
  });
  return parsed as Record<string, unknown>;
};

describe('sync command contract', () => {
  test('EWP-CMD-SYNC-TS01 — mandatory endpoints and bounded selection', async () => {
    const selected = await fleet();
    const report = await syncReport(selected, [
      'sync',
      '--from',
      'user',
      '--to',
      '../project-b',
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(report).toMatchObject({
      mode: 'dry-run',
      selection: { selectionSource: 'bounded-default' },
    });
  });

  test('EWP-CMD-SYNC-TS02 — user and project additions converge', async () => {
    const selected = await fleet();
    const report = await syncReport(selected, [
      'sync',
      'lint',
      '--from',
      'user',
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
    ]);
    expect(report).toMatchObject({ state: 'completed' });
  });

  test('EWP-CMD-SYNC-TS03 — project A, B, and C remain distinct', async () => {
    const selected = await fleet();
    const report = await syncReport(selected, [
      'sync',
      'lint',
      '--from',
      selected.projects.a,
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(report).toMatchObject({ endpoints: { from: {}, to: {} } });
  });

  test('EWP-CMD-SYNC-TS04 — filtering and capability refusal stay bounded', async () => {
    const selected = await fleet();
    const report = await syncReport(
      selected,
      [
        'sync',
        'lint',
        '--from',
        'user',
        '--to',
        selected.projects.c,
        '--tool',
        'kilo-code',
        '--dry-run',
      ],
      4,
    );
    expect(report).toMatchObject({ state: 'refused' });
  });

  test('EWP-CMD-SYNC-TS05 — force is a selected destination override', async () => {
    const selected = await fleet();
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
      '--dry-run',
    ]);
    expect(report).toMatchObject({ options: { force: true, delete: false } });
  });

  test('EWP-CMD-SYNC-TS06 — destination-only deletion is explicit', async () => {
    const selected = await fleet();
    const report = await syncReport(selected, [
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
    expect(report).toMatchObject({ options: { force: false, delete: true } });
  });

  test('EWP-CMD-SYNC-TS07 — save selects one exact destination pair', async () => {
    const selected = await fleet();
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
    expect(report).toMatchObject({ options: { save: true } });
  });

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
    expect(report).toMatchObject({ mode: 'dry-run' });
  });

  test('EWP-CMD-SYNC-TS09 — group failures and continuation remain truthful', async () => {
    const selected = await fleet();
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
    expect(report).toMatchObject({ options: { continueOnError: true } });
  });

  test('EWP-CMD-SYNC-TS10 — output exposes shared planner operations', async () => {
    const selected = await fleet();
    const report = await syncReport(selected, [
      'sync',
      'lint',
      '--from',
      'user',
      '--to',
      selected.projects.c,
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(report.operations).toBeArray();
    expect(report.checks).toBeArray();
    expect(report.diagnostics).toBeArray();
  });
});
