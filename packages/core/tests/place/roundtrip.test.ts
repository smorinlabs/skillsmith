import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join, resolve } from 'node:path';
import type { ScanEnv } from '../../src/env/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPair, readLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { LEGACY_ROOT_NOTICE } from '../../src/place/plan.ts';
import { runDev, runPromote } from '../../src/place/run.ts';
import { contentHashOf } from '../../src/place/store.ts';
import type { FlipDeps, FlipOptions } from '../../src/place/types.ts';
import type { Result } from '../../src/result.ts';
import { ok } from '../../src/result.ts';
import type { VerifyOptions } from '../../src/verify/run.ts';
import type { SummaryVerdict, VerifyReport, VerifyTool } from '../../src/verify/types.ts';
import { hermeticGitEnv } from '../fixtures/git-env.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

// This file's tests each build a fixture fleet (real `git init`) and often run several full
// flips (each resolving provenance via real `git` subprocess calls) — the 5s bun:test default
// can be tight when the whole suite runs under load.
setDefaultTimeout(20_000);

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
// canned verify checkers (P11 fake-checker pattern) — a capturing wrapper records
// (path, tools, deep) per call; each gate returns a minimal VerifyReport literal.
// -------------------------------------------------------------------------------------------

interface GateCall {
  path: string;
  tools: readonly VerifyTool[] | undefined;
  deep: boolean | undefined;
}

const minimalVerifyReport = (tool: VerifyTool, verdict: SummaryVerdict): VerifyReport => ({
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
  tools: [
    {
      tool,
      available: true,
      toolVersion: '1.0.0',
      versionDrift: false,
      skipReason: verdict === 'inconclusive' ? 'exec-error' : null,
      verdict,
      modes: [],
    },
  ],
});

let txCounter = 0;
const nextTxId = (): string => (++txCounter).toString(16).padStart(8, '0');

const makeGate = (verdict: SummaryVerdict, calls: GateCall[] = []): FlipDeps => ({
  now: () => '2026-07-07T00:00:00Z',
  newTxId: nextTxId,
  verify: async (_env: ScanEnv, o: VerifyOptions) => {
    calls.push({ path: o.path, tools: o.tools, deep: o.deep });
    const tool = o.tools?.[0] ?? 'claude-code';
    return ok(minimalVerifyReport(tool, verdict)) as Result<VerifyReport, SkillSmithError>;
  },
});

const gatePass = (calls: GateCall[] = []): FlipDeps => makeGate('pass', calls);
const gateWarn = (calls: GateCall[] = []): FlipDeps => makeGate('warn', calls);
const gateFail = (calls: GateCall[] = []): FlipDeps => makeGate('fail', calls);
const gateInconclusive = (calls: GateCall[] = []): FlipDeps => makeGate('inconclusive', calls);

const opts = (f: FixtureFleet, o: Partial<FlipOptions> = {}): FlipOptions => ({
  targets: [],
  cwd: f.home,
  envVars: f.envVars,
  ...o,
});

const readLedgerOf = async (f: FixtureFleet) => readLedger(f.env, ledgerPathOf(f.data));

// =============================================================================================
// Losslessness (the acceptance)
// =============================================================================================

