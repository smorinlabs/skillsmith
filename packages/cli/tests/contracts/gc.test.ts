import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GC_SECRET_CANARIES,
  type GcCliProduct,
  type GcFleet,
  createGcFleet,
  createStoreObject,
  destroyGcFleet,
  makeUnsafeHardLink,
  pathExists,
  pinnedPair,
  projectLedgerFields,
  readLedgerText,
  removeRetiredProject,
  runGcCli,
  setObjectModifiedAt,
  snapshotGcState,
  writeEmptyLedgerV1,
  writeLedgerDocument,
  writeLedgerV2,
} from '../../../../tests/ergonomics/fixtures/p5-gc/fleet.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../core/src/application/current-services.ts';
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';

setDefaultTimeout(90_000);

type UnknownRecord = Record<string, unknown>;

const openFleets: GcFleet[] = [];

afterEach(async () => {
  await Promise.all(openFleets.splice(0).map(destroyGcFleet));
});

const fleet = async (): Promise<GcFleet> => {
  const selected = await createGcFleet();
  openFleets.push(selected);
  return selected;
};

const requireGcBoundary = (): void => {
  expect(
    {
      commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith gc'),
      applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'gc'),
    },
    'public gc CommandSpec/application service boundary is absent',
  ).toEqual({ commandSpec: true, applicationService: true });
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const requireGcReport = (product: GcCliProduct, expectedExit = 0): UnknownRecord => {
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  const parsed: unknown = JSON.parse(product.stdout);
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.gc',
    command: 'gc',
    selectionSource: 'bounded-default',
  });
  if (!isRecord(parsed)) throw new Error('GC report was not an object');
  return parsed;
};

