import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SkillSmithError } from '../../src/errors.ts';
import { emptyLedger, getPair, readLedger, setPair, writeLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { runDev, runPromote, runRollback } from '../../src/place/run.ts';
import type {
  DevRecord,
  FlipDeps,
  FlipOptions,
  Journal,
  OriginRecord,
  PairRecord,
  PinnedRecord,
} from '../../src/place/types.ts';
import type { Result } from '../../src/result.ts';
import { ok } from '../../src/result.ts';
import type { VerifyOptions } from '../../src/verify/run.ts';
import type {
  ModeResult,
  ToolVerdict,
  VerifyOutcome,
  VerifyReport,
  VerifyTool,
} from '../../src/verify/types.ts';
import { hermeticGitEnv } from '../fixtures/git-env.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

// This file's tests each build a fixture fleet (real `git init`) and often run 2-3 full flips
// (each resolving provenance via real `git` subprocess calls) — the 5s bun:test default can be
// tight when the whole suite runs under load.
setDefaultTimeout(20_000);

const NOW = '2026-07-07T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

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

// -------------------------------------------------------------------------------------------
// canned verify checker fixtures
// -------------------------------------------------------------------------------------------

const makeVerifyReport = (
  tool: VerifyTool,
  verdict: VerifyOutcome | 'inconclusive',
): VerifyReport => {
  const mode: ModeResult =
    verdict === 'inconclusive'
      ? {
          mode: 'static',
          status: 'error',
          skipReason: 'exec-error',
          coverage: { manifest: false, skills: false },
          verdict: null,
          command: 'fake',
          findings: [],
        }
      : {
          mode: 'static',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict,
          command: 'fake',
          findings:
            verdict === 'fail'
              ? [
                  {
                    checkId: 'fake.check',
                    toolSeverity: 'error',
                    normalizedSeverity: 'error' as const,
                    message: 'boom',
                    file: null,
                    subject: 'skill' as const,
                  },
                ]
              : [],
        };
  const toolVerdict: ToolVerdict = {
    tool,
    available: true,
    toolVersion: '1.0.0',
    versionDrift: false,
    skipReason: verdict === 'inconclusive' ? 'exec-error' : null,
    verdict,
    modes: [mode],
  };
  return {
    schemaVersion: 1,
    target: { path: '/fake', kind: 'skill' },
    requested: { tools: [tool], modes: ['static'], strict: false, explicitTools: true },
    verifiedAgainst: { 'claude-code': '1.0.0', codex: '1.0.0' },
    summary: {
      verdict,
      verified: verdict === 'pass' || verdict === 'warn' ? [tool] : [],
      failed: verdict === 'fail' ? [tool] : [],
      skipped: verdict === 'inconclusive' ? [tool] : [],
      counts: { error: verdict === 'fail' ? 1 : 0, warning: 0, info: 0 },
    },
    tools: [toolVerdict],
  };
};

// Each call needs a distinct txId — a constant one collides staging/backup names across
// multiple sequential flips of the same (skill, tool) pair within one test (a kept backup
// from an earlier flip would otherwise already occupy the next flip's backup path).
let txCounter = 0;
const nextTxId = (): string => (++txCounter).toString(16).padStart(8, '0');

const cannedDeps = (
  verdict: VerifyOutcome | 'inconclusive',
  calls: VerifyOptions[] = [],
): FlipDeps => ({
  now: () => NOW,
  newTxId: nextTxId,
  verify: async (_env, opts: VerifyOptions) => {
    calls.push(opts);
    const tool = opts.tools?.[0] ?? 'claude-code';
    return ok(makeVerifyReport(tool, verdict)) as Result<VerifyReport, SkillSmithError>;
  },
});

const passDeps = (calls: VerifyOptions[] = []): FlipDeps => cannedDeps('pass', calls);

const opts = (f: FixtureFleet, o: Partial<FlipOptions> = {}): FlipOptions => ({
  targets: [],
  cwd: f.home,
  configuration: f.configuration,
  ...o,
});

const readLedgerOf = async (f: FixtureFleet) => readLedger(f.env, ledgerPathOf(f.data));

describe('runPromote / runDev — verify gate matrix', () => {
  const VERDICTS: (VerifyOutcome | 'inconclusive')[] = ['pass', 'warn', 'fail', 'inconclusive'];
  const MODES: { label: string; flags: Partial<FlipOptions> }[] = [
    { label: 'default', flags: {} },
    { label: '--strict', flags: { strict: true } },
    { label: '--no-verify', flags: { noVerify: true } },
  ];

  for (const verdict of VERDICTS) {
    for (const mode of MODES) {
      test(`verdict=${verdict} mode=${mode.label}`, async () => {
        const f = await buildFixtureFleet();
        try {
          const calls: VerifyOptions[] = [];
          const deps = mode.flags.noVerify ? passDeps(calls) : cannedDeps(verdict, calls);
          const r = await runPromote(f.env, opts(f, { targets: ['alpha'], ...mode.flags }), deps);
          if (!r.ok) throw new Error(msg(r.error));
          const result = r.value.results[0];
          if (!result) throw new Error('no result');

          if (mode.flags.noVerify) {
            expect(calls).toHaveLength(0);
            expect(result.action).toBe('flipped');
            expect(result.verify?.gate).toBe('skipped');
            return;
          }

          expect(calls).toHaveLength(1);
          if (verdict === 'fail') {
            expect(result.action).toBe('failed');
            expect(result.error).toBeDefined();
          } else if (verdict === 'warn') {
            if (mode.flags.strict) {
              expect(result.action).toBe('failed');
            } else {
              expect(result.action).toBe('flipped');
              expect(result.verify?.gate).toBe('warned');
            }
          } else if (verdict === 'inconclusive') {
            if (mode.flags.strict) {
              expect(result.action).toBe('failed');
            } else {
              expect(result.action).toBe('flipped');
              expect(result.verify?.gate).toBe('inconclusive');
            }
          } else {
            expect(result.action).toBe('flipped');
            expect(result.verify?.gate).toBe('passed');
          }
        } finally {
          await destroyFixtureFleet(f);
        }
      });
    }
  }

  test('codex gate is called with deep:true; claude-code gate is called without deep', async () => {
    const f = await buildFixtureFleet();
    try {
      const calls: VerifyOptions[] = [];
      const r = await runPromote(f.env, opts(f, { targets: ['alpha', 'beta'] }), passDeps(calls));
      if (!r.ok) throw new Error(msg(r.error));
      const claudeCall = calls.find((c) => c.tools?.[0] === 'claude-code');
      const codexCall = calls.find((c) => c.tools?.[0] === 'codex');
      expect(claudeCall?.deep).toBeFalsy();
      expect(codexCall?.deep).toBe(true);
    } finally {
      await destroyFixtureFleet(f);
    }
  });
});

describe('runPromote — happy paths and convergence', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('promote alpha: flipped, ledger mode pinned, dev retained, verify passed', async () => {
    const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.verify?.gate).toBe('passed');

    const ledgerRes = await readLedgerOf(f);
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    const pair = getPair(ledgerRes.value, 'alpha', 'claude-code');
    expect(pair?.mode).toBe('pinned');
    expect(pair?.dev).not.toBeNull();
    expect(pair?.pinned?.verify).toBe('passed');
  });

  test('re-pin after source moves: action updated, new rev', async () => {
    const first = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!first.ok) throw new Error(msg(first.error));
    const firstRev = first.value.results[0]?.store?.rev;

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
    expect(result?.store?.rev).not.toBe(firstRev);
  });

  test('noop when unchanged', async () => {
    const first = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!first.ok) throw new Error(msg(first.error));
    const second = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!second.ok) throw new Error(msg(second.error));
    expect(second.value.results[0]?.action).toBe('noop');
  });

  test('dirty tree refused without --allow-dirty; --allow-dirty snapshots dirty-<hash12>', async () => {
    await f.makeCheckoutDirty();
    const refused = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!refused.ok) throw new Error(msg(refused.error));
    expect(refused.value.results[0]?.action).toBe('refused');

    const allowed = await runPromote(
      f.env,
      opts(f, { targets: ['alpha'], allowDirty: true }),
      passDeps(),
    );
    if (!allowed.ok) throw new Error(msg(allowed.error));
    const result = allowed.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.store?.rev).toMatch(/^dirty-[0-9a-f]{12}$/);
    expect(result?.store?.gitSha).not.toBeNull();
    expect(result?.store?.dirty).toBe(true);
  });

  test('non-git gamma promote: local/gamma@content-<hash12>', async () => {
    const r = await runPromote(
      f.env,
      opts(f, { targets: ['gamma'], tools: ['codex'] }),
      passDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.store?.rev).toMatch(/^content-[0-9a-f]{12}$/);
    expect(result?.store?.path).toContain(join('local', `gamma@${result?.store?.rev}`));
  });
});

