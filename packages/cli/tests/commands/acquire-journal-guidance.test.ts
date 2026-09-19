import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../core/tests/fixtures/acquire/remote.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';

// SC-I60-MF1 RED characterization: a promote/dev request blocked by an interrupted INSTALL or
// UNINSTALL journal must name a parser-accepted recovery command. The legacy run-layer branches
// interpolate the journal op into `skillsmith <op> --rollback <skill>`, which is unsupported for
// install/uninstall (the parser rejects `--rollback` on those verbs). Genuine journals only: real
// CLI + public SKILLSMITH_TEST_PAUSE_AT seam + SIGKILL, mirroring install-live.test.ts (P12).
//
// Env-gated like the other live suites; CI stays green. Run locally:
// `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/acquire-journal-guidance.test.ts`
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

const clearOrphanedLock = async (ledgerPath: string): Promise<void> => {
  await rm(`${ledgerPath}.lock`, { recursive: true, force: true });
};

// Minimal ad-hoc shape of placements.json, read directly (not through core's ledger reader) per
// the P12 precedent — mirrors polling a real process from outside rather than reaching into core.
interface LedgerJsonShape {
  skills?: Record<
    string,
    {
      tools?: Record<
        string,
        {
          journal?: { op: string; phase: string } | null;
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
    return null; // mid-write; retry
  }
};

const skillJournal = (
  raw: LedgerJsonShape | null,
): { op: string; phase: string } | null | undefined =>
  raw?.skills?.[SKILL]?.tools?.['claude-code']?.journal;

const waitForPhase = async (
  ledgerPath: string,
  phase: string,
  proc: ReturnType<typeof spawnCli>,
  timeoutMs = 45_000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await readLedgerJson(ledgerPath);
    if (skillJournal(raw)?.phase === phase) return;
    if (proc.exitCode !== null) {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `paused child exited (code ${proc.exitCode}) before journal phase '${phase}' at ${ledgerPath}\n--- child stdout ---\n${stdout}\n--- child stderr ---\n${stderr}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for journal phase '${phase}' at ${ledgerPath}`);
};

/** SIGKILL the paused child; on setup timeout include its transcript for diagnosis. */
const killAndDrain = async (
  proc: ReturnType<typeof spawnCli>,
  ledgerPath: string,
  label: string,
): Promise<{ stdout: string; stderr: string }> => {
  proc.kill('SIGKILL');
  await proc.exited;
  await clearOrphanedLock(ledgerPath);
  const drain = async (stream: ReturnType<typeof spawnCli>['stdout']): Promise<string> => {
    try {
      return await new Response(stream).text();
    } catch {
      return '';
    }
  };
  const stdout = await drain(proc.stdout);
  const stderr = await drain(proc.stderr);
  if (process.env.MF1_DEBUG === '1') {
    console.log(
      `\n----- ${label} crashed-child transcript -----\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n----- end -----\n`,
    );
  }
  return { stdout, stderr };
};

// Networkless transport for spawned-CLI git: the P17 git port unsets GIT_CONFIG_COUNT (so
// GIT_CONFIG_KEY_* env rewrites are dropped), but honors a global config file. Mirror the
// contracts-suite precedent: write the insteadOf mapping into a fixture gitconfig and select it
// via hermeticGitEnv's globalConfigPath (GIT_CONFIG_GLOBAL). See uninstall.test.ts:434.
const writeRewriteGitconfig = async (f: FixtureFleet, remote: RemoteFixture): Promise<string> => {
  const path = join(f.base, 'gitconfig');
  await writeFile(
    path,
    `[url "${remote.multiUrl}"]\n\tinsteadOf = ${remote.multiSource}\n` +
      `[url "${remote.singleUrl}"]\n\tinsteadOf = ${remote.singleSource}\n` +
      `[url "${remote.rootUrl}"]\n\tinsteadOf = ${remote.rootSource}\n`,
  );
  return path;
};

const spawnCli = (args: string[], env: Record<string, string>, gitconfig?: string) =>
  Bun.spawn(['bun', BIN, ...args], {
    cwd: REPO_ROOT,
    env: hermeticGitEnv(env, gitconfig === undefined ? {} : { globalConfigPath: gitconfig }),
    stdout: 'pipe',
    stderr: 'pipe',
  } as const);

const run = async (
  args: string[],
  env: Record<string, string>,
  gitconfig?: string,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = spawnCli(args, env, gitconfig);
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

/**
 * Decisive MF1 assertion: the emitted guidance must not name an unsupported command. RED if the
 * output suggests `skillsmith install --rollback` or `skillsmith uninstall --rollback` (both
 * rejected by the real parser with `error: unknown option '--rollback'`). Absence-only by design:
 * the verified refusal names no recovery command at all, so presence cannot be asserted here
 * (advice enrichment would be a product change, out of scope). Throws with the full transcript
 * on RED so the verdict evidence is self-contained.
 */
const expectNoUnsupportedGuidance = (
  r: { stdout: string; stderr: string; code: number },
  label: string,
): void => {
  const text = `${r.stdout}\n${r.stderr}`;
  const forbidden = ['skillsmith install --rollback', 'skillsmith uninstall --rollback'].filter(
    (s) => text.includes(s),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `${label}: RED — unsupported recovery guidance emitted (${forbidden.join(', ')}), exit ${r.code}\n` +
        `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
};

const expectInterruptedRefusal = (
  r: { stdout: string; stderr: string; code: number },
  op: 'install' | 'uninstall',
  label: string,
): void => {
  if (process.env.MF1_DEBUG === '1') {
    console.log(
      `\n===== ${label} (exit ${r.code}) =====\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n===== end ${label} =====\n`,
    );
  }
  requireExit(r, 2, label);
  const text = `${r.stdout}\n${r.stderr}`;
  expect(text).toContain('interrupted');
  expect(text).toContain(op);
  expect(text).toContain(SKILL);
  expectNoUnsupportedGuidance(r, label);
};

interface CrashedAcquire {
  fixture: Awaited<ReturnType<typeof buildRemoteFixture>>;
  f: FixtureFleet;
  fsSource: string;
  livePath: string;
  skillsRoot: string;
  ledgerPath: string;
  gitconfig: string;
}

const crashInstallAtLive = async (): Promise<CrashedAcquire> => {
  const fixture = await buildRemoteFixture();
  const f = await buildFixtureFleet();
  const gitconfig = await writeRewriteGitconfig(f, fixture);
  const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
  const livePath = join(f.home, '.claude', 'skills', SKILL);
  const skillsRoot = join(f.home, '.claude', 'skills');
  const ledgerPath = join(f.data, 'placements.json');
  const proc = spawnCli(
    ['install', fsSource, '--tool', 'claude-code', '--no-verify', '--user'],
    {
      ...fixture.gitRewriteEnv,
      HOME: f.home,
      SKILLSMITH_HOME: f.data,
      SKILLSMITH_E2E: '1',
      SKILLSMITH_TEST_PAUSE_AT: 'live',
    },
    gitconfig,
  );
  try {
    await waitForPhase(ledgerPath, 'live', proc);
  } catch (error) {
    const t = await killAndDrain(proc, ledgerPath, 'crashed install');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n--- child stdout ---\n${t.stdout}\n--- child stderr ---\n${t.stderr}`,
    );
  }
  await killAndDrain(proc, ledgerPath, 'crashed install');
  const journal = skillJournal(await readLedgerJson(ledgerPath));
  expect(journal).toMatchObject({ op: 'install', phase: 'live' });
  return { fixture, f, fsSource, livePath, skillsRoot, ledgerPath, gitconfig };
};

const crashUninstallAtBackedUp = async (): Promise<CrashedAcquire> => {
  const fixture = await buildRemoteFixture();
  const f = await buildFixtureFleet();
  const gitconfig = await writeRewriteGitconfig(f, fixture);
  const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
  const livePath = join(f.home, '.claude', 'skills', SKILL);
  const skillsRoot = join(f.home, '.claude', 'skills');
  const ledgerPath = join(f.data, 'placements.json');
  const seed = await run(
    ['install', fsSource, '--tool', 'claude-code', '--no-verify', '--user'],
    {
      ...fixture.gitRewriteEnv,
      HOME: f.home,
      SKILLSMITH_HOME: f.data,
      SKILLSMITH_E2E: '1',
    },
    gitconfig,
  );
  requireExit(seed, 0, 'seed install');
  expect(await kindOf(livePath)).toBe('symlink');
  const proc = spawnCli(
    ['uninstall', SKILL, '--tool', 'claude-code', '--user'],
    {
      HOME: f.home,
      SKILLSMITH_HOME: f.data,
      SKILLSMITH_E2E: '1',
      SKILLSMITH_TEST_PAUSE_AT: 'backed-up',
    },
    gitconfig,
  );
  try {
    await waitForPhase(ledgerPath, 'backed-up', proc);
  } catch (error) {
    const t = await killAndDrain(proc, ledgerPath, 'crashed uninstall');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n--- child stdout ---\n${t.stdout}\n--- child stderr ---\n${t.stderr}`,
    );
  }
  await killAndDrain(proc, ledgerPath, 'crashed uninstall');
  const journal = skillJournal(await readLedgerJson(ledgerPath));
  expect(journal).toMatchObject({ op: 'uninstall', phase: 'backed-up' });
  return { fixture, f, fsSource, livePath, skillsRoot, ledgerPath, gitconfig };
};

const destroy = async (c: CrashedAcquire): Promise<void> => {
  await destroyFixtureFleet(c.f);
  await destroyRemoteFixture(c.fixture);
};

describe.skipIf(!E2E)('acquire-journal guidance (SC-I60-MF1 RED characterization)', () => {
  test('install-journal x promote names a supported recovery command', async () => {
    const c = await crashInstallAtLive();
    try {
      const r = await run(['promote', SKILL, '--no-verify'], {
        HOME: c.f.home,
        SKILLSMITH_HOME: c.f.data,
        SKILLSMITH_E2E: '1',
      });
      expectInterruptedRefusal(r, 'install', 'promote vs install-journal');
    } finally {
      await destroy(c);
    }
  }, 120_000);

  test('install-journal x dev names a supported recovery command', async () => {
    const c = await crashInstallAtLive();
    try {
      const r = await run(['dev', SKILL, '--no-verify'], {
        HOME: c.f.home,
        SKILLSMITH_HOME: c.f.data,
        SKILLSMITH_E2E: '1',
      });
      expectInterruptedRefusal(r, 'install', 'dev vs install-journal');
    } finally {
      await destroy(c);
    }
  }, 120_000);

  test('uninstall-journal x promote names a supported recovery command', async () => {
    const c = await crashUninstallAtBackedUp();
    try {
      const r = await run(['promote', SKILL, '--no-verify'], {
        HOME: c.f.home,
        SKILLSMITH_HOME: c.f.data,
        SKILLSMITH_E2E: '1',
      });
      expectInterruptedRefusal(r, 'uninstall', 'promote vs uninstall-journal');
    } finally {
      await destroy(c);
    }
  }, 120_000);

  test('uninstall-journal x dev names a supported recovery command', async () => {
    const c = await crashUninstallAtBackedUp();
    try {
      const r = await run(['dev', SKILL, '--no-verify'], {
        HOME: c.f.home,
        SKILLSMITH_HOME: c.f.data,
        SKILLSMITH_E2E: '1',
      });
      expectInterruptedRefusal(r, 'uninstall', 'dev vs uninstall-journal');
    } finally {
      await destroy(c);
    }
  }, 120_000);

  test('install-journal x promote --json names a supported recovery command', async () => {
    const c = await crashInstallAtLive();
    try {
      const r = await run(['promote', SKILL, '--no-verify', '--json'], {
        HOME: c.f.home,
        SKILLSMITH_HOME: c.f.data,
        SKILLSMITH_E2E: '1',
      });
      expectInterruptedRefusal(r, 'install', 'promote --json vs install-journal');
    } finally {
      await destroy(c);
    }
  }, 120_000);

  test('bounded advice check: promote --rollback recovers the interrupted install journal', async () => {
    const c = await crashInstallAtLive();
    try {
      const rb = await run(['promote', '--rollback', SKILL], {
        HOME: c.f.home,
        SKILLSMITH_HOME: c.f.data,
        SKILLSMITH_E2E: '1',
      });
      requireExit(rb, 0, 'promote --rollback factor-scan');
      expect(await kindOf(c.livePath)).toBe('absent');
      const rawAfter = await readLedgerJson(c.ledgerPath);
      expect(rawAfter?.skills?.[SKILL]).toBeUndefined();
      expect(await residueNames(c.skillsRoot)).toEqual([]);
    } finally {
      await destroy(c);
    }
  }, 120_000);
});
