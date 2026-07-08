import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join, resolve } from 'node:path';
import type { ScanEnv } from '../../src/env/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { emptyLedger, getPair, readLedger, setPair, writeLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf, storeRootOf } from '../../src/place/paths.ts';
import { runDev, runPromote } from '../../src/place/run.ts';
import { resolveProvenance, snapshotToStore } from '../../src/place/store.ts';
import type {
  DevRecord,
  FlipDeps,
  FlipOptions,
  OriginRecord,
  PinnedRecord,
} from '../../src/place/types.ts';
import type { Result } from '../../src/result.ts';
import { ok } from '../../src/result.ts';
import type { VerifyOptions } from '../../src/verify/run.ts';
import type { ModeResult, ToolVerdict, VerifyReport, VerifyTool } from '../../src/verify/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

// D9 (P09-T05): store-linked placements interop with the flip verbs. Each test here builds its
// own fixture fleet and drives real git subprocess calls (via seedStore/commitAll) plus real
// filesystem swaps, so allow the same generous timeout run.test.ts uses.
setDefaultTimeout(20_000);

const NOW = '2026-07-07T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);
const REINSTALL_REASON = "managed state missing; reinstall with 'skillsmith install --force'";

const runGit = (checkout: string, args: string[]): void => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: checkout,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
};

const commitChange = (checkout: string, relPath: string, content: string): void => {
  Bun.write(join(checkout, relPath), content);
};

const commitAll = (checkout: string, message: string): void => {
  runGit(checkout, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(checkout, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  ]);
};

const dev = (sourcePath: string): DevRecord => ({
  sourcePath,
  resolvedPath: sourcePath,
  repoRoot: null,
  sourceRelPath: null,
  remote: null,
  recordedAt: NOW,
});

const origin = (source: string): OriginRecord => ({
  source,
  host: 'github.com',
  repo: 'smorinlabs/fixture-harness',
  skillPath: 'plugins/fh/skills/alpha',
  refRequested: null,
  refResolved: 'a'.repeat(40),
  pin: false,
  installedAt: NOW,
});

const pinnedOf = (
  storePath: string,
  rev: string,
  contentHash: string,
  placement: 'symlink' | 'copy',
): PinnedRecord => ({
  storePath,
  rev,
  gitSha: null,
  dirty: false,
  contentHash,
  snapshotAt: NOW,
  verify: 'passed',
  placement,
});

interface StoreSeed {
  storePath: string;
  rev: string;
  contentHash: string;
}

const seedStore = async (f: FixtureFleet, skill: string): Promise<StoreSeed> => {
  const prov = await resolveProvenance(f.env, f.alphaSrc);
  if (!prov.ok) throw new Error(msg(prov.error));
  const snap = await snapshotToStore(f.env, {
    sourceDir: f.alphaSrc,
    skill,
    storeRoot: storeRootOf(f.data),
    provenance: prov.value,
    txId: 'seed0001',
  });
  if (!snap.ok) throw new Error(msg(snap.error));
  return {
    storePath: snap.value.storePath,
    rev: snap.value.rev,
    contentHash: snap.value.contentHash,
  };
};

const makeVerifyReport = (tool: VerifyTool): VerifyReport => {
  const mode: ModeResult = {
    mode: 'static',
    status: 'ran',
    skipReason: null,
    coverage: { manifest: true, skills: true },
    verdict: 'pass',
    command: 'fake',
    findings: [],
  };
  const toolVerdict: ToolVerdict = {
    tool,
    available: true,
    toolVersion: '1.0.0',
    versionDrift: false,
    skipReason: null,
    verdict: 'pass',
    modes: [mode],
  };
  return {
    schemaVersion: 1,
    target: { path: '/fake', kind: 'skill' },
    requested: { tools: [tool], modes: ['static'], strict: false, explicitTools: true },
    verifiedAgainst: { 'claude-code': '1.0.0', codex: '1.0.0' },
    summary: {
      verdict: 'pass',
      verified: [tool],
      failed: [],
      skipped: [],
      counts: { error: 0, warning: 0, info: 0 },
    },
    tools: [toolVerdict],
  };
};

let txCounter = 0;
const nextTxId = (): string => (++txCounter).toString(16).padStart(8, '0');

const passDeps = (): FlipDeps => ({
  now: () => NOW,
  newTxId: nextTxId,
  verify: async (_env: ScanEnv, o: VerifyOptions) => {
    const tool = o.tools?.[0] ?? 'claude-code';
    return ok(makeVerifyReport(tool)) as Result<VerifyReport, SkillSmithError>;
  },
});

