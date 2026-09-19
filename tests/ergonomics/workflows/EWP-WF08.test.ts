import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ApplyFixture,
  type RemoteApplyFixture,
  createApplyFixture,
  createRemoteApplyFixture,
  createReviewedPlan,
  destroyApplyFixture,
  destroyRemoteApplyFixture,
  jsonApplyReport,
  runApplyCli,
  snapshotApplyState,
} from '../fixtures/p4b-apply/cases.ts';

setDefaultTimeout(60_000);

const fixtures: ApplyFixture[] = [];
const remoteFixtures: RemoteApplyFixture[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map(destroyApplyFixture),
    ...remoteFixtures.splice(0).map(destroyRemoteApplyFixture),
  ]);
});

const fixture = async (): Promise<ApplyFixture> => {
  const value = await createApplyFixture();
  fixtures.push(value);
  return value;
};

const remoteFixture = async (): Promise<RemoteApplyFixture> => {
  const value = await createRemoteApplyFixture();
  remoteFixtures.push(value);
  return value;
};

describe('EWP-WF08', () => {
  test('CI JSON gates preserve state and distinguish healthy, failing, empty, drift, usage, and stale exits', async () => {
    const healthy = await fixture();
    const healthyState = await snapshotApplyState(healthy);
    jsonApplyReport(await runApplyCli(healthy, ['check', '--json']), 0, 'healthy check');
    jsonApplyReport(
      await runApplyCli(healthy, ['plan', '--locked', '--check', '--json']),
      0,
      'converged plan check',
    );
    expect(await snapshotApplyState(healthy)).toEqual(healthyState);

    const failing = await fixture();
    await mkdir(join(failing.home, '.agents'), { recursive: true });
    await writeFile(join(failing.home, '.agents', 'skills'), 'synthetic non-directory root\n');
    const failingState = await snapshotApplyState(failing);
    const failedHealth = jsonApplyReport(
      await runApplyCli(failing, ['check', '--tool', 'codex', '--scope', 'user', '--json']),
      1,
      'failing health check',
    );
    expect(failedHealth).toMatchObject({ counts: { error: 1 } });
    expect(await snapshotApplyState(failing)).toEqual(failingState);

    const drifting = await remoteFixture();
    const driftState = await snapshotApplyState(drifting);
    jsonApplyReport(
      await runApplyCli(drifting, ['plan', '--locked', '--check', '--json']),
      7,
      'fresh plan drift check',
    );
    expect(await snapshotApplyState(drifting)).toEqual(driftState);
    await createReviewedPlan(drifting);
    const planBytes = await readFile(drifting.plan);
    const savedState = await snapshotApplyState(drifting);
    jsonApplyReport(
      await runApplyCli(drifting, ['apply', '--plan', drifting.plan, '--check', '--json']),
      7,
      'valid nonempty saved plan check',
    );
    expect(await snapshotApplyState(drifting)).toEqual(savedState);
    expect(await readFile(drifting.plan)).toEqual(planBytes);

    const usage = jsonApplyReport(
      await runApplyCli(drifting, [
        'apply',
        '--plan',
        drifting.plan,
        '--dry-run',
        '--check',
        '--json',
      ]),
      2,
      'contradictory saved validation modes',
    );
    expect(usage).toMatchObject({ exitCode: 2 });
    expect(await snapshotApplyState(drifting)).toEqual(savedState);

    await writeFile(
      drifting.manifest,
      (await readFile(drifting.manifest, 'utf8')).replace('scope = "user"', 'scope = "project"'),
    );
    const staleState = await snapshotApplyState(drifting);
    const stale = jsonApplyReport(
      await runApplyCli(drifting, ['apply', '--plan', drifting.plan, '--check', '--json']),
      3,
      'stale saved authorization',
    );
    expect(stale).toMatchObject({ exitCode: 3 });
    expect(await snapshotApplyState(drifting)).toEqual(staleState);
    expect(await readFile(drifting.plan)).toEqual(planBytes);
  });
});
