import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ScanEnv } from '../../src/env/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPair, readLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { runDev, runPromote, runRollback } from '../../src/place/run.ts';
import type { LedgerFile } from '../../src/place/types.ts';
import {
  type DevSourceFlipOptions,
  actionV2,
  cannedFlipDeps,
  passFlipDeps,
} from '../fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

// P13-T6d: regression coverage for the four residual blockers (R1..R4) from the scoped re-review.
// Each block first reproduces the exact bug scenario the reviewer named (failing-first).
setDefaultTimeout(20_000);

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

describe('P13-T6d residual review regressions', () => {
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
    envVars: f.envVars,
    ...o,
  });
  const claudeRoot = (): string => join(f.home, '.claude', 'skills');
  const readLedgerOf = async (): Promise<LedgerFile> => {
    const r = await readLedger(f.env, ledgerPathOf(f.data));
    if (!r.ok) throw new Error(msg(r.error));
    return r.value;
  };

  // -------------------------------------------------------------------------------------------
  // R1 — adopt race residual: provenance must run BEFORE the final live re-read, so a retarget
  // that lands DURING provenance collection is still caught (never record source A for disk B).
  // -------------------------------------------------------------------------------------------

  test('R1: a retarget DURING provenance collection refuses the adopt, never records the stale source', async () => {
    const src = resolve(f.betaSrc);
    const other = resolve(f.alphaSrc);
    const live = join(claudeRoot(), 'r1race');
    await symlink(src, live); // hand-made dev symlink to src (== --source), not in ledger -> S2 adopt

    // Model a concurrent retarget that happens WHILE provenance is being collected: the first git
    // exec (resolveProvenance's `rev-parse --show-toplevel`) fires the retarget of the LIVE symlink
    // to `other`. With provenance done BEFORE the final re-read, the re-read observes the retarget
    // and refuses; the pre-fix order (re-read BEFORE provenance) had already recorded `src`.
    let retargeted = false;
    const racingEnv: ScanEnv = {
      ...f.env,
      exec: async (cmd, args, o) => {
        if (!retargeted && cmd === 'git') {
          retargeted = true;
          await rm(live, { force: true });
          await symlink(other, live);
        }
        return f.env.exec(cmd, args, o);
      },
    };

    const r = await runDev(
      racingEnv,
      opts({ targets: ['r1race'], tools: ['claude-code'], source: src }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    // Never recorded a lie: no dev record claiming `src` while the disk now points at `other`.
    expect(getPair(await readLedgerOf(), 'r1race', 'claude-code')).toBeNull();
  });

  // -------------------------------------------------------------------------------------------
  // R2 — lock split-brain: the ledger lock DIR is `placements.json.lock` (target-locked with
  // realpath:false, no materialization), so an old-style holder of that dir excludes a new binary.
  // -------------------------------------------------------------------------------------------

  test('R2: an old-style holder of placements.json.lock blocks a new acquisition (cross-version exclusion)', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    await f.env.makeDir(f.data);
    // A pre-T6b binary locked TARGET placements.json -> proper-lockfile mkdir'd the lock DIR
    // `placements.json.lock`. Recreate exactly that directory to model the old holder.
    await mkdir(`${ledgerPath}.lock`, { recursive: true });

    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      passFlipDeps(),
    );
    // The new acquisition must BLOCK/FAIL, not proceed into a second (split-brain) lock dir.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('flip-failed');
    // And it must not have mutated the ledger under the foreign lock.
    expect(await f.env.pathKind(ledgerPath)).toBe('absent');
  });

  test('R2: a gate failure on a fresh home leaves NO placements.json (target-lock, no materialization)', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    expect(await f.env.pathKind(ledgerPath)).toBe('absent');
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      cannedFlipDeps('fail'), // verify gate blocks -> failed, nothing written
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('failed');
    // D2: no ledger materialized. The lock DIR is placements.json.lock; the ledger FILE stays absent.
    expect(await f.env.pathKind(ledgerPath)).toBe('absent');
  });

  // -------------------------------------------------------------------------------------------
  // R3 — custom-dest rollback-all mis-target: bulk rollback must classify each pair at its RECORDED
  // placementPath (BF-1d ledger-first), so a promoted --dest pair is restored in place.
  // -------------------------------------------------------------------------------------------

  test('R3: dev --rollback --all restores a promoted --dest pair in place (recorded placementPath, no standard-root artifact)', async () => {
    const dest = join(f.base, 'custom-skills');
    await mkdir(dest, { recursive: true });
    const custom = join(dest, 'beta');

    const created = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc), dest }),
      passFlipDeps(),
    );
    if (!created.ok) throw new Error(msg(created.error));
    expect(actionV2(created.value.results[0])).toBe('created');

    const promoted = await runPromote(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'] }),
      passFlipDeps(),
    );
    if (!promoted.ok) throw new Error(msg(promoted.error));
    expect(promoted.value.results[0]?.action).toBe('flipped');
    expect(await f.env.pathKind(custom)).toBe('dir'); // pinned copy at the custom location

    // Bulk rollback is direction-agnostic. Pre-fix this classified at the STANDARD root, rewrote
    // placementPath to join(claudeRoot,'beta'), and orphaned the custom placement.
    const rb = await runRollback(
      f.env,
      { ...opts({ all: true, tools: ['claude-code'] }), op: 'dev' },
      passFlipDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const res = rb.value.results.find((x) => x.skill === 'beta');
    expect(res?.action).toBe('rolled-back');
    expect(res?.placementPath).toBe(custom);
    // Restored in place as a dev symlink; nothing appears at the standard root.
    expect(await f.env.pathKind(custom)).toBe('symlink');
    expect(await f.env.pathKind(join(claudeRoot(), 'beta'))).toBe('absent');
    const pair = getPair(await readLedgerOf(), 'beta', 'claude-code');
    expect(pair?.placementPath).toBe(custom);
    expect(pair?.mode).toBe('dev');
  });

  // -------------------------------------------------------------------------------------------
  // R4 — symlinked SKILL.md regression: a SKILL.md that is a symlink to a regular file is a usable
  // source (stat-following check), while a directory named SKILL.md is still refused (BF-6).
  // -------------------------------------------------------------------------------------------

  test('R4: a SKILL.md symlinked to a regular file is a usable source (create + dry-run + adopt)', async () => {
    const srcDir = join(f.base, 'srcs', 'symmd');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'REAL.md'), '---\nname: symmd\ndescription: x\n---\n');
    await symlink('REAL.md', join(srcDir, 'SKILL.md')); // relative symlink to a regular file

    // create (S1)
    const created = await runDev(
      f.env,
      opts({ targets: ['symmd'], tools: ['claude-code'], source: srcDir }),
      passFlipDeps(),
    );
    if (!created.ok) throw new Error(msg(created.error));
    expect(actionV2(created.value.results[0])).toBe('created');

    // dry-run predicts created for a fresh pair name against the same source.
    const dry = await runDev(
      f.env,
      opts({ targets: ['symmd2'], tools: ['claude-code'], source: srcDir, dryRun: true }),
      passFlipDeps(),
    );
    if (!dry.ok) throw new Error(msg(dry.error));
    expect(actionV2(dry.value.results[0])).toBe('created');

    // adopt (S2): a hand-made dev symlink whose source's SKILL.md is a symlink-to-file.
    const live = join(claudeRoot(), 'symadopt');
    await symlink(resolve(srcDir), live);
    const adopted = await runDev(
      f.env,
      opts({ targets: ['symadopt'], tools: ['claude-code'], source: resolve(srcDir) }),
      passFlipDeps(),
    );
    if (!adopted.ok) throw new Error(msg(adopted.error));
    expect(actionV2(adopted.value.results[0])).toBe('adopted');
  });

  test('R4: a directory named SKILL.md is still refused (BF-6 stays fixed)', async () => {
    const badSrc = join(f.base, 'srcs', 'skilldir');
    await mkdir(join(badSrc, 'SKILL.md'), { recursive: true }); // SKILL.md is a DIRECTORY
    for (const dryRun of [false, true]) {
      const r = await runDev(
        f.env,
        opts({ targets: ['skilldir'], tools: ['claude-code'], source: badSrc, dryRun }),
        passFlipDeps(),
      );
      if (!r.ok) throw new Error(msg(r.error));
      expect(actionV2(r.value.results[0])).toBe('refused');
    }
  });
});
