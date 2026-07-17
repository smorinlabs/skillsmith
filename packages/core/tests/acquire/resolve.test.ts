import { describe, expect, test } from 'bun:test';
import { matchCandidates, resolveRemoteSource, selectSkill } from '../../src/acquire/resolve.ts';
import { parseSource } from '../../src/acquire/source.ts';
import type {
  AcquisitionPorts,
  CandidateSkill,
  InstallSourceTransport,
  SourceSpec,
} from '../../src/acquire/types.ts';
import { sourceUnresolvableError } from '../../src/errors.ts';
import { emptyLedger } from '../../src/place/ledger.ts';
import { err, ok } from '../../src/result.ts';

const webReview: CandidateSkill = { path: 'plugins/web/skills/review', name: 'review' };
const apiReview: CandidateSkill = { path: 'plugins/api/skills/review', name: 'review' };
const factorScan: CandidateSkill = { path: 'plugins/fh/skills/factor-scan', name: 'factor-scan' };
const all: readonly CandidateSkill[] = [webReview, apiReview, factorScan];
const SHA = 'a'.repeat(40);
const NOW = '2026-07-16T00:00:00.000Z';

const sourceOf = (input: string): SourceSpec => {
  const parsed = parseSource(input);
  if (!parsed.ok) throw new Error('resolver test source must parse');
  return parsed.value;
};

const portsWithPathKind = (kind: 'absent' | 'dir' = 'absent'): AcquisitionPorts =>
  ({ pathKind: async () => kind }) as unknown as AcquisitionPorts;

const transportWith = (
  overrides: Partial<InstallSourceTransport> = {},
): InstallSourceTransport => ({
  resolveRef: async () => ok(null),
  fetchRepo: async () => ok({ sha: SHA }),
  listSkills: async () => ok({ candidates: [factorScan], scanned: 1 }),
  materializeSkill: async () => ok('/fetch/tx/plugins/fh/skills/factor-scan'),
  ...overrides,
});

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

describe('resolveRemoteSource', () => {
  test('returns a resolved materialization and caller-owned cleanup directory', async () => {
    let allocations = 0;
    const result = await resolveRemoteSource({
      ports: portsWithPathKind(),
      source: sourceOf('acme/repo//plugins/fh/skills/factor-scan'),
      transport: transportWith(),
      ledger: emptyLedger(NOW),
      scopeKey: null,
      storeRoot: '/store',
      createFetchDirectory: () => {
        allocations += 1;
        return '/fetch/tx';
      },
    });

    expect(result).toEqual({
      kind: 'resolved',
      materialization: {
        sha: SHA,
        skillName: 'factor-scan',
        skillPath: 'plugins/fh/skills/factor-scan',
        materializedDir: '/fetch/tx/plugins/fh/skills/factor-scan',
      },
      cleanupDirectory: '/fetch/tx',
    });
    expect(allocations).toBe(1);
  });

  test('returns no-match with the resolved revision and searched count', async () => {
    const result = await resolveRemoteSource({
      ports: portsWithPathKind(),
      source: sourceOf('acme/repo/missing'),
      transport: transportWith(),
      ledger: emptyLedger(NOW),
      scopeKey: null,
      storeRoot: '/store',
      createFetchDirectory: () => '/fetch/no-match',
    });

    expect(result).toEqual({
      kind: 'no-match',
      resolvedSha: SHA,
      searched: 1,
      cleanupDirectory: '/fetch/no-match',
    });
  });

  test('returns ordered canonical candidates for an ambiguous whole-repository source', async () => {
    const result = await resolveRemoteSource({
      ports: portsWithPathKind(),
      source: sourceOf('acme/repo'),
      transport: transportWith({
        listSkills: async () => ok({ candidates: [webReview, apiReview], scanned: 2 }),
      }),
      ledger: emptyLedger(NOW),
      scopeKey: null,
      storeRoot: '/store',
      createFetchDirectory: () => '/fetch/ambiguous',
    });

    expect(result).toEqual({
      kind: 'ambiguous',
      candidates: ['acme/repo//plugins/web/skills/review', 'acme/repo//plugins/api/skills/review'],
      cleanupDirectory: '/fetch/ambiguous',
    });
  });

  test('returns a source failure without owning cleanup execution', async () => {
    const error = sourceUnresolvableError('fixture fetch failed');
    const result = await resolveRemoteSource({
      ports: portsWithPathKind(),
      source: sourceOf('acme/repo'),
      transport: transportWith({ fetchRepo: async () => err(error) }),
      ledger: emptyLedger(NOW),
      scopeKey: null,
      storeRoot: '/store',
      createFetchDirectory: () => '/fetch/failed',
    });

    expect(result).toEqual({
      kind: 'source-failure',
      error,
      cleanupDirectory: '/fetch/failed',
    });
  });

  test('elides fetch without allocating a transaction directory when the store entry exists', async () => {
    let fetches = 0;
    let allocations = 0;
    let checkedPath = '';
    const ports = {
      pathKind: async (path: string) => {
        checkedPath = path;
        return 'dir' as const;
      },
    } as unknown as AcquisitionPorts;
    const result = await resolveRemoteSource({
      ports,
      source: sourceOf('acme/repo//plugins/fh/skills/factor-scan'),
      transport: transportWith({
        resolveRef: async () => ok(SHA),
        fetchRepo: async () => {
          fetches += 1;
          return ok({ sha: SHA });
        },
      }),
      ledger: emptyLedger(NOW),
      scopeKey: null,
      storeRoot: '/store',
      createFetchDirectory: () => {
        allocations += 1;
        return '/fetch/must-not-be-allocated';
      },
    });

    expect(result).toEqual({
      kind: 'resolved',
      materialization: {
        sha: SHA,
        skillName: 'factor-scan',
        skillPath: 'plugins/fh/skills/factor-scan',
        materializedDir: '/store/acme/repo@aaaaaaaaaaaa/factor-scan',
      },
      cleanupDirectory: null,
    });
    expect(checkedPath).toBe('/store/acme/repo@aaaaaaaaaaaa/factor-scan');
    expect(fetches).toBe(0);
    expect(allocations).toBe(0);
  });
});
