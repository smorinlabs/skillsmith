/**
 * SC-I60-MO2 Phase A characterization: interrupted direct-copy replacement
 * across two swaps (copy -> symlink -> copy) must not silently become a
 * completed symlink install on an identical retry.
 *
 * Process-spawning tests mirror the install-live.test.ts precedent and are
 * gated on SKILLSMITH_E2E=1. In-process controls run unconditionally.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from '../../src/acquire/run.ts';
import type { InstallDeps, InstallOptions } from '../../src/acquire/types.ts';
import type { InstallRecord } from '../../src/agents/types.ts';
import type { ArtifactCoordinatorPorts } from '../../src/artifacts/coordinator-types.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  getLedgerPairAt,
  readLedgerState,
  withLedgerPairAt,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { ok } from '../../src/result.ts';
import { VERIFIED_AGAINST, type VerifyReport } from '../../src/verify/types.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../fixtures/acquire/remote.ts';
import { hermeticGitEnv } from '../fixtures/git-env.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const E2E = process.env.SKILLSMITH_E2E === '1';
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const BIN = 'packages/cli/src/index.ts';
const CHILD = 'packages/core/tests/fixtures/acquire/mo2-crash-child.ts';
const SKILL = 'factor-scan';
const TOOL = 'claude-code';
const NOW = '2026-07-08T00:00:00.000Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

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

interface LedgerJsonShape {
  skills?: Record<string, { tools?: Record<string, Record<string, unknown>> }>;
  transactions?: Record<string, unknown>;
  history?: readonly unknown[];
}
const readLedgerJson = async (ledgerPath: string): Promise<LedgerJsonShape | null> => {
  if (!existsSync(ledgerPath)) return null;
  try {
    return JSON.parse(await readFile(ledgerPath, 'utf8')) as LedgerJsonShape;
  } catch {
    return null;
  }
};
const pairOf = (raw: LedgerJsonShape | null): Record<string, unknown> | undefined =>
  raw?.skills?.[SKILL]?.tools?.[TOOL];
const residueNames = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((n) => n.startsWith('.skillsmith-'));

const spawnCli = (args: string[], env: Record<string, string>, globalConfigPath: string) =>
  Bun.spawn(['bun', BIN, ...args], {
    cwd: REPO_ROOT,
    env: hermeticGitEnv(env, { globalConfigPath }),
    stdout: 'pipe',
    stderr: 'pipe',
  } as const);
const runCli = async (
  args: string[],
  env: Record<string, string>,
  globalConfigPath: string,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = spawnCli(args, env, globalConfigPath);
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};
const requireExit = (
  r: { stdout: string; stderr: string; code: number },
  expected: number,
  label: string,
): void => {
  if (r.code !== expected) {
    throw new Error(
      `${label}: expected exit ${expected}, got ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- in-process control deps (mirrors install-run.test.ts) ----
const detectBoth: InstallDeps['detect'] = async (_env, tool) =>
  ok<InstallRecord[]>([
    { path: `/usr/local/bin/${tool}`, version: '1.0.0', installMethod: 'unknown' },
  ]);
const passVerify: InstallDeps['verify'] = async (_env, opts) => {
  const tools = opts.tools ?? [];
  const tool = tools[0] ?? 'claude-code';
  const report: VerifyReport = {
    schemaVersion: 1,
    target: { path: opts.path, kind: 'skill' },
    requested: {
      tools: [...tools],
      modes: opts.deep ? ['static', 'deep'] : ['static'],
      strict: opts.strict ?? false,
      explicitTools: true,
    },
    verifiedAgainst: VERIFIED_AGAINST,
    summary: {
      verdict: 'pass',
      verified: [tool],
      failed: [],
      skipped: [],
      counts: { error: 0, warning: 0, info: 0 },
    },
    tools: [
      {
        tool,
        available: true,
        toolVersion: '1.0.0',
        versionDrift: false,
        skipReason: null,
        verdict: 'pass',
        modes: [],
      },
    ],
  };
  return ok(report);
};

describe('MO2 in-process controls (no crash)', () => {
  test('uninterrupted A-copy -> B-copy direct update converges to a B directory', async () => {
    const fixture = await buildRemoteFixture();
    const f = await buildFixtureFleet();
    try {
      const coordinator: ArtifactCoordinatorPorts = await createTestNodeArtifactCoordinatorPorts(
        join(f.base, 'artifact-coordination'),
      );
      let n = 0;
      const deps: InstallDeps = {
        verify: passVerify,
        detect: detectBoth,
        transport: fixture.transport,
        artifactCoordinator: coordinator,
        now: () => NOW,
        newTxId: () => (0x10000000 + n++).toString(16).slice(-8),
      };
      const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
      const livePath = join(f.home, '.claude', 'skills', SKILL);
      const base: InstallOptions = {
        sources: [fsSource],
        tools: [TOOL],
        scope: 'user',
        direct: true,
        cwd: f.base,
        configuration: f.configuration,
      };
      const r1 = await runInstall(f.env, { ...base, ref: 'v1.0.0' }, deps);
      if (!r1.ok) throw new Error(`A install: ${msg(r1.error)}`);
      expect(r1.value.summary.installed).toBe(1);
      expect(await kindOf(livePath)).toBe('dir');
      expect(await kindOf(join(livePath, 'bin', 'run.sh'))).toBe('absent');

      const r2 = await runInstall(f.env, { ...base, ref: fixture.multiHead }, deps);
      if (!r2.ok) throw new Error(`B update: ${msg(r2.error)}`);
      expect(r2.value.summary.updated).toBe(1);
      expect(await kindOf(livePath)).toBe('dir');
      expect(await kindOf(join(livePath, 'bin', 'run.sh'))).toBe('file');
      expect(await kindOf(join(livePath, 'link.md'))).toBe('symlink');
      const led = await readLedgerState(f.env, ledgerPathOf(f.data));
      if (!led.ok || led.value.state !== 'present') throw new Error('ledger missing');
      const pair = pairOf(led.value.model as unknown as LedgerJsonShape);
      expect(pair?.journal ?? null).toBeNull();
      expect((pair?.pinned as { placement?: unknown } | undefined)?.placement).toBe('copy');
      expect((pair?.origin as { refResolved?: unknown } | undefined)?.refResolved).toBe(
        fixture.multiHead,
      );
      // SC-I60-MO2: the uninterrupted two-stage replacement clears its staged
      // intent at the second terminal write — no marker survives convergence.
      expect(
        (pair as { pendingReplacement?: unknown } | undefined)?.pendingReplacement ?? null,
      ).toBeNull();

      // Same-B healthy-copy true noop.
      const r3 = await runInstall(f.env, { ...base, ref: fixture.multiHead }, deps);
      if (!r3.ok) throw new Error(`B re-run: ${msg(r3.error)}`);
      expect(r3.value.summary.noop).toBe(1);
      expect(await kindOf(livePath)).toBe('dir');
    } finally {
      await destroyFixtureFleet(f);
      await destroyRemoteFixture(fixture);
    }
  }, 120_000);

  test('healthy same-B symlink + no-force direct request: report stays truthful (policy characterization)', async () => {
    const fixture = await buildRemoteFixture();
    const f = await buildFixtureFleet();
    try {
      const coordinator: ArtifactCoordinatorPorts = await createTestNodeArtifactCoordinatorPorts(
        join(f.base, 'artifact-coordination'),
      );
      let n = 0;
      const deps: InstallDeps = {
        verify: passVerify,
        detect: detectBoth,
        transport: fixture.transport,
        artifactCoordinator: coordinator,
        now: () => NOW,
        newTxId: () => (0x20000000 + n++).toString(16).slice(-8),
      };
      const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
      const livePath = join(f.home, '.claude', 'skills', SKILL);
      const r1 = await runInstall(
        f.env,
        {
          sources: [fsSource],
          tools: [TOOL],
          scope: 'user',
          ref: fixture.multiHead,
          cwd: f.base,
          configuration: f.configuration,
        },
        deps,
      );
      if (!r1.ok) throw new Error(`symlink install: ${msg(r1.error)}`);
      expect(await kindOf(livePath)).toBe('symlink');
      const r2 = await runInstall(
        f.env,
        {
          sources: [fsSource],
          tools: [TOOL],
          scope: 'user',
          ref: fixture.multiHead,
          direct: true,
          cwd: f.base,
          configuration: f.configuration,
        },
        deps,
      );
      if (!r2.ok) throw new Error(`direct re-request: ${msg(r2.error)}`);
      const result = r2.value.results[0];
      const liveKind = await kindOf(livePath);
      console.log(
        `MO2 policy control: action=${result?.action} placement=${result?.placement} live=${liveKind} reason=${result?.reason}`,
      );
      // SC-I60-MO2 companion: the healthy symlink is still a noop (no
      // conversion without force — policy unchanged), but the report is now
      // truthful (recorded/live placement) and no phantom update op is
      // emitted, so no operation-level failure shadows the noop.
      expect(result?.action).toBe('noop');
      expect(result?.placement).toBe('symlink');
      console.log(
        `MO2 policy control plan kinds=${JSON.stringify(r2.value.plan.operations.map((op) => op.kind))} executionOutcomes=${JSON.stringify(r2.value.executionResults.map((r) => r.outcome))}`,
      );
      const liveOps = r2.value.plan.operations.filter(
        (op) => op.kind === 'install' || op.kind === 'update' || op.kind === 'repair',
      );
      expect(liveOps.length).toBe(0);
      // No phantom operation-level failure shadows the noop: the durable
      // desired state makes the noop itself the success outcome.
      expect(result?.executionOutcome).toBe('succeeded');
      expect(result?.drift.status).toBe('in-sync');
    } finally {
      await destroyFixtureFleet(f);
      await destroyRemoteFixture(fixture);
    }
  }, 120_000);

  test('staged marker from another revision with identical content does not continue', async () => {
    const fixture = await buildRemoteFixture();
    const f = await buildFixtureFleet();
    try {
      const coordinator: ArtifactCoordinatorPorts = await createTestNodeArtifactCoordinatorPorts(
        join(f.base, 'artifact-coordination'),
      );
      let n = 0;
      const deps: InstallDeps = {
        verify: passVerify,
        detect: detectBoth,
        transport: fixture.transport,
        artifactCoordinator: coordinator,
        now: () => NOW,
        newTxId: () => (0x30000000 + n++).toString(16).slice(-8),
      };
      const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
      const livePath = join(f.home, '.claude', 'skills', SKILL);
      const base: InstallOptions = {
        sources: [fsSource],
        tools: [TOOL],
        scope: 'user',
        ref: fixture.multiHead,
        cwd: f.base,
        configuration: f.configuration,
      };
      const r1 = await runInstall(f.env, base, deps);
      if (!r1.ok) throw new Error(`symlink install: ${msg(r1.error)}`);
      expect(await kindOf(livePath)).toBe('symlink');
      // Forge a stage-1 marker for the same content but a different
      // revision: store paths and content hashes are content-based, so
      // only the marker's resolved revision distinguishes it from this
      // request's own staged intent.
      const staleBackup = join(f.base, 'stale-backup');
      await mkdir(staleBackup, { recursive: true });
      const led = await readLedgerState(f.env, ledgerPathOf(f.data));
      if (!led.ok || led.value.state !== 'present') throw new Error('ledger missing');
      const pair = getLedgerPairAt(led.value.model, null, SKILL, TOOL);
      if (!pair?.pinned) throw new Error('expected seeded pinned pair');
      const otherSha = 'f'.repeat(40);
      expect(otherSha).not.toBe(fixture.multiHead);
      const next = withLedgerPairAt(led.value.model, null, SKILL, TOOL, {
        ...pair,
        pendingReplacement: {
          build: 'copy',
          stage: 1,
          refResolved: otherSha,
          storePath: pair.pinned.storePath,
          contentHash: pair.pinned.contentHash,
          backupPath: staleBackup,
          recordedAt: NOW,
        },
      });
      if (!next.ok) throw new Error(msg(next.error));
      const w = await writeLedger(f.env, ledgerPathOf(f.data), next.value);
      if (!w.ok) throw new Error(msg(w.error));
      const r2 = await runInstall(f.env, { ...base, direct: true }, deps);
      if (!r2.ok) throw new Error(`direct re-request: ${msg(r2.error)}`);
      const result = r2.value.results[0];
      // The foreign marker must not continue: the healthy symlink stays
      // a truthful noop and its unrelated backup is never surfaced.
      expect(result?.action).toBe('noop');
      expect(result?.placement).toBe('symlink');
      expect(result?.reason ?? '').not.toContain('kept backup');
      expect(await kindOf(livePath)).toBe('symlink');
    } finally {
      await destroyFixtureFleet(f);
      await destroyRemoteFixture(fixture);
    }
  }, 120_000);
});

// ---- shared crash choreography for the post-fix recovery tests (additive;
// the redprove helpers above are unchanged) ----
interface Mo2CrashContext {
  fixture: RemoteFixture;
  f: FixtureFleet;
  fsSource: string;
  shaB: string;
  livePath: string;
  skillsRoot: string;
  ledgerPath: string;
  cliEnv: Record<string, string>;
  gitConfigPath: string;
}
const setupMo2CrashPair = async (): Promise<Mo2CrashContext> => {
  const fixture = await buildRemoteFixture();
  const f = await buildFixtureFleet();
  const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
  const shaB = fixture.multiHead;
  const livePath = join(f.home, '.claude', 'skills', SKILL);
  const skillsRoot = join(f.home, '.claude', 'skills');
  const ledgerPath = join(f.data, 'placements.json');
  const cliEnv: Record<string, string> = {
    GIT_ALLOW_PROTOCOL: 'file:https',
    HOME: f.home,
    SKILLSMITH_HOME: f.data,
    SKILLSMITH_E2E: '1',
  };
  const { writeFile } = await import('node:fs/promises');
  const gitConfigPath = join(f.base, 'owned-gitconfig');
  await writeFile(
    gitConfigPath,
    [
      `[url "file://${fixture.base}/multi.git"]`,
      '\tinsteadOf = https://fixture.invalid/acme/multi.git',
      `[url "file://${fixture.base}/single.git"]`,
      '\tinsteadOf = https://fixture.invalid/acme/single.git',
      `[url "file://${fixture.base}/root.git"]`,
      '\tinsteadOf = https://fixture.invalid/acme/root.git',
      '',
    ].join('\n'),
  );
  const setup = await runCli(
    ['install', fsSource, '--tool', TOOL, '--ref', 'v1.0.0', '--direct', '--no-verify', '--user'],
    cliEnv,
    gitConfigPath,
  );
  requireExit(setup, 0, 'install A --direct');
  expect(await kindOf(livePath)).toBe('dir');
  const rawA = await readLedgerJson(ledgerPath);
  expect(pairOf(rawA)?.journal ?? null).toBeNull();
  expect((pairOf(rawA)?.pinned as { placement?: unknown })?.placement).toBe('copy');
  return { fixture, f, fsSource, shaB, livePath, skillsRoot, ledgerPath, cliEnv, gitConfigPath };
};
const destroyMo2CrashPair = async (ctx: Mo2CrashContext): Promise<void> => {
  await destroyFixtureFleet(ctx.f);
  await destroyRemoteFixture(ctx.fixture);
};
const runLatchChild = async <T>(
  ctx: Mo2CrashContext,
  tag: string,
  latchMode: 'gap' | 'pre-swap',
  verify: (ready: Record<string, unknown>) => Promise<T>,
): Promise<T> => {
  const readyPath = join(tmpdir(), `mo2-${tag}-ready-${process.pid}.json`);
  const logPath = join(tmpdir(), `mo2-${tag}-child-${process.pid}.log`);
  const paramsPath = join(tmpdir(), `mo2-${tag}-params-${process.pid}.json`);
  const { writeFile, rm } = await import('node:fs/promises');
  await rm(readyPath, { force: true });
  await rm(logPath, { force: true });
  await writeFile(
    paramsPath,
    JSON.stringify({
      remoteBase: ctx.fixture.base,
      home: ctx.f.home,
      data: ctx.f.data,
      cwd: ctx.f.base,
      source: ctx.fsSource,
      refB: ctx.shaB,
      shaB: ctx.shaB,
      skill: SKILL,
      tool: TOOL,
      ledgerPath: ctx.ledgerPath,
      livePath: ctx.livePath,
      readyPath,
      logPath,
      latchEnabled: true,
      latchMode,
    }),
  );
  const child = Bun.spawn(['bun', CHILD, paramsPath], {
    cwd: REPO_ROOT,
    env: hermeticGitEnv(ctx.cliEnv, { globalConfigPath: ctx.gitConfigPath }),
    stdout: 'pipe',
    stderr: 'pipe',
  } as const);
  try {
    let ready: Record<string, unknown> | null = null;
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      if (existsSync(readyPath)) {
        ready = JSON.parse(await readFile(readyPath, 'utf8')) as Record<string, unknown>;
        break;
      }
      await sleep(100);
    }
    if (ready === null) throw new Error(`timed out waiting for MO2 ${tag} rendezvous (60s)`);
    if (ready.completed !== undefined) {
      const log = existsSync(logPath) ? await readFile(logPath, 'utf8') : '(no child log)';
      throw new Error(`rendezvous MISSED, child completed: ${JSON.stringify(ready)}\n${log}`);
    }
    console.log(`MO2 ${tag} rendezvous: ${JSON.stringify(ready)}`);
    return await verify(ready);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
};
const sleepStaleLock = async (): Promise<void> => {
  // Real stale-lock recovery latency — the orphaned mkdir-lock goes stale
  // after 30s; never delete it (plan rule).
  await sleep(33_000);
};
/** Parent verification of the durable between-swaps gap; returns the staged backup path. */
const verifyGapState = async (ctx: Mo2CrashContext): Promise<string> => {
  expect(await kindOf(ctx.livePath)).toBe('symlink');
  const rawGap = await readLedgerJson(ctx.ledgerPath);
  if (rawGap === null) throw new Error('ledger unreadable at rendezvous');
  const pairGap = pairOf(rawGap);
  expect(pairGap).toBeDefined();
  expect(pairGap?.journal ?? null).toBeNull();
  expect((pairGap?.pinned as { placement?: unknown })?.placement).toBe('symlink');
  expect((pairGap?.origin as { refResolved?: unknown })?.refResolved).toBe(ctx.shaB);
  const staged = pairGap?.pendingReplacement as
    | { build?: unknown; stage?: unknown; refResolved?: unknown; backupPath?: unknown }
    | undefined;
  expect(staged?.build).toBe('copy');
  expect(staged?.stage).toBe(1);
  expect(staged?.refResolved).toBe(ctx.shaB);
  const backup = staged?.backupPath as string;
  expect(await kindOf(backup)).not.toBe('absent');
  return backup;
};