describe('runDev — happy paths, --source adoption, missing source', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('dev happy path: literal symlink restored, pinned retained', async () => {
    const up = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!up.ok) throw new Error(msg(up.error));

    const down = await runDev(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!down.ok) throw new Error(msg(down.error));
    const result = down.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.after).toEqual({ mode: 'dev', symlinkTarget: resolve(f.alphaSrc) });

    const ledgerRes = await readLedgerOf(f);
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    const pair = getPair(ledgerRes.value, 'alpha', 'claude-code');
    expect(pair?.mode).toBe('dev');
    expect(pair?.pinned).not.toBeNull();
  });

  test('dev --source adopts the hand-copied "copied" dir', async () => {
    const r = await runDev(
      f.env,
      opts(f, { targets: ['copied'], source: resolve(f.alphaSrc) }),
      passDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.after).toEqual({ mode: 'dev', symlinkTarget: resolve(f.alphaSrc) });
  });

  // P13 S5b (approved behavior change from P12): a --source that disagrees with the RECORDED dev
  // source now REFUSES rather than silently repointing the record (was: --source wins & updates).
  test('--source disagreeing with the recorded source is refused (P13 S5b)', async () => {
    const adopted = await runDev(
      f.env,
      opts(f, { targets: ['copied'], source: resolve(f.alphaSrc) }),
      passDeps(),
    );
    if (!adopted.ok) throw new Error(msg(adopted.error));
    const pinned = await runPromote(f.env, opts(f, { targets: ['copied'] }), passDeps());
    if (!pinned.ok) throw new Error(msg(pinned.error));

    const redirected = await runDev(
      f.env,
      opts(f, { targets: ['copied'], source: resolve(f.betaSrc) }),
      passDeps(),
    );
    if (!redirected.ok) throw new Error(msg(redirected.error));
    const result = redirected.value.results[0];
    expect(result?.action).toBe('refused');
    expect(result?.error?.code).toBe('flip-refused');
  });

  test('missing recorded dev source -> source-unresolvable error on the pair', async () => {
    const pinned = await runPromote(
      f.env,
      opts(f, { targets: ['gamma'], tools: ['codex'] }),
      passDeps(),
    );
    if (!pinned.ok) throw new Error(msg(pinned.error));
    await rm(f.gammaSrc, { recursive: true, force: true });

    const r = await runDev(f.env, opts(f, { targets: ['gamma'], tools: ['codex'] }), passDeps());
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('refused');
    expect(result?.error?.code).toBe('source-unresolvable');
  });
});

