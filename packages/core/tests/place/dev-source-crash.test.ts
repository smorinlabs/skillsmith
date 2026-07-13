import { describe, expect, test } from 'bun:test';
import { readdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPair, readLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { runDev } from '../../src/place/run.ts';
import type { FlipDeps } from '../../src/place/types.ts';
import { makeSkillSource, passFlipDeps } from '../fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';
import { crashingEnv } from './crash-env.ts';

// P12 crash-injection precedent, applied to the P13 create path: `crash-sweep.test.ts` wraps
// `runSwap` (promote/dev flip) in `crashingEnv` and sweeps every mutating call. This file does the
// same for `createDevPlacement` (S1 create, run.ts). Unlike the swap machinery, create/adopt keeps
// NO journal (PRD D3 — "no new journal op"), so there is no `SKILLSMITH_TEST_PAUSE_AT` real-SIGKILL
// seam for it either (that seam only understands `JournalPhase` values, none of which apply here) —
// this file's coverage is entirely the `crashingEnv` fs-hook technique plus, where that technique
// structurally cannot reach a scenario (see the last describe block), a state-construction test.
//
// T2 already covers one hand-constructed crash state (dev-source.test.ts:192, "S2 (codex): simulated
// crash state"). This file does not duplicate that case; it covers the *mechanism* (every mutating
// call actually crashed, via the real code path) rather than one hand-picked end state.

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const claudeRootOf = (f: FixtureFleet): string => join(f.home, '.claude', 'skills');

const stagingResidue = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((n) => n.startsWith('.skillsmith-'));

const readLedgerOf = async (f: FixtureFleet) => {
  const r = await readLedger(f.env, ledgerPathOf(f.data));
  if (!r.ok) throw new Error(msg(r.error));
  return r.value;
};

describe('dev --source create — crash sweep (crashingEnv, P12 technique)', () => {
  // A single fixture fleet is reused across the sweep: each iteration targets its own fresh skill
  // name (sweep1, sweep2, ...) with its own source dir, so iterations cannot interfere with each
  // other and no snapshot/restore dance (as crash-sweep.test.ts needs for its single shared 'alpha'
  // skill) is required here.
  test('every mutating-call crash point leaves either a clean absent state or a clean S2 state — never residue — and a plain re-run always converges to `created`', async () => {
    const f = await buildFixtureFleet();
    try {
      const claudeRoot = claudeRootOf(f);

      // The ledger file itself is created lazily on first write (`withLedgerLock`: "if
      // pathKind(ledgerPath) === absent, writeTextFile('')"), which is ONE FEWER mutating call once
      // it already exists. Warm it up with a throwaway real create first, so every iteration below
      // (which shares this one fixture/ledger across `sweepN` skills) sees the same steady-state
      // call count — otherwise the count learned from a pristine ledger would overcount by one for
      // every iteration after the first.
      const warmupSource = await makeSkillSource(f.base, 'sweepwarmup');
      const warmup = await runDev(
        f.env,
        {
          targets: ['sweepwarmup'],
          tools: ['claude-code'],
          source: resolve(warmupSource),
          cwd: f.home,
          configuration: f.configuration,
        },
        passFlipDeps(),
      );
      if (!warmup.ok) throw new Error(msg(warmup.error));

      // Learn the steady-state mutation count of a crash-free run (crashAtCall <= 0 disables
      // crashing), same pattern as crash-sweep.test.ts. Uses its own disposable skill so it doesn't
      // consume a `sweepN` name.
      const drySource = await makeSkillSource(f.base, 'sweepdry');
      const counter = crashingEnv(f.env, 0);
      const dry = await runDev(
        counter.env,
        {
          targets: ['sweepdry'],
          tools: ['claude-code'],
          source: resolve(drySource),
          cwd: f.home,
          configuration: f.configuration,
        },
        passFlipDeps(),
      );
      if (!dry.ok) throw new Error(msg(dry.error));
      const totalMutations = counter.calls();
      expect(totalMutations).toBeGreaterThan(0);

      // Track which of the two convergence classes (D3's S2, and the earlier pre-rename/pre-lock
      // window) the sweep actually visits, so the sweep can't silently degenerate into visiting
      // only one of them.
      let sawPreCreationWindow = false; // live absent after the crashed call
      let sawS2Window = false; // live present (real symlink), ledger not yet updated

      for (let n = 1; n <= totalMutations; n++) {
        const skill = `sweep${n}`;
        const source = await makeSkillSource(f.base, skill);
        const resolvedSource = resolve(source);
        const crash = crashingEnv(f.env, n);

        const opts = {
          targets: [skill],
          tools: ['claude-code' as const],
          source: resolvedSource,
          cwd: f.home,
          configuration: f.configuration,
        };

        const r = await runDev(crash.env, opts, passFlipDeps());

        // Early crash points (lock-directory setup, ahead of any per-pair work) surface as a
        // top-level Result error rather than a per-pair `failed` result — both are legitimate,
        // caught outcomes (never an unhandled throw reaching the test).
        if (r.ok) {
          expect(r.value.results[0]?.action).toBe('failed');
        }

        const liveKind = await f.env.pathKind(join(claudeRoot, skill));
        expect(['absent', 'symlink']).toContain(liveKind);
        if (liveKind === 'symlink') {
          sawS2Window = true;
          expect(await f.env.readLink(join(claudeRoot, skill))).toBe(resolvedSource);
        } else {
          sawPreCreationWindow = true;
        }

        // No `.skillsmith-staging-*` (or any other `.skillsmith-*`) entry survives the crashed
        // call — createDevPlacement's own catch (staging → live not yet renamed) or writeLedger's
        // own catch (tmp ledger file) cleans up synchronously in every reachable same-process
        // crash-and-continue scenario.
        expect(await stagingResidue(claudeRoot)).toEqual([]);

        // No ledger record yet in either window (S2 is defined as "not in the ledger").
        expect(getPair(await readLedgerOf(f), skill, 'claude-code')).toBeNull();

        // A plain, uncrashed re-run always converges to `created` (whether it starts from
        // absent — full S1 — or from the S2 window — record-only adopt, disk untouched).
        const rerun = await runDev(f.env, opts, passFlipDeps());
        if (!rerun.ok) throw new Error(`re-run n=${n}: ${msg(rerun.error)}`);
        const rerunResult = rerun.value.results[0];
        if (!rerunResult) throw new Error(`re-run n=${n}: no result returned`);
        expect(['created', 'adopted']).toContain(rerunResult.action);

        expect(await f.env.pathKind(join(claudeRoot, skill))).toBe('symlink');
        expect(await f.env.readLink(join(claudeRoot, skill))).toBe(resolvedSource);
        const pair = getPair(await readLedgerOf(f), skill, 'claude-code');
        expect(pair?.mode).toBe('dev');
        expect(pair?.dev?.sourcePath).toBe(resolvedSource);
        expect(pair?.pinned ?? null).toBeNull();
        expect(pair?.journal ?? null).toBeNull();
        expect(await stagingResidue(claudeRoot)).toEqual([]);
      }

      // The sweep must actually reach both convergence classes, or it isn't exercising what it
      // claims to (a `totalMutations` regression that shrank the call graph would otherwise pass
      // silently while only ever visiting one window).
      expect(sawPreCreationWindow).toBe(true);
      expect(sawS2Window).toBe(true);
    } finally {
      await destroyFixtureFleet(f);
    }
  }, 120_000);
});

describe('dev --source create — staging-name collision on retry', () => {
  // Production `newTxId` is `randomBytes(4).toString('hex')` (run.ts) — a real collision between
  // two *different* invocations is astronomically unlikely. The scenario this defends against is
  // the one createDevPlacement's own guard exists for: a leftover entry already occupying the exact
  // staging path this attempt is about to use. `FlipDeps.newTxId` is an injectable seam (same
  // pattern as `now`/`verify`), so pinning it to a fixed value makes that path deterministic instead
  // of guessing at a real collision. This is the "injectable fs/env hooks" half of the P12
  // technique, not `crashingEnv` — the fault here is pre-existing disk state, not a call failing.
  test('a pre-existing entry at the computed staging path is displaced, not left as a duplicate or a fatal error', async () => {
    const f = await buildFixtureFleet();
    try {
      const claudeRoot = claudeRootOf(f);
      const skill = 'collide';
      const source = await makeSkillSource(f.base, skill);
      const resolvedSource = resolve(source);
      const fixedTxId = 'fixedcollide1';
      const stagingPath = join(claudeRoot, `.skillsmith-staging-${skill}-${fixedTxId}`);

      // Pre-seed the exact staging path with stale content pointing somewhere else entirely, as a
      // stray from an earlier, differently-purposed attempt would.
      await symlink('/nonexistent/stale-source', stagingPath);
      expect(await f.env.pathKind(stagingPath)).toBe('symlink');

      const deps: FlipDeps = { ...passFlipDeps(), newTxId: () => fixedTxId };
      const r = await runDev(
        f.env,
        {
          targets: [skill],
          tools: ['claude-code'],
          source: resolvedSource,
          cwd: f.home,
          configuration: f.configuration,
        },
        deps,
      );
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('created');

      // The collision was displaced (removed, then the real staging entry was created and renamed
      // away to `live`) — nothing is left at the staging path itself, and `live` is correct, not the
      // stale target.
      expect(await f.env.pathKind(stagingPath)).toBe('absent');
      expect(await f.env.pathKind(join(claudeRoot, skill))).toBe('symlink');
      expect(await f.env.readLink(join(claudeRoot, skill))).toBe(resolvedSource);

      const pair = getPair(await readLedgerOf(f), skill, 'claude-code');
      expect(pair?.dev?.sourcePath).toBe(resolvedSource);
    } finally {
      await destroyFixtureFleet(f);
    }
  });
});

describe('dev --source create — true process death leaves a staging orphan (now swept: BF-5 / T5)', () => {
  // A real SIGKILL during an OLD-style staged create (`makeSymlink(source, staging)` then
  // `rename(staging, live)`) could leave a stray `.skillsmith-staging-<skill>-<txid>` — the process
  // is simply gone, so no in-process catch ran. The current create path no longer stages at all (it
  // publishes the symlink directly at the final path, BF-5(a)), and BF-5's non-blocking pre-stage
  // sweep removes any stale `.skillsmith-staging-<skill>-*` for THIS name before publishing. So a
  // stray staging orphan left by a truly-dead earlier attempt — which a random-txid retry could
  // never rediscover under the old scheme — is now swept on the next `dev --source` for that name.
  // The scenario is still modeled by constructing the terminal disk state directly (crashingEnv
  // throws in-process, before the primitive; it cannot express a no-cleanup process death).
  test('a stray staging orphan for this name is swept by the next create, which still converges', async () => {
    const f = await buildFixtureFleet();
    try {
      const claudeRoot = claudeRootOf(f);
      const skill = 'deadproc';
      const source = await makeSkillSource(f.base, skill);
      const resolvedSource = resolve(source);

      // The disk state a process SIGKILLed mid-create leaves: a stray staging entry, `live` absent,
      // nothing recorded. Its txId ("deadbeef01") is deliberately arbitrary — the sweep is by NAME,
      // not by txid, so it no longer matters that a retry could never guess the dead one.
      const deadStaging = join(claudeRoot, `.skillsmith-staging-${skill}-deadbeef01`);
      await symlink(resolvedSource, deadStaging);
      expect(await f.env.pathKind(join(claudeRoot, skill))).toBe('absent');

      const r = await runDev(
        f.env,
        {
          targets: [skill],
          tools: ['claude-code'],
          source: resolvedSource,
          cwd: f.home,
          configuration: f.configuration,
        },
        passFlipDeps(),
      );
      if (!r.ok) throw new Error(msg(r.error));

      // The skill converges correctly ...
      expect(r.value.results[0]?.action).toBe('created');
      expect(await f.env.pathKind(join(claudeRoot, skill))).toBe('symlink');
      expect(await f.env.readLink(join(claudeRoot, skill))).toBe(resolvedSource);
      const pair = getPair(await readLedgerOf(f), skill, 'claude-code');
      expect(pair?.dev?.sourcePath).toBe(resolvedSource);

      // ... AND the dead attempt's staging orphan was swept before the publish (BF-5 / T5).
      expect(await f.env.pathKind(deadStaging)).toBe('absent');
      expect(await stagingResidue(claudeRoot)).toEqual([]);
    } finally {
      await destroyFixtureFleet(f);
    }
  });
});
