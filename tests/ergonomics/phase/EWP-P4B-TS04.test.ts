import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PRUNE_EXCLUSIONS,
  createPlanFixture,
  destroyPlanFixture,
  fileSnapshot,
  jsonReport,
  runPlanCli,
} from '../fixtures/p4b-plan/cases.ts';

setDefaultTimeout(60_000);

type UnknownRecord = Record<string, unknown>;

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is UnknownRecord =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

describe('EWP-P4B-TS04', () => {
  test('prune never deletes unmanaged, undeclared, unselected, other-scope/project/pair, unknown, custom, or zero-selection state', async () => {
    expect(PRUNE_EXCLUSIONS).toEqual([
      'unmanaged',
      'undeclared',
      'unselected-tool',
      'unselected-scope',
      'other-project',
      'other-artifact-pair',
      'unknown-adapter',
      'custom-root',
      'filter-to-zero',
    ]);

    const fixture = await createPlanFixture();
    const canaries = [
      join(fixture.home, '.claude', 'skills', 'unmanaged', 'SKILL.md'),
      join(fixture.home, '.codex', 'skills', 'undeclared', 'SKILL.md'),
      join(fixture.cwd, '.claude', 'skills', 'other-project', 'SKILL.md'),
      join(fixture.root, 'other-pair', 'skills', 'other-artifact', 'SKILL.md'),
      join(fixture.root, 'custom-root', 'unknown-adapter', 'SKILL.md'),
    ];
    for (const path of canaries) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, `canary:${path}\n`);
    }
    const before = await fileSnapshot(canaries);

    try {
      const product = await runPlanCli(fixture, [
        'plan',
        '--file',
        fixture.manifest,
        '--locked',
        '--prune',
        '--json',
      ]);
      const report = jsonReport(product, 0, 'empty prune authority');
      expect(records(report.operations).filter((row) => row.kind === 'remove')).toHaveLength(0);
      expect(await fileSnapshot(canaries)).toEqual(before);
      for (const path of canaries) expect(await readFile(path, 'utf8')).toBe(`canary:${path}\n`);

      const zero = await runPlanCli(fixture, [
        'plan',
        '--file',
        fixture.manifest,
        '--locked',
        '--prune',
        '--tool',
        'opencode',
        '--json',
      ]);
      expect(records(jsonReport(zero, 0, 'filter-to-zero prune').operations)).toHaveLength(0);
      expect(await fileSnapshot(canaries)).toEqual(before);
    } finally {
      await destroyPlanFixture(fixture);
    }
  });
});