describe('runRollback', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('rollback of a committed promote restores the dev symlink', async () => {
    const up = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!up.ok) throw new Error(msg(up.error));

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: ['alpha'] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expect(await f.env.pathKind(join(f.home, '.claude', 'skills', 'alpha'))).toBe('symlink');
  });

  test('rollback with nothing to roll back -> refused', async () => {
    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: ['beta'] }), op: 'dev' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('refused');
    expect(result?.reason).toContain('nothing to roll back');
  });

  // P15 / issue #11: end-to-end, `promote --rollback --all` and `dev --rollback --all` must roll
  // back the identical set (spec D10). Mixed-state fleet: (a) alpha@claude-code demoted back to dev
  // with its pin retained (last committed op = dev), (b) beta@codex promoted (last committed op =
  // promote), (c) gamma@codex a fresh dev-only symlink with no ledger record. Only (a) and (b) are
  // rollbackable; (c) is untouched by both verbs.
  test('--rollback --all selects the same rollbackable set for both verbs (P15, issue #11)', async () => {
    const up = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!up.ok) throw new Error(msg(up.error));
    const down = await runDev(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!down.ok) throw new Error(msg(down.error));
    const upBeta = await runPromote(
      f.env,
      opts(f, { targets: ['beta'], tools: ['codex'] }),
      passDeps(),
    );
    if (!upBeta.ok) throw new Error(msg(upBeta.error));

    const rolledBack = (r: Awaited<ReturnType<typeof runRollback>>): string[] => {
      if (!r.ok) throw new Error(msg(r.error));
      return r.value.results
        .filter((res) => res.action === 'rolled-back')
        .map((res) => `${res.skill}@${res.tool}`)
        .sort();
    };

    const asPromote = await runRollback(
      f.env,
      { ...opts(f, { all: true, dryRun: true }), op: 'promote' },
      passDeps(),
    );
    const asDev = await runRollback(
      f.env,
      { ...opts(f, { all: true, dryRun: true }), op: 'dev' },
      passDeps(),
    );

    expect(rolledBack(asPromote)).toEqual(rolledBack(asDev));
    expect(rolledBack(asPromote)).toEqual(['alpha@claude-code', 'beta@codex']);
    expect(rolledBack(asPromote)).not.toContain('gamma@codex');
  });
});

