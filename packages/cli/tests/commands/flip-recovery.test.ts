import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FlipDeps, FlipOptions, RuntimePorts, SkillSmithError } from '@skillsmith/core';
import { resolveRuntimeConfiguration, runDev, runPromote, runRollback } from '@skillsmith/core';
import type { LedgerWriterBarrier } from '../../../core/src/artifacts/ledger-writer.ts';
import { getPair, readLedger, readLedgerState } from '../../../core/src/place/ledger.ts';
import { ledgerPathOf, resolveDataDir } from '../../../core/src/place/paths.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';
import { flipExitCode } from '../../src/util/flip-exit.ts';

// Real `git init` provenance runs a git subprocess per promote — the 5s default is tight under load.
setDefaultTimeout(20_000);

const NOW = '2026-07-07T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const passDeps = (): FlipDeps => ({
  now: () => NOW,
  newTxId: (() => {
    let n = 0;
    return () => (++n).toString(16).padStart(8, '0');
  })(),
  verify: async (_env, o) => ({
    ok: true,
    value: {
      schemaVersion: 1,
      target: { path: o.path, kind: 'skill' },
      requested: {
        tools: o.tools ? [...o.tools] : ['claude-code'],
        modes: ['static'],
        strict: false,
        explicitTools: true,
      },
      verifiedAgainst: { 'claude-code': '1.0.0', codex: '1.0.0', muse: '1.0.0' },
      summary: {
        verdict: 'pass',
        verified: o.tools ? [...o.tools] : ['claude-code'],
        failed: [],
        skipped: [],
        counts: { error: 0, warning: 0, info: 0 },
      },
      tools: (o.tools ?? ['claude-code']).map((tool) => ({
        tool,
        available: true,
        toolVersion: '1.0.0',
        versionDrift: false,
        skipReason: null,
        verdict: 'pass' as const,
        modes: [],
      })),
    },
  }),
});

const opts = (f: FixtureFleet, o: Partial<FlipOptions> = {}): FlipOptions => ({
  targets: [],
  cwd: f.home,
  configuration: resolveRuntimeConfiguration(f.envVars),
  ...o,
});

// Fault-inject the P4 (staging -> live) rename — the last step of a journaled swap. The rename to
// the live placement path throws, leaving the pair mid-crash: live path ABSENT (P3 moved it to the
// backup), staging present, and an uncommitted journal at phase 'live'. This is the exact state F1
// stranded: classifyPlacement returns 'absent', so pre-fix planning dropped the pair from every
// route. Only the live-install rename is faulted; the ledger's own renames (tmp -> placements.json)
// and store renames have different destinations and pass through untouched.
const crashOnInstall = (env: RuntimePorts, livePath: string): RuntimePorts => ({
  ...env,
  rename: async (src: string, dst: string): Promise<void> => {
    if (dst === livePath) throw new Error('injected crash: P4 install rename');
    return env.rename(src, dst);
  },
});

type PathKind = 'symlink' | 'dir' | 'file' | 'absent';
const kindOf = async (p: string): Promise<PathKind> => {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isDirectory()) return 'dir';
    return 'file';
  } catch {
    return 'absent';
  }
};

const residueNames = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((n) => n.startsWith('.skillsmith-'));

const journalPhaseOf = async (
  f: FixtureFleet,
  skill: string,
): Promise<string | null | undefined> => {
  const ledgerPath = ledgerPathOf(resolveDataDir(f.env, resolveRuntimeConfiguration(f.envVars)));
  const l = await readLedger(f.env, ledgerPath);
  if (!l.ok) throw new Error(msg(l.error));
  return getPair(l.value, skill, 'claude-code')?.journal?.phase;
};

const expectCanonicalRollbackFinal = async (
  f: FixtureFleet,
  skill: string,
  transactionId: string,
): Promise<void> => {
  const ledgerPath = ledgerPathOf(resolveDataDir(f.env, resolveRuntimeConfiguration(f.envVars)));
  const state = await readLedgerState(f.env, ledgerPath);
  if (!state.ok || state.value.state !== 'present') {
    throw new Error('canonical rollback ledger is absent');
  }
  expect(state.value.model.transactions).toEqual({});
  const committed = state.value.model.history.find(
    (journal) => journal.transactionId === transactionId,
  );
  expect(committed).toMatchObject({
    transactionId,
    disposition: 'rollback',
    phase: 'committed',
  });
  expect(committed?.actual.after).toEqual(committed?.actual.before);
  expect(state.value.model.skills[skill]?.tools['claude-code']?.journal).toBeNull();
};

