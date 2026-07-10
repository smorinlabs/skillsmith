import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';

// SIGKILL leaves the ledger's `proper-lockfile` mkdir-lock directory behind (the killed process
// never reaches its `finally { release() }`); the lock's own `stale: 30_000` option (env/default.ts)
// is purely mtime-based (no dead-PID detection), so a fresh CLI invocation right after the kill
// would spend its retry budget failing with "another skillsmith operation is running" rather than
// waiting out 30+ real seconds per test. We've just confirmed the child is gone (`proc.exited`), so
// clearing its orphaned lock directory ourselves is a faithful stand-in for that staleness sweep.
// BF-7a: the ledger lock now lives on a SIDECAR (`placements.json.lock`) so a gate failure never
// materializes `placements.json`; proper-lockfile's mkdir-lock directory is therefore
// `placements.json.lock.lock`.
const clearOrphanedLock = async (ledgerPath: string): Promise<void> => {
  await rm(`${ledgerPath}.lock.lock`, { recursive: true, force: true });
};

// Env-gated interrupted-swap process e2e — the one case worth running against a real process,
// because it proves the journal survives REAL process death (SIGKILL), not a simulated throw.
// CI never sets SKILLSMITH_E2E and its runners don't have this repo checked out as a workstation
// copy anyway, so this suite reports as skipped and `bun run check` stays green. Run locally:
// `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/flip-live.test.ts`
const E2E = process.env.SKILLSMITH_E2E === '1';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const BIN = 'packages/cli/src/index.ts';

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
// the brief — mirrors polling a real process from outside rather than reaching into core.
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

const alphaJournal = (raw: LedgerJsonShape | null): { phase: string } | null | undefined =>
  raw?.skills?.alpha?.tools?.['claude-code']?.journal;

const alphaJournalPhase = (raw: LedgerJsonShape | null): string | null | undefined =>
  alphaJournal(raw)?.phase;

const alphaPinnedStorePath = (raw: LedgerJsonShape | null): string | undefined =>
  raw?.skills?.alpha?.tools?.['claude-code']?.pinned?.storePath;

const waitForPhase = async (
  ledgerPath: string,
  phase: string,
  timeoutMs = 15_000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await readLedgerJson(ledgerPath);
    if (alphaJournalPhase(raw) === phase) return;
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

describe.skipIf(!E2E)('skillsmith promote/dev live e2e (real process SIGKILL)', () => {
  test('SIGKILL at backed-up, then `promote --rollback alpha`: journal recovered, symlink restored byte-identically', async () => {
    const f = await buildFixtureFleet();
    try {
      const livePath = join(f.home, '.claude', 'skills', 'alpha');
      const skillsRoot = join(f.home, '.claude', 'skills');
      const ledgerPath = join(f.data, 'placements.json');
      const originalTarget = await readlink(livePath);

      const proc = spawnCli(['promote', 'alpha', '--no-verify'], {
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

      // Crashed on-disk state — two possible kill points, each pinned down exactly. Either the
      // live path is still the OLD symlink (killed before the P3 rename; target byte-identical),
      // or it is ABSENT with the backup holding the old artifact (killed in the P3-P4 window).
      // The absent branch is the F1 crash window: planning surfaces the journaled pair from the
      // ledger, so the rollback below MUST recover it (exit 0) — never exit 4 "no placement found".
      const liveKind = await kindOf(livePath);
      expect(['symlink', 'absent']).toContain(liveKind);
      if (liveKind === 'symlink') {
        expect(await readlink(livePath)).toBe(originalTarget);
      } else {
        const names = await residueNames(skillsRoot);
        expect(names.some((n) => n.startsWith('.skillsmith-backup-alpha-'))).toBe(true);
      }
      const raw = await readLedgerJson(ledgerPath);
      const pinnedStorePath = alphaPinnedStorePath(raw);
      if (pinnedStorePath) expect(await kindOf(pinnedStorePath)).toBe('dir');

      const rb = await run(['promote', '--rollback', 'alpha'], {
        HOME: f.home,
        SKILLSMITH_HOME: f.data,
        SKILLSMITH_E2E: '1',
      });
      requireExit(rb, 0, 'promote --rollback alpha');

      expect(await readlink(livePath)).toBe(originalTarget);
      const rolledBack = await readLedgerJson(ledgerPath);
      expect(alphaJournal(rolledBack)).toBeNull();
      expect(await residueNames(skillsRoot)).toEqual([]);
    } finally {
      await destroyFixtureFleet(f);
    }
  }, 120_000);

  test('SIGKILL at backed-up, then a same-op re-run (`promote alpha --no-verify`): converges to the pinned copy, journal committed', async () => {
    const f = await buildFixtureFleet();
    try {
      const livePath = join(f.home, '.claude', 'skills', 'alpha');
      const ledgerPath = join(f.data, 'placements.json');

      const proc = spawnCli(['promote', 'alpha', '--no-verify'], {
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

      const rerun = await run(['promote', 'alpha', '--no-verify'], {
        HOME: f.home,
        SKILLSMITH_HOME: f.data,
        SKILLSMITH_E2E: '1',
      });
      requireExit(rerun, 0, 'promote alpha --no-verify (re-run)');

      expect(await kindOf(livePath)).toBe('dir');
      const raw = await readLedgerJson(ledgerPath);
      expect(alphaJournalPhase(raw)).toBe('committed');
    } finally {
      await destroyFixtureFleet(f);
    }
  }, 120_000);
});
