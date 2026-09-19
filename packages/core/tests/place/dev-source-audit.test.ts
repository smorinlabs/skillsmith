import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { runUninstall } from '../../src/acquire/run.ts';
import type { UninstallDeps } from '../../src/acquire/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPair, readLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf, storeRootOf } from '../../src/place/paths.ts';
import { planFlips } from '../../src/place/plan.ts';
import { runDev, runPromote, runRollback } from '../../src/place/run.ts';
import type { LedgerFile } from '../../src/place/types.ts';
import { type DevSourceFlipOptions, actionV2, passFlipDeps } from '../fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

setDefaultTimeout(20_000);

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

let uninstallCounter = 0;
const uninstallDeps = (): UninstallDeps => {
  const start = uninstallCounter++;
  let n = 0;
  return {
    now: () => '2026-07-10T00:00:00Z',
    newTxId: () => (0x70000000 + start * 1000 + n++).toString(16).slice(-8),
  };
};

// PRD ledger-record shape / plan risk register: a dev-only record (dev record present, NO pinned,
// NO journal) is a new legal shape that every ledger reader must tolerate — pair selection in
// plan.ts, the rollback planner, and downstream consumers. (The CLI list/doctor surfaces do not
// read the placements ledger today, so the audit reduces to the readers below plus the shared
// readLedger schema gate, which dev-source.test.ts pins.) Each test first CREATES the dev-only
// record through the real `dev --source` path, then exercises one reader against it.
describe('dev --source — pin-assumption audit on the dev-only record', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  const opts = (o: Partial<DevSourceFlipOptions> = {}): DevSourceFlipOptions => ({
    targets: [],
    cwd: f.home,
    configuration: f.configuration,
    ...o,
  });

  const claudeRoot = (): string => join(f.home, '.claude', 'skills');

  const readLedgerOf = async (): Promise<LedgerFile> => {
    const r = await readLedger(f.env, ledgerPathOf(f.data));
    if (!r.ok) throw new Error(msg(r.error));
    return r.value;
  };

  const createBeta = async (): Promise<void> => {
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');
  };

  test('plan pair-selection: a dev-created pair surfaces in promote --all', async () => {
    await createBeta();
    const ledger = await readLedgerOf();
    const r = await planFlips(
      f.env,
      { ...opts({ all: true }), op: 'promote' },
      storeRootOf(f.data),
      ledger,
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.pairs.some((p) => p.skill === 'beta' && p.tool === 'claude-code')).toBe(true);
  });

  test('promote of a dev-created pair flips cleanly (fresh pin, dev record retained)', async () => {
    await createBeta();
    const r = await runPromote(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'] }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('flipped');

    const pair = getPair(await readLedgerOf(), 'beta', 'claude-code');
    expect(pair?.mode).toBe('pinned');
    expect(pair?.pinned).not.toBeNull();
    expect(pair?.dev?.sourcePath).toBe(resolve(f.betaSrc));
  });

  test("rollback planner: dev-only pair -> refused 'nothing to roll back', not a crash", async () => {
    await createBeta();
    const r = await runRollback(
      f.env,
      { ...opts({ targets: ['beta'], tools: ['claude-code'] }), op: 'dev' },
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('refused');
    expect(result?.reason).toContain('nothing to roll back');
  });

  test('rollback --dry-run predicts the same refusal on a dev-only pair', async () => {
    await createBeta();
    const r = await runRollback(
      f.env,
      { ...opts({ targets: ['beta'], tools: ['claude-code'], dryRun: true }), op: 'dev' },
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
  });

  test('dev --all neither selects nor chokes on a dev-only pair (dev-class, not pinned)', async () => {
    await createBeta();
    const r = await runDev(f.env, opts({ all: true }), passFlipDeps());
    if (!r.ok) throw new Error(msg(r.error));
    // beta is already in dev mode; `dev --all` flips pinned placements only.
    expect(r.value.results.some((res) => res.skill === 'beta' && res.action === 'failed')).toBe(
      false,
    );
    const pair = getPair(await readLedgerOf(), 'beta', 'claude-code');
    expect(pair?.mode).toBe('dev');
  });

  test('uninstall handles a dev-created pair: placement removed, record removed', async () => {
    await createBeta();
    const r = await runUninstall(
      f.env,
      { targets: ['beta'], tools: ['claude-code'], cwd: f.home, configuration: f.configuration },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('removed');
    expect(result?.before?.mode).toBe('dev');
    expect(result?.before?.symlinkTarget).toBe(resolve(f.betaSrc));

    expect(await f.env.pathKind(join(claudeRoot(), 'beta'))).toBe('absent');
    expect(getPair(await readLedgerOf(), 'beta', 'claude-code')).toBeNull();
    // The dev source itself is never touched by uninstall.
    expect(await f.env.pathKind(join(resolve(f.betaSrc), 'SKILL.md'))).toBe('file');
  });
});