// Drive a swap into the absent-live crash window and return the (still-present) old live target so
// callers can assert byte-identical restoration. `oldTarget` is the literal symlink value when the
// pre-swap live entry was a symlink (a dev placement), else null (a pinned dir). `seed` runs first
// (e.g. a full promote before a dev crash); the crash itself always faults the P4 rename.
const crashAtInstall = async (
  f: FixtureFleet,
  driver: 'promote' | 'dev',
  seed?: (f: FixtureFleet) => Promise<void>,
): Promise<{
  livePath: string;
  skillsRoot: string;
  oldTarget: string | null;
  transactionId: string;
}> => {
  const skillsRoot = join(f.home, '.claude', 'skills');
  const livePath = join(skillsRoot, 'alpha');
  const oldTarget = (await kindOf(livePath)) === 'symlink' ? await readlink(livePath) : null;
  if (seed) await seed(f);

  const crashEnv = crashOnInstall(f.env, livePath);
  const run = driver === 'promote' ? runPromote : runDev;
  const r = await run(crashEnv, opts(f, { targets: ['alpha'] }), passDeps());
  if (!r.ok) throw new Error(`crash setup failed at plan level: ${msg(r.error)}`);
  expect(r.value.results[0]?.action).toBe('failed');

  // The crash window is real: live gone, backup holds the old artifact, journal uncommitted at P4.
  expect(await kindOf(livePath)).toBe('absent');
  expect((await residueNames(skillsRoot)).some((n) => n.startsWith('.skillsmith-backup-'))).toBe(
    true,
  );
  expect(await journalPhaseOf(f, 'alpha')).toBe('live');
  const ledgerPath = ledgerPathOf(resolveDataDir(f.env, resolveRuntimeConfiguration(f.envVars)));
  const state = await readLedgerState(f.env, ledgerPath);
  if (!state.ok || state.value.state !== 'present') {
    throw new Error('crashed canonical ledger is absent');
  }
  const transactions = Object.values(state.value.model.transactions);
  expect(transactions).toHaveLength(1);
  const transactionId = transactions[0]?.transactionId;
  if (transactionId === undefined) throw new Error('crashed logical transaction is missing');
  return { livePath, skillsRoot, oldTarget, transactionId };
};

const promoteFully = async (f: FixtureFleet): Promise<void> => {
  const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
  if (!r.ok) throw new Error(msg(r.error));
  expect(r.value.results[0]?.action).toBe('flipped');
};

