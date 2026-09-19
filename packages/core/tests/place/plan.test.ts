import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createToolRegistry, toolRegistry } from '../../src/agents/registry.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../../src/artifacts/ledger-types.ts';
import { validateJournalV1DtoShape } from '../../src/artifacts/registry.ts';
import { emptyLedger, setPair } from '../../src/place/ledger.ts';
import { storeRootOf } from '../../src/place/paths.ts';
import {
  LEGACY_ROOT_NOTICE,
  createPlacementPlan,
  planFlips,
  planFlipsWithRegistry,
} from '../../src/place/plan.ts';
import type {
  DevRecord,
  FlipOptions,
  LedgerFile,
  PairRecord,
  PinnedRecord,
} from '../../src/place/types.ts';
import {
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
} from '../../src/planning/create.ts';
import {
  type ExpectedRevisionV1,
  type LivePlacementStateV1,
  type ObservedStateSnapshotV1,
  type StoreStateV1,
  createContentObservationIdentityV1,
  createExpectedRevisionV1,
  createStoreSnapshotIdentityV1,
} from '../../src/state/types.ts';
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
    configuration: f.configuration,
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

  test('default tool routing uses the active lifecycle operation instead of install support', async () => {
    const claude = toolRegistry.get('claude-code');
    if (claude === undefined) throw new Error('claude-code fixture adapter is missing');
    const registry = createToolRegistry([
      {
        ...claude,
        descriptor: {
          ...claude.descriptor,
          operations: {
            ...claude.descriptor.operations,
            install: {
              supported: false,
              scopes: [],
              remediation: 'fixture intentionally supports dev without install',
            },
          },
        },
      },
    ]);

    expect(registry.toolsFor('install')).toEqual([]);
    expect(registry.toolsFor('dev')).toEqual(['claude-code']);

    const result = await planFlipsWithRegistry(
      registry,
      f.env,
      baseOpts({ targets: ['alpha'], op: 'dev' }),
      storeRoot,
      emptyLedger(NOW),
    );

    if (!result.ok) throw result.error;
    expect(result.value.pairs.map((pair) => pair.tool)).toEqual(['claude-code']);
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

  test('a codex duplicate reached by current-root path is refused with the adapter reason', async () => {
    const path = join(f.home, '.agents', 'skills', 'dup');
    const r = await planFlips(
      f.env,
      baseOpts({ targets: [path], op: 'dev' }),
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

  test('dev --source to an absent current path refuses an existing alternate placement', async () => {
    const path = join(f.home, '.agents', 'skills', 'legacy-only');
    const r = await planFlips(
      f.env,
      baseOpts({ targets: [path], op: 'dev', source: resolve(f.alphaSrc) }),
      storeRoot,
      emptyLedger(NOW),
    );
    if (!r.ok) throw new Error('expected ok');

    expect(r.value.pairs).toEqual([]);
    expect(r.value.preResults).toHaveLength(1);
    expect(r.value.preResults[0]?.action).toBe('refused');
    expect(r.value.preResults[0]?.placementPath).toBe(
      join(f.home, '.codex', 'skills', 'legacy-only'),
    );
    expect(r.value.preResults[0]?.reason).toContain(LEGACY_ROOT_NOTICE);
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

const PLANNER_HEX = {
  a: 'a'.repeat(64),
  b: 'b'.repeat(64),
  c: 'c'.repeat(64),
  d: 'd'.repeat(64),
} as const;

const plannerCanonicalRevision = (input: unknown): ExpectedRevisionV1 => {
  const result = createExpectedRevisionV1(input);
  if (!result.ok) throw new Error('invalid placement planner revision fixture');
  return result.value;
};

const plannerRevision = (
  domain: 'manifest' | 'lock' | 'ledger' | 'live' | 'store' | 'project' | 'capabilities',
  resourceId: string,
  hex: string,
) =>
  domain === 'project' || domain === 'capabilities'
    ? plannerCanonicalRevision({
        schemaVersion: 1,
        domain,
        resourceId,
        state: 'present',
        targetKind: 'semantic',
        semanticRevision: `sha256:${hex}`,
      })
    : plannerCanonicalRevision({
        schemaVersion: 1,
        domain,
        resourceId,
        state: 'absent',
        targetIdentity: domain === 'live' ? '/fixture/live/alpha' : `/fixture/${domain}`,
        targetKind: 'absent',
        parentIdentity: '/fixture',
        parentKind: 'directory',
        parentMetadataIdentity: `metadata:v1:${hex}`,
      });

const plannerPresentStoreRevision = (resourceId: string, value: StoreStateV1, hex: string) =>
  plannerCanonicalRevision({
    schemaVersion: 1 as const,
    domain: 'store' as const,
    resourceId,
    state: 'present' as const,
    targetIdentity: value.path,
    targetKind: 'directory' as const,
    targetMetadataIdentity: `metadata:v1:${hex}`,
    parentIdentity: '/fixture/store',
    parentKind: 'directory' as const,
    parentMetadataIdentity: `metadata:v1:${hex}`,
    resourceRevision: value.repositoryRevision,
    contentRevision: value.contentRevision,
    snapshotIdentity: value.snapshotIdentity,
  });

const plannerPresentLiveRevision = (resourceId: string, value: LivePlacementStateV1, hex: string) =>
  plannerCanonicalRevision({
    schemaVersion: 1 as const,
    domain: 'live' as const,
    resourceId,
    state: 'present' as const,
    targetIdentity: value.path,
    targetKind:
      value.representation === 'directory' ? ('directory' as const) : value.representation,
    targetMetadataIdentity: `metadata:v1:${hex}`,
    parentIdentity: '/fixture/live',
    parentKind: 'directory' as const,
    parentMetadataIdentity: `metadata:v1:${hex}`,
    resourceRevision: `sha256:${PLANNER_HEX.c}`,
    contentRevision: value.contentRevision,
  });

const plannerPresentLedgerRevision = (hex: string) =>
  plannerCanonicalRevision({
    schemaVersion: 1 as const,
    domain: 'ledger' as const,
    resourceId: 'ledger:user',
    state: 'present' as const,
    targetIdentity: '/fixture/ledger.json',
    targetKind: 'file' as const,
    targetMetadataIdentity: `metadata:v1:${hex}`,
    parentIdentity: '/fixture',
    parentKind: 'directory' as const,
    parentMetadataIdentity: `metadata:v1:${hex}`,
    byteRevision: `sha256:${hex}`,
    semanticRevision: `sha256:${hex}`,
  });

const plannerAbsentRevision = (
  domain: 'live' | 'store',
  resourceId: string,
  targetIdentity: string,
  hex: string,
) =>
  plannerCanonicalRevision({
    schemaVersion: 1 as const,
    domain,
    resourceId,
    state: 'absent' as const,
    targetIdentity,
    targetKind: 'absent' as const,
    parentIdentity: dirname(targetIdentity),
    parentKind: 'directory' as const,
    parentMetadataIdentity: `metadata:v1:${hex}`,
  });

const plannerLedgerWithAlphaPair = (pair: LedgerPairV1Dto): LedgerModel => ({
  updatedAt: '2026-07-16T00:00:00.000Z',
  skills: { alpha: { tools: { codex: pair } } },
  projects: {},
  projectRegistrations: {},
  transactions: {},
  history: [],
});

const plannerStore = (
  resourceId: string,
  name: string,
  contentRevision = `sha256:${PLANNER_HEX.a}`,
) => {
  const value: StoreStateV1 = {
    path: `/fixture/store/${name}`,
    repositoryRevision: `sha256:${PLANNER_HEX.d}`,
    contentRevision,
    snapshotIdentity: createStoreSnapshotIdentityV1(resourceId, contentRevision),
  };
  return {
    revision: plannerPresentStoreRevision(resourceId, value, PLANNER_HEX.a),
    value,
  };
};

const plannerSourceContent = (
  path = '/fixture/source/alpha',
  contentRevision = `sha256:${PLANNER_HEX.a}` as `sha256:${string}`,
) =>
  createContentObservationIdentityV1({
    schemaVersion: 1,
    resourceId: `source:${path}`,
    targetIdentity: path,
    targetKind: 'directory',
    contentRevision,
  });

interface PlannerSnapshotOverrides {
  readonly live?: ObservedStateSnapshotV1['live'];
  readonly store?: ObservedStateSnapshotV1['store'];
  readonly ledger?: ObservedStateSnapshotV1['ledger'];
}

const plannerSnapshot = (
  snapshotHex = PLANNER_HEX.a,
  capabilityHex = PLANNER_HEX.b,
  overrides: PlannerSnapshotOverrides = {},
): ObservedStateSnapshotV1 =>
  ({
    schemaVersion: 1,
    snapshotId: `snapshot:v1:${snapshotHex}`,
    project: {
      revision: plannerRevision('project', 'project:/fixture', PLANNER_HEX.a),
      value: {},
    },
    manifest: {
      revision: plannerRevision('manifest', 'manifest:/fixture', PLANNER_HEX.a),
      value: null,
    },
    lock: {
      revision: plannerRevision('lock', 'lock:/fixture', PLANNER_HEX.b),
      value: null,
    },
    ledger: overrides.ledger ?? {
      revision: plannerRevision('ledger', 'ledger:user', PLANNER_HEX.c),
      value: null,
    },
    live: overrides.live ?? [
      {
        revision: plannerRevision('live', 'live-resource-alpha', PLANNER_HEX.d),
        value: null,
      },
    ],
    store: overrides.store ?? [plannerStore('store-resource-alpha', 'alpha')],
    capabilities: {
      revision: plannerRevision('capabilities', 'capabilities:fixture', capabilityHex),
      value: {},
    },
  }) as unknown as ObservedStateSnapshotV1;

const placementRequest = () => ({
  schemaVersion: 1 as const,
  command: 'promote' as const,
  selection: {
    source: 'explicit-targets' as const,
    skills: ['alpha'],
    tools: ['codex'] as const,
    scopes: ['user'] as const,
  },
  batchPolicy: 'fail-fast' as const,
  intents: [
    {
      kind: 'promote' as const,
      skill: 'alpha',
      tool: 'codex' as const,
      scope: 'user' as const,
      projectRoot: null,
      liveResourceId: 'live-resource-alpha',
      storeResourceId: 'store-resource-alpha',
      source: {
        kind: 'local-dev' as const,
        path: '/fixture/source/alpha',
        contentHash: `sha256:${PLANNER_HEX.a}` as const,
      },
      representation: 'copy' as const,
      desiredContentHash: `sha256:${PLANNER_HEX.a}` as const,
      sourceContent: plannerSourceContent(),
    },
  ],
});

describe('createPlacementPlan', () => {
  test('uses the supplied registry ordering during canonical planning', () => {
    const reorderedRegistry = createToolRegistry(
      toolRegistry.adapters.map((adapter) => ({
        ...adapter,
        descriptor: {
          ...adapter.descriptor,
          order:
            adapter.descriptor.id === 'codex'
              ? 1
              : adapter.descriptor.id === 'claude-code'
                ? 2
                : adapter.descriptor.order + 10,
        },
      })),
    );
    const request = {
      schemaVersion: 1 as const,
      command: 'promote' as const,
      selection: {
        source: 'explicit-targets' as const,
        skills: [] as const,
        tools: ['claude-code', 'codex'] as const,
        scopes: ['user'] as const,
      },
      batchPolicy: 'fail-fast' as const,
      intents: [],
    };

    const result = createPlacementPlan(request, plannerSnapshot(), {
      registry: reorderedRegistry,
      toolOrder: reorderedRegistry.ids,
    });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.selection.tools).toEqual(['codex', 'claude-code']);
  });

  test('creates deterministic immutable plans from request and observed snapshot only', () => {
    const request = placementRequest();
    const observed = plannerSnapshot();
    const requestBefore = structuredClone(request);
    const observedBefore = structuredClone(observed);
    const first = createPlacementPlan(request, observed);
    const second = createPlacementPlan(request, observed);

    expect(first).toEqual(second);
    expect(request).toEqual(requestBefore);
    expect(observed).toEqual(observedBefore);
    expect(first.ok).toBeTrue();
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.snapshotId).toBe(observed.snapshotId);
    expect(first.value.plan.operations).toHaveLength(1);
    expect(first.value.plan.operations[0]?.operationId).toMatch(/^operation:v1:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(first.value)).toBeTrue();
    expect(Object.isFrozen(first.value.plan)).toBeTrue();
    expect(Object.isFrozen(first.value.expectedRevisions)).toBeTrue();
  });

  test('does not fold snapshot identity or unrelated capability revisions into operation IDs', () => {
    const first = createPlacementPlan(
      placementRequest(),
      plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b),
    );
    const second = createPlacementPlan(
      placementRequest(),
      plannerSnapshot(PLANNER_HEX.c, PLANNER_HEX.d),
    );
    expect(first.ok).toBeTrue();
    expect(second.ok).toBeTrue();
    if (!first.ok || !second.ok) throw new Error('expected placement plans');
    expect(first.value.plan.operations.map((operation) => operation.operationId)).toEqual(
      second.value.plan.operations.map((operation) => operation.operationId),
    );
    expect(first.value.snapshotId).not.toBe(second.value.snapshotId);
  });

  test('does fold the desired store content revision into semantic operation identity', () => {
    const first = createPlacementPlan(placementRequest(), plannerSnapshot());
    const changed = placementRequest();
    const second = createPlacementPlan(
      {
        ...changed,
        intents: changed.intents.map((intent) => ({
          ...intent,
          source: {
            ...intent.source,
            contentHash: `sha256:${PLANNER_HEX.d}` as const,
          },
          desiredContentHash: `sha256:${PLANNER_HEX.d}` as const,
          sourceContent: plannerSourceContent(intent.source.path, `sha256:${PLANNER_HEX.d}`),
        })),
      },
      plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
        store: [plannerStore('store-resource-alpha', 'alpha', `sha256:${PLANNER_HEX.d}`)],
      }),
    );
    expect(first.ok).toBeTrue();
    expect(second.ok).toBeTrue();
    if (!first.ok || !second.ok) throw new Error('expected placement plans');
    expect(first.value.plan.operations[0]?.operationId).not.toBe(
      second.value.plan.operations[0]?.operationId,
    );
  });

  test('selects each live and store observation by explicit resource ID in multi-resource plans', () => {
    const alpha = placementRequest().intents[0];
    if (alpha === undefined) throw new Error('missing alpha intent');
    const beta = {
      ...structuredClone(alpha),
      skill: 'beta',
      liveResourceId: 'live-resource-beta-nonconventional',
      storeResourceId: 'store-resource-beta-nonconventional',
      source: { ...alpha.source, path: '/fixture/source/beta' },
      sourceContent: plannerSourceContent('/fixture/source/beta'),
      representation: 'symlink' as const,
    };
    const input = {
      ...placementRequest(),
      selection: { ...placementRequest().selection, skills: ['alpha', 'beta'] },
      intents: [alpha, beta],
    };
    expect(alpha.sourceContent.contentRevision).toBe(beta.sourceContent.contentRevision);
    expect(alpha.sourceContent.resourceId).not.toBe(beta.sourceContent.resourceId);
    expect(alpha.sourceContent.targetIdentity).toBe('/fixture/source/alpha');
    expect(beta.sourceContent.targetIdentity).toBe('/fixture/source/beta');
    const observed = plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
      live: [
        {
          revision: plannerRevision('live', 'live-resource-beta-nonconventional', PLANNER_HEX.c),
          value: null,
        },
        {
          revision: plannerRevision('live', 'live-resource-alpha', PLANNER_HEX.d),
          value: null,
        },
      ] as ObservedStateSnapshotV1['live'],
      store: [
        plannerStore('store-resource-beta-nonconventional', 'beta'),
        plannerStore('store-resource-alpha', 'alpha'),
      ],
    });
    const result = createPlacementPlan(input, observed);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    const bySkill = new Map(
      result.value.plan.operations.map((operation) => [operation.skill, operation]),
    );
    expect(bySkill.get('alpha')?.before).toMatchObject({
      kind: 'absent',
      resource: {
        location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
      },
    });
    expect(bySkill.get('beta')?.after).toMatchObject({
      kind: 'placement',
      representation: 'symlink',
      linkTarget: { kind: 'machine-bound', path: '/fixture/store/beta' },
    });
  });

  test('derives update kind and an exact present-live before image without fabricated source facts', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'symlink',
      path: '/fixture/live/alpha',
      realpath: '/fixture/store/old-alpha',
      linkTarget: '../store/old-alpha',
      dangling: true,
      placementClass: 'store-linked',
      skillFile: 'invalid',
      brokenReason: 'dangling-link',
      contentRevision: null,
    };
    const ledger: LedgerModel = {
      updatedAt: '2026-07-16T00:00:00.000Z',
      skills: {
        alpha: {
          tools: {
            codex: {
              placementPath: live.path,
              mode: 'pinned',
              dev: null,
              pinned: {
                storePath: '/fixture/store/old-alpha',
                rev: 'c'.repeat(40),
                gitSha: 'c'.repeat(40),
                dirty: false,
                contentHash: `sha256:${PLANNER_HEX.c}`,
                snapshotAt: '2026-07-16T00:00:00.000Z',
                verify: 'passed',
                placement: 'symlink',
              },
              origin: {
                source: 'example.test/fixture/repo//skills/alpha',
                host: 'example.test',
                repo: 'fixture/repo',
                skillPath: 'skills/alpha',
                refRequested: null,
                refResolved: 'c'.repeat(40),
                pin: true,
                installedAt: '2026-07-16T00:00:00.000Z',
              },
              journal: null,
            },
          },
        },
      },
      projects: {},
      projectRegistrations: {},
      transactions: {},
      history: [],
    };
    const observed = plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
      live: [
        {
          revision: plannerPresentLiveRevision('live-resource-alpha', live, PLANNER_HEX.d),
          value: live,
        },
      ],
      ledger: {
        revision: plannerPresentLedgerRevision(PLANNER_HEX.c),
        value: ledger,
      },
    });
    const result = createPlacementPlan(placementRequest(), observed);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations[0]).toMatchObject({
      kind: 'update',
      source: {
        kind: 'local-dev',
        path: '/fixture/source/alpha',
        contentHash: `sha256:${PLANNER_HEX.a}`,
      },
      before: {
        kind: 'placement',
        classification: 'store-linked',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: '/fixture/store/old-alpha' },
        dangling: true,
        source: {
          kind: 'portable',
          identity: {
            host: 'example.test',
            repository: 'fixture/repo',
            path: 'skills/alpha',
          },
          contentHash: `sha256:${PLANNER_HEX.c}`,
        },
        contentHash: `sha256:${PLANNER_HEX.c}`,
      },
      reason: { code: 'update-selected' },
    });
  });

  test('fails closed for missing observations, mismatched store facts, or fabricated source content', () => {
    const missing = placementRequest();
    const missingIntent = missing.intents[0];
    if (missingIntent === undefined) throw new Error('missing placement intent');
    missing.intents[0] = {
      ...missingIntent,
      liveResourceId: 'live-resource-missing',
    };
    expect(createPlacementPlan(missing, plannerSnapshot())).toMatchObject({
      ok: false,
      error: { message: 'placement planning: live resource observation is missing or ambiguous' },
    });

    const mismatchedStore = placementRequest();
    const wrongStore = plannerStore('store-resource-alpha', 'alpha', `sha256:${PLANNER_HEX.d}`);
    expect(
      createPlacementPlan(
        mismatchedStore,
        plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, { store: [wrongStore] }),
      ),
    ).toMatchObject({
      ok: false,
      error: { message: 'placement planning: store resource does not match placement intent' },
    });

    const mismatchedSource = placementRequest();
    const mismatchedSourceIntent = mismatchedSource.intents[0];
    if (mismatchedSourceIntent === undefined) throw new Error('missing placement intent');
    mismatchedSource.intents[0] = {
      ...mismatchedSourceIntent,
      source: {
        ...mismatchedSourceIntent.source,
        contentHash: `sha256:${PLANNER_HEX.d}`,
      },
    };
    expect(createPlacementPlan(mismatchedSource, plannerSnapshot())).toMatchObject({
      ok: false,
      error: { message: 'placement planning: source content observation differs from intent' },
    });
  });

  test('plans deterministic forward dev from exact absent-live state without effects', () => {
    const input = {
      schemaVersion: 1 as const,
      command: 'dev' as const,
      mode: 'forward' as const,
      selection: {
        source: 'explicit-targets' as const,
        skills: ['alpha'],
        tools: ['codex'] as const,
        scopes: ['user'] as const,
      },
      batchPolicy: 'fail-fast' as const,
      intents: [
        {
          kind: 'link-dev' as const,
          skill: 'alpha',
          tool: 'codex' as const,
          scope: 'user' as const,
          projectRoot: null,
          liveResourceId: 'live-resource-alpha',
          source: {
            kind: 'local-dev' as const,
            path: '/fixture/source/alpha',
            contentHash: `sha256:${PLANNER_HEX.a}` as const,
          },
          sourceContent: plannerSourceContent(),
        },
      ],
    };
    const observed = plannerSnapshot();
    const inputBefore = structuredClone(input);
    const observedBefore = structuredClone(observed);

    const first = createPlacementPlan(input, observed);
    const second = createPlacementPlan(input, observed);

    expect(first).toEqual(second);
    expect(first.ok).toBeTrue();
    if (!first.ok) throw new Error(first.error.message);
    expect(input).toEqual(inputBefore);
    expect(observed).toEqual(observedBefore);
    expect(first.value.plan.command).toBe('dev');
    expect(first.value.plan.operations[0]).toMatchObject({
      kind: 'link-dev',
      before: {
        kind: 'absent',
        resource: {
          location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
        },
      },
      after: {
        kind: 'placement',
        classification: 'dev',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: '/fixture/source/alpha' },
        source: {
          kind: 'local-dev',
          path: '/fixture/source/alpha',
          contentHash: `sha256:${PLANNER_HEX.a}`,
        },
        contentHash: `sha256:${PLANNER_HEX.a}`,
      },
      reason: { code: 'link-dev-selected' },
    });
    expect(first.value.plan.operations[0]?.preconditionIds).toHaveLength(
      first.value.expectedRevisions.length + 1,
    );
    expect(first.value.plan.checks).toEqual([]);
  });

  test('omits forward dev when the exact managed source is already linked', () => {
    const source = {
      kind: 'local-dev' as const,
      path: '/fixture/source/alpha',
      contentHash: `sha256:${PLANNER_HEX.a}` as const,
    };
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'symlink',
      path: '/fixture/live/alpha',
      realpath: source.path,
      linkTarget: source.path,
      dangling: false,
      placementClass: 'dev',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: source.contentHash,
    };
    const pair: LedgerPairV1Dto = {
      placementPath: live.path,
      mode: 'dev',
      dev: {
        sourcePath: source.path,
        resolvedPath: source.path,
        repoRoot: '/fixture',
        sourceRelPath: 'source/alpha',
        remote: null,
        recordedAt: '2026-07-16T00:00:00.000Z',
      },
      pinned: null,
      journal: null,
    };
    const observed = plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
      live: [
        {
          revision: plannerPresentLiveRevision('live-resource-alpha', live, PLANNER_HEX.d),
          value: live,
        },
      ],
      ledger: {
        revision: plannerPresentLedgerRevision(PLANNER_HEX.c),
        value: plannerLedgerWithAlphaPair(pair),
      },
    });
    const input = {
      schemaVersion: 1 as const,
      command: 'dev' as const,
      selection: placementRequest().selection,
      batchPolicy: 'fail-fast' as const,
      intents: [
        {
          kind: 'link-dev' as const,
          skill: 'alpha',
          tool: 'codex' as const,
          scope: 'user' as const,
          projectRoot: null,
          liveResourceId: 'live-resource-alpha',
          source,
          sourceContent: plannerSourceContent(),
        },
      ],
    };

    const result = createPlacementPlan(input, observed);

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toEqual([]);
    expect(result.value.expectedRevisions).toHaveLength(7);
  });

  test('plans promote against an exact absent-store expectation', () => {
    const base = placementRequest();
    const intent = base.intents[0];
    if (intent === undefined) throw new Error('missing promote intent');
    const input = {
      ...base,
      intents: [{ ...intent, representation: 'symlink' as const }],
    };
    const observed = plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
      store: [
        {
          revision: plannerAbsentRevision(
            'store',
            'store-resource-alpha',
            '/fixture/store/alpha',
            PLANNER_HEX.a,
          ),
          value: null,
        },
      ],
    });

    const result = createPlacementPlan(input, observed);

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations[0]).toMatchObject({
      kind: 'promote',
      after: {
        kind: 'placement',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: '/fixture/store/alpha' },
        contentHash: `sha256:${PLANNER_HEX.a}`,
      },
    });
  });

  test('plans rollback to retained dev with exact observed source content and a bound precondition', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'directory',
      path: '/fixture/live/alpha',
      realpath: '/fixture/live/alpha',
      linkTarget: null,
      dangling: false,
      placementClass: 'pinned',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: `sha256:${PLANNER_HEX.c}`,
    };
    const pair: LedgerPairV1Dto = {
      placementPath: live.path,
      mode: 'pinned',
      dev: {
        sourcePath: '/fixture/source/alpha',
        resolvedPath: '/fixture/source/alpha',
        repoRoot: '/fixture',
        sourceRelPath: 'source/alpha',
        remote: null,
        recordedAt: '2026-07-16T00:00:00.000Z',
      },
      pinned: {
        storePath: '/fixture/store/current-alpha',
        rev: 'c'.repeat(40),
        gitSha: 'c'.repeat(40),
        dirty: false,
        contentHash: `sha256:${PLANNER_HEX.c}`,
        snapshotAt: '2026-07-16T00:00:00.000Z',
        verify: 'passed',
        placement: 'copy',
      },
      origin: {
        source: 'example.test/fixture/repo//skills/alpha',
        host: 'example.test',
        repo: 'fixture/repo',
        skillPath: 'skills/alpha',
        refRequested: null,
        refResolved: 'c'.repeat(40),
        pin: true,
        installedAt: '2026-07-16T00:00:00.000Z',
      },
      journal: {
        op: 'promote',
        txId: 'tx-rollback-dev',
        phase: 'committed',
        startedAt: '2026-07-16T00:00:00.000Z',
        completedAt: '2026-07-16T00:00:01.000Z',
        before: { mode: 'dev', symlinkTarget: '/fixture/source/alpha', liveKind: 'symlink' },
        stagingPath: '/fixture/staging/alpha',
        backupPath: '/fixture/backup/alpha',
      },
    };
    const observed = plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
      live: [
        {
          revision: plannerPresentLiveRevision('live-resource-alpha', live, PLANNER_HEX.d),
          value: live,
        },
      ],
      ledger: {
        revision: plannerPresentLedgerRevision(PLANNER_HEX.c),
        value: plannerLedgerWithAlphaPair(pair),
      },
    });
    const input = {
      schemaVersion: 1 as const,
      command: 'promote' as const,
      mode: 'rollback' as const,
      selection: placementRequest().selection,
      batchPolicy: 'fail-fast' as const,
      intents: [
        {
          kind: 'rollback' as const,
          skill: 'alpha',
          tool: 'codex' as const,
          scope: 'user' as const,
          projectRoot: null,
          liveResourceId: 'live-resource-alpha',
          storeResourceId: null,
          sourceContent: plannerSourceContent(),
        },
      ],
    };
    const inputBefore = structuredClone(input);
    const observedBefore = structuredClone(observed);

    const result = createPlacementPlan(input, observed);
    const repeated = createPlacementPlan(input, observed);

    expect(result).toEqual(repeated);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(input).toEqual(inputBefore);
    expect(observed).toEqual(observedBefore);
    expect(result.value.plan.command).toBe('promote');
    expect(result.value.plan.operations[0]).toMatchObject({
      kind: 'link-dev',
      source: {
        kind: 'local-dev',
        path: '/fixture/source/alpha',
        contentHash: `sha256:${PLANNER_HEX.a}`,
      },
      before: {
        kind: 'placement',
        classification: 'pinned',
        representation: 'copy',
        contentHash: `sha256:${PLANNER_HEX.c}`,
      },
      after: {
        kind: 'placement',
        classification: 'dev',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: '/fixture/source/alpha' },
        source: {
          kind: 'local-dev',
          path: '/fixture/source/alpha',
          contentHash: `sha256:${PLANNER_HEX.a}`,
        },
        contentHash: `sha256:${PLANNER_HEX.a}`,
      },
      reason: { code: 'rollback-inverse' },
    });
    expect(result.value.plan.operations[0]?.preconditionIds).toHaveLength(
      result.value.expectedRevisions.length + 1,
    );

    const undo = createPlacementPlan({ ...input, command: 'undo' }, observed);
    expect(undo.ok).toBeTrue();
    if (!undo.ok) throw new Error(undo.error.message);
    expect(undo.value.plan.command).toBe('undo');
    expect(undo.value.plan.selection.source).toBe('explicit-targets');
  });

  test('plans committed uninstall reversal from retained history when pair and live are absent', () => {
    const journalNow = '2026-07-16T00:00:00.000Z';
    const path = '/fixture/live/alpha';
    const resource = {
      kind: 'live' as const,
      skill: 'alpha',
      tool: 'codex' as const,
      scope: 'user' as const,
      projectRoot: null,
      location: { kind: 'machine-bound' as const, path },
    };
    const source = {
      kind: 'portable' as const,
      identity: { host: 'example.test', repository: 'fixture/repo', path: 'skills/alpha' },
      requestedRef: null,
      resolvedSha: 'c'.repeat(40),
      sourcePath: 'skills/alpha',
      contentHash: `sha256:${PLANNER_HEX.c}` as const,
    };
    const installed = {
      kind: 'placement' as const,
      resource,
      classification: 'pinned' as const,
      representation: 'copy' as const,
      linkTarget: null,
      dangling: false,
      source,
      contentHash: source.contentHash,
    };
    const absent = { kind: 'absent' as const, resource };
    const groupId = createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'uninstall',
      skill: 'alpha',
      source,
      scope: 'user',
      target: null,
    });
    const pairId = createOperationPairId({
      domain: 'skillsmith.operation-pair-identity',
      schemaVersion: 1,
      groupId,
      tool: 'codex',
      resource,
    });
    const operationId = createOperationId({
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId,
      pairId,
      kind: 'remove',
      skill: 'alpha',
      source,
      tool: 'codex',
      scope: 'user',
    });
    const journalInput = {
      schemaVersion: 1,
      kind: 'skillsmith.transaction-journal',
      transactionId: 'tx:uninstall-alpha',
      intent: {
        operationId,
        groupId,
        pairId,
        kind: 'remove',
        skill: 'alpha',
        source,
        tool: 'codex',
        scope: 'user',
        before: installed,
        after: absent,
        mutates: { live: true, manifest: false, lock: false, ledger: true },
        reversibility: { kind: 'conditional', retentionResourceIds: [pairId] },
        conflict: null,
      },
      context: {
        parentOperationId: null,
        command: 'skillsmith-uninstall',
        workflow: 'uninstall',
        attempt: 1,
        startedAt: journalNow,
      },
      disposition: 'forward',
      phase: 'committed',
      actual: {
        before: [
          {
            resourceId: 'live:alpha',
            role: 'live',
            state: 'present',
            repositoryRevision: { kind: 'resource', digest: source.contentHash },
            placementPath: path,
            liveKind: 'directory',
            mode: 'pinned',
            symlinkTarget: null,
            contentHash: source.contentHash,
          },
          {
            resourceId: 'ledger:user',
            role: 'ledger',
            state: 'present',
            repositoryRevision: { kind: 'resource', digest: source.contentHash },
            schemaVersion: 2,
            semanticHash: source.contentHash,
          },
        ],
        after: [
          {
            resourceId: 'live:alpha',
            role: 'live',
            state: 'absent',
            repositoryRevision: null,
            placementPath: path,
            liveKind: null,
            mode: null,
            symlinkTarget: null,
            contentHash: null,
          },
          {
            resourceId: 'ledger:user',
            role: 'ledger',
            state: 'present',
            repositoryRevision: { kind: 'resource', digest: source.contentHash },
            schemaVersion: 2,
            semanticHash: source.contentHash,
          },
        ],
        retained: [],
      },
      updatedAt: journalNow,
      completedAt: journalNow,
    };
    const journalShape = validateJournalV1DtoShape(journalInput);
    expect(journalShape.ok, JSON.stringify(journalShape)).toBeTrue();
    if (!journalShape.ok) throw new Error(journalShape.error.message);
    const journal = journalShape.value;
    const observed = plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
      live: [
        {
          revision: plannerAbsentRevision('live', 'live-resource-alpha', path, PLANNER_HEX.d),
          value: null,
        },
      ],
      ledger: {
        revision: plannerPresentLedgerRevision(PLANNER_HEX.c),
        value: {
          updatedAt: journalNow,
          skills: {},
          projects: {},
          projectRegistrations: {},
          transactions: {},
          history: [journal],
        },
      },
    });
    const result = createPlacementPlan(
      {
        schemaVersion: 1,
        command: 'undo',
        mode: 'rollback',
        selection: placementRequest().selection,
        batchPolicy: 'fail-fast',
        intents: [
          {
            kind: 'rollback',
            skill: 'alpha',
            tool: 'codex',
            scope: 'user',
            projectRoot: null,
            liveResourceId: 'live-resource-alpha',
            storeResourceId: null,
          },
        ],
      },
      observed,
    );

    expect(result.ok, JSON.stringify(result)).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan).toMatchObject({
      command: 'undo',
      operations: [
        {
          kind: 'install',
          before: { kind: 'absent' },
          after: { kind: 'placement', classification: 'pinned' },
          reason: { code: 'rollback-inverse' },
        },
      ],
    });

    const inverseOperation = result.value.plan.operations[0];
    if (inverseOperation === undefined) throw new Error('missing committed reversal operation');
    const inverseOperationId = inverseOperation.operationId;
    const inverseTransactionId = 'tx:fresh-remove-reversal';
    for (const phase of ['prepared', 'staged', 'backed-up', 'live'] as const) {
      const child: LogicalJournalV1Dto = {
        ...journal,
        transactionId: inverseTransactionId,
        intent: {
          ...journal.intent,
          operationId: inverseOperationId,
          groupId: inverseOperation.groupId,
          pairId: inverseOperation.pairId,
        },
        context: {
          ...journal.context,
          parentOperationId: journal.intent.operationId,
          command: 'skillsmith-undo',
          workflow: 'undo',
        },
        disposition: 'rollback',
        phase,
        actual: {
          before: journal.actual.after,
          after: phase === 'live' ? journal.actual.before : [],
          retained: journal.actual.retained,
        },
        completedAt: null,
      };
      const inversePair: LedgerPairV1Dto = {
        placementPath: path,
        mode: 'pinned',
        dev: null,
        pinned: {
          storePath: '/fixture/store/alpha',
          rev: source.resolvedSha.slice(0, 12),
          gitSha: source.resolvedSha,
          dirty: false,
          contentHash: source.contentHash,
          snapshotAt: journalNow,
          verify: 'passed',
          placement: 'copy',
        },
        journal: {
          op: 'install',
          txId: inverseTransactionId,
          phase,
          startedAt: journalNow,
          completedAt: null,
          before: { mode: 'absent' },
          stagingPath: '/fixture/staging/fresh-alpha',
          backupPath: '/fixture/backup/fresh-alpha',
        },
      };
      const retry = createPlacementPlan(
        {
          schemaVersion: 1,
          command: 'undo',
          mode: 'rollback',
          selection: placementRequest().selection,
          batchPolicy: 'fail-fast',
          intents: [
            {
              kind: 'rollback',
              skill: 'alpha',
              tool: 'codex',
              scope: 'user',
              projectRoot: null,
              liveResourceId: 'live-resource-alpha',
              storeResourceId: null,
            },
          ],
        },
        {
          ...observed,
          ledger: {
            ...observed.ledger,
            value: {
              ...(observed.ledger.value as NonNullable<typeof observed.ledger.value>),
              skills: { alpha: { tools: { codex: inversePair } } },
              transactions: { [inverseTransactionId]: child },
            },
          },
        },
      );
      expect(retry.ok, `${phase}: ${JSON.stringify(retry)}`).toBeTrue();
      if (!retry.ok) throw new Error(retry.error.message);
      expect(retry.value.plan.operations[0]).toMatchObject({
        operationId: inverseOperationId,
        kind: 'install',
        before: { kind: 'absent' },
        after: { kind: 'placement', classification: 'pinned' },
      });
    }
  });

  test('plans rollback to retained pinned state with existing promote vocabulary', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'symlink',
      path: '/fixture/live/alpha',
      realpath: '/fixture/source/alpha',
      linkTarget: '/fixture/source/alpha',
      dangling: false,
      placementClass: 'dev',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: `sha256:${PLANNER_HEX.a}`,
    };
    const pair: LedgerPairV1Dto = {
      placementPath: live.path,
      mode: 'dev',
      dev: {
        sourcePath: '/fixture/source/alpha',
        resolvedPath: '/fixture/source/alpha',
        repoRoot: '/fixture',
        sourceRelPath: 'source/alpha',
        remote: null,
        recordedAt: '2026-07-16T00:00:00.000Z',
      },
      pinned: {
        storePath: '/fixture/store/alpha',
        rev: 'c'.repeat(40),
        gitSha: 'c'.repeat(40),
        dirty: false,
        contentHash: `sha256:${PLANNER_HEX.c}`,
        snapshotAt: '2026-07-16T00:00:00.000Z',
        verify: 'passed',
        placement: 'symlink',
      },
      origin: {
        source: 'example.test/fixture/repo//skills/alpha',
        host: 'example.test',
        repo: 'fixture/repo',
        skillPath: 'skills/alpha',
        refRequested: null,
        refResolved: 'c'.repeat(40),
        pin: true,
        installedAt: '2026-07-16T00:00:00.000Z',
      },
      journal: {
        op: 'dev',
        txId: 'tx-rollback-pinned',
        phase: 'committed',
        startedAt: '2026-07-16T00:00:00.000Z',
        completedAt: '2026-07-16T00:00:01.000Z',
        before: {
          mode: 'pinned',
          storePath: '/fixture/store/alpha',
          contentHash: `sha256:${PLANNER_HEX.c}`,
          liveKind: 'symlink',
          symlinkTarget: '../store/alpha',
        },
        stagingPath: '/fixture/staging/alpha',
        backupPath: '/fixture/backup/alpha',
      },
    };
    const observed = plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
      live: [
        {
          revision: plannerPresentLiveRevision('live-resource-alpha', live, PLANNER_HEX.d),
          value: live,
        },
      ],
      store: [plannerStore('store-resource-alpha', 'alpha', `sha256:${PLANNER_HEX.c}`)],
      ledger: {
        revision: plannerPresentLedgerRevision(PLANNER_HEX.c),
        value: plannerLedgerWithAlphaPair(pair),
      },
    });
    const input = {
      schemaVersion: 1 as const,
      command: 'dev' as const,
      mode: 'rollback' as const,
      selection: placementRequest().selection,
      batchPolicy: 'fail-fast' as const,
      intents: [
        {
          kind: 'rollback' as const,
          skill: 'alpha',
          tool: 'codex' as const,
          scope: 'user' as const,
          projectRoot: null,
          liveResourceId: 'live-resource-alpha',
          storeResourceId: 'store-resource-alpha',
        },
      ],
    };

    const result = createPlacementPlan(input, observed);

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.command).toBe('dev');
    expect(result.value.plan.operations[0]).toMatchObject({
      kind: 'promote',
      before: {
        kind: 'placement',
        classification: 'dev',
        representation: 'symlink',
        source: {
          kind: 'local-dev',
          path: '/fixture/source/alpha',
          contentHash: `sha256:${PLANNER_HEX.a}`,
        },
      },
      after: {
        kind: 'placement',
        classification: 'pinned',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: '/fixture/store/alpha' },
        source: {
          kind: 'portable',
          identity: {
            host: 'example.test',
            repository: 'fixture/repo',
            path: 'skills/alpha',
          },
          contentHash: `sha256:${PLANNER_HEX.c}`,
        },
        contentHash: `sha256:${PLANNER_HEX.c}`,
      },
      reason: { code: 'rollback-inverse' },
    });
  });

  test('plans interrupted fresh-install rollback as remove to exact absent state', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'directory',
      path: '/fixture/live/alpha',
      realpath: '/fixture/live/alpha',
      linkTarget: null,
      dangling: false,
      placementClass: 'pinned',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: `sha256:${PLANNER_HEX.c}`,
    };
    const pair: LedgerPairV1Dto = {
      placementPath: live.path,
      mode: 'pinned',
      dev: null,
      pinned: {
        storePath: '/fixture/store/alpha',
        rev: 'c'.repeat(40),
        gitSha: 'c'.repeat(40),
        dirty: false,
        contentHash: `sha256:${PLANNER_HEX.c}`,
        snapshotAt: '2026-07-16T00:00:00.000Z',
        verify: 'passed',
        placement: 'copy',
      },
      journal: {
        op: 'install',
        txId: 'tx-interrupted-install',
        phase: 'staged',
        startedAt: '2026-07-16T00:00:00.000Z',
        completedAt: null,
        before: { mode: 'absent' },
        stagingPath: '/fixture/staging/alpha',
        backupPath: '/fixture/backup/alpha',
      },
    };
    const observed = plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
      live: [
        {
          revision: plannerPresentLiveRevision('live-resource-alpha', live, PLANNER_HEX.d),
          value: live,
        },
      ],
      ledger: {
        revision: plannerPresentLedgerRevision(PLANNER_HEX.c),
        value: plannerLedgerWithAlphaPair(pair),
      },
    });

    const result = createPlacementPlan(
      {
        schemaVersion: 1,
        command: 'promote',
        mode: 'rollback',
        selection: placementRequest().selection,
        batchPolicy: 'fail-fast',
        intents: [
          {
            kind: 'rollback',
            skill: 'alpha',
            tool: 'codex',
            scope: 'user',
            projectRoot: null,
            liveResourceId: 'live-resource-alpha',
            storeResourceId: null,
          },
        ],
      },
      observed,
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toHaveLength(1);
    expect(result.value.plan.operations[0]).toMatchObject({
      kind: 'remove',
      before: {
        kind: 'placement',
        classification: 'pinned',
        contentHash: null,
      },
      after: {
        kind: 'absent',
        resource: {
          kind: 'live',
          skill: 'alpha',
          tool: 'codex',
        },
      },
      reason: { code: 'rollback-inverse' },
    });
  });

  test('fails closed for incoherent supplied components and rollback without retained inverse', () => {
    const live: LivePlacementStateV1 = {
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'directory',
      path: '/fixture/live/alpha',
      realpath: '/fixture/live/alpha',
      linkTarget: null,
      dangling: false,
      placementClass: 'pinned',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: `sha256:${PLANNER_HEX.a}`,
    };
    expect(
      createPlacementPlan(
        placementRequest(),
        plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
          live: [
            {
              revision: plannerAbsentRevision(
                'live',
                'live-resource-alpha',
                '/fixture/live/alpha',
                PLANNER_HEX.d,
              ),
              value: live,
            },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { message: 'placement planning: live resource observation is incoherent' },
    });

    expect(
      createPlacementPlan(
        placementRequest(),
        plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
          store: [
            {
              revision: plannerStore('store-resource-alpha', 'alpha').revision,
              value: null,
            },
          ],
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { message: 'placement planning: store resource observation is incoherent' },
    });

    expect(
      createPlacementPlan(
        placementRequest(),
        plannerSnapshot(PLANNER_HEX.a, PLANNER_HEX.b, {
          ledger: {
            revision: plannerPresentLedgerRevision(PLANNER_HEX.c),
            value: null,
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { message: 'placement planning: ledger observation is incoherent' },
    });

    const rollback = {
      schemaVersion: 1 as const,
      command: 'dev' as const,
      mode: 'rollback' as const,
      selection: placementRequest().selection,
      batchPolicy: 'fail-fast' as const,
      intents: [
        {
          kind: 'rollback' as const,
          skill: 'alpha',
          tool: 'codex' as const,
          scope: 'user' as const,
          projectRoot: null,
          liveResourceId: 'live-resource-alpha',
          storeResourceId: null,
        },
      ],
    };
    expect(createPlacementPlan(rollback, plannerSnapshot())).toMatchObject({
      ok: false,
      error: { message: 'placement planning: rollback intent has no retained inverse' },
    });
  });
});
