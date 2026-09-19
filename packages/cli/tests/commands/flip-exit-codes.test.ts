import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { dirname, join, resolve } from 'node:path';
import type { FlipDeps, FlipOptions, FlipReport, SkillSmithError } from '@skillsmith/core';
import { resolveRuntimeConfiguration, runDev, runPromote } from '@skillsmith/core';
import { emptyLedger, setPair, writeLedger } from '../../../core/src/place/ledger.ts';
import { ledgerPathOf, resolveDataDir } from '../../../core/src/place/paths.ts';
import { canonicalFixtureLedger } from '../../../core/tests/fixtures/place/canonical-ledger.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';
import { exitCodeForError } from '../../src/util/exit-codes.ts';
import { flipExitCode } from '../../src/util/flip-exit.ts';

// This file's tests each build a fixture fleet (real `git init`) and often resolve provenance via
// real `git` subprocess calls — the 5s bun:test default can be tight when the whole suite runs
// under load.
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
      verifiedAgainst: { 'claude-code': '1.0.0', codex: '1.0.0' },
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

const gateFailDeps = (): FlipDeps => ({
  now: () => NOW,
  newTxId: (() => {
    let n = 0;
    return () => (++n).toString(16).padStart(8, '0');
  })(),
  verify: async (_env, o) => {
    const tool = o.tools?.[0] ?? 'claude-code';
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        target: { path: o.path, kind: 'skill' },
        requested: { tools: [tool], modes: ['static'], strict: false, explicitTools: true },
        verifiedAgainst: { 'claude-code': '1.0.0', codex: '1.0.0' },
        summary: {
          verdict: 'fail',
          verified: [],
          failed: [tool],
          skipped: [],
          counts: { error: 1, warning: 0, info: 0 },
        },
        tools: [
          {
            tool,
            available: true,
            toolVersion: '1.0.0',
            versionDrift: false,
            skipReason: null,
            verdict: 'fail' as const,
            modes: [],
          },
        ],
      },
    };
  },
});

const opts = (f: FixtureFleet, o: Partial<FlipOptions> = {}): FlipOptions => ({
  targets: [],
  cwd: f.home,
  configuration: resolveRuntimeConfiguration(f.envVars),
  ...o,
});

// Plant a valid ledger whose (alpha, claude-code) pair carries an uncommitted journal for a
// DIFFERENT op ('dev') than the one we're about to run ('promote') — run.ts refuses rather than
// resumes on an op mismatch, without touching the filesystem (no real staging/backup dirs needed).
const plantMismatchedJournal = async (f: FixtureFleet): Promise<void> => {
  const dataDir = resolveDataDir(f.env, resolveRuntimeConfiguration(f.envVars));
  const ledgerPath = ledgerPathOf(dataDir);
  const skillsRoot = join(f.home, '.claude', 'skills');
  const placementPath = join(skillsRoot, 'alpha');
  const ledger = emptyLedger(NOW);
  setPair(ledger, 'alpha', 'claude-code', {
    placementPath,
    mode: 'dev',
    dev: {
      sourcePath: resolve(f.alphaSrc),
      resolvedPath: resolve(f.alphaSrc),
      repoRoot: null,
      sourceRelPath: null,
      remote: null,
      recordedAt: NOW,
    },
    pinned: null,
    journal: {
      op: 'dev',
      txId: 'aaaa1111',
      phase: 'backed-up',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'pinned', storePath: null, contentHash: null },
      stagingPath: join(skillsRoot, '.skillsmith-staging-alpha-aaaa1111'),
      backupPath: join(skillsRoot, '.skillsmith-backup-alpha-aaaa1111'),
    },
  });
  const w = await writeLedger(f.env, ledgerPath, canonicalFixtureLedger(ledger));
  if (!w.ok) throw new Error(`failed to plant journal: ${msg(w.error)}`);
};

const corruptLedger = async (f: FixtureFleet): Promise<void> => {
  const dataDir = resolveDataDir(f.env, resolveRuntimeConfiguration(f.envVars));
  const ledgerPath = ledgerPathOf(dataDir);
  await f.env.makeDir(dirname(ledgerPath));
  await f.env.writeTextFile(ledgerPath, '{"schemaVersion":');
};

// Drive runPromote/runDev on the fixture fleet and check flipExitCode — one row per §12's
// exit-code table (0-5). The corrupt-ledger row is the one exception: a ledger read failure is a
// top-level `Result` error (no FlipReport at all), so it asserts `exitCodeForError` directly,
// exactly as promote.ts/dev.ts do for that branch.
describe('flip exit-code table (§12)', () => {
  test('already-dev: `dev alpha` (noop) -> exit 0', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runDev(f.env, opts(f, { targets: ['alpha'] }), passDeps());
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('noop');
      expect(flipExitCode(r.value)).toBe(0);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('clean `promote alpha` (flipped) -> exit 0', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('flipped');
      expect(flipExitCode(r.value)).toBe(0);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('dirty tree, no --allow-dirty (refused) -> exit 2', async () => {
    const f = await buildFixtureFleet();
    try {
      await f.makeCheckoutDirty();
      const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('refused');
      expect(flipExitCode(r.value)).toBe(2);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('gateFail promote (failed) -> exit 1', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), gateFailDeps());
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('failed');
      expect(flipExitCode(r.value)).toBe(1);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('promote alpha --tool codex (named tool, nothing flippable) -> exit 4', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(
        f.env,
        opts(f, { targets: ['alpha'], tools: ['codex'] }),
        passDeps(),
      );
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('refused');
      expect(r.value.results[0]?.error?.code).toBe('placement-not-found');
      expect(flipExitCode(r.value)).toBe(4);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('promote dangler (dangling source) -> exit 5', async () => {
    const f = await buildFixtureFleet();
    try {
      const r = await runPromote(f.env, opts(f, { targets: ['dangler'] }), passDeps());
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('refused');
      expect(r.value.results[0]?.error?.code).toBe('source-unresolvable');
      expect(flipExitCode(r.value)).toBe(5);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('pair with a planted uncommitted journal, promote without --rollback -> exit 2', async () => {
    const f = await buildFixtureFleet();
    try {
      await plantMismatchedJournal(f);
      const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
      if (!r.ok) throw new Error(msg(r.error));
      expect(r.value.results[0]?.action).toBe('refused');
      expect(r.value.results[0]?.error?.code).toBe('flip-refused');
      expect(flipExitCode(r.value)).toBe(2);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('ledger file containing `{"schemaVersion":` (corrupt) -> any op maps to exit 3', async () => {
    const f = await buildFixtureFleet();
    try {
      await corruptLedger(f);
      const r: { ok: false; error: SkillSmithError } | { ok: true; value: FlipReport } =
        await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('ledger-error');
        expect(exitCodeForError(r.error)).toBe(3);
      }
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('mixed batch: one flipped + one refused-dirty -> exit 2 (max rule)', async () => {
    const f = await buildFixtureFleet();
    try {
      // Dirties only alpha's checkout repo; gamma is a separate non-git source and unaffected.
      await f.makeCheckoutDirty();
      const r = await runPromote(f.env, opts(f, { targets: ['alpha', 'gamma'] }), passDeps());
      if (!r.ok) throw new Error(msg(r.error));
      const alphaResult = r.value.results.find((res) => res.skill === 'alpha');
      const gammaResult = r.value.results.find((res) => res.skill === 'gamma');
      expect(alphaResult?.action).toBe('refused');
      expect(gammaResult?.action).toBe('flipped');
      expect(flipExitCode(r.value)).toBe(2);
    } finally {
      await destroyFixtureFleet(f);
    }
  });
});