describe('gc command contract', () => {
  test('EWP-CMD-GC-TS01 — fixed store inventory, publisher grammar, and exact reachability', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const reachable = await createStoreObject(selected, {
      namespace: 'local',
      repository: 'my repo',
      revision: 'content-111111111111',
      skill: 'review',
    });
    const extraAt = await createStoreObject(selected, {
      namespace: 'local',
      repository: 'acme@tools',
      revision: '222222222222',
      skill: 'lint',
    });
    await mkdir(join(selected.store, '.staging', 'ignored'), { recursive: true });
    const placementPath = join(selected.projects.current, '.agents', 'skills', 'review');
    const pair = pinnedPair(placementPath, reachable);
    const fields = projectLedgerFields(
      selected.projects.current,
      'review',
      'codex',
      pair,
      reachable,
    );
    await writeLedgerV2(selected, fields);

    const report = requireGcReport(await runGcCli(selected, ['gc', '--dry-run', '--json']));
    expect(report).toMatchObject({ mode: 'dry-run', state: 'planned' });
    const objects = records(report.objects);
    expect(objects).toHaveLength(2);
    expect(objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: reachable.path,
          contentHash: reachable.contentHash,
          outcome: 'protected',
        }),
        expect.objectContaining({ path: extraAt.path, outcome: 'eligible' }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('.staging/ignored');
    expect(JSON.stringify(report)).not.toContain(GC_SECRET_CANARIES[0]);
  });

  test('EWP-CMD-GC-TS02 — registrations, missing projects, v1 migration, and portable non-leases', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const object = await createStoreObject(selected, { revision: '333333333333' });
    await writeEmptyLedgerV1(selected);
    const v1Bytes = await readLedgerText(selected);
    const before = await snapshotGcState(selected);

    const preview = requireGcReport(
      await runGcCli(selected, ['gc', '--dry-run', '--older-than', '1s', '--json']),
    );
    expect(preview).toMatchObject({ migration: { sourceVersion: 1, action: 'migrate-ledger' } });
    expect(await readLedgerText(selected)).toBe(v1Bytes);
    expect(await snapshotGcState(selected)).toEqual(before);

    const result = requireGcReport(
      await runGcCli(selected, ['gc', '--older-than', '1s', '--yes', '--json']),
    );
    expect(result).toMatchObject({ mode: 'execute', state: 'completed' });
    expect(JSON.parse(await readLedgerText(selected))).toMatchObject({ schemaVersion: 2 });
    expect(await pathExists(object.path)).toBeFalse();

    await writeLedgerDocument(selected, { schemaVersion: 99, kind: 'skillsmith.placements' });
    expect((await runGcCli(selected, ['gc', '--dry-run', '--json'])).exitCode).toBe(3);
  });

  test('EWP-CMD-GC-TS03 — journal, history, undo-window, and lineage retention', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const protectedObject = await createStoreObject(selected, {
      revision: '444444444444',
      skill: 'policy',
    });
    const placementPath = join(selected.projects.current, '.claude', 'skills', 'policy');
    const pair = pinnedPair(placementPath, protectedObject);
    await writeLedgerV2(selected, {
      skills: { policy: { tools: { 'claude-code': pair } } },
      transactions: {},
      history: [],
    });

    const report = requireGcReport(
      await runGcCli(selected, ['gc', '--dry-run', '--older-than', '1s', '--json']),
    );
    expect(records(report.objects)).toContainEqual(
      expect.objectContaining({
        path: protectedObject.path,
        outcome: 'protected',
        protection: expect.arrayContaining([expect.objectContaining({ kind: 'ledger' })]),
      }),
    );
    expect(report.summary).toMatchObject({ eligibleItems: 0, eligibleBytes: 0 });
  });

  test('EWP-CMD-GC-TS04 — duration grammar and strict age cutoff boundaries', async () => {
    requireGcBoundary();
    const selected = await fleet();
    await writeLedgerV2(selected);
    const old = await createStoreObject(selected, {
      revision: '555555555555',
      skill: 'old',
      modifiedAt: new Date(Date.now() - 120_000),
    });
    const recent = await createStoreObject(selected, {
      revision: '666666666666',
      skill: 'recent',
    });
    await setObjectModifiedAt(recent, new Date());

    for (const duration of ['0s', '-1s', '+1s', '1.5h', ' 1h', '1', '1H', '999999999999999999w']) {
      const product = await runGcCli(selected, ['gc', '--older-than', duration, '--dry-run']);
      expect(product.exitCode, duration).toBe(2);
    }
    const report = requireGcReport(
      await runGcCli(selected, ['gc', '--older-than', '1m', '--dry-run', '--json']),
    );
    expect(report).toMatchObject({ olderThan: { input: '1m', milliseconds: 60_000 } });
    expect(records(report.objects)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: old.path, outcome: 'eligible' }),
        expect.objectContaining({ path: recent.path, outcome: 'age-filtered' }),
      ]),
    );
  });

  test('EWP-CMD-GC-TS05 — logical bytes and whole-invocation unsafe measurement refusal', async () => {
    requireGcBoundary();
    const selected = await fleet();
    await writeLedgerV2(selected);
    const safe = await createStoreObject(selected, {
      revision: '777777777777',
      files: { 'nested/payload.txt': 'abc' },
      symlinks: { alias: 'nested/payload.txt' },
    });
    const preview = requireGcReport(await runGcCli(selected, ['gc', '--dry-run', '--json']));
    expect(records(preview.objects)).toContainEqual(
      expect.objectContaining({ path: safe.path, logicalBytes: safe.logicalBytes }),
    );
    expect(preview.summary).toMatchObject({ eligibleBytes: safe.logicalBytes });

    await makeUnsafeHardLink(safe);
    const before = await snapshotGcState(selected);
    const refused = requireGcReport(await runGcCli(selected, ['gc', '--yes', '--json']), 3);
    expect(refused).toMatchObject({ state: 'refused' });
    expect(records(refused.actions)).toHaveLength(0);
    expect(refused.summary).toMatchObject({ eligibleItems: null, eligibleBytes: null });
    expect(await snapshotGcState(selected)).toEqual(before);
  });

  test('EWP-CMD-GC-TS06 — exact approval, dry-run identity, filter-zero, and recovery retry', async () => {
    requireGcBoundary();
    const selected = await fleet();
    await writeLedgerV2(selected);
    const object = await createStoreObject(selected, { revision: '888888888888' });
    expect((await runGcCli(selected, ['gc', '--dry-run', '--yes'])).exitCode).toBe(2);
    expect((await runGcCli(selected, ['gc', '--json'])).exitCode).toBe(2);

    const before = await snapshotGcState(selected);
    const preview = requireGcReport(await runGcCli(selected, ['gc', '--dry-run', '--json']));
    expect(await snapshotGcState(selected)).toEqual(before);
    expect(await pathExists(selected.recovery)).toBeFalse();

    const execution = requireGcReport(await runGcCli(selected, ['gc', '--yes', '--json']));
    expect(execution.planId).toBe(preview.planId);
    expect(execution.actions).toEqual(preview.actions);
    expect(await pathExists(object.path)).toBeFalse();
    expect(await pathExists(selected.recovery)).toBeTrue();

    const noOp = requireGcReport(await runGcCli(selected, ['gc', '--json']));
    expect(noOp).toMatchObject({ state: 'no-op', summary: { eligibleItems: 0 } });
  });

  test('EWP-CMD-GC-TS07 — exact missing-project forget and derived ledger mutation', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const object = await createStoreObject(selected, {
      revision: '999999999999',
      skill: 'retired',
    });
    const placementPath = join(selected.projects.retired, '.agents', 'skills', 'retired');
    const pair = pinnedPair(placementPath, object);
    const fields = projectLedgerFields(selected.projects.retired, 'retired', 'codex', pair, object);
    await writeLedgerV2(selected, fields);
    await removeRetiredProject(selected);
    await Promise.all([
      writeFile(join(selected.cwd, 'skillsmith.toml'), 'version = 1\n'),
      writeFile(join(selected.cwd, 'skillsmith.lock'), '{"version":1}\n'),
    ]);
    const portableBefore = await Promise.all([
      readFile(join(selected.cwd, 'skillsmith.toml'), 'utf8'),
      readFile(join(selected.cwd, 'skillsmith.lock'), 'utf8'),
    ]);

    const report = requireGcReport(
      await runGcCli(selected, [
        'gc',
        '--forget-project',
        selected.projects.retired,
        '--forget-project',
        selected.projects.retired,
        '--yes',
        '--json',
      ]),
    );
    expect(records(report.projects)).toHaveLength(1);
    expect(records(report.projects)[0]).toMatchObject({
      root: selected.projects.retired,
      action: 'forget-project',
      outcome: 'forgotten',
    });
    const ledger = JSON.parse(await readLedgerText(selected)) as UnknownRecord;
    expect(ledger.projects).not.toHaveProperty(selected.projects.retired);
    expect(ledger.projectRegistrations).not.toHaveProperty(selected.projects.retired);
    expect(await pathExists(object.path)).toBeFalse();
    expect(
      await Promise.all([
        readFile(join(selected.cwd, 'skillsmith.toml'), 'utf8'),
        readFile(join(selected.cwd, 'skillsmith.lock'), 'utf8'),
      ]),
    ).toEqual(portableBefore);

    expect(
      (await runGcCli(selected, ['gc', '--forget-project', selected.projects.current, '--yes']))
        .exitCode,
    ).toBe(2);
  });

  test('EWP-CMD-GC-TS08 — owner-bound tombstones, crash convergence, and zero reachable deletion', async () => {
    requireGcBoundary();
    const selected = await fleet();
    const reachable = await createStoreObject(selected, {
      revision: 'aaaaaaaaaaaa',
      skill: 'reachable',
    });
    const reclaimable = await createStoreObject(selected, {
      revision: 'bbbbbbbbbbbb',
      skill: 'reclaimable',
    });
    const pair = pinnedPair(
      join(selected.projects.current, '.agents', 'skills', 'reachable'),
      reachable,
    );
    await writeLedgerV2(selected, { skills: { reachable: { tools: { codex: pair } } } });

    const result = requireGcReport(await runGcCli(selected, ['gc', '--yes', '--json']));
    expect(result).toMatchObject({ state: 'completed' });
    expect(await pathExists(reachable.path)).toBeTrue();
    expect(await pathExists(reclaimable.path)).toBeFalse();

    const planted = join(selected.store, '.gc-tombstones', 'v1', 'planted');
    await mkdir(planted, { recursive: true });
    await writeFile(join(planted, 'owner.json'), '{}\n');
    const before = await snapshotGcState(selected);
    expect((await runGcCli(selected, ['gc', '--yes', '--json'])).exitCode).toBe(3);
    expect(await snapshotGcState(selected)).toEqual(before);
    await rm(join(selected.store, '.gc-tombstones'), { recursive: true, force: true });
  });
});