describe('F1: an absent-live journaled pair is reachable by every recovery route', () => {
  describe('promote crash (P4 rename faulted)', () => {
    test('named --rollback restores the dev symlink byte-identically', async () => {
      const f = await buildFixtureFleet();
      try {
        const { livePath, skillsRoot, oldTarget, transactionId } = await crashAtInstall(
          f,
          'promote',
        );

        const rb = await runRollback(
          f.env,
          { ...opts(f, { targets: ['alpha'] }), op: 'promote' },
          passDeps(),
        );
        if (!rb.ok) throw new Error(msg(rb.error));
        expect(rb.value.results[0]?.action).toBe('rolled-back');
        expect(flipExitCode(rb.value)).toBe(0);

        if (oldTarget === null) throw new Error('expected a symlink live entry before the crash');
        expect(await readlink(livePath)).toBe(oldTarget);
        expect(await journalPhaseOf(f, 'alpha')).toBeUndefined();
        expect(await residueNames(skillsRoot)).toEqual([]);
        await expectCanonicalRollbackFinal(f, 'alpha', transactionId);
      } finally {
        await destroyFixtureFleet(f);
      }
    });

    test('--all --rollback reaches the same absent-live pair', async () => {
      const f = await buildFixtureFleet();
      try {
        const { livePath, oldTarget, transactionId } = await crashAtInstall(f, 'promote');

        const rb = await runRollback(
          f.env,
          { ...opts(f, { all: true }), op: 'promote' },
          passDeps(),
        );
        if (!rb.ok) throw new Error(msg(rb.error));
        // Other fleet pairs (beta, gamma, ...) have nothing to roll back and refuse — the batch
        // exit code is theirs (max rule). What F1 guarantees is that alpha is REACHED and healed.
        const alpha = rb.value.results.find((res) => res.skill === 'alpha');
        expect(alpha?.action).toBe('rolled-back');
        if (oldTarget === null) throw new Error('expected a symlink live entry before the crash');
        expect(await readlink(livePath)).toBe(oldTarget);
        expect(await journalPhaseOf(f, 'alpha')).toBeUndefined();
        await expectCanonicalRollbackFinal(f, 'alpha', transactionId);
      } finally {
        await destroyFixtureFleet(f);
      }
    });

    test('same-op re-run converges to the pinned copy (journal committed)', async () => {
      const f = await buildFixtureFleet();
      try {
        const { livePath } = await crashAtInstall(f, 'promote');

        const rerun = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
        if (!rerun.ok) throw new Error(msg(rerun.error));
        expect(rerun.value.results[0]?.action).toBe('flipped');
        expect(flipExitCode(rerun.value)).toBe(0);
        expect(await kindOf(livePath)).toBe('dir');
        expect(await journalPhaseOf(f, 'alpha')).toBe('committed');
      } finally {
        await destroyFixtureFleet(f);
      }
    });

    test('rollback resumes after its durable direction boundary is interrupted', async () => {
      const f = await buildFixtureFleet();
      try {
        const { livePath, oldTarget, transactionId } = await crashAtInstall(f, 'promote');
        let liveParentFsyncs = 0;
        const boundaryEnv = {
          ...f.env,
          afterLedgerBarrier: async ({ kind }: LedgerWriterBarrier) => {
            if (kind !== 'writer-live-parent-fsync') return;
            liveParentFsyncs += 1;
            if (liveParentFsyncs !== 2) return;
            throw Object.assign(new Error('injected rollback boundary interruption'), {
              code: 'cancelled',
            });
          },
        };

        const interrupted = await runRollback(
          boundaryEnv,
          { ...opts(f, { targets: ['alpha'] }), op: 'promote' },
          passDeps(),
        );
        if (!interrupted.ok) throw new Error(msg(interrupted.error));
        expect(liveParentFsyncs).toBe(2);
        expect(interrupted.value.results[0]?.action).not.toBe('rolled-back');
        expect(await kindOf(livePath)).toBe('absent');

        const ledgerPath = ledgerPathOf(
          resolveDataDir(f.env, resolveRuntimeConfiguration(f.envVars)),
        );
        const boundary = await readLedgerState(f.env, ledgerPath);
        if (!boundary.ok || boundary.value.state !== 'present') {
          throw new Error('durable rollback boundary ledger is absent');
        }
        expect(Object.values(boundary.value.model.transactions)).toContainEqual(
          expect.objectContaining({ disposition: 'rollback', phase: 'prepared' }),
        );

        const resumed = await runRollback(
          f.env,
          { ...opts(f, { targets: ['alpha'] }), op: 'promote' },
          passDeps(),
        );
        if (!resumed.ok) throw new Error(msg(resumed.error));
        expect(resumed.value.results[0]?.action).toBe('rolled-back');
        if (oldTarget === null) throw new Error('expected a symlink live entry before the crash');
        expect(await readlink(livePath)).toBe(oldTarget);
        expect(await journalPhaseOf(f, 'alpha')).toBeUndefined();
        await expectCanonicalRollbackFinal(f, 'alpha', transactionId);
      } finally {
        await destroyFixtureFleet(f);
      }
    });
  });

  describe('dev crash (P4 rename faulted, after a full promote)', () => {
    test('named --rollback restores the pinned copy', async () => {
      const f = await buildFixtureFleet();
      try {
        const { livePath, skillsRoot, transactionId } = await crashAtInstall(
          f,
          'dev',
          promoteFully,
        );

        const rb = await runRollback(
          f.env,
          { ...opts(f, { targets: ['alpha'] }), op: 'dev' },
          passDeps(),
        );
        if (!rb.ok) throw new Error(msg(rb.error));
        expect(rb.value.results[0]?.action).toBe('rolled-back');
        expect(flipExitCode(rb.value)).toBe(0);
        expect(await kindOf(livePath)).toBe('dir');
        expect(await journalPhaseOf(f, 'alpha')).toBeUndefined();
        expect(await residueNames(skillsRoot)).toEqual([]);
        await expectCanonicalRollbackFinal(f, 'alpha', transactionId);
      } finally {
        await destroyFixtureFleet(f);
      }
    });

    test('--all --rollback reaches it; same-op re-run then converges to the dev symlink', async () => {
      const f = await buildFixtureFleet();
      try {
        const { livePath, transactionId } = await crashAtInstall(f, 'dev', promoteFully);
        const devSource = resolve(f.alphaSrc); // the adopted dev source recorded at promote time

        const rb = await runRollback(f.env, { ...opts(f, { all: true }), op: 'dev' }, passDeps());
        if (!rb.ok) throw new Error(msg(rb.error));
        // As above: sibling pinned pairs (dup, copied) refuse/skip — alpha's reachability is the
        // regression under test, not the whole-fleet exit code.
        expect(rb.value.results.find((res) => res.skill === 'alpha')?.action).toBe('rolled-back');
        expect(await kindOf(livePath)).toBe('dir');
        expect(await journalPhaseOf(f, 'alpha')).toBeUndefined();
        await expectCanonicalRollbackFinal(f, 'alpha', transactionId);

        // Re-crash (live is now the restored pinned dir) and let a plain `dev` re-run drive the
        // interrupted swap forward to committed.
        await crashAtInstall(f, 'dev');
        const rerun = await runDev(f.env, opts(f, { targets: ['alpha'] }), passDeps());
        if (!rerun.ok) throw new Error(msg(rerun.error));
        expect(rerun.value.results[0]?.action).toBe('flipped');
        expect(flipExitCode(rerun.value)).toBe(0);
        expect(await kindOf(livePath)).toBe('symlink');
        expect(await readlink(livePath)).toBe(devSource);
      } finally {
        await destroyFixtureFleet(f);
      }
    });
  });
});
