import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { classifyPlacement } from '../../src/agents/placement-shared.ts';
import type { LedgerModel } from '../../src/artifacts/ledger-types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  emptyLedger,
  getLedgerPairAt,
  getPair,
  readLedger,
  readLedgerState,
  setPair,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf, storeRootOf } from '../../src/place/paths.ts';
import { runDev, runPromote, runRollback } from '../../src/place/run.ts';
import { contentHashOf, resolveProvenance, snapshotToStore } from '../../src/place/store.ts';
import { rollbackSwap, runSwap } from '../../src/place/swap.ts';
import type {
  DevRecord,
  FlipDeps,
  FlipOptions,
  FlipResult,
  Journal,
  JournalPhase,
  LedgerFile,
  OriginRecord,
  PinnedRecord,
  SwapPlan,
  SwapRequest,
} from '../../src/place/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import type { Result } from '../../src/result.ts';
import { ok } from '../../src/result.ts';
import type { VerifyOptions } from '../../src/verify/run.ts';
import type { ModeResult, ToolVerdict, VerifyReport, VerifyTool } from '../../src/verify/types.ts';
import { hermeticGitEnv } from '../fixtures/git-env.ts';
import { canonicalFixtureLedger } from '../fixtures/place/canonical-ledger.ts';
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
    env: hermeticGitEnv(),
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
  verify: async (_env, o: VerifyOptions) => {
    const tool = o.tools?.[0] ?? 'claude-code';
    return ok(makeVerifyReport(tool)) as Result<VerifyReport, SkillSmithError>;
  },
});

