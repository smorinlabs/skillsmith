import { afterEach, describe, expect, test } from 'bun:test';
import {
  type UpdateFleet,
  createUpdateFleet,
  destroyUpdateFleet,
  runUpdateCli,
  snapshotUpdateState,
} from '../../../../tests/ergonomics/fixtures/p5-update/fleet.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../core/src/application/current-services.ts';
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';

const openFleets: UpdateFleet[] = [];

afterEach(async () => {
  await Promise.all(openFleets.splice(0).map(destroyUpdateFleet));
});

const fleet = async (): Promise<UpdateFleet> => {
  const selected = await createUpdateFleet();
  openFleets.push(selected);
  return selected;
};

const updateReport = async (
  selected: UpdateFleet,
  args: readonly string[],
  expectedExit = 0,
): Promise<Record<string, unknown>> => {
  expect(await Bun.file(selected.manifest).exists()).toBeTrue();
  expect(
    {
      commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith update'),
      applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'update'),
    },
    'update CommandSpec/application service boundary is absent',
  ).toEqual({ commandSpec: true, applicationService: true });
  const product = await runUpdateCli(selected, [...args, '--json']);
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  const parsed: unknown = JSON.parse(product.stdout);
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.update',
    command: 'update',
  });
  return parsed as Record<string, unknown>;
};

describe('update command contract', () => {
  test('EWP-CMD-UPDATE-TS01 — exact remote candidate discovery', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, ['update', 'factor-scan', '--check'], 7);
    expect(report).toMatchObject({
      mode: 'check',
      selection: { selectionSource: 'explicit-targets' },
    });
  });

  test('EWP-CMD-UPDATE-TS02 — moving, fixed, ref, and pin policy', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      'main',
      '--pin',
      '--dry-run',
    ]);
    expect(report.candidates).toBeArray();
  });

  test('EWP-CMD-UPDATE-TS03 — declaration-first target and tool selection', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, [
      'update',
      'factor-*',
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(report).toMatchObject({ selection: { selectionSource: 'explicit-targets' } });
  });

  test('EWP-CMD-UPDATE-TS04 — targetless bounded check and no-write modes', async () => {
    const selected = await fleet();
    const before = await snapshotUpdateState(selected);
    const report = await updateReport(selected, ['update', '--check'], 7);
    expect(report).toMatchObject({
      mode: 'check',
      selection: { selectionSource: 'bounded-default' },
    });
    expect(await snapshotUpdateState(selected)).toEqual(before);
  });

  test('EWP-CMD-UPDATE-TS05 — adapter-owned verification policy', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, ['update', 'factor-scan', '--strict', '--dry-run']);
    expect(report.checks).toBeArray();
  });

  test('EWP-CMD-UPDATE-TS06 — artifact and selected-tool consistency', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, [
      'update',
      'factor-scan',
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(report.operations).toBeArray();
  });

  test('EWP-CMD-UPDATE-TS08 — failure, continuation, and cancellation truth', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, [
      'update',
      '--all',
      '--continue-on-error',
      '--dry-run',
    ]);
    expect(report).toMatchObject({ options: { continueOnError: true } });
  });

  test('EWP-CMD-UPDATE-TS09 — exact approval, JSON, and exit contracts', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, ['update', '--all', '--yes']);
    expect(report).toMatchObject({ approval: { outcome: 'approved' } });
  });

  test('EWP-CMD-UPDATE-TS10 — one exact source materialization and hash domain', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      'main',
      '--dry-run',
    ]);
    expect(report.operations).toBeArray();
    expect(report.diagnostics).toBeArray();
  });
});
