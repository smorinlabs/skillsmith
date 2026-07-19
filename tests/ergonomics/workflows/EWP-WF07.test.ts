import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import {
  APPLY_SECRET_CANARIES,
  type RemoteApplyFixture,
  SAVED_PLAN_STALE_DOMAINS,
  collectStrings,
  createRemoteApplyFixture,
  createReviewedPlan,
  destroyRemoteApplyFixture,
  jsonApplyReport,
  localAbsoluteStrings,
  runApplyCli,
  snapshotApplyState,
} from '../fixtures/p4b-apply/cases.ts';

setDefaultTimeout(60_000);

type UnknownRecord = Record<string, unknown>;

const fixtures: RemoteApplyFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(destroyRemoteApplyFixture));
});

const fixture = async (): Promise<RemoteApplyFixture> => {
  const value = await createRemoteApplyFixture();
  fixtures.push(value);
  return value;
};

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is UnknownRecord =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

const operationIds = (report: UnknownRecord): readonly unknown[] =>
  records(report.operations).map((operation) => operation.operationId);

describe('EWP-WF07', () => {
  test('saved-plan automation preserves owner-only exact authorization, scoped staleness, portability, and redaction', async () => {
    expect(SAVED_PLAN_STALE_DOMAINS).toEqual([
      'manifest-semantic',
      'lock-canonical',
      'resource',
      'selection-set',
      'capability-version',
      'executor-schema',
      'hash-schema',
    ]);

    const selected = await fixture();
    await writeFile(
      `${selected.root}/unselected-canary.txt`,
      `${APPLY_SECRET_CANARIES.join('\n')}\n`,
    );
    const reviewed = await createReviewedPlan(selected);
    const savedBytes = await readFile(selected.plan);
    expect((await stat(selected.plan)).mode & 0o777).toBe(0o600);
    expect(reviewed).toMatchObject({
      schemaVersion: 1,
      kind: 'skillsmith.plan',
      executorSchemaVersion: 1,
      hashSchemaVersion: 1,
      portability: { kind: 'portable' },
    });
    expect(records(reviewed.operations)).not.toHaveLength(0);
    expect(records(reviewed.resourcePreconditions)).not.toHaveLength(0);
    expect(records(reviewed.selectionPreconditions)).not.toHaveLength(0);
    expect(records(reviewed.capabilityPreconditions)).not.toHaveLength(0);
    expect(localAbsoluteStrings(reviewed, selected)).toEqual([]);
    for (const canary of APPLY_SECRET_CANARIES) {
      expect(collectStrings(reviewed)).not.toContain(canary);
    }

    await writeFile(
      selected.manifest,
      `${await readFile(selected.manifest, 'utf8')}# formatting-only authorization-preserving edit\n`,
    );
    const beforeValidation = await snapshotApplyState(selected);
    const dryRun = jsonApplyReport(
      await runApplyCli(selected, ['apply', '--plan', selected.plan, '--dry-run', '--json']),
      0,
      'saved dry-run',
    );
    const checked = jsonApplyReport(
      await runApplyCli(selected, ['apply', '--plan', selected.plan, '--check', '--json']),
      7,
      'saved check',
    );
    expect(operationIds(dryRun)).toEqual(operationIds(reviewed));
    expect(operationIds(checked)).toEqual(operationIds(reviewed));
    expect(await snapshotApplyState(selected)).toEqual(beforeValidation);
    expect(await readFile(selected.plan)).toEqual(savedBytes);

    const conflict = await runApplyCli(selected, [
      'apply',
      '--plan',
      selected.plan,
      '--prune',
      '--json',
    ]);
    expect(conflict.exitCode).toBe(2);
    expect(JSON.parse(conflict.stdout)).toMatchObject({ exitCode: 2 });
    expect(await snapshotApplyState(selected)).toEqual(beforeValidation);

    const applied = jsonApplyReport(
      await runApplyCli(selected, ['apply', '--plan', selected.plan, '--json']),
      0,
      'exact saved execution',
    );
    expect(operationIds(applied)).toEqual(operationIds(reviewed));
    expect(await readFile(selected.plan)).toEqual(savedBytes);

    const stale = await fixture();
    await createReviewedPlan(stale);
    await writeFile(
      stale.manifest,
      (await readFile(stale.manifest, 'utf8')).replace('scope = "user"', 'scope = "project"'),
    );
    const staleState = await snapshotApplyState(stale);
    const staleProduct = jsonApplyReport(
      await runApplyCli(stale, ['apply', '--plan', stale.plan, '--check', '--json']),
      3,
      'semantic manifest staleness',
    );
    expect(collectStrings(staleProduct).join(' ')).toContain('manifest');
    expect(await snapshotApplyState(stale)).toEqual(staleState);

    const machineBound = await fixture();
    await createReviewedPlan(machineBound, { machineBound: true });
    const otherContext = await fixture();
    const crossContext = jsonApplyReport(
      await runApplyCli(otherContext, ['apply', '--plan', machineBound.plan, '--check', '--json']),
      3,
      'machine-bound plan in another project context',
    );
    expect(collectStrings(crossContext).join(' ')).toMatch(/machine|binding|context|regenerate/i);
  });
});