const opts = (f: FixtureFleet, o: Partial<FlipOptions> = {}): FlipOptions => ({
  targets: [],
  cwd: f.home,
  configuration: f.configuration,
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
    const written = await writeLedger(f.env, ledgerPathOf(f.data), canonicalFixtureLedger(ledger));
    if (!written.ok) throw new Error(msg(written.error));

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
    const written = await writeLedger(f.env, ledgerPathOf(f.data), canonicalFixtureLedger(ledger));
    if (!written.ok) throw new Error(msg(written.error));

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

    const canonical = await readLedgerState(f.env, ledgerPathOf(f.data));
    if (!canonical.ok || canonical.value.state !== 'present') {
      throw new Error('canonical store-linked re-pin ledger is missing');
    }
    expect(
      getLedgerPairAt(canonical.value.model, null, 'alpha-inst', 'claude-code')?.journal ?? null,
    ).toBeNull();
    expect(canonical.value.model.history.at(-1)).toMatchObject({
      intent: { kind: 'update', skill: 'alpha-inst', tool: 'claude-code' },
      phase: 'committed',
    });

    const legacy = await readLedgerOf(f);
    if (!legacy.ok) throw new Error(msg(legacy.error));
    const pair = getPair(legacy.value, 'alpha-inst', 'claude-code');
    expect(pair?.mode).toBe('pinned');
    expect(pair?.pinned?.placement).toBe('symlink');
    expect(pair?.pinned?.rev).not.toBe(s.rev);
    expect(pair?.origin).toEqual(seededOrigin); // retained verbatim
    expect(pair?.dev).not.toBeNull(); // dev record retained
    // The physical install-shaped recovery shadow is cleared, while the compatibility view
    // projects the committed logical pinned-to-pinned update for legacy readers.
    expect(pair?.journal).toMatchObject({ op: 'install', phase: 'committed' });

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
    expect(getPair(ledgerRes.value, 'slink', 'codex')?.mode).toBe('dev');
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
    const written = await writeLedger(f.env, ledgerPathOf(f.data), canonicalFixtureLedger(ledger));
    if (!written.ok) throw new Error(msg(written.error));

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

// ---------------------------------------------------------------------------
// SC-I60-R1: an interrupted dev from a store-linked symlink must roll back to
// the literal old store target. Each boundary test seeds a genuine store entry
// plus a pinned pair with an existing dev record, drives the REAL runDev (or
// the exact exported runSwap) to write its own journal, injects ONE deterministic
// fault at a named path-and-operation boundary, then recovers through the PUBLIC
// runRollback (or the exact exported rollbackSwap after reloading disk).
//
// Boundary matrix (journal phase is the real write-ahead state on disk):
// - prepared:    fault before the owned staging makeSymlink. Old live only.
// - staged:      fault before rename(live, backup). Old live + staged dev exist; no backup.
//                The journal already advanced to 'backed-up' (write-ahead) even though the
//                rename never ran.
// - moved-aside: fault before rename(staging, live). Live absent; old at backup; staged new.
//                Positive control: restores without any target comparison.
// - published:   fault at the commit's skills-root fsync, after rename(staging, live). New live,
//                old at backup, uncommitted journal.
//
// Fault predicates match only owned placement paths under the fixture skills root, so the
// canonical ledger's own file renames under the data directory can never trip them.
//
// P17 line note: the rollback planner (placementRollbackOperationFor) independently requires
// the journal's saved symlink target and the public runRollback rejects while it is absent,
// so on this line every public boundary test is RED pre-fix — including moved-aside, whose
// engine branch could restore without the target. The pre-fix positive controls on this line
// are the direct moved-aside cases plus the directory/uninterrupted/resume/legacy controls.
// ---------------------------------------------------------------------------

type R1Boundary = 'prepared' | 'staged' | 'moved-aside' | 'published';
type R1TargetKind = 'absolute' | 'relative';

class R1BoundaryFault extends Error {
  constructor(
    readonly op: string,
    readonly detail: string,
  ) {
    super(`SC-I60-R1 one-shot fault at ${op} (${detail})`);
    this.name = 'R1BoundaryFault';
  }
}

interface R1Gate {
  env: RuntimePorts;
  fired: () => number;
  faultDetail: () => string | null;
}

const gateMakeSymlink = (inner: RuntimePorts, match: (linkPath: string) => boolean): R1Gate => {
  let n = 0;
  let detail: string | null = null;
  const env: RuntimePorts = {
    ...inner,
    makeSymlink: async (target, linkPath) => {
      if (n === 0 && match(linkPath)) {
        n += 1;
        detail = `target=${target} linkPath=${linkPath}`;
        throw new R1BoundaryFault('makeSymlink', detail);
      }
      return inner.makeSymlink(target, linkPath);
    },
  };
  return { env, fired: () => n, faultDetail: () => detail };
};

const gateRename = (inner: RuntimePorts, match: (from: string, to: string) => boolean): R1Gate => {
  let n = 0;
  let detail: string | null = null;
  const env: RuntimePorts = {
    ...inner,
    rename: async (from, to) => {
      if (n === 0 && match(from, to)) {
        n += 1;
        detail = `from=${from} to=${to}`;
        throw new R1BoundaryFault('rename', detail);
      }
      return inner.rename(from, to);
    },
  };
  return { env, fired: () => n, faultDetail: () => detail };
};

const gateFsyncDir = (inner: RuntimePorts, path: string): R1Gate => {
  let n = 0;
  let detail: string | null = null;
  const env: RuntimePorts = {
    ...inner,
    fsyncDir: async (p) => {
      if (n === 0 && p === path) {
        n += 1;
        detail = `path=${p}`;
        throw new R1BoundaryFault('fsyncDir', detail);
      }
      return inner.fsyncDir(p);
    },
  };
  return { env, fired: () => n, faultDetail: () => detail };
};

const gateReadLink = (inner: RuntimePorts, path: string): R1Gate => {
  let n = 0;
  let detail: string | null = null;
  const env: RuntimePorts = {
    ...inner,
    readLink: async (p) => {
      if (p === path) {
        n += 1;
        detail = `path=${p}`;
        throw new R1BoundaryFault('readLink', detail);
      }
      return inner.readLink(p);
    },
  };
  return { env, fired: () => n, faultDetail: () => detail };
};

interface R1Seed {
  skill: string;
  live: string;
  skillsRoot: string;
  ledgerPath: string;
  store: StoreSeed;
  oldTarget: string;
  devSource: string;
  devBytes: string;
  pinned: PinnedRecord;
  seededOrigin: OriginRecord;
  unrelatedSkill: string;
  unrelatedLive: string;
  unrelatedTarget: string;
  unrelatedPinned: PinnedRecord;
  unrelatedOrigin: OriginRecord;
}

const writeCanonicalOrThrow = async (
  env: RuntimePorts,
  ledgerPath: string,
  ledger: LedgerFile,
): Promise<void> => {
  const w = await writeLedger(env, ledgerPath, canonicalFixtureLedger(ledger));
  if (!w.ok) throw new Error(msg(w.error));
};

const seedR1 = async (
  f: FixtureFleet,
  skill: string,
  targetKind: R1TargetKind,
): Promise<R1Seed> => {
  const skillsRoot = join(f.home, '.claude', 'skills');
  const live = join(skillsRoot, skill);
  const s = await seedStore(f, skill);
  const oldTarget = targetKind === 'absolute' ? s.storePath : relative(skillsRoot, s.storePath);
  await f.env.makeSymlink(oldTarget, live);
  const devSource = resolve(f.alphaSrc);
  const devBytes = await f.env.readText(join(devSource, 'SKILL.md'));
  const pinned = pinnedOf(s.storePath, s.rev, s.contentHash, 'symlink');
  const seededOrigin = origin('smorinlabs/fixture-harness/alpha');
  const ledger = emptyLedger(NOW);
  setPair(ledger, skill, 'claude-code', {
    placementPath: live,
    mode: 'pinned',
    dev: dev(devSource),
    pinned,
    origin: seededOrigin,
    journal: null,
  });
  const unrelatedSkill = `${skill}-unrelated`;
  const u = await seedStore(f, unrelatedSkill);
  const unrelatedLive = join(skillsRoot, unrelatedSkill);
  await f.env.makeSymlink(u.storePath, unrelatedLive);
  const unrelatedPinned = pinnedOf(u.storePath, u.rev, u.contentHash, 'symlink');
  const unrelatedOrigin = origin('smorinlabs/fixture-harness/beta');
  setPair(ledger, unrelatedSkill, 'claude-code', {
    placementPath: unrelatedLive,
    mode: 'pinned',
    dev: dev(resolve(f.betaSrc)),
    pinned: unrelatedPinned,
    origin: unrelatedOrigin,
    journal: null,
  });
  await writeCanonicalOrThrow(f.env, ledgerPathOf(f.data), ledger);
  return {
    skill,
    live,
    skillsRoot,
    ledgerPath: ledgerPathOf(f.data),
    store: s,
    oldTarget,
    devSource,
    devBytes,
    pinned,
    seededOrigin,
    unrelatedSkill,
    unrelatedLive,
    unrelatedTarget: u.storePath,
    unrelatedPinned,
    unrelatedOrigin,
  };
};

const assertR1Preconditions = async (f: FixtureFleet, seed: R1Seed): Promise<void> => {
  const placement = await classifyPlacement(
    f.env,
    seed.skillsRoot,
    seed.skill,
    storeRootOf(f.data),
  );
  expect(placement.class).toBe('store-linked');
  expect(placement.symlinkTarget).toBe(seed.oldTarget);
  expect(await f.env.readLink(seed.live)).toBe(seed.oldTarget);
  const h = await contentHashOf(f.env, seed.store.storePath);
  if (!h.ok) throw new Error(msg(h.error));
  expect(h.value).toBe(seed.store.contentHash);
};

const makeR1SwapRequest = (
  env: RuntimePorts,
  ledgerPath: string,
  ledger: LedgerModel,
): SwapRequest => {
  let durableLedger = ledger;
  return {
    context: { env },
    state: { ledger },
    effects: {
      persistLedger: async (candidate) => {
        const written = await writeLedger(env, ledgerPath, candidate);
        if (!written.ok) return { ok: false, error: written.error, ledger: durableLedger };
        durableLedger = candidate;
        return { ok: true, ledger: candidate };
      },
      journalNow: () => NOW,
      newTransactionId: () => nextTxId(),
    },
  };
};

const swapRequestFromDisk = async (env: RuntimePorts, ledgerPath: string): Promise<SwapRequest> => {
  const read = await readLedgerState(env, ledgerPath);
  if (!read.ok) throw new Error(msg(read.error));
  if (read.value.state !== 'present') throw new Error('fixture ledger is absent');
  return makeR1SwapRequest(env, ledgerPath, read.value.model);
};

const residueOf = async (env: RuntimePorts, skillsRoot: string): Promise<string[]> =>
  (await env.listDir(skillsRoot)).filter((n) => n.startsWith('.skillsmith-'));

interface R1BoundarySpec {
  boundary: R1Boundary;
  phase: JournalPhase;
  liveKind: 'symlink' | 'absent';
  liveTarget: 'old' | 'new' | null;
  stagingTarget: 'new' | null;
  backupTarget: 'old' | null;
  interruptText: string;
  // Whether recovery compares the persisted old target. The moved-aside boundary restores via
  // the live-absent branch without any target comparison, so it stays a true positive control
  // even when the journal never recorded the target; the other three lock the persisted literal.
  requiresSavedTarget: boolean;
}

const R1_BOUNDARIES: R1BoundarySpec[] = [
  {
    boundary: 'prepared',
    phase: 'prepared',
    liveKind: 'symlink',
    liveTarget: 'old',
    stagingTarget: null,
    backupTarget: null,
    interruptText: 'cannot stage',
    requiresSavedTarget: true,
  },
  {
    boundary: 'staged',
    phase: 'backed-up',
    liveKind: 'symlink',
    liveTarget: 'old',
    stagingTarget: 'new',
    backupTarget: null,
    interruptText: 'back up',
    requiresSavedTarget: true,
  },
  {
    boundary: 'moved-aside',
    phase: 'live',
    liveKind: 'absent',
    liveTarget: null,
    stagingTarget: 'new',
    backupTarget: 'old',
    interruptText: 'install',
    requiresSavedTarget: false,
  },
  {
    boundary: 'published',
    phase: 'live',
    liveKind: 'symlink',
    liveTarget: 'new',
    stagingTarget: null,
    backupTarget: 'old',
    interruptText: 'cannot fsync',
    requiresSavedTarget: true,
  },
];

const armR1Gate = (f: FixtureFleet, seed: R1Seed, boundary: R1Boundary): R1Gate => {
  const stagingPrefix = `.skillsmith-staging-${seed.skill}-`;
  const backupPrefix = `.skillsmith-backup-${seed.skill}-`;
  switch (boundary) {
    case 'prepared':
      return gateMakeSymlink(f.env, (linkPath) => basename(linkPath).startsWith(stagingPrefix));
    case 'staged':
      return gateRename(
        f.env,
        (from, to) => from === seed.live && basename(to).startsWith(backupPrefix),
      );
    case 'moved-aside':
      return gateRename(
        f.env,
        (from, to) => basename(from).startsWith(stagingPrefix) && to === seed.live,
      );
    case 'published':
      return gateFsyncDir(f.env, seed.skillsRoot);
  }
};

const firstResultOrThrow = (report: { results: FlipResult[] }, verb: string): FlipResult => {
  const r = report.results[0];
  if (!r) throw new Error(`${verb} returned no results`);
  return r;
};

const interruptPublicDev = async (
  f: FixtureFleet,
  skill: string,
  gate: R1Gate,
): Promise<FlipResult> => {
  const res = await runDev(gate.env, opts(f, { targets: [skill] }), passDeps());
  if (!res.ok) throw new Error(`runDev batch failed: ${msg(res.error)}`);
  return firstResultOrThrow(res.value, 'runDev');
};

const interruptDirectDev = async (
  f: FixtureFleet,
  seed: R1Seed,
  gate: R1Gate,
  boundary: R1Boundary,
): Promise<SkillSmithError> => {
  const read = await readLedger(f.env, seed.ledgerPath);
  if (!read.ok) throw new Error(msg(read.error));
  const state = await readLedgerState(f.env, seed.ledgerPath);
  if (!state.ok) throw new Error(msg(state.error));
  if (state.value.state !== 'present') throw new Error('fixture ledger is absent');
  const pair = getPair(read.value, seed.skill, 'claude-code');
  if (!pair?.dev) throw new Error('seed pair dev record missing');
  const plan: SwapPlan = {
    op: 'dev',
    skill: seed.skill,
    tool: 'claude-code',
    skillsRoot: seed.skillsRoot,
    placementPath: seed.live,
    dev: { sourcePath: pair.dev.sourcePath, devRecord: pair.dev },
  };
  const res = await runSwap(makeR1SwapRequest(gate.env, seed.ledgerPath, state.value.model), plan);
  if (res.ok) {
    throw new Error(
      `direct runSwap was not stopped by the one-shot ${boundary} fault (harness failure)`,
    );
  }
  return res.error;
};

const assertR1Interrupted = async (
  f: FixtureFleet,
  seed: R1Seed,
  spec: R1BoundarySpec,
): Promise<{ journal: Journal; savedTarget: string | null }> => {
  const read = await readLedger(f.env, seed.ledgerPath);
  if (!read.ok) throw new Error(msg(read.error));
  const pair = getPair(read.value, seed.skill, 'claude-code');
  const j = pair?.journal;
  if (!j) throw new Error(`no journal on disk after the ${spec.boundary} interruption`);
  expect(j.op).toBe('dev');
  expect(j.phase).toBe(spec.phase);
  expect(j.completedAt).toBeNull();
  if (j.before.mode !== 'pinned') throw new Error(`before mode is ${j.before.mode}, not pinned`);
  expect(j.before.storePath).toBe(seed.store.storePath);
  expect(j.before.contentHash).toBe(seed.store.contentHash);
  expect(j.before.liveKind).toBe('symlink');
  const savedTarget = j.before.symlinkTarget ?? null;
  expect(dirname(j.stagingPath)).toBe(seed.skillsRoot);
  expect(basename(j.stagingPath).startsWith(`.skillsmith-staging-${seed.skill}-`)).toBe(true);
  expect(dirname(j.backupPath)).toBe(seed.skillsRoot);
  expect(basename(j.backupPath).startsWith(`.skillsmith-backup-${seed.skill}-`)).toBe(true);
  expect(pair?.mode).toBe('pinned');
  expect(await f.env.pathKind(seed.live)).toBe(spec.liveKind);
  if (spec.liveTarget === 'old') expect(await f.env.readLink(seed.live)).toBe(seed.oldTarget);
  if (spec.liveTarget === 'new') expect(await f.env.readLink(seed.live)).toBe(seed.devSource);
  if (spec.stagingTarget === null) {
    expect(await f.env.pathKind(j.stagingPath)).toBe('absent');
  } else {
    expect(await f.env.pathKind(j.stagingPath)).toBe('symlink');
    expect(await f.env.readLink(j.stagingPath)).toBe(seed.devSource);
  }
  if (spec.backupTarget === null) {
    expect(await f.env.pathKind(j.backupPath)).toBe('absent');
  } else {
    expect(await f.env.pathKind(j.backupPath)).toBe('symlink');
    expect(await f.env.readLink(j.backupPath)).toBe(seed.oldTarget);
  }
  return { journal: j, savedTarget };
};

const assertOwnedFault = (
  gate: R1Gate,
  spec: R1BoundarySpec,
  seed: R1Seed,
  journal: Journal,
): void => {
  expect(gate.fired()).toBe(1);
  const detail = gate.faultDetail();
  if (detail === null) throw new Error('one-shot fault never recorded its detail');
  switch (spec.boundary) {
    case 'prepared':
      expect(detail).toContain(journal.stagingPath);
      break;
    case 'staged':
      expect(detail).toContain(seed.live);
      expect(detail).toContain(journal.backupPath);
      break;
    case 'moved-aside':
      expect(detail).toContain(journal.stagingPath);
      expect(detail).toContain(seed.live);
      break;
    case 'published':
      expect(detail).toContain(seed.skillsRoot);
      break;
  }
};

const rollbackPublicOrThrow = async (
  f: FixtureFleet,
  seed: R1Seed,
  spec: R1BoundarySpec,
  savedTarget: string | null,
): Promise<void> => {
  // P17's rollback planner independently requires the saved target
  // (placementRollbackOperationFor, plan.ts) and rejects when it is absent, so a rejection here
  // is the public pre-fix RED surface on this line; the engine guard is covered separately.
  let res: Awaited<ReturnType<typeof runRollback>>;
  try {
    res = await runRollback(
      f.env,
      { ...opts(f, { targets: [seed.skill] }), op: 'dev' },
      passDeps(),
    );
  } catch (e) {
    throw new Error(
      `public rollback did not restore after the ${spec.boundary} interruption: ` +
        `rejected with ${e instanceof Error ? e.message : String(e)} ` +
        `savedTarget=${JSON.stringify(savedTarget)}`,
    );
  }
  if (!res.ok) throw new Error(`runRollback batch failed: ${msg(res.error)}`);
  const r = firstResultOrThrow(res.value, 'runRollback');
  if (r.action !== 'rolled-back') {
    throw new Error(
      `public rollback did not restore after the ${spec.boundary} interruption: ` +
        `action=${r.action} reason=${r.reason} ` +
        `error=${r.error ? `${r.error.code}: ${msg(r.error)}` : '<none>'} ` +
        `savedTarget=${JSON.stringify(savedTarget)}`,
    );
  }
};

const rollbackDirectOrThrow = async (
  f: FixtureFleet,
  seed: R1Seed,
  spec: R1BoundarySpec,
  savedTarget: string | null,
): Promise<void> => {
  const request = await swapRequestFromDisk(f.env, seed.ledgerPath);
  const rb = await rollbackSwap(request, seed.skill, 'claude-code');
  if (!rb.ok) {
    throw new Error(
      `direct rollbackSwap did not restore after the ${spec.boundary} interruption: ` +
        `${rb.error.code}: ${msg(rb.error)} savedTarget=${JSON.stringify(savedTarget)}`,
    );
  }
};

const assertR1Restored = async (
  f: FixtureFleet,
  seed: R1Seed,
  spec: R1BoundarySpec,
  savedTarget: string | null,
): Promise<void> => {
  // The journal pre-image captured before recovery carried the literal old target. Only
  // boundaries whose recovery compares the target assert it; moved-aside restores from the
  // backup without any comparison (positive control).
  if (spec.requiresSavedTarget) expect(savedTarget).toBe(seed.oldTarget);
  expect(await f.env.pathKind(seed.live)).toBe('symlink');
  expect(await f.env.readLink(seed.live)).toBe(seed.oldTarget);
  const read = await readLedger(f.env, seed.ledgerPath);
  if (!read.ok) throw new Error(msg(read.error));
  const pair = getPair(read.value, seed.skill, 'claude-code');
  if (!pair) throw new Error('pair missing after rollback');
  expect(pair.mode).toBe('pinned');
  expect(pair.journal ?? null).toBeNull();
  expect(pair.pinned).toEqual(seed.pinned);
  expect(pair.origin).toEqual(seed.seededOrigin);
  expect(pair.dev?.sourcePath).toBe(seed.devSource);
  // Canonical transaction state agrees with the restored filesystem.
  const state = await readLedgerState(f.env, seed.ledgerPath);
  if (!state.ok) throw new Error(msg(state.error));
  if (state.value.state !== 'present') throw new Error('ledger absent after rollback');
  const canonical = getLedgerPairAt(state.value.model, null, seed.skill, 'claude-code');
  expect(canonical?.mode).toBe('pinned');
  expect(canonical?.journal ?? null).toBeNull();
  const h = await contentHashOf(f.env, seed.store.storePath);
  if (!h.ok) throw new Error(msg(h.error));
  expect(h.value).toBe(seed.store.contentHash);
  expect(await f.env.readText(join(seed.devSource, 'SKILL.md'))).toBe(seed.devBytes);
  expect(await residueOf(f.env, seed.skillsRoot)).toEqual([]);
  const u = getPair(read.value, seed.unrelatedSkill, 'claude-code');
  expect(u?.mode).toBe('pinned');
  expect(u?.pinned).toEqual(seed.unrelatedPinned);
  expect(u?.origin).toEqual(seed.unrelatedOrigin);
  expect(u?.journal ?? null).toBeNull();
  expect(await f.env.readLink(seed.unrelatedLive)).toBe(seed.unrelatedTarget);
  expect((await f.env.listDir(f.data)).filter((n) => n.endsWith('.lock'))).toEqual([]);
  // Repeat rollback at the engine level follows existing no-pending-work behavior.
  const again = await rollbackSwap(
    await swapRequestFromDisk(f.env, seed.ledgerPath),
    seed.skill,
    'claude-code',
  );
  expect(again.ok).toBe(false);
  if (again.ok) throw new Error('repeat rollback unexpectedly restored again');
  expect(msg(again.error)).toContain('nothing to roll back');
  expect(await f.env.readLink(seed.live)).toBe(seed.oldTarget);
};

describe('SC-I60-R1 interrupted store-linked dev rollback', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  for (const targetKind of ['absolute', 'relative'] as const) {
    for (const spec of R1_BOUNDARIES) {
      test(`public runRollback after ${spec.boundary} interruption (${targetKind} old target)`, async () => {
        const seed = await seedR1(f, `r1-${spec.boundary}-${targetKind}`, targetKind);
        await assertR1Preconditions(f, seed);
        const gate = armR1Gate(f, seed, spec.boundary);
        const interrupted = await interruptPublicDev(f, seed.skill, gate);
        expect(interrupted.action).toBe('failed');
        expect(interrupted.error?.code).toBe('flip-failed');
        expect(interrupted.reason ?? '').toContain(spec.interruptText);
        const { journal, savedTarget } = await assertR1Interrupted(f, seed, spec);
        assertOwnedFault(gate, spec, seed, journal);
        await rollbackPublicOrThrow(f, seed, spec, savedTarget);
        await assertR1Restored(f, seed, spec, savedTarget);
      });

      test(`direct rollbackSwap after ${spec.boundary} interruption (${targetKind} old target)`, async () => {
        const seed = await seedR1(f, `r1d-${spec.boundary}-${targetKind}`, targetKind);
        await assertR1Preconditions(f, seed);
        const gate = armR1Gate(f, seed, spec.boundary);
        const interruptError = await interruptDirectDev(f, seed, gate, spec.boundary);
        expect(interruptError.code).toBe('flip-failed');
        expect(msg(interruptError)).toContain(spec.interruptText);
        const { journal, savedTarget } = await assertR1Interrupted(f, seed, spec);
        assertOwnedFault(gate, spec, seed, journal);
        await rollbackDirectOrThrow(f, seed, spec, savedTarget);
        await assertR1Restored(f, seed, spec, savedTarget);
      });
    }
  }

  test('directory live -> dev interrupted at the staged boundary rolls back to dir bytes', async () => {
    const skillsRoot = join(f.home, '.claude', 'skills');
    const skill = 'r1-dir-staged';
    const live = join(skillsRoot, skill);
    const s = await seedStore(f, skill);
    await f.env.copyTree(s.storePath, live);
    const devSource = resolve(f.alphaSrc);
    const pinned = pinnedOf(s.storePath, s.rev, s.contentHash, 'copy');
    const seededOrigin = origin('smorinlabs/fixture-harness/alpha');
    const ledger = emptyLedger(NOW);
    setPair(ledger, skill, 'claude-code', {
      placementPath: live,
      mode: 'pinned',
      dev: dev(devSource),
      pinned,
      origin: seededOrigin,
      journal: null,
    });
    await writeCanonicalOrThrow(f.env, ledgerPathOf(f.data), ledger);

    const placement = await classifyPlacement(f.env, skillsRoot, skill, storeRootOf(f.data));
    expect(placement.class).toBe('pinned');
    const backupPrefix = `.skillsmith-backup-${skill}-`;
    const gate = gateRename(
      f.env,
      (from, to) => from === live && basename(to).startsWith(backupPrefix),
    );
    const interrupted = await interruptPublicDev(f, skill, gate);
    expect(gate.fired()).toBe(1);
    expect(interrupted.action).toBe('failed');
    expect(interrupted.reason ?? '').toContain('back up');

    const read = await readLedger(f.env, ledgerPathOf(f.data));
    if (!read.ok) throw new Error(msg(read.error));
    const j = getPair(read.value, skill, 'claude-code')?.journal;
    if (!j) throw new Error('no journal on disk after the staged dir interruption');
    expect(j.op).toBe('dev');
    expect(j.phase).toBe('backed-up');
    if (j.before.mode !== 'pinned') throw new Error('before mode is not pinned');
    expect(j.before.liveKind).toBe('dir');
    expect('symlinkTarget' in j.before).toBe(false);
    expect(await f.env.pathKind(live)).toBe('dir');
    expect(await f.env.pathKind(j.stagingPath)).toBe('symlink');
    expect(await f.env.readLink(j.stagingPath)).toBe(devSource);
    expect(await f.env.pathKind(j.backupPath)).toBe('absent');

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'dev' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(`runRollback batch failed: ${msg(rb.error)}`);
    const r = firstResultOrThrow(rb.value, 'runRollback');
    expect(r.action).toBe('rolled-back');

    expect(await f.env.pathKind(live)).toBe('dir');
    const h = await contentHashOf(f.env, live);
    if (!h.ok) throw new Error(msg(h.error));
    expect(h.value).toBe(s.contentHash);
    const after = await readLedger(f.env, ledgerPathOf(f.data));
    if (!after.ok) throw new Error(msg(after.error));
    const pair = getPair(after.value, skill, 'claude-code');
    expect(pair?.mode).toBe('pinned');
    expect(pair?.journal ?? null).toBeNull();
    expect(pair?.pinned).toEqual(pinned);
    expect(pair?.origin).toEqual(seededOrigin);
    expect(await residueOf(f.env, skillsRoot)).toEqual([]);
  });

  test('directory live -> dev interrupted at the published boundary rolls back to dir bytes', async () => {
    const skillsRoot = join(f.home, '.claude', 'skills');
    const skill = 'r1-dir-published';
    const live = join(skillsRoot, skill);
    const s = await seedStore(f, skill);
    await f.env.copyTree(s.storePath, live);
    const devSource = resolve(f.alphaSrc);
    const pinned = pinnedOf(s.storePath, s.rev, s.contentHash, 'copy');
    const seededOrigin = origin('smorinlabs/fixture-harness/alpha');
    const ledger = emptyLedger(NOW);
    setPair(ledger, skill, 'claude-code', {
      placementPath: live,
      mode: 'pinned',
      dev: dev(devSource),
      pinned,
      origin: seededOrigin,
      journal: null,
    });
    await writeCanonicalOrThrow(f.env, ledgerPathOf(f.data), ledger);

    const placement = await classifyPlacement(f.env, skillsRoot, skill, storeRootOf(f.data));
    expect(placement.class).toBe('pinned');
    const gate = gateFsyncDir(f.env, skillsRoot);
    const interrupted = await interruptPublicDev(f, skill, gate);
    expect(gate.fired()).toBe(1);
    expect(interrupted.action).toBe('failed');
    expect(interrupted.reason ?? '').toContain('cannot fsync');

    const read = await readLedger(f.env, ledgerPathOf(f.data));
    if (!read.ok) throw new Error(msg(read.error));
    const j = getPair(read.value, skill, 'claude-code')?.journal;
    if (!j) throw new Error('no journal on disk after the published dir interruption');
    expect(j.op).toBe('dev');
    expect(j.phase).toBe('live');
    if (j.before.mode !== 'pinned') throw new Error('before mode is not pinned');
    expect(j.before.liveKind).toBe('dir');
    expect(await f.env.pathKind(live)).toBe('symlink');
    expect(await f.env.readLink(live)).toBe(devSource);
    expect(await f.env.pathKind(j.stagingPath)).toBe('absent');
    expect(await f.env.pathKind(j.backupPath)).toBe('dir');

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'dev' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(`runRollback batch failed: ${msg(rb.error)}`);
    const r = firstResultOrThrow(rb.value, 'runRollback');
    expect(r.action).toBe('rolled-back');

    expect(await f.env.pathKind(live)).toBe('dir');
    const h = await contentHashOf(f.env, live);
    if (!h.ok) throw new Error(msg(h.error));
    expect(h.value).toBe(s.contentHash);
    const after = await readLedger(f.env, ledgerPathOf(f.data));
    if (!after.ok) throw new Error(msg(after.error));
    const pair = getPair(after.value, skill, 'claude-code');
    expect(pair?.mode).toBe('pinned');
    expect(pair?.journal ?? null).toBeNull();
    expect(pair?.pinned).toEqual(pinned);
    expect(pair?.origin).toEqual(seededOrigin);
    expect(await residueOf(f.env, skillsRoot)).toEqual([]);
  });

  test('uninterrupted store-linked -> dev succeeds for absolute and relative old targets', async () => {
    for (const targetKind of ['absolute', 'relative'] as const) {
      const seed = await seedR1(f, `r1-clean-${targetKind}`, targetKind);
      await assertR1Preconditions(f, seed);
      const res = await runDev(f.env, opts(f, { targets: [seed.skill] }), passDeps());
      if (!res.ok) throw new Error(msg(res.error));
      const r = firstResultOrThrow(res.value, 'runDev');
      expect(r.action).toBe('flipped');
      expect(await f.env.pathKind(seed.live)).toBe('symlink');
      expect(await f.env.readLink(seed.live)).toBe(seed.devSource);
      const read = await readLedger(f.env, seed.ledgerPath);
      if (!read.ok) throw new Error(msg(read.error));
      const pair = getPair(read.value, seed.skill, 'claude-code');
      expect(pair?.mode).toBe('dev');
      expect(pair?.journal?.phase).toBe('committed');
      expect(pair?.pinned).toEqual(seed.pinned);
      expect(pair?.origin).toEqual(seed.seededOrigin);
    }
    const skillsRoot = join(f.home, '.claude', 'skills');
    expect(await residueOf(f.env, skillsRoot)).toEqual([]);
  });

  test('same-op re-run of an independently interrupted dev completes the flip', async () => {
    const seed = await seedR1(f, 'r1-resume', 'absolute');
    await assertR1Preconditions(f, seed);
    const staged = R1_BOUNDARIES[1];
    if (!staged || staged.boundary !== 'staged') throw new Error('staged spec missing');
    const gate = armR1Gate(f, seed, 'staged');
    const interrupted = await interruptPublicDev(f, seed.skill, gate);
    expect(gate.fired()).toBe(1);
    expect(interrupted.action).toBe('failed');

    const resumed = await runDev(f.env, opts(f, { targets: [seed.skill] }), passDeps());
    if (!resumed.ok) throw new Error(msg(resumed.error));
    const r = firstResultOrThrow(resumed.value, 'runDev');
    expect(r.action).toBe('flipped');
    expect(await f.env.pathKind(seed.live)).toBe('symlink');
    expect(await f.env.readLink(seed.live)).toBe(seed.devSource);
    const read = await readLedger(f.env, seed.ledgerPath);
    if (!read.ok) throw new Error(msg(read.error));
    const pair = getPair(read.value, seed.skill, 'claude-code');
    expect(pair?.mode).toBe('dev');
    expect(pair?.journal?.phase).toBe('committed');
    expect(pair?.journal?.completedAt).not.toBeNull();
    expect(pair?.pinned).toEqual(seed.pinned);
    expect(pair?.origin).toEqual(seed.seededOrigin);
    expect(await residueOf(f.env, seed.skillsRoot)).toEqual([]);
    const u = getPair(read.value, seed.unrelatedSkill, 'claude-code');
    expect(u?.mode).toBe('pinned');
    expect(u?.pinned).toEqual(seed.unrelatedPinned);
    expect(await f.env.readLink(seed.unrelatedLive)).toBe(seed.unrelatedTarget);
  });

  test('legacy dev journal without the saved target stays fail-closed', async () => {
    const seed = await seedR1(f, 'r1-legacy', 'absolute');
    await assertR1Preconditions(f, seed);
    // Deliberately constructed malformed historical state: a pre-fix dev journal whose
    // before-state never recorded the literal old target. Allowed only for this control.
    const legacyJournal: Journal = {
      op: 'dev',
      txId: 'deadbeef',
      phase: 'live',
      startedAt: NOW,
      completedAt: null,
      before: {
        mode: 'pinned',
        storePath: seed.store.storePath,
        contentHash: seed.store.contentHash,
        liveKind: 'symlink',
      },
      stagingPath: join(seed.skillsRoot, `.skillsmith-staging-${seed.skill}-deadbeef`),
      backupPath: join(seed.skillsRoot, `.skillsmith-backup-${seed.skill}-deadbeef`),
    };
    const legacyLedger = emptyLedger(NOW);
    setPair(legacyLedger, seed.skill, 'claude-code', {
      placementPath: seed.live,
      mode: 'pinned',
      dev: dev(seed.devSource),
      pinned: seed.pinned,
      origin: seed.seededOrigin,
      journal: legacyJournal,
    });
    setPair(legacyLedger, seed.unrelatedSkill, 'claude-code', {
      placementPath: seed.unrelatedLive,
      mode: 'pinned',
      dev: dev(resolve(f.betaSrc)),
      pinned: seed.unrelatedPinned,
      origin: seed.unrelatedOrigin,
      journal: null,
    });
    await writeCanonicalOrThrow(f.env, seed.ledgerPath, legacyLedger);
    await f.env.removeTree(seed.live);
    await f.env.makeSymlink(seed.devSource, seed.live);
    await f.env.makeSymlink(seed.oldTarget, legacyJournal.backupPath);

    // P17's public surface rejects in the rollback planner (placementRollbackOperationFor
    // requires the saved target); the engine guard below is the second fail-closed layer.
    let rejection: unknown = null;
    try {
      await runRollback(f.env, { ...opts(f, { targets: [seed.skill] }), op: 'dev' }, passDeps());
    } catch (e) {
      rejection = e;
    }
    expect(rejection instanceof Error ? rejection.message : String(rejection)).toContain(
      'pinned rollback symlink target is incomplete',
    );

    const direct = await rollbackSwap(
      await swapRequestFromDisk(f.env, seed.ledgerPath),
      seed.skill,
      'claude-code',
    );
    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error('direct rollbackSwap unexpectedly restored a legacy journal');
    expect(msg(direct.error)).toContain('missing its target');

    expect(await f.env.readLink(seed.live)).toBe(seed.devSource);
    expect(await f.env.readLink(legacyJournal.backupPath)).toBe(seed.oldTarget);
    expect(await f.env.pathKind(legacyJournal.stagingPath)).toBe('absent');
    const read = await readLedger(f.env, seed.ledgerPath);
    if (!read.ok) throw new Error(msg(read.error));
    const pair = getPair(read.value, seed.skill, 'claude-code');
    expect(pair?.mode).toBe('pinned');
    expect(pair?.journal?.phase).toBe('live');
    expect(pair?.pinned).toEqual(seed.pinned);
    const u = getPair(read.value, seed.unrelatedSkill, 'claude-code');
    expect(u?.mode).toBe('pinned');
    expect(u?.pinned).toEqual(seed.unrelatedPinned);
    expect(await f.env.readLink(seed.unrelatedLive)).toBe(seed.unrelatedTarget);
  });

  test('readLink failure before journaling leaves state unchanged with the mapped error', async () => {
    const seed = await seedR1(f, 'r1-readlink', 'absolute');
    await assertR1Preconditions(f, seed);
    const gate = gateReadLink(f.env, seed.live);
    const read = await readLedger(f.env, seed.ledgerPath);
    if (!read.ok) throw new Error(msg(read.error));
    const state = await readLedgerState(f.env, seed.ledgerPath);
    if (!state.ok) throw new Error(msg(state.error));
    if (state.value.state !== 'present') throw new Error('fixture ledger is absent');
    const pair = getPair(read.value, seed.skill, 'claude-code');
    if (!pair?.dev) throw new Error('seed pair dev record missing');
    const plan: SwapPlan = {
      op: 'dev',
      skill: seed.skill,
      tool: 'claude-code',
      skillsRoot: seed.skillsRoot,
      placementPath: seed.live,
      dev: { sourcePath: pair.dev.sourcePath, devRecord: pair.dev },
    };
    const res = await runSwap(
      makeR1SwapRequest(gate.env, seed.ledgerPath, state.value.model),
      plan,
    );
    if (res.ok) {
      throw new Error(
        'the readLink fault did not stop the swap before journaling: direct runSwap committed',
      );
    }
    expect(gate.fired()).toBeGreaterThanOrEqual(1);
    expect(res.error.code).toBe('flip-failed');
    expect(msg(res.error)).toContain(`cannot read live symlink for ${seed.skill}`);

    const after = await readLedger(f.env, seed.ledgerPath);
    if (!after.ok) throw new Error(msg(after.error));
    const afterPair = getPair(after.value, seed.skill, 'claude-code');
    expect(afterPair?.journal ?? null).toBeNull();
    expect(afterPair?.mode).toBe('pinned');
    expect(afterPair?.dev).toEqual(pair.dev);
    expect(afterPair?.pinned).toEqual(seed.pinned);
    expect(await f.env.readLink(seed.live)).toBe(seed.oldTarget);
    const h = await contentHashOf(f.env, seed.store.storePath);
    if (!h.ok) throw new Error(msg(h.error));
    expect(h.value).toBe(seed.store.contentHash);
    expect(await residueOf(f.env, seed.skillsRoot)).toEqual([]);
  });
});