const opts = (f: FixtureFleet, o: Partial<FlipOptions> = {}): FlipOptions => ({
  targets: [],
  cwd: f.home,
  envVars: f.envVars,
  ...o,
});

const readLedgerOf = async (f: FixtureFleet) => readLedger(f.env, ledgerPathOf(f.data));

describe('store-linked flip (D9)', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('install -> dev --source -> promote loop keeps the fleet a store symlink (PRD scenario 4)', async () => {
    const s = await seedStore(f, 'alpha-inst');
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, 'alpha-inst');
    await f.env.makeSymlink(s.storePath, live);

    const seededOrigin = origin('smorinlabs/fixture-harness/alpha');
    const seededDev = dev(resolve(f.alphaSrc));
    const seededPinned = pinnedOf(s.storePath, s.rev, s.contentHash, 'symlink');
    const ledger = emptyLedger(NOW);
    setPair(ledger, 'alpha-inst', 'claude-code', {
      placementPath: live,
      mode: 'pinned',
      dev: seededDev,
      pinned: seededPinned,
      origin: seededOrigin,
      journal: null,
    });
    await writeLedger(f.env, ledgerPathOf(f.data), ledger);

    // --- runDev: store-linked with a dev record flips to the recorded source ---
    const devResult = await runDev(f.env, opts(f, { targets: ['alpha-inst'] }), passDeps());
    if (!devResult.ok) throw new Error(msg(devResult.error));
    const dr = devResult.value.results[0];
    expect(dr?.action).toBe('flipped');
    expect(await f.env.pathKind(live)).toBe('symlink');
    expect(await f.env.readLink(live)).toBe(resolve(f.alphaSrc));
    expect(dr?.reason ?? '').not.toContain('kept backup');

    const afterDev = await readLedgerOf(f);
    if (!afterDev.ok) throw new Error(msg(afterDev.error));
    const pairAfterDev = getPair(afterDev.value, 'alpha-inst', 'claude-code');
    expect(pairAfterDev?.mode).toBe('dev');
    expect(pairAfterDev?.pinned).toEqual(seededPinned);
    expect(pairAfterDev?.origin).toEqual(seededOrigin);

    const residueAfterDev = (await f.env.listDir(skillsRoot)).filter((n) =>
      n.startsWith('.skillsmith-'),
    );
    expect(residueAfterDev).toEqual([]);

    // --- dry-run promote should predict the coming re-pin as 'updated' ---
    const dryBeforeChange = await runPromote(
      f.env,
      opts(f, { targets: ['alpha-inst'], dryRun: true }),
      passDeps(),
    );
    if (!dryBeforeChange.ok) throw new Error(msg(dryBeforeChange.error));
    expect(dryBeforeChange.value.results[0]?.action).toBe('noop');

    // --- runPromote after the source moved: re-pins as a store SYMLINK, not a copy ---
    commitChange(
      f.checkout,
      'plugins/fh/skills/alpha/SKILL.md',
      '---\nname: alpha\ndescription: v2.\n---\n',
    );
    commitAll(f.checkout, 'fixture: alpha v2');

    const dryAfterChange = await runPromote(
      f.env,
      opts(f, { targets: ['alpha-inst'], dryRun: true }),
      passDeps(),
    );
    if (!dryAfterChange.ok) throw new Error(msg(dryAfterChange.error));
    expect(dryAfterChange.value.results[0]?.action).toBe('updated');

    const promoted = await runPromote(f.env, opts(f, { targets: ['alpha-inst'] }), passDeps());
    if (!promoted.ok) throw new Error(msg(promoted.error));
    const pr = promoted.value.results[0];
    expect(pr?.action).toBe('updated');
    expect(await f.env.pathKind(live)).toBe('symlink');
    expect(pr?.store?.path).toBeDefined();
    expect(await f.env.readLink(live)).toBe(pr?.store?.path as string);
    expect(pr?.store?.rev).not.toBe(s.rev);

    const afterPromote = await readLedgerOf(f);
    if (!afterPromote.ok) throw new Error(msg(afterPromote.error));
    const pairAfterPromote = getPair(afterPromote.value, 'alpha-inst', 'claude-code');
    expect(pairAfterPromote?.pinned?.placement).toBe('symlink');
    expect(pairAfterPromote?.origin).toEqual(seededOrigin);

    const residueAfterPromote = (await f.env.listDir(skillsRoot)).filter((n) =>
      n.startsWith('.skillsmith-'),
    );
    expect(residueAfterPromote).toEqual([]);

    // --- runPromote again with the source unchanged: noop ---
    const noopResult = await runPromote(f.env, opts(f, { targets: ['alpha-inst'] }), passDeps());
    if (!noopResult.ok) throw new Error(msg(noopResult.error));
    expect(noopResult.value.results[0]?.action).toBe('noop');
  });

  test('genuine store-linked re-pin (no dev flip first) drives runPromotePair store-linked branch', async () => {
    // Unlike the PRD-scenario-4 test above, this does NOT call runDev first, so the live path is
    // STILL a symlink into the store at promote time — classifyPlacement reports 'store-linked',
    // exercising runPromotePair's `placement.class === 'store-linked'` branch (adoptedDev = null,
    // since the pre-swap live symlink already points INSIDE the store) rather than the dev-class
    // branch. The engine mechanics are covered by Task 5's swap-acquire test; this covers the
    // run.ts WIRING of that branch end-to-end with a moved rev.
    const s = await seedStore(f, 'alpha-inst');
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, 'alpha-inst');
    await f.env.makeSymlink(s.storePath, live);

    const seededOrigin = origin('smorinlabs/fixture-harness/alpha');
    const seededDev = dev(resolve(f.alphaSrc));
    const seededPinned = pinnedOf(s.storePath, s.rev, s.contentHash, 'symlink');
    const ledger = emptyLedger(NOW);
    setPair(ledger, 'alpha-inst', 'claude-code', {
      placementPath: live,
      mode: 'pinned',
      dev: seededDev,
      pinned: seededPinned,
      origin: seededOrigin,
      journal: null,
    });
    await writeLedger(f.env, ledgerPathOf(f.data), ledger);

    // Confirm the live path is genuinely store-linked BEFORE promote (guards against the coverage
    // silently regressing to the dev-class branch if the seed or classifier ever changes).
    expect(await f.env.pathKind(live)).toBe('symlink');
    expect(await f.env.readLink(live)).toBe(s.storePath); // points into the store => store-linked

    // Move the source rev so the store-linked convergence re-pins (rather than noops).
    commitChange(
      f.checkout,
      'plugins/fh/skills/alpha/SKILL.md',
      '---\nname: alpha\ndescription: v2.\n---\n',
    );
    commitAll(f.checkout, 'fixture: alpha v2');

    const promoted = await runPromote(f.env, opts(f, { targets: ['alpha-inst'] }), passDeps());
    if (!promoted.ok) throw new Error(msg(promoted.error));
    const pr = promoted.value.results[0];
    expect(pr?.action).toBe('updated');
    // before.mode is 'pinned' (the store-linked branch reports a pinned before-state, NOT a dev
    // one) — outcome-level confirmation that the store-linked-class branch (not the dev branch) ran.
    expect(pr?.before?.mode).toBe('pinned');
    expect(pr?.store?.rev).not.toBe(s.rev);

    // Live is a store SYMLINK again, retargeted to the NEW store entry.
    expect(await f.env.pathKind(live)).toBe('symlink');
    expect(pr?.store?.path).toBeDefined();
    expect(await f.env.readLink(live)).toBe(pr?.store?.path as string);

    const after = await readLedgerOf(f);
    if (!after.ok) throw new Error(msg(after.error));
    const pair = getPair(after.value, 'alpha-inst', 'claude-code');
    expect(pair?.mode).toBe('pinned');
    expect(pair?.pinned?.placement).toBe('symlink');
    expect(pair?.pinned?.rev).not.toBe(s.rev);
    expect(pair?.origin).toEqual(seededOrigin); // retained verbatim
    expect(pair?.dev).not.toBeNull(); // dev record retained
    expect(pair?.journal).toBeNull();

    const residue = (await f.env.listDir(skillsRoot)).filter((n) => n.startsWith('.skillsmith-'));
    expect(residue).toEqual([]);
  });

  test('recordless store-linked (hand-made symlink into the store) stays refused; --source adopts it', async () => {
    const s = await seedStore(f, 'slink-src');
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, 'slink');
    await f.env.makeSymlink(s.storePath, live);
    // No ledger pair at all — a genuinely unmanaged, hand-made store-linked placement.

    const refusedPromote = await runPromote(f.env, opts(f, { targets: ['slink'] }), passDeps());
    if (!refusedPromote.ok) throw new Error(msg(refusedPromote.error));
    const rp = refusedPromote.value.results[0];
    expect(rp?.action).toBe('refused');
    expect(rp?.reason).toContain(REINSTALL_REASON);
    expect(rp?.error?.code).toBe('flip-refused'); // exit contribution 2, not placement-not-found

    const refusedDev = await runDev(f.env, opts(f, { targets: ['slink'] }), passDeps());
    if (!refusedDev.ok) throw new Error(msg(refusedDev.error));
    const rd = refusedDev.value.results[0];
    expect(rd?.action).toBe('refused');
    expect(rd?.reason).toContain(REINSTALL_REASON);
    expect(rd?.error?.code).toBe('flip-refused');

    // dry-run mirrors the real refusal
    const dryRefused = await runPromote(
      f.env,
      opts(f, { targets: ['slink'], dryRun: true }),
      passDeps(),
    );
    if (!dryRefused.ok) throw new Error(msg(dryRefused.error));
    expect(dryRefused.value.results[0]?.action).toBe('refused');
    expect(dryRefused.value.results[0]?.reason).toContain(REINSTALL_REASON);

    const adopted = await runDev(
      f.env,
      opts(f, { targets: ['slink'], source: resolve(f.alphaSrc) }),
      passDeps(),
    );
    if (!adopted.ok) throw new Error(msg(adopted.error));
    const ad = adopted.value.results[0];
    expect(ad?.action).toBe('flipped');
    expect(await f.env.pathKind(live)).toBe('symlink');
    expect(await f.env.readLink(live)).toBe(resolve(f.alphaSrc));

    const ledgerRes = await readLedgerOf(f);
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    const pair = getPair(ledgerRes.value, 'slink', 'claude-code');
    expect(pair?.mode).toBe('dev');
    expect(pair?.dev?.sourcePath).toBe(resolve(f.alphaSrc));
  });

  test('store-linked with a pair but no dev record: promote noops, dev refuses without --source', async () => {
    const s = await seedStore(f, 'beta-inst');
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, 'beta-inst');
    await f.env.makeSymlink(s.storePath, live);
    const ledger = emptyLedger(NOW);
    setPair(ledger, 'beta-inst', 'claude-code', {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf(s.storePath, s.rev, s.contentHash, 'symlink'),
      origin: origin('smorinlabs/fixture-harness/alpha'),
      journal: null,
    });
    await writeLedger(f.env, ledgerPathOf(f.data), ledger);

    const promoted = await runPromote(f.env, opts(f, { targets: ['beta-inst'] }), passDeps());
    if (!promoted.ok) throw new Error(msg(promoted.error));
    const pr = promoted.value.results[0];
    expect(pr?.action).toBe('noop');
    expect(pr?.reason).toBe('already pinned; no dev source recorded');

    const devd = await runDev(f.env, opts(f, { targets: ['beta-inst'] }), passDeps());
    if (!devd.ok) throw new Error(msg(devd.error));
    const dr = devd.value.results[0];
    expect(dr?.action).toBe('refused');
    expect(dr?.reason).toBe('no recorded dev source; pass --source <path>');
  });

  test('copy-placement pairs are unaffected: a classic pinned re-pin still promotes via copy', async () => {
    const first = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!first.ok) throw new Error(msg(first.error));
    expect(first.value.results[0]?.action).toBe('flipped');
    expect(await f.env.pathKind(join(f.home, '.claude', 'skills', 'alpha'))).toBe('dir');

    const afterFirst = await readLedgerOf(f);
    if (!afterFirst.ok) throw new Error(msg(afterFirst.error));
    expect(getPair(afterFirst.value, 'alpha', 'claude-code')?.pinned?.placement).toBeUndefined();

    commitChange(
      f.checkout,
      'plugins/fh/skills/alpha/SKILL.md',
      '---\nname: alpha\ndescription: v2.\n---\n',
    );
    commitAll(f.checkout, 'fixture: alpha v2');

    const second = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!second.ok) throw new Error(msg(second.error));
    const result = second.value.results[0];
    expect(result?.action).toBe('updated');
    // still a real directory (copy), never converted to a symlink by the D9 change.
    expect(await f.env.pathKind(join(f.home, '.claude', 'skills', 'alpha'))).toBe('dir');
  });

  test('explicit --tool + recordless store-linked keeps the plan-level placement-not-found preResult', async () => {
    const s = await seedStore(f, 'gamma-inst');
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, 'gamma-inst');
    await f.env.makeSymlink(s.storePath, live);

    const r = await runPromote(
      f.env,
      opts(f, { targets: ['gamma-inst'], tools: ['claude-code'] }),
      passDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('refused');
    expect(result?.error?.code).toBe('placement-not-found'); // plan-level preResult, not run-layer
    expect(result?.reason).toContain('store-linked');
    expect(result?.reason).toContain('reinstall');
  });
});
