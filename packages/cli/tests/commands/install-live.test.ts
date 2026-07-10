import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../core/tests/fixtures/acquire/remote.ts';
import {
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';

// SIGKILL leaves the ledger's `proper-lockfile` mkdir-lock directory behind (the killed process
// never reaches its `finally { release() }`); the lock's own `stale: 30_000` option (env/default.ts)
// is purely mtime-based (no dead-PID detection), so a fresh CLI invocation right after the kill
// would spend its retry budget failing with "another skillsmith operation is running" rather than
// waiting out 30+ real seconds per test. We've just confirmed the child is gone (`proc.exited`), so
// clearing its orphaned lock directory ourselves is a faithful stand-in for that staleness sweep —
// mirrors P12's flip-live.test.ts exactly (D17: proper-lockfile's 30s staleness is the vetted path,
// not something to "improve" here). R2: the ledger lock targets `placements.json` directly
// (realpath:false, no materialization), so proper-lockfile's mkdir-lock directory is `placements.json.lock`.
const clearOrphanedLock = async (ledgerPath: string): Promise<void> => {
  await rm(`${ledgerPath}.lock`, { recursive: true, force: true });
};

// Env-gated interrupted-swap process e2e — extends the P12 `flip-live.test.ts` harness to the
// acquisition verbs (install/uninstall). CI never sets SKILLSMITH_E2E and its runners don't have
// this repo checked out as a workstation copy anyway, so this suite reports as skipped and
// `bun run check` stays green. Run locally:
// `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/install-live.test.ts`
const E2E = process.env.SKILLSMITH_E2E === '1';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const BIN = 'packages/cli/src/index.ts';
const SKILL = 'factor-scan';

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

// Minimal ad-hoc shape of placements.json, read directly (not through core's ledger reader) per
// the P12 precedent — mirrors polling a real process from outside rather than reaching into core.
interface LedgerJsonShape {
  skills?: Record<
    string,
    {
      tools?: Record<
        string,
        {
          journal?: { phase: string } | null;
          pinned?: { storePath?: string } | null;
        }
      >;
    }
  >;
}

const readLedgerJson = async (ledgerPath: string): Promise<LedgerJsonShape | null> => {
  if (!existsSync(ledgerPath)) return null;
  try {
    return JSON.parse(await readFile(ledgerPath, 'utf8')) as LedgerJsonShape;
  } catch {
    return null; // mid-write (the ledger writer renames a tmp file into place); retry
  }
};

const skillJournal = (raw: LedgerJsonShape | null): { phase: string } | null | undefined =>
  raw?.skills?.[SKILL]?.tools?.['claude-code']?.journal;

const skillJournalPhase = (raw: LedgerJsonShape | null): string | null | undefined =>
  skillJournal(raw)?.phase;

const skillPinnedStorePath = (raw: LedgerJsonShape | null): string | undefined =>
  raw?.skills?.[SKILL]?.tools?.['claude-code']?.pinned?.storePath;

const waitForPhase = async (
  ledgerPath: string,
  phase: string,
  timeoutMs = 15_000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await readLedgerJson(ledgerPath);
    if (skillJournalPhase(raw) === phase) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for journal phase '${phase}' at ${ledgerPath}`);
};

const spawnCli = (args: string[], env: Record<string, string>) =>
  Bun.spawn(['bun', BIN, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  } as const);

const run = async (
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = spawnCli(args, env);
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

/** Fails with the full process transcript, not just a bare exit-code mismatch. */
const requireExit = (
  r: { stdout: string; stderr: string; code: number },
  expected: number,
  label: string,
): void => {
  if (r.code !== expected) {
    throw new Error(
      `${label}: expected exit ${expected}, got ${r.code}\n` +
        `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
};

describe.skipIf(!E2E)('skillsmith install/uninstall live e2e (real process SIGKILL)', () => {
  test('SIGKILL a fresh install at the live phase, then a same-op re-run: converges (no partial live artifact, no orphaned lock beyond staleness)', async () => {
    const fixture = await buildRemoteFixture();
    const f = await buildFixtureFleet();
    try {
      const fsSource = `${fixture.multiUrl}//plugins/fh/skills/factor-scan`;
      const livePath = join(f.home, '.claude', 'skills', SKILL);
      const skillsRoot = join(f.home, '.claude', 'skills');
      const ledgerPath = join(f.data, 'placements.json');

      const proc = spawnCli(
        ['install', fsSource, '--tool', 'claude-code', '--no-verify', '--user'],
        {
          HOME: f.home,
          SKILLSMITH_HOME: f.data,
          SKILLSMITH_E2E: '1',
          SKILLSMITH_TEST_PAUSE_AT: 'live',
        },
      );
      try {
        await waitForPhase(ledgerPath, 'live');
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
        await clearOrphanedLock(ledgerPath);
      }

      // Crashed state: a FRESH install starts with the live slot empty, so the P4 rename
      // (staging -> live) is the only thing that can ever populate it; the write-ahead persist
      // of phase 'live' happens strictly before that rename, so a kill caught at exactly this
      // phase leaves live absent (never a half-written placement). `.skillsmith-staging-*`
      // residue proves the swap really reached staging.
      const liveKind = await kindOf(livePath);
      expect(['absent', 'symlink']).toContain(liveKind);
      if (liveKind === 'absent') {
        const names = await residueNames(skillsRoot);
        expect(names.some((n) => n.startsWith(`.skillsmith-staging-${SKILL}-`))).toBe(true);
      }
      const raw = await readLedgerJson(ledgerPath);
      expect(skillJournalPhase(raw)).toBe('live');
      const storePath = skillPinnedStorePath(raw);
      if (!storePath) throw new Error('expected a pinned storePath recorded on the journaled pair');
      // The store snapshot completes (atomic rename) BEFORE the swap/journal even starts, so it
      // is unconditionally intact regardless of where the swap itself got interrupted.
      expect(await kindOf(storePath)).toBe('dir');

      // Recovery A: re-run the SAME install (no pause var) -> converges to a committed install.
      const rerun = await run(
        ['install', fsSource, '--tool', 'claude-code', '--no-verify', '--user'],
        {
          HOME: f.home,
          SKILLSMITH_HOME: f.data,
          SKILLSMITH_E2E: '1',
        },
      );
      requireExit(rerun, 0, 'install (re-run)');
      expect(await kindOf(livePath)).toBe('symlink');
      const rawAfter = await readLedgerJson(ledgerPath);
      // A fresh install's terminal write NULLS the journal directly (no committed-at-rest
      // record, unlike a plain promote/dev flip) — Global Constraint 12: resume means "residue
      // reclaimed", never a brand-new success independent of the crashed transaction.
      expect(skillJournal(rawAfter)).toBeNull();
      expect(await residueNames(skillsRoot)).toEqual([]);
    } finally {
      await destroyFixtureFleet(f);
      await destroyRemoteFixture(fixture);
    }
  }, 120_000);

  test('SIGKILL a fresh install at the live phase, then `promote --rollback factor-scan`: placement ABSENT again, pair gone', async () => {
    const fixture = await buildRemoteFixture();
    const f = await buildFixtureFleet();
    try {
      const fsSource = `${fixture.multiUrl}//plugins/fh/skills/factor-scan`;
      const livePath = join(f.home, '.claude', 'skills', SKILL);
      const skillsRoot = join(f.home, '.claude', 'skills');
      const ledgerPath = join(f.data, 'placements.json');

      const proc = spawnCli(
        ['install', fsSource, '--tool', 'claude-code', '--no-verify', '--user'],
        {
          HOME: f.home,
          SKILLSMITH_HOME: f.data,
          SKILLSMITH_E2E: '1',
          SKILLSMITH_TEST_PAUSE_AT: 'live',
        },
      );
      try {
        await waitForPhase(ledgerPath, 'live');
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
        await clearOrphanedLock(ledgerPath);
      }
      expect(skillJournalPhase(await readLedgerJson(ledgerPath))).toBe('live');

      // Recovery B: `promote --rollback` reaches the journaled pair regardless of the journal's
      // own op (F1) — a fresh-install rollback restores "nothing there".
      const rb = await run(['promote', '--rollback', SKILL], {
        HOME: f.home,
        SKILLSMITH_HOME: f.data,
        SKILLSMITH_E2E: '1',
      });
      requireExit(rb, 0, 'promote --rollback factor-scan');
      expect(await kindOf(livePath)).toBe('absent');
      const rawAfter = await readLedgerJson(ledgerPath);
      expect(rawAfter?.skills?.[SKILL]).toBeUndefined(); // the pair itself is gone
      expect(await residueNames(skillsRoot)).toEqual([]);
    } finally {
      await destroyFixtureFleet(f);
      await destroyRemoteFixture(fixture);
    }
  }, 120_000);

  test('seed a completed install, SIGKILL an uninstall at backed-up, re-run uninstall: pair gone, store intact', async () => {
    const fixture = await buildRemoteFixture();
    const f = await buildFixtureFleet();
    try {
      const fsSource = `${fixture.multiUrl}//plugins/fh/skills/factor-scan`;
      const livePath = join(f.home, '.claude', 'skills', SKILL);
      const skillsRoot = join(f.home, '.claude', 'skills');
      const ledgerPath = join(f.data, 'placements.json');

      const seed = await run(
        ['install', fsSource, '--tool', 'claude-code', '--no-verify', '--user'],
        {
          HOME: f.home,
          SKILLSMITH_HOME: f.data,
          SKILLSMITH_E2E: '1',
        },
      );
      requireExit(seed, 0, 'seed install');
      expect(await kindOf(livePath)).toBe('symlink');
      const storePath = skillPinnedStorePath(await readLedgerJson(ledgerPath));
      if (!storePath) throw new Error('expected a seeded pinned storePath');

      const proc = spawnCli(['uninstall', SKILL, '--tool', 'claude-code', '--user'], {
        HOME: f.home,
        SKILLSMITH_HOME: f.data,
        SKILLSMITH_E2E: '1',
        SKILLSMITH_TEST_PAUSE_AT: 'backed-up',
      });
      try {
        await waitForPhase(ledgerPath, 'backed-up');
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
        await clearOrphanedLock(ledgerPath);
      }

      // Crash window: uninstall has no staging/publish phase, only the P3 backup rename — the
      // live path is either still the old symlink (killed before the rename) or already moved
      // into the backup (killed just after), same two-way hedge P12's flip-live.test.ts uses
      // for its own 'backed-up' pause point.
      const liveKind = await kindOf(livePath);
      expect(['symlink', 'absent']).toContain(liveKind);
      if (liveKind === 'absent') {
        const names = await residueNames(skillsRoot);
        expect(names.some((n) => n.startsWith(`.skillsmith-backup-${SKILL}-`))).toBe(true);
      }

      // Lock note (D17): the orphaned lock frees via proper-lockfile's 30s mtime staleness; we
      // clear it ourselves above purely so this test doesn't spend 30+ real seconds waiting —
      // the `stale` setting itself (env/default.ts) is untouched.
      const rerun = await run(['uninstall', SKILL, '--tool', 'claude-code', '--user'], {
        HOME: f.home,
        SKILLSMITH_HOME: f.data,
        SKILLSMITH_E2E: '1',
      });
      requireExit(rerun, 0, 'uninstall (re-run)');
      expect(await kindOf(livePath)).toBe('absent');
      const rawAfter = await readLedgerJson(ledgerPath);
      expect(rawAfter?.skills?.[SKILL]).toBeUndefined(); // pair gone
      expect(await kindOf(storePath)).toBe('dir'); // store retained (immortal)
      expect(await residueNames(skillsRoot)).toEqual([]);
    } finally {
      await destroyFixtureFleet(f);
      await destroyRemoteFixture(fixture);
    }
  }, 120_000);
});
