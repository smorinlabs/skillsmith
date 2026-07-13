import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPair, readLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { runDev, runPromote, runRollback } from '../../src/place/run.ts';
import type { LedgerFile } from '../../src/place/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { type DevSourceFlipOptions, actionV2, passFlipDeps } from '../fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

// P13-T6f: regression coverage for the final two residuals of the scoped re-review.
// Each block first reproduces the exact bug scenario the reviewer named (failing-first).
setDefaultTimeout(20_000);

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

describe('P13-T6f residual review regressions', () => {
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

  // -------------------------------------------------------------------------------------------
  // R1 (final window) — adopt must record EXACTLY what the final readLink observed. From that read
  // to setPair, the guard compares only the CAPTURED target string; it never re-dereferences the
  // live-derived path via realpath. A fresh realpath there is a retarget window: the pre-fix guard
  // trusted it over the captured read, so a realpath that canonicalizes the read target onto the
  // source spuriously matched and recorded the source while the disk pointed elsewhere (a mix).
  // -------------------------------------------------------------------------------------------

  test('R1: a realpath-injected retarget AFTER the final readLink refuses, never records a mixed target', async () => {
    const src = resolve(f.betaSrc); // --source
    const other = resolve(f.alphaSrc); // where the live symlink actually points
    const live = join(claudeRoot(), 'r1final');
    // Hand-made dev symlink pointing at `other`, NOT --source. A correct adopt must REFUSE: the
    // live link does not point at --source. The final readLink observes `other`.
    await symlink(other, live);

    // Model a retarget injected DURING the post-readLink canonicalization: when realpath is asked to
    // resolve the live-derived path (`other`), it returns the canonical of `src` — as if the link had
    // just been retargeted onto the source. The pre-fix guard realpath'd the live-derived path and
    // trusted that fresh result, so samePath(other, src) matched and it recorded `src` for disk-`other`.
    const racingEnv: RuntimePorts = {
      ...f.env,
      realpath: async (p) =>
        resolve(f.home, p) === other ? f.env.realpath(src) : f.env.realpath(p),
    };

    const r = await runDev(
      racingEnv,
      opts({ targets: ['r1final'], tools: ['claude-code'], source: src }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    // Record exactly what was read (`other` != --source) -> refuse; NEVER a mixed record claiming src.
    expect(actionV2(r.value.results[0])).toBe('refused');
    expect(getPair(await readLedgerOf(), 'r1final', 'claude-code')).toBeNull();
  });

  // -------------------------------------------------------------------------------------------
  // R3 (authoritative recorded path) — in bulk rollback the RECORDED placementPath is authoritative
  // UNCONDITIONALLY. A same-name real artifact that later appears at the STANDARD root is unmanaged
  // and must never be touched; the pre-fix order classified the standard root first and let that
  // artifact hijack the pair, mutating the unrelated artifact and orphaning the custom placement.
  // -------------------------------------------------------------------------------------------

  const setUpCustomPromotedPair = async (): Promise<{ custom: string; standard: string }> => {
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

    // Plant an UNRELATED, unmanaged real skill named `beta` at the STANDARD root, with a sentinel.
    const standard = join(claudeRoot(), 'beta');
    await mkdir(standard, { recursive: true });
    await writeFile(join(standard, 'SKILL.md'), '---\nname: beta\ndescription: unrelated\n---\n');
    await writeFile(join(standard, 'SENTINEL.txt'), 'do-not-touch');
    return { custom, standard };
  };

  const assertCustomRolledBackStandardUntouched = async (
    custom: string,
    standard: string,
  ): Promise<void> => {
    // Rolled back in place at the RECORDED custom path (now a dev symlink again).
    expect(await f.env.pathKind(custom)).toBe('symlink');
    const pair = getPair(await readLedgerOf(), 'beta', 'claude-code');
    expect(pair?.placementPath).toBe(custom);
    expect(pair?.mode).toBe('dev');
    // The standard-root artifact is UNMANAGED: byte-untouched (still a dir, sentinel intact).
    expect(await f.env.pathKind(standard)).toBe('dir');
    expect(await readFile(join(standard, 'SENTINEL.txt'), 'utf8')).toBe('do-not-touch');
  };

  test('R3: dev --rollback --all targets the RECORDED custom path, never a same-name standard-root artifact', async () => {
    const { custom, standard } = await setUpCustomPromotedPair();
    const rb = await runRollback(
      f.env,
      { ...opts({ all: true, tools: ['claude-code'] }), op: 'dev' },
      passFlipDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const res = rb.value.results.find((x) => x.skill === 'beta');
    expect(res?.action).toBe('rolled-back');
    expect(res?.placementPath).toBe(custom);
    await assertCustomRolledBackStandardUntouched(custom, standard);
  });

  test('R3: promote --rollback --all targets the RECORDED custom path, never a same-name standard-root artifact', async () => {
    const { custom, standard } = await setUpCustomPromotedPair();
    const rb = await runRollback(
      f.env,
      { ...opts({ all: true, tools: ['claude-code'] }), op: 'promote' },
      passFlipDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const res = rb.value.results.find((x) => x.skill === 'beta');
    expect(res?.action).toBe('rolled-back');
    expect(res?.placementPath).toBe(custom);
    await assertCustomRolledBackStandardUntouched(custom, standard);
  });
});
