import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SAVED_PLAN_STALE_DOMAINS,
  createApplyFixture,
  createRemoteApplyFixture,
  createReviewedPlan,
  destroyApplyFixture,
  destroyRemoteApplyFixture,
  jsonApplyReport,
  runApplyCli,
  snapshotApplyState,
  writeCanonicalPlanVariant,
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

const operations = (report: UnknownRecord) => records(report.operations);

const validationText = async (
  fixture: Parameters<typeof runApplyCli>[0],
  plan: string,
  expectedExit: 0 | 3,
): Promise<string> => {
  const before = await snapshotApplyState(fixture);
  const planBytes = await readFile(plan);
  const product = await runApplyCli(fixture, ['apply', '--plan', plan, '--dry-run', '--json']);
  const report = jsonApplyReport(product, expectedExit, `saved validation ${plan}`);
  expect(await readFile(plan)).toEqual(planBytes);
  expect(await snapshotApplyState(fixture)).toEqual(before);
  return `${JSON.stringify(report)}\n${product.stderr}`.toLowerCase();
};

describe('EWP-P4B-TS03', () => {
  test('saved dry-run/check/execute retain the artifact and use only its exact operation IDs', async () => {
    const fixture = await createRemoteApplyFixture();
    try {
      const saved = await createReviewedPlan(fixture);
      const expectedOperations = records(saved.operations);
      const expectedIds = expectedOperations.map((operation) => operation.operationId);
      expect(expectedIds).not.toHaveLength(0);
      const reviewedBytes = await readFile(fixture.plan);
      const stateBeforeValidation = await snapshotApplyState(fixture);

      const dryRun = jsonApplyReport(
        await runApplyCli(fixture, ['apply', '--plan', fixture.plan, '--dry-run', '--json']),
        0,
        'saved dry-run',
      );
      const check = jsonApplyReport(
        await runApplyCli(fixture, ['apply', '--plan', fixture.plan, '--check', '--json']),
        7,
        'saved check',
      );
      expect(operations(dryRun).map((operation) => operation.operationId)).toEqual(expectedIds);
      expect(operations(check)).toEqual(operations(dryRun));
      expect(await snapshotApplyState(fixture)).toEqual(stateBeforeValidation);

      const applied = jsonApplyReport(
        await runApplyCli(fixture, ['apply', '--plan', fixture.plan, '--json']),
        0,
        'saved exact execution',
      );
      expect(operations(applied).map((operation) => operation.operationId)).toEqual(expectedIds);
      expect(await readFile(join(fixture.skill.livePath, 'SKILL.md'), 'utf8')).toContain(
        'name: lint',
      );
      expect(await readFile(fixture.plan)).toEqual(reviewedBytes);
    } finally {
      await destroyRemoteApplyFixture(fixture);
    }
  });

  test('manifest, lock, resource, and selection facts stale independently while unrelated facts remain valid', async () => {
    expect(SAVED_PLAN_STALE_DOMAINS).toEqual([
      'manifest-semantic',
      'lock-canonical',
      'resource',
      'selection-set',
      'capability-version',
      'executor-schema',
      'hash-schema',
    ]);
    const fixture = await createApplyFixture([{ name: 'alpha' }]);
    try {
      await createReviewedPlan(fixture);
      const [manifestBytes, lockBytes] = await Promise.all([
        readFile(fixture.manifest, 'utf8'),
        readFile(fixture.lock, 'utf8'),
      ]);

      await writeFile(fixture.manifest, `# formatting-only edit\n${manifestBytes}`);
      expect(await validationText(fixture, fixture.plan, 0)).not.toContain('stale');

      await writeFile(
        fixture.manifest,
        manifestBytes.replace('placement = "copy"', 'placement = "symlink"'),
      );
      expect(await validationText(fixture, fixture.plan, 3)).toMatch(/manifest|semantic/u);

      await writeFile(fixture.manifest, manifestBytes);
      await writeFile(
        fixture.lock,
        lockBytes.replace(
          `resolved_sha = "${'a'.repeat(40)}"`,
          `resolved_sha = "${'c'.repeat(40)}"`,
        ),
      );
      expect(await validationText(fixture, fixture.plan, 3)).toMatch(/lock|canonical/u);

      await writeFile(fixture.lock, lockBytes);
      const unrelated = join(fixture.live.user, 'unrelated', 'SKILL.md');
      await mkdir(join(unrelated, '..'), { recursive: true });
      await writeFile(
        unrelated,
        '---\nname: unrelated\ndescription: unrelated local fixture\n---\n',
      );
      expect(await validationText(fixture, fixture.plan, 0)).not.toContain('stale');

      const referenced = join(fixture.live.user, 'alpha', 'SKILL.md');
      await mkdir(join(referenced, '..'), { recursive: true });
      await writeFile(referenced, '---\nname: alpha\ndescription: changed after review\n---\n');
      expect(await validationText(fixture, fixture.plan, 3)).toMatch(/resource|live|alpha/u);
      await rm(join(referenced, '..'), { recursive: true, force: true });

      await writeFile(
        fixture.manifest,
        `${manifestBytes}\n[[skills]]\nname = "beta"\nsource = "fixture.invalid/acme/skills//skills/beta"\ntools = ["codex"]\nscope = "user"\nplacement = "copy"\n`,
      );
      expect(await validationText(fixture, fixture.plan, 3)).toMatch(
        /selection|selected|manifest/u,
      );
    } finally {
      await destroyApplyFixture(fixture);
    }
  });

  test('capability, executor, and hash compatibility variants refuse as state without replanning', async () => {
    const fixture = await createApplyFixture([{ name: 'alpha' }]);
    try {
      await createReviewedPlan(fixture);
      const variants = [
        {
          name: 'capability-version',
          pattern: /capabilit/u,
          mutate: (draft: UnknownRecord) => {
            const capability = records(draft.capabilityPreconditions)[0];
            if (capability === undefined) throw new Error('fixture has no capability precondition');
            capability.capabilityVersion = 'fixture-incompatible-capability-v999';
          },
        },
        {
          name: 'executor-schema',
          pattern: /executor|schema/u,
          mutate: (draft: UnknownRecord) => {
            draft.executorSchemaVersion = 999;
          },
        },
        {
          name: 'hash-schema',
          pattern: /hash|schema/u,
          mutate: (draft: UnknownRecord) => {
            draft.hashSchemaVersion = 999;
          },
        },
      ] as const;

      for (const variant of variants) {
        const path = join(fixture.cwd, `${variant.name}.skillsmith.plan`);
        await writeCanonicalPlanVariant(fixture.plan, path, variant.mutate);
        const text = await validationText(fixture, path, 3);
        expect(text, variant.name).toMatch(variant.pattern);
        expect(text, `${variant.name}: regeneration guidance`).toMatch(
          /regenerate|new plan|replan/u,
        );
      }
    } finally {
      await destroyApplyFixture(fixture);
    }
  });
});