describe.skipIf(!E2E)('MO2 decisive replay (owned child + SIGKILL + public CLI restart)', () => {
  test('interrupted copy->copy update converges to a B directory on identical retry', async () => {
    const fixture = await buildRemoteFixture();
    const f = await buildFixtureFleet();
    try {
      const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
      const shaB = fixture.multiHead;
      const livePath = join(f.home, '.claude', 'skills', SKILL);
      const skillsRoot = join(f.home, '.claude', 'skills');
      const ledgerPath = join(f.data, 'placements.json');
      const cliEnv: Record<string, string> = {
        GIT_ALLOW_PROTOCOL: 'file:https',
        HOME: f.home,
        SKILLSMITH_HOME: f.data,
        SKILLSMITH_E2E: '1',
      };
      // Owned global gitconfig carrying the synthetic-remote rewrite: the
      // production git port scrubs GIT_CONFIG_COUNT, so the env-var rewrite
      // cannot reach real git; an owned config file is the surviving
      // equivalent (system config stays /dev/null, HOME is owned).
      const { writeFile: writeFileTop } = await import('node:fs/promises');
      const gitConfigPath = join(f.base, 'owned-gitconfig');
      await writeFileTop(
        gitConfigPath,
        [
          `[url "file://${fixture.base}/multi.git"]`,
          '\tinsteadOf = https://fixture.invalid/acme/multi.git',
          `[url "file://${fixture.base}/single.git"]`,
          '\tinsteadOf = https://fixture.invalid/acme/single.git',
          `[url "file://${fixture.base}/root.git"]`,
          '\tinsteadOf = https://fixture.invalid/acme/root.git',
          '',
        ].join('\n'),
      );

      // Step 1: real public CLI installs A as a managed direct copy.
      const setup = await runCli(
        [
          'install',
          fsSource,
          '--tool',
          TOOL,
          '--ref',
          'v1.0.0',
          '--direct',
          '--no-verify',
          '--user',
        ],
        cliEnv,
        gitConfigPath,
      );
      requireExit(setup, 0, 'install A --direct');
      expect(await kindOf(livePath)).toBe('dir');
      const rawA = await readLedgerJson(ledgerPath);
      const pairA = pairOf(rawA);
      expect(pairA?.journal ?? null).toBeNull();
      expect((pairA?.pinned as { placement?: unknown })?.placement).toBe('copy');
      expect((pairA?.origin as { refResolved?: unknown })?.refResolved).toBe(fixture.multiTagSha);

      // Step 2: owned child runs exported production runInstall (B --direct)
      // under the forwarding decorator; it latches at the between-swaps gap.
      const readyPath = join(tmpdir(), `mo2-ready-${process.pid}.json`);
      const logPath = join(tmpdir(), `mo2-child-${process.pid}.log`);
      const paramsPath = join(tmpdir(), `mo2-params-${process.pid}.json`);
      let gapBackup: string | null = null;
      const { writeFile, rm } = await import('node:fs/promises');
      await rm(readyPath, { force: true });
      await rm(logPath, { force: true });
      await writeFile(
        paramsPath,
        JSON.stringify({
          remoteBase: fixture.base,
          home: f.home,
          data: f.data,
          cwd: f.base,
          source: fsSource,
          refB: shaB,
          shaB,
          skill: SKILL,
          tool: TOOL,
          ledgerPath,
          livePath,
          readyPath,
          logPath,
          latchEnabled: true,
        }),
      );
      const child = Bun.spawn(['bun', CHILD, paramsPath], {
        cwd: REPO_ROOT,
        env: hermeticGitEnv(cliEnv, { globalConfigPath: gitConfigPath }),
        stdout: 'pipe',
        stderr: 'pipe',
      } as const);
      let ready: Record<string, unknown> | null = null;
      try {
        const start = Date.now();
        while (Date.now() - start < 60_000) {
          if (existsSync(readyPath)) {
            ready = JSON.parse(await readFile(readyPath, 'utf8')) as Record<string, unknown>;
            break;
          }
          await sleep(100);
        }
        if (ready === null) throw new Error('timed out waiting for MO2 rendezvous (60s)');
        if (ready.completed !== undefined) {
          const log = existsSync(logPath) ? await readFile(logPath, 'utf8') : '(no child log)';
          throw new Error(`rendezvous MISSED, child completed: ${JSON.stringify(ready)}\n${log}`);
        }
        console.log(`MO2 rendezvous: ${JSON.stringify(ready)}`);

        // Step 3: independent parent verification of the gap state on disk.
        expect(await kindOf(livePath)).toBe('symlink');
        const rawGap = await readLedgerJson(ledgerPath);
        if (rawGap === null) throw new Error('ledger unreadable at rendezvous');
        console.log(
          `MO2 gap ledger keys=${JSON.stringify(Object.keys(rawGap))} skills=${JSON.stringify(Object.keys(rawGap.skills ?? {}))}`,
        );
        const { copyFile: copyFileGap } = await import('node:fs/promises');
        await copyFileGap(ledgerPath, `/tmp/mo2-gap-ledger-${process.pid}.json`).catch(() => {});
        const pairGap = pairOf(rawGap);
        expect(pairGap).toBeDefined();
        expect(pairGap?.journal ?? null).toBeNull();
        expect((pairGap?.pinned as { placement?: unknown })?.placement).toBe('symlink');
        expect((pairGap?.origin as { refResolved?: unknown })?.refResolved).toBe(shaB);
        const { readlink } = await import('node:fs/promises');
        const { dirname, resolve } = await import('node:path');
        const linkTarget = resolve(dirname(livePath), await readlink(livePath));
        expect(linkTarget).toBe(resolve((pairGap?.pinned as { storePath: string }).storePath));
        const storeB = (pairGap?.pinned as { storePath: string }).storePath;
        expect(await kindOf(storeB)).toBe('dir');
        // SC-I60-MO2: the gap is self-describing — stage 1 persisted the
        // requested build plus its backup path before the crash.
        const staged = pairGap?.pendingReplacement as
          | {
              build?: unknown;
              stage?: unknown;
              refResolved?: unknown;
              storePath?: unknown;
              contentHash?: unknown;
              backupPath?: unknown;
            }
          | undefined;
        expect(staged?.build).toBe('copy');
        expect(staged?.stage).toBe(1);
        expect(staged?.refResolved).toBe(shaB);
        expect(staged?.storePath).toBe(storeB);
        expect(typeof staged?.contentHash).toBe('string');
        gapBackup = staged?.backupPath as string;
        expect(await kindOf(gapBackup)).not.toBe('absent');
        expect(await residueNames(skillsRoot)).toContain(gapBackup.slice(skillsRoot.length + 1));
        const pendingTx = Object.entries(rawGap.transactions ?? {}).filter(([, tx]) => {
          const t = tx as { intent?: { kind?: string; skill?: string; tool?: string } };
          return (
            t.intent?.kind === 'install' && t.intent?.skill === SKILL && t.intent?.tool === TOOL
          );
        });
        console.log(
          `MO2 gap: residue=${JSON.stringify(await residueNames(skillsRoot))} pendingTx=${pendingTx.length} history=${rawGap.history?.length}`,
        );
        expect(pendingTx.length).toBe(0);
      } finally {
        child.kill('SIGKILL');
        await child.exited;
      }

      // Step 4: real stale-lock recovery latency — the orphaned mkdir-lock
      // goes stale after 30s; never delete it (plan rule).
      await sleep(33_000);
      expect(await kindOf(livePath)).toBe('symlink');

      // Step 5: restart with the UNMODIFIED public CLI, identical B request.
      const rerun = await runCli(
        [
          'install',
          fsSource,
          '--tool',
          TOOL,
          '--ref',
          shaB,
          '--direct',
          '--no-verify',
          '--user',
          '--json',
        ],
        cliEnv,
        gitConfigPath,
      );
      console.log(
        `MO2 restart exit=${rerun.code}\n--- stdout ---\n${rerun.stdout}\n--- stderr ---\n${rerun.stderr}`,
      );
      requireExit(rerun, 0, 'restart B --direct');
      const report = JSON.parse(rerun.stdout) as {
        summary: Record<string, number>;
        results: Array<{
          action: string;
          placement: string | null;
          reason: string | null;
          executionOutcome?: string;
        }>;
      };
      const finalKind = await kindOf(livePath);
      const rawAfter = await readLedgerJson(ledgerPath);
      const pairAfter = pairOf(rawAfter);
      console.log(
        `MO2 after-restart: live=${finalKind} action=${report.results[0]?.action} placement=${report.results[0]?.placement} executionOutcome=${report.results[0]?.executionOutcome} ledgerPlacement=${(pairAfter?.pinned as { placement?: unknown })?.placement}`,
      );

      // Load-bearing GREEN assertions: convergence to a B directory with a
      // copy record and a truthful report — not a success/noop on a symlink.
      expect(report.results[0]?.action).toBe('updated');
      expect(report.results[0]?.placement).toBe('copy');
      expect(report.results[0]?.executionOutcome).toBe('succeeded');
      expect(report.summary.updated).toBe(1);
      expect(finalKind).toBe('dir');
      expect(await kindOf(join(livePath, 'bin', 'run.sh'))).toBe('file');
      expect(pairAfter?.journal ?? null).toBeNull();
      expect((pairAfter?.pinned as { placement?: unknown })?.placement).toBe('copy');
      expect((pairAfter?.origin as { refResolved?: unknown })?.refResolved).toBe(shaB);
      // SC-I60-MO2: convergence clears the staged intent; the first stage's
      // kept backup survives the completion and is surfaced in the report.
      expect(
        (pairAfter as { pendingReplacement?: unknown })?.pendingReplacement ?? null,
      ).toBeNull();
      expect(report.results[0]?.reason).toContain('kept backup');
      expect(gapBackup).not.toBeNull();
      expect(await kindOf(gapBackup as string)).not.toBe('absent');

      // Step 6: a second identical retry is a true noop on the converged dir.
      const rerun2 = await runCli(
        [
          'install',
          fsSource,
          '--tool',
          TOOL,
          '--ref',
          shaB,
          '--direct',
          '--no-verify',
          '--user',
          '--json',
        ],
        cliEnv,
        gitConfigPath,
      );
      requireExit(rerun2, 0, 'second restart B --direct');
      const report2 = JSON.parse(rerun2.stdout) as {
        summary: Record<string, number>;
        results: Array<{ action: string; placement: string | null; reason: string | null }>;
      };
      console.log(
        `MO2 second-retry: action=${report2.results[0]?.action} placement=${report2.results[0]?.placement}`,
      );
      expect(report2.results[0]?.action).toBe('noop');
      expect(report2.results[0]?.placement).toBe('copy');
      expect(report2.summary.noop).toBe(1);
      expect(await kindOf(livePath)).toBe('dir');
    } finally {
      await destroyFixtureFleet(f);
      await destroyRemoteFixture(fixture);
    }
  }, 240_000);

  test('decorator-neutrality: latch disabled, child B update completes as updated/copy', async () => {
    const fixture = await buildRemoteFixture();
    const f = await buildFixtureFleet();
    try {
      const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
      const shaB = fixture.multiHead;
      const livePath = join(f.home, '.claude', 'skills', SKILL);
      const ledgerPath = join(f.data, 'placements.json');
      const cliEnv: Record<string, string> = {
        GIT_ALLOW_PROTOCOL: 'file:https',
        HOME: f.home,
        SKILLSMITH_HOME: f.data,
        SKILLSMITH_E2E: '1',
      };
      const { writeFile: writeFileNeutral } = await import('node:fs/promises');
      const gitConfigPath = join(f.base, 'owned-gitconfig');
      await writeFileNeutral(
        gitConfigPath,
        [
          `[url "file://${fixture.base}/multi.git"]`,
          '\tinsteadOf = https://fixture.invalid/acme/multi.git',
          '',
        ].join('\n'),
      );
      const setup = await runCli(
        [
          'install',
          fsSource,
          '--tool',
          TOOL,
          '--ref',
          'v1.0.0',
          '--direct',
          '--no-verify',
          '--user',
        ],
        cliEnv,
        gitConfigPath,
      );
      requireExit(setup, 0, 'install A --direct');
      const readyPath = join(tmpdir(), `mo2-neutral-ready-${process.pid}.json`);
      const logPath = join(tmpdir(), `mo2-neutral-child-${process.pid}.log`);
      const paramsPath = join(tmpdir(), `mo2-neutral-params-${process.pid}.json`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        paramsPath,
        JSON.stringify({
          remoteBase: fixture.base,
          home: f.home,
          data: f.data,
          cwd: f.base,
          source: fsSource,
          refB: shaB,
          shaB,
          skill: SKILL,
          tool: TOOL,
          ledgerPath,
          livePath,
          readyPath,
          logPath,
          latchEnabled: false,
        }),
      );
      const child = Bun.spawn(['bun', CHILD, paramsPath], {
        cwd: REPO_ROOT,
        env: hermeticGitEnv(cliEnv, { globalConfigPath: gitConfigPath }),
        stdout: 'pipe',
        stderr: 'pipe',
      } as const);
      const code = await child.exited;
      const [out, errText, readyRaw] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        readFile(readyPath, 'utf8'),
      ]);
      console.log(`MO2 neutral child exit=${code} out=${out} err=${errText} ready=${readyRaw}`);
      expect(code).toBe(0);
      expect(await kindOf(livePath)).toBe('dir');
      const raw = await readLedgerJson(ledgerPath);
      const pair = pairOf(raw);
      expect((pair?.pinned as { placement?: unknown })?.placement).toBe('copy');
      expect((pair?.origin as { refResolved?: unknown })?.refResolved).toBe(shaB);
    } finally {
      await destroyFixtureFleet(f);
      await destroyRemoteFixture(fixture);
    }
  }, 180_000);

  test('force-after-interruption completes the staged replacement and surfaces the kept backup', async () => {
    const ctx = await setupMo2CrashPair();
    try {
      const gapBackup = await runLatchChild(ctx, 'force', 'gap', async () => verifyGapState(ctx));
      await sleepStaleLock();
      expect(await kindOf(ctx.livePath)).toBe('symlink');
      const rerun = await runCli(
        [
          'install',
          ctx.fsSource,
          '--tool',
          TOOL,
          '--ref',
          ctx.shaB,
          '--direct',
          '--force',
          '--no-verify',
          '--user',
          '--json',
        ],
        ctx.cliEnv,
        ctx.gitConfigPath,
      );
      console.log(
        `MO2 force restart exit=${rerun.code}\n--- stdout ---\n${rerun.stdout}\n--- stderr ---\n${rerun.stderr}`,
      );
      requireExit(rerun, 0, 'force restart B --direct');
      const report = JSON.parse(rerun.stdout) as {
        summary: Record<string, number>;
        results: Array<{
          action: string;
          placement: string | null;
          reason: string | null;
          executionOutcome?: string;
        }>;
      };
      expect(report.results[0]?.action).toBe('updated');
      expect(report.results[0]?.placement).toBe('copy');
      expect(report.results[0]?.executionOutcome).toBe('succeeded');
      expect(await kindOf(ctx.livePath)).toBe('dir');
      expect(await kindOf(join(ctx.livePath, 'bin', 'run.sh'))).toBe('file');
      const pairAfter = pairOf(await readLedgerJson(ctx.ledgerPath));
      expect(pairAfter?.journal ?? null).toBeNull();
      expect((pairAfter?.pinned as { placement?: unknown })?.placement).toBe('copy');
      expect(
        (pairAfter as { pendingReplacement?: unknown })?.pendingReplacement ?? null,
      ).toBeNull();
      // The first stage's kept backup is preserved and surfaced, never silently kept.
      expect(report.results[0]?.reason).toContain('kept backup');
      expect(await kindOf(gapBackup)).not.toBe('absent');
    } finally {
      await destroyMo2CrashPair(ctx);
    }
  }, 240_000);

  test('pre-first-swap interruption resumes ordinarily, then completes the staged replacement', async () => {
    const ctx = await setupMo2CrashPair();
    try {
      await runLatchChild(ctx, 'preswap', 'pre-swap', async (ready) => {
        // The rendezvous record proves the latch hit an uncommitted journal,
        // and the parent re-verifies it independently on disk.
        const obs = ready.observation as { journal?: unknown } | undefined;
        expect(obs?.journal).not.toBeNull();
        expect(typeof obs?.journal).toBe('object');
        const pairGap = pairOf(await readLedgerJson(ctx.ledgerPath));
        const journal = pairGap?.journal as { op?: unknown; phase?: unknown } | undefined;
        expect(journal?.op).toBe('install');
        expect(journal?.phase).not.toBe('committed');
        expect((pairGap?.origin as { refResolved?: unknown })?.refResolved).toBe(ctx.shaB);
        console.log(`MO2 pre-swap latched journal phase=${String(journal?.phase)}`);
      });
      await sleepStaleLock();
      const rerun = await runCli(
        [
          'install',
          ctx.fsSource,
          '--tool',
          TOOL,
          '--ref',
          ctx.shaB,
          '--direct',
          '--no-verify',
          '--user',
          '--json',
        ],
        ctx.cliEnv,
        ctx.gitConfigPath,
      );
      requireExit(rerun, 0, 'restart B --direct after pre-swap interruption');
      const report = JSON.parse(rerun.stdout) as {
        summary: Record<string, number>;
        results: Array<{
          action: string;
          placement: string | null;
          reason: string | null;
          executionOutcome?: string;
        }>;
      };
      const afterFirst = await kindOf(ctx.livePath);
      console.log(
        `MO2 pre-swap restart1: live=${afterFirst} action=${report.results[0]?.action} placement=${report.results[0]?.placement}`,
      );
      if (afterFirst === 'dir') {
        // The latch raced past stage 1, so the resumed journal was stage 2:
        // ordinary resume converged fully in one step.
        expect(report.results[0]?.action).toBe('updated');
        const pairAfter = pairOf(await readLedgerJson(ctx.ledgerPath));
        expect(pairAfter?.journal ?? null).toBeNull();
        expect(
          (pairAfter as { pendingReplacement?: unknown })?.pendingReplacement ?? null,
        ).toBeNull();
      } else {
        // Ordinary resume completed stage 1 only; the gap is now durable and
        // truthfully reported as an intermediate symlink.
        expect(afterFirst).toBe('symlink');
        expect(report.results[0]?.action).toBe('updated');
        expect(report.results[0]?.placement).toBe('symlink');
        const pairMid = pairOf(await readLedgerJson(ctx.ledgerPath));
        expect(pairMid?.journal ?? null).toBeNull();
        expect(
          (pairMid as { pendingReplacement?: { stage?: unknown } })?.pendingReplacement?.stage,
        ).toBe(1);
        // A second identical retry completes stage 2 via the staged intent.
        const rerun2 = await runCli(
          [
            'install',
            ctx.fsSource,
            '--tool',
            TOOL,
            '--ref',
            ctx.shaB,
            '--direct',
            '--no-verify',
            '--user',
            '--json',
          ],
          ctx.cliEnv,
          ctx.gitConfigPath,
        );
        requireExit(rerun2, 0, 'second restart B --direct');
        const report2 = JSON.parse(rerun2.stdout) as {
          summary: Record<string, number>;
          results: Array<{ action: string; placement: string | null; reason: string | null }>;
        };
        expect(report2.results[0]?.action).toBe('updated');
        expect(await kindOf(ctx.livePath)).toBe('dir');
        const pairAfter = pairOf(await readLedgerJson(ctx.ledgerPath));
        expect(
          (pairAfter as { pendingReplacement?: unknown })?.pendingReplacement ?? null,
        ).toBeNull();
      }
    } finally {
      await destroyMo2CrashPair(ctx);
    }
  }, 240_000);

  test('rollback and undo refuse safely after the gap (characterization)', async () => {
    const ctx = await setupMo2CrashPair();
    try {
      await runLatchChild(ctx, 'rbu', 'gap', async () => verifyGapState(ctx));
      await sleepStaleLock();
      expect(await kindOf(ctx.livePath)).toBe('symlink');

      // Rollback: the staged first stage is committed with no journal, so the
      // rollback alias routes to undo selection, which refuses — the update
      // predates exact retained artifact history. No mutation either way.
      // (Pre-existing retained-artifact rule, independent of the staged
      // marker; no grouping semantics invented here.)
      const rb = await runCli(
        ['promote', '--rollback', SKILL, '--tool', TOOL, '--user', '--json'],
        ctx.cliEnv,
        ctx.gitConfigPath,
      );
      console.log(
        `MO2 gap rollback exit=${rb.code}\n--- stdout ---\n${rb.stdout}\n--- stderr ---\n${rb.stderr}`,
      );
      requireExit(rb, 3, 'rollback after the gap refuses');
      expect(rb.stdout).toContain('undo-artifact-lineage');
      expect(`${rb.stdout}\n${rb.stderr}`).toContain('cannot be reversed safely');
      expect(await kindOf(ctx.livePath)).toBe('symlink');
      const pairKept = pairOf(await readLedgerJson(ctx.ledgerPath));
      expect(pairKept?.journal ?? null).toBeNull();
      expect(
        (pairKept as { pendingReplacement?: { stage?: unknown } })?.pendingReplacement?.stage,
      ).toBe(1);

      // Undo: same retained-artifact refusal through the shared machinery —
      // the gap stays intact for the identical install retry.
      const undo = await runCli(
        ['undo', SKILL, '--tool', TOOL, '--json'],
        ctx.cliEnv,
        ctx.gitConfigPath,
      );
      console.log(
        `MO2 gap undo exit=${undo.code}\n--- stdout ---\n${undo.stdout}\n--- stderr ---\n${undo.stderr}`,
      );
      requireExit(undo, 3, 'undo after the gap refuses');
      expect(undo.stdout).toContain('undo-artifact-lineage');
      expect(await kindOf(ctx.livePath)).toBe('symlink');
      const pairAfterUndo = pairOf(await readLedgerJson(ctx.ledgerPath));
      expect(pairAfterUndo?.journal ?? null).toBeNull();
      expect((pairAfterUndo?.origin as { refResolved?: unknown })?.refResolved).toBe(ctx.shaB);
      expect(
        (pairAfterUndo as { pendingReplacement?: { stage?: unknown } })?.pendingReplacement?.stage,
      ).toBe(1);
    } finally {
      await destroyMo2CrashPair(ctx);
    }
  }, 240_000);
});
