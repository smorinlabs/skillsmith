import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { emptyLedger, setPair } from '../../src/place/ledger.ts';
import { storeRootOf } from '../../src/place/paths.ts';
import { LEGACY_ROOT_NOTICE, planFlips } from '../../src/place/plan.ts';
import type { DevRecord, FlipOptions, LedgerFile } from '../../src/place/types.ts';
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
});
