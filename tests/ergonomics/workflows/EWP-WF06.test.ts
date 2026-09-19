import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { lstat, writeFile } from 'node:fs/promises';
import {
  type RemoteApplyFixture,
  createRemoteApplyFixture,
  destroyRemoteApplyFixture,
  jsonApplyReport,
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
  const value = await createRemoteApplyFixture({ includeReview: true });
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

describe('EWP-WF06', () => {
  test('interactive plan/apply shares one exact approved product, revalidates, converges, and requires prune for removal', async () => {
    const selected = await fixture();
    const plan = jsonApplyReport(
      await runApplyCli(selected, ['plan', '--locked', '--json']),
      0,
      'interactive workflow plan',
    );
    const planIds = operationIds(plan);
    expect(planIds).not.toHaveLength(0);
    expect(new Set(planIds).size).toBe(planIds.length);

    const beforeRefusal = await snapshotApplyState(selected);
    const refusal = await runApplyCli(selected, ['apply', '--locked', '--json']);
    expect(refusal.exitCode).toBe(2);
    expect(JSON.parse(refusal.stdout)).toMatchObject({
      kind: 'skillsmith.apply-report',
      state: 'refused',
      approval: { required: true, outcome: 'refused' },
    });
    expect(refusal.stderr).toBe('');
    expect(await snapshotApplyState(selected)).toEqual(beforeRefusal);

    const preview = jsonApplyReport(
      await runApplyCli(selected, ['apply', '--locked', '--dry-run', '--json']),
      0,
      'fresh apply dry-run',
    );
    expect(operationIds(preview)).toEqual(planIds);
    expect(await snapshotApplyState(selected)).toEqual(beforeRefusal);

    const execution = jsonApplyReport(
      await runApplyCli(selected, ['apply', '--locked', '--yes', '--json']),
      0,
      'approved fresh apply',
    );
    expect(operationIds(execution)).toEqual(planIds);
    expect(records(execution.results).map((result) => result.operationId)).toEqual(planIds);
    expect(await lstat(selected.skill.livePath)).toBeDefined();

    const converged = jsonApplyReport(
      await runApplyCli(selected, ['plan', '--locked', '--json']),
      0,
      'second plan after apply',
    );
    expect(records(converged.operations)).toHaveLength(0);
    const noOpState = await snapshotApplyState(selected);
    jsonApplyReport(
      await runApplyCli(selected, ['apply', '--locked', '--json']),
      0,
      'no-op apply does not prompt',
    );
    expect(await snapshotApplyState(selected)).toEqual(noOpState);

    await writeFile(
      selected.manifest,
      `${[
        'version = 1',
        '',
        '[[skills]]',
        'name = "review"',
        'source = "fixture.invalid/acme/multi//plugins/web/skills/review"',
        'tools = ["codex"]',
        'scope = "user"',
        'placement = "copy"',
        '',
      ].join('\n')}\n`,
    );
    const withoutPrune = jsonApplyReport(
      await runApplyCli(selected, ['plan', '--json']),
      0,
      'removal is not authorized without prune',
    );
    expect(records(withoutPrune.operations).some((operation) => operation.kind === 'remove')).toBe(
      false,
    );
    jsonApplyReport(
      await runApplyCli(selected, ['apply', '--yes', '--json']),
      0,
      'non-pruning reconciliation',
    );
    expect(await lstat(selected.skill.livePath)).toBeDefined();

    const prunePlan = jsonApplyReport(
      await runApplyCli(selected, ['plan', '--prune', '--json']),
      0,
      'explicit prune plan',
    );
    expect(records(prunePlan.operations).map((operation) => operation.kind)).toContain('remove');
    const prunePreview = jsonApplyReport(
      await runApplyCli(selected, ['apply', '--prune', '--dry-run', '--json']),
      0,
      'explicit prune preview',
    );
    expect(operationIds(prunePreview)).toEqual(operationIds(prunePlan));
    jsonApplyReport(
      await runApplyCli(selected, ['apply', '--prune', '--yes', '--json']),
      0,
      'explicit prune execution',
    );
    await expect(lstat(selected.skill.livePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
