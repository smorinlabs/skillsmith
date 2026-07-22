import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import {
  type SyncFleet,
  createSyncFleet,
  destroySyncFleet,
  readSkillBytes,
  runSyncCli,
} from '../../../../tests/ergonomics/fixtures/p5-sync/fleet.ts';
import { hashManifestSemantics } from '../../../core/src/artifacts/hash.ts';
import type { PortableLockV1 } from '../../../core/src/artifacts/lock.ts';
import { artifactContractRegistry } from '../../../core/src/artifacts/registry.ts';
import type { NormalizedManifestV1 } from '../../../core/src/artifacts/types.ts';

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

    await syncReport(selected, [
      'sync',
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
  }, 20_000);

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