describe('round-trip losslessness', () => {
  test('dev -> promote -> dev restores the original literal target byte-identically; re-promote reuses the store', async () => {
    const f = await buildFixtureFleet();
    try {
      const livePath = join(f.home, '.claude', 'skills', 'alpha');
      const originalTarget = await f.env.readLink(livePath);

      const up = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gatePass());
      if (!up.ok) throw new Error(msg(up.error));
      expect(up.value.results[0]?.action).toBe('flipped');
      expect(await f.env.pathKind(livePath)).toBe('dir');

      const down = await runDev(f.env, opts(f, { targets: ['alpha'] }), gatePass());
      if (!down.ok) throw new Error(msg(down.error));
      expect(down.value.results[0]?.action).toBe('flipped');
      expect(await f.env.readLink(livePath)).toBe(originalTarget);

      const ledgerRes = await readLedgerOf(f);
      if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
      const pair = getPair(ledgerRes.value, 'alpha', 'claude-code');
      if (!pair?.dev || !pair.pinned) throw new Error('expected both dev and pinned records');
      const storePath = pair.pinned.storePath;
      expect(await f.env.pathKind(storePath)).not.toBe('absent');
      const h = await contentHashOf(f.env, storePath);
      if (!h.ok) throw new Error(msg(h.error));
      expect(h.value).toBe(pair.pinned.contentHash);

      const again = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gatePass());
      if (!again.ok) throw new Error(msg(again.error));
      const result = again.value.results[0];
      expect(result?.action).toBe('flipped');
      expect(result?.store?.reused).toBe(true);
      expect(result?.store?.rev).toBe(up.value.results[0]?.store?.rev);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('adoption of an unmanaged symlink: zero prior ledger derives sourcePath and remote from the live link', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gatePass());
      if (!r.ok) throw new Error(msg(r.error));
      const ledgerRes = await readLedgerOf(f);
      if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
      const pair = getPair(ledgerRes.value, 'alpha', 'claude-code');
      expect(pair?.dev?.sourcePath).toBe(resolve(f.alphaSrc));
      expect(pair?.dev?.remote).toBe('smorinlabs/fixture-harness');
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('adoption of a hand-copied dir: no --source refused; --source flips and preserves the old copy as a backup', async () => {
    const f = await buildFixtureFleet();
    try {
      const refused = await runDev(f.env, opts(f, { targets: ['copied'] }), gatePass());
      if (!refused.ok) throw new Error(msg(refused.error));
      const refusedResult = refused.value.results[0];
      expect(refusedResult?.action).toBe('refused');
      expect(refusedResult?.reason).toContain('--source');

      const adopted = await runDev(
        f.env,
        opts(f, { targets: ['copied'], source: resolve(f.betaSrc) }),
        gatePass(),
      );
      if (!adopted.ok) throw new Error(msg(adopted.error));
      const result = adopted.value.results[0];
      expect(result?.action).toBe('flipped');
      expect(result?.after).toEqual({ mode: 'dev', symlinkTarget: resolve(f.betaSrc) });
      expect(result?.reason).toBeTruthy(); // carries the "backup kept" warning

      const copiedPath = join(f.home, '.claude', 'skills', 'copied');
      expect(await f.env.pathKind(copiedPath)).toBe('symlink');
      expect(await f.env.readLink(copiedPath)).toBe(resolve(f.betaSrc));

      const skillsRoot = join(f.home, '.claude', 'skills');
      const entries = await f.env.listDir(skillsRoot);
      const backupName = entries.find((n) => n.startsWith('.skillsmith-backup-copied-'));
      expect(backupName).toBeDefined();
      if (backupName) expect(await f.env.pathKind(join(skillsRoot, backupName))).toBe('dir');
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('dirty-git refusal: promote is refused naming the porcelain line; --allow-dirty snapshots dirty-<hash12>; dev round-trip stays byte-identical', async () => {
    const f = await buildFixtureFleet();
    try {
      const livePath = join(f.home, '.claude', 'skills', 'alpha');
      const originalTarget = await f.env.readLink(livePath);
      await f.makeCheckoutDirty();

      const refused = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gatePass());
      if (!refused.ok) throw new Error(msg(refused.error));
      const refusedResult = refused.value.results[0];
      expect(refusedResult?.action).toBe('refused');
      expect(refusedResult?.reason).toContain('SKILL.md'); // the porcelain status line

      const allowed = await runPromote(
        f.env,
        opts(f, { targets: ['alpha'], allowDirty: true }),
        gatePass(),
      );
      if (!allowed.ok) throw new Error(msg(allowed.error));
      const result = allowed.value.results[0];
      expect(result?.action).toBe('flipped');
      expect(result?.store?.rev).toMatch(/^dirty-[0-9a-f]{12}$/);
      expect(result?.store?.dirty).toBe(true);

      const ledgerRes = await readLedgerOf(f);
      if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
      const pair = getPair(ledgerRes.value, 'alpha', 'claude-code');
      expect(pair?.pinned?.dirty).toBe(true);
      expect(pair?.pinned?.gitSha).toMatch(/^[0-9a-f]{40}$/);

      const down = await runDev(f.env, opts(f, { targets: ['alpha'] }), gatePass());
      if (!down.ok) throw new Error(msg(down.error));
      expect(await f.env.readLink(livePath)).toBe(originalTarget);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('non-git content-hash path: gamma promotes to store/local/gamma@content-<hash12> (deep gate); demote restores the literal link', async () => {
    const f = await buildFixtureFleet();
    try {
      const livePath = join(f.home, '.codex', 'skills', 'gamma');
      const originalTarget = await f.env.readLink(livePath);
      const calls: GateCall[] = [];

      const r = await runPromote(
        f.env,
        opts(f, { targets: ['gamma'], tools: ['codex'] }),
        gatePass(calls),
      );
      if (!r.ok) throw new Error(msg(r.error));
      const result = r.value.results[0];
      expect(result?.action).toBe('flipped');
      expect(result?.store?.rev).toMatch(/^content-[0-9a-f]{12}$/);
      expect(result?.store?.path).toContain(join('local', `gamma@${result?.store?.rev}`, 'gamma'));
      expect(calls[0]?.deep).toBe(true);

      const down = await runDev(
        f.env,
        opts(f, { targets: ['gamma'], tools: ['codex'] }),
        gatePass(),
      );
      if (!down.ok) throw new Error(msg(down.error));
      expect(await f.env.readLink(livePath)).toBe(originalTarget);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('duplicate-skill refusal: dup is refused (both roots named) while another target in the batch still flips', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(f.env, opts(f, { targets: ['dup', 'gamma'] }), gatePass());
      if (!r.ok) throw new Error(msg(r.error));
      const dupResult = r.value.results.find((res) => res.skill === 'dup');
      expect(dupResult?.action).toBe('refused');
      expect(dupResult?.error?.code).toBe('flip-refused'); // exit contribution 2
      expect(dupResult?.reason).toContain('.agents/skills');
      expect(dupResult?.reason).toContain('.codex/skills');

      const gammaResult = r.value.results.find((res) => res.skill === 'gamma');
      expect(gammaResult?.action).toBe('flipped');

      const ledgerRes = await readLedgerOf(f);
      if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
      const dupPair = getPair(ledgerRes.value, 'dup', 'codex');
      expect(dupPair === null || dupPair.journal === null).toBe(true);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('codex legacy-only flip: flips in place in the legacy root; nothing created under ~/.agents/skills', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(f.env, opts(f, { targets: ['legacy-only'] }), gatePass());
      if (!r.ok) throw new Error(msg(r.error));
      const result = r.value.results[0];
      expect(result?.action).toBe('flipped');
      expect(result?.reason).toContain(LEGACY_ROOT_NOTICE);
      const legacyPath = join(f.home, '.codex', 'skills', 'legacy-only');
      expect(await f.env.pathKind(legacyPath)).toBe('dir');
      expect(await f.env.pathKind(join(f.home, '.agents', 'skills', 'legacy-only'))).toBe('absent');
    } finally {
      await destroyFixtureFleet(f);
    }
  });
});

// =============================================================================================
// Gate matrix at e2e level
// =============================================================================================

describe('gate matrix at e2e level', () => {
  test('gateFail: failed, placement untouched, ledger unchanged (no pair recorded)', async () => {
    const f = await buildFixtureFleet();
    try {
      const livePath = join(f.home, '.claude', 'skills', 'alpha');
      const originalTarget = await f.env.readLink(livePath);
      const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gateFail());
      if (!r.ok) throw new Error(msg(r.error));
      const result = r.value.results[0];
      expect(result?.action).toBe('failed');
      expect(await f.env.pathKind(livePath)).toBe('symlink');
      expect(await f.env.readLink(livePath)).toBe(originalTarget);
      // The gate check short-circuits before any pair is ever written to the ledger — the
      // lock-acquisition step still creates the ledger file (empty), but no pair is recorded.
      const ledgerRes = await readLedgerOf(f);
      if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
      expect(getPair(ledgerRes.value, 'alpha', 'claude-code')).toBeNull();
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('gateWarn + --strict: failed', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(f.env, opts(f, { targets: ['alpha'], strict: true }), gateWarn());
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('failed');
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('gateWarn default: flipped, ledger verify warned', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gateWarn());
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('flipped');
      expect(r.value.results[0]?.verify?.gate).toBe('warned');
      const ledgerRes = await readLedgerOf(f);
      if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
      expect(getPair(ledgerRes.value, 'alpha', 'claude-code')?.pinned?.verify).toBe('warned');
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('gateInconclusive default: flipped, ledger verify skipped, result gate inconclusive', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gateInconclusive());
      if (!r.ok) throw new Error(msg(r.error));
      const result = r.value.results[0];
      expect(result?.action).toBe('flipped');
      expect(result?.verify?.gate).toBe('inconclusive');
      const ledgerRes = await readLedgerOf(f);
      if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
      expect(getPair(ledgerRes.value, 'alpha', 'claude-code')?.pinned?.verify).toBe('skipped');
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('--no-verify: checker never called, ledger verify skipped', async () => {
    const f = await buildFixtureFleet();
    try {
      const calls: GateCall[] = [];
      const r = await runPromote(
        f.env,
        opts(f, { targets: ['alpha'], noVerify: true }),
        gatePass(calls),
      );
      if (!r.ok) throw new Error(msg(r.error));
      expect(calls).toHaveLength(0);
      expect(r.value.results[0]?.action).toBe('flipped');
      expect(r.value.results[0]?.verify?.gate).toBe('skipped');
      const ledgerRes = await readLedgerOf(f);
      if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
      expect(getPair(ledgerRes.value, 'alpha', 'claude-code')?.pinned?.verify).toBe('skipped');
    } finally {
      await destroyFixtureFleet(f);
    }
  });
});

// =============================================================================================
// Seam-based crash test: the re-pin double-swap boundary (T04 review addition A)
// =============================================================================================

describe('re-pin double-swap boundary', () => {
  test('a crash between the interim dev swap and the promote swap is safely resumable', async () => {
    const f = await buildFixtureFleet();
    try {
      const livePath = join(f.home, '.claude', 'skills', 'alpha');
      const originalTarget = await f.env.readLink(livePath);

      const first = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gatePass());
      if (!first.ok) throw new Error(msg(first.error));
      const firstRev = first.value.results[0]?.store?.rev;

      commitChange(
        f.checkout,
        'plugins/fh/skills/alpha/SKILL.md',
        '---\nname: alpha\ndescription: v2.\n---\n',
      );
      commitAll(f.checkout, 'fixture: alpha v2');

      // A re-pin (source moved while already pinned) runs an interim, fully-committed `dev`
      // swap (restoring the symlink) then a fresh `promote` swap, as one function call but two
      // independently-committed swaps (run.ts ~339-359). `pauseAt`/`signal` cannot represent a
      // crash strictly BETWEEN them: pausing inside swap 1 leaves it uncommitted (fails
      // "committed dev"); pausing inside swap 2, at ANY phase, already has a persisted
      // uncommitted journal by the time a phase check runs (runSwap persists the 'prepared'
      // journal before its first pauseAt/signal check) — fails "no uncommitted journal". The
      // only zero-journal boundary is before swap 2's runSwap is even invoked, i.e. inside the
      // store snapshot that runs between the two swaps. `copyTree` is used by that snapshot
      // (and by a promote swap's own staging, never reached here) but never by a `dev` swap, so
      // gating the first `copyTree` call lands the crash exactly in that gap — after swap 1
      // has committed and before swap 2 starts.
      let copyTreeCalls = 0;
      const crashEnv: ScanEnv = {
        ...f.env,
        copyTree: async (from, to) => {
          copyTreeCalls += 1;
          if (copyTreeCalls === 1) {
            throw new Error('simulated crash: process died writing the re-pin store snapshot');
          }
          return f.env.copyTree(from, to);
        },
      };

      const crashed = await runPromote(crashEnv, opts(f, { targets: ['alpha'] }), gatePass());
      if (!crashed.ok) throw new Error(msg(crashed.error));
      expect(crashed.value.results[0]?.action).toBe('failed');

      // Intermediate ("crashed") state: a legal, fully committed dev placement — no swap
      // in flight, byte-identical to the original literal target.
      const midLedger = await readLedgerOf(f);
      if (!midLedger.ok) throw new Error(msg(midLedger.error));
      const midPair = getPair(midLedger.value, 'alpha', 'claude-code');
      expect(midPair?.mode).toBe('dev');
      expect(midPair?.journal === null || midPair?.journal?.phase === 'committed').toBe(true);
      expect(await f.env.pathKind(livePath)).toBe('symlink');
      expect(await f.env.readLink(livePath)).toBe(originalTarget);

      // Re-running the same promote (real env, no crash injected) converges to the pinned
      // end state with the new rev.
      const recovered = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gatePass());
      if (!recovered.ok) throw new Error(msg(recovered.error));
      const result = recovered.value.results[0];
      expect(result?.action).toBe('flipped');
      expect(result?.store?.rev).not.toBe(firstRev);
      expect(await f.env.pathKind(livePath)).toBe('dir');
    } finally {
      await destroyFixtureFleet(f);
    }
  });
});
