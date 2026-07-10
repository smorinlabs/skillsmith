import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { emptyLedger, setPair } from '../../src/place/ledger.ts';
import { storeRootOf } from '../../src/place/paths.ts';
import { LEGACY_ROOT_NOTICE, planFlips } from '../../src/place/plan.ts';
import type {
  DevRecord,
  FlipOptions,
  LedgerFile,
  PairRecord,
  PinnedRecord,
} from '../../src/place/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const NOW = '2026-07-07T00:00:00Z';

const dev = (sourcePath: string): DevRecord => ({
  sourcePath,
  resolvedPath: sourcePath,
  repoRoot: null,
  sourceRelPath: null,
  remote: null,
  recordedAt: NOW,
});

describe('planFlips', () => {
  let f: FixtureFleet;
  let storeRoot: string;

  beforeEach(async () => {
    f = await buildFixtureFleet();
    storeRoot = storeRootOf(f.data);
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  const baseOpts = (
    overrides: Partial<FlipOptions> & { op?: 'promote' | 'dev' } = {},
  ): FlipOptions & { op: 'promote' | 'dev' } => ({
    targets: [],
    cwd: f.home,
    envVars: f.envVars,
    op: 'promote',
    ...overrides,
  });

  test('name target: promote alpha resolves to claude-code only', async () => {
    const r = await planFlips(f.env, baseOpts({ targets: ['alpha'] }), storeRoot, emptyLedger(NOW));
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs).toHaveLength(1);
    expect(r.value.pairs[0]?.tool).toBe('claude-code');
    expect(r.value.pairs[0]?.skill).toBe('alpha');
    expect(r.value.preResults).toEqual([]);
  });

  test('path target resolves the same placement as the equivalent name target', async () => {
    const path = join(f.home, '.claude', 'skills', 'alpha');
    const r = await planFlips(f.env, baseOpts({ targets: [path] }), storeRoot, emptyLedger(NOW));
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs).toHaveLength(1);
    expect(r.value.pairs[0]?.tool).toBe('claude-code');
    expect(r.value.pairs[0]?.skill).toBe('alpha');
  });

  test('owning-tool inference: a codex-current-root path resolves to codex, no legacy notice', async () => {
    const path = join(f.home, '.agents', 'skills', 'beta');
    const r = await planFlips(f.env, baseOpts({ targets: [path] }), storeRoot, emptyLedger(NOW));
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs).toHaveLength(1);
    expect(r.value.pairs[0]?.tool).toBe('codex');
    expect(r.value.pairs[0]?.notices).toEqual([]);
  });

  test('owning-tool inference: a codex-legacy-root path resolves to codex with the legacy notice', async () => {
    const path = join(f.home, '.codex', 'skills', 'gamma');
    const r = await planFlips(f.env, baseOpts({ targets: [path] }), storeRoot, emptyLedger(NOW));
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs).toHaveLength(1);
    expect(r.value.pairs[0]?.tool).toBe('codex');
    expect(r.value.pairs[0]?.notices).toContain(LEGACY_ROOT_NOTICE);
  });

  test('path outside every known skills root -> err(flip-refused)', async () => {
    const outside = join(f.checkout, 'plugins', 'fh', 'skills', 'alpha');
    const r = await planFlips(f.env, baseOpts({ targets: [outside] }), storeRoot, emptyLedger(NOW));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('flip-refused');
  });

  test('a skill dev in two tools resolves to both', async () => {
    await symlink(resolve(f.alphaSrc), join(f.home, '.agents', 'skills', 'alpha'));
    const r = await planFlips(f.env, baseOpts({ targets: ['alpha'] }), storeRoot, emptyLedger(NOW));
    if (!r.ok) throw new Error('expected ok');
    const tools = r.value.pairs.map((p) => p.tool).sort();
    expect(tools).toEqual(['claude-code', 'codex']);
  });

  test('explicit --tool absent for the target -> preResult refused + placement-not-found', async () => {
    const r = await planFlips(
      f.env,
      baseOpts({ targets: ['alpha'], tools: ['codex'] }),
      storeRoot,
      emptyLedger(NOW),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs).toEqual([]);
    expect(r.value.preResults).toHaveLength(1);
    expect(r.value.preResults[0]?.tool).toBe('codex');
    expect(r.value.preResults[0]?.action).toBe('refused');
    expect(r.value.preResults[0]?.error?.code).toBe('placement-not-found');
  });

  test('a name matching nothing anywhere -> preResult refused (tool: null), searched roots listed', async () => {
    const r = await planFlips(
      f.env,
      baseOpts({ targets: ['no-such-skill'] }),
      storeRoot,
      emptyLedger(NOW),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs).toEqual([]);
    expect(r.value.preResults).toHaveLength(1);
    expect(r.value.preResults[0]?.tool).toBeNull();
    expect(r.value.preResults[0]?.reason).toContain('.claude/skills');
  });

  test('--all promote: every dev placement (dangling included), pinned excluded', async () => {
    const r = await planFlips(f.env, baseOpts({ all: true }), storeRoot, emptyLedger(NOW));
    if (!r.ok) throw new Error('expected ok');
    const bySkillTool = r.value.pairs.map((p) => `${p.skill}@${p.tool}`).sort();
    expect(bySkillTool).toEqual(
      [
        'alpha@claude-code',
        'beta@codex',
        'dangler@claude-code',
        'gamma@codex',
        'legacy-only@codex',
      ].sort(),
    );
    // 'copied' is pinned (not dev) and must not appear.
    expect(bySkillTool.some((s) => s.startsWith('copied@'))).toBe(false);
    // 'dup' is pinned in BOTH codex roots (never dev-class in either) — irrelevant to
    // `promote --all` (only dev-class targets are planned), so it produces no preResult at
    // all here. Converse of the `dev --all` case below, where dup IS refused.
    expect(r.value.preResults.filter((res) => res.skill === 'dup')).toEqual([]);
  });

  test('--all dev: pinned-without-recorded-source is skipped, not an error', async () => {
    const r = await planFlips(
      f.env,
      baseOpts({ all: true, op: 'dev' }),
      storeRoot,
      emptyLedger(NOW),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs.some((p) => p.skill === 'copied')).toBe(false);
    const skipped = r.value.preResults.find((res) => res.skill === 'copied');
    expect(skipped?.action).toBe('skipped');
    expect(skipped?.reason).toBe('no recorded dev source');
  });

  test('--all dev: a pinned placement with a recorded dev source is included', async () => {
    const ledger: LedgerFile = emptyLedger(NOW);
    setPair(ledger, 'copied', 'claude-code', {
      placementPath: join(f.home, '.claude', 'skills', 'copied'),
      mode: 'pinned',
      dev: dev(resolve(f.alphaSrc)),
      pinned: null,
      journal: null,
    });
    const r = await planFlips(f.env, baseOpts({ all: true, op: 'dev' }), storeRoot, ledger);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs.some((p) => p.skill === 'copied' && p.tool === 'claude-code')).toBe(true);
  });

  test('codex duplicate (dup, pinned in both roots) via dev --all -> refused preResult naming both paths', async () => {
    const r = await planFlips(
      f.env,
      baseOpts({ all: true, op: 'dev' }),
      storeRoot,
      emptyLedger(NOW),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs.some((p) => p.skill === 'dup')).toBe(false);
    const dup = r.value.preResults.find((res) => res.skill === 'dup');
    expect(dup?.action).toBe('refused');
    expect(dup?.reason).toContain('.agents/skills');
    expect(dup?.reason).toContain('.codex/skills');
  });

  test('codex duplicate via a named target -> refused preResult with both paths in reason', async () => {
    const r = await planFlips(
      f.env,
      baseOpts({ targets: ['dup'], op: 'dev' }),
      storeRoot,
      emptyLedger(NOW),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs).toEqual([]);
    expect(r.value.preResults).toHaveLength(1);
    expect(r.value.preResults[0]?.action).toBe('refused');
    expect(r.value.preResults[0]?.reason).toContain('.agents/skills');
    expect(r.value.preResults[0]?.reason).toContain('.codex/skills');
  });

  test('legacy-only: found only in the legacy codex root -> pair carries the legacy notice', async () => {
    const r = await planFlips(
      f.env,
      baseOpts({ targets: ['legacy-only'] }),
      storeRoot,
      emptyLedger(NOW),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs).toHaveLength(1);
    expect(r.value.pairs[0]?.tool).toBe('codex');
    expect(r.value.pairs[0]?.notices).toContain(LEGACY_ROOT_NOTICE);
  });

  test('a store-linked placement is never flippable', async () => {
    const target = join(storeRoot, 'ns', 'name@rev', 'skill');
    await symlink(target, join(f.home, '.claude', 'skills', 'linked')).catch(() => {});
    const r = await planFlips(
      f.env,
      baseOpts({ targets: ['linked'], tools: ['claude-code'] }),
      storeRoot,
      emptyLedger(NOW),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.pairs).toEqual([]);
    expect(r.value.preResults[0]?.action).toBe('refused');
    expect(r.value.preResults[0]?.reason).toContain('store-linked');
  });

  // F1 regression: a crash between the P3 (live -> backup) and P4 (staging -> live) renames leaves
  // the live path ABSENT while an uncommitted journal is recorded (the backup holds the old
  // artifact). classifyPlacement then returns 'absent', which pre-fix dropped the pair from every
  // route (named -> exit 4 "no placement found"; --all -> never listed), stranding the journaled
  // pair beyond the reach of --rollback / re-run / resume. The pair must surface into the plan
  // regardless of filesystem class so the run layer's resume/rollback/refuse logic engages.
  describe('an uncommitted-journal pair is never dropped from planning (F1)', () => {
    const openJournalPair = (
      skillsRoot: string,
      skill: string,
      op: 'promote' | 'dev',
    ): PairRecord => ({
      placementPath: join(skillsRoot, skill),
      mode: op === 'promote' ? 'dev' : 'pinned',
      dev: dev(resolve(f.alphaSrc)),
      pinned: null,
      journal: {
        op,
        txId: 'beef0001',
        phase: 'live', // P4 not yet done => live absent
        startedAt: NOW,
        completedAt: null,
        before:
          op === 'promote'
            ? { mode: 'dev', symlinkTarget: resolve(f.alphaSrc) }
            : { mode: 'pinned', storePath: null, contentHash: null },
        stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-beef0001`),
        backupPath: join(skillsRoot, `.skillsmith-backup-${skill}-beef0001`),
      },
    });

    // Remove alpha's live symlink to reproduce the absent-live crash window, then record an
    // uncommitted journal for (alpha, claude-code).
    const absentLiveWithJournal = async (op: 'promote' | 'dev'): Promise<LedgerFile> => {
      const skillsRoot = join(f.home, '.claude', 'skills');
      await rm(join(skillsRoot, 'alpha'), { force: true });
      const ledger = emptyLedger(NOW);
      setPair(ledger, 'alpha', 'claude-code', openJournalPair(skillsRoot, 'alpha', op));
      return ledger;
    };

    for (const op of ['promote', 'dev'] as const) {
      test(`named target (${op}) surfaces the journaled pair despite an absent live path`, async () => {
        const ledger = await absentLiveWithJournal(op);
        const r = await planFlips(f.env, baseOpts({ targets: ['alpha'], op }), storeRoot, ledger);
        if (!r.ok) throw new Error('expected ok');
        const pair = r.value.pairs.find((p) => p.skill === 'alpha' && p.tool === 'claude-code');
        expect(pair).toBeDefined();
        expect(pair?.placement.class).toBe('absent');
        // The pre-fix failure mode: a placement-not-found preResult instead of a planned pair.
        expect(r.value.preResults.some((res) => res.error?.code === 'placement-not-found')).toBe(
          false,
        );
      });

      test(`--all (${op}) surfaces the journaled pair despite an absent live path`, async () => {
        const ledger = await absentLiveWithJournal(op);
        const r = await planFlips(f.env, baseOpts({ all: true, op }), storeRoot, ledger);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.pairs.some((p) => p.skill === 'alpha' && p.tool === 'claude-code')).toBe(
          true,
        );
      });
    }

    test('a committed-journal pair keeps current behavior (absent => dropped, not surfaced)', async () => {
      const skillsRoot = join(f.home, '.claude', 'skills');
      await rm(join(skillsRoot, 'alpha'), { force: true });
      const ledger = emptyLedger(NOW);
      const rec = openJournalPair(skillsRoot, 'alpha', 'promote');
      if (rec.journal) rec.journal.phase = 'committed';
      setPair(ledger, 'alpha', 'claude-code', rec);
      const r = await planFlips(f.env, baseOpts({ targets: ['alpha'] }), storeRoot, ledger);
      if (!r.ok) throw new Error('expected ok');
      expect(r.value.pairs.some((p) => p.skill === 'alpha')).toBe(false);
      expect(r.value.preResults.some((res) => res.error?.code === 'placement-not-found')).toBe(
        true,
      );
    });
  });

  // P15 / issue #11: `--rollback --all` must be direction-agnostic (spec D10). The bug reused the
  // forward verb's placement-class filter (plan.ts): `promote --rollback --all` selected dev-class
  // placements, `dev --rollback --all` selected pinned-class placements — OPPOSITE, non-overlapping
  // sets. Rollback selection must instead key off each pair's OWN rollbackable state so both verbs
  // select the identical set: exactly the pairs whose last committed flip can be inverted.
  describe('--rollback --all is direction-agnostic (P15, issue #11)', () => {
    const pinnedRec = (): PinnedRecord => ({
      storePath: join(storeRoot, 'local', 'x@content-000000000000', 'x'),
      rev: 'content-000000000000',
      gitSha: null,
      dirty: false,
      contentHash: `sha256:${'0'.repeat(64)}`,
      snapshotAt: NOW,
      verify: 'passed',
    });

    // A mixed-state fleet: (a) a dev pair with a retained pin (last committed op = dev), (b) a
    // pinned pair with a retained dev record (last committed op = promote), and (c) a fresh
    // dev-only pair with no ledger record at all (gamma@codex on disk) — not rollbackable.
    const mixedLedger = (): LedgerFile => {
      const ledger = emptyLedger(NOW);
      setPair(ledger, 'alpha', 'claude-code', {
        placementPath: join(f.home, '.claude', 'skills', 'alpha'),
        mode: 'dev',
        dev: dev(resolve(f.alphaSrc)),
        pinned: pinnedRec(),
        journal: null,
      });
      setPair(ledger, 'copied', 'claude-code', {
        placementPath: join(f.home, '.claude', 'skills', 'copied'),
        mode: 'pinned',
        dev: dev(resolve(f.alphaSrc)),
        pinned: pinnedRec(),
        journal: null,
      });
      return ledger;
    };

    const selectAll = async (op: 'promote' | 'dev'): Promise<string[]> => {
      const r = await planFlips(
        f.env,
        baseOpts({ all: true, op, rollback: true }),
        storeRoot,
        mixedLedger(),
      );
      if (!r.ok) throw new Error('expected ok');
      return r.value.pairs.map((p) => `${p.skill}@${p.tool}`).sort();
    };

    test('both verbs select the identical rollbackable set', async () => {
      const asPromote = await selectAll('promote');
      const asDev = await selectAll('dev');
      expect(asPromote).toEqual(asDev);
      expect(asPromote).toEqual(['alpha@claude-code', 'copied@claude-code']);
    });

    test('a fresh dev-only pair with no ledger record is untouched by either verb', async () => {
      expect(await selectAll('promote')).not.toContain('gamma@codex');
      expect(await selectAll('dev')).not.toContain('gamma@codex');
    });

    test('named-target rollback selection is unchanged (already direction-agnostic)', async () => {
      const named = async (op: 'promote' | 'dev', target: string): Promise<string[]> => {
        const r = await planFlips(
          f.env,
          baseOpts({ targets: [target], op, rollback: true }),
          storeRoot,
          mixedLedger(),
        );
        if (!r.ok) throw new Error('expected ok');
        return r.value.pairs.map((p) => `${p.skill}@${p.tool}`).sort();
      };
      expect(await named('promote', 'copied')).toEqual(await named('dev', 'copied'));
      expect(await named('promote', 'copied')).toEqual(['copied@claude-code']);
      expect(await named('promote', 'alpha')).toEqual(await named('dev', 'alpha'));
      expect(await named('promote', 'alpha')).toEqual(['alpha@claude-code']);
    });
  });
});
