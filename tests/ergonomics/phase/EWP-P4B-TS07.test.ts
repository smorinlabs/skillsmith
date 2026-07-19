import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  APPLY_PORTABILITY_MATRIX,
  APPLY_SECRET_CANARIES,
  collectStrings,
  createApplyFixture,
  createReviewedPlan,
  destroyApplyFixture,
  jsonApplyReport,
  localAbsoluteStrings,
  runApplyCli,
  snapshotApplyState,
} from '../fixtures/p4b-apply/cases.ts';

setDefaultTimeout(60_000);

type UnknownRecord = Record<string, unknown>;

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is UnknownRecord =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

const assertNoCanary = (label: string, value: unknown): void => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const canary of APPLY_SECRET_CANARIES) expect(serialized, label).not.toContain(canary);
};

describe('EWP-P4B-TS07', () => {
  test('portable plans and exact validation reports contain no local absolute fixture path', async () => {
    expect(APPLY_PORTABILITY_MATRIX).toEqual([
      'portable-zero-local-path',
      'machine-bound-reasons',
      'machine-bound-exact-context',
      'cross-context-refusal',
      'nested-canary-redaction',
    ]);
    const fixture = await createApplyFixture([{ name: 'alpha' }]);
    try {
      const saved = await createReviewedPlan(fixture);
      expect(saved.portability).toEqual({ kind: 'portable', reasons: [] });
      expect(localAbsoluteStrings(saved, fixture)).toEqual([]);
      const validated = jsonApplyReport(
        await runApplyCli(fixture, ['apply', '--plan', fixture.plan, '--dry-run', '--json']),
        0,
        'portable exact validation',
      );
      expect(localAbsoluteStrings(validated, fixture)).toEqual([]);
      expect(records(validated.operations)).toEqual(records(saved.operations));
    } finally {
      await destroyApplyFixture(fixture);
    }
  });

  test('machine-bound plans name each path/reason, validate only in context, and guide refusal', async () => {
    const fixture = await createApplyFixture([{ name: 'alpha' }]);
    try {
      const saved = await createReviewedPlan(fixture, { machineBound: true });
      const portability = saved.portability as UnknownRecord;
      const reasons = records(portability.reasons);
      expect(portability.kind).toBe('machine-bound');
      expect(reasons).not.toHaveLength(0);
      expect(reasons.every((reason) => typeof reason.code === 'string')).toBeTrue();
      expect(reasons.every((reason) => typeof reason.path === 'string')).toBeTrue();
      expect(localAbsoluteStrings(saved, fixture)).not.toHaveLength(0);
      expect(
        collectStrings(saved.resourcePreconditions).some((value) => value === fixture.manifest),
      ).toBeTrue();

      const local = jsonApplyReport(
        await runApplyCli(fixture, ['apply', '--plan', fixture.plan, '--dry-run', '--json']),
        0,
        'same-context machine-bound validation',
      );
      expect(records(local.operations)).toEqual(records(saved.operations));

      const otherProject = join(fixture.root, 'other-project');
      await mkdir(otherProject);
      const movedContext = { ...fixture, cwd: otherProject };
      const refused = await runApplyCli(movedContext, [
        'apply',
        '--plan',
        fixture.plan,
        '--dry-run',
        '--json',
      ]);
      const report = jsonApplyReport(refused, 3, 'cross-context machine-bound refusal');
      const refusal = `${JSON.stringify(report)}\n${refused.stderr}`.toLowerCase();
      expect(refusal).toMatch(/machine|binding|project|context/u);
      expect(refusal).toMatch(/regenerate|new plan|manifest.*lock|original (?:machine|context)/u);
    } finally {
      await destroyApplyFixture(fixture);
    }
  });

  test('nested secret canaries stay out of saved output, debug failure streams, and residue', async () => {
    const base = await createApplyFixture([{ name: 'alpha' }]);
    const fixture = {
      ...base,
      env: Object.freeze({
        ...base.env,
        GH_TOKEN: APPLY_SECRET_CANARIES[0],
        SKILLSMITH_AUTH_TOKEN: APPLY_SECRET_CANARIES[1],
        SKILLSMITH_TEST_NESTED_ERROR: JSON.stringify({
          cause: { credential: APPLY_SECRET_CANARIES[2] },
        }),
      }),
    };
    try {
      await createReviewedPlan(fixture);
      assertNoCanary('saved plan', await readFile(fixture.plan, 'utf8'));

      const manifest = await readFile(fixture.manifest, 'utf8');
      await writeFile(
        fixture.manifest,
        manifest.replace('placement = "copy"', 'placement = "symlink"'),
      );
      const stale = await runApplyCli(fixture, [
        'apply',
        '--plan',
        fixture.plan,
        '--dry-run',
        '--json',
        '--verbose',
      ]);
      jsonApplyReport(stale, 3, 'redacted stale-plan debug failure');
      assertNoCanary('stale stdout', stale.stdout);
      assertNoCanary('stale stderr', stale.stderr);
      assertNoCanary('saved plan after failure', await readFile(fixture.plan, 'utf8'));
      assertNoCanary('state and partial-failure residue', await snapshotApplyState(fixture));
    } finally {
      await destroyApplyFixture(fixture);
    }
  });
});
