import { describe, expect, test } from 'bun:test';
import { matchCandidates, selectSkill } from '../../src/acquire/resolve.ts';
import type { CandidateSkill } from '../../src/acquire/types.ts';

const webReview: CandidateSkill = { path: 'plugins/web/skills/review', name: 'review' };
const apiReview: CandidateSkill = { path: 'plugins/api/skills/review', name: 'review' };
const factorScan: CandidateSkill = { path: 'plugins/fh/skills/factor-scan', name: 'factor-scan' };
const all: readonly CandidateSkill[] = [webReview, apiReview, factorScan];

describe('matchCandidates', () => {
  test('whole-repo returns every candidate', () => {
    expect(matchCandidates(all, { kind: 'whole-repo' })).toHaveLength(3);
  });

  test('R1: a name matches every candidate with that basename, at any depth', () => {
    const matches = matchCandidates(all, { kind: 'name', name: 'review' });
    expect(matches.map((c) => c.path).sort()).toEqual([
      'plugins/api/skills/review',
      'plugins/web/skills/review',
    ]);
  });

  test('name matching is case-sensitive', () => {
    expect(matchCandidates(all, { kind: 'name', name: 'Review' })).toEqual([]);
  });

  test('a path selector matches exactly one candidate', () => {
    expect(matchCandidates(all, { kind: 'path', path: 'plugins/fh/skills/factor-scan' })).toEqual([
      factorScan,
    ]);
  });

  test('a path selector miss returns []', () => {
    expect(matchCandidates(all, { kind: 'path', path: 'plugins/none/skills/x' })).toEqual([]);
  });
});

describe('selectSkill', () => {
  test('R3: a single match is chosen', async () => {
    expect(await selectSkill([factorScan], 3)).toEqual({ kind: 'chosen', skill: factorScan });
  });

  test('zero matches → none carrying the searched count', async () => {
    expect(await selectSkill([], 5)).toEqual({ kind: 'none', searched: 5 });
  });

  test('R2: multiple matches without a picker → ambiguous', async () => {
    expect(await selectSkill([webReview, apiReview], 3)).toEqual({
      kind: 'ambiguous',
      candidates: [webReview, apiReview],
    });
  });

  test('R2: a picker that chooses resolves to chosen', async () => {
    const sel = await selectSkill([webReview, apiReview], 3, async (cands) => cands[0] ?? null);
    expect(sel).toEqual({ kind: 'chosen', skill: webReview });
  });

  test('R2: a picker that cancels (null) → ambiguous', async () => {
    const sel = await selectSkill([webReview, apiReview], 3, async () => null);
    expect(sel).toEqual({ kind: 'ambiguous', candidates: [webReview, apiReview] });
  });
});