// -------------------------------------------------------------------------------------------
// I2: flip-rollback of an interrupted install must warn when it leaves a stale rev on the pair
// -------------------------------------------------------------------------------------------

describe('runRollback — interrupted install-replace reconciliation warning (I2)', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  const devOf = (sourcePath: string): DevRecord => ({
    sourcePath,
    resolvedPath: sourcePath,
    repoRoot: null,
    sourceRelPath: null,
    remote: null,
    recordedAt: NOW,
  });

  const originOf = (skill: string): OriginRecord => ({
    source: `smorinlabs/fixture-harness/${skill}`,
    host: 'github.com',
    repo: 'smorinlabs/fixture-harness',
    skillPath: `plugins/fh/skills/${skill}`,
    refRequested: null,
    refResolved: 'b'.repeat(40),
    pin: false,
    installedAt: NOW,
  });

  const pinnedOf = (storePath: string, rev: string): PinnedRecord => ({
    storePath,
    rev,
    gitSha: null,
    dirty: false,
    contentHash: `sha256:${'0'.repeat(64)}`,
    snapshotAt: NOW,
    verify: 'passed',
    placement: 'symlink',
  });

  const seedJournaledPair = async (
    skill: string,
    journal: Journal,
    pair: Omit<PairRecord, 'journal'>,
  ): Promise<string> => {
    const ledgerPath = ledgerPathOf(f.data);
    const ledger = emptyLedger(NOW);
    setPair(ledger, skill, 'claude-code', { ...pair, journal });
    const w = await writeLedger(f.env, ledgerPath, ledger);
    if (!w.ok) throw new Error(msg(w.error));
    return ledgerPath;
  };

  test('RED->GREEN: replace-install rollback (before.mode pinned) surfaces the reconcile warning', async () => {
    const skill = 'zeta-replace';
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, skill);
    // Old placement bytes still on disk (P1/P2 done, P3/P4 not — mirrors the 'staged' crash phase).
    await f.env.makeDir(live);

    const journal: Journal = {
      op: 'install',
      txId: 'aaaa1111',
      phase: 'staged',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'pinned', storePath: null, contentHash: null, liveKind: 'dir' },
      stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-aaaa1111`),
      backupPath: join(skillsRoot, `.skillsmith-backup-${skill}-aaaa1111`),
    };
    await seedJournaledPair(skill, journal, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf('/fake/store/o/r@newrev000000/zeta', 'newrev000000'),
      origin: originOf(skill),
    });

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expect(result?.reason).toContain('reconcile');
    expect(result?.reason).toContain('ledger');
    expect(result?.reason).toContain('skillsmith install');

    // The old placement bytes are restored/preserved (the engine already did this part right).
    expect(await f.env.pathKind(live)).toBe('dir');
    const ledgerRes = await readLedger(f.env, ledgerPathOf(f.data));
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    const pair = getPair(ledgerRes.value, skill, 'claude-code');
    expect(pair?.journal).toBeNull();
    expect(pair?.mode).toBe('pinned');
  });

  test('negative: fresh-install rollback (before.mode absent) does NOT surface the reconcile warning', async () => {
    const skill = 'zeta-fresh';
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, skill);
    // The half-installed NEW artifact — a fresh install has nothing to restore to.
    await f.env.makeDir(live);

    const journal: Journal = {
      op: 'install',
      txId: 'bbbb2222',
      phase: 'staged',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'absent' },
      stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-bbbb2222`),
      backupPath: join(skillsRoot, `.skillsmith-backup-${skill}-bbbb2222`),
    };
    await seedJournaledPair(skill, journal, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf('/fake/store/o/r@newrev000000/zeta', 'newrev000000'),
      origin: originOf(skill),
    });

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expect(result?.reason ?? '').not.toContain('reconcile');

    // Fresh install rollback deletes the pair entirely (coherent — nothing left to reconcile).
    expect(await f.env.pathKind(live)).toBe('absent');
    const ledgerRes = await readLedger(f.env, ledgerPathOf(f.data));
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    expect(getPair(ledgerRes.value, skill, 'claude-code')).toBeNull();
  });

  test('negative: uninstall-journal rollback does NOT surface the reconcile warning', async () => {
    const skill = 'zeta-uninstall';
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, skill);
    const backupPath = join(skillsRoot, `.skillsmith-backup-${skill}-cccc3333`);
    // Committed-live-removed, backup still holding the old bytes (mirrors 'backed-up' phase).
    await f.env.makeDir(backupPath);

    const journal: Journal = {
      op: 'uninstall',
      txId: 'cccc3333',
      phase: 'backed-up',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'pinned', storePath: null, contentHash: null, liveKind: 'dir' },
      stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-cccc3333`),
      backupPath,
    };
    await seedJournaledPair(skill, journal, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf('/fake/store/o/r@oldrev000000/zeta', 'oldrev000000'),
      origin: originOf(skill),
    });

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expect(result?.reason ?? '').not.toContain('reconcile');
  });

  test('negative: interrupted promote-journal rollback does NOT surface the reconcile warning', async () => {
    const skill = 'zeta-promote';
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, skill);
    const target = resolve(f.alphaSrc);
    // Live still the old dev symlink — the promote journal never got past 'staged'.
    await f.env.makeSymlink(target, live);

    const journal: Journal = {
      op: 'promote',
      txId: 'dddd4444',
      phase: 'staged',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'dev', symlinkTarget: target, liveKind: 'symlink' },
      stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-dddd4444`),
      backupPath: join(skillsRoot, `.skillsmith-backup-${skill}-dddd4444`),
    };
    await seedJournaledPair(skill, journal, {
      placementPath: live,
      mode: 'dev',
      dev: devOf(target),
      pinned: null,
    });

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expect(result?.reason ?? '').not.toContain('reconcile');
  });
});

describe('dry-run', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('writes nothing (ledger absent afterwards) and takes no lock', async () => {
    const r = await runPromote(f.env, opts(f, { targets: ['alpha'], dryRun: true }), passDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.dryRun).toBe(true);
    expect(r.value.results[0]?.action).toBe('flipped');
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
  });
});
